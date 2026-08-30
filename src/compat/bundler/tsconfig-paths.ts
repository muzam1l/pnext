// ---------------------------------------------------------------------------
// tsconfig `paths` resolution for esbuild graphs (COMPAT).
//
// esbuild natively discovers a `tsconfig.json` next to the resolveDir and
// applies its `paths`/`baseUrl`. Next's `typescript.tsconfigPath` lets an app
// keep its compiler config (including `paths`) in a DIFFERENTLY-named file
// (e.g. `myconfig.json`); esbuild never discovers that file, so bare aliases
// declared there ("foo" -> "./bar.ts") are unresolved in esbuild bundles.
//
// Core's source resolver honors the configured tsconfig, but direct esbuild
// graphs do not consult it. This plugin resolves matching bare specifiers
// through the same configured-tsconfig resolver.
//
// The filter is the DECLARED `paths` patterns, read once from every tsconfig
// that can drive a resolution here (the app root, the workspace root and its
// members). Aliases are the only thing this plugin can ever claim, so a
// catch-all bare filter just paid a JS round-trip per import to say "not mine"
// (611 fires on a 401-route app that declares no `paths` at all). No patterns
// anywhere -> no plugin.
// ---------------------------------------------------------------------------

import path from 'node:path'
import type { Plugin } from 'esbuild'
import type { ResolvedConfig } from '../../config'
import { configuredTsPathPatterns, resolveConfiguredTsPath } from '../../resolve/imports'
import { escapeRegex } from '../../utils/code'

export function tsconfigPathsPlugin(config: ResolvedConfig): Plugin | undefined {
  const patterns = configuredTsPathPatterns(config.root, config.workspaceRoot)
  if (patterns.length === 0) return undefined
  // A TS `paths` key holds at most one `*`; everything else is literal.
  const filter = new RegExp(
    `^(?:${patterns.map(pattern => pattern.split('*').map(escapeRegex).join('[^:]*')).join('|')})$`,
  )
  return {
    name: 'pnext-tsconfig-paths',
    setup(build) {
      build.onResolve({ filter }, args => {
        const resolved = resolveConfiguredTsPath(
          config.root,
          path.join(args.resolveDir || config.root, 'pnext-resolve.ts'),
          args.path,
        )
        return resolved ? { path: resolved } : undefined
      })
    },
  }
}
