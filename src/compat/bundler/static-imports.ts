import { pathToFileHref } from '../../config'
import { rewriteSpecifierLiterals } from '../../resolve/scan-facts'

/**
 * Resolve registered compat aliases before Bun reaches installed package entries. Folded onto the
 * memoized module record: only real import/export/dynamic-import/require specifiers are considered, so
 * an alias key quoted inside a string or a comment - which the old specifier regex rewrote - is never
 * touched.
 */
export function rewriteStaticCompatImports(
  source: string,
  file: string,
  aliases: Readonly<Record<string, string>>,
  requireAliases: Readonly<Record<string, string>> = {},
): string {
  return rewriteSpecifierLiterals(source, file, (specifier, kind) => {
    // A side-effect `import 'x'` keeps resolving through the host resolver, as
    // it did under the `from`-anchored regex this replaced.
    const target = kind === 'side-effect' ? undefined : aliases[specifier]
    if (!target) return undefined
    const resolved =
      kind === 'require' ? (requireAliases[specifier] ?? target) : pathToFileHref(target)
    return JSON.stringify(resolved)
  })
}
