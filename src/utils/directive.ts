/**
 * Whether `source` opens with the `directive` prologue string. Linear and allocation-free: a regex
 * over leading comments backtracks catastrophically on files with many comments and no directive.
 */
export function hasModuleDirective(source: string, directive: string) {
  const isSpace = (index: number) => {
    const code = source.charCodeAt(index)
    return code === 32 || (code >= 9 && code <= 13) || (code > 127 && /\s/.test(source[index]!))
  }
  let i = 0
  for (;;) {
    while (i < source.length && isSpace(i)) i += 1
    if (source.startsWith('//', i)) {
      const newline = source.indexOf('\n', i)
      if (newline === -1) return false
      i = newline + 1
      continue
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2)
      if (end === -1) return false
      i = end + 2
      continue
    }
    // Anything that is not a string literal ends the prologue.
    const quote = source[i]
    if (quote !== '"' && quote !== "'") return false
    let end = i + 1
    while (end < source.length) {
      const char = source[end]!
      if (char === quote || char === '\n' || char === '\\') break
      end += 1
    }
    if (source[end] !== quote) return false
    if (source.slice(i + 1, end) === directive) return true
    i = end + 1
    while (i < source.length && isSpace(i)) i += 1
    if (source[i] === ';') i += 1
  }
}
