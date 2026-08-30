import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { loadConfig } from '../config'
import { emittedAssetName, publishEmittedAssets, routeCssAssetNames } from '../css/build'
import { matchRoute } from '../routing/routes'
import { bold, cyan, dim } from '../utils/ansi'
import { listFiles } from '../utils/fs'
import type { BuildManifest, RouteManifestEntry } from '../types'

export interface AnalyzeResult {
  root: string
  compression: AnalyzeCompression
  files: AnalyzeFile[]
  routeBundles: AnalyzeRouteBundle[]
  totals: {
    rawBytes: number
    compressedBytes: number
  }
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

export type AnalyzeCompression = 'gzip' | 'brotli'

interface AnalyzeOptions {
  compression?: AnalyzeCompression
  route?: string
}

export async function analyzeProject(
  root?: string,
  options: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  const config = await loadConfig(root)
  if (!existsSync(config.outPath)) {
    throw new Error(`No PNext output found at ${config.outPath}. Run pnext build first.`)
  }

  // Dev output is unminified, so its sizes say nothing about what ships; analyze is production-only.
  const target = analyzeTarget(config.outPath)
  if (!target) {
    throw new Error(`No production build found at ${config.outPath}. Run pnext build first.`)
  }

  const compression = options.compression ?? 'gzip'
  const files = await listFiles(target.root)
  const rows = await Promise.all(
    files.map(async file => {
      const bytes = await readFile(file)
      return {
        path: path.relative(target.root, file),
        type: fileType(file),
        rawBytes: bytes.length,
        compressedBytes: compressedSize(bytes, compression),
      }
    }),
  )
  const routeBundles = await analyzeRouteBundles(config.outPath, target.root, rows, options.route)

  return {
    root: path.relative(config.root, target.root),
    compression,
    files: rows,
    routeBundles,
    totals: rows.reduce(
      (total, row) => ({
        rawBytes: total.rawBytes + row.rawBytes,
        compressedBytes: total.compressedBytes + row.compressedBytes,
      }),
      { rawBytes: 0, compressedBytes: 0 },
    ),
  }
}

async function analyzeRouteBundles(
  outPath: string,
  publicPath: string,
  files: AnalyzeFile[],
  routeFilter?: string,
) {
  const manifestPath = path.join(outPath, 'manifest.json')
  if (!existsSync(manifestPath)) return []

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as BuildManifest
  // Resolve the logical CSS names through the build's content-hashed spellings.
  publishEmittedAssets(outPath, manifest.assetNames)
  const pages = manifest.routes.filter(route => route.kind === 'page')
  const selected: AnalyzeRouteSelection[] = routeFilter
    ? filterAnalyzeRoutes(pages, routeFilter)
    : pages.map(route => ({ route }))
  if (routeFilter && selected.length === 0) {
    throw new Error(
      `No route matches ${routeFilter}. Routes:\n  ${pages
        .map(route => publicRoutePath(route.route))
        .join('\n  ')}`,
    )
  }
  const sizes = new Map(files.map(file => [toPosix(file.path), file]))
  const contents = new Map<string, string>()

  async function js(pathname: string) {
    const normalized = toPosix(pathname)
    if (contents.has(normalized)) return contents.get(normalized) ?? ''
    const text = await readFile(path.join(publicPath, normalized), 'utf8')
    contents.set(normalized, text)
    return text
  }

  const bundles: AnalyzeRouteBundle[] = []
  for (const { route, pathname } of selected) {
    bundles.push(await analyzeRouteBundle(outPath, route, sizes, js, pathname))
  }
  return bundles
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

async function analyzeRouteBundle(
  outPath: string,
  route: RouteManifestEntry,
  sizes: Map<string, AnalyzeFile>,
  js: (path: string) => Promise<string>,
  pathname?: string,
): Promise<AnalyzeRouteBundle> {
  const initial = new Set<string>()
  addIfExists(initial, sizes, routeHtmlPath(route, pathname))
  const assetFile = (name: string) => `assets/${emittedAssetName({ outPath }, name)}`
  addIfExists(initial, sizes, assetFile('global.css'))
  for (const asset of routeCssAssetNames(route)) addIfExists(initial, sizes, assetFile(asset))
  // Every compat page loads this with a blocking <script>. The sibling
  // `_ssgManifest.js` (router-fetched, never in the document) and the
  // `polyfills-*.js` chunk (noModule: legacy browsers only) are deliberately
  // not initial weight for a modern client.
  addIfExists(initial, sizes, '_next/static/pnext/_buildManifest.js')

  if (route.clientEntry) {
    addIfExists(initial, sizes, route.clientEntry)
    // The build records the entry's chunk closure from the esbuild metafile and
    // the renderer modulepreloads exactly this set. Chunk folding hoists imports
    // out of the entry module, so walking its source alone under-reports; the
    // walk stays as a union for dev-style single-bundle entries, which never
    // populate clientEntryImports.
    for (const asset of route.clientEntryImports ?? []) addIfExists(initial, sizes, asset)
    for (const dependency of await staticDependencies(route.clientEntry, sizes, js))
      initial.add(dependency)
  }

  const visibleDynamic: AnalyzeDynamicBundleFile[] = []
  const dynamic: AnalyzeDynamicBundleFile[] = []
  const dynamicTargets = new Set<string>()
  const lazyShared = new Set<string>()

  if (route.clientEntry && sizes.has(toPosix(route.clientEntry))) {
    const entrySource = await js(route.clientEntry)
    for (const island of islandImports(entrySource, route.clientEntry)) {
      const row = sizes.get(island.path)
      if (!row) continue
      // Keyed by island id: every island's loader resolves `module.default`, so
      // matching on the export name collapses them all onto one reference.
      const reference = route.clientReferences.find(item => item.id === island.id)
      const load: AnalyzeDynamicBundleFile['load'] =
        reference?.dynamic?.load === 'visible' ? 'visible' : 'render'
      dynamicTargets.add(island.path)
      const exportName = reference?.exportName ?? 'default'
      const item: AnalyzeDynamicBundleFile = {
        path: island.path,
        id: island.id,
        component: islandComponent(exportName, reference?.file, island.path),
        exportName,
        load,
        rawBytes: row.rawBytes,
        compressedBytes: row.compressedBytes,
      }
      if (load === 'visible') visibleDynamic.push(item)
      else dynamic.push(item)

      // An island with its own CSS loads `assets/<referenceId>.css` alongside its
      // chunk (loadIslandCss); it is deferred weight, so it belongs here rather
      // than in initial.
      if (reference?.cssImports?.length) addIfExists(lazyShared, sizes, `assets/${island.id}.css`)
      for (const dependency of await staticDependencies(island.path, sizes, js)) {
        if (!initial.has(dependency) && !dynamicTargets.has(dependency)) lazyShared.add(dependency)
      }
    }

    // Same metafile closure as the renderer's low-priority preloads, unioned
    // with the entry-source walk for the same reason as the static side above.
    for (const asset of [
      ...(route.clientDynamicImports ?? []),
      ...dynamicImportPaths(entrySource, route.clientEntry),
    ]) {
      const importedPath = toPosix(asset)
      if (initial.has(importedPath) || dynamicTargets.has(importedPath)) continue
      if (sizes.has(importedPath)) lazyShared.add(importedPath)
      for (const dependency of await staticDependencies(importedPath, sizes, js)) {
        if (!initial.has(dependency) && !dynamicTargets.has(dependency)) lazyShared.add(dependency)
      }
    }
  }

  return {
    route: route.route,
    page: route.client ? 'client' : 'server',
    initial: bundleFiles([...initial], sizes),
    visibleDynamic: visibleDynamic.sort((a, b) => b.compressedBytes - a.compressedBytes),
    dynamic: dynamic.sort((a, b) => b.compressedBytes - a.compressedBytes),
    lazyShared: bundleFiles([...lazyShared], sizes),
  }
}

function islandComponent(exportName: string, file: string | undefined, chunkPath: string) {
  if (exportName !== 'default') return exportName
  const source = file ?? chunkPath.replace(/-[A-Z0-9]{8}\.js$/, '.js')
  return path.posix.basename(toPosix(source)).replace(/\.[^.]+$/, '')
}

async function staticDependencies(
  entry: string,
  sizes: Map<string, AnalyzeFile>,
  js: (path: string) => Promise<string>,
  seen = new Set<string>(),
) {
  const dependencies = new Set<string>()
  const normalized = toPosix(entry)
  if (seen.has(normalized) || !sizes.has(normalized)) return dependencies
  seen.add(normalized)

  for (const specifier of staticImports(await js(normalized))) {
    const dependency = resolveBuiltImport(normalized, specifier)
    if (!dependency || !sizes.has(dependency)) continue
    dependencies.add(dependency)
    for (const transitive of await staticDependencies(dependency, sizes, js, seen))
      dependencies.add(transitive)
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

function addIfExists(items: Set<string>, sizes: Map<string, AnalyzeFile>, pathname: string) {
  const normalized = toPosix(pathname)
  if (sizes.has(normalized)) items.add(normalized)
}

function bundleFiles(paths: string[], sizes: Map<string, AnalyzeFile>) {
  return paths
    .map(pathname => {
      const row = sizes.get(pathname)
      return row
        ? { path: pathname, rawBytes: row.rawBytes, compressedBytes: row.compressedBytes }
        : null
    })
    .filter((file): file is AnalyzeBundleFile => Boolean(file))
    .sort((a, b) => b.compressedBytes - a.compressedBytes)
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

function analyzeTarget(outPath: string) {
  // PPR shells live in `.pnext/ppr`, outside `public`: they are resumed
  // server-side and never downloaded, so they are not shipped weight.
  const publicPath = path.join(outPath, 'public')
  return existsSync(publicPath) ? { root: publicPath } : null
}

function compressedSize(bytes: Buffer, compression: AnalyzeCompression) {
  if (compression === 'brotli') {
    return zlib.brotliCompressSync(bytes, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
    }).length
  }
  return zlib.gzipSync(bytes, { level: 9 }).length
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

export function printAnalyzeResult(
  result: AnalyzeResult,
  options: { route?: string; files: boolean },
) {
  console.log(`PNext analyze: production build at ${dim(result.root)} (${result.compression})`)
  printRouteBundles(result)
  // With a route filter, the remaining files are mostly other routes' bundles —
  // listing them as "other" would misread as unowned weight.
  if (!options.route) printAnalyzeFiles(result, { details: options.files })
}

function printRouteBundles(result: AnalyzeResult) {
  if (result.routeBundles.length === 0) return

  console.log(`\n${bold('Routes')}`)
  for (const bundle of result.routeBundles) {
    console.log(`\n${cyan(bundle.route)} ${dim(`(${bundle.page} page)`)}`)
    printBundleGroup('initial', bundle.initial, result.compression)
    printDynamicBundleGroup('visible dynamic', bundle.visibleDynamic, result.compression)
    printDynamicBundleGroup('dynamic', bundle.dynamic, result.compression)
    printBundleGroup('shared after dynamic', bundle.lazyShared, result.compression)
  }
  console.log('')
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

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB'] as const
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unitIndex]}`
}
