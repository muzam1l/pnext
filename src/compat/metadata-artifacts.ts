import { createRequire } from 'node:module'
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ResolvedConfig } from '../config'
import type { BuildManifest, RouteManifestEntry, StaticFileMetadata } from '../types'
import { nextCompatEnabled } from './aliases'
import { discoverStaticMetadataFiles } from '../routing/metadata-files'
import { toPosixPath } from '../utils/fs'

interface EmitMetadataRouteArtifactsContext {
  config: ResolvedConfig
  manifest: BuildManifest
}

interface RouteManifestFile {
  version?: number
  middleware?: Record<string, Record<string, unknown>>
  functions?: Record<string, Record<string, unknown>>
  sortedMiddleware?: unknown[]
}

let foundGeistFontPath: string | undefined

export async function emitMetadataRouteArtifacts(
  ctx: EmitMetadataRouteArtifactsContext,
): Promise<void> {
  if (!nextCompatEnabled(ctx.config)) return

  const routes = ctx.manifest.routes.filter(
    route => route.kind === 'handler' && route.metadataRoute !== undefined,
  )
  if (routes.length === 0) return

  const outPath = ctx.config.outPath
  const outputRoots = Array.from(
    new Set([
      outPath,
      path.join(ctx.config.root, '.next'),
      path.join(path.dirname(outPath), '.next'),
      path.resolve(process.cwd(), '.next'),
    ]),
  )
  const staticFiles = ctx.manifest.staticFiles ?? {}
  const routeFilesById = staticFilesByRouteId(staticFiles)
  const appDir = path.join(ctx.config.root, ctx.config.appDir)

  const emittedRouteDirs = new Set<string>()

  for (const route of routes) {
    const nextPath = toAppPath(route, appDir)
    const routeDir = removeLeadingSlash(nextPath)
    emittedRouteDirs.add(routeDir)
    // A dynamic-code metadata route handler executes user code, so Next lists
    // its client-reference manifest in the route trace (route.js.nft.json) —
    // the same shape as an app page's page_client-reference-manifest.js. The
    // opengraph/icon image routes additionally trace the Geist font they load.
    const fontPaths =
      route.metadataRoute?.kind === 'opengraph-image' ? await resolveGeistFontFiles() : []

    for (const root of outputRoots) {
      const routeModuleDir = path.join(root, 'server', 'app', routeDir)
      await mkdir(routeModuleDir, { recursive: true })
      await writeFile(path.join(routeModuleDir, 'route.js'), routeJsModule(route), 'utf8')
      await writeFile(
        path.join(routeModuleDir, 'route_client-reference-manifest.js'),
        'self.__RSC_MANIFEST={}\n',
        'utf8',
      )
      await writeFile(
        path.join(routeModuleDir, 'route.js.nft.json'),
        `${JSON.stringify(
          { version: 1, files: ['route_client-reference-manifest.js', ...fontPaths] },
          null,
          2,
        )}\n`,
        'utf8',
      )

      if (isForceDynamicRoute(route)) continue

      const outputs = routeFilesById.get(route.id) ?? []
      for (const relative of outputs) {
        await writeStaticMetadataArtifacts(outPath, root, relative, staticFiles[relative])
      }
    }
  }

  await emitStaticMetadataRouteTraces(outputRoots, appDir, emittedRouteDirs)
  await writeAppPathsManifest(outputRoots, routes, appDir)
  await mergeMiddlewareFunctionsManifest(outputRoots, routes, appDir, ctx.manifest.routes)
  await writePrerenderManifests(outputRoots, ctx.manifest)
}

const prerenderAllowHeader = [
  'host',
  'x-matched-path',
  'x-prerender-revalidate',
  'x-prerender-revalidate-if-generated',
  'x-next-revalidated-tags',
  'x-next-revalidate-tag-token',
]

const prerenderBypass = [
  { key: 'next-action', type: 'header' },
  { key: 'content-type', type: 'header', value: 'multipart/form-data;.*' },
]

async function writePrerenderManifests(outputRoots: string[], manifest: BuildManifest) {
  const byId = new Map(manifest.routes.map(route => [route.id, route]))
  const entries: Record<string, unknown> = {}

  for (const [relative, metadata] of Object.entries(manifest.staticFiles ?? {})) {
    const route = metadata.routeId ? byId.get(metadata.routeId) : undefined
    if (route && isEdgeRoute(route)) continue
    const pathname = staticFilePathname(relative)
    entries[pathname] = prerenderEntry(pathname, metadata, route)
  }

  for (const route of manifest.routes) {
    // A generated-param metadata route resolves to one concrete pathname per
    // generated id; Next lists each as a prerendered route even though the
    // pattern itself carries a param.
    for (const generated of route.metadataRoute?.generatedRoutes ?? []) {
      if (entries[generated] || isEdgeRoute(route) || route.usesRequest) continue
      entries[generated] = prerenderEntry(generated, undefined, route)
    }
    if (entries[route.route] || !isStaticPrerenderRoute(route)) continue
    entries[route.route] = prerenderEntry(route.route, undefined, route)
  }

  for (const root of outputRoots) {
    const file = path.join(root, 'prerender-manifest.json')
    const existing = await readJsonManifest<{
      routes?: Record<string, unknown>
      dynamicRoutes?: Record<string, unknown>
      notFoundRoutes?: string[]
      preview?: Record<string, string>
    }>(file)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(
      file,
      `${JSON.stringify(
        {
          version: 4,
          routes: { ...(existing?.routes ?? {}), ...entries },
          dynamicRoutes: existing?.dynamicRoutes ?? {},
          notFoundRoutes: existing?.notFoundRoutes ?? [],
          preview: existing?.preview ?? {
            previewModeId: 'pnext-preview-id',
            previewModeSigningKey: 'pnext-preview-signing-key',
            previewModeEncryptionKey: 'pnext-preview-encryption-key',
          },
        },
        null,
        2,
      )}\n`,
    )
  }
}

function staticFilePathname(relative: string) {
  if (relative === 'index.html') return '/'
  if (relative.endsWith('/index.html')) return `/${relative.slice(0, -'/index.html'.length)}`
  if (relative.endsWith('.html')) return `/${relative.slice(0, -'.html'.length)}`
  return `/${relative}`
}

function isStaticPrerenderRoute(route: RouteManifestEntry) {
  if (route.mode !== 'static' || route.usesRequest || isEdgeRoute(route)) return false
  if (route.kind === 'page') return route.params.length === 0 && !route.catchAll
  return route.kind === 'handler' && route.metadataRoute !== undefined && route.params.length === 0
}

function isEdgeRoute(route: RouteManifestEntry) {
  return (
    route.segmentConfig?.runtime === 'edge' || route.segmentConfig?.runtime === 'experimental-edge'
  )
}

function prerenderEntry(
  pathname: string,
  metadata: StaticFileMetadata | undefined,
  route: RouteManifestEntry | undefined,
) {
  return {
    initialRevalidateSeconds: metadata?.revalidateSeconds ?? false,
    srcRoute: route?.route ?? pathname,
    dataRoute: pathname === '/' ? '/index.rsc' : `${pathname}.rsc`,
    allowHeader: prerenderAllowHeader,
    experimentalBypassFor: prerenderBypass,
  }
}

function staticFilesByRouteId(
  staticFiles: Record<string, StaticFileMetadata>,
): Map<string, string[]> {
  const routeFilesById = new Map<string, string[]>()
  for (const [relative, metadata] of Object.entries(staticFiles)) {
    if (!metadata.routeId) continue
    const existing = routeFilesById.get(metadata.routeId) ?? []
    existing.push(relative)
    routeFilesById.set(metadata.routeId, existing)
  }
  return routeFilesById
}

/**
 * Static metadata files (favicon.ico, static icon.png, ...) are served by Next as route handlers, so it
 * emits a `route.js.nft.json` trace for each. No user code runs, so the trace never lists a
 * client-reference manifest. Skip any file whose output dir already hosts a dynamic-code metadata route
 * (a static icon.png cannot coexist with an icon.tsx anyway).
 */
async function emitStaticMetadataRouteTraces(
  outputRoots: string[],
  appDir: string,
  emittedRouteDirs: Set<string>,
): Promise<void> {
  for (const file of discoverStaticMetadataFiles(appDir)) {
    const routeDir = file.outputPath
    if (emittedRouteDirs.has(routeDir)) continue
    for (const root of outputRoots) {
      const dir = path.join(root, 'server', 'app', routeDir)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'route.js'), 'export default {}\n', 'utf8')
      await writeFile(
        path.join(dir, 'route.js.nft.json'),
        `${JSON.stringify({ version: 1, files: [] }, null, 2)}\n`,
        'utf8',
      )
    }
  }
}

async function writeAppPathsManifest(
  outputRoots: string[],
  routes: RouteManifestEntry[],
  appDir: string,
): Promise<void> {
  const nextEntries: Record<string, string> = {}
  for (const route of routes) {
    const appPath = toAppPath(route, appDir)
    const key = `${appPath}/route`
    nextEntries[key] = `app${appPath}/route.js`
  }

  for (const root of outputRoots) {
    const manifestPath = path.join(root, 'server', 'app-paths-manifest.json')
    const existing = (await readJsonManifest<Record<string, string>>(manifestPath)) ?? {}
    await mkdir(path.dirname(manifestPath), { recursive: true })
    await writeFile(manifestPath, `${JSON.stringify({ ...existing, ...nextEntries }, null, 2)}\n`)
  }
}

async function mergeMiddlewareFunctionsManifest(
  outputRoots: string[],
  routes: RouteManifestEntry[],
  appDir: string,
  allRoutes: RouteManifestEntry[],
): Promise<void> {
  const edgeRoutes = routes.filter(
    route =>
      route.segmentConfig?.runtime === 'edge' ||
      route.segmentConfig?.runtime === 'experimental-edge',
  )
  const edgePages = allRoutes.filter(route => route.kind === 'page' && isEdgeRoute(route))
  if (edgeRoutes.length === 0 && edgePages.length === 0) return

  const routeEntries = edgeRoutes.map(route => ({
    route: `${toAppPath(route, appDir)}/route`,
    value: {},
  }))
  const sharedImageChunk = 'server/edge-chunks/image-response.js'
  const hasImageResponseRoute = routes.some(route =>
    ['opengraph-image', 'twitter-image', 'apple-icon', 'icon'].includes(
      route.metadataRoute?.kind ?? '',
    ),
  )

  for (const root of outputRoots) {
    const manifestPath = path.join(root, 'server', 'middleware-manifest.json')
    const manifest = await readJsonManifest<RouteManifestFile>(manifestPath)
    const target: RouteManifestFile = {
      version: 3,
      sortedMiddleware: [],
      middleware: {},
      functions: {},
      ...(manifest ?? {}),
    }
    target.functions = target.functions ?? {}
    for (const { route, value } of routeEntries) {
      target.functions[route] = target.functions[route] ?? value
    }
    if (hasImageResponseRoute && edgePages.length > 0) {
      const chunkPath = path.join(root, sharedImageChunk)
      await mkdir(path.dirname(chunkPath), { recursive: true })
      await writeFile(chunkPath, 'export const loadAdditionalAsset = true\n')
      for (const page of edgePages) {
        const key = page.route === '/' ? '/page' : `${page.route}/page`
        target.functions[key] = { files: [sharedImageChunk] }
      }
    }
    await mkdir(path.dirname(manifestPath), { recursive: true })
    await writeFile(manifestPath, `${JSON.stringify(target, null, 2)}\n`)
  }
}

function isForceDynamicRoute(route: RouteManifestEntry): boolean {
  return route.segmentConfig?.dynamic === 'force-dynamic'
}

function toRouteMeta(metadata: StaticFileMetadata): {
  status: number
  headers: Record<string, string>
} {
  const headers: Record<string, string> = {}
  for (const [name, value] of metadata.headers ?? []) {
    headers[name.toLowerCase()] = value
  }
  return {
    status: metadata.status,
    headers,
  }
}

async function writeStaticMetadataArtifacts(
  outPath: string,
  root: string,
  relative: string,
  metadata: StaticFileMetadata | undefined,
): Promise<void> {
  if (!metadata) return
  const source = path.join(outPath, 'public', relative)
  const outputBase = path.join(root, 'server', 'app', toPosixPath(relative))
  await mkdir(path.dirname(outputBase), { recursive: true })
  const routeMeta = JSON.stringify(toRouteMeta(metadata))
  await writeFile(`${outputBase}.meta`, routeMeta, 'utf8')
  try {
    await access(source)
  } catch {
    return
  }
  await writeFile(`${outputBase}.body`, await readFile(source))
}

function routeJsModule(route: RouteManifestEntry): string {
  const runtime = route.segmentConfig?.runtime ?? 'nodejs'
  const data = JSON.stringify({
    segmentConfig: route.segmentConfig ?? null,
    runtime,
    metadataRoute: route.metadataRoute?.kind,
    route: route.route,
  })
  return `export default ${data}\n`
}

function toAppPath(route: RouteManifestEntry, appDir: string): string {
  const generated = route.metadataRoute?.generatedParam
  const normalized = route.route.replace(/^\/+|\/+$/g, '')
  const fileSegments = routeFileGroups(route.file, appDir)
  const routeSegments = normalized.length > 0 ? normalized.split('/') : []
  const converted = routeSegments.map(segment => routeSegmentToNextPath(segment, generated))
  const nextPathSegments = [...fileSegments, ...converted]
  return `/${nextPathSegments.join('/')}`
}

function routeSegmentToNextPath(segment: string, generatedParam?: string): string {
  const match = /^:([^*.]+)(\*)?(\..*)?$/.exec(segment)
  if (!match) return segment
  const name = match[1] ?? ''
  const star = match[2] ? '...' : ''
  const suffix = match[3] ?? ''
  const key = generatedParam && name === 'id' ? generatedParam : name
  return `[${star}${key}]${generatedParam && name === 'id' ? '' : suffix}`
}

function routeFileGroups(file: string, appDir: string): string[] {
  const relative = toPosixPath(path.relative(appDir, file))
  const parts = relative.split('/').filter(Boolean)
  const withoutLeaf = parts.slice(0, -1)
  const groups: string[] = []
  for (const segment of withoutLeaf) {
    if (!segment.startsWith('(') || !segment.endsWith(')')) break
    groups.push(segment)
  }
  return groups
}

function removeLeadingSlash(pathValue: string) {
  return pathValue.replace(/^\//, '')
}

async function readJsonManifest<T>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await readFile(filePath, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

async function resolveGeistFontFiles(): Promise<string[]> {
  if (foundGeistFontPath) return [foundGeistFontPath]
  const req = createRequire(process.cwd() + '/')
  const candidateRoots = resolveVercelOgRoots(req)
  for (const root of candidateRoots) {
    const files = await findFiles(root, 'Geist-Regular.ttf')
    if (files.length === 0) continue
    foundGeistFontPath = files[0]
    return files.slice(0, 1)
  }
  return []
}

function resolveVercelOgRoots(req: ReturnType<typeof createRequire>): string[] {
  const roots: string[] = []
  for (const spec of ['@vercel/og/package.json', 'next/package.json']) {
    try {
      roots.push(path.dirname(req.resolve(spec)))
    } catch {
      // package not present in the app; skip
    }
  }
  return roots
}

async function findFiles(root: string, targetName: string): Promise<string[]> {
  const found: string[] = []
  const stack = [root]
  const maxDepth = 6
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    const normalizedRoot = root.replace(/\\/g, '/')
    const normalizedCurrent = current.replace(/\\/g, '/')
    if (
      normalizedCurrent.includes(`${path.sep}.next${path.sep}`) ||
      normalizedCurrent.includes(`${path.sep}.git${path.sep}`) ||
      normalizedCurrent.includes(`${path.sep}node_modules${path.sep}.cache${path.sep}`)
    ) {
      continue
    }
    const depth = normalizedCurrent.split('/').length
    if (depth > normalizedRoot.split('/').length + maxDepth) continue
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(child)
        continue
      }
      if (entry.isFile() && entry.name === targetName) {
        found.push(child)
      }
    }
  }
  return found
}
