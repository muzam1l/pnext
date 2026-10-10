/**
 * Split a webpack resource specifier into its file request and its `?query#fragment` suffix - loader
 * plumbing (turbopack rules, `.wasm?module`) that takes no part in the on-disk lookup. A leading `#` is a
 * package-imports specifier, not a fragment.
 */
export function splitResourceQuery(specifier: string): { path: string; query: string } {
  const offset = specifier.startsWith('#') ? 1 : 0
  const match = /[?#]/.exec(specifier.slice(offset))
  if (!match) return { path: specifier, query: '' }
  const index = offset + match.index
  return { path: specifier.slice(0, index), query: specifier.slice(index) }
}
