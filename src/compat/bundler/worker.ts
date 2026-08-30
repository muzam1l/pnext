// Web Worker bundling (COMPAT - `new Worker(new URL('./w', import.meta.url))`).
//
// Next/webpack/turbopack detect this pattern (and SharedWorker) in client code, bundle the referenced
// module as its own entry chunk, and swap the URL expression for the emitted chunk URL. esbuild has no
// native support, so this pass:
//   1. runs as the client-source chain's async PRE-transform, ahead of the sync passes, one of which
//      inlines the `import.meta.url` this pattern needs,
//   2. resolves each worker specifier (honoring TS/JSX extensions and any configured resolveExtensions),
//   3. bundles the worker file with its own esbuild pass - IIFE output so classic AND module workers
//      both execute it, with internal dynamic imports inlined,
//   4. rewrites the `new URL(...)` argument to the emitted chunk's public URL string literal.
//
// Worker graphs get their own static-asset handling, reusing the compat staticAssetModule extension for
// images and a generic `{ src }` module for other assets.

import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Plugin } from 'esbuild'
import { build } from '../../utils/esbuild'
import { publicEnvDefines, type ResolvedConfig } from '../../config'
import { getAssetExtensions } from '../../extensions'

// `new Worker(new URL('<spec>', import.meta.url)` / SharedWorker — the URL
// argument must be a string literal and the base exactly `import.meta.url`.
const workerPattern = () =>
  /\bnew\s+(Worker|SharedWorker)\(\s*new\s+URL\(\s*(['"])([^'"]+)\2\s*,\s*import\.meta\.url\s*\)/g

/** Cheap gate: does this source construct a Worker from a `new URL(...)`? */
export function sourceHasWorkerNewUrl(source: string): boolean {
  return (
    (source.includes('new Worker(') || source.includes('new SharedWorker(')) &&
    workerPattern().test(source)
  )
}

const workerSpecifierExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts']

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function resolveWorkerEntry(
  importerDir: string,
  specifier: string,
  configuredExtensions: readonly string[] | undefined,
): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  const base = path.resolve(importerDir, specifier)
  if (path.extname(base) && isFile(base)) return base
  for (const extension of configuredExtensions ?? workerSpecifierExtensions) {
    if (extension === '') {
      if (isFile(base)) return base
      continue
    }
    const candidate = `${base}${extension}`
    if (isFile(candidate)) return candidate
  }
  // A configured extension list that misses the worker's real extension must
  // not break the build — fall back to the built-in source order.
  if (configuredExtensions) {
    for (const extension of workerSpecifierExtensions) {
      const candidate = `${base}${extension}`
      if (isFile(candidate)) return candidate
    }
  }
  return isFile(base) ? base : undefined
}

// Any importable asset a worker may reference: static images (compat descriptor
// module) plus generic binary assets (.wasm) exposed as `{ src }`.
const workerAssetFilter = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|wasm)(?:$|[?#])/

// Workers fetch `.wasm` via `new URL('./x.wasm', import.meta.url)`; rewrite it
// (and image URLs) onto the asset import pipeline exactly like the main-graph
// new-url-asset transform, but with `.wasm` included.
const workerNewUrlAssetPattern = () =>
  /new\s+URL\(\s*(['"])([^'"]+?\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|wasm)(?:[?#][^'"]*)?)\1\s*,\s*import\.meta\.url\s*\)/g

function rewriteWorkerNewUrlAssets(source: string): string {
  if (!source.includes('import.meta.url')) return source
  const bindings = new Map<string, string>()
  const replaced = source.replace(workerNewUrlAssetPattern(), (_match, _quote, spec: string) => {
    let binding = bindings.get(spec)
    if (!binding) {
      binding = `__pnext_worker_url_${bindings.size}`
      bindings.set(spec, binding)
    }
    return `(${binding}.src)`
  })
  if (bindings.size === 0) return source
  const imports = [...bindings]
    .map(([spec, binding]) => `import ${binding} from ${JSON.stringify(spec)};`)
    .join('\n')
  return `${imports}\n${replaced}`
}

function splitAssetHash(specifier: string) {
  const index = specifier.search(/[?#]/)
  return index === -1
    ? { sourcePath: specifier, hash: '' }
    : { sourcePath: specifier.slice(0, index), hash: specifier.slice(index) }
}

async function workerAssetModuleSource(config: ResolvedConfig, file: string): Promise<string> {
  const { sourcePath } = splitAssetHash(file)
  const bytes = new Uint8Array(await readFile(sourcePath))
  const emitted: string[] = []
  const emit = (relative: string) => {
    emitted.push(relative)
    return `/${relative}`
  }
  let source = await getAssetExtensions().staticAssetModule({ sourcePath, bytes, emit })
  if (!source) {
    const ext = path.extname(sourcePath).toLowerCase() || '.bin'
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 8)
    const base = path
      .basename(sourcePath, path.extname(sourcePath))
      .replace(/[^A-Za-z0-9_-]+/g, '-')
    const relative = getAssetExtensions().staticAssetRelativePath({ sourcePath, base, hash, ext })
    const src = emit(relative)
    // `.src` (worker new-URL rewrite) and default-as-string both observable.
    source = `const src = ${JSON.stringify(src)};\nexport default { src };\nexport { src };\n`
  }
  for (const relative of emitted) {
    const target = path.join(config.outPath, 'public', ...relative.split('/'))
    await mkdir(path.dirname(target), { recursive: true })
    if (!existsSync(target)) await copyFile(sourcePath, target)
  }
  return source
}

function workerAssetPlugin(config: ResolvedConfig): Plugin {
  return {
    name: 'pnext-worker-static-assets',
    setup(build) {
      // Worker-graph sources referencing assets via `new URL(..., import.meta.url)`
      // (esbuild would otherwise mangle `import.meta.url` in the iife output) are
      // rewritten onto the asset import pipeline below.
      build.onLoad({ filter: /\.(?:js|mjs|jsx|ts|tsx|mts)$/, namespace: 'file' }, async args => {
        const source = await readFile(args.path, 'utf8')
        if (!workerNewUrlAssetPattern().test(source)) return undefined
        const loader = args.path.endsWith('.ts')
          ? ('ts' as const)
          : args.path.endsWith('.mts')
            ? ('ts' as const)
            : args.path.endsWith('.tsx')
              ? ('tsx' as const)
              : ('jsx' as const)
        return { contents: rewriteWorkerNewUrlAssets(source), loader }
      })
      build.onResolve({ filter: workerAssetFilter }, args => {
        const { sourcePath, hash } = splitAssetHash(args.path)
        const resolved = path.isAbsolute(sourcePath)
          ? sourcePath
          : path.resolve(args.resolveDir, sourcePath)
        return { path: `${resolved}${hash}`, namespace: 'pnext-worker-asset' }
      })
      build.onLoad({ filter: /.*/, namespace: 'pnext-worker-asset' }, async args => ({
        contents: await workerAssetModuleSource(config, args.path),
        loader: 'js',
      }))
    },
  }
}

function workerDefines(): Record<string, string> {
  const defines: Record<string, string> = {
    ...publicEnvDefines(),
    'process.browser': 'true',
  }
  // Next inlines the deployment id into every graph, workers included.
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const deploymentId = process.env.NEXT_DEPLOYMENT_ID
  if (deploymentId !== undefined) {
    defines['process.env.NEXT_DEPLOYMENT_ID'] = JSON.stringify(deploymentId)
  }
  return defines
}

/**
 * Bundle one worker entry into `<out>/public/assets/workers/` and return its
 * public URL path. Deduplicated per resolved entry file across the whole
 * client build via the caller's cache.
 */
async function bundleWorkerEntry(config: ResolvedConfig, entry: string): Promise<string> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    // IIFE runs under both `new Worker(url)` (classic) and `{ type: 'module' }`
    // workers; internal dynamic imports are inlined (no splitting), so no
    // runtime chunk loader is needed.
    format: 'iife',
    platform: 'browser',
    minify: true,
    define: workerDefines(),
    plugins: [workerAssetPlugin(config)],
    logLevel: 'silent',
  })
  const output = result.outputFiles[0]
  if (!output) throw new Error(`pnext: worker bundle produced no output for ${entry}`)
  const hash = createHash('sha256').update(output.contents).digest('hex').slice(0, 8)
  const base = path.basename(entry, path.extname(entry)).replace(/[^A-Za-z0-9_-]+/g, '-')
  const relative = path.posix.join('assets', 'workers', `${base}.${hash}.js`)
  const target = path.join(config.outPath, 'public', ...relative.split('/'))
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, output.contents)
  return `/${relative}`
}

/**
 * CLIENT-graph source transform: bundle each worker entry a source constructs
 * from `new URL(..., import.meta.url)` and substitute the emitted chunk URL.
 * The bundle cache is per-transform (one per registration), so a worker shared
 * by many modules is built once per build.
 */
export function createClientWorkerTransform(
  config: ResolvedConfig,
  configuredExtensions: readonly string[] | undefined,
): (source: string, file: string) => Promise<string> {
  const bundleCache = new Map<string, Promise<string>>()
  return async (source, file) => {
    if (!sourceHasWorkerNewUrl(source)) return source
    const rewritten = await rewriteWorkerSource(
      config,
      source,
      file,
      bundleCache,
      configuredExtensions,
    )
    return rewritten ?? source
  }
}

/**
 * Rewrite every worker construction in `source` (resolving + bundling each
 * referenced worker module) and return the transformed source, or undefined
 * when nothing matched/resolved (caller falls through to the normal loader).
 */
export async function rewriteWorkerSource(
  config: ResolvedConfig,
  source: string,
  file: string,
  bundleCache: Map<string, Promise<string>>,
  configuredExtensions: readonly string[] | undefined,
): Promise<string | undefined> {
  const importerDir = path.dirname(file)
  const matches = [...source.matchAll(workerPattern())]
  if (matches.length === 0) return undefined

  const urls = new Map<string, string>()
  for (const match of matches) {
    const spec = match[3]!
    if (urls.has(spec)) continue
    const entry = resolveWorkerEntry(importerDir, spec, configuredExtensions)
    if (!entry) continue // unresolvable: leave the construction untouched
    let pending = bundleCache.get(entry)
    if (!pending) {
      pending = bundleWorkerEntry(config, entry)
      bundleCache.set(entry, pending)
    }
    urls.set(spec, await pending)
  }
  if (urls.size === 0) return undefined

  return source.replace(workerPattern(), (match, ctor: string, _quote: string, spec: string) => {
    const url = urls.get(spec)
    return url ? `new ${ctor}(${JSON.stringify(url)}` : match
  })
}
