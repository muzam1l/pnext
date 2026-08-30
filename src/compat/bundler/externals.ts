import type { Plugin } from 'esbuild'
import type { ResolvedConfig } from '../../config'
import { packageNameOfSpecifier, resolvePackageSpecifier } from '../../resolve/imports'
import { escapeRegex } from '../../utils/code'

/**
 * Bundle configured server externals into client output with browser exports.
 * The configured package names ARE the filter (plus their subpaths), so an app
 * with no `serverExternalPackages` registers no plugin at all instead of paying
 * a hook fire per bare import in the graph.
 */
export function clientExternalPackageResolvePlugin(
  config: ResolvedConfig,
  externals: ReadonlySet<string>,
): Plugin | undefined {
  if (externals.size === 0) return undefined
  const filter = new RegExp(`^(?:${[...externals].map(escapeRegex).join('|')})(?:/|$)`)
  return {
    name: 'pnext-client-external-package-resolve',
    setup(build) {
      build.onResolve({ filter }, args => {
        const packageName = packageNameOfSpecifier(args.path)
        if (!packageName || !externals.has(packageName)) return undefined
        const resolved = resolvePackageSpecifier(
          config.root,
          `${args.importer || config.root}/pnext-resolve.ts`,
          args.path,
          ['import', 'browser', 'require', 'default'],
        )
        return resolved ? { path: resolved } : undefined
      })
    },
  }
}
