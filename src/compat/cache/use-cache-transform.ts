/**
 * Source rewrite for the 'use cache' directive (Next compat). Regex/heuristic based like the
 * 'use server' scanning in compat/actions/detect.ts - not a compiler. Two shapes are handled:
 *
 * 1. Function-level: a function whose body opens with the directive. The directive is stripped and the
 *    function's binding is reassigned to `pnextUseCache(id, fn)` at the end of the module (const
 *    declarations are rewritten to let).
 * 2. Module-level: a file whose first statement is the directive. Every exported function declaration
 *    gets wrapped the same way.
 *
 * Limitations: anonymous default exports, object methods, and function expressions passed inline as
 * arguments are not wrapped.
 */
import path from 'node:path'

const useCacheRuntimePath = path.join(import.meta.dirname, 'use-cache.ts')

const quickTest = /(['"])use cache(?:\s*:\s*[\w-]+)?\1/
const directiveText = /(['"])use cache(?:\s*:\s*([\w-]+))?\1\s*;?/
const rootParamsImportLine =
  /^[ \t]*import\s+\{[\s\S]*?\}\s+from\s+['"]next\/root-params['"]\s*;?[ \t]*(?:\r?\n)?/gm

const boundHelper = '__pnextUseCacheBound'

export function rewriteUseCacheSource(source: string, file: string, root?: string): string {
  // `includes` first: over a real module corpus the quoted-directive regex is
  // ~24x the cost of the token scan, and virtually every module fails the token.
  if (!source.includes('use cache') || !quickTest.test(source)) return source

  const idBase = root ? path.relative(root, file) : file
  const wrapped = new Set<string>()
  const privateWrapped = new Set<string>()
  let out = source
  let usedBoundHelper = false

  out = rewriteModuleLevelDirective(out, wrapped)
  // Nested cached closures capturing enclosing bindings (bound args) must be wrapped in place - a
  // module-level reassignment cannot reach a function-scoped binding, and the captured values
  // participate in the cache key. Runs before the top-level pass so it only claims genuinely-nested
  // directives. Returned arrow closures capture their enclosing scope's free variables as bound args,
  // including any non-serializable function, which is a build error - wrap them first so the directive
  // is claimed here before the nested-named-closure pass, whose brace-balance heuristic would otherwise
  // mis-attribute the arrow's directive to a sibling function declaration.
  const arrows = rewriteReturnedArrowClosures(out, idBase)
  out = arrows.source
  usedBoundHelper = arrows.wrapped
  const nested = rewriteNestedBoundClosures(out, idBase)
  out = nested.source
  usedBoundHelper = usedBoundHelper || nested.wrapped
  // Function expressions in value position (JSX attributes / call arguments):
  // `<Form foo={async function () { 'use cache'; … }} />`.
  const expressions = rewriteExpressionClosures(out, idBase)
  out = expressions.source
  usedBoundHelper = usedBoundHelper || expressions.wrapped
  const objectMethods = rewriteObjectMethods(out, idBase)
  out = objectMethods.source
  usedBoundHelper = usedBoundHelper || objectMethods.wrapped
  const staticMethods = rewriteStaticClassMethods(out, idBase)
  out = staticMethods.source
  const usedDirectHelper = staticMethods.wrapped
  out = rewriteFunctionLevelDirectives(out, wrapped, privateWrapped)

  if (wrapped.size === 0 && !usedBoundHelper && !usedDirectHelper) return out

  const imports: string[] = []
  if (wrapped.size > 0 || usedDirectHelper) {
    imports.push(
      `import { pnextUseCache as __pnextUseCache } from ${JSON.stringify(useCacheRuntimePath)};`,
    )
  }
  if (privateWrapped.size > 0) {
    imports.push(
      `import { pnextUseCachePrivate as __pnextUseCachePrivate } from ${JSON.stringify(useCacheRuntimePath)};`,
    )
  }
  if (usedBoundHelper) {
    imports.push(
      `import { pnextUseCacheBound as ${boundHelper} } from ${JSON.stringify(useCacheRuntimePath)};`,
    )
  }
  // `export default NAME;` snapshots the binding's value when the statement
  // evaluates (a default-exported identifier is not a live binding, unlike
  // `export default function NAME`), so the module-end reassignment would be
  // invisible to importers. Move the statement after the reassignments.
  let defaultExport = ''
  for (const name of wrapped) {
    const statement = new RegExp(
      `(^|[\\n;])[ \\t]*export\\s+default\\s+${escapeIdent(name)}(?![\\w$])\\s*;?`,
    ).exec(out)
    if (!statement) continue
    out =
      out.slice(0, statement.index) +
      (statement[1] ?? '') +
      out.slice(statement.index + statement[0].length)
    defaultExport = `\nexport default ${name};`
    break
  }

  const hoisted = hoistRootParamsImports(out)
  const assignments = [...wrapped]
    .map(name =>
      privateWrapped.has(name)
        ? `${name} = __pnextUseCachePrivate(${JSON.stringify(`${idBase}#${name}`)}, ${name});`
        : `${name} = __pnextUseCache(${JSON.stringify(`${idBase}#${name}`)}, ${name});`,
    )
    .join('\n')
  const suffix = assignments ? `\n;${assignments}${defaultExport}\n` : '\n'
  return `${hoisted.imports}${imports.join('\n')}\n${hoisted.source}${suffix}`
}

function hoistRootParamsImports(source: string): { imports: string; source: string } {
  if (!source.includes('next/root-params')) return { imports: '', source }
  const imports: string[] = []
  const body = source.replace(rootParamsImportLine, statement => {
    imports.push(statement.trimEnd())
    return ''
  })
  if (imports.length === 0) return { imports: '', source }
  return {
    imports: `${imports.join('\n')}\n`,
    source: body.replace(/^\s*\n/, ''),
  }
}

/**
 * Wrap nested cached closures (a `'use cache'` function declared inside another function) in place with
 * `pnextUseCacheBound`, threading the enclosing function's parameters that the closure references as
 * bound-arg key inputs. Handles the load-bearing shape:
 *
 *   async function outer(arg) {
 *     async function inner() { 'use cache'; return { arg } }
 *     return inner()
 *   }
 *
 * Captures are limited to the nearest enclosing function's parameter names that appear as whole-word
 * identifiers in the closure body - enough for the fixtures without a full scope analysis, and
 * conservative (never captures globals).
 */
function rewriteNestedBoundClosures(
  source: string,
  idBase: string,
): { source: string; wrapped: boolean } {
  let out = source
  let wrapped = false
  let searchFrom = 0
  for (;;) {
    const tail = out.slice(searchFrom)
    const directive = directiveText.exec(tail)
    if (!directive) break
    const index = searchFrom + directive.index
    const prefix = out.slice(0, index)
    if (!/\{\s*$/.test(prefix)) {
      searchFrom = index + directive[0].length
      continue
    }
    const closure = findNestedClosure(out, index)
    if (!closure) {
      searchFrom = index + directive[0].length
      continue
    }
    const id = `${idBase}#${closure.enclosingName}.${closure.name}`
    const captureList = closure.captures.length ? closure.captures.join(', ') : ''
    // Replace `[async ]function NAME(params) {` with a wrapped const binding, and
    // strip the directive from the body.
    const wrappedHead = `const ${closure.name} = ${boundHelper}(${JSON.stringify(id)}, ${closure.asyncKeyword}function ${closure.name}(${closure.params}) {`
    const bodyAfterDirective = out.slice(index + directive[0].length, closure.bodyEnd)
    const rest = out.slice(closure.bodyEnd)
    out =
      out.slice(0, closure.declStart) +
      wrappedHead +
      bodyAfterDirective +
      `}, () => [${captureList}])` +
      rest.replace(/^\}/, '')
    wrapped = true
    searchFrom = closure.declStart + wrappedHead.length
  }
  return { source: out, wrapped }
}

/**
 * Wrap `use cache` closures returned as arrow functions from an enclosing function - the shape the
 * close-over-function fixture uses:
 *
 *   function createCachedFn(start) {
 *     function fn() { return start }
 *     return async () => { 'use cache'; return Math.random() + fn() }
 *   }
 *
 * The capture list is the enclosing function's params and local declarations that the closure
 * references, so a captured function reaches the runtime's close-over-function guard. Scoped to
 * return-position arrows to keep the regex heuristic narrow; arrows elsewhere stay inert.
 */
function rewriteReturnedArrowClosures(
  source: string,
  idBase: string,
): { source: string; wrapped: boolean } {
  let out = source
  let wrapped = false
  let searchFrom = 0
  let counter = 0
  for (;;) {
    const tail = out.slice(searchFrom)
    const directive = directiveText.exec(tail)
    if (!directive) break
    const index = searchFrom + directive.index
    const prefix = out.slice(0, index)
    if (!/\{\s*$/.test(prefix)) {
      searchFrom = index + directive[0].length
      continue
    }
    const closure = findReturnedArrowClosure(out, index)
    if (!closure) {
      searchFrom = index + directive[0].length
      continue
    }
    const id = `${idBase}#${closure.enclosingName}.arrow${counter === 0 ? '' : counter}`
    counter += 1
    const captureList = closure.captures.join(', ')
    const wrappedHead = `${boundHelper}(${JSON.stringify(id)}, ${closure.head}`
    const bodyAfterDirective = out.slice(index + directive[0].length, closure.bodyEnd)
    const rest = out.slice(closure.bodyEnd)
    out =
      out.slice(0, closure.declStart) +
      wrappedHead +
      bodyAfterDirective +
      `}, () => [${captureList}])` +
      rest.replace(/^\}/, '')
    wrapped = true
    searchFrom = closure.declStart + wrappedHead.length
  }
  return { source: out, wrapped }
}

/**
 * Wrap `use cache` function expressions in VALUE position - JSX attributes, call arguments and
 * object-property values. Captures are the nearest enclosing named function's params/locals referenced
 * in the body (same policy as the returned-arrow pass). Statement declarations and top-level bindings
 * are NOT claimed here - the value-position context requires a preceding `={`, `(`, `,` or `:` - so the
 * established passes keep their shapes and id scheme. Named-handler variants are left inert.
 */
function rewriteExpressionClosures(
  source: string,
  idBase: string,
): { source: string; wrapped: boolean } {
  let out = source
  let wrapped = false
  let searchFrom = 0
  let counter = 0
  for (;;) {
    const tail = out.slice(searchFrom)
    const directive = directiveText.exec(tail)
    if (!directive) break
    const index = searchFrom + directive.index
    if (directive[2] !== undefined || !/\{\s*$/.test(out.slice(0, index))) {
      searchFrom = index + directive[0].length
      continue
    }
    const closure = findExpressionClosure(out, index)
    if (!closure) {
      searchFrom = index + directive[0].length
      continue
    }
    const id = `${idBase}#${closure.enclosingName}.expr${counter === 0 ? '' : counter}`
    counter += 1
    const wrappedHead = `${boundHelper}(${JSON.stringify(id)}, ${closure.head}`
    const bodyAfterDirective = out.slice(index + directive[0].length, closure.bodyEnd)
    const rest = out.slice(closure.bodyEnd)
    out =
      out.slice(0, closure.declStart) +
      wrappedHead +
      bodyAfterDirective +
      `}, () => [${closure.captures.join(', ')}])` +
      rest.replace(/^\}/, '')
    wrapped = true
    searchFrom = closure.declStart + wrappedHead.length
  }
  return { source: out, wrapped }
}

function findExpressionClosure(
  source: string,
  directiveIndex: number,
): ReturnedArrowClosure | null {
  const prefix = source.slice(0, directiveIndex)
  // Value-position contexts: a JSX attribute (`={`), a call argument (`(` or
  // `,`), or an object-property value (`:`), followed by a function expression
  // or an arrow whose body opens with the directive.
  const exprRe =
    /(=\s*\{|[(,:])\s*((?:async\s+)?(?:function(?:\s+[A-Za-z_$][\w$]*)?\s*\(([^)]*)\)|(?:\(([^)]*)\)|[A-Za-z_$][\w$]*)\s*=>)\s*\{)/g
  let match: RegExpExecArray | null
  let best: { headStart: number; head: string; params: string; bodyOpen: number } | null = null
  while ((match = exprRe.exec(prefix)) !== null) {
    const head = match[2]!
    const headStart = match.index + match[0].length - head.length
    const bodyOpen = match.index + match[0].length
    const between = source.slice(bodyOpen, directiveIndex)
    // The directive must be the first statement of THIS body: zero net braces
    // between, and the body must never close in between (a dip below zero means
    // this candidate's body ended before the directive).
    let balance = 0
    let closed = false
    for (const ch of between) {
      if (ch === '{') balance += 1
      else if (ch === '}') {
        balance -= 1
        if (balance < 0) {
          closed = true
          break
        }
      }
    }
    if (!closed && balance === 0) {
      best = { headStart, head, params: match[3] ?? match[4] ?? '', bodyOpen }
    }
  }
  if (!best) return null

  const bodyEnd = matchClosingBrace(source, best.bodyOpen)
  if (bodyEnd < directiveIndex) return null
  const body = source.slice(best.bodyOpen, bodyEnd)

  const enclosing = findEnclosingFunctionFull(source, best.headStart)
  const ownParams = new Set(paramNames(best.params))
  const captures = enclosing
    ? enclosingCaptureCandidates(source, enclosing).filter(
        name => !ownParams.has(name) && new RegExp(`\\b${escapeIdent(name)}\\b`).test(body),
      )
    : []

  return {
    head: best.head,
    declStart: best.headStart,
    bodyEnd,
    enclosingName: enclosing?.name ?? 'module',
    captures,
  }
}

interface ReturnedArrowClosure {
  head: string
  declStart: number
  bodyEnd: number
  enclosingName: string
  captures: string[]
}

function findReturnedArrowClosure(
  source: string,
  directiveIndex: number,
): ReturnedArrowClosure | null {
  const prefix = source.slice(0, directiveIndex)
  // The parameter list must stay on one line and carry no `<`: otherwise
  // `return (\n  <Form getDate={async () => {` reads as one giant "arrow" whose
  // params run from the returned parenthesis to the first `)` inside the JSX,
  // and the wrap lands on the return expression instead of the attribute's
  // closure (use-cache-with-server-function-props). Value-position closures like
  // that are claimed by rewriteExpressionClosures instead.
  const arrowRe = /\breturn\s+(async\s+)?(\([^)<\n]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g
  let match: RegExpExecArray | null
  let best: { headStart: number; head: string; params: string; bodyOpen: number } | null = null
  while ((match = arrowRe.exec(prefix)) !== null) {
    const retPrefix = /^return\s+/.exec(match[0])?.[0] ?? 'return '
    const headStart = match.index + retPrefix.length
    const bodyOpen = match.index + match[0].length
    const between = source.slice(bodyOpen, directiveIndex)
    let balance = 0
    for (const ch of between) {
      if (ch === '{') balance += 1
      else if (ch === '}') balance -= 1
    }
    if (balance === 0) {
      const paramSpec = match[2]!
      const params = paramSpec.startsWith('(') ? paramSpec.slice(1, -1) : paramSpec
      best = { headStart, head: match[0].slice(retPrefix.length), params, bodyOpen }
    }
  }
  if (!best) return null

  const enclosing = findEnclosingFunctionFull(source, best.headStart)
  if (!enclosing) return null

  const bodyEnd = matchClosingBrace(source, best.bodyOpen)
  if (bodyEnd < 0) return null
  const body = source.slice(best.bodyOpen, bodyEnd)

  const arrowParams = new Set(paramNames(best.params))
  const candidates = enclosingCaptureCandidates(source, enclosing)
  const captures = candidates.filter(
    name => !arrowParams.has(name) && new RegExp(`\\b${escapeIdent(name)}\\b`).test(body),
  )

  return {
    head: best.head,
    declStart: best.headStart,
    bodyEnd,
    enclosingName: enclosing.name,
    captures,
  }
}

/** Nearest enclosing named function wrapping `pos`, with its body span. */
function findEnclosingFunctionFull(
  source: string,
  pos: number,
): { name: string; params: string[]; bodyStart: number; bodyEnd: number } | null {
  const before = source.slice(0, pos)
  const re = /(?:^|[\s;{}])(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g
  let match: RegExpExecArray | null
  let candidate: { name: string; params: string[]; bodyStart: number; bodyEnd: number } | null =
    null
  while ((match = re.exec(before)) !== null) {
    const kwOffset = match[0].search(/async|function/)
    if (!isStatementFunctionHead(source, match.index + kwOffset)) continue
    const bodyOpen = match.index + match[0].length
    const close = matchClosingBrace(source, bodyOpen)
    if (close > pos) {
      candidate = {
        name: match[1]!,
        params: paramNames(match[2]!),
        bodyStart: bodyOpen,
        bodyEnd: close,
      }
    }
  }
  return candidate
}

/**
 * Identifiers declared in the enclosing function that a captured arrow may close over: the function's
 * params plus its local function/const/let/var declarations. Over-collection is harmless - only names
 * actually referenced in the closure body become captures.
 */
function enclosingCaptureCandidates(
  source: string,
  enclosing: { params: string[]; bodyStart: number; bodyEnd: number },
): string[] {
  const names = new Set(enclosing.params)
  const body = source.slice(enclosing.bodyStart, enclosing.bodyEnd)
  for (const match of body.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g)) {
    if (match[1]) names.add(match[1])
  }
  for (const match of body.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    if (match[1]) names.add(match[1])
  }
  return [...names]
}

interface NestedClosure {
  name: string
  params: string
  asyncKeyword: string
  declStart: number
  bodyEnd: number
  enclosingName: string
  captures: string[]
}

/**
 * Given the index of a `'use cache'` directive that opens a function body, find the immediately
 * enclosing named function declaration nested inside another named function and compute its captured
 * enclosing-parameter identifiers. Returns null when the directive does not open one - object methods,
 * statics and arrows are left inert, which is safe: they run uncached rather than breaking the build.
 */
function findNestedClosure(source: string, directiveIndex: number): NestedClosure | null {
  const prefix = source.slice(0, directiveIndex)
  // Match the nearest `[async ]function NAME(params) {` whose brace opens the
  // directive body (exactly one unclosed brace between it and the directive).
  const declRe = /(?:^|[\s;{}])(async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g
  let match: RegExpExecArray | null
  let best: {
    asyncKeyword: string
    name: string
    params: string
    headStart: number
    bodyOpen: number
  } | null = null
  while ((match = declRe.exec(prefix)) !== null) {
    // Clean head start: the position of the `async`/`function` keyword (the
    // match may include a leading whitespace/`{`/`;` separator char).
    const kwOffset = match[0].search(/async|function/)
    const cleanStart = match.index + kwOffset
    if (!isStatementFunctionHead(source, cleanStart)) continue
    const bodyOpen = match.index + match[0].length // just after `{`
    // Balance braces from bodyOpen to directiveIndex — must be exactly 0 open
    // *within* this function head region, i.e. the directive is the first stmt.
    const between = source.slice(bodyOpen, directiveIndex)
    let balance = 0
    for (const ch of between) {
      if (ch === '{') balance += 1
      else if (ch === '}') balance -= 1
    }
    if (balance === 0) {
      if (match[2] === 'function') continue
      best = {
        asyncKeyword: match[1] ? 'async ' : '',
        name: match[2]!,
        params: match[3]!.trim(),
        headStart: cleanStart,
        bodyOpen,
      }
    }
  }
  if (!best) return null

  // The closure must be genuinely nested: there is an enclosing named function
  // whose body contains `best`. Find the nearest such enclosing declaration.
  const enclosing = findEnclosingNamedFunction(source, best.headStart)
  if (!enclosing) return null

  // Find the matching close brace of the closure body.
  const bodyEnd = matchClosingBrace(source, best.bodyOpen)
  if (bodyEnd < 0) return null
  const body = source.slice(best.bodyOpen, bodyEnd)

  // Captures: enclosing params referenced (whole-word) in the closure body and
  // not shadowed by the closure's own params.
  const closureParams = new Set(paramNames(best.params))
  const captures = enclosing.params.filter(
    param => !closureParams.has(param) && new RegExp(`\\b${escapeIdent(param)}\\b`).test(body),
  )

  return {
    name: best.name,
    params: best.params,
    asyncKeyword: best.asyncKeyword,
    declStart: best.headStart,
    bodyEnd,
    enclosingName: enclosing.name,
    captures,
  }
}

/** Nearest enclosing `[async ]function NAME(params)` whose body wraps `pos`. */
function findEnclosingNamedFunction(
  source: string,
  pos: number,
): { name: string; params: string[] } | null {
  const before = source.slice(0, pos)
  const re = /(?:^|[\s;{}])(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g
  let match: RegExpExecArray | null
  let candidate: { name: string; params: string[] } | null = null
  while ((match = re.exec(before)) !== null) {
    const kwOffset = match[0].search(/async|function/)
    if (!isStatementFunctionHead(source, match.index + kwOffset)) continue
    const bodyOpen = match.index + match[0].length
    const close = matchClosingBrace(source, bodyOpen)
    if (close > pos) {
      candidate = { name: match[1]!, params: paramNames(match[2]!) }
    }
  }
  return candidate
}

function isStatementFunctionHead(source: string, index: number): boolean {
  if (/(^|[\s;{}])export\s+(?:default\s+)?$/.test(source.slice(0, index))) return true
  let previous = index - 1
  while (previous >= 0 && /\s/.test(source[previous]!)) previous -= 1
  if (previous < 0) return true
  if (source[previous] === '=') return false
  if (source[previous] === '{') {
    let beforeBrace = previous - 1
    while (beforeBrace >= 0 && /\s/.test(source[beforeBrace]!)) beforeBrace -= 1
    return source[beforeBrace] !== '='
  }
  return source[previous] === ';' || source[previous] === '}'
}

/** Index just past the `}` matching the `{` at `openIndex`, or -1. */
function matchClosingBrace(source: string, openIndex: number): number {
  let balance = 1
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') balance += 1
    else if (ch === '}') {
      balance -= 1
      if (balance === 0) return i
    }
  }
  return -1
}

function escapeIdent(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Extract simple parameter identifier names from a `(...)` param string. */
function paramNames(params: string): string[] {
  const names: string[] = []
  for (const part of params.split(',')) {
    const name = part.trim().split(/[=:\s]/)[0]
    if (name) names.push(name)
  }
  return names
}

/**
 * Module-level directive: strip it and wrap every exported function-ish
 * declaration. `export const` becomes `export let` so the binding is
 * reassignable.
 */
function rewriteModuleLevelDirective(source: string, wrapped: Set<string>): string {
  const prologue = /^(?:#![^\n]*\n)?(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/.exec(source)
  const offset = prologue?.[0].length ?? 0
  const head = source.slice(offset)
  const directive = /^(['"])use cache(?:\s*:\s*[\w-]+)?\1\s*;?/.exec(head)
  if (!directive) return source

  let out = source.slice(0, offset) + head.slice(directive[0].length)

  // export [async] function NAME / export [default] [async] function NAME
  for (const match of out.matchAll(
    /\bexport\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/g,
  )) {
    if (match[1]) wrapped.add(match[1])
  }
  // export const|let|var NAME = ... (assume function values; const -> let)
  out = out.replace(
    /\bexport\s+(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
    (full, keyword: string, name: string) => {
      wrapped.add(name)
      return full.replace(keyword, keyword === 'const' ? 'let' : keyword)
    },
  )

  // `const NAME = ...; export { NAME }` — a re-exported binding under a
  // module-level directive. Wrap each re-exported name declared as a top-level
  // const/let/var function value (flip its const to let so it's reassignable).
  const reExported = new Set<string>()
  for (const clause of out.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const spec of clause[1]!.split(',')) {
      const local = spec
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim()
      if (local && /^[A-Za-z_$][\w$]*$/.test(local)) reExported.add(local)
    }
  }
  for (const name of reExported) {
    if (wrapped.has(name)) continue
    const declRe = new RegExp(`(^|[\\n;])\\s*(const|let|var)\\s+${escapeIdent(name)}\\s*=`)
    const declMatch = declRe.exec(out)
    if (!declMatch) continue
    wrapped.add(name)
    if (declMatch[2] === 'const') {
      out =
        out.slice(0, declMatch.index) +
        declMatch[0].replace(/\bconst\b/, 'let') +
        out.slice(declMatch.index + declMatch[0].length)
    }
  }

  for (const match of out.matchAll(/\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;?/g)) {
    const name = match[1]!
    if (wrapped.has(name)) continue
    const declRe = new RegExp(`(^|[\\n;])\\s*(const|let|var)\\s+${escapeIdent(name)}\\s*=`)
    const declMatch = declRe.exec(out)
    if (!declMatch) continue
    wrapped.add(name)
    if (declMatch[2] === 'const') {
      out =
        out.slice(0, declMatch.index) +
        declMatch[0].replace(/\bconst\b/, 'let') +
        out.slice(declMatch.index + declMatch[0].length)
    }
  }
  return out
}

function rewriteObjectMethods(
  source: string,
  idBase: string,
): { source: string; wrapped: boolean } {
  let out = source
  let wrapped = false
  let searchFrom = 0
  for (;;) {
    const tail = out.slice(searchFrom)
    const directive = directiveText.exec(tail)
    if (!directive) break
    const index = searchFrom + directive.index
    if (!/\{\s*$/.test(out.slice(0, index))) {
      searchFrom = index + directive[0].length
      continue
    }
    const method = findObjectMethod(out, index)
    if (!method) {
      searchFrom = index + directive[0].length
      continue
    }
    const id = `${idBase}#${method.enclosingName}.${method.name}`
    const captureList = method.captures.join(', ')
    const wrappedHead = `${method.name}: ${boundHelper}(${JSON.stringify(id)}, ${method.asyncKeyword}function ${method.name}(${method.params}) {`
    out =
      out.slice(0, method.declStart) +
      wrappedHead +
      out.slice(index + directive[0].length, method.bodyEnd) +
      `}, () => [${captureList}])` +
      out.slice(method.bodyEnd + 1)
    wrapped = true
    searchFrom = method.declStart + wrappedHead.length
  }
  return { source: out, wrapped }
}

function findObjectMethod(source: string, directiveIndex: number): NestedClosure | null {
  const prefix = source.slice(0, directiveIndex)
  const methodRe = /(?:^|[,{]\s*)(async\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g
  let match: RegExpExecArray | null
  let best: {
    asyncKeyword: string
    name: string
    params: string
    headStart: number
    bodyOpen: number
  } | null = null
  while ((match = methodRe.exec(prefix)) !== null) {
    let beforeMatch = match.index - 1
    while (beforeMatch >= 0 && /\s/.test(source[beforeMatch]!)) beforeMatch -= 1
    if (source[beforeMatch] === '=') continue
    const kwOffset = match[0].search(/async|[A-Za-z_$]/)
    const cleanStart = match.index + kwOffset
    const bodyOpen = match.index + match[0].length
    const between = source.slice(bodyOpen, directiveIndex)
    let balance = 0
    for (const ch of between) {
      if (ch === '{') balance += 1
      else if (ch === '}') balance -= 1
    }
    if (balance === 0) {
      best = {
        asyncKeyword: match[1] ? 'async ' : '',
        name: match[2]!,
        params: match[3]!.trim(),
        headStart: cleanStart,
        bodyOpen,
      }
    }
  }
  if (!best) return null
  const enclosing = findEnclosingNamedFunction(source, best.headStart)
  if (!enclosing) return null
  const bodyEnd = matchClosingBrace(source, best.bodyOpen)
  if (bodyEnd < 0) return null
  const body = source.slice(best.bodyOpen, bodyEnd)
  const methodParams = new Set(paramNames(best.params))
  const captures = enclosing.params.filter(
    param => !methodParams.has(param) && new RegExp(`\\b${escapeIdent(param)}\\b`).test(body),
  )
  return {
    name: best.name,
    params: best.params,
    asyncKeyword: best.asyncKeyword,
    declStart: best.headStart,
    bodyEnd,
    enclosingName: enclosing.name,
    captures,
  }
}

function rewriteStaticClassMethods(
  source: string,
  idBase: string,
): { source: string; wrapped: boolean } {
  let out = source
  let wrapped = false
  let searchFrom = 0
  for (;;) {
    const tail = out.slice(searchFrom)
    const directive = directiveText.exec(tail)
    if (!directive) break
    const index = searchFrom + directive.index
    if (!/\{\s*$/.test(out.slice(0, index))) {
      searchFrom = index + directive[0].length
      continue
    }
    const method = findStaticClassMethod(out, index)
    if (!method) {
      searchFrom = index + directive[0].length
      continue
    }
    const id = `${idBase}#${method.className}.${method.name}`
    const wrappedHead = `static ${method.name} = __pnextUseCache(${JSON.stringify(id)}, ${method.asyncKeyword}function ${method.name}(${method.params}) {`
    out =
      out.slice(0, method.declStart) +
      wrappedHead +
      out.slice(index + directive[0].length, method.bodyEnd) +
      `})` +
      out.slice(method.bodyEnd + 1)
    wrapped = true
    searchFrom = method.declStart + wrappedHead.length
  }
  return { source: out, wrapped }
}

function findStaticClassMethod(
  source: string,
  directiveIndex: number,
): (NestedClosure & { className: string }) | null {
  const prefix = source.slice(0, directiveIndex)
  const methodRe = /(?:^|[\s;{}])static\s+(async\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g
  let match: RegExpExecArray | null
  let best: {
    asyncKeyword: string
    name: string
    params: string
    headStart: number
    bodyOpen: number
  } | null = null
  while ((match = methodRe.exec(prefix)) !== null) {
    const kwOffset = match[0].indexOf('static')
    const cleanStart = match.index + kwOffset
    const bodyOpen = match.index + match[0].length
    const between = source.slice(bodyOpen, directiveIndex)
    let balance = 0
    for (const ch of between) {
      if (ch === '{') balance += 1
      else if (ch === '}') balance -= 1
    }
    if (balance === 0) {
      best = {
        asyncKeyword: match[1] ? 'async ' : '',
        name: match[2]!,
        params: match[3]!.trim(),
        headStart: cleanStart,
        bodyOpen,
      }
    }
  }
  if (!best) return null
  const className = findEnclosingClassName(source, best.headStart)
  if (!className) return null
  const bodyEnd = matchClosingBrace(source, best.bodyOpen)
  if (bodyEnd < 0) return null
  return {
    name: best.name,
    params: best.params,
    asyncKeyword: best.asyncKeyword,
    declStart: best.headStart,
    bodyEnd,
    enclosingName: className,
    className,
    captures: [],
  }
}

function findEnclosingClassName(source: string, pos: number): string | null {
  const before = source.slice(0, pos)
  const re = /(?:^|[\s;{}])class\s+([A-Za-z_$][\w$]*)[^{]*\{/g
  let match: RegExpExecArray | null
  let candidate: string | null = null
  while ((match = re.exec(before)) !== null) {
    const bodyOpen = match.index + match[0].length
    const close = matchClosingBrace(source, bodyOpen)
    if (close > pos) candidate = match[1]!
  }
  return candidate
}

/**
 * Function-level directives: for each `'use cache'` opening a function body,
 * locate the enclosing declaration's name by scanning backwards, verify the
 * region between the declaration head and the directive is a plausible
 * function signature (brace balance of exactly one open), strip the directive
 * and mark the name for wrapping.
 */
function rewriteFunctionLevelDirectives(
  source: string,
  wrapped: Set<string>,
  privateWrapped: Set<string>,
): string {
  let out = source
  let searchFrom = 0
  for (;;) {
    const tail = out.slice(searchFrom)
    const directive = directiveText.exec(tail)
    if (!directive) break
    const index = searchFrom + directive.index
    const prefix = out.slice(0, index)

    // Only a directive when it opens a function body; anything else is a plain
    // string literal.
    const declaration = opensFunctionBody(prefix) ? findEnclosingDeclaration(prefix) : null
    if (!declaration) {
      searchFrom = index + directive[0].length
      continue
    }

    let head = prefix
    if (declaration.constKeywordIndex !== undefined) {
      head =
        prefix.slice(0, declaration.constKeywordIndex) +
        'let  ' +
        prefix.slice(declaration.constKeywordIndex + 'const'.length)
    }
    wrapped.add(declaration.name)
    if (directive[2] === 'private') privateWrapped.add(declaration.name)
    out = head + out.slice(index + directive[0].length)
    searchFrom = index
  }
  return out
}

/**
 * Whether `prefix` ends at the start of a function body - the brace reached by skipping back over
 * whitespace AND comments. A directive prologue is the first STATEMENT of the body, so a comment above
 * `'use cache'` must not hide it. Scanned rather than matched: a regex alternating whitespace and
 * comment forms backtracks badly.
 */
function opensFunctionBody(prefix: string): boolean {
  // The match is a comment's own text, not a directive, when `prefix` ends
  // inside a comment — e.g. a line explaining `'use cache'` semantics.
  if (prefix.includes('//', prefix.lastIndexOf('\n') + 1)) return false
  const blockOpen = prefix.lastIndexOf('/*')
  if (blockOpen !== -1 && !prefix.includes('*/', blockOpen)) return false

  let end = prefix.length
  for (;;) {
    end = prefix.slice(0, end).replace(/\s+$/, '').length
    if (end === 0) return false
    if (prefix.startsWith('*/', end - 2)) {
      const open = prefix.lastIndexOf('/*', end - 2)
      if (open === -1) return false
      end = open
      continue
    }
    const comment = prefix.indexOf('//', prefix.lastIndexOf('\n', end - 1) + 1)
    if (comment !== -1 && comment < end) {
      end = comment
      continue
    }
    return prefix[end - 1] === '{'
  }
}

interface EnclosingDeclaration {
  name: string
  /** Index of a `const` keyword to rewrite to `let`, when applicable. */
  constKeywordIndex?: number
}

function findEnclosingDeclaration(prefix: string): EnclosingDeclaration | null {
  const candidates: { name: string; end: number; constKeywordIndex?: number }[] = []

  // Only top-level declarations (line starts at column 0): a nested closure's
  // binding is function-scoped and cannot be reassigned from module level —
  // those run uncached (the directive string is inert).
  const topLevel = (index: number) => index === 0 || prefix[index - 1] === '\n'

  const fnPattern = /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/g
  for (const match of prefix.matchAll(fnPattern)) {
    if (match[1] && topLevel(match.index)) {
      candidates.push({ name: match[1], end: match.index + match[0].length })
    }
  }
  const bindingPattern = /(?:export\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g
  for (const match of prefix.matchAll(bindingPattern)) {
    if (!match[2] || !topLevel(match.index)) continue
    candidates.push({
      name: match[2],
      end: match.index + match[0].length,
      ...(match[1] === 'const'
        ? { constKeywordIndex: match.index + match[0].indexOf('const') }
        : {}),
    })
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.end - b.end)
  const nearest = candidates[candidates.length - 1]!

  // The span between the declaration head and the directive must look like a
  // signature followed by the opening body brace: exactly one unclosed '{'.
  const span = prefix.slice(nearest.end)
  let balance = 0
  for (const char of span) {
    if (char === '{') balance += 1
    else if (char === '}') balance -= 1
  }
  if (balance !== 1) return null

  return {
    name: nearest.name,
    ...(nearest.constKeywordIndex !== undefined
      ? { constKeywordIndex: nearest.constKeywordIndex }
      : {}),
  }
}
