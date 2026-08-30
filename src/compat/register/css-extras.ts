// CSS-extras registration (COMPAT).
//
// Wires the compat CSS features into core:
//
//   1. Sass/scss -> the CssExtensions registry. src/css.ts reads getCssExtensions() at its build sites:
//      bundleCssChunk / buildGlobalCss add the sass chunk plugins and the `.scss`/`.sass` loader entries
//      so the sass onLoad fires; registerCssRuntime and cssModuleClientPlugin consult resolveCssModule /
//      loadCssModuleForClient for `*.module.{scss,sass}` before falling back to the empty-module default.
//
//   2. Sass loaders are also composed onto the JS bundle esbuild seams (client + server) as a safety net,
//      so a `.scss` reachable through the JS graph resolves too. COMPOSED, not clobbered: the live plugin
//      factories are read first and the sass module-loader appended. register-actions sets
//      clientEsbuildPlugins wholesale, so this MUST run after it - and does, being later in register.ts.
//
//   3. useServerInsertedHTML, the CSP nonce and inline-CSS ship as standalone helpers consumed by the
//      render layer / next-navigation re-export.
//
// Gated on next-compat: a pure-core or react-only app keeps every no-op default and never loads the sass
// module.

import type { Plugin } from 'esbuild'
import type { ResolvedConfig } from '../../config'
import { getBundlerExtensions, setBundlerExtensions, setCssExtensions } from '../../extensions'
import { nextCompatEnabled } from '../../render/hooks'
import {
  sassChunkPlugin,
  sassLoadCssModuleForClient,
  sassResolveCssModule,
} from '../css/sass-plugin'
import { isSassFile, isSassModuleFile, sassModuleMapping } from '../css/sass'
import {
  nextCssLoadModuleForClient,
  nextCssModuleChunkPlugin,
  nextCssResolveModule,
} from '../css/modules'
import { nextPlanRouteCssChunks } from '../css/chunking'
import { inlineCssStylesheets } from '../css/inline-css'

export function registerCssExtrasExtensions(config: ResolvedConfig): void {
  if (!nextCompatEnabled(config)) return

  // (1) CSS-chunk + module-map registry consumed by src/css.ts. The two entries
  // the route scanner needs (extraCssExtensions, resolveCssDependency) plus the
  // source materialization are boot facts — register-boot.ts owns them.
  const resolveNextCssModule = nextCssResolveModule(config)
  const loadNextCssModuleForClient = nextCssLoadModuleForClient(config)
  const resolveSassCssModule = sassResolveCssModule(config)
  const loadSassCssModuleForClient = sassLoadCssModuleForClient(config)
  setCssExtensions({
    deferRootNotFoundCss: () => true,
    inlineStylesheets: inlineCssStylesheets,
    cssChunkPlugins: () => [nextCssModuleChunkPlugin(config), sassChunkPlugin(config)],
    resolveCssModule: file => resolveNextCssModule(file) ?? resolveSassCssModule(file),
    loadCssModuleForClient: file =>
      loadNextCssModuleForClient(file) ?? loadSassCssModuleForClient(file),
    planRouteCssChunks: nextPlanRouteCssChunks,
  })

  // (2) Compose the sass module-loader onto the JS bundle esbuild seams.
  const current = getBundlerExtensions()
  const priorClient = current.clientEsbuildPlugins
  const priorServer = current.serverEsbuildPlugins
  setBundlerExtensions({
    clientEsbuildPlugins: (cfg: ResolvedConfig): Plugin[] => [
      ...priorClient(cfg),
      sassModuleLoaderPlugin(cfg),
    ],
    serverEsbuildPlugins: (cfg: ResolvedConfig, opts?): Plugin[] => [
      ...priorServer(cfg, opts),
      nextCssServerModuleLoaderPlugin(cfg),
      sassModuleLoaderPlugin(cfg),
    ],
  })
}

function nextCssServerModuleLoaderPlugin(config: ResolvedConfig): Plugin {
  const loadModule = nextCssLoadModuleForClient(config)
  return {
    name: 'pnext-compat-server-css-module',
    setup(build) {
      build.onLoad({ filter: /\.module\.css$/ }, ({ path: file }) => {
        const contents = loadModule(file)
        return contents ? { contents, loader: 'js' } : null
      })
    },
  }
}

/**
 * esbuild onLoad for a `.scss`/`.sass` reached through a JS graph: a
 * `*.module.*` import evaluates to its class map, a global import to an empty
 * side-effect module (its bytes ship via the CSS chunk, not the JS bundle).
 * Mirrors core's `cssModuleClientPlugin` for the sass extensions.
 */
function sassModuleLoaderPlugin(config: ResolvedConfig): Plugin {
  return {
    name: 'pnext-compat-sass-module',
    setup(build) {
      build.onLoad({ filter: /\.(?:scss|sass)$/ }, ({ path: file }) => {
        if (!isSassFile(file)) return null
        const contents = isSassModuleFile(file)
          ? `export default ${JSON.stringify(sassModuleMapping(file, config.root, sassIncludePathsFor(config)))};`
          : 'export default undefined;'
        return { contents, loader: 'js' }
      })
    },
  }
}

// Local include-paths read kept here to avoid importing sass-plugin internals;
// the JS-graph loader rarely needs includePaths (module maps resolve from the
// file itself), so an empty list is acceptable — the CSS-chunk plugin
// (sass-plugin.ts) threads the real sassOptions.includePaths.
function sassIncludePathsFor(_config: ResolvedConfig): string[] {
  return []
}
