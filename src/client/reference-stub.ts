/**
 * The stub a server-graph module gets in place of a `'use client'` file: a component object tagged
 * with the reference the renderer matches islands by. Shared by the two places that cross a client
 * boundary from the server graph - the dev module pass and the vendor bundler (a package's own
 * `'use client'` files, reached mid-bundle).
 */
import path from 'node:path'
import { clientReferenceId } from './reference'
import { pathToFileHref } from '../config'
import type { ResolvedConfig } from '../config'
import { resolveImport } from '../resolve/imports'
import { moduleExportNames, moduleExportStars } from '../resolve/scan-facts'
import { readText } from '../utils/fs'

export const clientReferenceRuntimeFile = path.resolve(import.meta.dirname, 'reference.ts')

export interface ClientReferenceModuleOptions {
  /**
   * Inline `Symbol.for('pnext.clientReference')` instead of importing the
   * runtime module. A stub esbuild BUNDLES (the vendor pass) has no way to
   * reach pnext's own source tree, and the symbol is registry-global, so an
   * inlined lookup is the same symbol the renderer tests for.
   */
  inlineSymbol?: boolean
}

export function clientReferenceModuleSource(
  sourceFile: string,
  exportNames: string[],
  options: ClientReferenceModuleOptions = {},
) {
  const reference = (exportName: string) =>
    `createReference({ id: ${JSON.stringify(`c-${clientReferenceId(sourceFile, exportName)}`)}, file: ${JSON.stringify(sourceFile)}, exportName: ${JSON.stringify(exportName)} })`
  const defaultExport = exportNames.includes('default')
    ? `export default ${reference('default')};`
    : ''
  const namedExports = exportNames
    .filter(name => name !== 'default')
    .map(name => `export const ${name} = ${reference(name)};`)
  const symbol = options.inlineSymbol
    ? `const clientReferenceSymbol = Symbol.for('pnext.clientReference');`
    : `import { clientReferenceSymbol } from ${JSON.stringify(pathToFileHref(clientReferenceRuntimeFile))};`

  return `${symbol}

function createReference(reference) {
  function ClientReference({ children }) {
    return children ?? null;
  }
  ClientReference[clientReferenceSymbol] = reference;
  return ClientReference;
}

${defaultExport}
${namedExports.join('\n')}
`
}

/**
 * The names a stub must republish. `export *` is followed because the star's
 * targets live in other files, and a name the stub omits is a hard link error
 * at the importer.
 */
export async function clientReferenceExportNames(
  config: ResolvedConfig,
  file: string,
  source?: string,
  visited = new Set<string>(),
): Promise<string[]> {
  const key = path.resolve(file)
  if (visited.has(key)) return []
  visited.add(key)
  const text = source ?? (await readText(file))
  const names = new Set(moduleExportNames(text, file))
  // A CommonJS-style client module (`exports.X = ...`) has no ESM exports for
  // the transpiler scan; recover the statically visible names so its reference
  // shim exposes them (mirrors the client bundle's CJS-name recovery).
  if (names.size === 0) {
    for (const match of text.matchAll(/\bexports\.([A-Za-z_$][\w$]*)\s*=/g)) {
      if (match[1] !== '__esModule') names.add(match[1]!)
    }
    if (/\bmodule\.exports\s*=/.test(text)) names.add('default')
  }
  // `export * from './x'` re-exports every named export of the target, whose
  // names live in that module — union them recursively (default stays
  // excluded, per ES module star semantics). `export * as ns from` exports
  // only `ns`, which the own-module scan already lists.
  for (const specifier of moduleExportStars(text, file)) {
    const resolved = resolveImport(config.root, file, specifier)
    if (!resolved || !isInside(config.workspaceRoot, resolved)) continue
    for (const name of await clientReferenceExportNames(config, resolved, undefined, visited)) {
      if (name !== 'default') names.add(name)
    }
  }
  return [...names]
}

/**
 * Comments and preceding directives do not end the directive prologue. Hand-scanned rather than
 * matched by a regex on purpose: the prologue grammar (a lazy repeat over an alternation whose
 * branches both end in `*?`) is catastrophically ambiguous, so on a file with no directive but a
 * few leading comments a backtracking engine tries every way of splitting the prefix. This scan is
 * linear and allocation-free.
 */
export function hasUseClientDirective(source: string) {
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
    if (source.slice(i + 1, end) === 'use client') return true
    i = end + 1
    while (i < source.length && isSpace(i)) i += 1
    if (source[i] === ';') i += 1
  }
}

function isInside(root: string, file: string) {
  const relative = path.relative(root, file)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}
