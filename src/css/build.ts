import { existsSync, readFileSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Plugin } from 'esbuild'
import { hashedAssetName } from '../utils/asset-hash'
import { build } from '../utils/esbuild'
import { ensureDir, readText } from '../utils/fs'
import { postcssConfigFile, runPostcss } from './postcss'
import { extraPageExtensions, getCssExtensions } from '../extensions'
import { nextCompatEnabled } from '../render/hooks'
import { resolveImport } from '../resolve/imports'
import { createVerboseLogger } from '../utils/verbose'
import type { ClientReference } from '../client/reference'
import type { ResolvedConfig } from '../config'
import type { RouteManifestEntry } from '../types'

import type { CssWorkerRequest, CssWorkerResponse } from './worker'

interface Pending {
  resolve: () => void
  reject: (error: Error) => void
}

// Bun's Worker carries node's ref/unref; the DOM lib typing does not.
// Bun's terminate() resolves once the thread is gone (lib.dom types it void).
type CssWorker = Worker & { ref(): void; unref(): void; terminate(): Promise<void> }

let worker: CssWorker | undefined
let workerFailed = false
let nextId = 0
const pending = new Map<number, Pending>()

function ensureWorker() {
  if (worker || workerFailed) return worker
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url).href, {
      type: 'module',
    }) as CssWorker
  } catch {
    workerFailed = true
    return undefined
  }
  // Idle workers must not hold `pnext build` (or a test run) open; each in-flight
  // request refs it again.
  worker.unref()
  worker.onmessage = (event: MessageEvent<CssWorkerResponse>) => {
    const { id, error } = event.data
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    if (pending.size === 0) worker?.unref()
    if (!error) return entry.resolve()
    const failure = new Error(error.message)
    failure.name = error.name
    if (error.stack) failure.stack = error.stack
    entry.reject(failure)
  }
  worker.onerror = () => failWorker(new Error('pnext CSS worker crashed'))
  return worker
}

// A dead worker takes its processor cache with it; drop it and let the next
// request fall back in-process rather than hanging every pending build.
function failWorker(error: Error) {
  workerFailed = true
  worker = undefined
  for (const entry of pending.values()) entry.reject(error)
  pending.clear()
}

function send(request: (id: number) => CssWorkerRequest) {
  const active = ensureWorker()
  if (!active) return undefined
  const id = nextId++
  return new Promise<void>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    active.ref()
    active.postMessage(request(id))
  })
}

/** Run the app's postcss pipeline over a built stylesheet, off the event loop. */
// A live worker thread at process.exit races Bun's teardown (seen flipping the
// exit code to 1 on Linux after a fully successful build); one-shot commands
// terminate it explicitly before exiting.
export async function stopCssWorker(): Promise<void> {
  const active = worker
  worker = undefined
  if (active) await Promise.resolve(active.terminate())
}

export async function runPostcssOffThread(
  config: Pick<ResolvedConfig, 'root' | 'outPath'>,
  cssFile: string,
  options: { dev?: boolean },
  from?: string,
) {
  const { root, outPath: outDir } = config
  const dev = options.dev ?? false
  const sent = send(id => ({ kind: 'process', id, root, dev, outDir, cssFile, from }))
  if (sent) return sent
  return runPostcss(root, cssFile, { dev, outDir }, from)
}

/**
 * Spawn the worker and load the app's postcss config ahead of the first
 * stylesheet, so a cold Tailwind boot overlaps with the rest of dev startup.
 */
export function warmCssWorker(
  config: Pick<ResolvedConfig, 'root' | 'outPath'>,
  options: { dev?: boolean } = {},
) {
  send(id => ({
    kind: 'warm',
    id,
    root: config.root,
    dev: options.dev ?? false,
    outDir: config.outPath,
  }))?.catch(() => {
    // A broken postcss config surfaces on the real build; warming stays quiet.
  })
}

interface CssBuildOptions {
  dev?: boolean
  verbose?: boolean
}

let cssRuntimeRegistered = false

export function globalCssSource(config: ResolvedConfig) {
  return globalCssSources(config)[0]
}

export function globalCssSources(config: Pick<ResolvedConfig, 'root' | 'appPath'>) {
  return globalCssSourcesForPaths(config.root, config.appPath)
}

// The walk below reads and resolves the ROOT LAYOUT'S WHOLE IMPORT GRAPH, and every render asks it
// (via globalCssHref) whether the app has global CSS at all. Memoize per root+appPath; dev clears
// this on save (invalidateDevCaches), prod sources never change in-process.
const globalCssSourceCache = new Map<string, string[]>()

/**
 * Restart half of the walk above: the store persists the answer keyed by every
 * file the walk *read*, so a restart re-states it instead of re-reading the
 * graph. `undefined` (prod, or the cache off) simply means always walk.
 */
export interface GlobalCssSourceStore {
  load(key: string): string[] | undefined
  save(key: string, sources: string[], visited: string[], missing: string[]): void
}

let globalCssStore: GlobalCssSourceStore | undefined

export function setGlobalCssSourceStore(store: GlobalCssSourceStore | undefined) {
  globalCssStore = store
}

export function globalCssSourcesForPaths(root: string, appPath: string) {
  const key = `${root}\0${appPath}`
  const cached = globalCssSourceCache.get(key)
  if (cached) return cached

  const stored = globalCssStore?.load(key)
  if (stored) {
    globalCssSourceCache.set(key, stored)
    return stored
  }

  const sources = new Set<string>()
  const visited = new Set<string>()
  const missing = new Set<string>()
  collectGlobalCssSources(root, rootLayoutFile(appPath, missing), sources, visited, missing)

  const resolved = [...sources].map(file => path.resolve(file))
  globalCssSourceCache.set(key, resolved)
  // The answer depends on every file the walk READ (a new `import './x.css'`
  // anywhere in the layout graph changes its importer's bytes) and on every
  // path it found ABSENT (restoring one while the server was down would add an
  // edge no importer's bytes record).
  globalCssStore?.save(key, resolved, [...visited], [...missing])
  return resolved
}

/** Drop the memoized layout-graph walk (dev save invalidation). */
export function clearGlobalCssSourceCache() {
  globalCssSourceCache.clear()
}

function collectGlobalCssSources(
  root: string,
  file: string,
  sources: Set<string>,
  visited: Set<string>,
  missing?: Set<string>,
) {
  const resolvedFile = path.resolve(file)
  if (visited.has(resolvedFile)) return
  if (!existsSync(resolvedFile)) {
    missing?.add(resolvedFile)
    return
  }
  visited.add(resolvedFile)

  for (const specifier of moduleSpecifiers(readFileSync(resolvedFile, 'utf8'))) {
    const resolved = resolveImport(root, resolvedFile, specifier)
    if (!resolved) continue
    if (isCssFile(resolved)) {
      sources.add(resolved)
    } else {
      collectGlobalCssSources(root, resolved, sources, visited, missing)
    }
  }
}

function rootLayoutFile(appPath: string, missing?: Set<string>) {
  for (const extension of ['tsx', 'ts', 'jsx', 'js', 'mjs', ...extraPageExtensions()]) {
    const file = path.join(appPath, `layout.${extension}`)
    if (existsSync(file)) return file
    missing?.add(file)
  }
  return path.join(appPath, 'layout.tsx')
}

export function globalCssHref(config: ResolvedConfig) {
  return globalCssSources(config).length > 0 ? assetHref(config, 'global.css') : undefined
}

export type AssetHrefConfig = Pick<ResolvedConfig, 'assetPrefix' | 'compat' | 'outPath'>

/**
 * Logical build-asset name -> the content-hashed name the build actually emitted
 * (`global.css` -> `global-1f4a9c2b3d5e6f70.css`). A production asset name must
 * carry its content, or the URL cannot honestly be served `immutable`: the same
 * name would answer different bytes after a deploy.
 *
 * Keyed by outPath, never process-global: one process builds several apps (the
 * test suite does it constantly) and their names must not cross. Empty in dev,
 * where names stay flat and every asset is served `no-cache` anyway.
 */
const emittedAssets = new Map<string, Map<string, string>>()

export function recordEmittedAsset(outPath: string, logical: string, emitted: string): void {
  const names = emittedAssets.get(outPath) ?? new Map<string, string>()
  names.set(logical, emitted)
  emittedAssets.set(outPath, names)
}

/** Re-publish the build's name map at server boot (see BuildManifest.assetNames). */
export function publishEmittedAssets(
  outPath: string,
  names: Record<string, string> | undefined,
): void {
  if (!names) return
  for (const [logical, emitted] of Object.entries(names))
    recordEmittedAsset(outPath, logical, emitted)
}

export function emittedAssetNames(outPath: string): Record<string, string> {
  return Object.fromEntries(emittedAssets.get(outPath) ?? [])
}

export function clearEmittedAssets(outPath: string): void {
  emittedAssets.delete(outPath)
}

/** The file name a logical asset name resolves to. Identity until a build records one. */
export function emittedAssetName(
  config: Pick<ResolvedConfig, 'outPath'> | undefined,
  name: string,
): string {
  if (!config?.outPath) return name
  return emittedAssets.get(config.outPath)?.get(name) ?? name
}

// Where a built asset lives in the URL space. next-compat serves the build output under Next's
// static path, so a compat app's document references its CSS/JS exactly as Next does; core keeps
// `/assets/`. Every document-emitted build-asset URL goes through here (and the dev/prod servers
// accept both spellings), so an emitted href can never name a path the server will not serve —
// including the content hash the production name carries.
export function assetPathname(
  config: Pick<ResolvedConfig, 'compat' | 'outPath'> | undefined,
  name: string,
) {
  const emitted = emittedAssetName(config, name)
  return nextCompatEnabled(config ?? {}) ? `/_next/static/${emitted}` : `/assets/${emitted}`
}

export function assetHref(config: AssetHrefConfig | undefined, name: string) {
  return withAssetPrefix(config, assetPathname(config, name))
}

// A route's built CSS filenames - the one rule behind the document's links, the
// inline-CSS path and analyze, so no consumer can disagree about whether a
// route has CSS. compat cssChunking records split names in cssAssets.
export function routeCssAssetNames(
  route: Pick<RouteManifestEntry, 'id' | 'cssImports' | 'cssAssets'>,
): string[] {
  if (route.cssImports.length === 0) return []
  return route.cssAssets?.length ? route.cssAssets : [`${route.id}.css`]
}

export function routeCssHref(
  route: RouteManifestEntry,
  config?: AssetHrefConfig,
): string | string[] | undefined {
  const assets = routeCssAssetNames(route)
  if (assets.length === 0) return undefined
  return assets.map(asset => assetHref(config, asset))
}

/**
 * Put a render's next/font rules in the first stylesheet chunk, matching Next's
 * linked CSS delivery without changing the rest of the route's chunk order.
 */
export async function emitFontCssStylesheet(
  config: ResolvedConfig,
  routeId: string,
  fontCss: string,
  baseAsset: string | undefined,
  options: { dev: boolean },
) {
  const outDir = path.join(config.outPath, options.dev ? 'cache' : 'public', 'assets')
  await ensureDir(outDir)
  const baseFile = baseAsset ? path.join(outDir, baseAsset) : undefined
  const baseCss = baseFile && existsSync(baseFile) ? await readFile(baseFile, 'utf8') : ''
  const contents = [fontCss, baseCss].filter(Boolean).join('\n')
  const logicalName = baseAsset
    ? baseAsset.replace(/-[0-9a-f]{16}(?=\.css$)/, '')
    : `${routeId}.css`
  const name = hashedAssetName(logicalName, contents)
  const file = path.join(outDir, name)
  if (!existsSync(file) || (await readFile(file, 'utf8')) !== contents)
    await writeFile(file, contents)
  return name
}

// Prepend the configured assetPrefix (a CDN origin or path) to an app-absolute
// asset URL. Link hrefs use basePath instead and must NOT go through here.
export function withAssetPrefix(
  config: Pick<ResolvedConfig, 'assetPrefix'> | undefined,
  href: string,
) {
  const prefix = config?.assetPrefix
  if (!prefix) return href
  return `${prefix.replace(/\/$/, '')}${href}`
}

/**
 * Spawn the CSS worker and load the app's postcss config before any stylesheet
 * is asked for, so Tailwind's cold boot overlaps with the rest of startup
 * instead of landing on the first request. No-op without a postcss config.
 */
export function warmCssPipeline(
  config: Pick<ResolvedConfig, 'root' | 'outPath'>,
  options: CssBuildOptions = {},
) {
  if (!hasPostcssConfig(config.root)) return
  warmCssWorker(config, options)
}

export async function buildGlobalCss(config: ResolvedConfig, options: CssBuildOptions = {}) {
  const log = createVerboseLogger(options.verbose ?? false, 'css')
  const sources = globalCssSources(config)
  if (sources.length === 0) {
    log.log('global css: no side-effect css imports in root layout, skipping')
    return undefined
  }

  const outDir = options.dev
    ? path.join(config.outPath, 'cache', 'assets')
    : path.join(config.outPath, 'public', 'assets')
  const outfile = path.join(outDir, 'global.css')
  await ensureDir(outDir)

  log.log(
    `global css: ${sources.length} source${sources.length === 1 ? '' : 's'} — ${sources
      .map(file => path.relative(config.root, file))
      .join(', ')}`,
  )

  const postcss = hasPostcssConfig(config.root)
  await log.step('global css: esbuild bundle', () =>
    build({
      stdin: {
        contents: sources.map(file => `@import ${JSON.stringify(file)};`).join('\n'),
        loader: 'css',
        resolveDir: config.root,
        sourcefile: 'global.css',
      },
      outfile,
      bundle: true,
      minify: !options.dev,
      conditions: ['style', 'browser'],
      assetNames: 'files/[name]-[hash]',
      plugins: [
        cssPublicUrlPlugin(),
        ...getCssExtensions().cssChunkPlugins(),
        ...cssDirectiveOrderPlugins(postcss),
      ],
      loader: {
        '.css': 'css',
        '.module.css': 'css',
        ...cssLoaderEntries(),
        '.woff': 'file',
        '.woff2': 'file',
        '.ttf': 'file',
        '.otf': 'file',
        '.eot': 'file',
        '.png': 'file',
        '.svg': 'file',
        '.ico': 'file',
      },
    }),
  )
  if (postcss) {
    await rewriteTailwindConfigDirectives(outfile, sources)
    await log.step('global css: postcss', () =>
      runPostcssOffThread(config, outfile, options, sources[0]),
    )
  }

  const emitted = await fingerprintAsset(config, outDir, 'global.css', options)
  log.log(`global css → ${path.relative(config.root, emitted)}`)
  return emitted
}

/**
 * Rename a freshly built asset to carry its content hash, and record the
 * logical -> emitted mapping every href/file consumer resolves through.
 * Dev keeps flat names: nothing there is served immutable, and the dev server
 * addresses these files by their logical name.
 */
async function fingerprintAsset(
  config: Pick<ResolvedConfig, 'outPath'>,
  outDir: string,
  assetName: string,
  options: CssBuildOptions,
) {
  const outfile = path.join(outDir, assetName)
  if (options.dev) return outfile
  const emittedName = hashedAssetName(assetName, await readFile(outfile))
  const emitted = path.join(outDir, emittedName)
  if (emitted !== outfile) await rename(outfile, emitted)
  recordEmittedAsset(config.outPath, assetName, emittedName)
  return emitted
}

function moduleSpecifiers(source: string) {
  const specifiers: string[] = []
  const pattern = /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(source))) {
    if (match[1]) specifiers.push(match[1])
  }

  return specifiers
}

function cssFileExtensions() {
  return ['.css', ...getCssExtensions().extraCssExtensions()]
}

export function isCssFile(file: string) {
  return cssFileExtensions().some(extension => file.endsWith(extension))
}

function cssLoaderEntries() {
  return Object.fromEntries(
    getCssExtensions()
      .extraCssExtensions()
      .map(extension => [extension, 'css'] as const),
  )
}

// The compat CSS-chunk plan (Next `experimental.cssChunking`), computed once
// across all routes by prepareRouteCssChunks before the per-route build loop.
// Pure-core apps never populate it, so every route keeps its single chunk.
const routeCssPlan = new Map<string, string[][]>()

// Partition each route's ordered cssImports into chunk slices via the compat
// registry (Next's CSS chunking). Must run before buildRouteCss so the loop can
// emit one asset per slice; a no-op for pure-core apps (empty plan).
export function prepareRouteCssChunks(routes: Pick<RouteManifestEntry, 'id' | 'cssImports'>[]) {
  routeCssPlan.clear()
  const plan = getCssExtensions().planRouteCssChunks(
    routes.map(route => ({ id: route.id, cssImports: route.cssImports })),
  )
  for (const [id, segments] of plan) routeCssPlan.set(id, segments)
}

export async function buildRouteCss(
  config: ResolvedConfig,
  route: RouteManifestEntry,
  options: CssBuildOptions = {},
) {
  if (route.cssImports.length === 0) return undefined
  const segments = routeCssPlan.get(route.id)
  if (segments && segments.length > 1) {
    const assetNames = segments.map((_, index) => `${route.id}-${index}.css`)
    route.cssAssets = assetNames
    const files: string[] = []
    for (const [index, segment] of segments.entries()) {
      files.push(
        await bundleCssChunk(
          config,
          segment,
          assetNames[index]!,
          `route css ${route.route} #${index + 1}`,
          options,
        ),
      )
    }
    return files
  }
  route.cssAssets = undefined
  return bundleCssChunk(
    config,
    route.cssImports,
    `${route.id}.css`,
    `route css ${route.route}`,
    options,
  )
}

// The synthetic document conventions are created at render time and never
// appear in the scanned manifest, so their stylesheet chunks aren't emitted by
// the per-route CSS build loop. Build them explicitly:
// an unmatched URL rendering the root not-found ships `/assets/not-found.css`
// (its own CSS) alongside `/assets/global.css` (the root layout's CSS).
export async function buildNotFoundCss(config: ResolvedConfig, options: CssBuildOptions = {}) {
  const { collectFileCss } = await import('../routing/routes')
  const targets: { id: string; files: string[]; includeGlobalCss?: boolean }[] = [
    {
      id: 'not-found',
      files: conventionCandidates(config.appPath, 'not-found'),
    },
    {
      id: 'global-not-found',
      files: conventionCandidates(config.appPath, 'global-not-found'),
      // global-not-found replaces the whole document (no root layout), so CSS
      // it shares with the root layout must ship in its own chunk — the global
      // sheet is not linked on that document.
      includeGlobalCss: true,
    },
    {
      id: 'global-error',
      files: conventionCandidates(config.appPath, 'global-error'),
    },
  ]
  for (const target of targets) {
    const cssImports = await collectFileCss(config.appPath, target.files, {
      includeGlobalCss: target.includeGlobalCss ?? false,
    })
    if (cssImports.length === 0) continue
    await bundleCssChunk(config, cssImports, `${target.id}.css`, `route css /${target.id}`, options)
  }
}

function conventionCandidates(appPath: string, base: string) {
  return ['tsx', 'ts', 'jsx', 'js'].map(ext => path.join(appPath, `${base}.${ext}`))
}

// CSS reachable only through a non-SSR dynamic island ships as its own chunk
// (assets/<reference-id>.css), fetched by the client entry when the island
// loads instead of blocking the route stylesheet.
export async function buildClientReferenceCss(
  config: ResolvedConfig,
  reference: ClientReference,
  options: CssBuildOptions = {},
) {
  if (!reference.cssImports || reference.cssImports.length === 0) return undefined
  return bundleCssChunk(
    config,
    reference.cssImports,
    `${reference.id}.css`,
    `island css ${reference.id}`,
    options,
  )
}

async function bundleCssChunk(
  config: ResolvedConfig,
  cssImports: string[],
  assetName: string,
  label: string,
  options: CssBuildOptions,
) {
  const log = createVerboseLogger(options.verbose ?? false, 'css')

  const outDir = options.dev
    ? path.join(config.outPath, 'cache', 'assets')
    : path.join(config.outPath, 'public', 'assets')
  const outfile = path.join(outDir, assetName)
  await ensureDir(outDir)

  log.log(`${label}: ${cssImports.length} import${cssImports.length === 1 ? '' : 's'}`)

  const postcss = hasPostcssConfig(config.root)
  await build({
    stdin: {
      contents: cssImports.map(file => `@import ${JSON.stringify(file)};`).join('\n'),
      loader: 'css',
      resolveDir: config.root,
      sourcefile: assetName,
    },
    outfile,
    bundle: true,
    minifyWhitespace: !options.dev,
    minifySyntax: !options.dev,
    minifyIdentifiers: false,
    conditions: ['style', 'browser'],
    assetNames: 'files/[name]-[hash]',
    // Lazy registry read: compat (sass) plugins register at bootstrap.
    plugins: [
      cssPublicUrlPlugin(),
      ...getCssExtensions().cssChunkPlugins(),
      cssModuleBuildPlugin(),
      ...cssDirectiveOrderPlugins(postcss),
    ],
    loader: {
      '.css': 'css',
      '.module.css': 'css',
      ...cssLoaderEntries(),
      '.woff': 'file',
      '.woff2': 'file',
      '.ttf': 'file',
      '.otf': 'file',
      '.eot': 'file',
      '.png': 'file',
      '.svg': 'file',
      '.ico': 'file',
    },
  })

  if (postcss) {
    await rewriteTailwindConfigDirectives(outfile, cssImports)
    await log.step(`${label}: postcss`, () => runPostcssOffThread(config, outfile, options))
  }

  return fingerprintAsset(config, outDir, assetName, options)
}

// A leading slash in a CSS url() is a public URL, not an app-root filesystem
// path. Keep it verbatim so the production bundle matches the dev server and
// Next's public/ asset contract; relative URLs still use esbuild's file loader.
function cssPublicUrlPlugin(): Plugin {
  return {
    name: 'pnext-css-public-url',
    setup(plugin) {
      plugin.onResolve({ filter: /^\// }, args =>
        args.kind === 'url-token' ? { path: args.path, external: true } : undefined,
      )
    },
  }
}

export function registerCssRuntime() {
  if (cssRuntimeRegistered) return
  cssRuntimeRegistered = true

  Bun.plugin({
    name: 'pnext-css-runtime',
    setup(plugin) {
      plugin.onLoad({ filter: /\.(?:css|scss|sass)$/ }, async ({ path: file }) =>
        isCssModuleFile(file)
          ? {
              exports: { default: await cssModuleMapping(file) },
              loader: 'object',
            }
          : {
              contents: 'export default undefined;',
              loader: 'js',
            },
      )
    },
  })
}

// Sass is unsupported (no compiler); its imports still must not break the
// bundle, so .scss/.sass load as empty modules with module class-name maps.
function isCssModuleFile(file: string) {
  return /\.module\.(?:css|scss|sass)$/.test(file)
}

export function cssModuleClientPlugin(): Plugin {
  return {
    name: 'pnext-css-modules',
    setup(plugin) {
      plugin.onLoad({ filter: /\.(?:css|scss|sass)$/ }, async ({ path: file }) => ({
        contents: isCssModuleFile(file)
          ? `export default ${JSON.stringify(await cssModuleMapping(file))};`
          : 'export default undefined;',
        loader: 'js',
      }))
    },
  }
}

// Tailwind's own pipeline consumes @source/@plugin/@config wherever they sit, so apps write them
// above their @import lines. esbuild bundles first and rejects any @import that follows another
// rule ("invalid-@import"), leaving that sheet unbundled — a broken stylesheet. Only postcss apps
// can have these directives, so plain-CSS apps keep esbuild's native (plugin-free) load path.
function cssDirectiveOrderPlugins(postcss: boolean): Plugin[] {
  return postcss ? [cssDirectiveOrderPlugin()] : []
}

function cssDirectiveOrderPlugin(): Plugin {
  return {
    name: 'pnext-css-directive-order',
    setup(plugin) {
      plugin.onLoad({ filter: /\.css$/ }, async ({ path: file }) => ({
        contents: hoistCssImports(await readText(file)),
        loader: 'css',
        resolveDir: path.dirname(file),
      }))
    },
  }
}

/** At-rules that configure Tailwind and emit no CSS, so their position is free. */
const CSS_CONFIG_AT_RULES = new Set(['source', 'plugin', 'config'])

/**
 * Move leading @import statements above the Tailwind config directives they follow. Only the
 * statement prefix of the file is considered: the first rule that is neither an @import, a
 * config directive, a comment nor @charset stops the scan, so real CSS never moves.
 */
export function hoistCssImports(source: string) {
  if (!/@(?:source|plugin|config)\b/.test(source)) return source

  const imports: string[] = []
  const others: string[] = []
  let charset = ''
  let sawDirective = false
  let hoist = false
  let index = 0

  while (index < source.length) {
    const code = source.charCodeAt(index)
    // space, tab, LF, CR, FF — CSS whitespace, without a regex call per character.
    if (code === 32 || code === 9 || code === 10 || code === 13 || code === 12) {
      index += 1
      continue
    }
    const char = source[index]!
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      if (end === -1) break
      others.push(source.slice(index, end + 2))
      index = end + 2
      continue
    }
    const name = char === '@' ? /^@([\w-]+)/.exec(source.slice(index))?.[1] : undefined
    if (!name) break
    if (name !== 'import' && name !== 'charset' && !CSS_CONFIG_AT_RULES.has(name)) break
    const end = statementEnd(source, index)
    if (end === -1) break

    const statement = source.slice(index, end)
    if (name === 'charset') charset ||= statement
    else if (name === 'import') {
      imports.push(statement)
      if (sawDirective) hoist = true
    } else {
      others.push(statement)
      sawDirective = true
    }
    index = end
  }

  if (!hoist) return source
  return `${[charset, ...imports, ...others].filter(Boolean).join('\n')}\n${source.slice(index)}`
}

/** End offset (past the `;`) of a block-less at-rule, or -1 if it isn't one. */
function statementEnd(source: string, start: number) {
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]!
    if (char === ';') return index + 1
    if (char === '{' || char === '}') return -1
    if (char === '"' || char === "'") {
      index = skipString(source, index)
      if (index === -1) return -1
    }
  }
  return -1
}

/** Index of the closing quote of the string starting at `start`, or -1. */
function skipString(source: string, start: number) {
  const quote = source[start]
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index]
    if (char === '\\') index += 1
    else if (char === quote) return index
  }
  return -1
}

function cssModuleBuildPlugin(): Plugin {
  return {
    name: 'pnext-css-module-build',
    setup(plugin) {
      plugin.onLoad({ filter: /\.module\.css$/ }, async ({ path: file }) => ({
        contents: transformCssModule(await readText(file), file),
        loader: 'css',
      }))
    },
  }
}

async function cssModuleMapping(file: string) {
  // Compat handles *.module.{scss,sass} (sass compiles + scopes); core keeps
  // plain .module.css. Lazy read: the registry populates at compat bootstrap.
  const compatMapping = getCssExtensions().resolveCssModule(file)
  if (compatMapping) return compatMapping
  const source = await readText(file)
  const classNames = cssClassNames(source)

  return Object.fromEntries(
    [...classNames].map(className => [className, cssModuleClassName(file, className)]),
  )
}

function cssClassNames(source: string) {
  const classNames = new Set<string>()
  const classPattern = /(^|[^\\])\.(-?[_a-zA-Z][\w-]*)/g
  let match: RegExpExecArray | null

  while ((match = classPattern.exec(source))) {
    if (match[2]) classNames.add(match[2])
  }

  return classNames
}

function transformCssModule(source: string, file: string) {
  let css = source
  for (const className of cssClassNames(source)) {
    css = rewriteClassSelector(css, cssModuleClassName(file, className), className)
  }
  css = scopeKeyframes(css, file)
  return css
}

// CSS-module `@keyframes` names are scoped like class names, so a local animation `example` from two
// modules must not collide. The `@keyframes` declaration AND every `animation-name`/`animation` shorthand
// reference to it are rewritten to the scoped name. `grid-area` names are NOT identifiers of this kind and
// are left untouched.
function scopeKeyframes(css: string, file: string) {
  const names = keyframeNames(css)
  if (names.size === 0) return css

  let out = css
  for (const name of names) {
    const scoped = cssModuleClassName(file, name)
    // Rename the @keyframes / @-webkit-keyframes block name.
    out = out.replace(
      new RegExp(`(@(?:-webkit-)?keyframes\\s+)${escapeRegex(name)}(?![-_a-zA-Z0-9])`, 'g'),
      `$1${scoped}`,
    )
    // Rename `animation-name: name`.
    out = out.replace(
      new RegExp(`(animation-name\\s*:\\s*)${escapeRegex(name)}(?![-_a-zA-Z0-9])`, 'g'),
      `$1${scoped}`,
    )
    // Rename the name inside an `animation:` shorthand (token-bounded).
    out = out.replace(
      new RegExp(
        `(animation\\s*:[^;{}]*?(?<![-_a-zA-Z0-9]))${escapeRegex(name)}(?![-_a-zA-Z0-9])`,
        'g',
      ),
      `$1${scoped}`,
    )
  }
  return out
}

function keyframeNames(css: string) {
  const names = new Set<string>()
  const pattern = /@(?:-webkit-)?keyframes\s+(-?[_a-zA-Z][\w-]*)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(css))) {
    if (match[1]) names.add(match[1])
  }
  return names
}

function cssModuleClassName(file: string, className: string) {
  const base = path
    .basename(file)
    .replace(/\.module\.css$/, '')
    .replace(/[^_a-zA-Z0-9]/g, '_')
  const hash = pathHash(cssModuleScopePath(file))
  return `${base}_${className}_${hash}`
}

function cssModuleScopePath(file: string) {
  const normalized = file.split(path.sep).join('/')
  const appIndex = normalized.lastIndexOf('/app/')
  if (appIndex !== -1) return normalized.slice(appIndex + 1)
  return normalized.split('/').slice(-3).join('/')
}

function rewriteClassSelector(css: string, scopedClassName: string, originalClassName: string) {
  const esbuildNamePattern = new RegExp(
    `\\.${escapeRegex(originalClassName)}(?![-_a-zA-Z0-9])`,
    'g',
  )
  return css.replace(esbuildNamePattern, `.${scopedClassName}`)
}

function pathHash(file: string) {
  let hash = 5381
  for (const char of file) hash = ((hash << 5) + hash) ^ char.charCodeAt(0)
  return (hash >>> 0).toString(36).slice(0, 5)
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasPostcssConfig(root: string) {
  return postcssConfigFile(root) !== undefined
}

// Bundling moves the CSS away from the directory its `@config` paths were
// written against, and Tailwind resolves them against postcss's `from` (the
// original source, not the outfile). Absolute paths sidestep both bases.
export async function rewriteTailwindConfigDirectives(cssFile: string, sources: string[]) {
  const candidateDirs = [path.dirname(cssFile), ...sources.map(file => path.dirname(file))]
  let css = await readText(cssFile)
  let changed = false

  css = css.replace(
    /@config\s+(['"])([^'"]+)\1\s*;/g,
    (match, quote: string, specifier: string) => {
      if (!isRelativeSpecifier(specifier)) return match
      const resolved = candidateDirs
        .map(dir => path.resolve(dir, specifier))
        .find(file => existsSync(file))
      if (!resolved) return match

      changed = true
      return `@config ${quote}${resolved.split(path.sep).join('/')}${quote};`
    },
  )

  if (changed) await writeFile(cssFile, css)
}

function isRelativeSpecifier(specifier: string) {
  return specifier.startsWith('./') || specifier.startsWith('../')
}
