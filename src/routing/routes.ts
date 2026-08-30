import path from 'node:path'
import { existsSync } from 'node:fs'
import { listFiles, listFilesSync, readDirListing, toPosixPath, withDirCache } from '../utils/fs'
import { safeDecode } from '../utils/decode'
import {
  dynamicCallsFromSource,
  pnextDynamicImportNames,
  rewriteLiteralDynamicCalls,
} from '../resolve/dynamic'
import { resolveImport, resolveModuleAlias, resolvePackageSpecifier } from '../resolve/imports'
import { dynamicCallFacts, scanFacts, type DynamicCallFact } from '../resolve/scan-facts'
import { readSourceSync } from '../resolve/source-text'
import { globalCssSourcesForPaths } from '../css/build'
import {
  childrenDefaultFile,
  interceptionMarkerLevels,
  interceptionMarkerOf,
  isGroupSegment,
  isSlotSegment,
  slotConventionFile,
  slotDirectoriesIn,
} from './slots'
import type {
  ClientEntryReason,
  MetadataRouteEntry,
  MetadataRouteKind,
  NavState,
  RouteInterception,
  RouteManifestEntry,
  RouteMode,
  RouteParamValue,
  RouteSegmentConfig,
} from '../types'
import {
  clientReferenceId,
  ssrClientReference,
  type ClientDynamicReference,
  type ClientReference,
} from '../client/reference'
import {
  alwaysClientEntryReasons,
  classifyRouteDependencies,
  extraBoundaryConventionNames,
  extraPageExtensions,
  getBundlerExtensions,
  getCssExtensions,
  sourceClientEntryReasons,
  sourceUsesRegisteredRequestApi,
} from '../extensions'

// Single source of truth for the page/convention extension list. `.tsx`/`.ts` stay first so an all-.tsx app
// resolves on the first candidate and produces the identical file as before; .js/.jsx/.mjs are additive
// alternatives, and compat appends `mdx`/`md` via registerPageExtensions. EVERYTHING below derives from
// pageExtensions()/routeHandlerExtensions() LAZILY, computed on first use and memoized, so the compat
// registration that runs at bootstrap - before scanRoutes - is honored; a module-level const regex is baked
// at import time, which is too early.
const BASE_PAGE_EXTENSIONS = ['tsx', 'ts', 'jsx', 'js', 'mjs'] as const
const BASE_ROUTE_HANDLER_EXTENSIONS = ['ts', 'tsx', 'js', 'mjs'] as const

/** Base + compat-registered page extensions, de-duplicated in order. */
function pageExtensions(): string[] {
  return [...new Set([...BASE_PAGE_EXTENSIONS, ...extraPageExtensions()])]
}

/** Route-handler extensions (route.*); compat page extensions do not apply. */
function routeHandlerExtensions(): readonly string[] {
  return BASE_ROUTE_HANDLER_EXTENSIONS
}

/** Union of page + route-handler extensions (metadata + trailing-file regexes). */
function allFileExtensions(): string[] {
  return [...new Set([...pageExtensions(), ...routeHandlerExtensions()])]
}

const componentConventions = ['loading', 'error', 'not-found'] as const
// Extra boundary conventions (e.g. Next's authInterrupts forbidden/unauthorized)
// are registered by compat via the routeConventions seam and merged in here.
function boundaryConventions(): string[] {
  return [...componentConventions, ...extraBoundaryConventionNames()]
}

const globalErrorBase = 'global-error'

// The extension list is only known after compat bootstrap runs (which may
// registerPageExtensions), and scanRoutes always runs after bootstrap. Each
// pattern is computed on first use and memoized so the compat additions land
// while repeat calls stay cheap. Kept as accessors (not module-level consts)
// precisely to defer baking past bootstrap.
let memoPageFile: RegExp | undefined
let memoRouteFilePattern: RegExp | undefined
let memoDefaultConventionPattern: RegExp | undefined
let memoMetadataCodeFilePattern: RegExp | undefined
let memoPageOrRouteTrailing: RegExp | undefined
let memoSlotConventionPattern: RegExp | undefined

// Memos must not outlive a later registerPageExtensions call: Pages-compat
// materialization scans routes during config resolution, BEFORE
// registerMdxExtensions runs, and a pattern baked then would lock `.mdx` out.
let memoExtensionsKey: string | undefined
function freshMemos(): void {
  const key = extraPageExtensions().join(',')
  if (key === memoExtensionsKey) return
  memoExtensionsKey = key
  memoPageFile = undefined
  memoRouteFilePattern = undefined
  memoDefaultConventionPattern = undefined
  memoMetadataCodeFilePattern = undefined
  memoPageOrRouteTrailing = undefined
  memoSlotConventionPattern = undefined
}

function pageFile(): RegExp {
  freshMemos()
  return (memoPageFile ??= extensionRegex('page', pageExtensions()))
}

function routeFilePattern(): RegExp {
  freshMemos()
  return (memoRouteFilePattern ??= extensionRegex('route', routeHandlerExtensions()))
}

function defaultConventionPattern(): RegExp {
  freshMemos()
  return (memoDefaultConventionPattern ??= extensionRegex('default', pageExtensions()))
}

function metadataCodeFilePattern(): RegExp {
  freshMemos()
  return (memoMetadataCodeFilePattern ??= new RegExp(
    `(^|/)(robots|sitemap|manifest|icon\\d*|apple-icon\\d*|opengraph-image\\d*|twitter-image\\d*)\\.(${allFileExtensions().join(
      '|',
    )})$`,
  ))
}

function pageOrRouteTrailing(): RegExp {
  freshMemos()
  return (memoPageOrRouteTrailing ??= new RegExp(
    `/?(page|route|layout|template|loading|error|not-found|forbidden|unauthorized|default|global-error)\\.(${allFileExtensions().join(
      '|',
    )})$`,
  ))
}

function slotConventionPattern(): RegExp {
  freshMemos()
  return (memoSlotConventionPattern ??= new RegExp(
    `(^|/)(page|layout|template|loading|error|default|not-found)\\.(${pageExtensions().join('|')})$`,
  ))
}

function extensionRegex(base: string, extensions: readonly string[]) {
  return new RegExp(`(^|/)${escapeRegex(base)}\\.(${extensions.join('|')})$`)
}

/** Nearest existing file named `<base>.<ext>` for the convention extensions. */
function conventionFileName(dir: string, base: string) {
  const { files } = readDirListing(dir)
  for (const extension of pageExtensions()) {
    if (files.has(`${base}.${extension}`)) return path.join(dir, `${base}.${extension}`)
  }
  return undefined
}

interface RouteParts {
  route: string
  pattern: string
  params: string[]
  catchAll?: string
  catchAllOptional?: boolean
  interception?: Omit<RouteInterception, 'slotDir'>
}

interface ModuleEdge {
  file: string
  exports: string[]
  dynamic?: ClientDynamicReference
  /** `export * from` the target: its named exports are re-exported by this module. */
  star?: boolean
}

interface ScanContext {
  root: string
  appPath: string
  sources: Map<string, string>
  edges: Map<string, ModuleEdge[]>
  requestImportUsage: Map<string, boolean>
  /**
   * Per-FILE facts, path-keyed. Every route re-walks its whole source closure and each visit
   * re-derived these from the text. Same lifetime and staleness rules as `sources`.
   */
  exists: Map<string, boolean>
  useClient: Map<string, boolean>
  usesLink: Map<string, boolean>
  usesNavigation: Map<string, boolean>
  entryReasons: Map<string, ClientEntryReason[]>
  /** Root-layout CSS closure — itself a content walk, so it resolves with the first CSS fact. */
  globalCssImports(): Set<string>
}

function createScanContext(appPath: string, globalCss?: () => Set<string>): ScanContext {
  const root = rootFromAppPath(appPath)
  let memo: Set<string> | undefined
  return {
    root,
    appPath,
    sources: new Map(),
    edges: new Map(),
    requestImportUsage: new Map(),
    exists: new Map(),
    useClient: new Map(),
    usesLink: new Map(),
    usesNavigation: new Map(),
    entryReasons: new Map(),
    globalCssImports:
      globalCss ?? (() => (memo ??= new Set(globalCssSourcesForPaths(root, appPath)))),
  }
}

/** `existsSync` once per path per scan — the closure walk asks the same paths per route. */
function fileExists(context: ScanContext, file: string) {
  let hit = context.exists.get(file)
  if (hit === undefined) {
    hit = existsSync(file)
    context.exists.set(file, hit)
  }
  return hit
}

const routeHandlerMethods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const

/**
 * The entry fields that need file CONTENT. Boot never reads them: the route table is built from path
 * conventions alone, which fully determine matching, and these resolve on first access - the route's first
 * compile - through one memoized scan-facts pass per file, which that compile then re-uses.
 */
export interface RouteFacts {
  mode: RouteMode
  hasStaticParams: boolean
  usesRequest: boolean
  handlerUsesRevalidationApi?: true
  dynamicErrorApi?: string
  client: boolean
  clientReferences: ClientReference[]
  cssImports: string[]
  sourceFiles: string[]
  serverActionFile?: string
  stream?: RouteManifestEntry['stream']
  maxDuration?: number
  ppr?: boolean
  segmentConfig?: RouteSegmentConfig
  needsRouterEntry?: true
  clientEntryReasons?: ClientEntryReason[]
}

const deferredFields = [
  'mode',
  'hasStaticParams',
  'usesRequest',
  'handlerUsesRevalidationApi',
  'dynamicErrorApi',
  'client',
  'clientReferences',
  'cssImports',
  'sourceFiles',
  'serverActionFile',
  'stream',
  'maxDuration',
  'ppr',
  'segmentConfig',
  'needsRouterEntry',
  'clientEntryReasons',
] as const satisfies readonly (keyof RouteFacts)[]

/** Path-only entry fields; everything in RouteFacts is layered on lazily. */
type RoutePathEntry = Omit<RouteManifestEntry, keyof RouteFacts>

const resolvedRoutes = new WeakSet<RouteManifestEntry>()
let factsVersion = 0

/** Bumped each time a route resolves its deferred facts (dev re-keys watch roots off it). */
export function routeFactsVersion() {
  return factsVersion
}

export function routeFactsResolved(route: RouteManifestEntry) {
  return resolvedRoutes.has(route)
}

/**
 * Force every route's deferred facts - the build and typegen need the whole table. `onRoute` fires as each
 * route's facts land, so a consumer that only needs one route's file list (the client stage) can start on it
 * instead of waiting for the last route to scan.
 */
export function materializeRouteFacts<T extends RouteManifestEntry[]>(
  routes: T,
  onRoute?: (route: RouteManifestEntry) => void,
): T {
  for (const route of routes) {
    void route.sourceFiles
    onRoute?.(route)
  }
  return routes
}

/**
 * The same walk for a consumer that must not hold the event loop: one route per turn, with `pause`
 * awaited in between. A build wants the loop (nothing else runs); a dev server does not, and a first
 * page landing mid-walk would otherwise wait out all of it before its own first `await` resumes.
 */
export async function materializeRouteFactsPaced<T extends RouteManifestEntry[]>(
  routes: T,
  pause: () => Promise<void>,
): Promise<T> {
  for (const route of routes) {
    await pause()
    void route.sourceFiles
  }
  return routes
}

/**
 * A store that survives the process - the dev server installs one so a restart reads the walk's result
 * instead of re-running it. `load` returns the recorded facts only when every source they were derived from
 * still has the content it was recorded with; `save` is called once, with the facts a fresh walk produced.
 */
export interface RouteFactsStore {
  load(routeId: string): RouteFacts | undefined
  save(routeId: string, facts: RouteFacts): void
}

let factsStore: RouteFactsStore | undefined

export function setRouteFactsStore(store: RouteFactsStore | undefined) {
  factsStore = store
}

function withDeferredFacts(
  appPath: string,
  base: RoutePathEntry,
  compute: () => RouteFacts,
): RouteManifestEntry {
  const entry = base as RouteManifestEntry
  let facts: RouteFacts | undefined
  // Consumers still assign some of these (the build marks needsRouterEntry), so
  // each field keeps a setter that wins over the computed value without forcing
  // the scan.
  const overrides = new Map<string, unknown>()

  for (const field of deferredFields) {
    Object.defineProperty(entry, field, {
      enumerable: true,
      configurable: true,
      get() {
        if (overrides.has(field)) return overrides.get(field)
        if (!facts) {
          // Route ids repeat across apps ('page:/' everywhere), so the app the
          // facts were derived in is part of the key - otherwise one app's
          // record answers another app's lookup in the same process.
          const key = `${appPath}\0${base.kind}:${base.id}`
          const stored = factsStore?.load(key)
          facts = stored ?? withDirCache(compute)
          if (!stored) factsStore?.save(key, facts)
          resolvedRoutes.add(entry)
          factsVersion += 1
        }
        return facts[field]
      },
      set(value: unknown) {
        overrides.set(field, value)
      },
    })
  }

  return entry
}

export async function scanRoutes(appPath: string): Promise<RouteManifestEntry[]> {
  const files = await listFiles(appPath)
  return withDirCache(() => buildRouteTable(appPath, files))
}

/** The path pass: file paths in, route table out — no file content is read. */
function buildRouteTable(appPath: string, files: string[]): RouteManifestEntry[] {
  const context = createScanContext(appPath)
  const routes: RouteManifestEntry[] = []
  const slotPageFiles: { file: string; relative: string }[] = []
  const defaultPageFiles: { file: string; relative: string }[] = []
  // Parallel/intercepting-route semantics only exist on client navigations, so
  // when the app uses them every page ships the router runtime. Both facts are
  // path-shaped, but the whole table must be walked before they are known —
  // hence a holder the per-route needsRouterEntry closures read later.
  const table = { parallelRoutes: false }

  for (const file of files) {
    const relative = toPosixPath(path.relative(appPath, file))
    const routeFile = path.join(appPath, relative)
    if (
      defaultConventionPattern().test(relative) &&
      !relative.split('/').some(segment => segment.startsWith('@'))
    ) {
      defaultPageFiles.push({ file, relative })
    }
    // App segments beginning with `_` are private (Next ignores them); the
    // route is dropped so requesting it 404s. A directory literally named
    // `%5Ffoo` decodes to a routable `/_foo` (handled in routeParts), so it is
    // NOT private. Applies to pages, handlers, and metadata routes alike.
    if (isPrivateAppPath(relative)) continue
    if (!pageFile().test(relative) && !routeFilePattern().test(relative)) {
      if (!metadataCodeFilePattern().test(relative)) continue
      // The one content read boot cannot defer: a metadata file's generateSitemaps/
      // generateImageMetadata export decides whether its URL carries an id segment,
      // so it shapes the PATTERN. Bounded to metadata files (a handful per app) and
      // to their own source — no module-graph walk.
      const source = readSource(context, file)
      const metadataParts = dynamicMetadataRouteParts(relative, source)
      if (!metadataParts) continue
      routes.push(
        withDeferredFacts(
          appPath,
          {
            id: `metadata-${routeId(metadataParts.route)}`,
            kind: 'handler',
            route: metadataParts.route,
            pattern: metadataParts.pattern,
            file,
            params: metadataParts.params,
            catchAll: metadataParts.catchAll,
            ...(metadataParts.catchAllOptional ? { catchAllOptional: true } : {}),
            metadataRoute: metadataParts.metadataRoute,
          },
          () => metadataRouteFacts(context, routeFile, metadataParts),
        ),
      )
      continue
    }
    // Pages inside `@slot` dirs primarily render as slot content of their
    // owning segment; they also derive standalone entries (synthetic slot URLs
    // and slot interception targets) in a second pass below.
    if (relative.split('/').some(segment => segment.startsWith('@'))) {
      if (pageFile().test(relative)) slotPageFiles.push({ file, relative })
      continue
    }

    const kind = pageFile().test(relative) ? 'page' : 'handler'
    const routeDir = relative.replace(pageOrRouteTrailing(), '')
    const parts = routeParts(routeDir)
    const conventions = conventionPaths(appPath, routeFile, kind)
    const templatePaths = conventions.templateFiles.filter(item => existsSync(item))
    // authInterrupt boundary files (forbidden/unauthorized) are only discovered
    // when compat registered those conventions via the routeConventions seam.
    const extraBoundaries = new Set(extraBoundaryConventionNames())
    const forbiddenPaths =
      kind === 'page' && extraBoundaries.has('forbidden')
        ? findConventionFiles(appPath, routeFile, 'forbidden').filter(item => existsSync(item))
        : []
    const unauthorizedPaths =
      kind === 'page' && extraBoundaries.has('unauthorized')
        ? findConventionFiles(appPath, routeFile, 'unauthorized').filter(item => existsSync(item))
        : []

    // An interception entry's route/pattern is the TARGET path it responds
    // to; it only matches soft navigations (see matchInterception), renders
    // per request, and never prerenders.
    const interception = parts.interception
    routes.push(
      withDeferredFacts(
        appPath,
        {
          id: interception ? `intercept-${sanitizeIdPart(routeDir)}` : routeId(parts.route || '/'),
          kind,
          route: parts.route,
          pattern: parts.pattern,
          file,
          params: parts.params,
          catchAll: parts.catchAll,
          ...(parts.catchAllOptional ? { catchAllOptional: true } : {}),
          ...(templatePaths.length > 0 ? { templateFiles: templatePaths } : {}),
          ...(forbiddenPaths.length > 0 ? { forbiddenFiles: forbiddenPaths } : {}),
          ...(unauthorizedPaths.length > 0 ? { unauthorizedFiles: unauthorizedPaths } : {}),
          ...(conventions.slotDirs.length > 0 ? { slotDirs: conventions.slotDirs } : {}),
          ...(interception ? { interception } : {}),
        },
        () => pageOrHandlerFacts(context, { kind, routeFile, parts, conventions, table }),
      ),
    )
  }

  appendSlotDerivedRoutes(context, routes, slotPageFiles, table)
  appendDefaultDerivedRoutes(context, routes, defaultPageFiles, table)
  table.parallelRoutes = routes.some(route => route.slotDirs?.length || route.interception)

  return routes.sort((a, b) => routeRank(a).localeCompare(routeRank(b)))
}

/** Convention files reachable from a route file — all decided by paths on disk. */
function conventionPaths(appPath: string, routeFile: string, kind: 'page' | 'handler') {
  if (kind !== 'page') {
    return { layoutFiles: [], templateFiles: [], specialFiles: [], slotDirs: [], slotFiles: [] }
  }
  const slotDirs = chainSlotDirs(appPath, routeFile)
  return {
    layoutFiles: findLayouts(appPath, routeFile),
    templateFiles: findConventionFiles(appPath, routeFile, 'template'),
    specialFiles: boundaryConventions().flatMap(name =>
      findConventionFiles(appPath, routeFile, name),
    ),
    slotDirs,
    slotFiles: slotTreeFiles(slotDirs),
  }
}

type ConventionPaths = ReturnType<typeof conventionPaths>

/** Set once the whole table is known; the closures below read it, never at boot. */
interface TableFlags {
  parallelRoutes: boolean
}

function metadataRouteFacts(
  context: ScanContext,
  routeFile: string,
  parts: DynamicMetadataRouteParts,
): RouteFacts {
  const source = readSource(context, routeFile)
  const sourceFiles = collectSourceFiles(context, [routeFile])
  const dependency = routeDependencyClassification(context, 'handler', sourceFiles)
  const usesRequest =
    metadataRouteUsesRequest(source) ||
    usesRevalidationApis(source) ||
    dependency.usesRequest === true ||
    usesRequestImportDataForFiles(
      context,
      sourceFiles.filter(file => !isAssetFile(file)),
    )
  const segmentConfig = segmentConfigFromEntries(
    context.appPath,
    [{ file: routeFile, source }],
    parts,
  )
  return {
    mode: inferRouteMode(parts, usesRequest, segmentConfig),
    hasStaticParams: Boolean(parts.metadataRoute.generatedParam),
    usesRequest,
    client: false,
    clientReferences: [],
    cssImports: [],
    sourceFiles,
    maxDuration: maxDurationFromSources([source]),
    ...(segmentConfig ? { segmentConfig } : {}),
  }
}

function pageOrHandlerFacts(
  context: ScanContext,
  options: {
    kind: 'page' | 'handler'
    routeFile: string
    parts: RouteParts
    conventions: ConventionPaths
    table: TableFlags
  },
): RouteFacts {
  const { appPath } = context
  const { kind, routeFile, parts, conventions, table } = options
  const { layoutFiles, templateFiles, specialFiles, slotFiles } = conventions
  const source = readScanSource(context, routeFile)
  const layoutSources = [...layoutFiles, ...templateFiles, ...specialFiles]
    .filter(item => existsSync(item))
    .map(item => readScanSource(context, item))
  const entryFiles = [routeFile, ...layoutFiles, ...templateFiles, ...specialFiles, ...slotFiles]
  const sourceFiles = collectSourceFiles(context, entryFiles)
  const dependency = routeDependencyClassification(context, kind, sourceFiles)
  const handlerUsesRevalidationApi = kind === 'handler' && usesRevalidationApis(source)
  const usesRequest =
    kind === 'handler'
      ? routeHandlerUsesRequest(source) ||
        handlerUsesRevalidationApi ||
        dependency.usesRequest === true
      : [source, ...layoutSources].some(usesRequestData) || dependency.usesRequest === true
  // Layout sources only (leaf-first, page first): segment config exports in
  // templates/special files have no route-level meaning.
  const existingLayoutFiles = layoutFiles.filter(item => existsSync(item))
  const configEntries = [
    { file: routeFile, source },
    ...[...existingLayoutFiles].reverse().map(item => ({
      file: item,
      source: readScanSource(context, item),
    })),
  ]
  const segmentConfig = segmentConfigFromEntries(appPath, configEntries, parts)
  if (segmentConfig?.dynamicParamsFalse?.length) {
    // `dynamicParams = false` only 404s unlisted params when the route is fully statically enumerable -
    // every dynamic segment must be generated by a generateStaticParams somewhere in the chain. If a dynamic
    // segment has no static params, the route renders on demand and the ancestor's dynamicParams config no
    // longer restricts it (Next treats the whole path as dynamic).
    const allDynamicParams = [...parts.params, ...(parts.catchAll ? [parts.catchAll] : [])]
    const coveredParams = new Set<string>()
    for (const entry of configEntries) {
      if (!hasStaticParamsExport(entry.source)) continue
      const covered = paramOfOwnSegment(appPath, entry.file, allDynamicParams)
      if (covered) coveredParams.add(covered)
    }
    if (allDynamicParams.some(param => !coveredParams.has(param))) {
      delete segmentConfig.dynamicParamsFalse
    } else if (hasStaticParamsExport(source)) {
      segmentConfig.strictDynamicParams = true
    }
  }
  const hasStaticParams =
    hasStaticParamsExport(source) ||
    (kind === 'page' &&
      existingLayoutFiles.map(item => readScanSource(context, item)).some(hasStaticParamsExport))
  // `dynamic = 'error'` forbids dynamic data: a static reference to one is a
  // build failure (enforced in the prerender pass). Restricted to routes with
  // no dynamic params and no generateStaticParams: those prerender a single
  // top-level render, so a referenced dynamic API is reached unconditionally.
  // A parameterized `dynamic = 'error'` route (e.g. `[id]` guarding cookies()
  // behind a runtime param check) builds fine in Next and only errors at
  // request time, so it must not fail the build. Layout sources count for
  // pages so a dynamic API read in a shared layout is still caught.
  const dynamicErrorApi =
    segmentConfig?.dynamic === 'error' &&
    parts.params.length === 0 &&
    !parts.catchAll &&
    !hasStaticParams
      ? dynamicApiLabel(kind === 'handler' ? [source] : [source, ...layoutSources], kind)
      : undefined
  const ppr =
    kind === 'page' &&
    usesRequest &&
    parts.params.length === 0 &&
    !parts.catchAll &&
    exportsExperimentalPpr([source, ...layoutSources])

  const directClient = kind === 'page' && hasUseClientDirective(routeFile, source)
  const clientReferences =
    kind === 'page'
      ? collectClientReferences(
          context,
          directClient
            ? [...layoutFiles, ...templateFiles, ...specialFiles, ...slotFiles]
            : entryFiles,
        )
      : []
  const client =
    directClient ||
    clientReferences.some(
      reference => reference.file === routeFile && reference.exportName === 'default',
    )
  const stream =
    kind === 'page'
      ? routeStreamMetadata({ context, layoutFiles, templateFiles, specialFiles })
      : undefined
  const cssImports =
    kind === 'page'
      ? collectCssImports(
          context,
          cssEntryOrder({ routeFile, layoutFiles, templateFiles, specialFiles, slotFiles }),
          { route: true },
        )
      : []
  if (kind === 'page') attachLazyReferenceCss(context, clientReferences)

  const interception = parts.interception
  return {
    mode: interception ? 'dynamic' : inferRouteMode(parts, usesRequest, segmentConfig),
    hasStaticParams: interception ? false : hasStaticParams,
    usesRequest,
    ...(handlerUsesRevalidationApi ? { handlerUsesRevalidationApi: true as const } : {}),
    ...(dynamicErrorApi ? { dynamicErrorApi } : {}),
    client,
    clientReferences,
    cssImports,
    sourceFiles,
    ...(kind === 'page' ? serverActionFileFact(context, sourceFiles) : {}),
    ...(stream ? { stream } : {}),
    maxDuration: maxDurationFromSources([source, ...layoutSources]),
    ppr: interception ? false : ppr,
    ...(segmentConfig ? { segmentConfig } : {}),
    ...routerEntryFact(context, {
      kind,
      client,
      clientReferences,
      sourceFiles,
      // Only slot-derived interception entries carry a slotDir.
      slotInterceptor: false,
      table,
    }),
  }
}

/**
 * Why this page needs the client router entry, as a reason list rather than a yes/no - the client build gates
 * its feature regions on the reasons, so a page that only renders <Link> must not be told "you need
 * everything".
 *
 * <Link> emits interactive `<a data-pnext-link>` anchors the soft-navigation runtime drives (prefetch, soft
 * nav, scroll/focus). Without a client component the page would otherwise ship no entry, so the router never
 * installs and every Link falls back to a full document load.
 */
function routerEntryFact(
  context: ScanContext,
  options: {
    kind: 'page' | 'handler'
    client: boolean
    clientReferences: ClientReference[]
    sourceFiles: string[]
    slotInterceptor: boolean
    table: TableFlags
  },
): { needsRouterEntry?: true; clientEntryReasons?: ClientEntryReason[] } {
  if (options.kind !== 'page') return {}
  const reasons: ClientEntryReason[] = []
  // Slot interceptors never render standalone (the origin page hosts them);
  // children interceptors render directly and need the runtime.
  if (options.table.parallelRoutes && !options.slotInterceptor) reasons.push('parallel-routes')
  // Compat parity: Next ships its router bootstrap on every app page, so a page
  // with no client code of its own still hydrates (and runs
  // instrumentation-client before hydration).
  reasons.push(...alwaysClientEntryReasons())
  // A page with client code of its own already ships an entry, so the <Link> scan only exists to catch the
  // pages that otherwise would not. The remaining reasons gate feature regions INSIDE the entry (the action
  // runtime), so they are scanned for every page - a page's inline `'use server'` action is usually handed to
  // an island it also renders.
  if (!options.client && options.clientReferences.length === 0) {
    if (routeUsesLinkComponent(context, options.sourceFiles)) reasons.push('link')
  } else if (routeUsesNavigation(context, options.sourceFiles)) {
    // The complement of the branch above: a page that already ships an entry
    // never needed a reason before, so nothing here changes whether the entry
    // exists — it decides whether that entry carries the router at all.
    reasons.push('router-api')
  }
  reasons.push(...routeClientEntryReasons(context, options.sourceFiles))
  if (reasons.length === 0) return {}
  return { needsRouterEntry: true, clientEntryReasons: [...new Set(reasons)] }
}

/**
 * Record one more reason a route needs the client entry, from a consumer that
 * learns it after the scan (the build discovers server actions only once action
 * discovery has run). Keeps `needsRouterEntry` in step with the reason list.
 */
export function addClientEntryReason(route: RouteManifestEntry, reason: ClientEntryReason): void {
  const reasons = route.clientEntryReasons ?? []
  if (!reasons.includes(reason)) route.clientEntryReasons = [...reasons, reason]
  route.needsRouterEntry = true
}

function routeStreamMetadata(options: {
  context: ScanContext
  layoutFiles: string[]
  templateFiles: string[]
  specialFiles: string[]
}) {
  const existingSpecialFiles = options.specialFiles.filter(item => existsSync(item))
  const hasLoadingBoundary = existingSpecialFiles.some(file =>
    /(^|[/\\])loading\.[^.]+$/.test(file),
  )
  // Compute the ancestor client-reference closure for EVERY page, not just loading.js routes. Streaming
  // isolates each Suspense boundary and drops client-provider context from ancestor layouts, so the
  // render-time stream gate keys off this list - a route with in-page user Suspense boundaries but no
  // loading.js still streams as long as no ancestor layout/template ships a client reference.
  const ancestorClientReferences = collectClientReferences(options.context, [
    ...options.layoutFiles,
    ...options.templateFiles,
  ])
  return {
    ...(hasLoadingBoundary ? { hasLoadingBoundary } : {}),
    ...(ancestorClientReferences.length > 0
      ? { ancestorClientReferences: ancestorClientReferences.map(reference => reference.id) }
      : {}),
  }
}

function hasStaticParamsExport(source: string) {
  const searchable = stripCommentsAndStrings(source)
  return (
    /\bexport\s+(?:async\s+)?function\s+(?:params|generateStaticParams)\b/.test(searchable) ||
    /\bexport\s+const\s+(?:params|generateStaticParams)\b/.test(searchable)
  )
}

/** All `@slot` directories on the walk from the app root to the route's dir. */
function chainSlotDirs(appPath: string, routeFilePath: string) {
  const dirs: string[] = []
  let dir = path.dirname(routeFilePath)
  while (dir.startsWith(appPath)) {
    dirs.push(...slotDirectoriesIn(dir))
    if (dir === appPath) break
    dir = path.dirname(dir)
  }
  return dirs.reverse()
}

/** Every convention file in the given slot trees (recursive). */
function slotTreeFiles(slotDirs: string[]) {
  const files: string[] = []
  const pattern = slotConventionPattern()
  for (const dir of slotDirs) {
    for (const file of listFilesSync(dir)) {
      if (pattern.test(toPosixPath(file))) files.push(file)
    }
  }
  return files
}

/**
 * Second scan pass over pages that live inside `@slot` directories. Each slot
 * page implies a URL (its owner path plus its slot-internal path). A page with
 * an interception marker produces an interception entry (matched only on soft
 * navigation); other slot pages make their URL routable via a synthetic entry
 * whose children tree renders the nearest `default.*` (hard-nav semantics)
 * while the slot content resolves at render time.
 */
function appendSlotDerivedRoutes(
  context: ScanContext,
  routes: RouteManifestEntry[],
  slotPages: { file: string; relative: string }[],
  table: TableFlags,
) {
  const appPath = context.appPath
  const patterns = new Set(routes.filter(route => !route.interception).map(route => route.pattern))
  const interceptionKeys = new Set(
    routes
      .filter(route => route.interception)
      .map(route => `${route.pattern}#${route.interception!.base}`),
  )

  const candidates = slotPages
    .map(({ file, relative }) => {
      const segments = relative.split('/')
      const slotIndex = segments.findIndex(isSlotSegment)
      const slotDir = path.join(appPath, ...segments.slice(0, slotIndex + 1))
      return {
        file,
        relative,
        slotDir,
        ownerDir: path.dirname(slotDir),
        parts: routeParts(relative.replace(pageOrRouteTrailing(), '')),
        innerNames: segments
          .slice(slotIndex + 1, -1)
          .filter(name => !isSlotSegment(name) && !isGroupSegment(name)),
      }
    })
    // Deepest owner first: a URL reachable through several slots anchors its
    // layout chain at the most specific segment.
    .sort((a, b) => b.ownerDir.length - a.ownerDir.length)

  for (const candidate of candidates) {
    const { parts } = candidate
    if (parts.interception) {
      const key = `${parts.pattern}#${parts.interception.base}`
      if (interceptionKeys.has(key)) continue
      interceptionKeys.add(key)
      // Never rendered directly: a matching soft navigation renders the
      // CURRENT page (the from-path's entry) and this slot resolves the
      // interceptor during slot rendering. Kept minimal on purpose.
      routes.push(
        withDeferredFacts(
          appPath,
          {
            id: `intercept-${sanitizeIdPart(candidate.relative.replace(pageOrRouteTrailing(), ''))}`,
            kind: 'page',
            route: parts.route,
            pattern: parts.pattern,
            file: candidate.file,
            params: parts.params,
            catchAll: parts.catchAll,
            ...(parts.catchAllOptional ? { catchAllOptional: true } : {}),
            interception: { ...parts.interception, slotDir: candidate.slotDir },
          },
          () => ({
            ...emptyDerivedFacts,
            ...routerEntryFact(context, {
              kind: 'page',
              client: false,
              clientReferences: [],
              sourceFiles: [],
              slotInterceptor: true,
              table,
            }),
          }),
        ),
      )
      continue
    }

    if (patterns.has(parts.pattern)) continue
    patterns.add(parts.pattern)

    const childrenDefault = childrenDefaultFile(candidate.ownerDir, candidate.innerNames)
    // The anchor only positions the entry in the app tree (layouts, templates,
    // boundaries, slot chain). Prefer a real file: the children default, then an
    // explicit `@children` page, then the owner's own page. A non-existent
    // `<owner>/page.tsx` would break the build when the URL is served purely by
    // slots, so fall back to the slot page itself as a last resort.
    const anchor =
      childrenDefault ??
      slotConventionFile(path.join(candidate.ownerDir, '@children'), 'page') ??
      slotConventionFile(candidate.ownerDir, 'page') ??
      candidate.file
    const layoutFiles = findLayouts(appPath, anchor)
    const templateFiles = findConventionFiles(appPath, anchor, 'template')
    const specialFiles = boundaryConventions().flatMap(name =>
      findConventionFiles(appPath, anchor, name),
    )
    const slotDirs = chainSlotDirs(appPath, anchor)
    const slotFiles = slotTreeFiles(slotDirs)
    const extraBoundaries = new Set(extraBoundaryConventionNames())
    const forbiddenPaths = extraBoundaries.has('forbidden')
      ? findConventionFiles(appPath, anchor, 'forbidden').filter(item => existsSync(item))
      : []
    const unauthorizedPaths = extraBoundaries.has('unauthorized')
      ? findConventionFiles(appPath, anchor, 'unauthorized').filter(item => existsSync(item))
      : []
    const templatePaths = templateFiles.filter(item => existsSync(item))

    routes.push(
      withDeferredFacts(
        appPath,
        {
          id: `slot-${routeId(parts.route || '/')}`,
          kind: 'page',
          route: parts.route,
          pattern: parts.pattern,
          file: anchor,
          params: parts.params,
          catchAll: parts.catchAll,
          ...(parts.catchAllOptional ? { catchAllOptional: true } : {}),
          ...(templatePaths.length > 0 ? { templateFiles: templatePaths } : {}),
          ...(slotDirs.length > 0 ? { slotDirs } : {}),
          synthetic: true,
          syntheticSlotDir: candidate.slotDir,
          ...(childrenDefault ? { childrenDefault } : {}),
          ...(forbiddenPaths.length > 0 ? { forbiddenFiles: forbiddenPaths } : {}),
          ...(unauthorizedPaths.length > 0 ? { unauthorizedFiles: unauthorizedPaths } : {}),
        },
        () =>
          derivedRouteFacts(context, {
            leadFiles: childrenDefault ? [childrenDefault] : [],
            layoutFiles,
            templateFiles,
            specialFiles,
            slotFiles,
            clientFile: childrenDefault,
            table,
          }),
      ),
    )
  }
}

/** Facts shared by every derived entry: dynamic, request-rendered, never prerendered. */
const emptyDerivedFacts = {
  mode: 'dynamic',
  hasStaticParams: false,
  usesRequest: true,
  client: false,
  clientReferences: [],
  cssImports: [],
  sourceFiles: [],
} satisfies RouteFacts

/**
 * Content facts of a synthetic slot / default entry. Its tree is the convention
 * chain around the anchor — the entry has no page file of its own to scan.
 */
function derivedRouteFacts(
  context: ScanContext,
  options: {
    /** Files that lead the entry tree (children default) or ARE it (a default.tsx). */
    leadFiles: string[]
    layoutFiles: string[]
    templateFiles: string[]
    specialFiles: string[]
    slotFiles: string[]
    /** File whose `'use client'` directive decides the entry's own `client` flag. */
    clientFile?: string
    /** Lead file also participates in CSS order as the route file (default entries). */
    leadIsRouteFile?: boolean
    table: TableFlags
  },
): RouteFacts {
  const { leadFiles, layoutFiles, templateFiles, specialFiles, slotFiles } = options
  const entryFiles = [...leadFiles, ...layoutFiles, ...templateFiles, ...specialFiles, ...slotFiles]
  const sourceFiles = collectSourceFiles(context, entryFiles)
  const clientReferences = collectClientReferences(context, entryFiles)
  const cssImports = collectCssImports(
    context,
    cssEntryOrder({
      ...(options.leadIsRouteFile ? { routeFile: leadFiles[0] } : { leadFiles }),
      layoutFiles,
      templateFiles,
      specialFiles,
      slotFiles,
    }),
    { route: true },
  )
  attachLazyReferenceCss(context, clientReferences)
  const client = options.clientFile ? isClientModule(context, options.clientFile) : false

  return {
    ...emptyDerivedFacts,
    client,
    clientReferences,
    cssImports,
    sourceFiles,
    ...routerEntryFact(context, {
      kind: 'page',
      client,
      clientReferences,
      sourceFiles,
      slotInterceptor: false,
      table: options.table,
    }),
  }
}

/**
 * Second pass: a segment directory that owns a `default.tsx` but no `page.tsx`
 * still renders (its `default` is the children fallback for that active but
 * pageless segment). Without a route entry the request would fall through to a
 * higher catch-all, so we synthesize one whose page file IS the `default.tsx`.
 * Its route/pattern are more specific than a higher `[[...catchAll]]`, so the
 * matcher and `routeRank` prefer the default segment (Next: default > catch-all).
 * Skipped when a real `page.tsx` already produced an entry for the same pattern.
 */
function appendDefaultDerivedRoutes(
  context: ScanContext,
  routes: RouteManifestEntry[],
  defaultPages: { file: string; relative: string }[],
  table: TableFlags,
) {
  const appPath = context.appPath
  const patterns = new Set(routes.filter(route => !route.interception).map(route => route.pattern))

  for (const { file, relative } of defaultPages) {
    const dir = path.dirname(file)
    // A sibling page.tsx means the segment already has a normal entry.
    if (conventionFileName(dir, 'page')) continue
    const parts = routeParts(relative.replace(pageOrRouteTrailing(), ''))
    if (parts.interception) continue
    if (patterns.has(parts.pattern)) continue
    patterns.add(parts.pattern)

    const layoutFiles = findLayouts(appPath, file)
    const templateFiles = findConventionFiles(appPath, file, 'template')
    const specialFiles = boundaryConventions().flatMap(name =>
      findConventionFiles(appPath, file, name),
    )
    const slotDirs = chainSlotDirs(appPath, file)
    const slotFiles = slotTreeFiles(slotDirs)
    const extraBoundaries = new Set(extraBoundaryConventionNames())
    const forbiddenPaths = extraBoundaries.has('forbidden')
      ? findConventionFiles(appPath, file, 'forbidden').filter(item => existsSync(item))
      : []
    const unauthorizedPaths = extraBoundaries.has('unauthorized')
      ? findConventionFiles(appPath, file, 'unauthorized').filter(item => existsSync(item))
      : []
    const templatePaths = templateFiles.filter(item => existsSync(item))

    routes.push(
      withDeferredFacts(
        appPath,
        {
          id: `default-${routeId(parts.route || '/')}`,
          kind: 'page',
          route: parts.route,
          pattern: parts.pattern,
          file,
          params: parts.params,
          catchAll: parts.catchAll,
          ...(parts.catchAllOptional ? { catchAllOptional: true } : {}),
          ...(templatePaths.length > 0 ? { templateFiles: templatePaths } : {}),
          ...(slotDirs.length > 0 ? { slotDirs } : {}),
          ...(forbiddenPaths.length > 0 ? { forbiddenFiles: forbiddenPaths } : {}),
          ...(unauthorizedPaths.length > 0 ? { unauthorizedFiles: unauthorizedPaths } : {}),
        },
        () =>
          derivedRouteFacts(context, {
            leadFiles: [file],
            leadIsRouteFile: true,
            layoutFiles,
            templateFiles,
            specialFiles,
            slotFiles,
            clientFile: file,
            table,
          }),
      ),
    )
  }
}

export function findLayouts(appPath: string, routeFilePath: string) {
  return findConventionFiles(appPath, routeFilePath, 'layout')
}

/**
 * CSS imported by the app's ROOT `not-found.*` (and its module graph), in
 * source order, excluding the root-layout global CSS (which is served
 * separately via `/assets/global.css`). Used to give the synthetic 404 route
 * its own stylesheet: an unmatched URL rendering the root not-found must ship
 * BOTH the root layout CSS (the global sheet) AND the not-found's own CSS.
 * Returns [] when the app has no root not-found file (built-in fallback).
 */
export async function collectNotFoundCss(appPath: string): Promise<string[]> {
  const notFoundFile = conventionFileName(appPath, 'not-found')
  if (!notFoundFile) return []
  return collectFileCss(appPath, [notFoundFile])
}

/**
 * CSS imported by `files` (and their module graphs), in source order. By default the root-layout global CSS
 * is excluded, served separately via `/assets/global.css`; `includeGlobalCss` keeps it - for
 * document-replacing conventions (global-not-found) that render WITHOUT the root layout, so a stylesheet
 * shared with the root layout must still ship in their own chunk. Used to give render-time synthetic routes
 * their own stylesheet outside the scan-built manifest.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function collectFileCss(
  appPath: string,
  files: string[],
  options: { includeGlobalCss?: boolean } = {},
): Promise<string[]> {
  const existing = files.filter(file => existsSync(file))
  if (existing.length === 0) return []
  const context = createScanContext(
    appPath,
    options.includeGlobalCss ? () => new Set<string>() : undefined,
  )
  return collectCssImports(context, existing)
}

/**
 * Walk from the route's directory up to `appPath`, returning one convention file per segment ordered
 * root-to-leaf. `name` may be a bare base (`'layout'`) or carry an extension - a known extension is stripped
 * so the full extension list is tried. Each segment resolves to the first existing `<base>.<ext>`; when none
 * exists the `.tsx` candidate is returned so existing callers that filter by `existsSync` keep
 * byte-identical behavior.
 */
export function findConventionFiles(appPath: string, routeFilePath: string, name: string) {
  const base = conventionBase(name)
  const files: string[] = []
  let dir = path.dirname(routeFilePath)

  while (dir.startsWith(appPath)) {
    files.push(conventionFileName(dir, base) ?? path.join(dir, `${base}.tsx`))
    if (dir === appPath) break
    dir = path.dirname(dir)
  }

  return files.reverse()
}

function conventionBase(name: string) {
  const match = new RegExp(`\\.(${pageExtensions().join('|')})$`).exec(name)
  return match ? name.slice(0, -match[0].length) : name
}

/** App-root `global-error.*` file, if present (BuildManifest.globalErrorFile). */
export function findGlobalError(appPath: string) {
  return conventionFileName(appPath, globalErrorBase)
}

export function matchRoute(routes: RouteManifestEntry[], pathname: string) {
  // Trailing-slash tolerance: '/route/' matches the same entry as '/route'
  // (Next redirects these away; static file serving already accepts both).
  const normalized = normalizePathname(pathname)
  for (const route of routes) {
    // Interception entries never match a plain (hard) request; they apply
    // only through matchInterception on soft navigations.
    if (route.interception) continue
    const match = routeRegex(route).exec(normalized)
    if (!match) continue
    return { route, params: routeMatchParams(route, match) }
  }
  return null
}

export function normalizePathname(pathname: string) {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') || '/' : pathname
}

function routeMatchParams(route: RouteManifestEntry, match: RegExpExecArray) {
  const params: Record<string, RouteParamValue> = {}
  route.params.forEach((name, index) => {
    const decoded = safeDecode(match[index + 1] ?? '')
    // A runtime request whose segment IS the dynamic placeholder for its own
    // param (`[slug]`, whether sent raw or as `%5Bslug%5D`) is Next's "params
    // placeholder": it must surface the ENCODED placeholder (`%5Bslug%5D`), not
    // a decoded `[slug]`. A decoded `[slug]` reads as a fallback param and would
    // trigger a fallback-shell render (failing without a parent Suspense
    // boundary); Next keeps it URL-encoded to render at runtime instead.
    // Fallback-shell generation injects its placeholder params through a
    // separate build path, so this only affects live requests.
    params[name] = decoded === `[${name}]` ? encodeURIComponent(decoded) : decoded
  })
  if (route.catchAll) {
    params[route.catchAll] = (match[route.params.length + 1] ?? '')
      .split('/')
      .filter(Boolean)
      .map(safeDecode)
  }
  return params
}

export interface InterceptionRouteMatch {
  route: RouteManifestEntry
  params: Record<string, RouteParamValue>
}

/**
 * Match a soft navigation against interception entries: the entry's target
 * pattern must match the destination and the navigation must originate at or
 * below the interceptor's base (the children path the current document
 * rendered from). The deepest base wins. A no-op when destination equals the
 * origin (a refresh re-renders whatever produced the current document).
 */
export function matchInterception(
  routes: RouteManifestEntry[],
  pathname: string,
  fromPath: string | undefined,
): InterceptionRouteMatch | null {
  if (!fromPath) return null
  const target = normalizePathname(pathname)
  const from = normalizePathname(fromPath)
  if (target === from) return null
  let best: InterceptionRouteMatch | null = null
  let bestDepth = -1
  for (const route of routes) {
    const interception = route.interception
    if (!interception) continue
    const match = routeRegex(route).exec(target)
    if (!match) continue
    const basePattern = interception.basePattern ? `/${interception.basePattern}` : ''
    if (!new RegExp(`^${basePattern}(?:/.*)?$`).test(from)) continue
    const depth = interception.base.split('/').filter(Boolean).length
    if (depth <= bestDepth) continue
    bestDepth = depth
    best = { route, params: routeMatchParams(route, match) }
  }
  return best
}

export interface RouteRenderSelection {
  route: RouteManifestEntry
  params: Record<string, RouteParamValue>
  /** Pathname the children tree renders from (normalized). */
  childrenPath: string
  /** Internal pathname after rewrites, used to resolve interception slots. */
  targetPath: string
}

/**
 * Pick the entry a page request renders. Hard requests match plainly. Soft navigations first consult
 * interception entries; a slot interception (and a synthetic slot URL reached with known origin) renders the
 * ORIGIN's entry as host - the current page stays while the slot content changes - with the children tree
 * anchored at `childrenPath`.
 */
export function selectRouteForRequest(
  routes: RouteManifestEntry[],
  pathname: string,
  nav?: import('../types').NavState,
): RouteRenderSelection | null {
  const target = normalizePathname(pathname)
  if (nav) {
    const intercepted = matchInterception(routes, target, nav.children)
    if (intercepted) {
      if (!intercepted.route.interception?.slotDir) {
        return {
          route: intercepted.route,
          params: intercepted.params,
          childrenPath: target,
          targetPath: target,
        }
      }
      const host = hostMatch(routes, nav.children)
      if (host) return { ...host, targetPath: target }
    }
  }
  const matched = matchRoute(routes, target)
  if (!matched) return null
  if (nav && matched.route.synthetic && nav.children) {
    const primary = matchRoute(
      routes.filter(route => !route.synthetic),
      target,
    )
    const syntheticOwner = matched.route.syntheticSlotDir
      ? path.dirname(matched.route.syntheticSlotDir)
      : undefined
    const primaryFromOwner =
      primary && syntheticOwner ? path.relative(syntheticOwner, primary.route.file) : undefined
    if (
      primary &&
      primaryFromOwner !== undefined &&
      primaryFromOwner !== '..' &&
      !primaryFromOwner.startsWith(`..${path.sep}`)
    ) {
      return {
        route: primary.route,
        params: primary.params,
        childrenPath: target,
        targetPath: target,
      }
    }
    const host = hostMatch(routes, nav.children)
    if (
      host &&
      host.route !== matched.route &&
      matched.route.syntheticSlotDir &&
      host.route.slotDirs?.includes(matched.route.syntheticSlotDir)
    ) {
      return { ...host, targetPath: target }
    }
  }
  return {
    route: matched.route,
    params: matched.params,
    childrenPath: target,
    targetPath: target,
  }
}

/**
 * Navigation headers from the client soft-nav runtime: `x-pnext-soft-nav`
 * marks the fetch and `x-pnext-nav-state` carries the current document's
 * parallel-route state (URI-encoded JSON).
 */
export function parseNavState(request: Request): NavState | undefined {
  if (!request.headers.get('x-pnext-soft-nav')) return undefined
  const raw = request.headers.get('x-pnext-nav-state')
  if (!raw) return {}
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as unknown
    if (parsed && typeof parsed === 'object') return parsed
  } catch {
    // Malformed state degrades to a plain soft navigation.
  }
  return {}
}

function hostMatch(
  routes: RouteManifestEntry[],
  fromPath: string | undefined,
): RouteRenderSelection | null {
  if (!fromPath) return null
  const from = normalizePathname(fromPath)
  const host = matchRoute(routes, from)
  if (host?.route.kind !== 'page') return null
  return { route: host.route, params: host.params, childrenPath: from, targetPath: from }
}

const routeRegexCache = new WeakMap<RouteManifestEntry, RegExp>()

function routeRegex(route: RouteManifestEntry) {
  let regex = routeRegexCache.get(route)
  if (!regex) {
    regex = new RegExp(`^${route.pattern}$`)
    routeRegexCache.set(route, regex)
  }
  return regex
}

interface RouteSegmentToken {
  route: string
  /** Regex piece; absent for the optional catch-all (assembled specially). */
  pattern?: string
  param?: string
  catchAll?: string
  catchAllOptional?: boolean
}

function segmentTokenOf(bare: string): RouteSegmentToken {
  const optionalCatchAllMatch = /^\[\[\.\.\.([^\]]+)\]\]$/.exec(bare)
  if (optionalCatchAllMatch?.[1]) {
    const name = optionalCatchAllMatch[1]
    return { route: `:${name}*`, catchAll: name, catchAllOptional: true }
  }
  const catchAllMatch = /^\[\.\.\.([^\]]+)\]$/.exec(bare)
  if (catchAllMatch?.[1]) {
    return { route: `:${catchAllMatch[1]}*`, pattern: '(.*)', catchAll: catchAllMatch[1] }
  }
  const paramMatch = /^\[([^\]]+)\]$/.exec(bare)
  if (paramMatch?.[1]) {
    return { route: `:${paramMatch[1]}`, pattern: '([^/]+)', param: paramMatch[1] }
  }
  const literal = decodeLiteralSegment(bare)
  return { route: literal, pattern: escapeRegex(literal) }
}

// A path is private when any of its directory segments begins with `_`, except
// route groups `(name)`, slots `@slot`, and `%5F`-encoded segments (which
// decode to a routable leading underscore). The filename segment is excluded.
function isPrivateAppPath(relative: string): boolean {
  const segments = relative.split('/')
  return segments
    .slice(0, -1)
    .some(segment => segment.startsWith('_') && !isGroupSegment(segment) && !isSlotSegment(segment))
}

// A literal (non-dynamic) path segment: `%5F` decodes to `_` so a directory
// named `%5Ffoo` on disk routes as `/_foo`. Other percent escapes are left
// as-is (the router decodes params at match time).
function decodeLiteralSegment(segment: string): string {
  return segment.replace(/%5[Ff]/g, '_')
}

function routeParts(routeDir: string): RouteParts {
  const segments = routeDir.split('/').filter(Boolean)
  let tokens: RouteSegmentToken[] = []
  let interception: RouteParts['interception']

  for (const segment of segments) {
    // Route group `(name)`: organizational only. `@slot`: no path segment.
    if (isGroupSegment(segment) || isSlotSegment(segment)) continue

    const marker = interceptionMarkerOf(segment)
    let bare = segment
    if (marker) {
      // The interception target rewinds `levels` URL segments from the
      // marker's position; the segments before the marker form the base the
      // interceptor renders within.
      bare = segment.slice(marker.length)
      const base = tokens.slice()
      const levels = interceptionMarkerLevels(marker)
      tokens =
        levels === Number.POSITIVE_INFINITY
          ? []
          : tokens.slice(0, Math.max(0, tokens.length - levels))
      interception = {
        marker,
        base: `/${base.map(token => token.route).join('/')}`.replace(/\/$/, '') || '/',
        basePattern: base.map(token => token.pattern ?? '(.*)').join('/'),
      }
    }

    tokens.push(segmentTokenOf(bare))
  }

  const params = tokens.filter(token => token.param).map(token => token.param!)
  const catchAllToken = tokens.find(token => token.catchAll)
  const routeSegments = tokens.map(token => token.route)
  const patternSegments = tokens
    .filter(token => !token.catchAllOptional)
    .map(token => token.pattern!)

  const route = `/${routeSegments.join('/')}`.replace(/\/$/, '') || '/'
  let pattern: string
  if (catchAllToken?.catchAllOptional) {
    // `[[...slug]]` matches the base path and any nested path: the whole
    // trailing group (including its leading slash) is optional.
    const prefix = patternSegments.length > 0 ? `/${patternSegments.join('/')}` : ''
    pattern = `${prefix}(?:/(.*))?`
    if (pattern === '(?:/(.*))?') pattern = '/?(?:(.*))?'
  } else {
    pattern = route === '/' ? '/' : `/${patternSegments.join('/')}`
  }
  return {
    route,
    pattern,
    params,
    catchAll: catchAllToken?.catchAll,
    catchAllOptional: Boolean(catchAllToken?.catchAllOptional),
    interception,
  }
}

interface DynamicMetadataRouteParts extends RouteParts {
  metadataRoute: MetadataRouteEntry
}

function dynamicMetadataRouteParts(
  relative: string,
  source: string,
): DynamicMetadataRouteParts | undefined {
  const name = path.basename(relative)
  const dir = path.dirname(relative) === '.' ? '' : path.dirname(relative)
  const root = dir === ''
  const extension = path.extname(name)
  const base = name.slice(0, -extension.length)
  const kind = dynamicMetadataKind(base, root)
  if (!kind) return undefined

  const prefix = routeParts(dir)
  const generatedParam = metadataGeneratedParam(kind, source)
  const final = dynamicMetadataFinalSegment(kind, base, dir, Boolean(generatedParam))
  return {
    ...appendRouteParts(prefix, final.route, final.pattern, generatedParam ? [generatedParam] : []),
    metadataRoute: {
      kind,
      ...(generatedParam ? { generatedParam } : {}),
    },
  }
}

function dynamicMetadataKind(base: string, root: boolean): MetadataRouteKind | undefined {
  if (base === 'robots') return root ? 'robots' : undefined
  if (base === 'sitemap') return 'sitemap'
  if (base === 'manifest') return root ? 'manifest' : undefined
  if (/^icon\d*$/.test(base)) return 'icon'
  if (/^apple-icon\d*$/.test(base)) return 'apple-icon'
  if (/^opengraph-image\d*$/.test(base)) return 'opengraph-image'
  if (/^twitter-image\d*$/.test(base)) return 'twitter-image'
  return undefined
}

function metadataGeneratedParam(kind: MetadataRouteKind, source: string) {
  if (kind === 'sitemap' && /\bexport\s+(?:async\s+)?function\s+generateSitemaps\b/.test(source)) {
    return '__metadata_id__'
  }
  if (
    metadataImageKind(kind) &&
    /\bexport\s+(?:async\s+)?function\s+generateImageMetadata\b/.test(source)
  ) {
    return '__metadata_id__'
  }
  return undefined
}

function dynamicMetadataFinalSegment(
  kind: MetadataRouteKind,
  base: string,
  relativeDir: string,
  generated: boolean,
) {
  if (kind === 'robots') return { route: 'robots.txt', pattern: 'robots\\.txt' }
  if (kind === 'manifest')
    return { route: 'manifest.webmanifest', pattern: 'manifest\\.webmanifest' }
  if (kind === 'sitemap') {
    return generated
      ? { route: 'sitemap/:id.xml', pattern: 'sitemap/([^/]+)\\.xml' }
      : { route: 'sitemap.xml', pattern: 'sitemap\\.xml' }
  }

  const suffix = metadataRouteSuffix(relativeDir)
  const imageBase = suffix ? `${base}-${suffix}` : base
  return generated
    ? { route: `${imageBase}/:id`, pattern: `${escapeRegex(imageBase)}/([^/]+)` }
    : { route: imageBase, pattern: escapeRegex(imageBase) }
}

function appendRouteParts(parts: RouteParts, route: string, pattern: string, params: string[]) {
  const prefixRoute = parts.route === '/' ? '' : parts.route
  const prefixPattern = parts.pattern === '/' ? '' : parts.pattern
  return {
    ...parts,
    route: `${prefixRoute}/${route}`.replace(/\/$/, '') || '/',
    pattern: `${prefixPattern}/${pattern}`,
    params: [...parts.params, ...params],
  }
}

function metadataImageKind(kind: MetadataRouteKind) {
  return (
    kind === 'icon' ||
    kind === 'apple-icon' ||
    kind === 'opengraph-image' ||
    kind === 'twitter-image'
  )
}

function metadataRouteUsesRequest(source: string) {
  // routeHandlerUsesRequest already consults the compat usageDetection seam
  // (next/headers, next/server connection(), ...).
  return routeHandlerUsesRequest(source)
}

function metadataRouteSuffix(relativeDir: string) {
  if (!relativeDir) return ''
  const segments = relativeDir.split('/').filter(Boolean)
  if (!segments.some(segment => isGroupSegment(segment) || isSlotSegment(segment))) return ''
  return djb2Hash(`/${relativeDir}`).toString(36).slice(0, 6)
}

function djb2Hash(value: string) {
  let hash = 5381
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) & 0xffffffff
  }
  return hash >>> 0
}

function inferRouteMode(
  parts: RouteParts,
  usesRequest: boolean,
  config?: RouteSegmentConfig,
): RouteMode {
  if (config?.dynamic === 'force-dynamic') return 'dynamic'
  if (config?.revalidate === 0) return 'dynamic'
  if (config?.fetchCache === 'force-no-store') return 'dynamic'
  if (config?.dynamic === 'force-static') return 'static'
  if (config?.dynamic === 'error') return 'static'
  if (usesRequest) return 'dynamic'
  if (parts.params.length > 0 || parts.catchAll) return 'dynamic'
  return 'static'
}

interface ParsedSegmentConfig {
  dynamic?: RouteSegmentConfig['dynamic']
  revalidate?: number | false
  fetchCache?: RouteSegmentConfig['fetchCache']
  dynamicParams?: boolean
  runtime?: string
  prefetch?: RouteSegmentConfig['prefetch']
  unstableInstant?: boolean
  /** Literal but invalid `export const revalidate` value (build error in Next). */
  invalidRevalidate?: string
}

function parseSegmentConfig(source: string): ParsedSegmentConfig {
  const searchable = stripComments(source)
  const parsed: ParsedSegmentConfig = {}
  const dynamicMatch =
    /^\s*export\s+const\s+dynamic\s*=\s*['"](auto|force-dynamic|error|force-static)['"]/m.exec(
      searchable,
    )
  if (dynamicMatch) parsed.dynamic = dynamicMatch[1] as RouteSegmentConfig['dynamic']
  const revalidateMatch = /^\s*export\s+const\s+revalidate\s*=\s*(\d+|false)\s*;?\s*$/m.exec(
    searchable,
  )
  if (revalidateMatch) {
    parsed.revalidate = revalidateMatch[1] === 'false' ? false : Number(revalidateMatch[1])
  } else {
    // Invalid literal values (strings, negatives) are a build error in Next.
    const invalid = /^\s*export\s+const\s+revalidate\s*=\s*(['"]([^'"]*)['"]|-\d+)/m.exec(
      searchable,
    )
    if (invalid) parsed.invalidRevalidate = invalid[2] ?? invalid[1]
  }
  const fetchCacheMatch =
    /^\s*export\s+const\s+fetchCache\s*=\s*['"](auto|default-cache|only-cache|force-cache|force-no-store|default-no-store|only-no-store)['"]/m.exec(
      searchable,
    )
  if (fetchCacheMatch) parsed.fetchCache = fetchCacheMatch[1] as RouteSegmentConfig['fetchCache']
  const dynamicParamsMatch = /^\s*export\s+const\s+dynamicParams\s*=\s*(true|false)/m.exec(
    searchable,
  )
  if (dynamicParamsMatch) parsed.dynamicParams = dynamicParamsMatch[1] === 'true'
  const runtimeMatch = /^\s*export\s+const\s+runtime\s*=\s*['"](edge|nodejs)['"]/m.exec(searchable)
  if (runtimeMatch) parsed.runtime = runtimeMatch[1]
  const prefetchMatch =
    /^\s*export\s+const\s+prefetch\s*=\s*['"](allow-runtime|partial|unstable_eager)['"]/m.exec(
      searchable,
    )
  if (prefetchMatch) parsed.prefetch = prefetchMatch[1] as RouteSegmentConfig['prefetch']
  // `unstable_instant = true | false | {…samples}` — an object literal opts in
  // like `true` (its samples refine the runtime-prefetch render, they don't
  // gate it).
  const instantMatch = /^\s*export\s+const\s+unstable_instant\s*=\s*(true|false|\{)/m.exec(
    searchable,
  )
  if (instantMatch) parsed.unstableInstant = instantMatch[1] !== 'false'
  return parsed
}

/**
 * Merge segment config exports across the route's own file and its layout
 * chain. `entries` are ordered leaf-first (page/handler first, then layouts
 * leaf->root): the leaf-most declaration of a field wins, except
 * `force-dynamic` (any segment forces the whole route) and `revalidate`
 * (the lowest declared number wins, Next-style).
 *
 * `dynamicParams = false` is resolved per param: it governs the params that
 * appear in the declaring file's own directory prefix, taking the leaf-most
 * declaration for each param.
 */
function segmentConfigFromEntries(
  appPath: string,
  entries: { file: string; source: string }[],
  parts: RouteParts,
): RouteSegmentConfig | undefined {
  const config: RouteSegmentConfig = {}
  let lowestRevalidate: number | undefined
  let sawRevalidateFalse = false
  const dynamicParamsByName = new Map<string, boolean>()
  const allParams = [...parts.params, ...(parts.catchAll ? [parts.catchAll] : [])]

  for (const entry of entries) {
    const parsed = parseSegmentConfig(entry.source)
    if (parsed.invalidRevalidate !== undefined) {
      throw new Error(
        `Invalid revalidate value "${parsed.invalidRevalidate}" on "${parts.route || '/'}", must be a non-negative number or false`,
      )
    }
    if (parsed.dynamic) {
      if (parsed.dynamic === 'force-dynamic') config.dynamic = 'force-dynamic'
      else if (!config.dynamic) config.dynamic = parsed.dynamic
    }
    if (parsed.revalidate !== undefined) {
      if (parsed.revalidate === false) sawRevalidateFalse = true
      else {
        lowestRevalidate =
          lowestRevalidate === undefined
            ? parsed.revalidate
            : Math.min(lowestRevalidate, parsed.revalidate)
      }
    }
    if (parsed.fetchCache && !config.fetchCache) config.fetchCache = parsed.fetchCache
    if (parsed.runtime && !config.runtime) config.runtime = parsed.runtime
    if (parsed.prefetch && !config.prefetch) config.prefetch = parsed.prefetch
    // Leaf-most declaration wins (entries are page-first): a page's explicit
    // `unstable_instant = false` overrides a layout's opt-in.
    if (parsed.unstableInstant !== undefined && config.unstableInstant === undefined) {
      config.unstableInstant = parsed.unstableInstant
    }
    if (parsed.dynamicParams !== undefined) {
      const param = paramOfOwnSegment(appPath, entry.file, allParams)
      if (param !== undefined && !dynamicParamsByName.has(param)) {
        dynamicParamsByName.set(param, parsed.dynamicParams)
      }
    }
  }

  if (lowestRevalidate !== undefined) config.revalidate = lowestRevalidate
  else if (sawRevalidateFalse) config.revalidate = false
  const governed = allParams.filter(param => dynamicParamsByName.get(param) === false)
  if (governed.length > 0) config.dynamicParamsFalse = governed

  return Object.keys(config).length > 0 ? config : undefined
}

/**
 * The route param introduced by the file's own directory segment, if any. A `dynamicParams` declaration
 * governs that segment only - it does not cascade to child segments (a layout at `[locale]/` governs
 * `locale` but not a `[slug]` below it).
 */
function paramOfOwnSegment(appPath: string, file: string, params: string[]) {
  const segments = toPosixPath(path.relative(appPath, path.dirname(file))).split('/')
  const own = segments[segments.length - 1]
  return params.find(
    param => own === `[${param}]` || own === `[...${param}]` || own === `[[...${param}]]`,
  )
}

// The parse is memoized per source, so the thousands of directive checks a
// scan makes cost one parse per file.
function hasUseClientDirective(file: string, source: string) {
  return scanFacts(file, source).useClient
}

/**
 * The first `'use server'` module REACHABLE from this PAGE's graph - `sourceFiles`
 * is the transitive import closure of the page, its layouts and everything they
 * render, so a directive file that nothing imports is not one of these. That
 * scoping is the contract: existence never refuses an app, reachability does.
 *
 * Pages only, by the caller. An action is dangerous when it can reach a CLIENT
 * boundary, and a route handler's graph cannot - it returns a Response, never
 * markup and never an island - so a directive reachable only from a handler is
 * inert. Refusing it would break an app that works, for no user-visible reason.
 *
 * Computed regardless of compat (the parse is already memoized); only core
 * CONSUMES it - see serverActionsUnsupportedMessage.
 */
function serverActionFileFact(context: ScanContext, sourceFiles: string[]) {
  for (const file of sourceFiles) {
    if (!fileExists(context, file) || isAssetFile(file)) continue
    if (scanFacts(file, readSource(context, file)).useServer) return { serverActionFile: file }
  }
  return {}
}

/**
 * Core has no action registry and no dispatch endpoint: `'use server'` is a
 * next-compat feature. Refusing by name beats the alternative core used to have -
 * building clean and rendering a form whose `action` was silently dropped.
 *
 * Read once, act once: the file, what pnext will not do, and both remedies. No
 * stack - the CLI prints `error.message` alone (cli/index.ts).
 */
export function serverActionsUnsupportedMessage(offender: {
  file: string
  route?: string
  root?: string
}) {
  const file = offender.root
    ? toPosixPath(path.relative(offender.root, offender.file))
    : offender.file
  const reach = offender.route ? `, reachable from the route ${offender.route}` : ''
  return [
    `Server actions need next compat, and this app is pure core.`,
    ``,
    `  ${file} has a 'use server' directive${reach}.`,
    ``,
    `pnext will not build this app: core has no server-action registry and no`,
    `dispatch endpoint, so the action could only render as a form that submits`,
    `nowhere.`,
    ``,
    `Fix it one of two ways:`,
    `  1. Enable compat in pnext.config.ts:`,
    `       export default { compat: { next: true } }`,
    `  2. Or delete the 'use server' directive from ${file}, if those exports are`,
    `     only ever called on the server (in core the directive does nothing).`,
  ].join('\n')
}

/**
 * Fail the build / the dev request rather than render a form whose action goes
 * nowhere. Only page routes carry the fact (see serverActionFileFact), so a
 * handler-only directive never reaches here.
 */
export function assertNoServerActionsWithoutCompat(
  routes: RouteManifestEntry[],
  compatEnabled: boolean,
  root?: string,
) {
  if (compatEnabled) return
  const offender = routes.find(route => route.serverActionFile)
  if (!offender) return
  throw new Error(
    serverActionsUnsupportedMessage({
      file: offender.serverActionFile!,
      route: offender.route,
      root,
    }),
  )
}

function isClientModule(context: ScanContext, file: string) {
  const key = path.resolve(file)
  let client = context.useClient.get(key)
  if (client === undefined) {
    client = hasUseClientDirective(file, readSource(context, file))
    context.useClient.set(key, client)
  }
  return client
}

function collectClientReferences(context: ScanContext, entryFiles: string[]) {
  const references = new Map<string, ClientReference>()
  const visited = new Set<string>()

  for (const file of entryFiles) {
    // A convention module may be a bare re-export of a client module
    // (`export { default } from './client-layout'`): its own source carries no
    // directive, but its default export IS a client component. Register the
    // reference under the ENTRY file so the renderer mounts the convention as
    // an island (the client bundle resolves the re-export chain naturally).
    if (fileExists(context, file)) {
      if (!isClientModule(context, file) && defaultReexportsClientModule(context, file)) {
        addClientReference(references, clientReference(file, 'default'))
      }
    }
    collectFromFile(context, file, references, visited)
  }

  const collected = [...references.values()]
  // Webpack eagerly initializes side-effect-only client modules (a bare `import './client-only'`) ONLY once
  // at least one client reference actually renders. A route whose sole client references are
  // side-effect-only executes nothing on the client, so drop them - otherwise their side effects would
  // wrongly run.
  const hasRenderedReference = collected.some(reference => !reference.sideEffect)
  const filtered = hasRenderedReference
    ? collected
    : collected.filter(reference => !reference.sideEffect)

  return filtered.sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Whether `file`'s DEFAULT export is re-exported (possibly through a chain of
 * directive-less modules) from a `'use client'` module. Only the
 * `export { ... default ... } from` form participates: importing a client
 * component and rendering it is the ordinary island case, but re-exporting one
 * as your own default makes THIS module's default a client component.
 */
function defaultReexportsClientModule(
  context: ScanContext,
  file: string,
  visited = new Set<string>(),
): boolean {
  const key = path.resolve(file)
  if (visited.has(key)) return false
  visited.add(key)
  const source = readSource(context, file)
  const specifiers: string[] = []
  for (const edge of scanFacts(file, source).imports) {
    // `export *` never carries a default, so only the named form counts.
    if (edge.reexport && edge.exports.includes('default')) specifiers.push(edge.specifier)
  }
  // `import X from 'spec'; export default X` and the namespace form
  // `import * as NS from 'spec'; export default NS.default` (the pages-compat
  // materializer emits the latter) re-export a default just the same.
  const defaultExpr = /export\s+default\s+([A-Za-z_$][\w$]*)(\s*\.\s*default)?\s*;?/.exec(source)
  if (defaultExpr) {
    const binding = defaultExpr[1]!
    const namespaced = Boolean(defaultExpr[2])
    const importBinding = namespaced
      ? new RegExp(`import\\s*\\*\\s*as\\s+${binding}\\s+from\\s+['"]([^'"]+)['"]`).exec(source)
      : new RegExp(`import\\s+${binding}\\s+from\\s+['"]([^'"]+)['"]`).exec(source)
    if (importBinding?.[1]) specifiers.push(importBinding[1])
  }
  for (const specifier of specifiers) {
    const resolved = resolveModuleEdge(context.root, file, specifier)
    if (!resolved || !fileExists(context, resolved)) continue
    if (isClientModule(context, resolved)) return true
    if (defaultReexportsClientModule(context, resolved, visited)) return true
  }
  return false
}

function collectFromFile(
  context: ScanContext,
  file: string,
  references: Map<string, ClientReference>,
  visited: Set<string>,
  withinClientBoundary = false,
) {
  const visitKey = `${file}\0${withinClientBoundary ? 'client' : 'server'}`
  if (visited.has(visitKey) || !fileExists(context, file)) return
  visited.add(visitKey)

  const clientFile = isClientModule(context, file)
  if (clientFile) {
    addClientReference(references, clientReference(file, 'default'))
  }

  const nestedClientBoundary = withinClientBoundary || clientFile
  const imports = [...moduleEdges(context, file)]
  if (!nestedClientBoundary) imports.push(...publishedClientImports(context, file))
  for (const imported of imports) {
    if (isClientModule(context, imported.file)) {
      // `export * from './client'` re-exports the target's named exports (never
      // its default), so each of them is a client reference of this module.
      if (imported.star) {
        const importedSource = readSource(context, imported.file)
        for (const exportName of scanFacts(imported.file, importedSource).exportNames) {
          if (exportName !== 'default') {
            addClientReference(references, clientReference(imported.file, exportName))
          }
        }
        continue
      }
      if (imported.exports.includes('*')) {
        throw new Error(
          `${file} namespace-imports Client Component module ${imported.file}. Import the client component by default or named export instead.`,
        )
      }
      // A bare side-effect import binds no exports, but the module still belongs in the client bundle:
      // webpack eagerly initializes every client reference module once any of them renders, so its top-level
      // side effects must run. Register it as a side-effect-only reference - never SSR'd, never mounted, just
      // bundled and executed.
      if (imported.exports.length === 0) {
        addClientReference(references, {
          ...clientReference(imported.file, '*side-effect*'),
          sideEffect: true,
        })
        continue
      }
      for (const exportName of imported.exports) {
        addClientReference(references, {
          ...clientReference(imported.file, exportName),
          dynamic: imported.dynamic,
        })
      }
      continue
    }

    if (imported.dynamic?.load === 'visible') {
      console.warn(
        `${file} uses dynamic({ load: 'visible' }) for ${imported.file}, but the target is a Server Component. It will render on the server instead of loading on visibility.`,
      )
    }

    collectFromFile(context, imported.file, references, visited, nestedClientBoundary)
  }
}

function addClientReference(references: Map<string, ClientReference>, reference: ClientReference) {
  const existing = references.get(reference.id)
  if (!existing) {
    references.set(reference.id, reference)
    return
  }

  if (!reference.dynamic) references.set(reference.id, reference)
}

// CSS cascade order across a route's entry files: outer->inner layouts, then
// templates, then the page itself, then boundary/slot files. `entryFiles` is
// built page-first for module/client collection; CSS needs the reverse nesting
// so a layout's stylesheet is emitted before (and thus loses specificity ties
// to) the page's.
function cssEntryOrder(options: {
  routeFile?: string
  layoutFiles: string[]
  templateFiles: string[]
  specialFiles: string[]
  slotFiles: string[]
  leadFiles?: string[]
}) {
  return [
    ...(options.leadFiles ?? []),
    ...options.layoutFiles,
    ...options.templateFiles,
    ...(options.routeFile ? [options.routeFile] : []),
    ...options.specialFiles,
    ...options.slotFiles,
  ]
}

function collectCssImports(
  context: ScanContext,
  entryFiles: string[],
  options: { route?: boolean } = {},
) {
  const imports = new Set<string>()
  const visited = new Set<string>()

  for (const file of entryFiles) {
    collectCssFromFile(context, file, imports, visited)
  }

  // Preserve source import order (a Set keeps insertion order): the emitted
  // stylesheet's cascade depends on it — layouts outer->inner, then page, then
  // components in import order. Sorting alphabetically would scramble the
  // cascade and flip which rule wins.
  if (!options.route || !getCssExtensions().deferRootNotFoundCss()) return [...imports]

  const rootNotFound = entryFiles.find(
    file =>
      path.dirname(file) === context.appPath && /^not-found\.[^.]+$/.test(path.basename(file)),
  )
  if (!rootNotFound) return [...imports]

  const rootNotFoundImports = new Set<string>()
  collectCssFromFile(context, rootNotFound, rootNotFoundImports, new Set())
  if (rootNotFoundImports.size === 0) return [...imports]

  const matchedImports = new Set<string>()
  for (const file of entryFiles) {
    if (file === rootNotFound) continue
    collectCssFromFile(context, file, matchedImports, new Set())
  }

  return [...imports].filter(file => !rootNotFoundImports.has(file) || matchedImports.has(file))
}

function collectSourceFiles(context: ScanContext, entryFiles: string[]) {
  const files = new Set<string>()
  const visited = new Set<string>()

  for (const file of entryFiles) {
    collectSourceFile(context, file, files, visited)
  }

  return [...files].sort()
}

function collectSourceFile(
  context: ScanContext,
  file: string,
  files: Set<string>,
  visited: Set<string>,
) {
  if (visited.has(file) || !fileExists(context, file)) return
  visited.add(file)
  files.add(file)
  if (isAssetFile(file)) return

  for (const imported of moduleEdges(context, file)) {
    collectSourceFile(context, imported.file, files, visited)
  }
}

function collectCssFromFile(
  context: ScanContext,
  file: string,
  imports: Set<string>,
  visited: Set<string>,
) {
  if (visited.has(file) || !fileExists(context, file)) return
  visited.add(file)

  if (isCssFile(file)) {
    if (!context.globalCssImports().has(path.resolve(file))) imports.add(file)
    return
  }

  const clientFile = isClientModule(context, file)
  for (const imported of moduleEdges(context, file)) {
    if (isCssFile(imported.file)) {
      if (!context.globalCssImports().has(path.resolve(imported.file))) imports.add(imported.file)
      continue
    }

    // CSS behind a non-SSR island boundary ships with the island
    // (assets/<reference-id>.css) instead of the route chunk, so it loads
    // when the component does. Boundaries only exist in server files:
    // dynamic() inside a client subtree mounts without the island runtime.
    if (!clientFile && isLazyClientEdge(context, imported)) continue

    collectCssFromFile(context, imported.file, imports, visited)
  }
}

function isLazyClientEdge(context: ScanContext, edge: ModuleEdge) {
  if (!edge.dynamic || ssrClientReference({ dynamic: edge.dynamic })) return false
  return isClientModule(context, edge.file)
}

function attachLazyReferenceCss(context: ScanContext, references: ClientReference[]) {
  for (const reference of references) {
    if (ssrClientReference(reference)) continue
    const css = collectCssImports(context, [reference.file])
    if (css.length > 0) reference.cssImports = css
  }
}

/**
 * Entry source for FACT scans (segment config, revalidation-API usage, request
 * usage, generateStaticParams), with the sources of relative re-export targets
 * appended. Next evaluates the module, so `export const revalidate = 0` behind
 * an `export * from './route'` (the pages-compat materializer shims every
 * hybrid-app convention this way) still configures the route; text-only entry
 * scans would miss it and, e.g., prerender a revalidateTag route handler.
 * Relative specifiers only: bare imports never carry segment config.
 */
function readScanSource(context: ScanContext, file: string, visited = new Set<string>()): string {
  const key = path.resolve(file)
  if (visited.has(key)) return ''
  visited.add(key)
  const source = readSource(context, file)
  const parts = [source]
  for (const edge of scanFacts(file, source).imports) {
    if (!edge.reexport || !edge.specifier.startsWith('.')) continue
    const resolved = resolveModuleEdge(context.root, file, edge.specifier)
    if (!resolved || !existsSync(resolved)) continue
    parts.push(readScanSource(context, resolved, visited))
  }
  return parts.join('\n')
}

function readSource(context: ScanContext, file: string) {
  const key = path.resolve(file)
  let source = context.sources.get(key)
  if (source === undefined) {
    // Raw text comes from the build-scoped cache (a no-op outside a build), so
    // the client loader and action discovery don't re-read what this walk reads.
    source = rewriteLiteralDynamicCalls(readSourceSync(key), file)
    context.sources.set(key, source)
  }
  return source
}

// True when any of the route's source files imports a Link component
// (next/link in compat, or the core @wular/pnext/link). Matches the module
// specifier so it survives aliasing/renamed imports of the default export.
const linkSpecifiers = new Set(['next/link', '@wular/pnext/link'])

// Every module specifier through which a route's graph can reach a soft
// navigation: Link, the client router hooks, and compat's navigation surface.
// A route whose whole closure imports none of these can never start a soft
// navigation, so its entry ships no router at all (client/entry.ts).
const navigationSpecifiers = new Set([
  ...linkSpecifiers,
  'next/form',
  'next/navigation',
  'next/router',
  '@wular/pnext/navigation',
  '@wular/pnext/navigation/client',
])

// The root `@wular/pnext` barrel also re-exports navigation: a NAMED import of
// one of these counts, anything else (types, cache, config helpers) does not.
// A bare/namespace/default import does not name what it reaches, so it counts —
// the fact has to over-approximate, never under-approximate.
const rootNavigationExports = new Set([
  '*',
  'default',
  'Link',
  'permanentRedirect',
  'redirect',
  'useLinkStatus',
  'useParams',
  'usePathname',
  'useRoute',
  'useRouter',
  'useSearchParams',
])

function importReachesNavigation(edge: { specifier: string; exports: string[] }) {
  if (navigationSpecifiers.has(edge.specifier)) return true
  if (edge.specifier !== '@wular/pnext') return false
  return edge.exports.length === 0 || edge.exports.some(name => rootNavigationExports.has(name))
}

function routeUsesLinkComponent(context: ScanContext, files: string[]) {
  for (const file of files) {
    if (!fileExists(context, file) || isAssetFile(file)) continue
    const key = path.resolve(file)
    let uses = context.usesLink.get(key)
    if (uses === undefined) {
      const facts = scanFacts(file, readSource(context, file))
      uses = facts.imports.some(edge => linkSpecifiers.has(edge.specifier))
      context.usesLink.set(key, uses)
    }
    if (uses) return true
  }
  return false
}

/** True when any file in the route's closure can reach a soft navigation. */
function routeUsesNavigation(context: ScanContext, files: string[]) {
  for (const file of files) {
    if (!fileExists(context, file) || isAssetFile(file)) continue
    const key = path.resolve(file)
    let uses = context.usesNavigation.get(key)
    if (uses === undefined) {
      const facts = scanFacts(file, readSource(context, file))
      uses = facts.imports.some(importReachesNavigation)
      context.usesNavigation.set(key, uses)
    }
    if (uses) return true
  }
  return false
}

function routeClientEntryReasons(context: ScanContext, files: string[]): ClientEntryReason[] {
  const reasons: ClientEntryReason[] = []
  for (const file of files) {
    if (!fileExists(context, file) || isAssetFile(file)) continue
    const key = path.resolve(file)
    let fileReasons = context.entryReasons.get(key)
    if (fileReasons === undefined) {
      fileReasons = sourceClientEntryReasons(readSource(context, file))
      context.entryReasons.set(key, fileReasons)
    }
    reasons.push(...fileReasons)
  }
  return reasons
}

function usesRequestImportDataForFiles(context: ScanContext, files: string[]) {
  for (const file of files) {
    const key = path.resolve(file)
    let usesRequestImport = context.requestImportUsage.get(key)
    if (usesRequestImport === undefined) {
      usesRequestImport = sourceUsesRegisteredRequestApi(readSource(context, file))
      context.requestImportUsage.set(key, usesRequestImport)
    }
    if (usesRequestImport) return true
  }

  return false
}

function routeDependencyClassification(
  context: ScanContext,
  kind: 'page' | 'handler',
  files: string[],
) {
  const sources = files
    .filter(file => !isAssetFile(file))
    .map(file => ({ file, source: readSource(context, file) }))
  return classifyRouteDependencies({ kind, files: sources })
}

function moduleEdges(context: ScanContext, file: string) {
  const key = path.resolve(file)
  let edges = context.edges.get(key)
  if (!edges) {
    edges = moduleEdgesFromSource(context, file, readSource(context, file))
    context.edges.set(key, edges)
  }
  return edges
}

// Compat pins framework specifiers (`next/form`, ...) to its own absolute files, and the bundler's
// importAliasPlugin gives those aliases precedence over every other resolver. The scanner's module-edge walk
// must mirror that order - alias FIRST, generic resolution second: inside a workspace that ships a real
// `next` package, plain resolveImport finds the real package's directive-less re-export stub and the
// 'use client' boundary of the compat module is silently missed, so the route never gets its client
// reference or entry.
function resolveModuleEdge(root: string, file: string, specifier: string) {
  return (
    resolveModuleAlias(specifier) ??
    resolveImport(root, file, specifier) ??
    getBundlerExtensions().resolveRouteDependency(root, file, specifier) ??
    getCssExtensions().resolveCssDependency(root, file, specifier)
  )
}

/** Rendered Client Component exports hidden behind a package's dist barrels. */
function publishedClientImports(context: ScanContext, file: string) {
  const source = readSource(context, file)
  const found: ModuleEdge[] = []
  for (const edge of scanFacts(file, source).imports) {
    if (resolveModuleEdge(context.root, file, edge.specifier)) continue
    found.push(...publishedClientEdges(context, file, edge.specifier, edge.exports))
  }
  return found
}

function publishedClientEdges(
  context: ScanContext,
  file: string,
  specifier: string,
  requested: string[],
) {
  const cacheKey = `${file}\0${specifier}\0${requested.join(',')}`
  const cached = context.edges.get(cacheKey)
  if (cached) return cached
  const entry = resolvePublishedEdge(context, file, specifier, 'import')
  const edges = entry ? publishedClientExports(context, entry, requested, new Set()) : []
  context.edges.set(cacheKey, edges)
  return edges
}

function resolvePublishedEdge(
  context: ScanContext,
  file: string,
  specifier: string,
  kind: 'import' | 'require',
) {
  return (
    resolveModuleEdge(context.root, file, specifier) ??
    resolvePackageSpecifier(context.root, file, specifier, [kind, 'default'])
  )
}

function publishedClientExports(
  context: ScanContext,
  file: string,
  requested: string[],
  visiting: Set<string>,
): ModuleEdge[] {
  const key = path.resolve(file)
  if (visiting.has(key) || !fileExists(context, key)) return []
  visiting.add(key)
  const source = readSource(context, key)
  if (hasUseClientDirective(key, source)) {
    visiting.delete(key)
    const names = [...scanFacts(key, source).exportNames, ...commonJsRouteExportNames(source)]
    const exports = requested.filter(name => names.includes(name))
    return exports.length > 0 ? [{ file: key, exports }] : []
  }

  const facts = scanFacts(key, source)
  const found: ModuleEdge[] = []
  for (const edge of facts.imports) {
    if (!edge.reexport) continue
    const map = { ...esmReexportMap(source, edge.specifier), ...edge.exportMap }
    const next = edge.star
      ? requested.filter(name => name !== 'default')
      : requested.map(name => map[name]).filter((name): name is string => Boolean(name))
    const target = resolvePublishedEdge(context, key, edge.specifier, 'import')
    if (target && next.length > 0) {
      found.push(...publishedClientExports(context, target, next, visiting))
    }
  }
  for (const edge of facts.requires) {
    const map = commonJsRequireReexportMap(source, edge.specifier)
    const next = map.star
      ? requested
      : requested.map(name => map.names[name]).filter((name): name is string => Boolean(name))
    const target = resolvePublishedEdge(context, key, edge.specifier, 'require')
    if (target && next.length > 0) {
      found.push(...publishedClientExports(context, target, next, visiting))
    }
  }
  visiting.delete(key)
  return found
}

function moduleEdgesFromSource(context: ScanContext, file: string, source: string) {
  const dynamicNames = pnextDynamicImportNames(source, file)
  assertSupportedDynamicCalls(file, source, dynamicNames)
  // Edges carry their byte offset so the final list follows true source order:
  // CSS injection order is a source-order property — a side-effect
  // `import './a.css'` written before a component import must be emitted
  // before that component's CSS.
  const ordered: (ModuleEdge & { index: number })[] = []
  const facts = scanFacts(file, source)

  for (const edge of facts.imports) {
    const resolved = resolveModuleEdge(context.root, file, edge.specifier)
    if (!resolved) continue
    ordered.push({
      file: resolved,
      exports: [...edge.exports],
      index: edge.index,
      ...(edge.star ? { star: true } : {}),
    })
  }

  ordered.sort((a, b) => a.index - b.index)
  const imports: ModuleEdge[] = ordered.map(({ index: _index, ...edge }) => edge)

  for (const imported of dynamicImportEdgesFromSource(context.root, file, source, dynamicNames))
    imports.push(imported)

  return imports
}

function esmReexportMap(source: string, specifier: string) {
  const escaped = escapeRegex(specifier)
  const names: Record<string, string> = {}
  const pattern = new RegExp(`\\bexport\\s*\\{([^}]*)\\}\\s*from\\s*["']${escaped}["']`, 'g')
  for (const clause of source.matchAll(pattern)) {
    for (const item of (clause[1] ?? '').split(',')) {
      const parts = item.trim().split(/\s+as\s+/)
      const imported = parts[0]?.trim()
      const exported = (parts[1] ?? parts[0])?.trim()
      if (imported && exported && /^[$\w]+$/.test(imported) && /^[$\w]+$/.test(exported)) {
        names[exported] = imported
      }
    }
  }
  return names
}

function commonJsRequireReexportMap(source: string, specifier: string) {
  const escaped = escapeRegex(specifier)
  const names: Record<string, string> = {}
  const direct = new RegExp(
    `exports\\.([A-Za-z_$][\\w$]*)\\s*=\\s*require\\(\\s*["']${escaped}["']\\s*\\)\\.([A-Za-z_$][\\w$]*)`,
    'g',
  )
  for (const match of source.matchAll(direct)) {
    names[match[1]!] = match[2]!
  }

  const binding = new RegExp(
    `(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*require\\(\\s*["']${escaped}["']\\s*\\)`,
  ).exec(source)?.[1]
  if (binding) {
    const local = escapeRegex(binding)
    const assignment = new RegExp(
      `exports\\.([A-Za-z_$][\\w$]*)\\s*=\\s*${local}\\.([A-Za-z_$][\\w$]*)`,
      'g',
    )
    for (const match of source.matchAll(assignment)) {
      names[match[1]!] = match[2]!
    }
    const getter = new RegExp(
      `Object\\.defineProperty\\(\\s*exports\\s*,\\s*["']([A-Za-z_$][\\w$]*)["'](?:(?!Object\\.defineProperty)[\\s\\S]){0,300}?return\\s+${local}\\.([A-Za-z_$][\\w$]*)`,
      'g',
    )
    for (const match of source.matchAll(getter)) {
      names[match[1]!] = match[2]!
    }
    const helper = new RegExp(
      `(?:^|[,\\{])\\s*([A-Za-z_$][\\w$]*)\\s*:\\s*\\(\\s*\\)\\s*=>\\s*${local}\\.([A-Za-z_$][\\w$]*)`,
      'g',
    )
    for (const match of source.matchAll(helper)) {
      names[match[1]!] = match[2]!
    }
  }

  const star = new RegExp(
    `module\\.exports\\s*=\\s*(?:require\\(\\s*["']${escaped}["']\\s*\\)|${binding ?? '(?!)'})(?=\\s*(?:;|$))`,
    'm',
  ).test(source)
  return { names, star }
}

function commonJsRouteExportNames(source: string) {
  return [
    ...new Set([
      ...[...source.matchAll(/\bexports\.([A-Za-z_$][\w$]*)\s*=/g)].map(match => match[1]!),
      ...[
        ...source.matchAll(
          /\bObject\.defineProperty\(\s*exports\s*,\s*["']([A-Za-z_$][\w$]*)["']/g,
        ),
      ].map(match => match[1]!),
    ]),
  ].filter(name => name !== '__esModule')
}

function assertSupportedDynamicCalls(file: string, source: string, dynamicNames: Set<string>) {
  for (const call of dynamicCallsFromSource(source, dynamicNames)) {
    if (!/\bimport\s*\(/.test(call.source)) {
      throw new Error(
        `${file} uses dynamic() without a literal import. PNext supports dynamic('./module') or dynamic(() => import('./module')).`,
      )
    }

    if (!/\bimport\s*\(\s*['"][^'"]+['"]\s*\)/.test(call.source)) {
      throw new Error(
        `${file} uses a non-literal dynamic import. PNext supports dynamic('./module') or dynamic(() => import('./module')).`,
      )
    }
  }
}

function dynamicImportEdgesFromSource(
  root: string,
  file: string,
  source: string,
  dynamicNames: Set<string>,
) {
  const imports: { file: string; exports: string[]; dynamic: ClientDynamicReference }[] = []
  if (dynamicNames.size === 0) return imports

  const optionObjects = dynamicOptionObjects(source)
  for (const fact of dynamicCallFacts(source, file)) {
    if (!dynamicNames.has(fact.name)) continue
    const resolved = resolveModuleEdge(root, file, fact.specifier)
    if (!resolved) continue
    imports.push({
      file: resolved,
      exports: [fact.exportName],
      dynamic: dynamicOptionsForFact(source, fact, optionObjects),
    })
  }

  return imports
}

function dynamicOptionObjects(source: string) {
  const options = new Map<string, ClientDynamicReference>()
  const pattern = /const\s+([A-Za-z_$][\w$]*)\s*=\s*({[\s\S]*?})\s*(?:as\s+const\s*)?;/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(source))) {
    const [, name, objectSource] = match
    if (name && objectSource) options.set(name, dynamicOptionsFromSource(objectSource))
  }

  return options
}

function dynamicOptionsForFact(
  source: string,
  fact: DynamicCallFact,
  optionObjects: Map<string, ClientDynamicReference>,
) {
  if (fact.optionsStart === undefined || fact.optionsEnd === undefined) return {}
  const options = source.slice(fact.optionsStart, fact.optionsEnd)
  if (/^[A-Za-z_$][\w$]*$/.test(options)) return optionObjects.get(options) ?? {}
  return dynamicOptionsFromSource(options)
}

function dynamicOptionsFromSource(source?: string): ClientDynamicReference {
  if (!source) return {}
  return {
    ...dynamicLoadFromSource(source),
    ...dynamicRootMarginFromSource(source),
    ...dynamicSsrFromSource(source),
    ...dynamicThresholdFromSource(source),
  }
}

function dynamicLoadFromSource(source: string): ClientDynamicReference {
  const match = /\bload\s*:\s*['"](render|visible)['"]/.exec(source)
  return match?.[1] === 'render' || match?.[1] === 'visible' ? { load: match[1] } : {}
}

function dynamicRootMarginFromSource(source: string): ClientDynamicReference {
  const match = /\brootMargin\s*:\s*['"]([^'"]+)['"]/.exec(source)
  return match?.[1] ? { rootMargin: match[1] } : {}
}

function dynamicSsrFromSource(source: string): ClientDynamicReference {
  const match = /\bssr\s*:\s*(true|false)\b/.exec(source)
  return match?.[1] ? { ssr: match[1] === 'true' } : {}
}

function dynamicThresholdFromSource(source: string): ClientDynamicReference {
  const numberMatch = /\bthreshold\s*:\s*(-?\d+(?:\.\d+)?)/.exec(source)
  if (numberMatch?.[1]) return { threshold: Number(numberMatch[1]) }

  const arrayMatch = /\bthreshold\s*:\s*\[([^\]]*)\]/.exec(source)
  if (!arrayMatch?.[1]) return {}
  const threshold = arrayMatch[1]
    .split(',')
    .map(value => Number(value.trim()))
    .filter(Number.isFinite)
  return threshold.length > 0 ? { threshold } : {}
}

function isCssFile(file: string) {
  return (
    file.endsWith('.css') ||
    getCssExtensions()
      .extraCssExtensions()
      .some(ext => file.endsWith(ext))
  )
}

function isAssetFile(file: string) {
  return (
    /\.(css|svg|png|jpe?g|gif|webp|ico|woff2?)$/.test(file) ||
    getCssExtensions()
      .extraCssExtensions()
      .some(ext => file.endsWith(ext))
  )
}

function exportsExperimentalPpr(sources: string[]) {
  return sources.some(source =>
    /\bexport\s+const\s+experimental_ppr\s*=\s*true\b/.test(stripComments(source)),
  )
}

function usesRequestData(source: string) {
  const searchable = stripJsxText(stripCommentsAndStrings(source))
  // Core knows only its own generic request-data markers; the next/* import
  // detectors (next/headers, next/navigation hooks, next/server connection())
  // are registered by compat via the usageDetection seam.
  return /\b(?:request|searchParams)\b/.test(searchable) || sourceUsesRegisteredRequestApi(source)
}

/**
 * Blank out JSX text nodes: rendered prose is not code, so `<h1>No searchParams used</h1>` must not read as a
 * request-data access and force the page dynamic. Only plain-text runs qualify - a run between two angle
 * brackets that spans lines or carries code punctuation (an arrow body, a comparison, an interpolation) is
 * left untouched so a real usage between JSX tags is still seen.
 */
function stripJsxText(source: string) {
  return source.replace(
    />([^<>(){}=;\n]*)</g,
    (_match, text: string) => `>${' '.repeat(text.length)}<`,
  )
}

/**
 * The dynamic data API a route statically references, named the way Next names
 * it in its "couldn't be rendered statically" build error (backticks included,
 * exactly as it appears after "it used "). Used only to enforce
 * `dynamic = 'error'`: such a route must render statically, so any dynamic data
 * access is a hard build failure. Detection is a source scan (Next decides at
 * render time by which API is hit first); for the single-API fixtures this is
 * exact, and server data APIs are checked before `searchParams` so a page that
 * reads both reports the server API. Returns undefined when no dynamic API is
 * referenced (the route can prerender).
 */
function dynamicApiLabel(sources: string[], kind: 'page' | 'handler'): string | undefined {
  const joined = sources.map(stripCommentsAndStrings).join('\n')
  if (/\bconnection\s*\(/.test(joined)) return '`connection()`'
  if (/\bcookies\s*\(/.test(joined)) return '`cookies()`'
  if (/\bheaders\s*\(/.test(joined)) return '`headers()`'
  if (/\bdraftMode\s*\(/.test(joined)) return '`draftMode()`'
  if (kind === 'handler') {
    if (/\.formData\b/.test(joined)) return '`request.formData`'
    if (/\bnextUrl\b/.test(joined)) return '`nextUrl.toString`'
    if (/\brequest\.url\b|\breq\.url\b/.test(joined)) return '`request.url`'
  } else if (/\bsearchParams\b/.test(joined)) {
    return '`await searchParams`, `searchParams.then`, or similar'
  }
  return undefined
}

function maxDurationFromSources(sources: string[]) {
  const durations = sources
    .map(source => /\bexport\s+const\s+maxDuration\s*=\s*(\d+)\b/.exec(source)?.[1])
    .filter((value): value is string => Boolean(value))
    .map(value => Number(value))
  return durations.length > 0 ? Math.max(...durations) : undefined
}

// On-demand revalidation calls make a handler dynamic in Next: caching the
// response would freeze the side effect at build time.
function usesRevalidationApis(source: string) {
  return /\b(?:revalidatePath|revalidateTag|updateTag|expirePath|expireTag|unstable_expirePath|unstable_expireTag)\s*\(/.test(
    stripCommentsAndStrings(source),
  )
}

/** Sentinel for a destructured first parameter (no identifier to track). */
const DESTRUCTURED_PARAM = '<destructured>'

function routeHandlerUsesRequest(source: string) {
  const withoutComments = stripComments(source)
  const searchable = stripCommentsAndStrings(source)
  // Compat's usageDetection (next/headers import, etc.) marks a handler dynamic.
  if (sourceUsesRegisteredRequestApi(source)) return true
  for (const method of routeHandlerMethods) {
    for (const params of exportedFunctionParams(withoutComments, method)) {
      const name = firstParameterName(params)
      // A destructured request parameter (`GET({ nextUrl })`) reads the request
      // in the signature itself — there is no binding to count references for.
      if (name === DESTRUCTURED_PARAM) return true
      if (name && referencesName(searchable, name) > 1) return true
    }
  }
  return false
}

function exportedFunctionParams(source: string, method: string) {
  const params: string[] = []
  const functionPattern = new RegExp(
    `\\bexport\\s+(?:async\\s+)?function\\s+${method}\\s*\\(([^)]*)\\)`,
    'g',
  )
  let match: RegExpExecArray | null
  while ((match = functionPattern.exec(source))) {
    params.push(match[1] ?? '')
  }

  const arrowPattern = new RegExp(
    `\\bexport\\s+const\\s+${method}\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?:\\(([^)]*)\\)|([A-Za-z_$][\\w$]*))\\s*=>`,
    'g',
  )
  while ((match = arrowPattern.exec(source))) {
    params.push(match[1] ?? match[2] ?? '')
  }

  return params
}

function firstParameterName(params: string) {
  const first = params.split(',')[0]?.trim()
  if (!first) return undefined
  if (first.startsWith('{') || first.startsWith('[')) return DESTRUCTURED_PARAM
  const name =
    /^\.{3}\s*([A-Za-z_$][\w$]*)/.exec(first)?.[1] ?? /^([A-Za-z_$][\w$]*)/.exec(first)?.[1]
  return name
}

function referencesName(source: string, name: string) {
  const pattern = new RegExp(`\\b${escapeRegex(name)}\\b`, 'g')
  return [...source.matchAll(pattern)].length
}

function stripCommentsAndStrings(source: string) {
  return stripComments(source).replace(/(['"`])(?:\\[\s\S]|(?!\1)[^\\])*\1/g, '')
}

function stripComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function rootFromAppPath(appPath: string) {
  const normalized = toPosixPath(appPath)
  return normalized.endsWith('/src/app')
    ? path.dirname(path.dirname(appPath))
    : path.dirname(appPath)
}

function clientReference(file: string, exportName: string): ClientReference {
  return {
    id: `c-${clientReferenceId(file, exportName)}`,
    file,
    exportName,
  }
}

function routeId(route: string) {
  if (route === '/') return 'index'
  return route
    .split('/')
    .filter(Boolean)
    .map(segment => {
      if (segment.startsWith(':') && segment.endsWith('*'))
        return `catchall-${sanitizeIdPart(segment.slice(1, -1))}`
      if (segment.startsWith(':')) return `param-${sanitizeIdPart(segment.slice(1))}`
      return sanitizeIdPart(segment)
    })
    .join('-')
}

function sanitizeIdPart(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'route'
}

function routeRank(route: RouteManifestEntry) {
  // Segment-wise specificity, Next-style: compare left to right with
  // literal < param < catch-all at each level, so /parallel/foo (from a slot)
  // beats /[lang]/foo while /parallel/[...all] still beats /[lang]/foo.
  // Synthetic entries only lose ties against a real route with the same shape.
  const spec = route.route
    .split('/')
    .filter(Boolean)
    .map(segment => (segment.startsWith(':') ? (segment.endsWith('*') ? '2' : '1') : '0'))
    .join('')
  return `${spec}:${route.synthetic ? 1 : 0}:${route.route}`
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
