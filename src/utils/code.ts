export function escapeRegex(value: string) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

/**
 * The smallest substring set covering every specifier in `keys` - package head segments, wildcard suffixes
 * stripped (a `'@/*'` key matches `'@/lib/x'`), and entries subsumed by a shorter one dropped. Used to
 * sniff-gate the passes whose triggers are a configured specifier map (compat aliases, resolveAlias).
 */
export function specifierSniffTokens(keys: Iterable<string>): string[] {
  const heads = [
    ...new Set(
      [...keys].map(key => {
        const head = key
          .split('/')
          .slice(0, key.startsWith('@') ? 2 : 1)
          .join('/')
        return head.replace(/\*.*$/, '')
      }),
    ),
  ]
  return heads.filter(head => !heads.some(other => other !== head && head.startsWith(other)))
}

export function uniqueIdentifier(source: string, base: string, ...used: string[]) {
  const usedNames = new Set(used)
  let name = base
  let index = 0
  while (source.includes(name) || usedNames.has(name)) {
    index += 1
    name = `${base}${index}`
  }
  return name
}

export function isIdentifier(value: string) {
  return /^[A-Za-z_$][\w$]*$/.test(value)
}

/**
 * Named exports of esbuild's `__export(entry, {...}); module.exports = __toCommonJS(entry)` shape.
 * Both helpers are matched by POSITION, not by name: a dependency published with `--minify` (tsup's
 * default, e.g. react-web-share) renames them to one letter, and a literal `__export`/`__toCommonJS`
 * match left every such package default-only - a hard failure, since the importer's named binding is
 * static. The `() =>` getter value is what pins the object down as an export map, not any other literal.
 */
export function esbuildEntryExportNames(code: string): string[] {
  const scope = entryCommonJsScope(code)
  const assignments = [
    ...scope.matchAll(
      /module\.exports\s*=\s*(?:[A-Za-z_$][\w$]*\s*\(\s*)?([A-Za-z_$][\w$]*)\s*\)?\s*[;\n]/g,
    ),
  ]
  const entryVar = assignments.at(-1)?.[1]
  if (!entryVar) return []
  const exportCall = new RegExp(
    `[A-Za-z_$][\\w$]*\\(\\s*${escapeRegex(entryVar)}\\s*,\\s*\\{([\\s\\S]*?)\\}\\s*\\)`,
  ).exec(scope)
  if (!exportCall?.[1]) return []
  return [
    ...exportCall[1].matchAll(
      /(?:^|,)\s*(?:["']([^"']+)["']|([A-Za-z_$][\w$]*))\s*:\s*\(\s*\)\s*=>/g,
    ),
  ]
    .map(match => match[1] ?? match[2])
    .filter((name): name is string => Boolean(name && isIdentifier(name)))
}

/**
 * The entry CommonJS module's own text. esbuild emits a `__commonJS` wrapper per module, dependencies
 * first and the entry's last, so slicing from that declaration keeps a dependency's `module.exports`
 * from being read as the entry's - which would publish names the package does not have.
 */
function entryCommonJsScope(code: string) {
  const wrapper = /(^|\n)export default ([A-Za-z_$][\w$]*)\(\)/.exec(code)?.[2]
  if (!wrapper) return code
  const start = code.lastIndexOf(`var ${wrapper} = `)
  return start === -1 ? code : code.slice(start)
}

/** Source with comments removed; the `[^:]` guard keeps `://` inside string URLs intact. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}
