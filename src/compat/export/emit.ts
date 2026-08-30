import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ResolvedConfig } from '../../config'
import type { BuildManifest, RouteManifestEntry } from '../../types'
import { listFiles, toPosixPath } from '../../utils/fs'
import type { BuildStepLogger } from '../../extensions'
import { getNextConfig } from '../next/config-loader'
import { emitStandalone } from './standalone'

interface EmitStaticExportContext {
  config: ResolvedConfig
  manifest: BuildManifest
  log: BuildStepLogger
}

interface ExportPage {
  route: RouteManifestEntry
  htmlFile: string
  outHtml: string
  outPageTxt: string
  segmentDir: string
}

const BUILD_ID = 'pnext'
const COMMON_SEGMENTS = ['_full', '_head', '_index', '_tree']

// Where the client runtime lands inside the export tree. A compat build serves `public/assets/<rel>` at
// `/_next/static/<rel>`, but a static export may only add files Next itself would add - the file-set
// contract treats everything under `_next/static/chunks/` as ignorable build output and nothing else.
// Shifting the whole `assets/` tree down one level, rather than flattening it, keeps its internal
// layout intact, so an entry's relative `./chunks/<chunk>.js` import still resolves after the move.
const RUNTIME_ASSET_DIR = '_next/static/chunks'

// Marks an exported document as "served without a pnext server" for the client
// router: it switches to fetching the flat artifacts written beside each page
// instead of negotiating with a server. See ./client.ts. Injected only into the
// export tree — `pnext start` serves the same build unchanged.
const EXPORT_MODE_SCRIPT = '<script>window.__PNEXT_OUTPUT_EXPORT__=true;</script>'

export async function emitStaticExport({ config, manifest, log }: EmitStaticExportContext) {
  // Every compat build serves `/_next/static/<buildId>/_buildManifest.js` (and `_ssgManifest.js`) from
  // the running server - client runtime code fetches it unconditionally, and Next's own asset-404 tests
  // probe it as "a known valid asset path". Export mode additionally snapshots a standalone `out/` tree
  // below; the manifest files it needs are the same bytes, so write the server-served copy first.
  await log.step('build manifest', () => writeBuildManifests(path.join(config.outPath, 'public')))
  const output = getNextConfig().output
  if (output === 'standalone') {
    await emitStandalone({ config, manifest, log })
    return
  }
  if (output !== 'export') return
  await log.step('static export', () => writeExportTree(config, manifest))
}

async function writeExportTree(config: ResolvedConfig, manifest: BuildManifest): Promise<void> {
  const outDir = exportOutDir(config)
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  const assets = await copyRuntimeAssets(config, outDir)
  await copyPublicTree(config, outDir, assets)
  await writeBuildManifests(outDir)

  const pages = exportPages(config, manifest)
  for (const page of pages) await writePageArtifacts(page, assets)
  await writeNotFoundArtifacts(config, outDir)
}

/**
 * Copy the client runtime (`public/assets/**`) into the export tree under
 * `_next/static/chunks/`. Without it an exported app never hydrates: nothing
 * serves `/assets/*` once the build directory is gone. Returns the set of
 * asset-relative paths so the exported HTML's `/_next/static/<rel>` references
 * can be pointed at their new location.
 */
async function copyRuntimeAssets(config: ResolvedConfig, outDir: string): Promise<Set<string>> {
  const assetsDir = path.join(config.outPath, 'public', 'assets')
  const assets = new Set<string>()
  for (const file of await listFiles(assetsDir)) {
    const relative = toPosixPath(path.relative(assetsDir, file))
    assets.add(relative)
    const target = path.join(outDir, ...RUNTIME_ASSET_DIR.split('/'), ...relative.split('/'))
    await mkdir(path.dirname(target), { recursive: true })
    await copyFile(file, target)
  }
  return assets
}

async function copyPublicTree(
  config: ResolvedConfig,
  outDir: string,
  assets: ReadonlySet<string>,
): Promise<void> {
  const publicDir = path.join(config.outPath, 'public')
  for (const file of await listFiles(publicDir)) {
    const relative = toPosixPath(path.relative(publicDir, file))
    if (relative.startsWith('assets/')) continue
    const target = path.join(outDir, ...relative.split('/'))
    await mkdir(path.dirname(target), { recursive: true })
    if (relative.endsWith('.html')) {
      await writeFile(target, exportDocument(await readFile(file, 'utf8'), assets))
    } else {
      await copyFile(file, target)
    }
  }
}

/**
 * An exported copy of a prerendered document: runtime references repointed at
 * `_next/static/chunks/`, and the export-mode marker for the client router.
 */
function exportDocument(html: string, assets: ReadonlySet<string>): string {
  // Only references that name a copied asset move; `_next/static/media/` and
  // the build manifests keep their Next-shaped paths. Any `?`/`#` suffix rides
  // along rather than defeating the lookup.
  const repointed = html.replace(
    /\/_next\/static\/([^"'`\s<>)?#]+)([?#][^"'`\s<>]*)?/g,
    (match: string, rest: string, suffix?: string) =>
      assets.has(rest) ? `/${RUNTIME_ASSET_DIR}/${rest}${suffix ?? ''}` : match,
  )
  // Before any module script runs, so the first navigation already sees it. A
  // fragment with neither <head> nor <body> takes the marker up front.
  const anchor = /<head[^>]*>|<body[^>]*>/.exec(repointed)
  if (!anchor) return EXPORT_MODE_SCRIPT + repointed
  const at = anchor.index + anchor[0].length
  return `${repointed.slice(0, at)}${EXPORT_MODE_SCRIPT}${repointed.slice(at)}`
}

async function writeBuildManifests(outDir: string): Promise<void> {
  const dir = path.join(outDir, '_next', 'static', BUILD_ID)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, '_buildManifest.js'),
    'self.__BUILD_MANIFEST={};self.__BUILD_MANIFEST_CB&&self.__BUILD_MANIFEST_CB();\n',
  )
  await writeFile(path.join(dir, '_ssgManifest.js'), 'self.__SSG_MANIFEST=new Set();\n')
}

/**
 * Where the static export tree lands: `<root>/out` by default, or the configured `distDir` when set -
 * under `output: 'export'` a custom distDir IS the export destination while the internal build keeps its
 * default dir.
 */
function exportOutDir(config: ResolvedConfig): string {
  const distDir = getNextConfig().distDir
  // Next's hasCustomExportOutput treats '.next' as the default distDir — the
  // export then lands in 'out' rather than clobbering the build directory.
  const dir =
    typeof distDir === 'string' && distDir.length > 0 && distDir !== '.next' ? distDir : 'out'
  return path.resolve(config.root, dir)
}

function exportPages(config: ResolvedConfig, manifest: BuildManifest): ExportPage[] {
  const staticFiles = manifest.staticFiles ?? {}
  const routeById = new Map(manifest.routes.map(route => [route.id, route]))
  const pages: ExportPage[] = []

  for (const [relative, metadata] of Object.entries(staticFiles)) {
    if (metadata.kind !== 'page' || !relative.endsWith('.html')) continue
    const route = metadata.routeId ? routeById.get(metadata.routeId) : undefined
    if (route?.kind !== 'page') continue
    const htmlFile = path.join(config.outPath, 'public', ...relative.split('/'))
    pages.push({
      route,
      htmlFile,
      ...exportPathsForHtml(config, relative),
    })
  }

  return pages.sort((a, b) => a.outHtml.localeCompare(b.outHtml))
}

function exportPathsForHtml(config: ResolvedConfig, relative: string) {
  const outDir = exportOutDir(config)
  const normalized = toPosixPath(relative)
  if (normalized === 'index.html') {
    return {
      outHtml: path.join(outDir, 'index.html'),
      outPageTxt: path.join(outDir, 'index.txt'),
      segmentDir: outDir,
    }
  }
  if (normalized.endsWith('/index.html')) {
    const routePath = normalized.slice(0, -'/index.html'.length)
    return {
      outHtml: path.join(outDir, ...normalized.split('/')),
      outPageTxt: path.join(outDir, ...routePath.split('/'), 'index.txt'),
      segmentDir: path.join(outDir, ...routePath.split('/')),
    }
  }
  const routePath = normalized.slice(0, -'.html'.length)
  return {
    outHtml: path.join(outDir, ...normalized.split('/')),
    outPageTxt: path.join(outDir, `${routePath}.txt`),
    segmentDir: path.join(outDir, ...routePath.split('/')),
  }
}

async function writePageArtifacts(page: ExportPage, assets: ReadonlySet<string>): Promise<void> {
  const html = exportDocument(await readFile(page.htmlFile, 'utf8'), assets)
  await mkdir(path.dirname(page.outPageTxt), { recursive: true })
  await writeFile(page.outPageTxt, html)
  await writeSegmentFiles(page.segmentDir, page.route, html)
}

async function writeSegmentFiles(
  segmentDir: string,
  route: Pick<RouteManifestEntry, 'route' | 'params'>,
  body: string,
): Promise<void> {
  await mkdir(segmentDir, { recursive: true })
  for (const segment of COMMON_SEGMENTS) {
    await writeFile(path.join(segmentDir, `__next.${segment}.txt`), body)
  }

  const keys = segmentKeys(route)
  const leaf = keys.at(-1) ?? ''
  await writeFile(
    path.join(segmentDir, leaf ? `__next.${leaf}.__PAGE__.txt` : '__next.__PAGE__.txt'),
    body,
  )
  if (leaf) await writeFile(path.join(segmentDir, `__next.${leaf}.txt`), body)
  for (const key of keys.slice(0, -1)) {
    if (key) await writeFile(path.join(segmentDir, `__next.${key}.txt`), body)
  }
}

function segmentKeys(route: Pick<RouteManifestEntry, 'route' | 'params'>): string[] {
  const params = new Set(route.params)
  const parts = route.route
    .replace(/^\/|\/$/g, '')
    .split('/')
    .filter(Boolean)
    .map(part => (part.startsWith(':') ? `$d$${part.replace(/^:|[*?]$/g, '')}` : part))
  if (parts.length === 0) return ['']
  const keys: string[] = []
  for (const [index, part] of parts.entries()) {
    const key = part.startsWith('$d$') && !params.has(part.slice(3)) ? part.slice(3) : part
    keys.push([...parts.slice(0, index), key].join('.'))
  }
  return keys
}

async function writeNotFoundArtifacts(config: ResolvedConfig, outDir: string): Promise<void> {
  // Read back the COPY in the export tree — copyPublicTree already repointed
  // its runtime references and stamped the export marker.
  const htmlFile = path.join(outDir, '404.html')
  const html = await readFile(htmlFile, 'utf8').catch(() => undefined)
  if (html === undefined) return

  if (config.trailingSlash === true) {
    const nested = path.join(outDir, '404', 'index.html')
    await mkdir(path.dirname(nested), { recursive: true })
    await writeFile(nested, html)
  }

  const outHtml =
    config.trailingSlash === true
      ? path.join(outDir, '_not-found', 'index.html')
      : path.join(outDir, '_not-found.html')
  const outTxt =
    config.trailingSlash === true
      ? path.join(outDir, '_not-found', 'index.txt')
      : path.join(outDir, '_not-found.txt')
  await mkdir(path.dirname(outHtml), { recursive: true })
  await writeFile(outHtml, html)
  await writeFile(outTxt, html)
  await writeSegmentFiles(
    path.join(outDir, '_not-found'),
    { route: '/_not-found', params: [] },
    html,
  )
}
