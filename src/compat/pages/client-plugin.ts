import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Loader, OnLoadResult, Plugin } from 'esbuild'
import { build as esbuild } from '../../utils/esbuild'
import type { ResolvedConfig } from '../../config'
import { applyClientSourceTransforms, getBundlerExtensions } from '../../extensions'

const pageClientFacade = 'pnext-page-client.js'
const sideEffectImportPattern = /(?:^|\n)\s*import\s*(['"])([^'"]+)\1\s*;?/g
const styleImportPattern = /\.(?:css|scss|sass|less|styl)(?:\?|$)/

/**
 * Compile generated Pages facades from only the page component export. The relative-import hook is
 * a catch-all that only ever fires from a facade, so an app with no `pages/` dir skips it.
 */
export function pagesClientModulePlugin(config: ResolvedConfig): Plugin {
  const compiled = new Map<string, Promise<OnLoadResult>>()
  const hasPages = existsSync(path.join(config.root, 'pages'))
  return {
    name: 'pnext-pages-client-module',
    setup(build) {
      if (!hasPages) return
      build.onResolve({ filter: /^\.{1,2}\// }, args => {
        if (path.basename(args.importer) !== pageClientFacade) return undefined
        return {
          path: path.resolve(args.resolveDir, args.path),
          namespace: 'pnext-pages-client-module',
        }
      })
      build.onLoad({ filter: /.*/, namespace: 'pnext-pages-client-module' }, args => {
        let output = compiled.get(args.path)
        if (!output) {
          output = compilePageClientModule(config, args.path)
          compiled.set(args.path, output)
        }
        return output
      })
    },
  }
}

async function compilePageClientModule(
  config: ResolvedConfig,
  file: string,
): Promise<OnLoadResult> {
  const rawSource = await readFile(file, 'utf8')
  const source = applyClientSourceTransforms(rawSource, file, config.root)
  const sideEffectImports = new Set(
    [...source.matchAll(sideEffectImportPattern)]
      .map(match => match[2])
      .filter((specifier): specifier is string => Boolean(specifier)),
  )
  const result = await esbuild({
    stdin: {
      contents: `export { default } from ${JSON.stringify(file)};`,
      loader: 'js',
      resolveDir: path.dirname(file),
      sourcefile: `${file}.pnext-client-entry.js`,
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    treeShaking: true,
    // This facade build is its own esbuild pass, so it needs compiler.define
    // (the main client build applies it through baseClientBuildOptions).
    define: getBundlerExtensions().clientDefines(),
    jsx: 'automatic',
    jsxImportSource: 'preact',
    logLevel: 'silent',
    plugins: [
      {
        name: 'pnext-pages-client-module-source',
        setup(build) {
          build.onResolve({ filter: /.*/ }, args => {
            if (args.path === file) {
              return { path: file, namespace: 'pnext-pages-client-source' }
            }
            return {
              path: args.path,
              external: true,
              sideEffects: sideEffectImports.has(args.path) || styleImportPattern.test(args.path),
            }
          })
          build.onLoad({ filter: /.*/, namespace: 'pnext-pages-client-source' }, () => ({
            contents: source,
            loader: pageLoader(file),
            resolveDir: path.dirname(file),
          }))
        },
      },
    ],
  })
  const output = result.outputFiles[0]
  if (!output) throw new Error(`Failed to compile Pages client module ${file}`)
  return {
    contents: output.text,
    loader: 'js',
    resolveDir: path.dirname(file),
  }
}

function pageLoader(file: string): Loader {
  if (file.endsWith('.tsx')) return 'tsx'
  if (file.endsWith('.ts')) return 'ts'
  return 'jsx'
}
