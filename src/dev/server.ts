import { existsSync, readFileSync, statSync } from 'node:fs'
import { readFile, readdir, rm, stat, watch } from 'node:fs/promises'
import path from 'node:path'
import {
  DEFERRED_DYNAMIC_SIDECAR,
  buildClientEntries,
  buildClientEntry,
  clientSourceHash,
  deferredDynamicRefById,
  prebuiltRuntimeDir,
  registerDeferredDynamicRef,
} from '../client/build'
import { drainPreplanBuilds } from '../runtime/vendor'
import { getClientActionBundler } from './client-actions'
import { devClientCacheKey } from './restart/client-key'
import { clientChunkStoreDir, contentAddressDir, sweepClientChunkStore } from './client-chunk-store'
import { restartCacheEnabled } from './restart/enabled'
import { installRouteFactsCache } from './restart/route-facts'
import { installGlobalCssCache } from './restart/global-css'
import { clientEntryName } from '../client/chunk-name'
import { bootstrapCompat, bootstrapCompatBoot } from '../compat-bootstrap'
import type { ResolvedConfig } from '../config'
import {
  buildClientReferenceCss,
  buildGlobalCss,
  buildRouteCss,
  clearGlobalCssSourceCache,
  isCssFile,
  warmCssPipeline,
} from '../css/build'
import {
  deferServerRuntimePlugins,
  installServerRuntimePlugins,
  registerServerRuntime,
  serverBundleTargetForRuntime,
} from '../runtime/loader'
import { applyProxyResponse, createProxyRunner, validateProxyFiles } from '../routing/proxy'
import {
  errorLogTrace,
  renderGlobalNotFoundResponse,
  renderPageResponse,
  withDevReloadScript,
} from '../render/renderer'
import { markErrorLogged } from '../utils/error-log'
import { escapeHtml } from '../utils/html'
import { internalErrorHtml } from './internal-error'
import { getFontExtensions, nextCompatEnabled } from '../render/hooks'
import {
  clearMetadataFileCaches,
  discoverStaticMetadataFiles,
  metadataRouteHandlerModule,
  staticMetadataCacheControl,
} from '../routing/metadata-files'
import { handleRouteModule, type RouteHandlerModule } from '../routing/handler'
import { malformedUrlResponse, trailingSlashRedirect } from '../routing/href'
import { type PeerAddressSource, withForwardedHeaders } from '../routing/forwarded'
import {
  assertNoServerActionsWithoutCompat,
  findLayouts,
  matchRoute,
  materializeRouteFactsPaced,
  parseNavState,
  routeFactsResolved,
  routeFactsVersion,
  scanRoutes,
  selectRouteForRequest,
} from '../routing/routes'
import { writeTypegen } from '../cli/typegen'
import { runWithCacheScope } from '../request/cache'
import {
  finalizeResponse,
  getAssetExtensions,
  getBundlerExtensions,
  getRequestExtensions,
  getRouterProtocolExtensions,
  reportRequestError,
  runInitHooks,
  runRequestWarmHooks,
  withRouteRuntime,
} from '../extensions'
import {
  flushWorkUnit,
  flushWorkUnitOnClose,
  getWorkUnit,
  runWithWorkUnit,
  setPhase,
  setWorkUnitRoute,
} from '../request/context'
import { setRequestRuntime } from '../routing/request-environment'
import { ensureDir, listFiles, writeText } from '../utils/fs'
import { contentType } from '../utils/content-type'
import { traceEnabled } from '../utils/trace-flags'
import {
  flushDevProfileLines,
  formatProfileDuration,
  recordDevProfileLine,
} from '../utils/dev-profile'
import { clearResolverFsCache } from '../resolve/engine'
import { clearAppTreeResolutions, workspacePackageRoots } from '../resolve/imports'
import type { RouteManifestEntry, RouteParamValue } from '../types'
import {
  clearDevRouteBundleKeys,
  devClientModuleHref,
  devClientReferenceGroups,
  devClientReferenceModules,
  devModuleGraph,
  devRouteModuleLoaders,
  devServerModuleHref,
  importDevModule,
  warmDevModulePipeline,
} from '../runtime/modules'
import { ssrClientReference } from '../client/reference'
import { cacheRoot, setDevWatcherFreshness } from '../runtime/module-cache'
import { abortUpstreamFetchOnDisconnect } from '../runtime/fetch-host'
import { markBoot } from '../cli/boot/trace'
import { formatDuration } from '../utils/verbose'

interface DevServerOptions {
  config: ResolvedConfig
  port: number
  hostname: string
  /**
   * Compile the entry route in the background as soon as the server is up, so the
   * expensive cold build (esbuild cold start + Tailwind subprocess) overlaps with
   * the browser launching instead of blocking the first click. The build caches
   * dedup, so if the real request arrives mid-warm it awaits the same promise.
   */
  warm?: boolean
}

// Bun closes the socket itself at this point, so a stalled render surfaces as a
// bare 499; the abort log reads the same constant to attribute it.
const DEV_IDLE_TIMEOUT_SECONDS = 60
const DEV_IDLE_TIMEOUT_MS = DEV_IDLE_TIMEOUT_SECONDS * 1000
// Long before that, warn once that the render is still going.
const DEV_PAGE_STALL_WARNING_MS = 20_000

const clientBuilds = new Map<string, Promise<string>>()
const clientChunks = new Map<string, string>()

// esbuild.stop() (the memory watchdog) can leave an in-flight build's promise permanently unsettled;
// anything awaiting it hangs and the dedup map keeps re-serving the poisoned promise. Waiters race against
// this registry so a service restart fails them fast instead - failed builds drop from the caches and the
// next request retries against the respawned service.
const clientBuildStopWaiters = new Set<(err: Error) => void>()
export function failInFlightClientBuilds(reason: string) {
  const err = new Error(reason)
  for (const reject of clientBuildStopWaiters) reject(err)
  clientBuildStopWaiters.clear()
  clientBuilds.clear()
}
// Client out-dirs whose chunk list is already in clientChunks — the dir name is
// a content key, so it never needs a second readdir.
const indexedClientDirs = new Set<string>()
// Layout chains per route file: findLayouts + an existsSync per level, which a
// warm request would otherwise redo every time.
const routeLayoutFiles = new Map<string, string[]>()
// Keyed by app (outPath), not by asset path or route id alone: several dev
// servers for different apps share one process in tests and monorepo tooling,
// and a bare `/assets/global.css` or route id collides between them.
const assetBuilds = new Map<string, Promise<unknown>>()
const routeCacheKeys = new Map<string, Promise<string>>()
const appKey = (outPath: string, key: string) => `${outPath}\0${key}`
function clearAppKeyed(map: Map<string, unknown>, outPath: string) {
  for (const key of map.keys()) if (key.startsWith(`${outPath}\0`)) map.delete(key)
}
// Routes whose bundles this process has already compiled, so the "Compiling"
// banner prints once per cold route (like Next.js) and not on warm hits.
// Cleared on reload.
const compiledRoutes = new Set<string>()

interface DevEventClient {
  controller: ReadableStreamDefaultController<Uint8Array>
}

/**
 * A save invalidates the changed files and their dependents - nothing else. Compiled modules are
 * content-addressed, so every map keyed by an artifact path invalidates itself; only the memo caches keyed
 * by route or source path need telling.
 */
function invalidateDevCaches(config: ResolvedConfig, changed: string[], structural: boolean) {
  devModuleGraph(config).invalidate(changed)
  // oxc caches fs lookups (including misses) until cleared, so a file added or
  // deleted since the last resolve stays invisible without this. A plain edit
  // changes no lookup answer.
  if (structural) {
    clearResolverFsCache()
    clearAppTreeResolutions()
    clearMetadataFileCaches()
    routeLayoutFiles.clear()
  }
  // Route CSS is derived from the whole source tree (Tailwind scans it), and
  // the client cache key is a content hash whose inputs just moved.
  clearGlobalCssSourceCache()
  clearDevRouteBundleKeys()
  clearAppKeyed(assetBuilds, config.outPath)
  clearAppKeyed(routeCacheKeys, config.outPath)
  indexedClientDirs.clear()
  compiledRoutes.clear()
  // Long sessions accumulate one generation per save; sweep past the keep
  // window here too, not just at boot. Best-effort and off the reload path.
  void evictStaleClientCaches(config.outPath)
}

// Every edit writes a fresh content-keyed generation under cache/client/ and
// nothing removed the old ones — ~6.6 MB per save, 1.24 GB after a 200-edit
// session (DEV-MEMORY §disk). Keep the newest N generations; an evicted dir is
// just a cache miss. Runs off the boot path.
async function evictStaleClientCaches(outPath: string) {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const keep = Number(process.env.PNEXT_DEV_CLIENT_CACHE_KEEP || 32)
  if (!Number.isFinite(keep) || keep <= 0) return
  const clientRoot = path.join(outPath, 'cache', 'client')
  try {
    const entries = await readdir(clientRoot)
    if (entries.length <= keep) return
    const dated = await Promise.all(
      entries.map(async entry => {
        const full = path.join(clientRoot, entry)
        const info = await stat(full).catch(() => null)
        return { full, mtime: info?.mtimeMs ?? 0 }
      }),
    )
    dated.sort((a, b) => b.mtime - a.mtime)
    await Promise.allSettled(
      dated.slice(keep).map(entry => rm(entry.full, { recursive: true, force: true })),
    )
    // Evicted generations may have been the last link to a store entry; sweep
    // after removal so orphaned store files (nlink back down to 1) don't linger.
    await sweepClientChunkStore(clientChunkStoreDir(outPath))
  } catch {
    // ignore: eviction is best-effort; worst case is disk growth, not breakage
  }
}

// Left behind by pre-persistence versions of the dev server, which swept the
// cache into a `.cache-stale-*` dir on every boot. Nothing creates them now.
async function removeLeakedStaleCaches(outPath: string) {
  try {
    const entries = await readdir(outPath)
    await Promise.allSettled(
      entries
        .filter(entry => entry.startsWith('.cache-stale-'))
        .map(entry => rm(path.join(outPath, entry), { recursive: true, force: true })),
    )
  } catch {
    // ignore: leftover stale dirs are only a disk-space nuisance
  }
}

export async function startDevServer(options: DevServerOptions) {
  const { config, port, hostname } = options
  // FSEvents replays writes that landed just before the watch started, so a server
  // booted right after a checkout or scaffold reloads itself once for files it has
  // already read. Nothing is compiled before the watcher, so anything this old is
  // already in hand.
  const bootTime = Date.now()
  // Spawn the CSS worker first: Tailwind's cold boot then runs off the event
  // loop, alongside everything below, instead of on the first page's stylesheet.
  warmCssPipeline(config, { dev: true })
  markBoot('boot:css-warm')
  // Compat plugin loader: the single gated seam that populates the core
  // extension registries when compat is enabled (no-op for pure-core apps).
  // Boot takes the cheap tier only — route conventions, aliases, proxy names,
  // lifecycle hooks; the implementation graph loads on the first request.
  await bootstrapCompatBoot(config)
  markBoot('boot:compat')
  // The compat implementation graph still has to load (first request / warmup).
  // Registering the module plugins now would put that whole import through the
  // plugin pipeline; arm them once compat is in, like build and start do.
  deferServerRuntimePlugins()
  registerServerRuntime(config)
  // Compat installs the Next fetch-cache patch here (no-op for pure-core apps).
  runInitHooks(config)
  // No boot sweep: the compiled cache is content-addressed and persists across
  // restarts, so validity is a name miss plus the
  // cache marker, not a wipe.
  void removeLeakedStaleCaches(config.outPath)
  void evictStaleClientCaches(config.outPath)
  // Route facts are the biggest single thing a restart's first page used to re-derive. Installed
  // before the route table so the first touch - whoever forces it - reads the previous process's
  // walk instead of repeating it.
  installRouteFactsCache(config)
  // Same deal for the root layout's CSS graph: 320 files read to find one
  // stylesheet, and both the warm tier and the render force it at Ready+0.
  installGlobalCssCache(config)
  markBoot('boot:registry')
  let routes = await scanRoutes(config.appPath)
  setDevClientRoutes(config, routes)
  markBoot('boot:scanRoutes')
  await validateProxyFiles(config)
  let proxyRunner = createProxyRunner(config)
  markBoot('boot:proxy')
  let devImportVersion = String(Date.now())
  // The proxy runs serially in front of every request, so its compile+import is
  // pure critical path when the first request pays it. Started here it overlaps
  // the CSS worker warmup, typegen and the first route's own module pass.
  if (restartCacheEnabled()) proxyRunner.warm({ dev: true, devImportVersion })
  markBoot('boot:proxy-warm')
  // Publish the live routing state the compat request interceptors (action
  // dispatch, rewrites) + client-action discovery read. Compat re-runs action
  // discovery lazily whenever the dev import version changes (see below), so the
  // registry + client-stub set that startup/reload armed inline stay current.
  publishRuntime()
  const clients = new Set<DevEventClient>()
  // Bumped on every rebuild broadcast and stamped on each stream's `ready`, so a
  // client that reconnects (bfcache restore) can tell it missed one and reload.
  let generation = 0
  let watcher: DevWatcher | undefined
  /** Requests currently being served — background work defers to them. */
  let inFlight = 0

  function publishRuntime() {
    setRequestRuntime({ config, routes, dev: true, devImportVersion })
  }

  // Typegen's route walk is the longest CPU run dev does outside a compile, and the only one with no
  // deadline, so it yields between routes and waits out anything the server is actually serving.
  // Bounded: a dev server under continuous load would otherwise never emit the .d.ts at all, so a
  // route waits out requests for at most this long and then takes its turn regardless.
  // `PNEXT_DEV_TYPEGEN_PACE=0` restores the uninterrupted walk.
  const TYPEGEN_MAX_WAIT_MS = 3_000

  async function typegenPause() {
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    if (process.env.PNEXT_DEV_TYPEGEN_PACE === '0') return
    const deadline = performance.now() + TYPEGEN_MAX_WAIT_MS
    do {
      await new Promise(resolve => setTimeout(resolve, inFlight > 0 ? 25 : 0))
    } while (inFlight > 0 && performance.now() < deadline)
  }

  async function typegenInBackground() {
    const generation = routes
    try {
      await writeTypegen(config, await materializeRouteFactsPaced(generation, typegenPause))
    } catch (error) {
      if (generation === routes) logDevPreloadError('typegen', error)
    }
    if (generation === routes) syncWatchRoots()
  }

  async function reload(change: DevChange) {
    // Editors save atomically (write + rename), so a rename event alone does not
    // mean the tree moved: it only did if a file is gone, or is one the module
    // graph has never seen.
    const structural =
      change.renamed &&
      change.files.some(file => !existsSync(file) || !devModuleGraph(config).knows(file))
    invalidateDevCaches(config, change.files, structural)
    // A burst that only touched plain stylesheets cannot have moved the module graph, the route
    // table, the proxy or the client bundles - only the built CSS assets. The page swaps its <link>s
    // in place instead of navigating.
    if (isCssOnlyChange(change.files)) {
      generation++
      broadcast(clients, 'css-update')
      return
    }
    // The route table is built from file paths only, so only an added, removed
    // or renamed file can change it — a plain save never does.
    if (structural) {
      routes = await scanRoutes(config.appPath)
      setDevClientRoutes(config, routes)
    }
    await validateProxyFiles(config)
    proxyRunner = createProxyRunner(config)
    devImportVersion = `${Date.now()}`
    proxyRunner.warm({ dev: true, devImportVersion })
    // Republish with the bumped version so compat re-discovers actions before
    // the next action request / client build.
    publishRuntime()
    void typegenInBackground()
    watchedFactsVersion = -1
    syncWatchRoots()
    generation++
    broadcast(clients, 'reload')
  }

  // A save's visibility must not wait out the coalescing window: the moment the
  // event lands, forget the changed file's graph and the memoized names derived
  // from it, so a request racing the debounced reload already compiles fresh.
  // The heavy reload work (proxy, typegen, route scan, CSS) stays debounced.
  function eagerInvalidate(file: string) {
    devModuleGraph(config).invalidate([file])
    clearDevRouteBundleKeys()
    clearAppKeyed(routeCacheKeys, config.outPath)
  }

  // Watch roots outside app/ come from route sourceFiles, which only exist once
  // a route has resolved its deferred facts — so they are re-derived whenever
  // another route materializes (its first compile), not once at boot.
  let watchedFactsVersion = -1
  function syncWatchRoots() {
    if (watchedFactsVersion === routeFactsVersion()) return
    watchedFactsVersion = routeFactsVersion()
    watcher = refreshWatcher(config, routes, watcher, reload, bootTime, eagerInvalidate)
  }

  syncWatchRoots()
  markBoot('boot:watcher')

  const server = Bun.serve({
    hostname,
    port,
    idleTimeout: DEV_IDLE_TIMEOUT_SECONDS,
    fetch(request, server) {
      // One work unit spans the whole request; its after-queue flushes once the
      // response fully closes (stream end, redirect, notFound, error, abort).
      inFlight++
      // The handler's own catch covers the routing/render body. This covers the
      // rest of it - the prologue that runs before that try, and every
      // `return finish(...)` whose rejection a bare return hands straight past
      // it. A rejection reaching Bun is Bun's fallback page, or a reset socket.
      return runWithWorkUnit('render', () => handleDevRequest(request, server))
        .catch((error: unknown) => devLastResortResponse(error, request))
        .finally(() => {
          inFlight--
        })
    },
    // Nothing should reach here now, but Bun's own fallback is never the answer.
    error: (error: Error) => devLastResortError(error),
  })

  async function handleDevRequest(
    request: Request,
    server: PeerAddressSource & { timeout(request: Request, seconds: number): void },
  ): Promise<Response> {
    const prologueStart = performance.now()
    // The compat implementation graph loads here, on the first request, not at
    // boot — everything a request touches (interceptors, render, compile) is
    // registered by the time this resolves.
    await bootstrapCompat(config, { serve: true })
    installServerRuntimePlugins()
    const unit = getWorkUnit()
    const badRequest = malformedUrlResponse(request)
    if (badRequest) return badRequest
    request = withForwardedHeaders(request, server)
    let url = new URL(request.url)
    const profile = devRequestProfile(request, url)
    if (profile) logDevProfile(profile, 'prologue (bootstrap/headers/url)', prologueStart)
    let pageLog = startDevPageStallTimer(pendingDevPageLoadLog(routes, request, url))
    // Work this request wants started, but only once its own response is out.
    let afterResponse: (() => void) | undefined
    const logAbort = () => {
      const pending = pageLog
      pageLog = undefined
      logDevPageAbort(pending)
    }
    request.signal.addEventListener('abort', logAbort, { once: true })
    const finish = async (response: Response): Promise<Response> => {
      const pending = pageLog
      pageLog = undefined
      request.signal.removeEventListener('abort', logAbort)
      const finalized = await profileDevStep(profile, 'finalize response', () =>
        finalizeResponse(
          response,
          { method: request.method, url: new URL(request.url), headers: request.headers },
          { routeKind: unit?.routeKind ?? 'html', routeMode: unit?.routeMode, dev: true },
        ),
      )
      const logged = logDevPageResponse(pending, finalized)
      // A timer, not a bare call: the response is only handed to Bun when this returns, so anything
      // started synchronously here still races it. That is also why the watch-root sync moved in -
      // a request that compiled a route just materialized its source graph, and re-deriving the
      // roots from it is a synchronous walk the document does not need.
      const tasks = afterResponse
      afterResponse = undefined
      setTimeout(() => {
        tasks?.()
        syncWatchRoots()
      }, 0)
      if (profile) flushDevProfileLines()
      abortUpstreamFetchOnDisconnect(logged.body, request.signal)
      return flushWorkUnitOnClose(logged, unit, request.signal)
    }

    try {
      const initialPrefetchResponse = maybeDevPagePrefetchResponse(routes, url.pathname, request)
      if (initialPrefetchResponse) return finish(initialPrefetchResponse)

      let proxyResponse: Response | undefined
      const proxyResult = await profileDevStep(profile, 'proxy', () =>
        proxyRunner(request, { dev: true, devImportVersion }),
      )
      if (proxyResult instanceof Response) return finish(proxyResult)
      if (proxyResult) {
        request = proxyResult.request
        proxyResponse = proxyResult.response
        url = new URL(request.url)
        const rewrittenLog = pendingDevPageLoadLog(routes, request, url, pageLog?.start)
        clearDevPageStallTimer(pageLog)
        pageLog = startDevPageStallTimer(rewrittenLog)

        const rewrittenPrefetchResponse = maybeDevPagePrefetchResponse(
          routes,
          url.pathname,
          request,
        )
        if (rewrittenPrefetchResponse)
          return finish(applyProxyResponse(rewrittenPrefetchResponse, proxyResponse))
      }

      if (url.pathname === '/__pnext/events') {
        server.timeout(request, 0)
        return finish(eventStream(clients, generation))
      }

      const assetResponse = await profileDevStep(profile, 'built asset lookup', () =>
        maybeBuiltAsset(config, routes, url.pathname),
      )
      if (assetResponse) return finish(applyProxyResponse(assetResponse, proxyResponse))

      const clientChunkResponse = await profileDevStep(profile, 'client chunk lookup', () =>
        maybeDevClientChunk(config, url.pathname),
      )
      if (clientChunkResponse) return finish(applyProxyResponse(clientChunkResponse, proxyResponse))

      const runtimeResponse = maybePrebuiltRuntime(config, url.pathname)
      if (runtimeResponse) return finish(applyProxyResponse(runtimeResponse, proxyResponse))

      const dynChunkMatch = /^\/__pnext\/client-dyn\/([A-Za-z0-9-]+)\.js$/.exec(url.pathname)
      if (dynChunkMatch?.[1]) {
        const id = dynChunkMatch[1]
        const file = await profileDevStep(profile, `client dyn chunk ${id}`, () =>
          devDynamicEntryFile(config, routes, id, url.searchParams.get('r')),
        )
        if (!file)
          return finish(
            applyProxyResponse(new Response('not found', { status: 404 }), proxyResponse),
          )
        return finish(
          applyProxyResponse(
            devResponse(await readFile(file), 'text/javascript; charset=utf-8'),
            proxyResponse,
          ),
        )
      }

      const clientMatch = /^\/__pnext\/client\/(.+)\.js$/.exec(url.pathname)
      if (clientMatch?.[1]) {
        const route = routes.find(
          item =>
            item.id === clientMatch[1] &&
            (item.client || item.clientReferences.length > 0 || item.needsRouterEntry),
        )
        if (!route)
          return finish(
            applyProxyResponse(new Response('not found', { status: 404 }), proxyResponse),
          )
        const file = await profileDevStep(profile, `client build ${route.route}`, () =>
          buildDevClient(config, route),
        )
        return finish(
          applyProxyResponse(
            devResponse(
              await profileDevStep(profile, 'client read', () => readFile(file)),
              'text/javascript; charset=utf-8',
            ),
            proxyResponse,
          ),
        )
      }

      const metadataFile = await profileDevStep(profile, 'static metadata file', () =>
        maybeStaticMetadataFile(config, url),
      )
      if (metadataFile) {
        setWorkUnitRoute('static-asset')
        return finish(applyProxyResponse(metadataFile, proxyResponse))
      }

      const staticResponse = await profileDevStep(profile, 'static lookup', () =>
        maybeStaticFile(config.publicPath, url.pathname),
      )
      if (staticResponse) {
        setWorkUnitRoute('static-asset', 'static')
        return finish(applyProxyResponse(staticResponse, proxyResponse))
      }
      // Emitted assets land in the build output's public dir, not the project public dir.
      if (
        getAssetExtensions()
          .staticAssetPublicPrefixes()
          .some(prefix => url.pathname.startsWith(prefix))
      ) {
        const emitted = await maybeStaticFile(path.join(config.outPath, 'public'), url.pathname)
        if (emitted) {
          setWorkUnitRoute('static-asset', 'static')
          return finish(applyProxyResponse(emitted, proxyResponse))
        }
      }
      const staticAssetPathname = getNextStaticAssetPathname(
        url.pathname,
        config.basePath,
        config.assetPrefix,
      )
      if (staticAssetPathname) {
        const outPublicStatic = await maybeStaticFile(
          path.join(config.outPath, 'public'),
          staticAssetPathname,
        )
        if (outPublicStatic) {
          setWorkUnitRoute('static-asset', 'static')
          return finish(applyProxyResponse(outPublicStatic, proxyResponse))
        }

        // Standalone chunks a bundler extension supplies (compat: the
        // no-module polyfills chunk). The prod build writes them to disk; dev
        // has no client out-dir for them, so serve the contents directly.
        const staticChunk = maybeStaticClientChunk(config, staticAssetPathname)
        if (staticChunk) {
          setWorkUnitRoute('static-asset', 'static')
          return finish(applyProxyResponse(staticChunk, proxyResponse))
        }

        setWorkUnitRoute('static-asset', 'static')
        return finish(
          applyProxyResponse(
            new Response('Not Found', {
              status: 404,
              headers: {
                'cache-control': 'private, no-cache, no-store, max-age=0, must-revalidate',
                'content-type': 'text/plain;charset=utf-8',
              },
            }),
            proxyResponse,
          ),
        )
      }

      // The compat request interceptors run before route matching (registration order: action dispatch -
      // POSTs to a page URL with the action id - then next.config rewrites). A Response short-circuits
      // (wrapped with the proxy response); a `{ request }` swaps the request (a rewrite) and continues.
      // The render keeps the ORIGINAL request URL as canonical; only matching and lookup follow the
      // rewritten url. Pure-core apps register no interceptors.
      const canonicalRequest = request
      const canonicalUrl = new URL(request.url)
      for (const [index, interceptor] of getRequestExtensions().interceptors.entries()) {
        const result = await profileDevStep(
          profile,
          `interceptor ${interceptor.name || index}`,
          () => interceptor(request, { config }),
        )
        if (result instanceof Response) return finish(applyProxyResponse(result, proxyResponse))
        if (result) {
          request = result.request
          url = new URL(request.url)
        }
      }

      const canonicalRedirect = trailingSlashRedirect(config, url, request.method.toUpperCase())
      if (canonicalRedirect) return finish(applyProxyResponse(canonicalRedirect, proxyResponse))

      const nav = parseNavState(request)
      const matched = profileDevSyncStep(profile, 'match route', () =>
        selectRouteForRequest(routes, url.pathname, nav),
      )

      if (!matched) {
        return finish(
          applyProxyResponse(
            await renderGlobalNotFoundResponse({
              config,
              url,
              request: canonicalRequest,
              dev: true,
              devImportVersion,
            }),
            proxyResponse,
          ),
        )
      }

      if (matched.route.kind === 'handler') {
        setWorkUnitRoute('route-handler')
        setPhase('handler')
        return finish(
          applyProxyResponse(
            await profileDevStep(profile, `handler ${matched.route.route}`, () =>
              handleRoute(
                config,
                matched.route,
                canonicalRequest,
                matched.params,
                devImportVersion,
              ),
            ),
            proxyResponse,
          ),
        )
      }

      setWorkUnitRoute('html', matched.route.mode === 'static' ? 'static' : 'dynamic')
      // Same refusal the build makes, at the only point dev has one: a core app
      // with a 'use server' module gets the error document, not a dead form.
      assertNoServerActionsWithoutCompat([matched.route], nextCompatEnabled(config), config.root)
      pageRequestsSeen++
      noteDevCompileStart(matched.route)
      noteDevRouteServed(config, matched.route)
      // Stylesheets are a SEPARATE browser fetch - the HTML never awaits them - so building them here only
      // takes cores off the import the response is blocked on. Handed to `finish` instead: the browser
      // still has to receive and parse the document before it asks, and by then the build is running (or,
      // on a warm hit, already memoized). The hydration chunk is a separate fetch on the same terms.
      const eagerClient = !deferClientStage()
      if (eagerClient) preloadDevClient(config, matched.route, profile)
      const preloadAssets = () => {
        preloadDevPageAssets(config, matched.route, profile)
        if (!eagerClient) preloadDevClient(config, matched.route, profile)
      }
      afterResponse = preloadAssets
      if (!deferAssetPreload()) {
        afterResponse = undefined
        preloadAssets()
      }
      const layoutFiles = profileDevSyncStep(profile, 'find layouts', () =>
        devLayoutFiles(config, matched.route.file),
      )
      let loaders: Awaited<ReturnType<typeof devRouteModuleLoaders>> | undefined
      preloadDevClientReferences(config, matched.route, profile)
      try {
        loaders = await profileDevStep(profile, `route module loaders ${matched.route.route}`, () =>
          devRouteModuleLoaders(config, matched.route, layoutFiles),
        )
      } catch (error) {
        logDevRouteLoaderFallback(matched.route, error)
      }
      // Second chance for the font stage: on most apps the fonts are declared
      // by the root LAYOUT, which the route bundle brings in — so this is
      // where they first exist. Memoized, so the earlier call is not repeated.
      void preloadDevFonts(config, profile)
      return finish(
        applyProxyResponse(
          await profileDevStep(profile, `render page ${matched.route.route}`, () =>
            withRouteRuntime(matched.route.segmentConfig?.runtime, () =>
              renderPageResponse({
                config,
                route: matched.route,
                params: matched.params,
                // The render keeps the ORIGINAL requested URL as canonical
                // (usePathname/useSearchParams); a rewrite only steered matching.
                url: canonicalUrl,
                // Non-action POSTs to a page render the page (Next's MPA
                // fallback for plain form posts / followed 307s), not a 405.
                request:
                  request.method.toUpperCase() === 'POST'
                    ? new Request(canonicalRequest.url, { headers: canonicalRequest.headers })
                    : canonicalRequest,
                dev: true,
                devImportVersion,
                layoutFiles,
                moduleLoader: loaders?.moduleLoader,
                clientModuleLoader: loaders?.clientModuleLoader,
                ...(nav
                  ? {
                      nav: {
                        soft: true,
                        state: nav,
                        childrenPath: matched.childrenPath,
                        targetPath: matched.targetPath,
                      },
                    }
                  : {}),
              }),
            ),
          ),
          proxyResponse,
        ),
      )
    } catch (error) {
      request.signal.removeEventListener('abort', logAbort)
      // The error funnel (compat classifies + reports) fires from this single catch.
      await reportRequestError(
        error,
        { method: request.method, url: request.url, headers: request.headers },
        { phase: unit?.phase, routeKind: unit?.routeKind },
      )
      logDevPageError(pageLog)
      flushWorkUnit(unit)
      // Rethrowing here handed the request to Bun, which answered with its raw
      // __bunfallback payload page (or dropped the connection outright). Nothing
      // downstream can render this one - the render pipeline is where it came
      // from - so dev answers with its own document, always.
      return devLastResortResponse(error, request)
    }
  }

  const warmup = options.warm
    ? afterReady(() => warmDev(config, routes)).catch(error => logDevPreloadError('warm', error))
    : undefined
  // Typegen is the one consumer that needs EVERY route's content facts (mode,
  // hydrated), so it runs last and off the critical path — after the entry
  // route's warm compile. The .d.ts is for the editor, not for serving.
  void Promise.resolve(warmup).then(typegenInBackground)

  return Object.assign(server, { warmup })
}

/**
 * Dev's last resort: an error that escaped the render pipeline's own boundaries.
 * Reaching here means pnext could not build a document the normal way, so the
 * internal-error page (full trace + prefilled report) is the honest answer.
 * Must not throw - it is the thing that runs when everything else already did.
 */
function devLastResortResponse(error: unknown, request: Request): Response {
  let route = request.url
  try {
    route = new URL(request.url).pathname
  } catch {
    // A malformed URL is exactly the kind of request that gets here; keep the raw text.
  }
  return devLastResortError(error, route, request.url, request)
}

export function devLastResortError(
  error: unknown,
  route = '(unknown)',
  url = route,
  request?: Request,
): Response {
  const resolved = error instanceof Error ? error : new Error(String(error))
  if (markErrorLogged(resolved)) console.error(errorLogTrace(resolved))
  let html: string
  try {
    html = internalErrorHtml({
      error: resolved,
      route,
      url,
      digest: (resolved as Error & { digest?: string }).digest,
    })
  } catch {
    html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>pnext error</title></head><body><h1>pnext could not render this request</h1><pre>${escapeHtml(resolved.stack ?? resolved.message)}</pre></body></html>`
  }
  return new Response(withDevReloadScript(html, request), {
    status: 500,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

/**
 * The Ready banner is printed by the caller in the microtask that resolves
 * `startDevServer`, so a timer callback is the earliest point that provably
 * runs after it: warmup can never push the banner out.
 */
function afterReady<T>(task: () => Promise<T>) {
  return new Promise<T>(resolve => setTimeout(() => resolve(task()), 0))
}

async function warmDev(config: ResolvedConfig, routes: RouteManifestEntry[]) {
  // The compat implementation graph — what the first request used to wait on —
  // plus the compile pipeline's fixed first-use costs. Both are memoized at
  // their source, so a request that beats us here joins the same promises
  // instead of starting a second copy.
  await bootstrapCompat(config, { serve: true })
  installServerRuntimePlugins()
  runRequestWarmHooks(config)
  await warmDevModulePipeline(config)
  await warmDevRoutes(config, routes)
}

// Warm what this developer actually opens, not `/` (core spec change 6). The
// routes they hit are recorded next to the compiled cache, so the first boot of
// a checkout compiles nothing and every later one warms the last routes served —
// which, with the cache persisted, is usually a disk read rather than a compile.
const WARM_ROUTES = 3

// Page requests served since boot. The boot warmer reads it to stand down once
// the developer has asked for something concrete (see warmDevRoutes).
let pageRequestsSeen = 0

async function warmDevRoutes(config: ResolvedConfig, routes: RouteManifestEntry[]) {
  const wanted = readDevRouteHistory(config)
    .map(id => routes.find(route => route.id === id && route.kind === 'page'))
    .filter((route): route is RouteManifestEntry => Boolean(route))
    .slice(0, WARM_ROUTES)
  if (wanted.length === 0) return
  // Every route is warmed on its own, in history order, and the whole pass stops the moment a real
  // page request arrives: a request is the developer saying which route they want, which beats the
  // history guess outright, and warming a *different* route beside it only steals CPU from the page
  // they are waiting on (a save landing on in-flight warm work invalidates it and the page pays for
  // it twice). The stand-down covers the stylesheet too, not just the route loop: a page request
  // that arrived first is blocked on its own import, and global.css is a build it does not consume.
  if (deferAssetPreload() && pageRequestsSeen > 0) return
  await buildDevAsset(config, '/assets/global.css', () => buildGlobalCss(config, { dev: true }))
  for (const route of wanted) {
    if (pageRequestsSeen > 0) return
    await warmDevRoute(config, route).catch(() => undefined)
  }
}

async function warmDevRoute(config: ResolvedConfig, route: RouteManifestEntry) {
  noteDevCompileStart(route)
  const start = performance.now()
  const layoutFiles = devLayoutFiles(config, route.file)
  const hasClient = route.client || route.clientReferences.length > 0
  await Promise.allSettled([
    route.cssImports.length > 0
      ? buildDevAsset(config, `/assets/${route.id}.css`, () =>
          buildRouteCss(config, route, { dev: true }),
        )
      : Promise.resolve(),
    devRouteModuleLoaders(config, route, layoutFiles),
    hasClient ? buildDevClient(config, route) : Promise.resolve(),
    warmDevClientReferences(config, route),
    warmDevPageModule(config, route),
  ])
  noteDevCompileDone(route, performance.now() - start)
}

/**
 * A `'use client'` page is the one module of the route the route bundle does NOT carry
 * (`writeDevRouteBundle` leaves it out), so the render imports it on its own. Same href the render
 * resolves, so both callers share one compile and one module registry entry.
 */
async function warmDevPageModule(config: ResolvedConfig, route: RouteManifestEntry) {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  if (process.env.PNEXT_DEV_WARM_PAGE_MODULE === '0' || !route.client || route.kind !== 'page') {
    return
  }
  const href = await devServerModuleHref(config, route.file, undefined, {
    conditionTarget: serverBundleTargetForRuntime(route.segmentConfig?.runtime),
  })
  await drainPreplanBuilds()
  await import(href)
}

/**
 * The client-SSR half of the route: `markClientReferences` imports every SSR-able reference through
 * the CLIENT layer, a different artifact from the browser bundle `buildDevClient` warms. Import the
 * content-addressed artifacts here, alongside the route bundle, so a restart evaluates them once
 * before the render reaches the same module-registry entries.
 *
 * The batchable references are one esbuild pass over the whole set rather than one walk per file
 * (`devClientReferenceModules`); the render joins that same pass. What the pass cannot own - package
 * references, pages-router sources - keeps the per-file naming below.
 */
async function warmDevClientReferences(config: ResolvedConfig, route: RouteManifestEntry) {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  if (process.env.PNEXT_DEV_WARM_CLIENT_REFS === '0') return
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const evaluate = process.env.PNEXT_DEV_PRELOAD_REF_IMPORTS !== '0'
  const target = serverBundleTargetForRuntime(route.segmentConfig?.runtime)
  const { batched, perModule } = devClientReferenceGroups(config, route)
  await Promise.allSettled([
    batched.length > 0
      ? devClientReferenceModules(config, route, { evaluate }).catch(error => {
          console.debug(
            `PNext dev warm failed for the client references of ${route.route}; falling back to per-module loading.`,
            error,
          )
          throw error
        })
      : Promise.resolve(),
    ...perModule.map(async file => {
      const href = await devClientModuleHref(config, file, undefined, target)
      if (evaluate) {
        try {
          await importDevModule(href, { warm: true })
        } catch (error) {
          console.debug(`PNext dev warm evaluation failed for client reference ${file}.`, error)
          throw error
        }
      }
    }),
  ])
}

const HISTORY_LIMIT = 8
let history: string[] | undefined
let historyWrite: Timer | undefined

function historyFile(config: ResolvedConfig) {
  return path.join(cacheRoot(config.outPath), 'warm.json')
}

function readDevRouteHistory(config: ResolvedConfig): string[] {
  if (history) return history
  try {
    const parsed = JSON.parse(readFileSync(historyFile(config), 'utf8')) as unknown
    history = Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : []
  } catch {
    history = []
  }
  return history
}

/** Remember a served route, most recent first — the next boot's warm list. */
function noteDevRouteServed(config: ResolvedConfig, route: RouteManifestEntry) {
  if (route.kind !== 'page') return
  const seen = readDevRouteHistory(config)
  if (seen[0] === route.id) return
  history = [route.id, ...seen.filter(id => id !== route.id)].slice(0, HISTORY_LIMIT)
  if (historyWrite) return
  historyWrite = setTimeout(() => {
    historyWrite = undefined
    void writeText(historyFile(config), JSON.stringify(history ?? [])).catch(() => undefined)
  }, 500)
  historyWrite.unref?.()
}

function logDevRouteLoaderFallback(route: RouteManifestEntry, error: unknown) {
  console.error(
    [
      `PNext dev route bundle failed for ${route.route}; falling back to per-module loading.`,
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    ].join('\n'),
  )
}

interface DevRequestProfile {
  label: string
  start: number
}

function devRequestProfile(request: Request, url: URL): DevRequestProfile | undefined {
  if (!traceEnabled('server')) return undefined
  return {
    label: `${request.method} ${url.pathname}`,
    start: performance.now(),
  }
}

async function profileDevStep<T>(
  profile: DevRequestProfile | undefined,
  label: string,
  task: () => Promise<T>,
) {
  if (!profile) return task()
  const start = performance.now()
  try {
    return await task()
  } finally {
    logDevProfile(profile, label, start)
  }
}

function profileDevSyncStep<T>(
  profile: DevRequestProfile | undefined,
  label: string,
  task: () => T,
) {
  if (!profile) return task()
  const start = performance.now()
  try {
    return task()
  } finally {
    logDevProfile(profile, label, start)
  }
}

function logDevProfile(profile: DevRequestProfile, label: string, start: number) {
  const end = performance.now()
  // Both offsets, not just the end: stages on this path run as concurrent
  // workflows, and overlap is only readable from where each one STARTED.
  recordDevProfileLine(
    `dev-profile ${profile.label} ${label} in ${formatProfileDuration(end - start)} (@${formatProfileDuration(start - profile.start)}..+${formatProfileDuration(end - profile.start)})`,
  )
}

async function handleRoute(
  config: ResolvedConfig,
  route: RouteManifestEntry,
  request: Request,
  params: Record<string, RouteParamValue>,
  devImportVersion: string,
) {
  const routeHref = await devServerModuleHref(config, route.file, devImportVersion, {
    conditionTarget: serverBundleTargetForRuntime(route.segmentConfig?.runtime),
  })
  await drainPreplanBuilds()
  const imported = (await import(routeHref)) as RouteHandlerModule &
    Parameters<typeof metadataRouteHandlerModule>[0]
  const module = (metadataRouteHandlerModule(imported, route) ?? imported) as RouteHandlerModule
  return withRouteRuntime(route.segmentConfig?.runtime, () =>
    runWithCacheScope(() => handleRouteModule(module, request, params, { routeFile: route.file })),
  )
}

function routeClientCacheKey(config: ResolvedConfig, route: RouteManifestEntry) {
  const existing = routeCacheKeys.get(appKey(config.outPath, route.id))
  if (existing) return existing
  const key = devClientCacheKey(config, route, Boolean(config.compat?.next))
  routeCacheKeys.set(appKey(config.outPath, route.id), key)
  return key
}

function preloadDevClient(
  config: ResolvedConfig,
  route: RouteManifestEntry,
  profile: DevRequestProfile | undefined,
) {
  if (!route.client && route.clientReferences.length === 0 && !route.needsRouterEntry) return
  void profileDevStep(profile, `client preload ${route.route}`, () => buildDevClient(config, route))
    .catch(error => logDevPreloadError(`client build for ${route.route}`, error))
    .finally(() => {
      if (profile) flushDevProfileLines()
    })
}

/**
 * The client-SSR artifacts `markClientReferences` imports, named at the top of the request instead of
 * inside the render. The boot warm already does this for a history route, but a first page that outran the
 * warm used to reach it only after the route bundle had imported, so the two ran back to back. Fired here
 * they overlap, and the render's own call joins the same memoized promises.
 */
function preloadDevClientReferences(
  config: ResolvedConfig,
  route: RouteManifestEntry,
  profile: DevRequestProfile | undefined,
) {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  if (process.env.PNEXT_DEV_PRELOAD_REFS === '0') return
  if (route.clientReferences.length > 0) {
    void profileDevStep(profile, `client references preload ${route.route}`, () =>
      warmDevClientReferences(config, route),
    ).catch(error => logDevPreloadError(`client references for ${route.route}`, error))
  }
  void profileDevStep(profile, `page module preload ${route.route}`, () =>
    warmDevPageModule(config, route),
  )
    .then(() => preloadDevFonts(config, profile))
    .catch(error => logDevPreloadError(`page module for ${route.route}`, error))
}

/**
 * Font resolution is network-bound on a cold checkout and the render only asks for it at the very
 * end, so it used to run alone with the box idle. The definitions exist as soon as the app's font
 * module evaluates, so it runs as its own stage alongside the compiles and the render then joins a
 * settled memo.
 */
function preloadDevFonts(config: ResolvedConfig, profile: DevRequestProfile | undefined) {
  return profileDevStep(profile, 'font prewarm', () =>
    getFontExtensions().prewarmFontAssets(config, { dev: true }),
  ).catch(error => logDevPreloadError('font prewarm', error))
}

/** Bisect seam: `PNEXT_DEV_CLIENT_STAGE=eager` restores the in-request firing. */
function deferClientStage() {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  return process.env.PNEXT_DEV_CLIENT_STAGE !== 'eager'
}

/** Bisect seam: `PNEXT_DEV_ASSET_PRELOAD=eager` restores the pre-request firing. */
function deferAssetPreload() {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  return process.env.PNEXT_DEV_ASSET_PRELOAD !== 'eager'
}

function preloadDevPageAssets(
  config: ResolvedConfig,
  route: RouteManifestEntry,
  profile: DevRequestProfile | undefined,
) {
  void profileDevStep(profile, 'asset preload /assets/global.css', () =>
    buildDevAsset(config, '/assets/global.css', () => buildGlobalCss(config, { dev: true })),
  ).catch(error => logDevPreloadError('global css build', error))

  if (route.cssImports.length === 0) return
  void profileDevStep(profile, `asset preload /assets/${route.id}.css`, () =>
    buildDevAsset(config, `/assets/${route.id}.css`, () =>
      buildRouteCss(config, route, { dev: true }),
    ),
  ).catch(error => logDevPreloadError(`route css build for ${route.route}`, error))
}

/** The route's existing layout chain, memoized until a structural save. */
function devLayoutFiles(config: ResolvedConfig, routeFile: string) {
  const cached = routeLayoutFiles.get(routeFile)
  if (cached) return cached
  const files = findLayouts(config.appPath, routeFile).filter(file => existsSync(file))
  routeLayoutFiles.set(routeFile, files)
  return files
}

function logDevPreloadError(label: string, error: unknown) {
  console.error(
    [
      `PNext dev preload failed for ${label}.`,
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    ].join('\n'),
  )
}

/**
 * Deferred dynamic reference by chunk id: a route-scanned dynamic reference
 * (server-component dynamic()), else the pipeline registry (dynamic() inside a
 * 'use client' module, registered by the entry build's rewrite or a sidecar).
 */
function findDeferredDynamicReference(routes: RouteManifestEntry[], id: string) {
  for (const route of routes) {
    const reference = route.clientReferences.find(
      item => item.id === id && item.dynamic && !ssrClientReference(item),
    )
    if (reference) return { route, reference }
  }
  const registered = deferredDynamicRefById(id)
  if (registered)
    return {
      route: routes.find(item => item.id === registered.routeId),
      reference: { id, ...registered },
    }
  return undefined
}

/**
 * The on-demand output of a deferred reference: an entry point of its route's own
 * client build, so it is emitted (and chunk-split against that entry) by the build
 * the route's bundle already runs. `r` names that route; a reference the scan or
 * the registry can place needs no query.
 */
async function devDynamicEntryFile(
  config: ResolvedConfig,
  routes: RouteManifestEntry[],
  id: string,
  routeId: string | null,
) {
  const scoped = routeId ? routes.find(route => route.id === routeId) : undefined
  const route = scoped ?? findDeferredDynamicReference(routes, id)?.route
  if (!route) return undefined
  const outDir = path.dirname(await buildDevClient(config, route))
  const file = path.join(outDir, `${id}.js`)
  return isInside(outDir, file) && existsSync(file) ? file : undefined
}

/** A cached entry never re-ran the pipeline rewrite: recover its chunk-id map. */
async function loadDeferredDynamicSidecar(outDir: string) {
  try {
    const parsed = JSON.parse(
      await readFile(path.join(outDir, DEFERRED_DYNAMIC_SIDECAR), 'utf8'),
    ) as Record<string, { file: string; exportName: string; routeId?: string }>
    for (const [id, ref] of Object.entries(parsed)) {
      if (ref?.file && ref.exportName) registerDeferredDynamicRef(id, ref)
    }
  } catch {
    // No sidecar: the entry has no deferred dynamic refs.
  }
}

// The current scan's routes, per app: the client build must span EVERY client route in one
// esbuild graph (like prod) so shared modules keep one identity — per-route graphs shipped
// per-route copies of shared libraries, breaking context identity across navigations and
// remounting the app shell (splash) on every soft nav.
const devClientRouteSets = new Map<string, RouteManifestEntry[]>()
function setDevClientRoutes(config: ResolvedConfig, routes: RouteManifestEntry[]) {
  devClientRouteSets.set(config.outPath, routes)
}
function devClientBatchRoutes(config: ResolvedConfig, route: RouteManifestEntry) {
  const all = devClientRouteSets.get(config.outPath)
  if (!all?.some(candidate => candidate.id === route.id)) return [route]
  return all.filter(
    candidate =>
      candidate.client || candidate.clientReferences.length > 0 || candidate.needsRouterEntry,
  )
}

async function buildDevClient(config: ResolvedConfig, route: RouteManifestEntry) {
  const batchRoutes = devClientBatchRoutes(config, route)
  const cacheKeys = await Promise.all(batchRoutes.map(entry => routeClientCacheKey(config, entry)))
  const cacheKey =
    batchRoutes.length === 1
      ? cacheKeys[0]!
      : `batch-${clientSourceHash([...cacheKeys].sort().join('\n'))}`
  const outDir = path.join(config.outPath, 'cache', 'client', cacheKey)
  const outFile = path.join(outDir, `${clientEntryName(route)}.js`)

  // Dedup in-flight builds first. A single page view fires up to three requests
  // for the same route's client bundle — the background preload, the entry, and
  // each chunk — and they must share one build. Two esbuild runs into the same
  // outDir would race nameSharedClientChunks' rename and fail with ENOENT.
  const existing = clientBuilds.get(outDir)
  if (existing) return existing

  if (existsSync(outFile)) {
    // Index chunks so chunk requests skip the rebuild fallback — once per outDir,
    // not once per request: the dir name is a content key, so its chunk list is
    // fixed for as long as it exists.
    if (!indexedClientDirs.has(outDir)) {
      await indexClientChunks(outDir)
      await loadDeferredDynamicSidecar(outDir)
      indexedClientDirs.add(outDir)
    }
    return outFile
  }

  // Register the promise synchronously (no await between the get above and this
  // set) so concurrent callers can't both slip past the dedup check.
  const inner = (async () => {
    await ensureDir(outDir)
    // The action stub plugin builds its filter from the DISCOVERED action modules, so discovery has
    // to have run before the build is constructed. A route-module compile arms it, but a batch spans
    // routes no request has reached: unarmed, their `'use server'` imports bundle the real module and
    // drag its server-only dependencies (node:crypto, http, tls) into the client graph — which fails
    // the whole batch, not just that route.
    if (nextCompatEnabled(config)) await getClientActionBundler()?.ensureArmed()
    const file =
      batchRoutes.length === 1
        ? await buildClientEntry({ config, route, outDir, dev: true })
        : await (async () => {
            // Action usage is per-request knowledge in dev; force the action runtime like the
            // single-route dev build always did.
            await buildClientEntries({
              config,
              routes: batchRoutes,
              outDir,
              dev: true,
              hasServerActions: true,
            })
            return outFile
          })()
    // Dedup this generation's chunk bytes against the shared store before serving
    //: identical chunks recur across generations, and this is
    // the one place all of a generation's output exists before requests read it.
    await contentAddressDir(outDir, clientChunkStoreDir(config.outPath))
    await indexClientChunks(outDir)
    indexedClientDirs.add(outDir)
    return file
  })()
  let unregister: () => void = () => undefined
  const stopSignal = new Promise<never>((_, reject) => {
    clientBuildStopWaiters.add(reject)
    unregister = () => void clientBuildStopWaiters.delete(reject)
  })
  // If the watchdog wins the race, `inner` may settle later with no listener.
  inner.catch(() => undefined)
  const build = Promise.race([inner, stopSignal]).finally(() => {
    unregister()
    clientBuilds.delete(outDir)
  })
  clientBuilds.set(outDir, build)
  return build
}

async function maybeDevClientChunk(config: ResolvedConfig, pathname: string) {
  const chunkMatch = /^\/__pnext\/client\/chunks\/(.+\.js)$/.exec(pathname)
  if (!chunkMatch?.[1]) return null
  const file = await resolveDevClientChunk(config, chunkMatch[1])
  return file ? devChunkResponse(await readFile(file)) : null
}

// A chunk only exists because some build emitted it, so a miss never justifies building: wait out
// the in-flight builds, then look across the generations on disk (chunk names are content hashes).
// Building instead cost one full client build per route for a single stale chunk URL.
async function resolveDevClientChunk(config: ResolvedConfig, name: string) {
  const indexed = clientChunks.get(name)
  if (indexed && existsSync(indexed)) return indexed
  await Promise.allSettled([...clientBuilds.values()])
  const settled = clientChunks.get(name)
  if (settled && existsSync(settled)) return settled

  const clientRoot = path.join(config.outPath, 'cache', 'client')
  for (const generation of await readdir(clientRoot).catch(() => [])) {
    const chunksDir = path.join(clientRoot, generation, 'chunks')
    const file = path.join(chunksDir, name)
    if (!isInside(chunksDir, file) || !existsSync(file)) continue
    clientChunks.set(name, file)
    return file
  }
  return undefined
}

/**
 * Serve the prebuilt client runtime. It lives outside `config.outPath` on purpose - a cold page is defined
 * by that directory being wiped, and an artifact wiped with it would be rebuilt on exactly the request it
 * exists to make cheap - so it needs its own route rather than the built-asset lookup.
 */
function maybePrebuiltRuntime(config: ResolvedConfig, pathname: string) {
  const match = /^\/__pnext\/runtime\/([0-9a-f]+)\/(.+\.js)$/.exec(pathname)
  if (!match?.[1] || !match[2]) return null
  const dir = prebuiltRuntimeDir(config, match[1])
  const file = path.join(dir, match[2])
  if (!isInside(dir, file) || !existsSync(file)) return null
  return devChunkResponse(readFileSync(file))
}

/** Serve an extension-supplied standalone chunk by its `/_next/static/chunks/<name>` path. */
function maybeStaticClientChunk(config: ResolvedConfig, staticAssetPathname: string) {
  const match = /^\/_next\/static\/chunks\/([^/]+\.js)$/.exec(staticAssetPathname)
  if (!match?.[1]) return null
  const chunk = getBundlerExtensions()
    .staticClientChunks(config)
    .find(item => item.name === match[1])
  return chunk ? devChunkResponse(chunk.contents) : null
}

async function indexClientChunks(outDir: string) {
  const chunksDir = path.join(outDir, 'chunks')
  if (!existsSync(chunksDir)) return
  for (const file of await listFiles(chunksDir)) {
    if (file.endsWith('.js')) clientChunks.set(path.basename(file), file)
  }
}

// File-convention metadata assets (app/icon.png, apple-icon.png, favicon.ico, opengraph-image.png)
// are emitted by the BUILD, so dev - which has no build output - served none of them and every dev
// document 404'd the very icon/manifest links it had just rendered. Serve the source bytes at the
// URL the document references. Icon/apple-icon queries carry a content identity;
// favicon and manifest use their documented bare routes.
async function maybeStaticMetadataFile(config: ResolvedConfig, url: URL) {
  const target = url.pathname.replace(/^\/+/, '')
  const file = discoverStaticMetadataFiles(config.appPath).find(item => item.outputPath === target)
  if (!file || !existsSync(file.file)) return null
  return new Response(await readFile(file.file), {
    headers: { 'content-type': file.contentType, 'cache-control': staticMetadataCacheControl },
  })
}

async function maybeStaticFile(publicPath: string, pathname: string) {
  const filePath = path.join(publicPath, pathname.replace(/^\/+/, ''))
  if (!isInside(publicPath, filePath) || !existsSync(filePath)) return null
  const fileStat = await stat(filePath)
  if (!fileStat.isFile()) return null
  return devResponse(await readFile(filePath), contentType(filePath))
}

function getNextStaticAssetPathname(
  pathname: string,
  basePath: string | undefined,
  assetPrefix: string | undefined,
) {
  if (pathname.startsWith('/_next/static/')) return pathname
  const normalizedBasePath = normalizePathPrefix(basePath)
  if (normalizedBasePath && pathname.startsWith(`${normalizedBasePath}/_next/static/`)) {
    return pathname.slice(normalizedBasePath.length)
  }
  const normalizedAssetPrefix = normalizePathPrefix(assetPrefix)
  if (normalizedAssetPrefix && pathname.startsWith(`${normalizedAssetPrefix}/_next/static/`)) {
    return pathname.slice(normalizedAssetPrefix.length)
  }
  return null
}

function normalizePathPrefix(prefix: string | undefined): string | null {
  if (!prefix) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(prefix)) return null
  const normalized = `/${prefix.replace(/^\/+|\/+$/g, '')}`
  if (normalized === '/') return null
  return normalized
}

function findClientReferenceCss(routes: RouteManifestEntry[], id: string) {
  return routes
    .flatMap(route => route.clientReferences)
    .find(reference => reference.id === id && reference.cssImports?.length)
}

// Build assets are emitted under `/_next/static/` for a compat app (assetPathname) and `/assets/`
// for core; the dev server answers to both spellings so the document's href and the served route
// cannot drift. Only a flat name aliases - `/_next/static/chunks|media/*` are Next's own paths and
// keep falling through to their handlers.
function builtAssetPathname(config: ResolvedConfig, pathname: string) {
  if (pathname.startsWith('/assets/')) return pathname
  const alias = /^\/_next\/static\/([^/]+)$/.exec(pathname)
  return alias?.[1] && nextCompatEnabled(config) ? `/assets/${alias[1]}` : null
}

async function maybeBuiltAsset(
  config: ResolvedConfig,
  routes: RouteManifestEntry[],
  requestPathname: string,
) {
  const pathname = builtAssetPathname(config, requestPathname)
  if (!pathname) return null
  if (pathname === '/assets/global.css') {
    await buildDevAsset(config, pathname, () => buildGlobalCss(config, { dev: true }))
  } else {
    const cssMatch = /^\/assets\/(.+)\.css$/.exec(pathname)
    const route = cssMatch?.[1] ? routes.find(item => item.id === cssMatch[1]) : undefined
    // Island CSS is only ever requested for a route that already rendered, so
    // the resolved routes are searched first — scanning the rest would compile
    // the whole app to answer one stylesheet request.
    const reference =
      !route && cssMatch?.[1]
        ? (findClientReferenceCss(routes.filter(routeFactsResolved), cssMatch[1]) ??
          findClientReferenceCss(routes, cssMatch[1]))
        : undefined
    if (route) {
      await buildDevAsset(config, pathname, () => buildRouteCss(config, route, { dev: true }))
    } else if (reference) {
      await buildDevAsset(config, pathname, () =>
        buildClientReferenceCss(config, reference, { dev: true }),
      )
    }
  }

  const outPath = config.outPath
  const filePath = path.join(outPath, 'cache', pathname.replace(/^\/+/, ''))
  if (!isInside(path.join(outPath, 'cache'), filePath) || !existsSync(filePath)) return null
  const fileStat = await stat(filePath)
  if (!fileStat.isFile()) return null
  return new Response(await readFile(filePath), {
    headers: { 'content-type': contentType(filePath) },
  })
}

function buildDevAsset(config: ResolvedConfig, pathname: string, build: () => Promise<unknown>) {
  const key = appKey(config.outPath, pathname)
  const existing = assetBuilds.get(key)
  if (existing) return existing
  // Build each asset once per dev version (reload() clears it); drop on failure to allow retry.
  const next = build().catch(error => {
    assetBuilds.delete(key)
    throw error
  })
  assetBuilds.set(key, next)
  return next
}

function maybeDevPagePrefetchResponse(
  routes: RouteManifestEntry[],
  pathname: string,
  request: Request,
) {
  if (!isDevPagePrefetchRequest(request)) return null
  const matched = matchRoute(routes, pathname)
  if (matched?.route.kind !== 'page') return null
  return devPagePrefetchResponse()
}

export function isDevPagePrefetchRequest(request: Request) {
  if (request.method.toUpperCase() !== 'GET') return false
  return (
    headerHasPrefetchToken(request.headers.get('sec-purpose')) ||
    headerHasPrefetchToken(request.headers.get('purpose')) ||
    getRouterProtocolExtensions()
      .prefetchRequestHeaders()
      .some(header => request.headers.get(header) === '1')
  )
}

function headerHasPrefetchToken(value: string | null) {
  return Boolean(value?.split(/[;,\s]+/).some(token => token.toLowerCase() === 'prefetch'))
}

function devPagePrefetchResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      'cache-control': 'no-store',
      'x-pnext-dev-prefetch': 'skipped',
    },
  })
}

interface PendingDevPageLoadLog {
  method: string
  pathname: string
  route: string
  start: number
  stallTimer?: ReturnType<typeof setTimeout>
}

interface DevPageLoadLog {
  method: string
  pathname: string
  route: string
  status: number
  durationMs: number
  note?: string
}

function pendingDevPageLoadLog(
  routes: RouteManifestEntry[],
  request: Request,
  url: URL,
  start = performance.now(),
): PendingDevPageLoadLog | undefined {
  const matched = matchRoute(routes, url.pathname)
  if (matched?.route.kind !== 'page') return undefined
  return {
    method: request.method,
    pathname: url.pathname,
    route: matched.route.route,
    start,
  }
}

// One timer per page request: if the render never resolves, the stall announces
// itself well before Bun's idle timeout turns it into a mystery 499.
function startDevPageStallTimer(pending: PendingDevPageLoadLog | undefined) {
  if (!pending) return pending
  const delay = Math.max(0, DEV_PAGE_STALL_WARNING_MS - (performance.now() - pending.start))
  pending.stallTimer = setTimeout(() => {
    console.warn(
      formatDevPageStallWarning({
        method: pending.method,
        pathname: pending.pathname,
        route: pending.route,
        elapsedMs: performance.now() - pending.start,
      }),
    )
  }, delay)
  pending.stallTimer.unref?.()
  return pending
}

function clearDevPageStallTimer(pending: PendingDevPageLoadLog | undefined) {
  if (!pending?.stallTimer) return
  clearTimeout(pending.stallTimer)
  pending.stallTimer = undefined
}

export function formatDevPageStallWarning(entry: {
  method: string
  pathname: string
  route: string
  elapsedMs: number
}) {
  const route = entry.route === entry.pathname ? '' : dim(`(${entry.route})`)
  return [
    yellow('⚠'),
    dim('page'),
    dim(entry.method),
    cyan(entry.pathname),
    route,
    yellow('still rendering'),
    dim('after'),
    durationLabel(entry.elapsedMs),
    dim('- no response yet'),
  ]
    .filter(Boolean)
    .join(' ')
}

// A 499 that lands on the idle timeout is Bun hanging up on us, not the client.
export function devPageAbortNote(durationMs: number) {
  return durationMs >= DEV_IDLE_TIMEOUT_MS ? 'dev server idle timeout' : undefined
}

function logDevPageResponse(pending: PendingDevPageLoadLog | undefined, response: Response) {
  if (!pending) return response
  clearDevPageStallTimer(pending)
  logDevPageLoad({
    method: pending.method,
    pathname: pending.pathname,
    route: pending.route,
    status: response.status,
    durationMs: performance.now() - pending.start,
  })
  return response
}

function logDevPageError(pending: PendingDevPageLoadLog | undefined) {
  if (!pending) return
  clearDevPageStallTimer(pending)
  logDevPageLoad({
    method: pending.method,
    pathname: pending.pathname,
    route: pending.route,
    status: 500,
    durationMs: performance.now() - pending.start,
  })
}

function logDevPageAbort(pending: PendingDevPageLoadLog | undefined) {
  if (!pending) return
  clearDevPageStallTimer(pending)
  const durationMs = performance.now() - pending.start
  logDevPageLoad({
    method: pending.method,
    pathname: pending.pathname,
    route: pending.route,
    status: 499,
    durationMs,
    note: devPageAbortNote(durationMs),
  })
}

// Print a "Compiling" banner the first time a route is hit in this process,
// so the several-second cold esbuild + Tailwind build isn't a silent stall. The
// timed `page GET ... in Xs` line follows once the response resolves.
function noteDevCompileStart(route: RouteManifestEntry) {
  if (compiledRoutes.has(route.file)) return
  compiledRoutes.add(route.file)
  console.log(`${cyan('○')} ${dim('Compiling')} ${cyan(route.route)} ${dim('...')}`)
}

// Completion line for the warm compile, since no request log fires before the
// browser opens. Mirrors the `page ... in Xs` timing style.
function noteDevCompileDone(route: RouteManifestEntry, durationMs: number) {
  console.log(
    `${green('✓')} ${dim('Compiled')} ${cyan(route.route)} ${dim('in')} ${durationLabel(durationMs)}`,
  )
}

function logDevPageLoad(entry: DevPageLoadLog) {
  console.log(formatDevPageLoadLog(entry))
}

export function formatDevPageLoadLog(entry: DevPageLoadLog) {
  const route = entry.route === entry.pathname ? '' : dim(`(${entry.route})`)
  return [
    dim('page'),
    dim(entry.method),
    cyan(entry.pathname),
    route,
    statusLabel(entry.status),
    dim('in'),
    durationLabel(entry.durationMs),
    entry.note ? yellow(`(${entry.note})`) : '',
  ]
    .filter(Boolean)
    .join(' ')
}

function statusLabel(status: number) {
  const label = String(status)
  if (status >= 500) return red(label)
  if (status >= 400) return yellow(label)
  if (status >= 300) return cyan(label)
  return green(label)
}

function durationLabel(durationMs: number) {
  const label = formatDuration(durationMs)
  if (durationMs >= 1000) return yellow(label)
  if (durationMs >= 250) return cyan(label)
  return green(label)
}

function dim(value: string) {
  return color(2, 22, value)
}

function red(value: string) {
  return color(31, 39, value)
}

function yellow(value: string) {
  return color(33, 39, value)
}

function green(value: string) {
  return color(32, 39, value)
}

function cyan(value: string) {
  return color(36, 39, value)
}

function color(open: number, close: number, value: string) {
  if (!process.stdout.isTTY) return value
  return `\x1b[${open}m${value}\x1b[${close}m`
}

function devResponse(body: BodyInit, contentType: string) {
  return new Response(body, {
    headers: {
      'content-type': contentType,
      'cache-control': 'no-store',
    },
  })
}

// Client chunk filenames are content-hashed (chunks/[name]-[hash].js), so they
// are safe to cache permanently: a source change yields a new hash (new URL).
// The page entry stays `no-store`, so a dev reload re-fetches only the entry and
// any changed chunks instead of the whole 7MB+ graph on every navigation.
function devChunkResponse(body: BodyInit) {
  return new Response(body, {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  })
}

function isInside(root: string, file: string) {
  const relative = path.relative(root, file)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

interface DevWatcher {
  rootsKey: string
  stop(): void
}

function refreshWatcher(
  config: ResolvedConfig,
  routes: RouteManifestEntry[],
  current: DevWatcher | undefined,
  onChange: (change: DevChange) => Promise<void>,
  bootTime: number,
  onEvent: (file: string) => void,
) {
  const roots = devWatchRoots(config, routes)
  const rootsKey = roots.join('\0')
  if (current?.rootsKey === rootsKey) return current
  current?.stop()
  return watchRoots(roots, rootsKey, config.outPath, onChange, bootTime, onEvent)
}

function devWatchRoots(config: ResolvedConfig, routes: RouteManifestEntry[]) {
  const packageRoots = workspacePackageRoots(config.workspaceRoot)
  const roots = new Set([config.appPath])

  // Reading sourceFiles off an unresolved route would scan the whole app at
  // boot — exactly what the deferred route table exists to avoid.
  for (const route of routes.filter(routeFactsResolved)) {
    for (const file of route.sourceFiles) {
      if (isInside(config.appPath, file)) continue
      const packageRoot = packageRoots.find(root => isInside(root, file))
      if (packageRoot) roots.add(packageWatchRoot(packageRoot, file))
      else {
        // An app that is not a declared workspace member has no package root,
        // which used to leave its own components/, lib/ and styles/ unwatched:
        // the server served fresh content but the open page was never told.
        const projectRoot = projectWatchRoot(config.root, file)
        if (projectRoot) roots.add(projectRoot)
      }
    }
  }

  return [...roots].sort()
}

/**
 * The top-level directory under the project root that `file` lives in. Watching
 * the root itself would pull in node_modules and .pnext, so dependencies, dot
 * directories and files sitting directly in the root are not covered.
 */
function projectWatchRoot(root: string, file: string) {
  if (!isInside(root, file)) return undefined
  const [segment, ...rest] = path.relative(root, file).split(path.sep)
  if (!segment || rest.length === 0) return undefined
  if (segment === 'node_modules' || segment.startsWith('.')) return undefined
  return path.join(root, segment)
}

function packageWatchRoot(packageRoot: string, file: string) {
  const relative = path.relative(packageRoot, file)
  const [firstSegment] = relative.split(path.sep)
  if (!firstSegment || firstSegment === '..' || path.isAbsolute(relative)) return packageRoot
  return path.join(packageRoot, firstSegment)
}

/**
 * Can this burst be answered by re-fetching stylesheets alone? Only if every
 * touched file is a plain stylesheet that still exists: a CSS *module* feeds
 * class names into JS bundles, and a file that is gone (or a rename) can move
 * the route table's CSS imports, so both keep the full reload.
 */
function isCssOnlyChange(files: string[]) {
  return (
    files.length > 0 &&
    files.every(file => isCssFile(file) && !/\.module\.[^.]+$/.test(file) && existsSync(file))
  )
}

/** What a watcher burst touched. */
interface DevChange {
  files: string[]
  /** At least one event was a create/delete/rename (an atomic save is one too). */
  renamed: boolean
}

// Once any watch root fails (recursive watch unsupported), the graph goes back
// to re-stating on every request for the life of the process.
let recursiveWatchBroken = false

function watchRoots(
  roots: string[],
  rootsKey: string,
  outPath: string,
  onChange: (change: DevChange) => Promise<void>,
  bootTime: number,
  onEvent: (file: string) => void,
): DevWatcher {
  const controller = new AbortController()
  let pending: Timer | undefined
  let running = false
  let batch: DevChange = { files: [], renamed: false }

  async function flush() {
    if (running || batch.files.length === 0) return
    const change = batch
    batch = { files: [], renamed: false }
    running = true
    try {
      await onChange(change)
    } finally {
      running = false
    }
    if (batch.files.length > 0) await flush()
  }

  function schedule(file: string, renamed: boolean) {
    if (predatesBoot(file, bootTime)) return
    onEvent(file)
    batch.files.push(file)
    batch.renamed ||= renamed
    if (pending) clearTimeout(pending)
    // The coalescing window exists so one save that lands as several events costs one recompile. A
    // stylesheet-only burst has no recompile to coalesce, so it waits a tenth as long; a JS file
    // arriving late just triggers the ordinary reload behind it.
    pending = setTimeout(
      () => {
        pending = undefined
        void flush()
      },
      isCssOnlyChange(batch.files) ? 4 : 40,
    )
  }

  for (const root of roots) {
    void watchRoot(root, controller.signal, schedule, () => {
      recursiveWatchBroken = true
      setDevWatcherFreshness(outPath, false)
    })
  }
  if (!recursiveWatchBroken) setDevWatcherFreshness(outPath, true)

  return {
    rootsKey,
    stop() {
      if (pending) clearTimeout(pending)
      controller.abort()
    },
  }
}

/** A replayed pre-boot event: still on disk, unchanged since before the server read it. */
function predatesBoot(file: string, bootTime: number) {
  const info = statSync(file, { throwIfNoEntry: false })
  return Boolean(info?.isFile() && info.mtimeMs <= bootTime)
}

// Output and dependency churn is not a save: .pnext (the server's own cache
// persists + typegen land there and used to reload the world on every warm
// request), other dot dirs, and node_modules.
const ignoredWatchSegment = /(?:^|[\\/])(?:node_modules|\.[^\\/]+)(?:[\\/]|$)/

/** @internal Test-only: is this root-relative watch event output/dependency churn? */
export function isIgnoredWatchPath(relativeFile: string) {
  return ignoredWatchSegment.test(relativeFile)
}

async function watchRoot(
  root: string,
  signal: AbortSignal,
  onChange: (file: string, structural: boolean) => void,
  onBroken: () => void,
) {
  try {
    const watcher = watch(root, { recursive: true, signal })
    for await (const event of watcher) {
      // No filename (rare, platform-dependent) means we cannot scope the
      // invalidation: treat it as structural so everything is re-derived.
      if (!event.filename) onChange(root, true)
      else if (!ignoredWatchSegment.test(event.filename))
        onChange(path.resolve(root, event.filename), event.eventType === 'rename')
    }
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) return
    // Some platforms do not support recursive watch. Dev still works without
    // live reload, but the graph must then re-stat on every request.
    onBroken()
  }
}

function eventStream(clients: Set<DevEventClient>, generation: number) {
  let client: DevEventClient | undefined
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      client = { controller }
      clients.add(client)
      controller.enqueue(new TextEncoder().encode(`event: ready\ndata: ${generation}\n\n`))
    },
    cancel() {
      if (client) clients.delete(client)
    },
  })
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  })
}

function broadcast(clients: Set<DevEventClient>, event: string) {
  const payload = new TextEncoder().encode(`event: ${event}\ndata: ${Date.now()}\n\n`)
  for (const client of clients) {
    try {
      client.controller.enqueue(payload)
    } catch {
      clients.delete(client)
    }
  }
}
