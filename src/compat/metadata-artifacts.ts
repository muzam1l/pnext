import { createRequire } from 'node:module'
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ResolvedConfig } from '../config'
import type { BuildManifest, RouteManifestEntry, StaticFileMetadata } from '../types'
import { nextCompatEnabled } from './aliases'
import { discoverStaticMetadataFiles } from '../routing/metadata-files'
import { toPosixPath } from '../utils/fs'
import { cacheComponents } from '../render/ppr'
import { routeParamKeys } from '../render/renderer'
import { nextRoutePattern } from '../routing/match'
import { PREVIEW_MODE_ID } from './pages/api'
import {
  fillNextRoutePattern,
  nextPatternRegex,
  paramMatchingCandidates,
  routeRootParams,
} from './register/build'
import { routeRuntimePrefetch } from './next/route-state'
import { buildRootTreePrefetch, segmentMetaFile, type SegmentMeta } from './segment/tree'

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

  const outPath = ctx.config.outPath
  const outputRoots = Array.from(
    new Set([
      outPath,
      path.join(ctx.config.root, '.next'),
      path.join(path.dirname(outPath), '.next'),
      path.resolve(process.cwd(), '.next'),
    ]),
  )
  await writePrerenderManifests(ctx.config, outputRoots, ctx.manifest)
  const routes = ctx.manifest.routes.filter(
    route => route.kind === 'handler' && route.metadataRoute !== undefined,
  )
  if (routes.length === 0) return
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

async function writePrerenderManifests(
  config: ResolvedConfig,
  outputRoots: string[],
  manifest: BuildManifest,
) {
  const byId = new Map(manifest.routes.map(route => [route.id, route]))
  const entries: Record<string, { srcRoute: string }> = {}

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

  const dynamicRoutes: Record<string, DynamicRouteEntry> = {}
  const prefetchHints: Record<string, SegmentMeta['prefetchHints']> = {}
  for (const route of cacheComponents() ? manifest.routes : []) {
    if (route.kind !== 'page' || route.interception) continue
    const page = nextRoutePattern(route.route, route.catchAllOptional)
    const meta = await readJsonManifest<SegmentMeta>(segmentMetaFile(config.outPath, route.id))
    // A route without a baked shell announces the hints its runtime tree response sends.
    prefetchHints[page] = meta?.prefetchHints ?? {
      hints:
        buildRootTreePrefetch({
          pathname: route.route,
          isStatic: false,
          partialPrefetching: routeRuntimePrefetch(route),
        }).tree.h ?? 0,
      slots: null,
    }
    const names = routeParamKeys(route)
    for (const set of route.prerenderedParams ?? []) {
      if (!names.every(name => set[name] !== undefined)) continue
      const pathname = fillNextRoutePattern(route, set)
      entries[pathname] ??= prerenderEntry(pathname, undefined, route)
    }
    const rootParams = routeRootParams(config.appPath, route)
    for (const candidate of paramMatchingCandidates(route, rootParams)) {
      const regex = nextPatternRegex(candidate.pathname)
      const dynamicAt = candidate.unfilled.findIndex(
        name => route.paramMatching?.[name] === 'dynamic',
      )
      const remaining = candidate.unfilled.slice(0, dynamicAt < 0 ? undefined : dynamicAt)
      dynamicRoutes[candidate.pathname] = {
        routeRegex: `^${regex}(?:/)?$`,
        dataRoute: `${candidate.pathname}.rsc`,
        dataRouteRegex: `^${regex}\\.rsc$`,
        fallback: candidate.fallback,
        fallbackSourceRoute: page,
        fallbackRouteParams: candidate.unfilled.map(name => paramEntry(route, name)),
        fallbackRootParams: candidate.unfilled.filter(name => rootParams.has(name)),
        remainingPrerenderableParams: remaining.length
          ? remaining.map(name => paramEntry(route, name))
          : undefined,
        throwOnEmptyStaticShell: candidate.validated,
        experimentalPPR: true,
        allowHeader: prerenderAllowHeader,
        experimentalBypassFor: prerenderBypass,
        ...(route.segmentConfig?.ensureStatic === 'navigation'
          ? { _isEnsureStaticPage: true }
          : {}),
      }
    }
  }
  // eslint-disable-next-line turbo/no-undeclared-env-vars -- Next's own debug switch
  if (process.env.NEXT_PRIVATE_DEBUG_PARAM_MATCHING)
    printParamMatchingDigest(entries, dynamicRoutes)

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
          dynamicRoutes: { ...(existing?.dynamicRoutes ?? {}), ...dynamicRoutes },
          notFoundRoutes: existing?.notFoundRoutes ?? [],
          preview: existing?.preview ?? {
            previewModeId: PREVIEW_MODE_ID,
            previewModeSigningKey: 'pnext-preview-signing-key',
            previewModeEncryptionKey: 'pnext-preview-encryption-key',
          },
        },
        null,
        2,
      )}\n`,
    )
    if (Object.keys(prefetchHints).length === 0) continue
    await mkdir(path.join(root, 'server'), { recursive: true })
    await writeFile(path.join(root, 'server', 'prefetch-hints.json'), JSON.stringify(prefetchHints))
  }
}

interface DynamicRouteEntry {
  fallback: string | null | false
  fallbackSourceRoute: string
  [key: string]: unknown
}

function paramEntry(route: RouteManifestEntry, paramName: string) {
  const paramType =
    paramName !== route.catchAll
      ? 'dynamic'
      : route.catchAllOptional
        ? 'optional-catchall'
        : 'catchall'
  return { paramName, paramType }
}

/** Next's NEXT_PRIVATE_DEBUG_PARAM_MATCHING digest (build/utils.ts `printPrerenderMatchers`). */
function printParamMatchingDigest(
  routes: Record<string, { srcRoute: string }>,
  dynamicRoutes: Record<string, DynamicRouteEntry>,
) {
  const sources = [
    ...new Set([
      ...Object.values(dynamicRoutes).map(route => route.fallbackSourceRoute),
      ...Object.values(routes).map(route => route.srcRoute),
    ]),
  ].sort()
  if (sources.length === 0) return
  const dynamicSegments = (pathname: string) => pathname.match(/\[[^/]+\]/g)?.length ?? 0
  const matchersFor = (source: string) =>
    Object.entries(dynamicRoutes)
      .filter(([, route]) => route.fallbackSourceRoute === source)
      .map(([pathname, route]) => ({
        behavior:
          route.fallback === false
            ? 'not-found'
            : route.fallback === null
              ? 'blocking'
              : 'fallback',
        pathname,
      }))
      .sort(
        (a, b) =>
          dynamicSegments(b.pathname) - dynamicSegments(a.pathname) ||
          a.pathname.localeCompare(b.pathname),
      )
  const tree = (rows: string[]) =>
    rows.forEach((row, index) => console.log(`  ${index === rows.length - 1 ? '└' : '├'} ${row}`))
  console.log('Experimental parameter matching')
  console.log('More-specific rows override broader rows for the same request.')
  console.log()
  for (const source of sources) {
    const entries = [
      ...matchersFor(source),
      ...Object.keys(routes)
        .filter(pathname => routes[pathname]!.srcRoute === source)
        .sort((a, b) => a.localeCompare(b))
        .map(pathname => ({ behavior: 'prerender', pathname })),
    ]
    const width = Math.max(...entries.map(({ behavior }) => behavior.length))
    console.log(source)
    tree(entries.map(({ behavior, pathname }) => `${behavior.padEnd(width)}  ${pathname}`))
    console.log()
  }
  console.log('Emitted dynamic route patterns')
  console.log('These are the patterns available to deployment routing metadata.')
  console.log()
  for (const source of sources) {
    const patterns = matchersFor(source).map(({ pathname }) => pathname)
    console.log(`${source} (${patterns.length})`)
    tree(patterns)
    console.log()
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
  // A shell without a static file carries its `use cache` lifetime on the route.
  const life = metadata ?? route?.cacheLife
  return {
    initialRevalidateSeconds: life?.revalidateSeconds ?? false,
    ...(life?.expireSeconds !== undefined ? { initialExpireSeconds: life.expireSeconds } : {}),
    srcRoute: route ? nextRoutePattern(route.route, route.catchAllOptional) : pathname,
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
  const source = path.join(outPath, 'static', relative)
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
