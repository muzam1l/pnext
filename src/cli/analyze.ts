import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import type { Metafile } from 'esbuild'
import { DEFAULT_OUT_DIR, loadConfig, type ResolvedConfig } from '../config'
import { emittedAssetName, publishEmittedAssets, routeCssAssetNames } from '../css/build'
import { matchRoute } from '../routing/routes'
import { bold, cyan, dim, formatBytes, formatDelta, yellow } from '../utils/ansi'
import { listFiles, resolveManifest } from '../utils/fs'
import type { BuildManifest, RouteManifestEntry } from '../types'
import { buildManifestFile } from '../runtime/production'
import { analyzeSizesFile, outCachePath, standaloneOutSegment } from '../out-paths'

export interface AnalyzeResult {
  root: string
  compression: AnalyzeCompression
  files: AnalyzeFile[]
  routeBundles: AnalyzeRouteBundle[]
  totals: {
    rawBytes: number
    compressedBytes: number
  }
  /** App-wide findings: packages bundled into several chunks or installed twice. */
  flags: AnalyzeFlag[]
  /** Import chains for `--why`, one per route that loads the target. */
  why?: AnalyzeWhy[]
}

export interface AnalyzeFile {
  path: string
  type: 'html' | 'css' | 'js' | 'asset'
  rawBytes: number
  compressedBytes: number
}

export interface AnalyzeRouteBundle {
  route: string
  page: 'server' | 'client'
  initial: AnalyzeBundleFile[]
  visibleDynamic: AnalyzeDynamicBundleFile[]
  dynamic: AnalyzeDynamicBundleFile[]
  lazyShared: AnalyzeBundleFile[]
  initialSize: { rawBytes: number; compressedBytes: number }
  /** Configured gzip budget for the initial load, in bytes. */
  budget?: number
  /** Against the previous build, as recorded by `pnext build`. */
  diff?: AnalyzeDiff
  chunks: AnalyzeChunk[]
  packages: AnalyzePackage[]
  css: AnalyzeCssFile[]
  tailwind?: AnalyzeTailwindSource[]
  fonts: AnalyzeFont[]
  flags: AnalyzeFlag[]
}

export interface AnalyzeBundleFile {
  path: string
  rawBytes: number
  compressedBytes: number
}

export interface AnalyzeDynamicBundleFile extends AnalyzeBundleFile {
  /** Island's client-reference id, as emitted in the entry's island table. */
  id: string
  /** Display name: the reference's named export, or its module basename. */
  component: string
  exportName: string
  load: 'render' | 'visible'
}

export interface AnalyzeChunk extends AnalyzeBundleFile {
  load: 'initial' | 'dynamic' | 'lazy'
  /** What the chunk is made of, e.g. `@floating-ui/* 48% · tailwind-merge 18%`. */
  label: string
  /** The package the build named the file after, when it is under half the contents. */
  misnamed?: string
  packages: { name: string; rawBytes: number; share: number }[]
  modules: { id: string; rawBytes: number }[]
}

export interface AnalyzePackage {
  name: string
  rawBytes: number
  /** The package's share of its chunks' compressed size. */
  compressedBytes: number
  modules: number
  commonjs: boolean
  /** Importers between the package and the route, nearest first. */
  via: string[]
}

export interface AnalyzeCssFile extends AnalyzeBundleFile {
  kind: 'global' | 'route'
  rules: number
  utilities: number
  /** Utilities whose class the route's HTML, client JS or source mentions. */
  usedUtilities: number
}

export interface AnalyzeTailwindSource {
  source: string
  kind: 'auto' | '@source' | 'unattributed'
  files: number
  utilities: number
  /** Utilities no other source produces: what dropping this source would remove. */
  only: number
  used: number
}

export interface AnalyzeFont {
  family: string
  weight?: string
  style?: string
  files: { path: string; rawBytes: number }[]
  preloaded: boolean
  used: boolean
}

export interface AnalyzeFlag {
  kind: 'budget' | 'runtime' | 'small-chunk' | 'full-package' | 'duplicate' | 'font'
  message: string
  /** Chunks the finding is about. */
  files?: string[]
}

export interface AnalyzeDiff {
  compressedBytes: number
  previousBytes: number
  /** Raw initial JS per package that changed. */
  packages: { name: string; rawBytes: number; previousBytes: number }[]
}

export interface AnalyzeWhy {
  route: string
  target: string
  /** Target first, route last. */
  chain: string[]
  dynamic: boolean
  importers: string[]
}

export type AnalyzeCompression = 'gzip' | 'brotli'

interface AnalyzeOptions {
  compression?: AnalyzeCompression
  route?: string
  why?: string
  /** Chunk composition, packages, CSS and fonts per route. On by default. */
  details?: boolean
}

// `pnext build` records these so analyze never loads the app's config. Under `cache`: a derived
// report, outside the build output the build cache fingerprints.
const ANALYZE_DIR = 'analyze'
const GRAPH_FILE = 'graph.json'
const SMALL_CHUNK_BYTES = 1024
const COMMONJS_FLAG_BYTES = 2048
const BARREL_FLAG_MODULES = 20
const DUPLICATE_FLAG_BYTES = 512
const FRAMEWORK_PACKAGE = frameworkPackageName()

export interface AnalyzeGraph {
  version: 1
  /** Shipped chunk path (`assets/…`) → its esbuild entry module and per-module bytes. */
  chunks: Record<string, { entry?: string; inputs: Record<string, number> }>
  /** Module id (path relative to the app root) → package and import edges. */
  modules: Record<string, AnalyzeGraphModule>
}

interface AnalyzeGraphModule {
  package: string
  /** Package directory relative to the app root. */
  root: string
  commonjs?: true
  /** [module, dynamic, bare specifier] */
  imports: [string, 0 | 1, string?][]
}

export interface AnalyzeRouteSize {
  rawBytes: number
  compressedBytes: number
  /** Raw initial JS bytes per package. */
  packages: Record<string, number>
}

export interface AnalyzeSizes {
  version: 1
  budgets?: Record<string, number>
  /** Root layout stylesheet sources, relative to the app root. */
  globalCss?: string[]
  routes: Record<string, AnalyzeRouteSize>
  previous?: Record<string, AnalyzeRouteSize>
}

export interface ClientBuildGraph {
  metafile: Metafile
  renames: Map<string, string>
}

export async function analyzeProject(
  root?: string,
  options: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  const build = await locateBuild(root)
  if (!existsSync(build.outPath)) {
    throw new Error(`No PNext output found at ${build.outPath}. Run pnext build first.`)
  }
  // Dev output is unminified, so its sizes say nothing about what ships; analyze is production-only.
  // PPR shells live outside `static`: resumed server-side, never downloaded.
  const publicPath = path.join(build.outPath, 'static')
  if (!existsSync(publicPath)) {
    throw new Error(`No production build found at ${build.outPath}. Run pnext build first.`)
  }

  const compression = options.compression ?? 'gzip'
  const stored = readJson<BuildManifest>(buildManifestFile(build.outPath))
  // The release stores source paths relative to itself; analyze reads them on the build machine.
  const manifest =
    stored && resolveManifest(stored, build.outPath, path.resolve(build.outPath, stored.root))
  const graph = readJson<AnalyzeGraph>(
    path.join(outCachePath(build.outPath), ANALYZE_DIR, GRAPH_FILE),
  )
  const sizes = readAnalyzeSizes(build.outPath)
  const ctx = createContext({
    outPath: build.outPath,
    publicPath,
    appRoot: manifest?.root ?? build.root,
    files: (await listFiles(publicPath)).map(file => toPosix(path.relative(publicPath, file))),
    compression,
    ...(manifest ? { manifest } : {}),
    ...(graph ? { graph } : {}),
    ...(sizes ? { sizes } : {}),
  })

  let routeBundles: AnalyzeRouteBundle[] = []
  let flags: AnalyzeFlag[] = []
  let why: AnalyzeWhy[] | undefined
  if (manifest) {
    // Resolve the logical CSS names through the build's content-hashed spellings.
    publishEmittedAssets(build.outPath, manifest.assetNames)
    const pages = manifest.routes.filter(route => route.kind === 'page')
    const selected: AnalyzeRouteSelection[] = options.route
      ? filterAnalyzeRoutes(pages, options.route)
      : pages.map(route => ({ route }))
    if (options.route && selected.length === 0) {
      throw new Error(
        `No route matches ${options.route}. Routes:\n  ${pages
          .map(route => publicRoutePath(route.route))
          .join('\n  ')}`,
      )
    }
    // Every route's files, not just the selected ones: duplication is a cross-route question.
    const all = await Promise.all(pages.map(route => collectRouteFiles(ctx, route)))
    const byRoute = new Map(all.map(files => [files.route, files]))
    const routeFiles = await Promise.all(
      selected.map(({ route, pathname }) =>
        pathname ? collectRouteFiles(ctx, route, pathname) : Promise.resolve(byRoute.get(route)!),
      ),
    )
    flags = appFlags(ctx, all)
    if (options.route) {
      const touched = new Set(routeFiles.flatMap(routeJsFiles))
      flags = flags.filter(flag => flag.files?.some(file => touched.has(file)) ?? true)
    }
    routeBundles = await Promise.all(
      routeFiles.map(files => analyzeRouteBundle(ctx, files, options.details ?? true)),
    )
    if (options.why) why = routeFiles.flatMap(files => whyChains(ctx, files, options.why!))
  }

  const paths = options.route ? [...new Set(routeBundles.flatMap(bundleFilePaths))] : ctx.files
  const files = await Promise.all(
    paths.map(async file => ({ ...(await ctx.size(file)), type: fileType(file) })),
  )
  return {
    root: path.relative(build.root, publicPath),
    compression,
    files,
    routeBundles,
    totals: sumSizes(files),
    flags,
    ...(why ? { why } : {}),
  }
}

// The default output needs no config: loading one runs the app's env validation, which a size
// report has no business requiring. Only a custom outDir needs the config to find it.
async function locateBuild(root?: string) {
  const projectRoot = path.resolve(root ?? process.cwd())
  const outPath = path.join(projectRoot, DEFAULT_OUT_DIR, standaloneOutSegment)
  if (existsSync(buildManifestFile(outPath))) return { root: projectRoot, outPath }
  const config = await loadConfig(root)
  return { root: config.root, outPath: config.outPath }
}

interface AnalyzeContext {
  outPath: string
  publicPath: string
  appRoot: string
  files: string[]
  exists: Set<string>
  compression: AnalyzeCompression
  manifest?: BuildManifest
  graph?: AnalyzeGraph
  sizes?: AnalyzeSizes
  size(file: string): Promise<AnalyzeBundleFile>
  text(file: string): Promise<string>
  tokens(file: string): Promise<Set<string>>
  css(file: string): Promise<CssRule[]>
  tailwind?: Promise<TailwindAttribution | undefined>
}

function createContext(
  options: Omit<AnalyzeContext, 'exists' | 'size' | 'text' | 'tokens' | 'css' | 'tailwind'>,
): AnalyzeContext {
  const sizes = new Map<string, Promise<AnalyzeBundleFile>>()
  const texts = new Map<string, Promise<string>>()
  const tokens = new Map<string, Promise<Set<string>>>()
  const css = new Map<string, Promise<CssRule[]>>()
  // Public files by their `assets/…` path; source files by absolute path.
  const absolute = (file: string) =>
    path.isAbsolute(file) ? file : path.join(options.publicPath, file)
  const memo = <T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>) => {
    let value = cache.get(key)
    if (!value) cache.set(key, (value = load()))
    return value
  }
  const ctx: AnalyzeContext = {
    ...options,
    exists: new Set(options.files),
    size: file =>
      memo(sizes, file, async () => {
        const bytes = await readFile(absolute(file))
        return {
          path: file,
          rawBytes: bytes.length,
          compressedBytes: await compressedSize(bytes, options.compression),
        }
      }),
    text: file => memo(texts, file, () => readFile(absolute(file), 'utf8').catch(() => '')),
    tokens: file => memo(tokens, file, async () => classTokens(await ctx.text(file))),
    css: file => memo(css, file, async () => parseCss(await ctx.text(file))),
  }
  return ctx
}

interface AnalyzeRouteSelection {
  route: RouteManifestEntry
  /** Concrete pathname the filter matched, for a param route's prerendered HTML. */
  pathname?: string
}

// Accepts the route in ':id' or '[id]' template form, or a concrete pathname
// (e.g. /users/ada) matched through the route patterns. A concrete pathname is
// carried through so the bundle reports that page's prerendered HTML.
function filterAnalyzeRoutes(pages: RouteManifestEntry[], filter: string): AnalyzeRouteSelection[] {
  const normalized = filter === '/' ? filter : filter.replace(/\/+$/, '')
  const direct = pages.filter(
    route => route.route === normalized || publicRoutePath(route.route) === normalized,
  )
  if (direct.length > 0) return direct.map(route => ({ route }))
  const matched = matchRoute(pages, normalized)
  return matched ? [{ route: matched.route, pathname: normalized }] : []
}

function publicRoutePath(route: string) {
  return route.replace(/:([a-zA-Z0-9_]+)\*/g, '[...$1]').replace(/:([a-zA-Z0-9_]+)/g, '[$1]')
}

interface RouteFiles {
  route: RouteManifestEntry
  html?: string
  initial: string[]
  islands: { path: string; id: string }[]
  lazy: string[]
}

async function collectRouteFiles(
  ctx: AnalyzeContext,
  route: RouteManifestEntry,
  pathname?: string,
): Promise<RouteFiles> {
  const initial = new Set<string>()
  const add = (items: Set<string>, file: string) => {
    const normalized = toPosix(file)
    if (ctx.exists.has(normalized)) items.add(normalized)
  }
  const html = routeHtmlPath(route, pathname)
  add(initial, html)
  add(initial, globalCssFile(ctx))
  for (const asset of routeCssAssetNames(route)) add(initial, assetFile(ctx, asset))
  // Every compat page loads this with a blocking <script>. The sibling
  // `_ssgManifest.js` (router-fetched, never in the document) and the
  // `polyfills-*.js` chunk (noModule: legacy browsers only) are deliberately
  // not initial weight for a modern client.
  add(initial, '_next/static/pnext/_buildManifest.js')

  if (route.clientEntry) {
    add(initial, route.clientEntry)
    // The build records the entry's chunk closure from the esbuild metafile and
    // the renderer modulepreloads exactly this set. Chunk folding hoists imports
    // out of the entry module, so walking its source alone under-reports; the
    // walk stays as a union for dev-style single-bundle entries, which never
    // populate clientEntryImports.
    for (const asset of route.clientEntryImports ?? []) add(initial, asset)
    for (const dependency of await staticDependencies(ctx, route.clientEntry)) {
      initial.add(dependency)
    }
  }

  const islands: RouteFiles['islands'] = []
  const islandPaths = new Set<string>()
  const lazy = new Set<string>()
  const entry = route.clientEntry && toPosix(route.clientEntry)
  if (entry && ctx.exists.has(entry)) {
    const entrySource = await ctx.text(entry)
    for (const island of islandImports(entrySource, entry)) {
      if (!ctx.exists.has(island.path)) continue
      islandPaths.add(island.path)
      islands.push(island)
      // An island with its own CSS loads `assets/<referenceId>.css` alongside its
      // chunk (loadIslandCss); it is deferred weight, so it belongs here rather
      // than in initial.
      const reference = route.clientReferences.find(item => item.id === island.id)
      if (reference?.cssImports?.length) add(lazy, `assets/${island.id}.css`)
      for (const dependency of await staticDependencies(ctx, island.path)) {
        if (!initial.has(dependency) && !islandPaths.has(dependency)) lazy.add(dependency)
      }
    }
    // Same metafile closure as the renderer's low-priority preloads, unioned
    // with the entry-source walk for the same reason as the static side above.
    for (const asset of [
      ...(route.clientDynamicImports ?? []),
      ...dynamicImportPaths(entrySource, entry),
    ]) {
      const importedPath = toPosix(asset)
      if (initial.has(importedPath) || islandPaths.has(importedPath)) continue
      if (ctx.exists.has(importedPath)) lazy.add(importedPath)
      for (const dependency of await staticDependencies(ctx, importedPath)) {
        if (!initial.has(dependency) && !islandPaths.has(dependency)) lazy.add(dependency)
      }
    }
  }

  return {
    route,
    ...(ctx.exists.has(html) ? { html } : {}),
    initial: [...initial],
    islands,
    lazy: [...lazy],
  }
}

function assetFile(ctx: AnalyzeContext, name: string) {
  return `assets/${emittedAssetName({ outPath: ctx.outPath }, name)}`
}

function globalCssFile(ctx: AnalyzeContext) {
  return assetFile(ctx, 'global.css')
}

function routeJsFiles(files: RouteFiles) {
  return [...files.initial, ...files.islands.map(island => island.path), ...files.lazy].filter(
    file => file.endsWith('.js'),
  )
}

async function analyzeRouteBundle(
  ctx: AnalyzeContext,
  files: RouteFiles,
  details: boolean,
): Promise<AnalyzeRouteBundle> {
  const { route } = files
  const visibleDynamic: AnalyzeDynamicBundleFile[] = []
  const dynamic: AnalyzeDynamicBundleFile[] = []
  for (const island of files.islands) {
    // Keyed by island id: every island's loader resolves `module.default`, so
    // matching on the export name collapses them all onto one reference.
    const reference = route.clientReferences.find(item => item.id === island.id)
    const load: AnalyzeDynamicBundleFile['load'] =
      reference?.dynamic?.load === 'visible' ? 'visible' : 'render'
    const exportName = reference?.exportName ?? 'default'
    const item: AnalyzeDynamicBundleFile = {
      ...(await ctx.size(island.path)),
      id: island.id,
      component: islandComponent(exportName, reference?.file, island.path),
      exportName,
      load,
    }
    if (load === 'visible') visibleDynamic.push(item)
    else dynamic.push(item)
  }
  const initial = await bundleFiles(ctx, files.initial)
  const initialSize = sumSizes(initial)
  const budget = budgetFor(ctx.sizes?.budgets, route.route)
  const recorded = ctx.sizes?.routes[route.route]
  const previous = ctx.sizes?.previous?.[route.route]
  const bundle: AnalyzeRouteBundle = {
    route: route.route,
    page: route.client ? 'client' : 'server',
    initial,
    visibleDynamic: visibleDynamic.sort((a, b) => b.compressedBytes - a.compressedBytes),
    dynamic: dynamic.sort((a, b) => b.compressedBytes - a.compressedBytes),
    lazyShared: await bundleFiles(ctx, files.lazy),
    initialSize,
    ...(budget !== undefined ? { budget } : {}),
    ...(recorded && previous ? { diff: routeDiff(recorded, previous) } : {}),
    chunks: [],
    packages: [],
    css: [],
    fonts: [],
    flags: [],
  }
  // Budgets are gzip numbers; a brotli run compares against the build's recorded gzip size.
  const gzipBytes =
    ctx.compression === 'gzip' ? initialSize.compressedBytes : recorded?.compressedBytes
  if (budget !== undefined && gzipBytes !== undefined && gzipBytes > budget) {
    bundle.flags.push({
      kind: 'budget',
      message: `initial load is ${formatBytes(gzipBytes)} gzip, over its ${formatBytes(budget)} budget by ${formatBytes(gzipBytes - budget)}`,
    })
  }
  const initialModules = routeModules(ctx, files.initial)
  bundle.flags.push(...runtimeFlags(route, initialModules), ...(await smallChunkFlags(ctx, files)))
  if (!details) return bundle

  bundle.chunks = await routeChunks(ctx, files)
  bundle.packages = await routePackages(ctx, files)
  bundle.flags.push(...packageFlags(ctx, bundle.packages, initialModules))
  const referenced = await routeTokens(ctx, files)
  bundle.css = await routeCss(ctx, files, referenced)
  if (bundle.css.some(file => file.kind === 'global')) {
    const tailwind = await (ctx.tailwind ??= tailwindAttribution(ctx))
    if (tailwind) bundle.tailwind = tailwindSummary(tailwind, referenced)
  }
  bundle.fonts = await routeFonts(ctx, files, referenced)
  for (const font of bundle.fonts) {
    if (!font.preloaded || font.used) continue
    const face = [font.family, font.weight, font.style].filter(Boolean).join(' ')
    bundle.flags.push({
      kind: 'font',
      message: `font ${face} is preloaded but nothing on the route uses it`,
    })
  }
  return bundle
}

function bundleFilePaths(bundle: AnalyzeRouteBundle) {
  return [...bundle.initial, ...bundle.visibleDynamic, ...bundle.dynamic, ...bundle.lazyShared].map(
    file => file.path,
  )
}

async function bundleFiles(ctx: AnalyzeContext, paths: string[]) {
  const files = await Promise.all(paths.map(file => ctx.size(file)))
  return files.sort((a, b) => b.compressedBytes - a.compressedBytes)
}

function sumSizes(files: { rawBytes: number; compressedBytes: number }[]) {
  return files.reduce(
    (total, file) => ({
      rawBytes: total.rawBytes + file.rawBytes,
      compressedBytes: total.compressedBytes + file.compressedBytes,
    }),
    { rawBytes: 0, compressedBytes: 0 },
  )
}

function islandComponent(exportName: string, file: string | undefined, chunkPath: string) {
  if (exportName !== 'default') return exportName
  const source = file ?? chunkPath.replace(/-[A-Z0-9]{8}\.js$/, '.js')
  return path.posix.basename(toPosix(source)).replace(/\.[^.]+$/, '')
}

async function staticDependencies(ctx: AnalyzeContext, entry: string, seen = new Set<string>()) {
  const dependencies = new Set<string>()
  const normalized = toPosix(entry)
  if (seen.has(normalized) || !ctx.exists.has(normalized)) return dependencies
  seen.add(normalized)

  for (const specifier of staticImports(await ctx.text(normalized))) {
    const dependency = resolveBuiltImport(normalized, specifier)
    if (!dependency || !ctx.exists.has(dependency)) continue
    dependencies.add(dependency)
    for (const transitive of await staticDependencies(ctx, dependency, seen)) {
      dependencies.add(transitive)
    }
  }

  return dependencies
}

// Entries of the entry module's island table, as emitted by client/entry.ts:
//   { id: "c-...", options: {...}, load: () => import("./chunk.js").then(m => m.default) }
// The CSS variant wraps the import in `Promise.all([...])`. Statically-bundled
// islands carry `Component:` instead of `load:` and are part of the entry's own
// closure, so they are not matched here.
function islandImports(source: string, from: string) {
  const imports: { path: string; id: string }[] = []
  const pattern =
    /\bid\s*:\s*"([^"]+)"\s*,\s*options\s*:\s*\{[^{}]*\}\s*,\s*load\s*:\s*\(\)\s*=>\s*(?:Promise\.all\(\[\s*)?import\(\s*"([^"]+)"\s*\)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source))) {
    const id = match[1]
    const specifier = match[2]
    if (!id || !specifier) continue
    const resolved = resolveBuiltImport(from, specifier)
    if (resolved) imports.push({ path: resolved, id })
  }
  return imports
}

function dynamicImportPaths(source: string, from: string) {
  const imports: string[] = []
  const pattern = /import\("([^"]+)"\)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source))) {
    const specifier = match[1]
    if (!specifier) continue
    const resolved = resolveBuiltImport(from, specifier)
    if (resolved) imports.push(resolved)
  }
  return imports
}

function staticImports(source: string) {
  const imports: string[] = []
  const pattern = /import\s*(?:[^'"]*?from\s*)?["']([^'"]+)["']/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source))) {
    if (match[1]) imports.push(match[1])
  }
  return imports
}

function resolveBuiltImport(from: string, specifier: string) {
  if (!specifier.startsWith('.')) return null
  return toPosix(
    path.posix.normalize(path.posix.join(path.posix.dirname(toPosix(from)), specifier)),
  )
}

function routeHtmlPath(route: RouteManifestEntry, pathname?: string) {
  const target = pathname ?? prerenderedPathname(route) ?? route.route
  return target === '/' ? 'index.html' : `${target.replace(/^\/+/, '')}/index.html`
}

// A param route prerenders one file per param set, never `posts/:slug/index.html`.
// Report the first as the representative page instead of dropping HTML entirely.
function prerenderedPathname(route: RouteManifestEntry) {
  const params = route.prerenderedParams?.[0]
  if (!params) return undefined
  return route.route.replace(/:([a-zA-Z0-9_]+)\*?/g, (_match, name: string) => {
    const value = params[name]
    return Array.isArray(value) ? value.join('/') : (value ?? '')
  })
}

// Chunk composition and import chains

function routeModules(ctx: AnalyzeContext, files: string[]) {
  const modules = new Map<string, number>()
  for (const file of files) {
    for (const [id, bytes] of Object.entries(ctx.graph?.chunks[file]?.inputs ?? {})) {
      modules.set(id, (modules.get(id) ?? 0) + bytes)
    }
  }
  return modules
}

async function routeChunks(ctx: AnalyzeContext, files: RouteFiles) {
  const graph = ctx.graph
  if (!graph) return []
  const load = new Map<string, AnalyzeChunk['load']>()
  for (const file of files.lazy) load.set(file, 'lazy')
  for (const island of files.islands) load.set(island.path, 'dynamic')
  for (const file of files.initial) load.set(file, 'initial')
  const chunks: AnalyzeChunk[] = []
  for (const [file, kind] of load) {
    const chunk = graph.chunks[file]
    if (!chunk) continue
    const total = Object.values(chunk.inputs).reduce((sum, bytes) => sum + bytes, 0) || 1
    const packages = new Map<string, number>()
    const families = new Map<string, number>()
    const familyOf = new Map<string, string>()
    for (const [id, bytes] of Object.entries(chunk.inputs)) {
      const module = graph.modules[id]
      const name = module?.package ?? '(unknown)'
      packages.set(name, (packages.get(name) ?? 0) + bytes)
      // Installed scoped packages read as one family (`@floating-ui/core` + `@floating-ui/dom`).
      const scoped = name.startsWith('@') && module?.root.includes('node_modules/')
      const family = scoped ? `${name.split('/')[0]}/*` : name
      familyOf.set(name, family)
      families.set(family, (families.get(family) ?? 0) + bytes)
    }
    // The build names a shared chunk after its largest single package; say so when that family is
    // a minority of the contents.
    const label = chunkFileLabel(file)
    const named = label
      ? [...packages.keys()].find(name => chunkLabelOf(name) === label)
      : undefined
    const namedShare = named ? families.get(familyOf.get(named)!)! / total : 1
    chunks.push({
      ...(await ctx.size(file)),
      load: kind,
      label: [...families]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, bytes]) => `${name} ${formatShare(bytes / total)}`)
        .join(' · '),
      ...(named && namedShare < 0.5 ? { misnamed: named } : {}),
      packages: [...packages]
        .sort((a, b) => b[1] - a[1])
        .map(([name, rawBytes]) => ({ name, rawBytes, share: rawBytes / total })),
      modules: Object.entries(chunk.inputs)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([id, rawBytes]) => ({ id: moduleName(ctx, id), rawBytes })),
    })
  }
  return chunks.sort((a, b) => b.compressedBytes - a.compressedBytes)
}

// The label a shared chunk's file name carries, before its content hash.
function chunkFileLabel(file: string) {
  if (!file.startsWith('assets/chunks/')) return undefined
  return path.posix.basename(file, '.js').replace(/-(?:[0-9a-f]{16}|[A-Z0-9]{8})(?:-\d+)?$/, '')
}

// client/build.ts chunkInputLabel's spelling of a package name.
function chunkLabelOf(name: string) {
  return name
    .replace(/^@/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40)
}

function formatShare(share: number) {
  return share < 0.01 ? '<1%' : `${Math.round(share * 100)}%`
}

async function routePackages(ctx: AnalyzeContext, files: RouteFiles) {
  const graph = ctx.graph
  if (!graph) return []
  const packages = new Map<string, AnalyzePackage>()
  for (const file of files.initial) {
    const chunk = graph.chunks[file]
    if (!chunk) continue
    const total = Object.values(chunk.inputs).reduce((sum, bytes) => sum + bytes, 0) || 1
    const { compressedBytes } = await ctx.size(file)
    for (const [id, bytes] of Object.entries(chunk.inputs)) {
      const module = graph.modules[id]
      const name = module?.package ?? '(unknown)'
      const item = packages.get(name) ?? {
        name,
        rawBytes: 0,
        compressedBytes: 0,
        modules: 0,
        commonjs: false,
        via: [],
      }
      item.rawBytes += bytes
      item.compressedBytes += (compressedBytes * bytes) / total
      item.modules += 1
      item.commonjs ||= Boolean(module?.commonjs)
      packages.set(name, item)
    }
  }
  const entry = routeEntryModule(ctx, files.route)
  const search = entry ? searchImports(graph, entry) : undefined
  for (const item of packages.values()) {
    item.compressedBytes = Math.round(item.compressedBytes)
    const target = search && [...search.order].find(id => graph.modules[id]?.package === item.name)
    if (search && target && target !== entry) {
      item.via = importChain(ctx, search, target, files.route).slice(1, -1)
    }
  }
  return [...packages.values()].sort((a, b) => b.compressedBytes - a.compressedBytes)
}

function routeEntryModule(ctx: AnalyzeContext, route: RouteManifestEntry) {
  return route.clientEntry ? ctx.graph?.chunks[toPosix(route.clientEntry)]?.entry : undefined
}

interface ImportSearch {
  order: Set<string>
  parent: Map<string, { from: string; specifier?: string; dynamic: boolean }>
}

// Breadth-first, so a module is first reached along its shortest chain.
function searchImports(graph: AnalyzeGraph, entry: string): ImportSearch {
  const order = new Set([entry])
  const parent: ImportSearch['parent'] = new Map()
  for (const current of order) {
    for (const [target, dynamic, specifier] of graph.modules[current]?.imports ?? []) {
      if (order.has(target)) continue
      order.add(target)
      const inherited = parent.get(current)?.dynamic ?? false
      parent.set(target, {
        from: current,
        ...(specifier ? { specifier } : {}),
        dynamic: inherited || dynamic === 1,
      })
    }
  }
  return { order, parent }
}

// Each step reads as its importer wrote it: `zod <- @hookform/resolvers/zod <- app/form.tsx <- /route`.
function importChain(
  ctx: AnalyzeContext,
  search: ImportSearch,
  target: string,
  route: RouteManifestEntry,
) {
  const chain: string[] = []
  let current: string | undefined = target
  while (current) {
    const link = search.parent.get(current)
    if (!link) break
    chain.push(link.specifier ?? moduleName(ctx, current))
    current = link.from
  }
  chain.push(publicRoutePath(route.route))
  return chain
}

function moduleName(ctx: AnalyzeContext, id: string) {
  const nodeModules = id.lastIndexOf('node_modules/')
  if (nodeModules !== -1) return id.slice(nodeModules + 'node_modules/'.length)
  const module = ctx.graph?.modules[id]
  if (!module?.root || module.root === '.' || module.package.startsWith('(')) return id
  return `${module.package}/${path.posix.relative(module.root, id)}`
}

function whyChains(ctx: AnalyzeContext, files: RouteFiles, target: string): AnalyzeWhy[] {
  const graph = ctx.graph
  const entry = routeEntryModule(ctx, files.route)
  if (!graph || !entry) return []
  const matches = (id: string) =>
    graph.modules[id]?.package === target || id === target || moduleName(ctx, id) === target
  const search = searchImports(graph, entry)
  const found = [...search.order].find(matches)
  if (!found) return []
  const importers = new Set<string>()
  for (const id of search.order) {
    if (matches(id)) continue
    if (graph.modules[id]?.imports.some(([imported]) => matches(imported))) {
      importers.add(moduleName(ctx, id))
    }
  }
  return [
    {
      route: files.route.route,
      target,
      chain: importChain(ctx, search, found, files.route),
      dynamic: search.parent.get(found)?.dynamic ?? false,
      importers: [...importers],
    },
  ]
}

function routeDiff(current: AnalyzeRouteSize, previous: AnalyzeRouteSize): AnalyzeDiff {
  const names = new Set([...Object.keys(current.packages), ...Object.keys(previous.packages)])
  const packages = [...names]
    .map(name => ({
      name,
      rawBytes: current.packages[name] ?? 0,
      previousBytes: previous.packages[name] ?? 0,
    }))
    .filter(item => item.rawBytes !== item.previousBytes)
    .sort((a, b) => Math.abs(b.rawBytes - b.previousBytes) - Math.abs(a.rawBytes - a.previousBytes))
  return {
    compressedBytes: current.compressedBytes,
    previousBytes: previous.compressedBytes,
    packages,
  }
}

// Flags

const RUNTIME_PIECES: {
  name: string
  match: RegExp
  needed: (route: RouteManifestEntry) => boolean
  why: string
}[] = [
  {
    name: 'client router',
    match: /^src\/client\/router\//,
    needed: route => (route.clientEntryReasons?.length ?? 0) > 0,
    why: 'the route cannot start a soft navigation',
  },
  {
    name: 'server action client',
    match: /^src\/compat\/actions\//,
    needed: route =>
      route.clientEntryReasons?.some(reason => reason === 'actions' || reason === 'form') ?? false,
    why: 'the route dispatches no server action',
  },
]

function runtimeFlags(route: RouteManifestEntry, modules: Map<string, number>): AnalyzeFlag[] {
  const flags: AnalyzeFlag[] = []
  for (const piece of RUNTIME_PIECES) {
    if (piece.needed(route)) continue
    let bytes = 0
    for (const [id, size] of modules) {
      const framework = frameworkPath(id)
      if (framework && piece.match.test(framework)) bytes += size
    }
    if (bytes > 0) {
      flags.push({
        kind: 'runtime',
        message: `ships the ${piece.name} (${formatBytes(bytes)} raw) but ${piece.why}`,
      })
    }
  }
  return flags
}

// A framework module's path inside the pnext package, from any install layout.
function frameworkPath(id: string) {
  return /(?:^|\/)(?:@wular\/)?pnext\/(src\/.+)$/.exec(id)?.[1]
}

async function smallChunkFlags(ctx: AnalyzeContext, files: RouteFiles): Promise<AnalyzeFlag[]> {
  const small: AnalyzeBundleFile[] = []
  for (const file of new Set(routeJsFiles(files))) {
    if (!file.startsWith('assets/chunks/')) continue
    const size = await ctx.size(file)
    if (size.compressedBytes < SMALL_CHUNK_BYTES) small.push(size)
  }
  if (small.length === 0) return []
  const initial = new Set(files.initial)
  const upfront = small.filter(file => initial.has(file.path)).length
  const smallest = [...small]
    .sort((a, b) => a.compressedBytes - b.compressedBytes)
    .slice(0, 5)
    .map(file => `${file.path} ${formatBytes(file.compressedBytes)}`)
  const more = small.length > smallest.length ? ', …' : ''
  const count = `${small.length} chunk${small.length === 1 ? '' : 's'}`
  return [
    {
      kind: 'small-chunk',
      message: `${count} under 1 KB gzip (${upfront} initial), each a request of its own: ${smallest.join(', ')}${more}`,
      files: small.map(file => file.path),
    },
  ]
}

function packageFlags(
  ctx: AnalyzeContext,
  packages: AnalyzePackage[],
  modules: Map<string, number>,
): AnalyzeFlag[] {
  const graph = ctx.graph
  if (!graph) return []
  const rootImported = new Set<string>()
  for (const id of modules.keys()) {
    for (const [target, , specifier] of graph.modules[id]?.imports ?? []) {
      const module = graph.modules[target]
      if (module && specifier === module.package) rootImported.add(module.package)
    }
  }
  const flags: AnalyzeFlag[] = []
  for (const item of packages) {
    if (item.commonjs && item.rawBytes >= COMMONJS_FLAG_BYTES) {
      flags.push({
        kind: 'full-package',
        message: `${item.name} is CommonJS and ships whole: ${formatBytes(item.rawBytes)} raw that tree-shaking cannot trim`,
      })
    } else if (rootImported.has(item.name) && item.modules >= BARREL_FLAG_MODULES) {
      flags.push({
        kind: 'full-package',
        message: `${item.name} is imported from its root and pulls ${item.modules} modules (${formatBytes(item.rawBytes)} raw); import the subpaths you use`,
      })
    }
  }
  return flags
}

// Packages bundled into more than one chunk (downloaded again per route) or installed twice.
function appFlags(ctx: AnalyzeContext, routes: RouteFiles[]): AnalyzeFlag[] {
  const graph = ctx.graph
  if (!graph) return []
  const chunkRoutes = new Map<string, Set<string>>()
  for (const files of routes) {
    for (const file of routeJsFiles(files)) {
      const set = chunkRoutes.get(file) ?? new Set<string>()
      set.add(publicRoutePath(files.route.route))
      chunkRoutes.set(file, set)
    }
  }
  const moduleChunks = new Map<string, string[]>()
  const roots = new Map<string, Map<string, string>>()
  for (const [file, chunk] of Object.entries(graph.chunks)) {
    if (!chunkRoutes.has(file)) continue
    for (const id of Object.keys(chunk.inputs)) {
      moduleChunks.set(id, [...(moduleChunks.get(id) ?? []), file])
      const module = graph.modules[id]
      if (!module?.root || module.package.startsWith('(')) continue
      const copies = roots.get(module.package) ?? new Map<string, string>()
      copies.set(module.root, file)
      roots.set(module.package, copies)
    }
  }
  const duplicated = new Map<string, { bytes: number; chunks: Set<string> }>()
  for (const [id, chunks] of moduleChunks) {
    if (chunks.length < 2) continue
    const name = graph.modules[id]?.package ?? '(unknown)'
    const item = duplicated.get(name) ?? { bytes: 0, chunks: new Set<string>() }
    const bytes = chunks.map(file => graph.chunks[file]?.inputs[id] ?? 0)
    item.bytes += bytes.reduce((sum, value) => sum + value, 0) - Math.max(...bytes)
    for (const file of chunks) item.chunks.add(file)
    duplicated.set(name, item)
  }
  const flags: AnalyzeFlag[] = []
  for (const [name, item] of [...duplicated].sort((a, b) => b[1].bytes - a[1].bytes)) {
    if (item.bytes < DUPLICATE_FLAG_BYTES) continue
    const where = [...item.chunks]
      .map(file => `${file} (${[...(chunkRoutes.get(file) ?? [])].join(', ')})`)
      .join('; ')
    flags.push({
      kind: 'duplicate',
      message: `${name} is bundled into ${item.chunks.size} chunks, ${formatBytes(item.bytes)} raw duplicated: ${where}`,
      files: [...item.chunks],
    })
  }
  for (const [name, copies] of roots) {
    if (copies.size < 2) continue
    flags.push({
      kind: 'duplicate',
      message: `${name} ships ${copies.size} installed copies: ${[...copies.keys()].join(', ')}`,
      files: [...new Set(copies.values())],
    })
  }
  return flags
}

// CSS

interface CssRule {
  selector: string
  body: string
  /** Enclosing at-rule preludes, outermost first. */
  context: string[]
}

// Enough of a CSS tokenizer for built stylesheets: strings and comments are skipped, and a nested
// style rule stays part of its top-level rule (Tailwind v4 nests variants: `.hover\:x{&:hover{…}}`).
function parseCss(css: string): CssRule[] {
  const rules: CssRule[] = []
  const stack: { prelude: string; start: number; style: boolean; nested: boolean }[] = []
  let start = 0
  for (let index = 0; index < css.length; index += 1) {
    const char = css[index]
    if (char === '/' && css[index + 1] === '*') {
      const end = css.indexOf('*/', index + 2)
      if (end === -1) break
      index = end + 1
      if (!stack.some(frame => frame.style)) start = index + 1
    } else if (char === '"' || char === "'") {
      let end = index + 1
      while (end < css.length && css[end] !== char) end += css[end] === '\\' ? 2 : 1
      index = end
    } else if (char === '{') {
      const prelude = css.slice(start, index).trim()
      const nested = stack.some(frame => frame.style)
      const style = nested || !prelude.startsWith('@') || prelude.startsWith('@font-face')
      stack.push({ prelude, start: index + 1, style, nested })
      start = index + 1
    } else if (char === '}') {
      const frame = stack.pop()
      if (frame?.style && !frame.nested) {
        rules.push({
          selector: frame.prelude,
          body: css.slice(frame.start, index),
          context: stack.map(item => item.prelude),
        })
      }
      start = index + 1
    } else if (char === ';' && !stack.some(frame => frame.style)) {
      start = index + 1
    }
  }
  return rules
}

function declarations(body: string) {
  const items: [string, string][] = []
  let depth = 0
  let start = 0
  for (let index = 0; index <= body.length; index += 1) {
    const char = body[index]
    if (char === '{' || char === '(') depth += 1
    else if (char === '}' || char === ')') depth -= 1
    else if ((char === ';' || char === undefined) && depth <= 0) {
      const text = body.slice(start, index)
      const colon = text.indexOf(':')
      const property = text.slice(0, colon).trim()
      if (colon > 0 && !/[{}]/.test(property)) {
        items.push([property.toLowerCase(), text.slice(colon + 1).trim()])
      }
      start = index + 1
    }
  }
  return items
}

function selectorList(selector: string) {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index]
    if (char === '\\') index += 1
    else if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth -= 1
    else if (char === ',' && depth === 0) {
      parts.push(selector.slice(start, index))
      start = index + 1
    }
  }
  parts.push(selector.slice(start))
  return parts.map(part => part.trim()).filter(Boolean)
}

function selectorClasses(selector: string) {
  return [...selector.matchAll(/\.((?:\\[0-9a-fA-F]{1,6}\s?|\\.|[\w-])+)/g)].map(match =>
    unescapeCss(match[1]!),
  )
}

function unescapeCss(value: string) {
  return value
    .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/\\(.)/g, '$1')
}

// A selector applies when the route mentions every class it names; element and attribute
// selectors are assumed to apply.
function selectorApplies(selector: string, tokens: Set<string>) {
  return selectorList(selector).some(part => selectorClasses(part).every(name => tokens.has(name)))
}

function isUtilityLayer(context: string[]) {
  return context.some(prelude => /^@layer\s+utilities\b/.test(prelude))
}

// The class of every utility rule. Tailwind v4 keeps `@layer utilities`; without it, a
// single-class rule counts as a utility.
function utilityRules(rules: CssRule[]) {
  const layered = rules.some(rule => isUtilityLayer(rule.context))
  const names: string[] = []
  for (const rule of rules) {
    if (rule.selector.startsWith('@')) continue
    if (layered ? !isUtilityLayer(rule.context) : !/^\.[^\s,>+~]+$/.test(rule.selector)) continue
    const name = selectorClasses(rule.selector)[0]
    if (name) names.push(name)
  }
  return names
}

// Every class-name-shaped token in a file: HTML class attributes, JS string literals, source.
// Strings split on whitespace and quotes keep `data-[state=open]:x` whole; the punctuation split
// recovers classes from unquoted contexts.
function classTokens(text: string) {
  const tokens = new Set<string>()
  for (const token of text.split(/[\s"'`\\]+/)) {
    if (!token) continue
    tokens.add(token)
    if (/[<>{}=,;()]/.test(token)) {
      for (const part of token.split(/[<>{}=,;()]+/)) if (part) tokens.add(part)
    }
  }
  return tokens
}

async function routeTokens(ctx: AnalyzeContext, files: RouteFiles) {
  const sources = [
    ...(files.html ? [files.html] : []),
    ...routeJsFiles(files),
    ...files.route.sourceFiles.filter(file => existsSync(file)),
  ]
  const tokens = new Set<string>()
  for (const set of await Promise.all(sources.map(file => ctx.tokens(file)))) {
    for (const token of set) tokens.add(token)
  }
  return tokens
}

async function routeCss(ctx: AnalyzeContext, files: RouteFiles, tokens: Set<string>) {
  const global = globalCssFile(ctx)
  const css: AnalyzeCssFile[] = []
  for (const file of files.initial) {
    if (!file.endsWith('.css')) continue
    const rules = await ctx.css(file)
    const utilities = utilityRules(rules)
    css.push({
      ...(await ctx.size(file)),
      kind: file === global ? 'global' : 'route',
      rules: rules.filter(rule => !rule.selector.startsWith('@')).length,
      utilities: utilities.length,
      usedUtilities: utilities.filter(name => tokens.has(name)).length,
    })
  }
  return css
}

// Tailwind sources

interface TailwindAttribution {
  sources: { source: string; kind: 'auto' | '@source'; files: number; classes: Set<string> }[]
  utilities: Set<string>
}

interface SourceTarget {
  base: string
  glob?: string
}

const TAILWIND_SCAN_EXTENSIONS = new Set([
  '.astro',
  '.cjs',
  '.cts',
  '.html',
  '.js',
  '.jsx',
  '.md',
  '.mdx',
  '.mjs',
  '.mts',
  '.svelte',
  '.ts',
  '.tsx',
  '.vue',
])
const TAILWIND_SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'out'])
const TAILWIND_MAX_FILES = 20_000

// Which scanned sources produce the global stylesheet's utilities: the automatic app-root scan
// plus every `@source`, read from the stylesheets the build recorded, matched class by class.
async function tailwindAttribution(ctx: AnalyzeContext): Promise<TailwindAttribution | undefined> {
  const entries = (ctx.sizes?.globalCss ?? []).map(file => path.resolve(ctx.appRoot, file))
  const directives = tailwindDirectives(entries, ctx.appRoot)
  const global = globalCssFile(ctx)
  if (!directives.tailwind || !ctx.exists.has(global)) return undefined
  const utilities = new Set(utilityRules(await ctx.css(global)))
  const targets = [
    ...(directives.auto ? [{ kind: 'auto' as const, target: directives.auto }] : []),
    ...directives.sources.map(target => ({ kind: '@source' as const, target })),
  ]
  const ignored = gitignoredNames(ctx.appRoot)
  ignored.add(path.basename(path.dirname(ctx.outPath)))
  const sources: TailwindAttribution['sources'] = []
  for (const { kind, target } of targets) {
    const scanned = await scanSourceFiles(target, directives.excluded, ignored)
    const classes = new Set<string>()
    for (const file of scanned) {
      for (const token of await ctx.tokens(file)) if (utilities.has(token)) classes.add(token)
    }
    const source = toPosix(path.relative(ctx.appRoot, target.base)) || '.'
    sources.push({
      source: target.glob ? `${source}/${target.glob}` : source,
      kind,
      files: scanned.length,
      classes,
    })
  }
  return { sources, utilities }
}

function tailwindSummary(
  attribution: TailwindAttribution,
  tokens: Set<string>,
): AnalyzeTailwindSource[] {
  const counts = new Map<string, number>()
  for (const source of attribution.sources) {
    for (const name of source.classes) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const used = (names: Iterable<string>) => [...names].filter(name => tokens.has(name)).length
  const rows: AnalyzeTailwindSource[] = attribution.sources.map(source => ({
    source: source.source,
    kind: source.kind,
    files: source.files,
    utilities: source.classes.size,
    only: [...source.classes].filter(name => counts.get(name) === 1).length,
    used: used(source.classes),
  }))
  const unattributed = [...attribution.utilities].filter(name => !counts.has(name))
  if (unattributed.length > 0) {
    rows.push({
      source: '(no scanned file)',
      kind: 'unattributed',
      files: 0,
      utilities: unattributed.length,
      only: unattributed.length,
      used: used(unattributed),
    })
  }
  return rows
}

// pnext hands Tailwind the app root as its scan base; `@import "tailwindcss" source(…)` moves it.
function tailwindDirectives(entries: string[], appRoot: string) {
  let tailwind = false
  let autoBase: string | undefined = appRoot
  const sources: SourceTarget[] = []
  const excluded: string[] = []
  const seen = new Set<string>()
  const visit = (file: string, depth: number) => {
    if (seen.has(file) || depth > 4 || !existsSync(file)) return
    seen.add(file)
    const css = readFileSync(file, 'utf8')
    const dir = path.dirname(file)
    for (const match of css.matchAll(/@import\s+(['"])([^'"]+)\1([^;]*);/g)) {
      const specifier = match[2]!
      if (specifier === 'tailwindcss') {
        tailwind = true
        const source = /source\(\s*(?:none|(['"])([^'"]+)\1)\s*\)/.exec(match[3] ?? '')
        if (source) autoBase = source[2] ? path.resolve(dir, source[2]) : undefined
      } else {
        const resolved = resolveCssImport(specifier, dir)
        if (resolved) visit(resolved, depth + 1)
      }
    }
    if (/@tailwind\s+utilities/.test(css)) tailwind = true
    for (const match of css.matchAll(/@source\s+(not\s+)?(['"])([^'"]+)\2/g)) {
      const target = sourceTarget(path.resolve(dir, match[3]!))
      if (match[1]) excluded.push(target.base)
      else sources.push(target)
    }
  }
  for (const entry of entries) visit(entry, 0)
  const auto: SourceTarget | undefined = autoBase ? { base: autoBase } : undefined
  return { tailwind, auto, sources, excluded }
}

// Relative imports and package stylesheets (`@import '@acme/ui/globals.css'`); URLs are skipped.
function resolveCssImport(specifier: string, dir: string) {
  if (/^(?:[a-z]+:|\/\/)/i.test(specifier)) return undefined
  if (specifier.startsWith('.') || path.isAbsolute(specifier)) return path.resolve(dir, specifier)
  try {
    const resolved = Bun.resolveSync(specifier, dir)
    return resolved.endsWith('.css') ? resolved : undefined
  } catch {
    return undefined
  }
}

function sourceTarget(resolved: string): SourceTarget {
  const segments = resolved.split(path.sep)
  const globAt = segments.findIndex(segment => /[*{?[]/.test(segment))
  if (globAt === -1) return { base: resolved }
  return {
    base: segments.slice(0, globAt).join(path.sep) || path.sep,
    glob: segments.slice(globAt).join('/'),
  }
}

function gitignoredNames(root: string) {
  const names = new Set<string>()
  const file = path.join(root, '.gitignore')
  if (!existsSync(file)) return names
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const name = line.trim().replace(/^\/|\/$/g, '')
    if (name && !name.startsWith('#') && !/[*?[!/]/.test(name)) names.add(name)
  }
  return names
}

async function scanSourceFiles(target: SourceTarget, excluded: string[], ignored: Set<string>) {
  const glob = target.glob ? new Bun.Glob(target.glob) : undefined
  const accept = (file: string) =>
    TAILWIND_SCAN_EXTENSIONS.has(path.extname(file)) &&
    (!glob || glob.match(toPosix(path.relative(target.base, file))))
  if (!existsSync(target.base)) return []
  if (!statSync(target.base).isDirectory()) return accept(target.base) ? [target.base] : []
  const files: string[] = []
  const walk = async (dir: string) => {
    if (files.length >= TAILWIND_MAX_FILES || excluded.includes(dir)) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || TAILWIND_SKIP_DIRS.has(entry.name)) continue
        if (!ignored.has(entry.name)) await walk(full)
      } else if (entry.isFile() && accept(full) && files.length < TAILWIND_MAX_FILES) {
        files.push(full)
      }
    }
  }
  await walk(target.base)
  return files
}

// Fonts

async function routeFonts(ctx: AnalyzeContext, files: RouteFiles, tokens: Set<string>) {
  const rules: CssRule[] = []
  const faces: { family: string; weight?: string; style?: string; urls: string[] }[] = []
  for (const file of files.initial) {
    if (!file.endsWith('.css')) continue
    for (const rule of await ctx.css(file)) {
      rules.push(rule)
      if (rule.selector !== '@font-face') continue
      const values = new Map(declarations(rule.body))
      const family = unquote(values.get('font-family') ?? '')
      if (!family) continue
      const urls = [...(values.get('src') ?? '').matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)]
        .map(match => resolveAssetUrl(ctx, match[2]!, path.posix.dirname(file)))
        .filter((item): item is string => Boolean(item))
      const weight = values.get('font-weight')
      const style = values.get('font-style')
      faces.push({ family, ...(weight ? { weight } : {}), ...(style ? { style } : {}), urls })
    }
  }
  const preloads = routeFontPreloads(ctx, files)
  const usage = fontUsage(rules, tokens)
  const fileSize = (file: string) => ({
    path: file,
    rawBytes: statSync(path.join(ctx.publicPath, file)).size,
  })
  const fonts: AnalyzeFont[] = faces.map(face => ({
    family: face.family,
    ...(face.weight ? { weight: face.weight } : {}),
    ...(face.style ? { style: face.style } : {}),
    files: [...new Set(face.urls)].map(fileSize),
    preloaded: face.urls.some(file => preloads.has(file)),
    used: usage(face.family),
  }))
  const faceFiles = new Set(faces.flatMap(face => face.urls))
  for (const file of preloads) {
    if (faceFiles.has(file)) continue
    fonts.push({
      family: '(no @font-face on this route)',
      files: [fileSize(file)],
      preloaded: true,
      used: false,
    })
  }
  return fonts
}

// Preloads travel in the document (`<link rel=preload as=font>`) or, for next/font, the Link header.
function routeFontPreloads(ctx: AnalyzeContext, files: RouteFiles) {
  const urls: string[] = []
  const headers = [
    files.route.linkHeader,
    ...(files.html ? (ctx.manifest?.staticFiles?.[files.html]?.headers ?? []) : [])
      .filter(([name]) => name.toLowerCase() === 'link')
      .map(([, value]) => value),
  ]
  for (const header of headers) {
    for (const match of (header ?? '').matchAll(/<([^>]+)>([^,]*)/g)) {
      const params = match[2]!
      if (/\bas=["']?font\b/i.test(params) && /\brel=["']?preload\b/i.test(params)) {
        urls.push(match[1]!)
      }
    }
  }
  const html = files.html ? readFileSync(path.join(ctx.publicPath, files.html), 'utf8') : ''
  for (const [tag] of html.matchAll(/<link\b[^>]*>/g)) {
    if (!/\brel=["']?preload\b/i.test(tag) || !/\bas=["']?font\b/i.test(tag)) continue
    const href = /\bhref=["']([^"']+)["']/.exec(tag)?.[1]
    if (href) urls.push(href)
  }
  return new Set(
    urls.map(url => resolveAssetUrl(ctx, url, '')).filter((item): item is string => Boolean(item)),
  )
}

// Built URLs are relative to their stylesheet, or absolute behind a basePath or CDN assetPrefix.
function resolveAssetUrl(ctx: AnalyzeContext, url: string, fromDir: string) {
  if (url.startsWith('data:')) return undefined
  const clean = url.replace(/[?#].*$/, '')
  if (!/^(?:[a-z]+:)?\/\//i.test(clean) && !clean.startsWith('/')) {
    const relative = path.posix.normalize(path.posix.join(fromDir, clean))
    if (ctx.exists.has(relative)) return relative
  }
  const segments = clean
    .replace(/^(?:[a-z]+:)?\/\/[^/]+/i, '')
    .split('/')
    .filter(Boolean)
  for (let index = 0; index < segments.length; index += 1) {
    const candidate = segments.slice(index).join('/')
    if (ctx.exists.has(candidate)) return candidate
  }
  return undefined
}

function unquote(value: string) {
  return value.trim().replace(/^(['"])(.*)\1$/, '$2')
}

// A family is used when an applying rule names it, directly or through a custom property chain
// (Tailwind's `--font-sans` → `--default-font-family` → `html { font-family }`).
function fontUsage(rules: CssRule[], tokens: Set<string>) {
  const parsed = rules
    .filter(rule => rule.selector !== '@font-face')
    .map(rule => ({ rule, values: declarations(rule.body) }))
    .filter(({ values }) =>
      values.some(([property]) => property.startsWith('--') || property.includes('font')),
    )
  return (family: string) => {
    const pattern = new RegExp(`(^|[^\\w-])${escapeRegExp(family)}($|[^\\w-])`, 'i')
    const properties = new Set<string>()
    const mentions = (value: string) =>
      pattern.test(value) || [...properties].some(name => value.includes(`var(${name}`))
    let changed = true
    while (changed) {
      changed = false
      for (const { values } of parsed) {
        for (const [property, value] of values) {
          if (property.startsWith('--') && !properties.has(property) && mentions(value)) {
            properties.add(property)
            changed = true
          }
        }
      }
    }
    return parsed.some(
      ({ rule, values }) =>
        selectorApplies(rule.selector, tokens) &&
        values.some(([property, value]) => !property.startsWith('--') && mentions(value)),
    )
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Budgets

function budgetFor(budgets: Record<string, number> | undefined, route: string) {
  if (!budgets) return undefined
  return budgets[route] ?? budgets[publicRoutePath(route)] ?? budgets['*']
}

export function parseBudgets(budgets: Record<string, number | string> | undefined) {
  if (!budgets) return undefined
  const parsed: Record<string, number> = {}
  for (const [route, value] of Object.entries(budgets)) {
    const bytes = typeof value === 'number' ? value : parseByteSize(value)
    if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) {
      throw new Error(
        `Invalid budget for ${route}: ${String(value)}. Use bytes or a size like '150kb'.`,
      )
    }
    parsed[route === '/' || route === '*' ? route : route.replace(/\/+$/, '')] = bytes
  }
  return parsed
}

function parseByteSize(value: string) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|k|mb|m)?\s*$/i.exec(value)
  if (!match) return undefined
  const unit = (match[2] ?? 'b').toLowerCase()
  const scale = unit.startsWith('m') ? 1024 * 1024 : unit.startsWith('k') ? 1024 : 1
  return Math.round(Number(match[1]) * scale)
}

// Build side: what `pnext build` records for analyze and prints per route.

function readAnalyzeSizes(outPath: string) {
  return readJson<AnalyzeSizes>(analyzeSizesFile(outPath))
}

/** Module and chunk graph of the production client build, keyed by shipped file names. */
export function analyzeGraph(
  config: Pick<ResolvedConfig, 'root' | 'outPath'>,
  client: ClientBuildGraph,
  entries: Map<string, string>,
): AnalyzeGraph {
  const publicPath = path.join(config.outPath, 'static')
  const packageOf = createPackageResolver(config.root)
  const ids = new Map<string, string | undefined>()
  // esbuild keys paths relative to its working directory; ids are app-root relative.
  const id = (input: string) => {
    if (!ids.has(input)) {
      const virtual = /^[\w-]+:/.test(input) && !path.isAbsolute(input)
      ids.set(
        input,
        input.startsWith('<')
          ? undefined
          : virtual
            ? input
            : toPosix(path.relative(config.root, path.resolve(input))),
      )
    }
    return ids.get(input)
  }
  const modules: AnalyzeGraph['modules'] = {}
  for (const [input, meta] of Object.entries(client.metafile.inputs)) {
    const key = id(input)
    if (!key) continue
    const imports: AnalyzeGraphModule['imports'] = []
    for (const item of meta.imports) {
      if (item.external || item.kind === 'import-rule' || item.kind === 'url-token') continue
      const target = id(item.path)
      if (!target || target === key) continue
      const dynamic = item.kind === 'dynamic-import' ? 1 : 0
      const bare = item.original && !/^[./]/.test(item.original) && !path.isAbsolute(item.original)
      imports.push(bare ? [target, dynamic, item.original] : [target, dynamic])
    }
    modules[key] = {
      ...packageOf(input, key),
      ...(meta.format === 'cjs' ? { commonjs: true as const } : {}),
      imports,
    }
  }
  const chunks: AnalyzeGraph['chunks'] = {}
  for (const [output, meta] of Object.entries(client.metafile.outputs)) {
    if (!output.endsWith('.js')) continue
    const relative = toPosix(path.relative(publicPath, path.resolve(output)))
    const basename = path.posix.basename(relative)
    const shipped =
      entries.get(basename) ??
      path.posix.join(path.posix.dirname(relative), client.renames.get(basename) ?? basename)
    const inputs: Record<string, number> = {}
    for (const [input, { bytesInOutput }] of Object.entries(meta.inputs)) {
      const key = id(input)
      if (key && bytesInOutput > 0) inputs[key] = (inputs[key] ?? 0) + bytesInOutput
    }
    const entry = meta.entryPoint ? id(meta.entryPoint) : undefined
    chunks[shipped] = { ...(entry ? { entry } : {}), inputs }
  }
  return { version: 1, chunks, modules }
}

function createPackageResolver(root: string) {
  const appRoot = path.resolve(root)
  const dirs = new Map<string, { name: string; dir: string } | undefined>()
  const nearest = (dir: string): { name: string; dir: string } | undefined => {
    if (!dirs.has(dir)) {
      const name = readJson<{ name?: string }>(path.join(dir, 'package.json'))?.name
      const parent = path.dirname(dir)
      dirs.set(dir, name ? { name, dir } : parent === dir ? undefined : nearest(parent))
    }
    return dirs.get(dir)
  }
  return (input: string, key: string): Pick<AnalyzeGraphModule, 'package' | 'root'> => {
    // Generated modules have no install location, so they never count as a package copy.
    if (/^[\w-]+:/.test(input) && !path.isAbsolute(input)) {
      return { package: input.startsWith('pnext') ? FRAMEWORK_PACKAGE : '(virtual)', root: '' }
    }
    const nodeModules = key.lastIndexOf('node_modules/')
    if (nodeModules !== -1) {
      const rest = key.slice(nodeModules + 'node_modules/'.length).split('/')
      const name = rest[0]?.startsWith('@') ? `${rest[0]}/${rest[1] ?? ''}` : (rest[0] ?? '')
      return { package: name, root: `${key.slice(0, nodeModules)}node_modules/${name}` }
    }
    const file = path.resolve(input)
    const found = nearest(path.dirname(file))
    // Inside the app, only a package nested under its root is not the app itself.
    const nested = found && found.dir !== appRoot && isInside(appRoot, found.dir)
    if (isInside(appRoot, file) && !nested) return { package: '(app)', root: '.' }
    if (!found) return { package: '(unknown)', root: '' }
    return { package: found.name, root: toPosix(path.relative(appRoot, found.dir)) }
  }
}

function isInside(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return !relative.startsWith('..') && !path.isAbsolute(relative)
}

export async function writeAnalyzeGraph(outPath: string, graph: AnalyzeGraph) {
  await mkdir(path.join(outCachePath(outPath), ANALYZE_DIR), { recursive: true })
  await writeFile(path.join(outCachePath(outPath), ANALYZE_DIR, GRAPH_FILE), JSON.stringify(graph))
}

export interface RouteSizeRow {
  route: string
  compressedBytes: number
  budget?: number
  previousBytes?: number
}

/** Per-route initial gzip weight, recorded for analyze's budget and diff views. */
export async function recordRouteSizes(
  config: ResolvedConfig,
  manifest: BuildManifest,
  graph: AnalyzeGraph | undefined,
  previous: AnalyzeSizes | undefined,
  globalCss: string[],
): Promise<RouteSizeRow[]> {
  const publicPath = path.join(config.outPath, 'static')
  const budgets = parseBudgets(config.budgets)
  const ctx = createContext({
    outPath: config.outPath,
    publicPath,
    appRoot: config.root,
    files: (await listFiles(publicPath)).map(file => toPosix(path.relative(publicPath, file))),
    compression: 'gzip',
    manifest,
    ...(graph ? { graph } : {}),
  })
  const pages = manifest.routes.filter(route => route.kind === 'page')
  const measured = await Promise.all(
    pages.map(async (route): Promise<[string, AnalyzeRouteSize]> => {
      const files = await collectRouteFiles(ctx, route)
      const packages: Record<string, number> = {}
      for (const [id, bytes] of routeModules(ctx, files.initial)) {
        const name = graph?.modules[id]?.package ?? '(unknown)'
        packages[name] = (packages[name] ?? 0) + bytes
      }
      const size = sumSizes(await Promise.all(files.initial.map(file => ctx.size(file))))
      return [route.route, { ...size, packages }]
    }),
  )
  const record: AnalyzeSizes = {
    version: 1,
    ...(budgets ? { budgets } : {}),
    globalCss: globalCss.map(file => toPosix(path.relative(config.root, file))),
    routes: Object.fromEntries(measured),
    ...(previous ? { previous: previous.routes } : {}),
  }
  await mkdir(path.join(outCachePath(config.outPath), ANALYZE_DIR), { recursive: true })
  const rows = sizeRows(record)
  // The build summary reads these back on a cache hit without loading this module.
  await writeFile(analyzeSizesFile(config.outPath), JSON.stringify({ ...record, rows }))
  return rows
}

function sizeRows(sizes: AnalyzeSizes | undefined): RouteSizeRow[] {
  if (!sizes) return []
  return Object.entries(sizes.routes).map(([route, size]) => {
    const budget = budgetFor(sizes.budgets, route)
    const before = sizes.previous?.[route]
    return {
      route: publicRoutePath(route),
      compressedBytes: size.compressedBytes,
      ...(budget !== undefined ? { budget } : {}),
      ...(before ? { previousBytes: before.compressedBytes } : {}),
    }
  })
}

// Output

const gzip = promisify(zlib.gzip)
const brotli = promisify(zlib.brotliCompress)

async function compressedSize(bytes: Buffer, compression: AnalyzeCompression) {
  if (compression === 'brotli') {
    return (await brotli(bytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } })).length
  }
  return (await gzip(bytes, { level: 9 })).length
}

function fileType(file: string): 'html' | 'css' | 'js' | 'asset' {
  if (file.endsWith('.html')) return 'html'
  if (file.endsWith('.css')) return 'css'
  if (file.endsWith('.js')) return 'js'
  return 'asset'
}

function toPosix(value: string) {
  return value.split(path.sep).join('/')
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

function frameworkPackageName() {
  const file = path.resolve(import.meta.dirname, '../../package.json')
  return readJson<{ name?: string }>(file)?.name ?? '@wular/pnext'
}

export function printAnalyzeResult(
  result: AnalyzeResult,
  options: { route?: string; files: boolean; why?: string },
) {
  console.log(`PNext analyze: production build at ${dim(result.root)} (${result.compression})`)
  if (options.why) {
    printWhy(result, options.why)
    return
  }
  printRouteBundles(result, Boolean(options.route))
  printFlags(result.flags, '')
  // With a route filter, the remaining files are mostly other routes' bundles —
  // listing them as "other" would misread as unowned weight.
  if (options.route) return
  printAnalyzeFiles(result, { details: options.files })
  const heaviest = [...result.routeBundles].sort(
    (a, b) => b.initialSize.compressedBytes - a.initialSize.compressedBytes,
  )[0]
  if (heaviest) {
    const command = `pnext analyze ${publicRoutePath(heaviest.route)}`
    console.log(`Inspect a route: ${cyan(command)} ${dim('(packages, CSS, fonts, flags)')}`)
  }
}

function printWhy(result: AnalyzeResult, target: string) {
  const chains = result.why ?? []
  console.log('')
  if (chains.length === 0) {
    console.log(`No route loads ${target}.`)
    return
  }
  for (const item of chains) {
    const dynamic = item.dynamic ? dim('  (behind a dynamic import)') : ''
    console.log(`${item.chain.join(dim(' <- '))}${dynamic}`)
    if (item.importers.length > 1) {
      console.log(dim(`  imported directly by ${item.importers.join(', ')}`))
    }
  }
}

function printRouteBundles(result: AnalyzeResult, details: boolean) {
  if (result.routeBundles.length === 0) return

  console.log(`\n${bold('Routes')}`)
  for (const bundle of result.routeBundles) {
    console.log(`\n${cyan(bundle.route)} ${dim(`(${bundle.page} page)`)}`)
    console.log(`  ${routeSizeLine(bundle, result.compression)}`)
    printBundleGroup('initial', bundle.initial, result.compression)
    printDynamicBundleGroup('visible dynamic', bundle.visibleDynamic, result.compression)
    printDynamicBundleGroup('dynamic', bundle.dynamic, result.compression)
    printBundleGroup('shared after dynamic', bundle.lazyShared, result.compression)
    if (details) {
      printDiff(bundle)
      printChunks(bundle)
      printPackages(bundle)
      if (bundle.chunks.length === 0 && bundle.initial.some(file => file.path.endsWith('.js'))) {
        console.log(dim('\n  Chunk contents and packages need a build from this pnext version.'))
      }
      printCss(bundle, result.compression)
      printFonts(bundle)
    }
    printFlags(bundle.flags, '  ')
  }
  console.log('')
}

function routeSizeLine(bundle: AnalyzeRouteBundle, compression: AnalyzeCompression) {
  const parts = [`initial ${formatBytes(bundle.initialSize.compressedBytes)} ${compression}`]
  if (bundle.budget !== undefined) {
    const budget = `${formatBytes(bundle.budget)} budget`
    parts.push(
      bundle.flags.some(flag => flag.kind === 'budget') ? yellow(`over ${budget}`) : budget,
    )
  }
  if (bundle.diff) {
    const delta = bundle.diff.compressedBytes - bundle.diff.previousBytes
    parts.push(
      delta === 0 ? 'same as previous build' : `${formatDelta(delta)} gzip since previous build`,
    )
  }
  return parts.join(dim(' · '))
}

function printDiff(bundle: AnalyzeRouteBundle) {
  const changes = bundle.diff?.packages.slice(0, 8) ?? []
  if (changes.length === 0) return
  console.log(`\n  ${bold('Changed since previous build')} ${dim('(raw initial JS)')}`)
  const width = Math.max(...changes.map(item => item.name.length))
  for (const item of changes) {
    const note = item.previousBytes === 0 ? 'added' : item.rawBytes === 0 ? 'removed' : ''
    const delta = formatDelta(item.rawBytes - item.previousBytes).padStart(9)
    console.log(`    ${item.name.padEnd(width)}  ${delta}  ${dim(note)}`)
  }
}

function printChunks(bundle: AnalyzeRouteBundle) {
  const chunks = bundle.chunks
  if (chunks.length === 0) return
  console.log(`\n  ${bold('Chunks by content')}`)
  const width = Math.max(...chunks.map(chunk => chunk.path.length))
  for (const chunk of chunks) {
    const named = chunk.misnamed ? yellow(`  (named for ${chunk.misnamed})`) : ''
    const size = formatBytes(chunk.compressedBytes).padStart(8)
    const load = dim(chunk.load.padEnd(7))
    console.log(`    ${load}  ${dim(chunk.path.padEnd(width))}  ${size}  ${chunk.label}${named}`)
  }
}

function printPackages(bundle: AnalyzeRouteBundle) {
  const packages = bundle.packages.slice(0, 15)
  if (packages.length === 0) return
  console.log(`\n  ${bold('Packages in initial JS')} ${dim('(share of gzip)')}`)
  const width = Math.max(...packages.map(item => item.name.length))
  for (const item of packages) {
    const modules = `${item.modules} module${item.modules === 1 ? '' : 's'}`
    const via = item.via.length > 0 ? `via ${item.via.slice(0, 3).join(' <- ')}` : ''
    const notes = [item.commonjs ? 'CommonJS' : '', via].filter(Boolean).join('  ')
    const size = formatBytes(item.compressedBytes).padStart(8)
    console.log(
      `    ${item.name.padEnd(width)}  ${size}  ${dim(modules.padEnd(11))}  ${dim(notes)}`,
    )
  }
  if (bundle.packages.length > packages.length) {
    console.log(dim(`    … ${bundle.packages.length - packages.length} more in --json`))
  }
}

function printCss(bundle: AnalyzeRouteBundle, compression: AnalyzeCompression) {
  if (bundle.css.length === 0) return
  console.log(`\n  ${bold('CSS')}`)
  const width = Math.max(...bundle.css.map(file => file.path.length))
  for (const file of bundle.css) {
    const share = formatShare(file.usedUtilities / (file.utilities || 1))
    const usage =
      file.utilities > 0
        ? `${file.utilities} utilities, route uses ${file.usedUtilities} (${share})`
        : ''
    const size = `${formatBytes(file.compressedBytes)} ${compression}`
    const rules = dim(`${file.rules} rules`)
    console.log(
      `    ${file.kind.padEnd(6)}  ${dim(file.path.padEnd(width))}  ${size}  ${rules}  ${usage}`,
    )
  }
  const sources = bundle.tailwind ?? []
  if (sources.length === 0) return
  console.log(`\n  ${bold('Tailwind sources')} ${dim('(global CSS utilities each one produces)')}`)
  const sourceWidth = Math.max(...sources.map(item => item.source.length))
  for (const item of sources) {
    const files =
      item.kind === 'unattributed' ? '' : `${item.files} file${item.files === 1 ? '' : 's'}`
    const counts = `${pad(item.utilities)} utilities  ${pad(item.only)} only here  ${pad(item.used)} used`
    const kind = dim(item.kind.padEnd(12))
    console.log(
      `    ${item.source.padEnd(sourceWidth)}  ${kind}  ${dim(files.padEnd(11))}  ${counts}`,
    )
  }
}

function pad(value: number) {
  return String(value).padStart(5)
}

function printFonts(bundle: AnalyzeRouteBundle) {
  if (bundle.fonts.length === 0) return
  console.log(`\n  ${bold('Fonts')}`)
  const labels = bundle.fonts.map(font =>
    [font.family, font.weight, font.style].filter(Boolean).join(' '),
  )
  const width = Math.max(...labels.map(label => label.length))
  bundle.fonts.forEach((font, index) => {
    const size = formatBytes(font.files.reduce((total, file) => total + file.rawBytes, 0))
    const state = [font.preloaded ? 'preloaded' : '', font.used ? 'used' : 'unused']
      .filter(Boolean)
      .join(', ')
    const status = font.preloaded && !font.used ? yellow(state) : dim(state)
    const files = dim(font.files.map(file => file.path).join(', '))
    console.log(`    ${labels[index]!.padEnd(width)}  ${size.padStart(8)}  ${status}  ${files}`)
  })
}

function printFlags(flags: AnalyzeFlag[], indent: string) {
  if (flags.length === 0) return
  console.log(`\n${indent}${bold('Flags')}`)
  for (const flag of flags) console.log(`${indent}  ${yellow('!')} ${flag.message}`)
  if (!indent) console.log('')
}

function printBundleGroup(
  label: string,
  files: AnalyzeResult['routeBundles'][number]['initial'],
  compression: AnalyzeCompression,
) {
  if (files.length === 0) return
  console.log(`\n  ${bold(label.padEnd(22))} ${formatTotalSize(files, compression)}`)
  printBundleFiles(files, compression, '    ', rowColumns(files))
}

function printDynamicBundleGroup(
  label: string,
  files: AnalyzeResult['routeBundles'][number]['visibleDynamic'],
  compression: AnalyzeCompression,
) {
  if (files.length === 0) return
  console.log(`\n  ${bold(label)}`)
  const columns = rowColumns(files)
  const componentWidth = Math.max(...files.map(file => file.component.length))
  const pathWidth = Math.max(...files.map(file => file.path.length))
  for (const file of files) {
    console.log(
      `    ${file.component.padEnd(componentWidth)}  ${dim(file.path.padEnd(pathWidth))}  ${formatFileSize(file, compression, columns)}`,
    )
  }
}

function formatTotalSize(
  files: { rawBytes: number; compressedBytes: number }[],
  compression: AnalyzeCompression,
) {
  const rawBytes = files.reduce((total, file) => total + file.rawBytes, 0)
  const compressedBytes = files.reduce((total, file) => total + file.compressedBytes, 0)
  return `${formatBytes(compressedBytes)} ${compression}  ${dim(`${formatBytes(rawBytes)} raw`)}`
}

function printAnalyzeFiles(result: AnalyzeResult, options: { details: boolean }) {
  const routeFiles = new Set(
    result.routeBundles.flatMap(bundle => [
      ...bundle.initial.map(file => file.path),
      ...bundle.visibleDynamic.map(file => file.path),
      ...bundle.dynamic.map(file => file.path),
      ...bundle.lazyShared.map(file => file.path),
    ]),
  )
  const sorted = sortedAnalyzeFiles(result.files).filter(file => !routeFiles.has(file.path))
  if (sorted.length === 0) return

  if (!options.details) {
    console.log(
      `Other files: ${formatFileCount(sorted)}  ${formatTotalSize(sorted, result.compression)}`,
    )
    console.log('List them: pnext analyze --files')
    return
  }

  console.log(`${bold('Other files')}\n`)
  for (const type of ['html', 'css', 'js', 'asset'] as const) {
    const files = sorted.filter(file => file.type === type)
    if (files.length === 0) continue
    console.log(bold(type))
    printBundleFiles(files, result.compression, '  ', rowColumns(files))
    console.log('')
  }
}

function printBundleFiles(
  files: { path: string; rawBytes: number; compressedBytes: number }[],
  compression: AnalyzeCompression,
  indent: string,
  columns: RowColumns,
) {
  const pathWidth = Math.max(...files.map(file => file.path.length))
  for (const file of files) {
    console.log(
      `${indent}${dim(file.path.padEnd(pathWidth))}  ${formatFileSize(file, compression, columns)}`,
    )
  }
}

interface RowColumns {
  compressedWidth: number
  rawWidth: number
}

function rowColumns(files: { rawBytes: number; compressedBytes: number }[]): RowColumns {
  return {
    compressedWidth: Math.max(...files.map(file => formatBytes(file.compressedBytes).length)),
    rawWidth: Math.max(...files.map(file => formatBytes(file.rawBytes).length)),
  }
}

function formatFileSize(
  file: { rawBytes: number; compressedBytes: number },
  compression: AnalyzeCompression,
  columns: RowColumns,
) {
  const compressed = formatBytes(file.compressedBytes).padStart(columns.compressedWidth)
  const raw = `${formatBytes(file.rawBytes).padStart(columns.rawWidth)} raw`
  return `${compressed} ${compression}  ${dim(raw)}`
}

function formatFileCount(files: AnalyzeResult['files']) {
  const counts = new Map<string, number>()
  for (const file of files) counts.set(file.type, (counts.get(file.type) ?? 0) + 1)
  return [...counts].map(([type, count]) => `${count} ${pluralFileType(type, count)}`).join(', ')
}

function pluralFileType(type: string, count: number) {
  if (count === 1) return type
  if (type === 'js' || type === 'css' || type === 'html') return type
  return `${type}s`
}

function sortedAnalyzeFiles(files: AnalyzeResult['files']) {
  return [...files].sort((a, b) => {
    const typeDelta = analyzeTypeRank(a.type) - analyzeTypeRank(b.type)
    if (typeDelta) return typeDelta
    const sizeDelta = b.compressedBytes - a.compressedBytes
    if (sizeDelta) return sizeDelta
    return a.path.localeCompare(b.path)
  })
}

function analyzeTypeRank(type: AnalyzeResult['files'][number]['type']) {
  switch (type) {
    case 'html':
      return 0
    case 'css':
      return 1
    case 'js':
      return 2
    case 'asset':
      return 3
  }
}
