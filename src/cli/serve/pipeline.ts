/**
 * The production request pipeline. Split out of `start.ts` so the prebundled
 * server entry parses only what listening needs: this module (renderer,
 * routing, runtime — ~700 KB of the bundle) is dynamically imported after the
 * port is bound and the ready banner is printed.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { constants as zlibConstants, createGzip, gzipSync } from 'node:zlib'
import { Readable } from 'node:stream'
import { loadConfig, pathToFileHref } from '../../config'
import type { ResolvedConfig } from '../../config'
import { bootstrapCompat } from '../../compat-bootstrap'
import { registerServerRuntime, serverBundleTargetForRuntime } from '../../runtime/loader'
import { importModuleOnce } from '../../runtime/modules'
import { abortUpstreamFetchOnDisconnect } from '../../runtime/fetch-host'
import { applyProxyResponse, createProxyRunner } from '../../routing/proxy'
import {
  isPprShellUpgradeEligible,
  renderGlobalNotFoundResponse,
  renderPageResponse,
  renderPageWithStatus,
} from '../../render/renderer'
import {
  handleRouteModule,
  routeParamsFromPath,
  type RouteHandlerModule,
} from '../../routing/handler'
import {
  canonicalTrailingSlashPath,
  malformedUrlResponse,
  trailingSlashRedirect,
} from '../../routing/href'
import { type PeerAddressSource, withForwardedHeaders } from '../../routing/forwarded'
import { normalizePathname, parseNavState, selectRouteForRequest } from '../../routing/routes'
import { runWithCacheScope } from '../../request/cache'
import { metadataRouteHandlerModule } from '../../routing/metadata-files'
import {
  finalizeResponse,
  getAssetExtensions,
  getRenderExtensions,
  getProxyExtensions,
  getRequestExtensions,
  reportRequestError,
  runInitHooks,
  setRequestExtensions,
  withRouteRuntime,
} from '../../extensions'
import {
  flushWorkUnit,
  flushWorkUnitOnClose,
  getWorkUnit,
  runWithWorkUnit,
  setPhase,
  setWorkUnitRoute,
} from '../../request/context'
import { setRequestRuntime } from '../../routing/request-environment'
import { getRenderSpanExtensions } from '../../render/hooks'
import { publishEmittedAssets } from '../../css/build'
import { contentType } from '../../utils/content-type'
import { stopEsbuildService } from '../../utils/esbuild'
import { markErrorLogged } from '../../utils/error-log'
import type {
  BuildManifest,
  RouteManifestEntry,
  RouteParamValue,
  StaticFileMetadata,
} from '../../types'

/** Compat module-mode route hrefs are the only prod use of the dev import layer; keep it off the start graph. */
async function moduleHrefForRoute(
  config: ResolvedConfig,
  route: RouteManifestEntry,
): Promise<string> {
  const { devServerModuleHref } = await import('../../runtime/modules')
  return devServerModuleHref(config, route.file, 'build', {
    conditionTarget: serverBundleTargetForRuntime(route.segmentConfig?.runtime),
  })
}

/**
 * The production request handler `pnext start` serves with. Exposed on its own
 * so deployment adapters (e.g. Vercel) can serve the exact same pipeline
 * without the Bun.serve wrapper.
 */
export async function createRequestHandler(
  options: { root?: string; config?: ResolvedConfig; manifest?: BuildManifest } = {},
) {
  // `start` already resolved (and bootstrapped) the config for its output-mode
  // guard; reusing it skips a second loadConfig — env load, pnext.config +
  // next.config imports, app-path resolution — before the ready banner.
  const config = options.config ?? (await loadConfig(options.root, { serve: true }))
  // Compat plugin loader: the single gated seam that populates the core
  // extension registries when compat is enabled (no-op for pure-core apps).
  // A prod server answers the very next request, so it takes both tiers here.
  await bootstrapCompat(config)
  const manifestPath = path.join(config.outPath, 'manifest.json')
  // `start` reads the manifest before binding the port (a missing build must
  // still fail there, not on the first request) and hands it over.
  const manifest =
    options.manifest ?? (JSON.parse(await readFile(manifestPath, 'utf8')) as BuildManifest)
  const persistManifest = () => writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  // Compat action-registry arming + serverActions.bodySizeLimit resolution +
  // fetch-cache install now run through the extension registry: the action
  // dispatch interceptor rebuilds the registry from manifest.actions on the
  // first action request, and runInitHooks installs the Next fetch-cache patch
  // so runtime renders observe force-cache / revalidate TTLs / tags exactly
  // like build prerenders. No-op for pure-core apps.
  runInitHooks(config)
  // Content-hashed asset names, as the build emitted them: a render in THIS
  // process must link the same files, not the logical `global.css` spelling.
  publishEmittedAssets(config.outPath, manifest.assetNames)
  // Publish the live routing state the compat request interceptors (action
  // dispatch, rewrites) read; prod loads the route table once.
  setRequestRuntime({ config, routes: manifest.routes, dev: false })
  const proxyRunner = createProxyRunner(config, {
    compiledModuleHref: manifest.proxyModule
      ? pathToFileHref(path.resolve(config.outPath, manifest.proxyModule))
      : undefined,
  })
  const routesById = new Map(manifest.routes.map(route => [route.id, route]))
  const nextCompat = Boolean(config.compat?.next)
  const regenerating = new Map<string, Promise<void>>()

  /**
   * ISR background regeneration (stale-while-revalidate): re-render the route
   * that produced a prebuilt file whose TTL expired, write the fresh bytes
   * over it, and refresh its manifest metadata (tags/TTL may change between
   * renders). Deduped per file; failures keep serving the stale copy.
   */
  async function regenerateStaticFile(
    pathname: string,
    file: string,
    relative: string,
    metadata: StaticFileMetadata,
    reason: 'stale' | 'on-demand',
  ) {
    if (!metadata.routeId) return
    const route = routesById.get(metadata.routeId)
    if (!route) return
    await runWithWorkUnit('render', async () => {
      const url = new URL(`http://pnext.local${pathname}`)
      const params = routeParamsFromPath(route, pathname)
      const fetchCache = route.segmentConfig?.fetchCache
      try {
        if (route.kind === 'handler') {
          setWorkUnitRoute('route-handler', 'isr', { revalidateReason: reason })
          setPhase('handler')
          registerServerRuntime(config, route.sourceFiles)
          const href = compatModuleMode(config)
            ? await moduleHrefForRoute(config, route)
            : pathToFileHref(route.file)
          const module = await importModuleOnce<Parameters<typeof handleRouteModule>[0]>(href)
          const rendered = await getRenderExtensions().collectRenderMeta(
            () =>
              withRouteRuntime(route.segmentConfig?.runtime, () =>
                runWithCacheScope(() =>
                  handleRouteModule(module, new Request(url), params, { routeFile: route.file }),
                ),
              ),
            { fetchCache, blockingStaleFetches: true, route: pathname, handler: true },
          )
          if (rendered.value.status >= 500) return
          await writeFile(file, new Uint8Array(await rendered.value.arrayBuffer()))
          manifest.staticFiles![relative] = {
            ...metadata,
            status: rendered.value.status,
            headers: [...rendered.value.headers.entries()],
            ...(rendered.tags.length > 0 ? { tags: rendered.tags } : {}),
          }
        } else {
          setWorkUnitRoute('html', 'isr', { revalidateReason: reason })
          setPhase('render')
          const rendered = await getRenderExtensions().collectRenderMeta(
            () =>
              withRouteRuntime(route.segmentConfig?.runtime, () =>
                renderPageWithStatus({
                  config,
                  route,
                  params,
                  url,
                  ...(route.usesRequest ? { request: new Request(url) } : {}),
                  staticMetadataFiles: manifest.staticMetadataFiles,
                  staticModuleMetadata: manifest.staticModuleMetadata,
                  staticRouteMetadata: manifest.staticRouteMetadata,
                }),
              ),
            { fetchCache, blockingStaleFetches: true, route: pathname },
          )
          // A failed regeneration (render threw → 5xx) must not overwrite the
          // good prebuilt copy: Next discards the error and keeps serving the
          // stale page (the error is still logged via the renderer's funnel).
          if (rendered.value.status >= 500) return
          await writeFile(file, rendered.value.html)
          manifest.staticFiles![relative] = {
            ...metadata,
            status: rendered.value.status,
            ...(rendered.tags.length > 0 ? { tags: rendered.tags } : {}),
          }
        }
      } catch (error) {
        const unit = getWorkUnit()
        await reportRequestError(
          error,
          { method: 'GET', url: url.href, headers: new Headers() },
          {
            phase: unit?.phase,
            routeKind: unit?.routeKind,
            ...(unit?.responseHints ?? {}),
          },
        )
        throw error
      }
    })
  }

  function runRegeneration(
    pathname: string,
    file: string,
    relative: string,
    metadata: StaticFileMetadata,
    reason: 'stale' | 'on-demand',
  ) {
    const existing = regenerating.get(file)
    if (existing) return existing
    const task = regenerateStaticFile(pathname, file, relative, metadata, reason)
      .catch(error => {
        console.warn(`pnext start: background revalidate failed for ${pathname}:`, error)
      })
      .finally(() => {
        regenerating.delete(file)
      })
    regenerating.set(file, task)
    return task
  }

  function scheduleRegen(
    pathname: string,
    file: string,
    relative: string,
    metadata: StaticFileMetadata,
  ) {
    void runRegeneration(pathname, file, relative, metadata, 'stale')
  }

  setRequestExtensions({
    onDemandRevalidatePath: async pathname => {
      const built = await builtFileInfo(config.outPath, pathname, manifest.staticFiles)
      if (!built?.metadata) return
      await runRegeneration(pathname, built.file, built.relative, built.metadata, 'on-demand')
    },
  })

  async function renderNotFound(request: Request): Promise<Response> {
    const built = await maybeBuiltFile(
      config.outPath,
      '/404',
      manifest.staticFiles,
      request.method,
      request.headers,
      nextCompat,
    )
    if (built) {
      setWorkUnitRoute('html', 'static')
      const headers = new Headers(built.headers)
      headers.set('x-nextjs-cache', 'HIT')
      if (!hasBuildCapturedCacheControl(manifest.staticFiles?.['404.html'])) {
        headers.delete('cache-control')
      }
      headers.delete('content-length')
      return compressResponse(new Response(built.body, { status: 404, headers }), request)
    }
    return compressResponse(
      await renderGlobalNotFoundResponse({
        config,
        url: new URL(request.url),
        request,
        staticMetadataFiles: manifest.staticMetadataFiles,
        staticModuleMetadata: manifest.staticModuleMetadata,
        staticRouteMetadata: manifest.staticRouteMetadata,
      }),
      request,
    )
  }

  // The boot config compile is the only build work a prod server does; drop the
  // resident esbuild service child (~10+ MB RSS) — it respawns if ever needed.
  stopEsbuildService()

  return function handleRequest(request: Request, server?: PeerAddressSource): Promise<Response> {
    // One work unit spans the whole request; its after-queue flushes once the
    // response fully closes (stream end, redirect, notFound, error, abort).
    return runWithWorkUnit('render', async () => {
      const unit = getWorkUnit()
      try {
        const raw = await handle(request, server)
        const finalized = await finalizeResponse(
          raw,
          { method: request.method, url: new URL(request.url), headers: request.headers },
          {
            routeKind: unit?.routeKind ?? 'html',
            routeMode: unit?.routeMode,
            hints: unit?.responseHints,
          },
        )
        const response = maybeCloseNodeFetchConnection(finalized, request)
        // Wired before the close-observer wraps the body: the stream a handler
        // passed through from fetch is still the one the abort map knows.
        abortUpstreamFetchOnDisconnect(response.body, request.signal)
        return flushWorkUnitOnClose(response, unit, request.signal)
      } catch (error) {
        // A dropped promise here would close the socket without a response
        // (client sees "socket hang up"); surface a 500 instead. The error
        // funnel (compat classifies + reports) fires from this single catch.
        await reportRequestError(
          error,
          { method: request.method, url: request.url, headers: request.headers },
          { phase: unit?.phase, routeKind: unit?.routeKind },
        )
        // Dedupe: the renderer may have already logged this SSR error inline
        // before it propagated here. Log once per error object across log sites.
        if (markErrorLogged(error)) {
          console.error(`pnext start: request failed for ${request.url}:`, error)
        }
        flushWorkUnit(unit)
        return new Response('Internal Server Error', { status: 500 })
      }
    })
  }

  async function handle(request: Request, server?: PeerAddressSource): Promise<Response> {
    const badRequest = malformedUrlResponse(request)
    if (badRequest) return badRequest
    request = withForwardedHeaders(request, server)
    const requestedUrl = new URL(request.url)
    // assetPrefix is independent from basePath. Strip a path-style asset
    // prefix first so `/cdn/_next/static/*` remains servable even when the app
    // itself lives under a different basePath.
    const assetStripped = stripAssetPrefix(request, config.assetPrefix)
    if (assetStripped) request = assetStripped
    // basePath: strip the configured prefix so all downstream routing, static
    // lookup, and handler context see the app-relative path (Next serves the
    // app under basePath; `usePathname`/`req.nextUrl.pathname` exclude it). A
    // request that does not carry the prefix is outside the app → 404.
    if (config.basePath && !assetStripped) {
      const stripped = stripBasePath(request, config.basePath)
      if (!stripped) {
        // Outside the basePath: only a rule that opted out of it (next.config's
        // `basePath: false` rewrites/redirects) may answer. If one rewrites the
        // request back into the app, re-apply the strip; otherwise this is a 404
        // exactly as before.
        const answered = await runOutsideBasePathInterceptors(request, config)
        if (answered instanceof Response) return answered
        const rewritten = answered && stripBasePath(answered.request, config.basePath)
        if (!rewritten) return await renderNotFound(request)
        request = rewritten
      } else {
        request = stripped
      }
    }
    // `/_next/data/<buildId>/<page>.json` is the pages-router data protocol:
    // Next serves it as a request for the PAGE path (trailing slash applied),
    // normalized BEFORE middleware so the handler sees the page URL — or, with
    // skipMiddlewareUrlNormalize, after it (middleware sees the raw data URL).
    const skipProxyNormalize = getProxyExtensions().skipUrlNormalize()
    if (nextCompat && !skipProxyNormalize) {
      request = normalizeDataRequest(request, config) ?? request
    }
    // A request authorized by the preview-mode id is Next's on-demand
    // revalidation: middleware never runs for it and the route re-renders
    // fresh below (the static fast path is skipped).
    const bypassToken = getRequestExtensions().revalidateBypassToken()
    const revalidateBypass = Boolean(
      bypassToken && request.headers.get('x-prerender-revalidate') === bypassToken,
    )
    const canonicalUrl = new URL(request.url)
    const canonicalHeaders = request.headers
    let proxyResponse: Response | undefined
    const proxyResult = revalidateBypass ? undefined : await proxyRunner(request)
    if (proxyResult instanceof Response) return proxyResult
    if (proxyResult) {
      request = proxyResult.request
      proxyResponse = proxyResult.response
    }
    if (nextCompat && skipProxyNormalize) {
      request = normalizeDataRequest(request, config) ?? request
    }

    // The compat request interceptors run after the proxy, before route
    // matching (registration order: action dispatch, then next.config
    // rewrites). A Response short-circuits (wrapped with the proxy response); a
    // { request } swaps the request (a rewrite) and continues. The render keeps
    // the ORIGINAL requested pathname as canonical (usePathname never sees a
    // rewrite's destination path), while matching / static lookup / staleness
    // use the (possibly rewritten) url. Pure-core apps register no
    // interceptors (a no-op).
    for (const interceptor of getRequestExtensions().interceptors) {
      const result = await interceptor(request, { config })
      // Interceptor responses (segment/flight payloads, action results) sit in
      // front of Next's compression middleware too — run them through the same
      // gzip/Vary negotiation as rendered pages.
      if (result instanceof Response)
        return applyProxyResponse(compressResponse(result, request), proxyResponse)
      if (result) request = result.request
    }
    let url = new URL(request.url)
    const rewritten = url.href !== canonicalUrl.href
    // Unlike pathname, Next DOES thread a rewrite's destination query into the page's `searchParams`
    // prop - only the address bar and usePathname() stay on the as-requested path - for both
    // middleware and next.config rewrites. So the canonical request keeps the original pathname but
    // picks up whatever search ended up on the fully-resolved request.
    const canonicalRequestUrl = new URL(canonicalUrl)
    canonicalRequestUrl.search = url.search
    const canonicalRequest =
      canonicalRequestUrl.href === request.url
        ? request
        : new Request(canonicalRequestUrl, { headers: canonicalHeaders })

    const method = request.method.toUpperCase()
    // Trailing-slash normalization applies to the browser-visible (as-requested)
    // URL, never to an internal rewrite destination. A middleware/next.config
    // rewrite to `/en/` must render internally, not 308 the visitor to `/en`.
    const canonicalRedirect = trailingSlashRedirect(config, requestedUrl, method)
    if (canonicalRedirect) return applyProxyResponse(canonicalRedirect, proxyResponse)
    // Soft navigations carry the client's parallel-route state; when the
    // target involves slots, interception, or a host render, the response is
    // state-dependent and must render dynamically (never from prebuilt html).
    const nav = parseNavState(request)
    const selection = selectRouteForRequest(manifest.routes, url.pathname, nav)
    const softDynamic = Boolean(
      nav &&
      selection?.route.kind === 'page' &&
      (selection.route.slotDirs?.length ||
        selection.route.synthetic ||
        selection.route.interception ||
        selection.childrenPath !== normalizePathname(url.pathname)),
    )
    // PPR shells carry an RDC sidecar and must resume through the renderer.
    // Their persisted HTML is only the shell; serving it directly skips the
    // dynamic continuation (and its RDC seed). Non-PPR static pages retain the
    // normal static-file fast path.
    const pprDocumentResume = selection?.route.kind === 'page' && selection.route.ppr
    // Draft mode: a __prerender_bypass cookie skips prebuilt page html so the
    // request falls through to a fresh dynamic render below; non-page assets
    // still serve statically and the stale-page write-back is disabled so a
    // draft render never overwrites the prerendered copy.
    const draftBypass = hasDraftBypassCookie(request.headers)
    // revalidatePath()/revalidateTag() mark prebuilt output stale: skip the static copy (even on a
    // matching etag - the bytes are stale) and fall through to a fresh blocking render. TTL expiry is
    // served stale-while-revalidate instead: the stale copy goes out while a background regeneration
    // rewrites it.
    const built =
      method === 'GET' || method === 'HEAD'
        ? await builtFileInfo(config.outPath, url.pathname, manifest.staticFiles, nextCompat)
        : null
    const hardStaticStale =
      built !== null &&
      // Content-hashed build assets are immutable and are never route outputs, so a
      // revalidatePath/revalidateTag must not mark them stale. Without this,
      // revalidatePath('/', 'layout') - whose pattern matches EVERY path - would flag the client entry
      // script as stale, drop it from static serving, and leave the browser without the router
      // runtime, silently downgrading every soft navigation to a hard one.
      !isImmutableAssetFile(built.relative) &&
      getRequestExtensions().staticStaleness(
        url.pathname,
        built.mtimeMs,
        built.metadata?.tags ?? [],
      )
    const staleReason = built
      ? (getRequestExtensions().staticStalenessReason(
          url.pathname,
          built.mtimeMs,
          built.metadata?.tags ?? [],
        ) ?? 'on-demand')
      : undefined
    const softStale = staleReason === 'soft'
    const staleOnDemand = hardStaticStale && !softStale
    // A `use cache` hard-expiry (cacheLife expire) elapsed: the stale copy is no
    // longer servable — fall through to a fresh blocking render (unlike ISR/SWR,
    // which serves stale while regenerating). Only page HTML is regenerated
    // this way; static handler bodies keep SWR semantics.
    const hardExpired =
      built?.metadata?.expireSeconds !== undefined &&
      isHtmlPageFile(built.file) &&
      Date.now() - built.mtimeMs >= built.metadata.expireSeconds * 1000
    // Route-shape bypasses (a PPR page resumes through the renderer; a soft navigation with
    // parallel-slot state re-renders) only apply when the built file IS the page's HTML. A plain ASSET
    // whose path merely matches a page route pattern must always serve statically - rendering the
    // route for it hands the browser HTML for a module script.
    const builtIsPageHtml = built !== null && isHtmlPageFile(built.file)
    if (
      built &&
      !staleOnDemand &&
      !(softDynamic && builtIsPageHtml) &&
      !(pprDocumentResume && builtIsPageHtml) &&
      !hardExpired &&
      !revalidateBypass
    ) {
      const servedBuilt = built
      const metadata = built.metadata
      const route = metadata?.routeId ? routesById.get(metadata.routeId) : undefined
      if (
        route?.segmentConfig?.runtime === 'edge' ||
        route?.segmentConfig?.runtime === 'experimental-edge'
      ) {
        withRouteRuntime(route.segmentConfig.runtime, () => undefined)
      }
      // A stale static handler body keeps stale-while-revalidate semantics: the generic serving path
      // below serves the stale bytes immediately with an x-nextjs-cache: STALE marker and schedules
      // the regeneration in the background. Awaiting the regen here would race that background refresh
      // - a fast regen would complete first and serve FRESH bytes where the client expects STALE.
      const staticFile = await maybeBuiltFile(
        config.outPath,
        url.pathname,
        manifest.staticFiles,
        request.method,
        request.headers,
        nextCompat,
      )
      if (staticFile && !(draftBypass && isHtmlResponse(staticFile))) {
        const staticMode = servedBuilt.metadata?.revalidateSeconds !== undefined ? 'isr' : 'static'
        setWorkUnitRoute(
          isHtmlResponse(staticFile) ? 'html' : 'static-asset',
          staticMode,
          servedBuilt.metadata?.revalidateSeconds !== undefined
            ? { revalidateSeconds: servedBuilt.metadata.revalidateSeconds }
            : undefined,
        )
        // A prebuilt DOCUMENT's cache-control belongs to the response finalizer,
        // which owns the one rule (Next's static / ISR / dynamic values) for
        // rendered and prebuilt pages alike. maybeBuiltFile's `no-cache` is its
        // asset default, not a claim; a build-captured header is a claim and stays.
        if (isHtmlResponse(staticFile) && !hasBuildCapturedCacheControl(servedBuilt.metadata)) {
          staticFile.headers.delete('cache-control')
        }
        if (servedBuilt.metadata) {
          const servedTtl = servedBuilt.metadata.revalidateSeconds
          const expired =
            softStale ||
            (servedTtl !== undefined && Date.now() - servedBuilt.mtimeMs >= servedTtl * 1000)
          if (expired) {
            scheduleRegen(
              url.pathname,
              servedBuilt.file,
              servedBuilt.relative,
              servedBuilt.metadata,
            )
            staticFile.headers.set('x-nextjs-cache', 'STALE')
          } else {
            staticFile.headers.set('x-nextjs-cache', 'HIT')
          }
        }
        return applyProxyResponse(compressResponse(staticFile, request), proxyResponse)
      }
    }
    if (url.pathname.startsWith('/_next/static/') && !built) {
      setWorkUnitRoute('static-asset')
      return applyProxyResponse(
        new Response('Not Found', {
          status: 404,
          headers: {
            'cache-control': 'private, no-cache, no-store, max-age=0, must-revalidate',
            'content-type': 'text/plain;charset=utf-8',
          },
        }),
        proxyResponse,
      )
    }
    const stalePage =
      built && (staleOnDemand || hardExpired) && isHtmlPageFile(built.file) ? built.file : null

    const matched = selection
    if (!matched) {
      return applyProxyResponse(await renderNotFound(canonicalRequest), proxyResponse)
    }
    if (matched.route.kind === 'handler') {
      setWorkUnitRoute(
        'route-handler',
        staleOnDemand ? 'isr' : routeModeOf(matched.route),
        responseHintsFor(matched.route, staleReason),
      )
      setPhase('handler')
      // On-demand revalidated renders refetch their data caches (Next's
      // isOnDemandRevalidate semantics) and persist the fresh bytes so
      // subsequent requests serve the regenerated static copy again.
      const renderedHandler = await getRenderExtensions().collectRenderMeta(
        () => handleRoute(config, matched.route, canonicalRequest, matched.params),
        {
          fetchCache: matched.route.segmentConfig?.fetchCache,
          refreshFetches: staleOnDemand,
          route: url.pathname,
          handler: true,
        },
      )
      const handlerResponse = renderedHandler.value
      if (
        built &&
        staleOnDemand &&
        !stalePage &&
        method === 'GET' &&
        handlerResponse.status === 200
      ) {
        try {
          await writeFile(built.file, new Uint8Array(await handlerResponse.clone().arrayBuffer()))
          handlerResponse.headers.set('x-nextjs-cache', 'MISS')
        } catch {
          // Best-effort like the page path below: a read-only serving filesystem
          // (a serverless host) costs the cache write, never the response.
        }
      }
      if (
        !built &&
        matched.route.hasStaticParams &&
        // force-dynamic / revalidate 0 opt the handler out of static output:
        // every request must re-run it (generateSitemaps + force-dynamic must
        // produce a fresh sitemap per request — dynamic-in-generate-params).
        matched.route.segmentConfig?.dynamic !== 'force-dynamic' &&
        matched.route.segmentConfig?.revalidate !== 0 &&
        method === 'GET' &&
        handlerResponse.status < 500
      ) {
        const file = lazyStaticHandlerPath(config.outPath, url.pathname)
        // Same best-effort contract as the page path below.
        try {
          if (!file) throw new Error('unsafe path')
          await mkdir(path.dirname(file), { recursive: true })
          await writeFile(file, new Uint8Array(await handlerResponse.clone().arrayBuffer()))
          const relative = path
            .relative(path.join(config.outPath, 'public'), file)
            .split(path.sep)
            .join('/')
          const routeRevalidate = matched.route.segmentConfig?.revalidate
          const revalidateSeconds =
            typeof routeRevalidate === 'number' && routeRevalidate > 0
              ? renderedHandler.revalidateSeconds === undefined
                ? routeRevalidate
                : Math.min(routeRevalidate, renderedHandler.revalidateSeconds)
              : renderedHandler.revalidateSeconds
          manifest.staticFiles ??= {}
          manifest.staticFiles[relative] = {
            status: handlerResponse.status,
            headers: [...handlerResponse.headers.entries()],
            routeId: matched.route.id,
            ...(revalidateSeconds !== undefined ? { revalidateSeconds } : {}),
            ...(renderedHandler.tags.length > 0 ? { tags: renderedHandler.tags } : {}),
          }
          await persistManifest()
          handlerResponse.headers.set('x-nextjs-cache', 'MISS')
        } catch {
          // Lazy caching is best-effort; the response is still served.
        }
      }
      return applyProxyResponse(handlerResponse, proxyResponse)
    }

    // dynamic = 'error': request-data access is a hard error instead of a
    // dynamic render (Next fails these at build; we surface a 500 at runtime).
    if (matched.route.segmentConfig?.dynamic === 'error' && matched.route.usesRequest) {
      return applyProxyResponse(
        new Response(
          `Page with dynamic = "error" encountered dynamic data method on ${url.pathname}`,
          { status: 500 },
        ),
        proxyResponse,
      )
    }

    // dynamicParams=false: dynamic segments governed by it must resolve to a
    // prerendered param set; anything else is a 404. (Prebuilt paths were
    // already served from the static output above.)
    if (!dynamicParamsAllowed(matched.route, matched.params)) {
      return applyProxyResponse(await renderNotFound(canonicalRequest), proxyResponse)
    }

    // force-static routes render with an empty request and no search params
    // even when served dynamically (Next returns empty cookies/headers/params).
    const forceStaticRoute = matched.route.segmentConfig?.dynamic === 'force-static'
    const renderUrl = forceStaticRoute
      ? new URL(canonicalUrl.pathname, canonicalUrl.origin)
      : canonicalRequestUrl
    // Non-action POSTs to a page render the page like Next's MPA fallback (a
    // plain <form method="POST"> submit, or a browser following a 307/308 from
    // a route handler) instead of a 405.
    const renderRequest = forceStaticRoute
      ? new Request(renderUrl)
      : method === 'POST'
        ? new Request(canonicalRequest.url, { headers: canonicalRequest.headers })
        : canonicalRequest
    const pageRevalidateReason = stalePage ? staleReason : hardExpired ? 'on-demand' : undefined
    setWorkUnitRoute(
      'html',
      pageRevalidateReason ? 'isr' : routeModeOf(matched.route),
      responseHintsFor(matched.route, pageRevalidateReason),
    )
    const renderMatchedPage = () =>
      withRouteRuntime(matched.route.segmentConfig?.runtime, () =>
        renderPageResponse({
          config,
          route: matched.route,
          params: matched.params,
          url: renderUrl,
          request: renderRequest,
          staticMetadataFiles: manifest.staticMetadataFiles,
          staticModuleMetadata: manifest.staticModuleMetadata,
          staticRouteMetadata: manifest.staticRouteMetadata,
          ...(nav || rewritten
            ? {
                nav: {
                  ...(nav ? { soft: true, state: nav } : {}),
                  childrenPath: matched.childrenPath,
                  targetPath: matched.targetPath,
                },
              }
            : {}),
        }),
      )
    // Every render carries a cache-meta scope: the route's fetchCache config
    // drives fetch cache-mode defaults; on-demand revalidated renders also
    // refetch their data caches (Next's isOnDemandRevalidate semantics).
    const renderedPage = await getRenderExtensions().collectRenderMeta(renderMatchedPage, {
      fetchCache: matched.route.segmentConfig?.fetchCache,
      refreshFetches: Boolean(stalePage),
      route: url.pathname,
    })
    const renderRevalidateSeconds =
      renderedPage.revalidateSeconds ??
      (typeof matched.route.segmentConfig?.revalidate === 'number'
        ? matched.route.segmentConfig.revalidate
        : undefined)
    // Only a POSITIVE revalidate window is ISR: `revalidate = 0` is Next's fully-dynamic opt-out
    // (never cached, dynamic staleTime). Promoting a 0-second window to 'isr' handed the route the
    // STATIC client staleTime via the segment finalizer, so a soft push to an already-visited dynamic
    // page reused the first render.
    //
    // ...and only a route that actually rendered statically can be ISR: a fetch-level
    // `next.revalidate` sets that fetch's DATA cache TTL and must never convert a request-API page
    // into ISR. Promoting one handed the document and its _rsc payload a browser-cacheable s-maxage,
    // so after a server action revalidated the path the browser replayed the pre-revalidation payload.
    // A `segmentConfig.revalidate > 0` route is already classified 'isr' by routeModeOf above.
    const renderWasDynamic =
      matched.route.mode === 'dynamic' || matched.route.usesRequest || renderedPage.noStore === true
    if (renderRevalidateSeconds !== undefined && renderRevalidateSeconds > 0 && !renderWasDynamic) {
      setWorkUnitRoute('html', 'isr', {
        ...(getWorkUnit()?.responseHints ?? {}),
        revalidateSeconds: renderRevalidateSeconds,
      })
    }
    const pageResponse = renderedPage.value

    // A PPR resume replays the prebuilt shell without re-running the
    // components whose react-dom preload()/font hints produced the prerender's
    // `Link` header — re-emit the build-captured value (Next serves the
    // prerender's stored headers the same way).
    if (matched.route.linkHeader && !pageResponse.headers.has('link')) {
      pageResponse.headers.set('link', matched.route.linkHeader)
    }

    // A prebuilt `use cache` page never re-runs its cache scopes, so the render
    // response finalizer can't stamp its SWR cache-control / x-nextjs-stale-time
    // (for PPR routes the cacheLife is stashed on the shell-resume work unit, not
    // this one). Re-emit them from the route's build-captured cacheLife.
    const cacheLifeHeaders = cacheLifeResponseHeaders(matched.route.cacheLife)
    if (cacheLifeHeaders.length > 0 && matched.route.kind === 'page') {
      for (const [key, value] of cacheLifeHeaders) {
        if (key === 'cache-control' && pageResponse.headers.has('cache-control')) continue
        pageResponse.headers.set(key, value)
      }
    }

    // Lazily generated static paths (force-static, or a static-capable route
    // whose param set wasn't prerendered): persist the render so subsequent
    // requests serve it as a HIT, Next-style.
    const lazyStaticCapable =
      matched.route.kind === 'page' &&
      // A request that can promote a fallback shell into a more specific route
      // shell must keep re-entering the renderer: caching its first (still
      // un-upgraded) render on disk would serve every later request as a HIT
      // and the upgraded shell would never reach the client.
      !isPprShellUpgradeEligible(config, matched.route, url) &&
      (forceStaticRoute ||
        (!matched.route.usesRequest &&
          // Next never statically caches `runtime = 'edge'` pages (they are
          // excluded from build prerendering too — see build.ts); their data
          // stability comes from the fetch cache alone.
          matched.route.segmentConfig?.runtime !== 'edge' &&
          (matched.route.hasStaticParams || matched.route.mode === 'static')))
    if (
      !stalePage &&
      !built &&
      !nav &&
      !draftBypass &&
      lazyStaticCapable &&
      !renderedPage.noStore &&
      method === 'GET' &&
      url.search === '' &&
      pageResponse.status === 200 &&
      (pageResponse.headers.get('content-type') ?? '').includes('text/html')
    ) {
      try {
        const file = lazyStaticHtmlPath(config.outPath, url.pathname)
        if (!file) throw new Error('unsafe path')
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(file, await pageResponse.clone().text())
        const relative = path
          .relative(path.join(config.outPath, 'public'), file)
          .split(path.sep)
          .join('/')
        manifest.staticFiles ??= {}
        manifest.staticFiles[relative] = {
          status: 200,
          // Persist the cacheLife SWR headers (and the route's prerendered
          // Link header) so later static HITs (served by maybeBuiltFile
          // straight off disk) re-emit them without a render.
          headers: [
            ...(matched.route.linkHeader
              ? ([['link', matched.route.linkHeader]] as [string, string][])
              : []),
            ...cacheLifeHeaders,
          ],
          routeId: matched.route.id,
          kind: 'page',
          ...(renderedPage.revalidateSeconds !== undefined
            ? { revalidateSeconds: renderedPage.revalidateSeconds }
            : {}),
          ...(matched.route.cacheLife?.expireSeconds !== undefined
            ? { expireSeconds: matched.route.cacheLife.expireSeconds }
            : {}),
          ...(matched.route.cacheLife?.staleSeconds !== undefined
            ? { staleSeconds: matched.route.cacheLife.staleSeconds }
            : {}),
          ...(renderedPage.tags.length > 0 ? { tags: renderedPage.tags } : {}),
        }
        pageResponse.headers.set('x-nextjs-cache', 'MISS')
      } catch {
        // Lazy caching is best-effort; the response is still served.
      }
    }
    // Write the fresh render back over the stale prebuilt html so subsequent requests serve the
    // regenerated static copy again. A client soft-navigation render is request-scoped - persisting it
    // would freeze a transient view over the prebuilt copy AND clear the on-demand staleness (the
    // written mtime outruns the revalidation timestamp), so a following hard reload would serve the
    // frozen soft-nav HTML instead of re-prerendering.
    if (
      stalePage &&
      !nav &&
      !softDynamic &&
      !draftBypass &&
      method === 'GET' &&
      pageResponse.status === 200 &&
      (pageResponse.headers.get('content-type') ?? '').includes('text/html')
    ) {
      try {
        await writeFile(stalePage, await pageResponse.clone().text())
        pageResponse.headers.set('x-nextjs-cache', 'MISS')
      } catch {
        // Best-effort write-back; the stale copy stays and the fresh render still serves.
      }
    }
    // On-demand revalidation (valid x-prerender-revalidate): the fresh render
    // replaces any prebuilt copy and is reported as REVALIDATED (Next's
    // res.revalidate() / revalidatePath-over-HTTP semantics).
    if (revalidateBypass) {
      if (
        built &&
        method === 'GET' &&
        pageResponse.status === 200 &&
        (pageResponse.headers.get('content-type') ?? '').includes('text/html')
      ) {
        try {
          await writeFile(built.file, await pageResponse.clone().text())
        } catch {
          // Best-effort: an on-demand revalidation still returns the fresh
          // render when the prebuilt copy cannot be replaced.
        }
      }
      pageResponse.headers.set('x-nextjs-cache', 'REVALIDATED')
    }
    return applyProxyResponse(compressResponse(pageResponse, request), proxyResponse)
  }
}

// Rewrite a `/_next/data/<buildId>/<page>.json` request into a request for the
// page path itself (Next's data-route normalization): `/index` maps to `/`,
// the app's trailing-slash rule applies, and the `x-nextjs-data` marker header
// is stamped so downstream (middleware protocol, the compat pages-data
// interceptor) can tell it apart from a document request. Non-data URLs (and
// non-GET/HEAD methods) return null.
function normalizeDataRequest(
  request: Request,
  config: { trailingSlash?: boolean },
): Request | null {
  const method = request.method.toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') return null
  const url = new URL(request.url)
  const match = /^\/_next\/data\/[^/]+(\/.+)\.json$/.exec(url.pathname)
  if (!match) return null
  const page = match[1] === '/index' ? '/' : match[1]!
  url.pathname = canonicalTrailingSlashPath(page, Boolean(config.trailingSlash))
  const headers = new Headers(request.headers)
  headers.set('x-nextjs-data', '1')
  return new Request(url, { method, headers })
}

// Give the basePath-independent interceptors (compat's `basePath: false`
// rewrites/redirects) their turn at a path core would otherwise 404. Returns the
// answering Response, a swapped request to continue with, or undefined when no
// rule claims it. A pure-core app registers none, so this is a no-op.
async function runOutsideBasePathInterceptors(
  request: Request,
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<Response | { request: Request } | undefined> {
  for (const interceptor of getRequestExtensions().outsideBasePathInterceptors) {
    const result = await interceptor(request, { config, outsideBasePath: true })
    if (result) return result
  }
  return undefined
}

// Remove the configured basePath prefix from the request URL, returning a
// rewritten Request. Matches `/basePath` exactly and `/basePath/...`; returns
// null when the path is outside basePath (Next 404s those). The root of the
// app (`/basePath`) maps to `/`.
function stripBasePath(request: Request, basePath: string): Request | null {
  const url = new URL(request.url)
  const { pathname } = url
  if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) return null
  url.pathname = pathname.slice(basePath.length) || '/'
  return new Request(url, request)
}

// Remove a configured PATH-style assetPrefix from an asset request URL so the
// static lookup resolves. Only `<prefix>/assets/*` and `<prefix>/_next/static/*`
// are stripped (asset URLs); other paths pass through untouched. Returns null
// when the prefix is absent or the path is not a prefixed asset path. For an
// absolute prefix, only its pathname is matched so local production starts can
// serve the same generated asset URLs.
function stripAssetPrefix(request: Request, assetPrefix: string | undefined): Request | null {
  if (!assetPrefix) return null
  let prefixValue = assetPrefix
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(assetPrefix)) {
    prefixValue = new URL(assetPrefix).pathname
  }
  const prefix = `/${prefixValue.replace(/^\/+|\/+$/g, '')}`
  if (prefix === '/') return null
  const url = new URL(request.url)
  const { pathname } = url
  if (
    !pathname.startsWith(`${prefix}/assets/`) &&
    !pathname.startsWith(`${prefix}/_next/static/`)
  ) {
    return null
  }
  url.pathname = pathname.slice(prefix.length)
  return new Request(url, request)
}

function maybeCloseNodeFetchConnection(response: Response, request: Request) {
  const userAgent = request.headers.get('user-agent') ?? ''
  if (!userAgent.includes('node-fetch')) return response
  response.headers.set('connection', 'close')
  return response
}

// Compat mode gate (a pure read of config.compat, no compat import): under
// compat the compiled module is loaded so bare next/* / react aliases resolve
// to the compat layer. Mirrors compat/aliases.ts reactCompatEnabled — kept inline
// so start.ts carries no static edge into compat.
function compatModuleMode(config: Awaited<ReturnType<typeof loadConfig>>): boolean {
  return Boolean(config.compat?.next || config.compat?.react || config.compat?.reactCompiler)
}

async function handleRoute(
  config: Awaited<ReturnType<typeof loadConfig>>,
  route: RouteManifestEntry,
  request: Request,
  params: Record<string, RouteParamValue>,
) {
  return withRouteRuntime(route.segmentConfig?.runtime, async () => {
    registerServerRuntime(config, route.sourceFiles)
    // Module resolution and handler invocation run through the render-span seam
    // (compat/otel emits `resolve page components` + `executing api route`;
    // pass-through for pure-core apps).
    const spans = getRenderSpanExtensions()
    const module = await spans.withFindPageComponentsSpan(route.route, async () => {
      // Compat mode loads the compiled module (aliases baked in): a raw import
      // would resolve bare next/* specifiers (next/headers etc.) against whatever
      // next package is installed instead of the compat layer — Bun's runtime
      // onResolve plugin cannot alias bare imports. Same pattern as pageRender.
      const href = compatModuleMode(config)
        ? await moduleHrefForRoute(config, route)
        : new URL(`file://${route.file}`).href
      const imported = await importModuleOnce<
        RouteHandlerModule & Parameters<typeof metadataRouteHandlerModule>[0]
      >(href)
      return (metadataRouteHandlerModule(imported, route) ?? imported) as RouteHandlerModule
    })
    return spans.withRouteHandlerSpan(route.route, () =>
      runWithCacheScope(() =>
        handleRouteModule(module, request, params, { routeFile: route.file }),
      ),
    )
  })
}

// Draft mode (draftMode().enable() from next/headers) marks the browser with
// a bypass cookie; requests carrying it must not see prerendered page html.
function hasDraftBypassCookie(headers: Headers) {
  return /(?:^|;\s*)__prerender_bypass=/.test(headers.get('cookie') ?? '')
}

function isHtmlResponse(response: Response) {
  return (response.headers.get('content-type') ?? '').includes('text/html')
}

// Core's coarse route caching disposition for the work unit / finalizers. ISR
// (a static route with a revalidate TTL) is reported as 'isr'; compat can refine
// the exact cache-control strings in its response finalizers.
function routeModeOf(route: RouteManifestEntry): 'static' | 'isr' | 'dynamic' {
  if (route.segmentConfig?.dynamic === 'force-dynamic') return 'dynamic'
  const revalidate = route.segmentConfig?.revalidate
  if (typeof revalidate === 'number' && revalidate > 0) return 'isr'
  return route.mode === 'static' ? 'static' : 'dynamic'
}

// Compat classification hints carried on the work unit for response finalizers:
// the revalidate reason (on-demand vs stale) and the route's runtime (so compat
// can stamp `x-edge-runtime` on edge routes). Undefined when neither applies.
function responseHintsFor(
  route: RouteManifestEntry,
  revalidateReason: string | undefined,
): Record<string, unknown> | undefined {
  const runtime = route.segmentConfig?.runtime
  const revalidate = route.segmentConfig?.revalidate
  if (!revalidateReason && !runtime && typeof revalidate !== 'number') return undefined
  return {
    ...(revalidateReason ? { revalidateReason } : {}),
    ...(runtime ? { runtime } : {}),
    ...(typeof revalidate === 'number' && revalidate > 0 ? { revalidateSeconds: revalidate } : {}),
  }
}

interface BuiltFileInfo {
  file: string
  relative: string
  mtimeMs: number
  metadata?: StaticFileMetadata
}

function hasBuildCapturedCacheControl(metadata: StaticFileMetadata | undefined): boolean {
  return (metadata?.headers ?? []).some(([key]) => key.toLowerCase() === 'cache-control')
}

// The prebuilt output file a GET for `pathname` would serve (page html or a
// static route-handler body), plus its ISR metadata from the build manifest.
async function builtFileInfo(
  outPath: string,
  pathname: string,
  staticFiles: Record<string, StaticFileMetadata> = {},
  nextStaticFallback = false,
): Promise<BuiltFileInfo | null> {
  const file = await firstFile(
    path.join(outPath, 'public'),
    builtFileCandidates(outPath, pathname, nextStaticFallback),
  )
  if (!file) return null
  const publicPath = path.join(outPath, 'public')
  const fileStat = await stat(file)
  const relative = path.relative(publicPath, file).split(path.sep).join('/')
  return { file, relative, mtimeMs: fileStat.mtimeMs, metadata: staticFiles[relative] }
}

// The prebuilt files a GET for `pathname` could resolve to, most-specific
// first: the dir layout (`/a/index.html`), a raw static asset (`/a`), and the
// flat export layout (`/a.html`, output:'export' + trailingSlash:false).
function builtFileCandidates(
  outPath: string,
  pathname: string,
  nextStaticFallback = false,
): string[] {
  const publicPath = path.join(outPath, 'public')
  const trimmed = pathname.replace(/^\/+/, '')
  if (pathname === '/') return [path.join(publicPath, 'index.html')]
  const candidates = [
    path.join(publicPath, trimmed, 'index.html'),
    path.join(publicPath, trimmed),
    path.join(publicPath, `${trimmed.replace(/\/+$/, '')}.html`),
  ]
  // Prerendered pages for generateStaticParams values with special characters
  // live under the DECODED segment (`sticks & stones/`), while the request
  // pathname arrives percent-encoded (prerender-encoding suite).
  try {
    const decoded = decodeURIComponent(trimmed)
    if (decoded !== trimmed && !decoded.split('/').some(seg => seg === '..' || seg === '')) {
      candidates.push(
        path.join(publicPath, decoded, 'index.html'),
        path.join(publicPath, `${decoded.replace(/\/+$/, '')}.html`),
      )
    }
  } catch {
    // malformed escape — encoded candidates only
  }
  if (nextStaticFallback && trimmed.startsWith('_next/static/')) {
    const asset = trimmed.slice('_next/static/'.length)
    candidates.push(path.join(publicPath, 'assets', asset))
  }
  return candidates
}

// Where a lazily generated page for `pathname` is persisted (mirrors the
// build's staticHtmlPath); null when the path would escape public/.
function lazyStaticHtmlPath(outPath: string, pathname: string): string | null {
  const publicPath = path.join(outPath, 'public')
  const file =
    pathname === '/'
      ? path.join(publicPath, 'index.html')
      : path.join(publicPath, pathname.replace(/^\/+|\/+$/g, ''), 'index.html')
  const relative = path.relative(publicPath, file)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  return file
}

function lazyStaticHandlerPath(outPath: string, pathname: string): string | null {
  if (pathname === '/') return null
  const publicPath = path.join(outPath, 'public')
  const file = path.join(publicPath, pathname.replace(/^\/+|\/+$/g, ''))
  const relative = path.relative(publicPath, file)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  return file
}

function isHtmlPageFile(file: string) {
  return file.endsWith('.html')
}

/**
 * The SWR cache-control and x-nextjs-stale-time headers a `use cache` route's build-captured
 * cacheLife implies. A pure static HIT never re-runs the render header finalizer, so start.ts
 * re-emits these from the persisted cacheLife. Returns [] when none applies.
 */
function cacheLifeResponseHeaders(life: RouteManifestEntry['cacheLife']): [string, string][] {
  if (!life) return []
  const headers: [string, string][] = []
  const { revalidateSeconds, expireSeconds, staleSeconds } = life
  if (revalidateSeconds !== undefined && expireSeconds !== undefined) {
    const swr = Math.max(0, expireSeconds - revalidateSeconds)
    headers.push(['cache-control', `s-maxage=${revalidateSeconds}, stale-while-revalidate=${swr}`])
  }
  if (staleSeconds !== undefined) headers.push(['x-nextjs-stale-time', String(staleSeconds)])
  return headers
}

// A content-hashed, immutable build asset (client runtime chunks under
// `assets/`, Next static files under `_next/static/`) identified by its
// public-relative path. These are never route outputs and must be exempt from
// revalidatePath/revalidateTag staleness, unlike prebuilt page HTML and
// route-handler bodies. `relative` uses forward slashes (see builtFileInfo).
function isImmutableAssetFile(relative: string) {
  return relative.startsWith('assets/') || relative.startsWith('_next/static/')
}

// `dynamicParams = false` (route segment config): params governed by the
// declaration must match one of the build's static param sets. When
// the page has its own static params export, the route behaves like Next's
// fallback: false — the full param tuple must match a prerendered path.
function dynamicParamsAllowed(route: RouteManifestEntry, params: Record<string, RouteParamValue>) {
  const governed = route.segmentConfig?.dynamicParamsFalse
  if (!governed?.length) return true
  const allowed = route.prerenderedParams ?? []
  const required = route.segmentConfig?.strictDynamicParams
    ? [...route.params, ...(route.catchAll ? [route.catchAll] : [])]
    : governed
  return allowed.some(set => required.every(param => paramValueEqual(set[param], params[param])))
}

function paramValueEqual(a: RouteParamValue | undefined, b: RouteParamValue | undefined) {
  if (a === undefined || b === undefined) return false
  const join = (value: RouteParamValue) => (Array.isArray(value) ? value.join('/') : value)
  return join(a) === join(b)
}

export async function maybeBuiltFile(
  outPath: string,
  pathname: string,
  staticFiles: Record<string, StaticFileMetadata> = {},
  method = 'GET',
  requestHeaders?: Headers,
  nextStaticFallback = false,
) {
  const normalizedMethod = method.toUpperCase()
  if (normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') return null

  const publicPath = path.join(outPath, 'public')
  const file = await firstFile(
    publicPath,
    builtFileCandidates(outPath, pathname, nextStaticFallback),
  )
  if (!file) return null
  const relative = path.relative(publicPath, file).split(path.sep).join('/')
  const metadata = staticFiles[relative]
  const headers = new Headers(metadata?.headers)
  if (!headers.has('content-type')) headers.set('content-type', contentType(file))

  const fileStat = await stat(file)
  // Vary discriminator: a router-originated fetch gets its Content-Type rewritten downstream (compat
  // swaps it to text/x-component for soft-nav requests) without this file or its etag changing. The
  // response's `Vary` header already lists `rsc` as differentiating, so the validator must differ too
  // - otherwise a browser that cached one representation gets a 304 on a later request for the OTHER
  // and silently reuses the wrong body and content-type.
  const variant = requestHeaders?.get('rsc') === '1' ? '-rsc' : ''
  const etag = `W/"${fileStat.size.toString(16)}-${Math.trunc(fileStat.mtimeMs).toString(16)}${variant}"`
  if (!headers.has('cache-control')) {
    headers.set('cache-control', immutableAssetPath(relative) ? immutableCacheControl : 'no-cache')
    headers.set('etag', etag)
    if (requestHeaders?.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers })
    }
  }

  const raw = await readFile(file)
  let body: BodyInit = raw
  if (
    compressibleContentType(headers.get('content-type') ?? '') &&
    raw.length > 1024 &&
    acceptsGzip(requestHeaders)
  ) {
    const zipped = cachedGzip(`${file}:${etag}`, raw)
    if (zipped.length < raw.length) {
      body = zipped as Uint8Array<ArrayBuffer>
      headers.set('content-encoding', 'gzip')
      headers.append('vary', 'accept-encoding')
    }
  }

  return new Response(normalizedMethod === 'HEAD' ? null : body, {
    status: metadata?.status ?? 200,
    headers,
  })
}

// Wrap dynamic responses (rendered pages, not-found) in streaming gzip.
// Static files are compressed once and cached above; anything already
// encoded or non-text passes through untouched.
// Append a token to the Vary header without duplicating existing entries.
function appendVaryToken(headers: Headers, token: string): void {
  const existing = headers.get('vary')
  if (!existing) {
    headers.set('vary', token)
    return
  }
  const tokens = existing.split(',').map(part => part.trim().toLowerCase())
  if (tokens.includes(token.toLowerCase()) || tokens.includes('*')) return
  headers.set('vary', `${existing}, ${token}`)
}

export function compressResponse(response: Response, request: Request) {
  if (!response.body || response.status === 304 || response.status === 204) return response
  if (response.headers.get('content-encoding')) return response
  if (!compressibleContentType(response.headers.get('content-type') ?? '')) return response

  const headers = new Headers(response.headers)
  // `compress: true` advertises encoding negotiability on every compressible
  // response — even when the client didn't send Accept-Encoding — so caches key
  // on it (matches Next's compression middleware, which sets Vary before it
  // decides whether to gzip). The flight-request vary assertion expects this.
  appendVaryToken(headers, 'accept-encoding')
  if (!acceptsGzip(request.headers)) {
    return new Response(response.body, { status: response.status, headers })
  }
  // Match Next's compression middleware threshold: bodies with a known
  // length at or below 1KB are served identity-encoded (Content-Length kept).
  const knownLength = Number(headers.get('content-length'))
  if (Number.isFinite(knownLength) && knownLength <= 1024) {
    return new Response(response.body, { status: response.status, headers })
  }
  headers.set('content-encoding', 'gzip')
  headers.delete('content-length')
  return new Response(streamingGzip(response.body), {
    status: response.status,
    headers,
  })
}

// Gzip a streaming response, flushing the compressor after every source chunk
// (Z_SYNC_FLUSH) so each React/RSC flush reaches the client immediately. The Web
// `CompressionStream('gzip')` buffers until it has a full deflate block or the
// source ends, which stalls incremental streaming: a shell flushed before a
// slow/suspended subtree would never reach fetch clients until the response
// closed (next-after-app's incomplete-stream tests, and streaming Suspense in
// general). A per-chunk sync flush keeps the stream observable at the cost of a
// slightly worse ratio on tiny early chunks.
function streamingGzip(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const gzip = createGzip()
  const reader = body.getReader()
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        gzip.write(value)
        // Emit the bytes buffered so far as a flushable block.
        await new Promise<void>(resolve => gzip.flush(zlibConstants.Z_SYNC_FLUSH, resolve))
      }
      gzip.end()
    } catch (error) {
      gzip.destroy(error as Error)
      reader.cancel(error).catch(() => undefined)
    }
  })()
  return Readable.toWeb(gzip) as unknown as ReadableStream<Uint8Array>
}

function compressibleContentType(type: string) {
  return /^(text\/|application\/(javascript|json|manifest|xml)|image\/svg)/.test(type)
}

function acceptsGzip(requestHeaders?: Headers) {
  return requestHeaders?.get('accept-encoding')?.includes('gzip') ?? false
}

// Bounded by the build's compressible assets; entries are keyed on content
// identity (path + etag), so a rebuild naturally replaces stale ones.
const gzipCache = new Map<string, Buffer>()
const gzipCacheLimit = 512

function cachedGzip(key: string, body: Buffer) {
  const cached = gzipCache.get(key)
  if (cached) return cached
  const zipped = gzipSync(body, { level: 6 })
  if (gzipCache.size >= gzipCacheLimit) {
    const oldest = gzipCache.keys().next().value
    if (oldest !== undefined) gzipCache.delete(oldest)
  }
  gzipCache.set(key, zipped)
  return zipped
}

export const immutableCacheControl = 'public, max-age=31536000, immutable'

/**
 * Everything the build emits under `assets/` (served at `/_next/static/*` in
 * compat) is immutable, which is the promise Next makes for that whole
 * namespace. It holds because every one of those names carries a content hash:
 * esbuild's for chunks and fonts, assetContentHash for the route entries and the
 * stylesheets (see fingerprintClientEntries / fingerprintAsset), and a build id
 * for `_next/static/<id>/_*Manifest.js`. An UNHASHED name must never reach here —
 * the same URL would answer different bytes after a deploy, and every browser
 * that saw the old ones would keep them for a year.
 *
 * Route outputs (prerendered html, handler bodies) live outside both prefixes
 * and stay revalidating; the public/ tree the app ships is likewise untouched.
 */
export function immutableAssetPath(relativePath: string) {
  if (relativePath.startsWith('assets/') || relativePath.startsWith('_next/static/')) return true
  return getAssetExtensions()
    .staticAssetPublicPrefixes()
    .some(prefix => relativePath.startsWith(prefix.replace(/^\/+/, '')))
}

async function firstFile(root: string, files: string[]) {
  for (const file of files) {
    if (!isInside(root, file)) continue
    if (!existsSync(file)) continue
    if ((await stat(file)).isFile()) return file
  }
  return null
}

function isInside(root: string, file: string) {
  const relative = path.relative(root, file)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}
