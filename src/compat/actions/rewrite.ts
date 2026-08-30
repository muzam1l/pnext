import { inlineUseServerFunctions, moduleLevelUseServer } from './detect'
import { workspaceRelative } from './ids'

/**
 * Compile-time tagging for MODULE-SCOPE inline server actions: top-level functions whose body opens
 * with 'use server' in a file that is NOT a module-level 'use server' module. Inserts a tagging call
 * immediately after each declaration, which registers the live instance under a stable id and attaches
 * React-compatible `$$id` metadata.
 *
 * The tag is placed right after the declaration, not at module end, so any module-scope code that
 * reads `fn.$$id` after declaring the action sees it already set. Function-scope inline actions are
 * untouched - they register per render through the render-scoped instance registry.
 */
export function rewriteInlineActionTags(source: string, file: string, root?: string): string {
  if (!source.includes('use server')) return source
  if (moduleLevelUseServer(source)) return source

  const topLevel = inlineUseServerFunctions(source).filter(
    action => action.start === 0 || source[action.start - 1] === '\n',
  )
  if (topLevel.length === 0) return source

  const key = workspaceRelative(file, root)
  const insertions: { at: number; text: string }[] = []
  const fallbacks: string[] = []
  for (const action of topLevel) {
    if (source.includes(`__pnextTagInlineAction(${action.name},`)) continue
    const id = inlineActionId(key, action.name)
    const tag = `\n;typeof ${action.name} === 'function' && globalThis.__pnextTagInlineAction && globalThis.__pnextTagInlineAction(${action.name}, ${JSON.stringify(id)});`
    const at = declarationEnd(source, action.directiveEnd)
    if (at === undefined) fallbacks.push(tag)
    else insertions.push({ at, text: tag })
  }
  let out = source
  for (const { at, text } of insertions.sort((a, b) => b.at - a.at)) {
    out = out.slice(0, at) + text + out.slice(at)
  }
  if (fallbacks.length > 0) out = `${out}\n${fallbacks.join('\n')}\n`
  return out
}

/**
 * Compile-time marking for ANONYMOUS inline server actions: function expressions whose body opens with
 * 'use server' and that are passed directly as a prop/argument. They have no name to tag a stable id
 * on, and the directive does not survive to String(fn) - the loader that evaluates the compiled module
 * drops directive prologues - so serialization has nothing to distinguish them from an ordinary client
 * handler. Wrapping the expression in a marking call leaves a mark on the live function that survives
 * compilation.
 *
 * Same heuristic-not-a-parser caveats as the rest of this module: only real function expressions in
 * expression position are wrapped, and a `'use server'` string right after an unrelated brace can match.
 */
export function rewriteAnonymousInlineActionMarks(source: string): string {
  if (!source.includes('use server')) return source
  if (moduleLevelUseServer(source)) return source

  const wraps = anonymousInlineActionSpans(source)
  if (wraps.length === 0) return source

  let out = source
  for (const { start, end } of wraps.sort((a, b) => b.start - a.start)) {
    const fn = out.slice(start, end)
    out = `${out.slice(0, start)}(globalThis.__pnextMarkInlineAction ? globalThis.__pnextMarkInlineAction(${fn}) : ${fn})${out.slice(end)}`
  }
  return out
}

/** One anonymous inline action: the span of its whole function expression. */
export interface AnonymousActionSpan {
  /** Offset of the first character of the function expression. */
  start: number
  /** Offset just past its closing `}`. */
  end: number
  /** Offset just past the `'use server'` directive that identified it. */
  directiveEnd: number
}

/**
 * Spans of every anonymous inline server action in `source` - the shared scan behind both the mark
 * rewrite and the hoist pass. Nested actions are reported too; callers that can only handle outermost
 * ones filter themselves.
 */
export function anonymousInlineActionSpans(source: string): AnonymousActionSpan[] {
  const directive = /\{\s*(['"])use server\1\s*;?/g
  const spans: AnonymousActionSpan[] = []
  for (let match; (match = directive.exec(source));) {
    const start = functionExpressionStart(source, match.index)
    if (start === undefined) continue
    const end = bodyEnd(source, match.index)
    if (end === undefined) continue
    spans.push({ start, end, directiveEnd: match.index + match[0].length })
  }
  return spans
}

/**
 * Start offset of the function expression whose body opens at `open`, or
 * undefined when the construct is not a wrappable expression (a `function`
 * *declaration*, an object method, or a plain block).
 */
function functionExpressionStart(source: string, open: number): number | undefined {
  let i = skipBackWhitespace(source, open - 1)
  if (source[i] === '>' && source[i - 1] === '=') {
    // arrow: `(...) =>` or `param =>`
    i = skipBackWhitespace(source, i - 2)
    const head = source[i] === ')' ? matchingOpenParen(source, i) : identifierStart(source, i)
    if (head === undefined) return undefined
    i = head
  } else if (source[i] === ')') {
    // function expression: `function [name](...)`
    const paren = matchingOpenParen(source, i)
    if (paren === undefined) return undefined
    let j = skipBackWhitespace(source, paren - 1)
    const name = identifierStart(source, j)
    if (name === undefined) return undefined
    if (source.slice(name, j + 1) !== 'function') {
      j = skipBackWhitespace(source, name - 1)
      const keyword = identifierStart(source, j)
      if (keyword === undefined || source.slice(keyword, j + 1) !== 'function') return undefined
      i = keyword
    } else {
      i = name
    }
  } else {
    return undefined
  }
  const withAsync = precedingKeyword(source, i, 'async')
  if (withAsync !== undefined) i = withAsync
  // Only expression position: a `function`/`const` declaration statement or a
  // bare block must not be wrapped.
  const before = skipBackWhitespace(source, i - 1)
  if (before < 0) return undefined
  if (source[before] === '{') return isJsxExpressionContainer(source, before) ? i : undefined
  return '(,:[=?&|'.includes(source[before] ?? '') ? i : undefined
}

/**
 * True when the brace at `open` opens a JSX expression container - the way an action normally reaches a
 * prop - or JSX children. A brace that opens a *block* (a component body, an `if`) must be told apart
 * from those: a `'use server'` function declared directly in a component body is a declaration whose
 * name the component still references, so rewriting it in place would leave that name unbound.
 */
function isJsxExpressionContainer(source: string, open: number): boolean {
  const before = skipBackWhitespace(source, open - 1)
  if (before < 0) return false
  const ch = source[before]
  // `prop={…` (attribute) or `<div>{…` (children) — but not `=>{` (arrow body)
  // and not `==`/`>=` style operators.
  if (source[before - 1] === '=') return false
  return ch === '=' || ch === '>'
}

function skipBackWhitespace(source: string, from: number): number {
  let i = from
  while (i >= 0 && /\s/.test(source[i] ?? '')) i--
  return i
}

function identifierStart(source: string, end: number): number | undefined {
  if (!/[\w$]/.test(source[end] ?? '')) return undefined
  let i = end
  while (i >= 0 && /[\w$]/.test(source[i] ?? '')) i--
  return i + 1
}

function matchingOpenParen(source: string, close: number): number | undefined {
  let depth = 0
  for (let i = close; i >= 0; i--) {
    if (source[i] === ')') depth++
    else if (source[i] === '(') {
      depth--
      if (depth === 0) return i
    }
  }
  return undefined
}

/** Start offset of `keyword` when it directly precedes `at`, else undefined. */
function precedingKeyword(source: string, at: number, keyword: string): number | undefined {
  const end = skipBackWhitespace(source, at - 1)
  const start = identifierStart(source, end)
  if (start === undefined || source.slice(start, end + 1) !== keyword) return undefined
  return start
}

/** Offset just past the `}` closing the function body that opens at `open`. */
function bodyEnd(source: string, open: number): number | undefined {
  const end = declarationEnd(source, open + 1)
  if (end === undefined) return undefined
  return source[end - 1] === ';' ? end - 1 : end
}

function declarationEnd(source: string, directiveEnd: number): number | undefined {
  // The body-open `{` is the last `{` at or before the directive.
  let open = -1
  for (let i = directiveEnd - 1; i >= 0; i--) {
    if (source[i] === '{') {
      open = i
      break
    }
  }
  if (open === -1) return undefined
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const ch = source[i]
    // Skip string/template/comment spans so their braces don't miscount and
    // shift the insertion point into the middle of an expression.
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(source, i, ch)
      continue
    }
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i + 2)
      if (nl === -1) return undefined
      i = nl
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      if (end === -1) return undefined
      i = end + 1
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        let end = i + 1
        if (source[end] === ';') end += 1
        return end
      }
    }
  }
  return undefined
}

/** Return the index of the closing quote of a string/template starting at `i`. */
function skipString(source: string, i: number, quote: string): number {
  for (let j = i + 1; j < source.length; j++) {
    const ch = source[j]
    if (ch === '\\') {
      j += 1
      continue
    }
    if (ch === quote) return j
    // Nested `${...}` in template literals can contain braces/strings; a
    // conservative bail (treat the rest as opaque) is safer than miscounting.
    if (quote === '`' && ch === '$' && source[j + 1] === '{') {
      let depth = 1
      j += 2
      while (j < source.length && depth > 0) {
        if (source[j] === '{') depth++
        else if (source[j] === '}') depth--
        j++
      }
      j -= 1
    }
  }
  return source.length
}

function inlineActionId(fileKey: string, name: string): string {
  // 'if:' ids embed the module key so a cold lookup can import the module
  // (running the injected registration) and retry — see resolveAction.
  return `if:${encodeURIComponent(fileKey)}:${encodeURIComponent(name)}`
}

/** Parse the module key out of an 'if:' inline-action id. */
export function inlineActionModuleKey(id: string): string | undefined {
  if (!id.startsWith('if:')) return undefined
  const rest = id.slice(3)
  const separator = rest.lastIndexOf(':')
  if (separator === -1) return undefined
  try {
    return decodeURIComponent(rest.slice(0, separator))
  } catch {
    return undefined
  }
}

export function isInlineActionId(id: string): boolean {
  return id.startsWith('if:')
}
