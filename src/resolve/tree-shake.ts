// Tree-shaking for destructured dynamic imports (mirrors webpack's `import()` export usage analysis).
//
// `const { used } = await import('./mod')` only ever touches `used`, so the unused exports of './mod' are
// dead. esbuild cannot see this across the dynamic-import boundary (each module is compiled standalone and
// keeps every export), so the server module compiler rewrites the qualifying `import()` to a per-usage
// facade module that re-exports ONLY the destructured names, letting esbuild drop the rest when it inlines
// the target.
//
// Only the syntactic forms webpack tree-shakes are recognized:
//   - `const|let|var { a, b: c } = await import('lit')`   (named / renamed)
//   - `const { nested: { inner } } = await import('lit')` (top-level key kept)
//   - `const { default: d } = await import('lit')`        (default kept)
//   - `const {} = await import('lit')`                    (all exports dropped; side effects kept)
//   - `/* webpackExports: [...] */` magic comment overrides the used set.
//
// A rest element, member access, re-assignment and `.then(({ ... }) => ...)` destructuring are NOT
// tree-shaken by webpack, so they never match here and the target keeps all exports.

export interface ShakeableDynamicImport {
  /** Absolute index (inclusive) of the specifier string literal, quote included. */
  literalStart: number
  /** Absolute index (exclusive) just past the closing quote. */
  literalEnd: number
  /** The import specifier (without quotes). */
  specifier: string
  /**
   * Export names the destructuring keeps. An empty array means the module is
   * imported purely for side effects (`const {} = ...`): drop every export.
   */
  usedExports: string[]
}

const declStart = /\b(?:const|let|var)\s+\{/g

export function findShakeableDynamicImports(source: string): ShakeableDynamicImport[] {
  const results: ShakeableDynamicImport[] = []
  let match: RegExpExecArray | null

  while ((match = declStart.exec(source))) {
    const braceOpen = match.index + match[0].length - 1
    const braceClose = matchDelimiter(source, braceOpen, '{', '}')
    if (braceClose < 0) continue

    let index = skipTrivia(source, braceClose + 1)
    if (source[index] !== '=') continue
    index = skipTrivia(source, index + 1)
    if (!matchesWord(source, index, 'await')) continue
    index = skipTrivia(source, index + 'await'.length)
    if (!matchesWord(source, index, 'import')) continue
    index = skipTrivia(source, index + 'import'.length)
    if (source[index] !== '(') continue

    const parenClose = matchDelimiter(source, index, '(', ')')
    if (parenClose < 0) continue
    const argStart = index + 1
    const argText = source.slice(argStart, parenClose)

    const literal = firstStringLiteral(argText)
    if (!literal || hasTrailingArgument(argText, literal.end)) continue

    const patternExports = usedExportsFromPattern(source.slice(braceOpen, braceClose + 1))
    if (patternExports === null) continue // rest element — not shakeable

    const webpackExports = webpackExportsFromArg(argText)
    results.push({
      literalStart: argStart + literal.start,
      literalEnd: argStart + literal.end,
      specifier: literal.value,
      usedExports: webpackExports ?? patternExports,
    })
    declStart.lastIndex = parenClose + 1
  }

  return results
}

// Parse an object destructuring pattern (braces included) into the top-level
// export names it binds. Returns null when a rest element is present (webpack
// gives up on tree-shaking then).
function usedExportsFromPattern(pattern: string): string[] | null {
  const inner = pattern.slice(1, -1)
  const names: string[] = []

  for (const rawPart of splitTopLevel(inner)) {
    const part = rawPart.trim()
    if (!part) continue
    if (part.startsWith('...')) return null

    const colon = topLevelColonIndex(part)
    const keyRegion = colon >= 0 ? part.slice(0, colon) : part
    // `{ a = fallback }` shorthand with a default — the key is before `=`.
    const eq = colon >= 0 ? -1 : keyRegion.indexOf('=')
    const name = (eq >= 0 ? keyRegion.slice(0, eq) : keyRegion).trim()
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null // computed/string key — bail
    names.push(name)
  }

  return names
}

function webpackExportsFromArg(argText: string): string[] | undefined {
  const match = /webpackExports\s*:\s*\[([^\]]*)\]/.exec(argText)
  if (!match) return undefined
  const names: string[] = []
  const namePattern = /['"]([^'"]+)['"]/g
  let entry: RegExpExecArray | null
  while ((entry = namePattern.exec(match[1] ?? ''))) {
    if (entry[1]) names.push(entry[1])
  }
  return names
}

// Split a comma-separated list at top level, ignoring commas nested in braces,
// brackets, parens, strings, or comments.
function splitTopLevel(source: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  let index = 0

  while (index < source.length) {
    const skipped = skipStringOrComment(source, index)
    if (skipped > index) {
      index = skipped
      continue
    }
    const char = source[index]
    if (char === '{' || char === '[' || char === '(') depth += 1
    else if (char === '}' || char === ']' || char === ')') depth -= 1
    else if (char === ',' && depth === 0) {
      parts.push(source.slice(start, index))
      start = index + 1
    }
    index += 1
  }
  parts.push(source.slice(start))
  return parts
}

function topLevelColonIndex(source: string): number {
  let depth = 0
  let index = 0
  while (index < source.length) {
    const skipped = skipStringOrComment(source, index)
    if (skipped > index) {
      index = skipped
      continue
    }
    const char = source[index]
    if (char === '{' || char === '[' || char === '(') depth += 1
    else if (char === '}' || char === ']' || char === ')') depth -= 1
    else if (char === ':' && depth === 0) return index
    index += 1
  }
  return -1
}

// Index of the matching close delimiter for the open delimiter at `open`,
// respecting nested delimiters, strings, and comments. Returns -1 if unbalanced.
function matchDelimiter(source: string, open: number, openChar: string, closeChar: string): number {
  let depth = 0
  let index = open
  while (index < source.length) {
    const skipped = skipStringOrComment(source, index)
    if (skipped > index) {
      index = skipped
      continue
    }
    const char = source[index]
    if (char === openChar) depth += 1
    else if (char === closeChar) {
      depth -= 1
      if (depth === 0) return index
    }
    index += 1
  }
  return -1
}

// Locate the first string literal in `text`, skipping leading whitespace and
// comments. Returns its bounds (quotes included, `end` exclusive) and value.
function firstStringLiteral(
  text: string,
): { start: number; end: number; value: string } | undefined {
  let index = skipTrivia(text, 0)
  const quote = text[index]
  if (quote !== '"' && quote !== "'" && quote !== '`') return undefined
  const start = index
  index += 1
  let value = ''
  while (index < text.length) {
    const char = text[index]
    if (char === '\\') {
      value += text[index + 1] ?? ''
      index += 2
      continue
    }
    if (char === quote) return { start, end: index + 1, value }
    value += char
    index += 1
  }
  return undefined
}

// True when a second top-level argument follows the specifier — `import('x', y)`
// is not a bare specifier import and is left untouched.
function hasTrailingArgument(argText: string, afterLiteral: number): boolean {
  const index = skipTrivia(argText, afterLiteral)
  return (
    index < argText.length && argText[index] === ',' && Boolean(argText.slice(index + 1).trim())
  )
}

function matchesWord(source: string, index: number, word: string): boolean {
  if (!source.startsWith(word, index)) return false
  const after = source[index + word.length]
  return after === undefined || !/[\w$]/.test(after)
}

// Skip whitespace and `//`/`/* */` comments starting at `index`.
function skipTrivia(source: string, index: number): number {
  let current = index
  for (;;) {
    while (current < source.length && /\s/.test(source[current] ?? '')) current += 1
    const skipped = skipComment(source, current)
    if (skipped === current) return current
    current = skipped
  }
}

// If `index` starts a string or comment, return the index just past it;
// otherwise return `index` unchanged.
function skipStringOrComment(source: string, index: number): number {
  const comment = skipComment(source, index)
  if (comment > index) return comment
  const char = source[index]
  if (char === '"' || char === "'" || char === '`') {
    let current = index + 1
    while (current < source.length) {
      if (source[current] === '\\') {
        current += 2
        continue
      }
      if (source[current] === char) return current + 1
      current += 1
    }
    return source.length
  }
  return index
}

function skipComment(source: string, index: number): number {
  if (source[index] === '/' && source[index + 1] === '/') {
    let current = index + 2
    while (current < source.length && source[current] !== '\n') current += 1
    return current
  }
  if (source[index] === '/' && source[index + 1] === '*') {
    let current = index + 2
    while (current < source.length && !(source[current] === '*' && source[current + 1] === '/')) {
      current += 1
    }
    return Math.min(source.length, current + 2)
  }
  return index
}
