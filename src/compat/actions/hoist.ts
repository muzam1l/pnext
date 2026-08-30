import { inlineUseServerFunctions, moduleLevelUseServer } from './detect'
import { anonymousInlineActionSpans } from './rewrite'

/**
 * Hoist anonymous inline server actions that capture nothing to module-scope consts, which
 * rewriteInlineActionTags then gives stable `if:` ids. That lets the action endpoint resolve them by
 * module import alone - the per-render `i:` instance path re-renders the whole route on the first
 * dispatch against a prebuilt page.
 *
 * No JS parser here, so the capture analysis FAILS CLOSED: every referenced identifier must resolve to
 * a module-scope binding, a known global, or the function's own declarations; anything unclassifiable
 * (`this`, `arguments`, destructured params, JSX) leaves the action on the per-render path.
 */
export function hoistNonCapturingInlineActions(source: string): string {
  if (!source.includes('use server')) return source
  if (moduleLevelUseServer(source)) return source
  // Some pipelines transform a module twice (a bundled external is rewritten on
  // load and again on its esbuild output). The pass must be idempotent: a second
  // hoist would re-emit declarations under names the first pass already used.
  if (source.includes(HOIST_PREFIX)) return source

  const spans = anonymousInlineActionSpans(source)
  if (spans.length === 0) return source

  // The span scan is text-based, so `'use server'` inside a STRING (a codegen
  // template, a test fixture, a docs snippet) looks exactly like an action. This
  // pass moves code, so acting on one would rewrite the string's contents:
  // require every hoisted span to start at real, unquoted code.
  const masked = blankLiterals(source)
  if (masked === undefined) return source

  // Skip actions a NAMED declaration already covers (`const a = async () => {
  // 'use server' }`). At module scope rewriteInlineActionTags already gives them
  // an `if:` id where they stand; at any other position the name is what the
  // surrounding code refers to, so moving the initializer only adds an alias.
  // Not line-anchored: bundled output indents module-scope declarations, and
  // hoisting one there would also read the binding before its declaration.
  const named = inlineUseServerFunctions(source)
  const candidates = spans.filter(
    span =>
      masked[span.start] === source[span.start] &&
      !named.some(action => action.directiveEnd > span.start && action.directiveEnd <= span.end) &&
      // Outermost only: an action declared inside another action's body would be
      // hoisted out of a scope that is itself a function.
      !spans.some(other => other !== span && other.start <= span.start && other.end >= span.end),
  )
  if (candidates.length === 0) return source

  const moduleBindings = moduleScopeBindings(source)
  const hoists: { start: number; end: number; name: string }[] = []
  for (const span of candidates) {
    if (!capturesNothing(source.slice(span.start, span.end), moduleBindings)) continue
    hoists.push({ start: span.start, end: span.end, name: `${HOIST_PREFIX}${hoists.length}` })
  }
  if (hoists.length === 0) return source

  let out = source
  const declarations: string[] = []
  for (const { start, end, name } of [...hoists].sort((a, b) => b.start - a.start)) {
    declarations.unshift(`const ${name} = ${out.slice(start, end)};`)
    out = `${out.slice(0, start)}${name}${out.slice(end)}`
  }
  // Emitted at the TOP of the module (just after any directive prologue), each on its own line so
  // rewriteInlineActionTags - which only tags line-anchored declarations - picks them up. Top, not
  // bottom: an action passed to a module-scope call is read while the module evaluates, and a const
  // declared below that point would still be in its temporal dead zone. Import bindings are
  // initialized before the module body runs, and everything else the body reads is only reached when
  // the action is called.
  const at = prologueEnd(out)
  return `${out.slice(0, at)}\n${declarations.join('\n')}\n${out.slice(at)}`
}

/**
 * Offset just past the module's directive prologue (and any shebang/leading comments) - the first
 * point at which a statement may be inserted without displacing a directive.
 */
function prologueEnd(source: string): number {
  let i = source.startsWith('﻿') ? 1 : 0
  if (source.startsWith('#!', i)) {
    const nl = source.indexOf('\n', i)
    i = nl === -1 ? source.length : nl + 1
  }
  for (;;) {
    let j = i
    while (j < source.length && /\s/.test(source[j] ?? '')) j++
    if (source.startsWith('//', j)) {
      const nl = source.indexOf('\n', j)
      i = nl === -1 ? source.length : nl + 1
      continue
    }
    if (source.startsWith('/*', j)) {
      const end = source.indexOf('*/', j + 2)
      if (end === -1) return i
      i = end + 2
      continue
    }
    const directive = /^(['"])[^'"\n]*\1\s*;?/.exec(source.slice(j))
    if (!directive) return i
    i = j + directive[0].length
  }
}

/**
 * True when every identifier the function references is resolvable without the
 * enclosing function scopes. Conservative: "cannot tell" is false.
 */
function capturesNothing(text: string, moduleBindings: Set<string>): boolean {
  // Literal spans are blanked (same offsets, content replaced by spaces) so that
  // neither the identifier scan nor the parameter scan can read code out of a
  // string, comment, or regex. Template `${...}` interpolations are kept: the
  // identifiers in them are real references.
  const code = blankLiterals(text)
  if (code === undefined) return false
  const tokens = identifierTokens(code)
  if (tokens === undefined) return false
  const locals = localBindings(code, tokens)
  if (locals === undefined) return false
  return tokens.every(
    token =>
      token.kind !== 'reference' ||
      locals.has(token.value) ||
      moduleBindings.has(token.value) ||
      GLOBALS.has(token.value),
  )
}

type TokenKind = 'reference' | 'property' | 'key' | 'keyword'

interface Token {
  value: string
  kind: TokenKind
  /** Offset of the identifier's first character within the scanned text. */
  at: number
}

/**
 * Identifier tokens of already-blanked code. `undefined` when the code uses a
 * construct whose scoping this scanner cannot reason about.
 */
function identifierTokens(code: string): Token[] | undefined {
  const tokens: Token[] = []
  let previous = ''
  let i = 0
  while (i < code.length) {
    const ch = code[i] ?? ''
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (!/[A-Za-z_$]/.test(ch)) {
      previous = ch
      i++
      continue
    }
    let j = i
    while (j < code.length && /[\w$]/.test(code[j] ?? '')) j++
    const value = code.slice(i, j)
    if (OPAQUE.has(value)) return undefined
    let k = j
    while (k < code.length && /\s/.test(code[k] ?? '')) k++
    const kind: TokenKind = KEYWORDS.has(value)
      ? 'keyword'
      : previous === '.'
        ? 'property'
        : code[k] === ':' && (previous === '{' || previous === ',')
          ? 'key'
          : 'reference'
    tokens.push({ value, kind, at: i })
    previous = 'a'
    i = j
  }
  return tokens
}

/**
 * Names the function binds itself: its own parameters plus every parameter and declaration nested
 * inside it. `undefined` for a binding form this scanner will not read precisely (destructuring,
 * defaults) - guessing either way risks hoisting a function that does capture.
 */
function localBindings(code: string, tokens: Token[]): Set<string> | undefined {
  const locals = new Set<string>()
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (token?.kind !== 'keyword') continue
    if (token.value === 'const' || token.value === 'let' || token.value === 'var') {
      const bound = declaredName(code, token)
      if (bound === undefined) return undefined
      locals.add(bound)
    } else if (token.value === 'function' || token.value === 'class' || token.value === 'catch') {
      const next = tokens[index + 1]
      if (next?.kind === 'reference') locals.add(next.value)
    }
  }
  for (const params of parameterLists(code)) {
    if (params === undefined) return undefined
    for (const name of params) locals.add(name)
  }
  return locals
}

/** The single name bound by the `const`/`let`/`var` at `token`, if simple. */
function declaredName(code: string, token: Token): string | undefined {
  let i = token.at + token.value.length
  while (i < code.length && /\s/.test(code[i] ?? '')) i++
  if (!/[A-Za-z_$]/.test(code[i] ?? '')) return undefined // destructuring pattern
  let j = i
  while (j < code.length && /[\w$]/.test(code[j] ?? '')) j++
  return code.slice(i, j)
}

/**
 * Every parameter list in `code` - the scanned function's own and any nested one. Yields `undefined`
 * for a list this scanner will not read precisely, which makes the whole function unhoistable.
 */
function* parameterLists(code: string): Generator<string[] | undefined> {
  const arrow = /=>/g
  for (let match; (match = arrow.exec(code));) {
    let i = match.index - 1
    while (i >= 0 && /\s/.test(code[i] ?? '')) i--
    if (code[i] === ')') {
      const open = matchingOpenParen(code, i)
      yield open === undefined ? undefined : parameterNames(code.slice(open + 1, i))
      continue
    }
    let j = i
    while (j >= 0 && /[\w$]/.test(code[j] ?? '')) j--
    const name = code.slice(j + 1, i + 1)
    yield /^[A-Za-z_$][\w$]*$/.test(name) ? [name] : undefined
  }
  const fnDecl = /\bfunction\b\s*\*?\s*(?:[A-Za-z_$][\w$]*)?\s*\(/g
  for (let match; (match = fnDecl.exec(code));) {
    const open = match.index + match[0].length - 1
    const close = matchingCloseParen(code, open)
    yield close === undefined ? undefined : parameterNames(code.slice(open + 1, close))
  }
}

/**
 * Names bound by a parameter list's source text. `undefined` for destructuring, default values, or a
 * nested function type - forms where a name in the list is not simply a binding.
 */
function parameterNames(params: string): string[] | undefined {
  const stripped = params.trim()
  if (stripped === '') return []
  if (/[{}[\]=(]/.test(stripped)) return undefined
  const names: string[] = []
  for (const part of stripped.split(',')) {
    // `name: Type` (TS annotation) binds `name`; the annotation is types only.
    const name = (part.split(':')[0] ?? '').trim().replace(/^\.\.\./, '')
    if (name === '') continue
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return undefined
    names.push(name)
  }
  return names
}

/**
 * Value bindings introduced at module scope. Line-anchored on purpose: an
 * indented declaration belongs to some inner scope and must not be mistaken for
 * one a hoisted function could still reach.
 */
function moduleScopeBindings(source: string): Set<string> {
  const names = new Set<string>()
  const declaration =
    /^(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\s*\*?|class)\s+([A-Za-z_$][\w$]*)/gm
  for (let match; (match = declaration.exec(source));) if (match[1]) names.add(match[1])

  const importClause = /^import\s+(?!type\b)([\s\S]*?)\s+from\s+['"]/gm
  for (let match; (match = importClause.exec(source));) {
    const clause = match[1] ?? ''
    const namespace = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause)
    if (namespace?.[1]) names.add(namespace[1])
    const defaultName = /^([A-Za-z_$][\w$]*)/.exec(clause.trim())
    if (defaultName?.[1]) names.add(defaultName[1])
    const braced = /\{([^}]*)\}/.exec(clause)
    for (const part of (braced?.[1] ?? '').split(',')) {
      const trimmed = part.trim()
      if (trimmed === '' || trimmed.startsWith('type ')) continue
      const renamed = /\bas\s+([A-Za-z_$][\w$]*)\s*$/.exec(trimmed)
      const name = renamed?.[1] ?? trimmed
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name)
    }
  }
  return names
}

/**
 * Replace the CONTENT of strings, comments and regex literals with spaces,
 * preserving every offset, so later scans only ever see real code. Template
 * literals keep their `${...}` interpolations (real expressions) and blank the
 * literal chunks. `undefined` when a literal is unterminated.
 */
function blankLiterals(text: string): string | undefined {
  const out = text.split('')
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (out[i] !== '\n') out[i] = ' '
  }
  // Template nesting: 'template' = inside literal text, 'interp' = inside a
  // `${...}` (which is ordinary code and may itself open a template).
  const stack: ({ kind: 'template' } | { kind: 'interp'; depth: number })[] = []
  let previous = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i] ?? ''
    const top = stack[stack.length - 1]
    if (top?.kind === 'template') {
      if (ch === '\\') {
        blank(i, i + 2)
        i += 2
      } else if (ch === '`') {
        stack.pop()
        previous = '`'
        i++
      } else if (ch === '$' && text[i + 1] === '{') {
        // Blank the `${` delimiter too — only the expression inside it is code.
        stack.push({ kind: 'interp', depth: 0 })
        blank(i, i + 2)
        previous = '('
        i += 2
      } else {
        blank(i, i + 1)
        i++
      }
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i)
      const end = nl === -1 ? text.length : nl
      blank(i, end)
      i = end
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end === -1) return undefined
      blank(i, end + 2)
      i = end + 2
      continue
    }
    if (ch === '"' || ch === "'") {
      const end = endOfQuoted(text, i, ch)
      if (end === undefined) {
        // No closing quote before the newline, so this is not a string at all —
        // most often an apostrophe in JSX text (`<p>don't</p>`). Treating it as
        // one would mask the rest of the file.
        previous = ch
        i++
        continue
      }
      blank(i + 1, end - 1)
      previous = ch
      i = end
      continue
    }
    if (ch === '/' && REGEX_PRECEDERS.has(previous)) {
      const end = endOfRegex(text, i)
      if (end === undefined) {
        // Not a regex after all — in TSX this is nearly always a JSX slash
        // (`<p />`, `</p>`), whose preceding character looks like an operator.
        previous = ch
        i++
        continue
      }
      blank(i, end)
      previous = ' '
      i = end
      continue
    }
    if (ch === '`') stack.push({ kind: 'template' })
    else if (top?.kind === 'interp') {
      if (ch === '{') top.depth++
      else if (ch === '}') {
        if (top.depth === 0) {
          stack.pop()
          blank(i, i + 1)
        } else top.depth--
      }
    }
    previous = ch
    i++
  }
  return stack.length === 0 ? out.join('') : undefined
}

/** Offset just past the string starting at `i`, or undefined if unterminated. */
function endOfQuoted(text: string, i: number, quote: string): number | undefined {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') {
      j++
      continue
    }
    if (text[j] === quote) return j + 1
    if (text[j] === '\n') return undefined
  }
  return undefined
}

/** Offset just past the regex literal (with flags) starting at `i`. */
function endOfRegex(text: string, i: number): number | undefined {
  let inClass = false
  for (let j = i + 1; j < text.length; j++) {
    const ch = text[j]
    if (ch === '\\') {
      j++
      continue
    }
    if (ch === '\n') return undefined
    if (ch === '[') inClass = true
    else if (ch === ']') inClass = false
    else if (ch === '/' && !inClass) {
      let k = j + 1
      while (k < text.length && /[a-z]/.test(text[k] ?? '')) k++
      return k
    }
  }
  return undefined
}

function matchingOpenParen(text: string, close: number): number | undefined {
  let depth = 0
  for (let i = close; i >= 0; i--) {
    if (text[i] === ')') depth++
    else if (text[i] === '(') {
      depth--
      if (depth === 0) return i
    }
  }
  return undefined
}

function matchingCloseParen(text: string, open: number): number | undefined {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return undefined
}

/** Name prefix of every hoisted declaration; also the idempotence marker. */
const HOIST_PREFIX = '__pnextInlineAction$'

/** Constructs whose scoping this scanner refuses to reason about. */
const OPAQUE = new Set(['this', 'arguments', 'super', 'eval', 'with'])

const KEYWORDS = new Set([
  'as',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'export',
  'extends',
  'finally',
  'for',
  'from',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'let',
  'new',
  'of',
  'return',
  'satisfies',
  'static',
  'switch',
  'throw',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'yield',
  // TS type positions the scanner walks through without resolving.
  'any',
  'asserts',
  'bigint',
  'boolean',
  'declare',
  'enum',
  'infer',
  'interface',
  'is',
  'keyof',
  'namespace',
  'never',
  'number',
  'object',
  'readonly',
  'string',
  'symbol',
  'type',
  'undefined',
  'unique',
  'unknown',
])

/** Globals a module-scope function reaches exactly as an inner one would. */
const GLOBALS = new Set([
  'AbortController',
  'AbortSignal',
  'AggregateError',
  'Array',
  'ArrayBuffer',
  'Atomics',
  'BigInt',
  'BigInt64Array',
  'BigUint64Array',
  'Blob',
  'Boolean',
  'Buffer',
  'DataView',
  'Date',
  'Error',
  'EvalError',
  'Event',
  'EventTarget',
  'File',
  'FinalizationRegistry',
  'Float32Array',
  'Float64Array',
  'FormData',
  'Function',
  'Headers',
  'Infinity',
  'Int16Array',
  'Int32Array',
  'Int8Array',
  'Intl',
  'Iterator',
  'JSON',
  'Map',
  'Math',
  'NaN',
  'Number',
  'Object',
  'Promise',
  'Proxy',
  'RangeError',
  'ReadableStream',
  'ReferenceError',
  'Reflect',
  'RegExp',
  'Request',
  'Response',
  'Set',
  'SharedArrayBuffer',
  'String',
  'Symbol',
  'SyntaxError',
  'TextDecoder',
  'TextEncoder',
  'TransformStream',
  'TypeError',
  'URIError',
  'URL',
  'URLSearchParams',
  'Uint16Array',
  'Uint32Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'WeakMap',
  'WeakRef',
  'WeakSet',
  'WritableStream',
  'atob',
  'btoa',
  'clearInterval',
  'clearTimeout',
  'console',
  'crypto',
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'fetch',
  'globalThis',
  'isFinite',
  'isNaN',
  'parseFloat',
  'parseInt',
  'performance',
  'process',
  'queueMicrotask',
  'setInterval',
  'setTimeout',
  'structuredClone',
])

/**
 * Characters after which a `/` opens a regex literal rather than dividing. An
 * identifier or literal never precedes a regex, so the default is division.
 */
const REGEX_PRECEDERS = new Set([
  '',
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '~',
  '^',
  '\n',
])
