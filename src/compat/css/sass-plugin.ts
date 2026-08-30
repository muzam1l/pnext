// Sass esbuild plugin + CSS-module resolvers (COMPAT).
//
// The concrete CssExtensions implementations wired by register-css-extras.ts:
//   - sassChunkPlugin(config): an esbuild onLoad for `.scss`/`.sass` used in the CSS-chunk builds.
//     Compiles to css text; a `*.module.*` file's selectors are already scoped by compileSassCss.
//   - sassResolveCssModule / sassLoadCssModuleForClient: the class-map resolvers for the Bun
//     render-time loader and the client bundle.
//
// includePaths come from next.config `sassOptions.includePaths`. All fields degrade to core's empty
// behavior when `sass` is not installed.

import type { Plugin } from 'esbuild'
import type { ResolvedConfig } from '../../config'
import { getNextConfig } from '../next/config-loader'
import { compileSassCss, isSassFile, isSassModuleFile, sassModuleMapping } from './sass'

/** Read `sassOptions.includePaths` from the loaded next.config. */
function sassIncludePaths(): string[] {
  const config = getNextConfig()
  const sassOptions = config.sassOptions as { includePaths?: unknown } | undefined
  const includePaths = sassOptions?.includePaths
  return Array.isArray(includePaths)
    ? includePaths.filter((p): p is string => typeof p === 'string')
    : []
}

/**
 * esbuild plugin: compile `.scss`/`.sass` to css inside the CSS-chunk build.
 * Returns `loader: 'css'` so esbuild's CSS bundler concatenates the result in
 * import order alongside the `@import`-ed `.css`.
 */
export function sassChunkPlugin(config: ResolvedConfig): Plugin {
  return {
    name: 'pnext-compat-sass',
    setup(build) {
      build.onLoad({ filter: /\.(?:scss|sass)$/ }, ({ path: file }) => ({
        contents: compileSassCss(file, config.root, sassIncludePaths()),
        loader: 'css',
      }))
    },
  }
}

/** Bun render-time loader / class-map resolver for `*.module.{scss,sass}`. */
export function sassResolveCssModule(config: ResolvedConfig) {
  return (file: string): Record<string, string> | undefined =>
    isSassModuleFile(file) ? sassModuleMapping(file, config.root, sassIncludePaths()) : undefined
}

/** Client-bundle ESM text for a `.scss`/`.sass` import. */
export function sassLoadCssModuleForClient(config: ResolvedConfig) {
  return (file: string): string | undefined => {
    if (!isSassFile(file)) return undefined
    if (isSassModuleFile(file)) {
      const map = sassModuleMapping(file, config.root, sassIncludePaths())
      return `export default ${JSON.stringify(map)};`
    }
    // Global (non-module) sass carries no class map; the css bytes ship via the
    // CSS chunk, so the client import is a side-effect-only empty module.
    return 'export default undefined;'
  }
}
