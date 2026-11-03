// Segment-prefetch responder (COMPAT): answers `/_tree` with the RootTreePrefetch payload and the body
// segments (`/_index`, `/_layout`, `/_page`, `/_head`) with framed HTML payloads, and stamps
// x-nextjs-stale-time on ordinary prefetch responses. Short-circuits BEFORE route matching / static
// lookup. The `_rsc` cache-buster is a CDN key, never an app search param. Registered by ../register/segment.ts.

import type { ResolvedConfig } from '../../config'
import { paramSetMatches } from '../static-params'
import type { RouteManifestEntry, RouteParamValue } from '../../types'
import { nextCompatEnabled } from '../../compat/aliases'
import {
  getRenderExtensions,
  type RequestInterceptor,
  type ResponseFinalizer,
  type ResponseFinalizerContext,
  withRouteRuntime,
} from '../../extensions'
import { getRequestRuntime } from '../../routing/request-environment'
import { redirectInterceptor } from '../actions/extensions'
import { takeCacheLifeStash } from '../cache/use-cache'
import { matchInterception, parseNavState, selectRouteForRequest } from '../../routing/match'
import {
  paramsPrerendered,
  routeParamKeys,
  subShellKey,
  pprShellPath,
  pprSubShellPath,
  renderPageResponse,
  routeModuleTags,
  shellStaleSeconds,
  LATE_METADATA_MARKER,
} from '../../render/renderer'
import { RUNTIME_SESSION, runtimeNeededBits } from '../../render/ppr'

const pprShell = () => import('../../render/ppr-shell')
import { RUNTIME_SHELL } from '../../render/postpone'
import {
  NEXT_ROUTER_PREFETCH_HEADER,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
  RSC_HEADER,
  RSC_CONTENT_TYPE_HEADER,
} from '../next/dist/client/components/app-router-headers'
import {
  bodySegmentFile,
  buildRootTreePrefetch,
  DEFAULT_DYNAMIC_STALE_TIME_SECONDS,
  DEFAULT_STATIC_STALE_TIME_SECONDS,
  segmentMetaFile,
  segmentBodyResponse,
  SEGMENT_ROUTE_HEADER,
  shellSegmentFile,
  ROUTE_SEGMENT_PATH,
  TREE_SEGMENT_PATH,
  treeSegmentFile,
  treePrefetchResponse,
  PrefetchHint,
  type RootTreePrefetch,
  type SegmentAppShell,
  type SegmentMeta,
  type SegmentVaryInfo,
} from './tree'
import {
  responseVaryParamsFromWire,
  restrictVary,
  varyNamesFor,
  withVaryParamsTracking,
  type ResponseVaryParams,
} from './vary-params'
import { pageHasInPageSuspense } from './loading-boundary'
import { pageSlotFrame, stripPageSlotContent } from './page-slot'
import { withoutInlineCss } from '../css/inline-css'
import { nextExperimental } from '../next/config-loader'
import { CACHE_BUSTING_REDIRECT_HEADER, mergeRouterVary } from '../protocol'
import { parseCookieHeader } from '../cache-control'
import { nextRoutePattern } from '../../routing/match'
import { routeRuntimePrefetch, staticSiblingNames } from '../next/route-state'
import { appRootParams } from '../ppr/root-params-scan'
import { loadCompatRewrites, resolveCompatRewrite, type CompatRewrite } from '../next/rewrites'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { writeFileAtomic } from '../../utils/fs'

/** experimental.staleTimes.{static,dynamic} from next.config (seconds). */
function configuredStaleTimes(): { static?: number; dynamic?: number } {
  const { staleTimes } = nextExperimental<{ staleTimes: { static?: unknown; dynamic?: unknown } }>()
  return {
    ...(typeof staleTimes?.static === 'number' ? { static: staleTimes.static } : {}),
    ...(typeof staleTimes?.dynamic === 'number' ? { dynamic: staleTimes.dynamic } : {}),
  }
}

function validateRscRequestHeaders(): boolean {
  return (
    nextExperimental<{ validateRSCRequestHeaders: unknown }>().validateRSCRequestHeaders === true
  )
}

function deploymentId(): string {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  return process.env.NEXT_DEPLOYMENT_ID || process.env.NEXT_PUBLIC_BUILD_ID || 'pnext'
}

/** Effective staleTime (seconds) for a route of the given disposition. */
export function staleTimeSecondsFor(isStatic: boolean): number {
  const configured = configuredStaleTimes()
  if (isStatic) return configured.static ?? DEFAULT_STATIC_STALE_TIME_SECONDS
  return configured.dynamic ?? DEFAULT_DYNAMIC_STALE_TIME_SECONDS
}

/** The segment-prefetch header value, or null when this isn't a segment prefetch. */
function segmentPrefetchTarget(request: Request): string | null {
  if (request.headers.get(RSC_HEADER) !== '1') return null
  // A runtime prefetch (`next-router-prefetch: 2`) asks for the whole route body.
  if (runtimePrefetchRequest(request)) return '/_index'
  return request.headers.get(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER)
}

/** A runtime prefetch: `2` (this URL's own) or `3` (the route's runtime App Shell). */
function runtimePrefetchRequest(request: Request): boolean {
  return (
    /^[23]$/.test(request.headers.get(NEXT_ROUTER_PREFETCH_HEADER) ?? '') &&
    !request.headers.has(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER)
  )
}

/** The route's root params (at or above a root layout): a runtime App Shell keeps them concrete. */
function rootParamNames(config: ResolvedConfig, route: RouteManifestEntry): string[] {
  const names = appRootParams(config)
  return route.params.filter(name => names.has(name))
}

const TREE_WARM_MS = 1000
/** Tree prefetches whose shell warm still waits for the body prefetch that follows. */
const pendingTreeWarms = new Map<string, ReturnType<typeof setTimeout>>()

// No server-side "`_rsc` predates the last revalidation" bounce: Next never issues one, and it would
// leak server state across browser sessions (a replayed hash answering 302 instead of the payload).

/**
 * A cache-busting redirect to a per-variant `_rsc` URL, byte-for-byte Next's wire form (307 + a
 * PATH-RELATIVE Location):
 *
 *  - 307, not 302. A prefetch that lands on a 302 is invisible to the e2e router-act helper, which
 *    only follows 307/308.
 *  - Relative Location. An absolute URL is built from the URL the ORIGIN server sees, which behind a
 *    proxy/CDN is its internal port - following it would bypass the CDN the client is talking to.
 *
 * It is CACHEABLE (no `cache-control: no-store`): the Location already folds the request's
 * negotiation headers into its `_rsc` token, so a Vary-ignoring CDN that replays the cached redirect
 * still sends each variant to its own URL. Marking it no-store instead broke a reference CDN, which
 * drops the redirect status+Location for non-cacheable responses.
 */
function cacheBustingRedirect(location: string): Response {
  const target = new URL(location)
  return new Response(null, {
    status: 307,
    headers: {
      location: `${target.pathname}${target.search}`,
      // Protocol marker: this 307 is a CDN key rotation, not an app redirect()
      // — the finalizer must not fold it into Next's 200+Location RSC form
      // (see normalizeRscRedirectStatus, which strips this header).
      [CACHE_BUSTING_REDIRECT_HEADER]: '1',
    },
  })
}

export const segmentPrefetchInterceptor: RequestInterceptor = async (request, ctx) => {
  const config = ctx.config
  if (!nextCompatEnabled(config)) return undefined
  const segment = segmentPrefetchTarget(request)
  const isRscRequest = request.headers.get(RSC_HEADER) === '1'
  if (segment === null && !isRscRequest) return undefined
  const method = request.method.toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') return undefined
  if (segment === null && request.headers.has('x-pnext-soft-nav')) return undefined
  // next.config redirects precede every RSC response, as on the full-render path.
  const redirect = await redirectInterceptor(request, ctx)
  if (redirect) return redirect

  const runtime = getRequestRuntime()
  if (!runtime) return undefined

  const url = new URL(request.url)
  if (segment !== null && validateRscRequestHeaders() && !url.searchParams.has('_rsc')) {
    // Redirect a header-only (no `_rsc`) prefetch to its per-variant cache-
    // busting URL. The Location folds this request's negotiation headers into
    // the `_rsc` token so distinct variants resolve to distinct URLs.
    return cacheBustingRedirect(withRscQuery(url, request.headers))
  }
  // next.config `rewrites` must apply on the RSC/segment serving path too. This
  // interceptor short-circuits BEFORE the register-actions rewrite interceptor
  // runs, so config rewrites (and their x-nextjs-rewritten-path/query headers)
  // would never fire on RSC requests without resolving them here. When a rewrite
  // matches we serve the destination route and stamp the rewritten headers
  // directly (interceptor responses bypass the protocol finalizer). When it does
  // NOT match we fall through unchanged, and the register-actions interceptor
  // handles the full-render path as before.
  const rewrite = await resolveSegmentRewrite(config, request, url)
  const matchPathname = rewrite?.pathname ?? url.pathname
  const rewriteHeaders = rewrite?.headers

  // The `_rsc` cache-buster is a CDN key, not an app param: it never reaches
  // route matching.
  const selection = selectRouteForRequest(runtime.routes, matchPathname, undefined, request.headers)

  // A pnext-router prefetch carries the origin's nav state. When an
  // interception entry targets this URL from that origin, the segment/RSC
  // fast path must NOT serve: it renders without nav context, so the cached
  // document would lack the intercepted slot content and the navigation that
  // reuses it would commit the un-intercepted page (modal suites regressed
  // exactly this way). Fall through to the host-render path instead.
  const prefetchNav = parseNavState(request)
  if (
    prefetchNav &&
    ((prefetchNav.children &&
      matchInterception(runtime.routes, matchPathname, prefetchNav.children, request.headers)) ||
      (selection?.route.kind === 'page' &&
        (selection.route.slotDirs?.length || selection.route.synthetic)))
  ) {
    return undefined
  }
  const isStatic = selection?.route.kind === 'page' && selection.route.mode === 'static'

  // A tree prefetch warms the URL's shell, but its body prefetch (served first, so the client learns
  // it was a fallback and retries) takes the scheduling over when it arrives in time.
  if (segment === TREE_SEGMENT_PATH && selection?.route.kind === 'page' && selection.route.ppr) {
    const route = selection.route
    if (!pendingTreeWarms.has(matchPathname)) {
      pendingTreeWarms.set(
        matchPathname,
        setTimeout(() => {
          pendingTreeWarms.delete(matchPathname)
          void pprShell().then(shell =>
            shell.schedulePprShellUpgrade({ config, route, url: new URL(request.url) }),
          )
        }, TREE_WARM_MS).unref(),
      )
    }
  }

  if (segment === null) {
    if (selection?.route.kind !== 'page') return undefined
    const meta = readSegmentMeta(config.outPath, selection.route.id)
    // A PREFETCH (`next-router-prefetch: 1`) is answered with the cheap route-metadata payload - it only
    // has to teach the client the route's identity and staleness window. A plain `rsc: 1` fetch is the
    // full-route flight request Next answers with the route's rendered content, so render the page for
    // those the same way the PPR branch does.
    const isPrefetchRequest = request.headers.get(NEXT_ROUTER_PREFETCH_HEADER) === '1'
    if (selection.route.ppr || !isPrefetchRequest) {
      const response = await getRenderExtensions().collectRenderMeta(
        () =>
          // A flight body carries stylesheet REFERENCES, never inlined CSS
          // (`experimental.inlineCss` is a document-only optimization) — see
          // compat/css/inline-css.ts.
          withoutInlineCss(() =>
            withRouteRuntime(selection.route.segmentConfig?.runtime, () =>
              renderPageResponse({
                config,
                route: selection.route,
                params: selection.params,
                url,
                request,
              }),
            ),
          ),
        {
          fetchCache: selection.route.segmentConfig?.fetchCache,
          route: matchPathname,
        },
      )
      // pnext's full-route RSC body is the rendered document (HTML-swap
      // protocol), but a flight response must never LOOK like a document: the
      // root-param fallback suites assert the body of an `RSC: 1` fetch does
      // not contain `<!DOCTYPE html>` (while resume-data-cache asserts it DOES
      // carry the page's content). Strip the doctype prefix and append the
      // route's flight segment marker (Next's payload names the leaf segment
      // `__PAGE__`, which the inline-css suite sanity-checks for); this path
      // never serves the pnext client router (x-pnext-soft-nav bails out above).
      const rscBody = stripDocumentDoctype(
        response.value,
        flightSegmentMarker(selection.route.id, isStatic),
      )
      rscBody.headers.set('content-type', RSC_CONTENT_TYPE_HEADER)
      rscBody.headers.set('x-nextjs-stale-time', String(effectiveStaleTime(meta, isStatic)))
      rscBody.headers.set('x-nextjs-deployment-id', deploymentId())
      rscBody.headers.set('cache-control', 'private, no-store')
      return withRewriteHeaders(rscBody, rewriteHeaders)
    }
    return withRewriteHeaders(
      fullRouteRscResponse(
        selection.route.id,
        isStatic,
        effectiveStaleTime(meta, isStatic),
        routeStaticChildren(runtime.routes, selection.route),
      ),
      rewriteHeaders,
    )
  }

  // Beyond `/_tree`: a framed segment payload. A segment request never falls through to the
  // document/static path, which would pair text/x-component headers with a full HTML document.
  if (segment !== TREE_SEGMENT_PATH) {
    const miss = () => withRewriteHeaders(segmentMissResponse(), rewriteHeaders)
    if (selection?.route.kind !== 'page') return miss()
    const route = selection.route
    const meta = readSegmentMeta(config.outPath, route.id)
    const isBodySegment = segment === ROUTE_SEGMENT_PATH || segment === '/_index'
    const renderSegment = () =>
      renderRuntimeSegment({
        config,
        selection,
        pathname: matchPathname,
        url,
        request,
        nav: prefetchNav,
      })
    // `/_layout`: the document with the page's markup cut out, keyed on the LAYOUT vary set. Not
    // truncated at the loading boundary: a baked fallback shell never read the params and would
    // publish an empty set, sharing one layout frame across every param value.
    if (segment === LAYOUT_SEGMENT_PATH) {
      const rendered = await renderSegment()
      if (!rendered) return miss()
      return withRewriteHeaders(
        segmentBodyResponse({
          body: stripPageSlotContent(rendered.body),
          staleTime: effectiveStaleTime(meta, true),
          postponed: true,
          prerendered: isStatic,
          deploymentId: deploymentId(),
          segment,
          // An empty tracked set on a params route is indistinguishable from an untracked prerender
          // cache hit; under-varying serves one param's layout for another, so publish none.
          vary: varyTrusted(rendered.vary, selection, 'layout')
            ? segmentVaryInfo(rendered.vary, 'layout', selection)
            : undefined,
        }),
        rewriteHeaders,
      )
    }
    // `/_page`: the page slot alone (the client owns the layout chain), tracked honestly like `/_layout`.
    if (segment === PAGE_SEGMENT_PATH) {
      const rendered = await renderSegment()
      if (!rendered) return miss()
      const frame = pageSlotFrame(rendered.body)
      // No page slot (markers dropped, a global error page): the frame cannot line up, so MISS.
      if (frame === null) return miss()
      return withRewriteHeaders(
        segmentBodyResponse({
          body: frame,
          // A postponed frame's static stage is the shell: it reuses for the shell's window.
          staleTime: rendered.postponed
            ? shellStaleSeconds(route)
            : effectiveStaleTime(meta, isStatic),
          postponed: true,
          prerendered: isStatic,
          deploymentId: deploymentId(),
          segment,
          vary: varyTrusted(rendered.vary, selection, 'page')
            ? segmentVaryInfo(rendered.vary, 'page', selection)
            : undefined,
        }),
        rewriteHeaders,
      )
    }
    // `/_head`: the outlined dynamic head of a full prefetch, fetched as its own response.
    if (segment === HEAD_SEGMENT_PATH) {
      const rendered = await renderSegment()
      const title = rendered ? extractDocumentTitle(rendered.body) : null
      if (title === null) return miss()
      return withRewriteHeaders(
        segmentBodyResponse({
          body: title,
          staleTime: effectiveStaleTime(meta, false),
          deploymentId: deploymentId(),
          segment,
          vary: segmentVaryInfo(rendered!.vary, 'head', selection),
        }),
        rewriteHeaders,
      )
    }
    // A FULL prefetch of a Partial Prefetching route is served like a default one (static shell,
    // dynamic boundaries left as holes) and marked so the client still treats it as a shell.
    const partialPrefetchDowngrade =
      !request.headers.has(NEXT_ROUTER_PREFETCH_HEADER) && routeRuntimePrefetch(route)
    const partialPrefetch =
      request.headers.get(NEXT_ROUTER_PREFETCH_HEADER) === '1' || partialPrefetchDowngrade
    const runtimePrefetch = routeUsesRuntimePrefetch(route)
    const serveSharedShell = async (prerendered: boolean) => {
      const shell = await renderInstantPrefetchShell({
        config,
        selection,
        pathname: matchPathname,
        url,
        request,
        fallbackParams: true,
      })
      return shell
        ? withRewriteHeaders(
            segmentBodyResponse({
              body: shell.html,
              staleTime: effectiveStaleTime(meta, true),
              // A shell, not the page: the navigation still fetches the continuation.
              postponed: true,
              // A pure function of the ROUTE (its params hung): paintable for any URL of the route.
              prerendered,
              deploymentId: deploymentId(),
              segment,
              vary: segmentVaryInfo(shell.vary, 'body', selection),
            }),
            rewriteHeaders,
          )
        : null
    }
    // A runtime prefetch (`2`/`3`), or a route opting into runtime-prefetch rendering (`unstable_instant`,
    // `allow-runtime`): the body is a request-sampled prerender, never persisted. The route's opt-in, not
    // the header, selects it: the client always sends `next-router-prefetch: 1`.
    if (
      isBodySegment &&
      !partialPrefetchDowngrade &&
      (runtimePrefetchRequest(request) || routeRuntimePrefetchRender(route))
    ) {
      // A `2` is this URL's own: params resolve. The default prefetch of an App Shell route hangs them.
      const fallbackParams = !runtimePrefetchRequest(request) && routeRuntimePrefetch(route)
      // `3` is the runtime App Shell: only root params stay concrete.
      const appShell =
        request.headers.get(NEXT_ROUTER_PREFETCH_HEADER) === '3'
          ? rootParamNames(config, route)
          : undefined
      const instant = await renderInstantPrefetchShell({
        config,
        selection,
        pathname: matchPathname,
        url,
        request,
        fallbackParams,
        appShell,
        nav: prefetchNav,
      })
      if (instant) {
        // A `pprMetadata` route's <title> is dynamic while this shared body varies on nothing: outline
        // it so the client fetches `/_head` per URL, as the baked path below does.
        let instantHtml = instant.html
        let instantHeadOutlined = false
        if (route.pprMetadata === true) {
          const outlined = outlineDocumentTitle(instantHtml)
          if (outlined) {
            instantHtml = outlined
            instantHeadOutlined = true
          }
        }
        // This response owns its window: drop the request-level `use cache` aggregate so the header
        // finalizer does not overwrite it with the route's longer public-cache window.
        takeCacheLifeStash()
        const response = segmentBodyResponse({
          body: instantHtml,
          // Request-sampled: reuses for the SHORTEST window it sampled (private caches included).
          staleTime:
            instant.staleSeconds !== undefined
              ? Math.min(instant.staleSeconds, effectiveStaleTime(meta, true))
              : effectiveStaleTime(meta, true),
          postponed: true,
          prerendered: isStatic,
          deploymentId: deploymentId(),
          segment,
          vary: varyTrusted(
            instant.vary,
            selection,
            'body',
            fallbackParams,
            // A live render: an explicit `allow-runtime` route's empty set is the truth.
            appShell !== undefined || routeExplicitRuntimePrefetch(route),
          )
            ? segmentVaryInfo(instant.vary, 'body', selection)
            : undefined,
        })
        // Only a runtime-prefetch shell downgrades a full prefetch to shell semantics (ordinary PPR
        // full renders also carry the postponed flag while streaming complete content).
        response.headers.set('x-pnext-runtime-prefetch', '1')
        if (instantHeadOutlined) {
          response.headers.set('x-pnext-head-outlined', headFetchedFirst(selection) ? 'first' : '1')
        }
        // A COMPLETE runtime prefetch (never postponed) lets the navigation commit network-free; it
        // stays `postponed` on the wire so a request-sampled payload never becomes CDN-cacheable.
        // Next: the runtime shell of a page that prerendered whole is runtime-complete.
        if (!instant.postponed || (appShell && (route.builtStatic ?? route.pprHoles?.length === 0)))
          response.headers.set('x-pnext-runtime-complete', '1')
        if (runtimePrefetchRequest(request)) response.headers.set('cache-control', 'no-store')
        return withRewriteHeaders(response, rewriteHeaders)
      }
    }
    // A Partial Prefetching route always answers from its prerenders: its URL data rides the `2`.
    const baked =
      partialPrefetch &&
      (routeRuntimePrefetch(route) || meta?.postponed !== true || !runtimePrefetch)
        ? await bakedBody(config, selection, url, meta)
        : null
    // A default prefetch of a dynamic page with no baked segment must not live-render: Next answers
    // such prefetches from static data only, and a hanging dynamic render would pin the connection.
    // Exceptions that cannot hang: runtime-prefetch routes, pure params-derived routes, prerendered
    // param sets, static routes, and routes with a loading/Suspense boundary (truncated render).
    const paramsOnlyStatic =
      (route.hasStaticParams === true && route.usesRequest !== true) ||
      clientStaticPrefetchable(route)
    const hasLoadingShell = routeHasLoadingBoundary(route)
    const paramPrerendered = paramsPrerendered(route, selection.params)
    // Params not enumerated by generateStaticParams on a `loading` route: the page is dynamic for this
    // URL, so the default prefetch stops at the loading shell (and its vary set stays honest).
    const truncateAtLoading = routeHasLoadingFile(route) && !paramPrerendered
    const unbakedDynamic =
      partialPrefetch &&
      !runtimePrefetch &&
      baked === null &&
      !paramsOnlyStatic &&
      !paramPrerendered &&
      !isStatic
    if (unbakedDynamic && !hasLoadingShell) return miss()
    // Kept alive by an in-page <Suspense> boundary: Next answers the default prefetch with the
    // route's SHARED fallback shell (params hang, one entry for every param value).
    if (isBodySegment && unbakedDynamic && !routeHasLoadingFile(route)) {
      const shared = await serveSharedShell(true)
      if (shared) return shared
    }
    let body: string
    let postponed: boolean
    /** The vary set of the live render, or the baked artifact's recorded one; undefined keys on the URL. */
    let bodyVary: ResponseVaryParams | undefined
    let bakedVaryTrusted = false
    let truncatedShell = false
    let renderStaleSeconds: number | undefined
    if (baked === null) {
      // An implied runtime-prefetch route (it reads searchParams) still follows the default-prefetch
      // contract: truncated at its loading shell, never a full dynamic render.
      truncatedShell = partialPrefetch && !routeExplicitRuntimePrefetch(route) && truncateAtLoading
      const rendered = await renderRuntimeSegment({
        config,
        selection,
        pathname: matchPathname,
        url,
        request,
        keepPrefetchHeader:
          partialPrefetch &&
          !routeExplicitRuntimePrefetch(route) &&
          (!paramsOnlyStatic || truncateAtLoading),
        nav: prefetchNav,
      })
      if (!rendered) return miss()
      body = rendered.body
      bodyVary = rendered.vary
      renderStaleSeconds = rendered.staleSeconds
      // A truncated prefetch answered from a baked sub-shell tracked no param access even though the
      // bytes are a function of the sub-shell's params: publish those instead of "unknown".
      if (
        truncateAtLoading &&
        bodyVary.params.length === 0 &&
        !bodyVary.search &&
        Object.keys(selection.params).length > 0
      ) {
        bodyVary = subShellVary(route, selection.params) ?? bodyVary
      }
      postponed =
        rendered.postponed ||
        (partialPrefetch &&
          meta?.postponed === true &&
          route.segmentConfig?.ensureStatic !== 'navigation')
      // unstable_dynamicOnHover resume: the client holds the static shell, so send only the
      // streamed dynamic chunks.
      if (!partialPrefetch && request.headers.get('x-pnext-resume-shell') === '1') {
        const resume = resumeOnlyDocument(body)
        if (resume) {
          const response = segmentBodyResponse({
            body: resume,
            staleTime: effectiveStaleTime(meta, false),
            deploymentId: deploymentId(),
            segment,
            vary: varyTrusted(rendered.vary, selection, 'body')
              ? segmentVaryInfo(rendered.vary, 'body', selection)
              : undefined,
          })
          response.headers.set('x-pnext-resume-only', '1')
          return withRewriteHeaders(response, rewriteHeaders)
        }
      }
    } else {
      body = baked.html
      postponed = baked.postponed
      bodyVary = baked.vary
      // The build applied its own trust rule (did the render track? did its params hang?) before
      // persisting the set; presence IS the trust.
      bakedVaryTrusted = bodyVary !== undefined
    }
    // Dynamic metadata: outline the <title> so the client fetches it via `/_head` as a later response.
    // A params-hanging shell carries no <title> at all, but the head is dynamic all the same.
    // So is a head that reads params the shared body does not.
    let headOutlined = false
    if (
      route.pprMetadata === true ||
      bodyVary?.head.some(name => !bodyVary.params.includes(name))
    ) {
      const outlined = outlineDocumentTitle(body)
      if (outlined) {
        body = outlined
        headOutlined = true
      } else if (!/<title>/i.test(body)) {
        headOutlined = true
      }
    }
    const completePrerender = baked !== null && !postponed
    // A postponed (shell-only) response carries static data only, so it reuses for the STATIC window
    // whatever the route's mode; so does a default prefetch of a route that never reads request data.
    const routeStaleTime = completePrerender
      ? meta && meta.staleTime > 0
        ? meta.staleTime
        : staleTimeSecondsFor(true)
      : effectiveStaleTime(
          meta,
          postponed || isStatic || (partialPrefetch && (!route.usesRequest || paramsOnlyStatic)),
        )
    // A request-sampled downgrade goes stale with the shortest cache it resolved.
    const staleTime =
      partialPrefetchDowngrade && renderStaleSeconds !== undefined
        ? Math.min(renderStaleSeconds, routeStaleTime)
        : routeStaleTime
    const ensureStatic = route.segmentConfig?.ensureStatic
    const bodyResponse = segmentBodyResponse({
      body,
      staleTime,
      postponed,
      // A pure params-derived render (or its truncated loading shell) is a prerender: a function of
      // the URL alone, shareable across every URL its vary set covers.
      prerendered:
        baked !== null || isStatic || ((!postponed || truncatedShell) && paramsOnlyStatic),
      deploymentId: deploymentId(),
      segment,
      vary:
        bodyVary &&
        (bakedVaryTrusted ||
          varyTrusted(
            bodyVary,
            selection,
            'body',
            false,
            // `allow-runtime` only: an `unstable_eager` route RESOLVES its params, so its empty set
            // is the untracked artifact, not the truth.
            route.segmentConfig?.prefetch === 'allow-runtime',
          ))
          ? segmentVaryInfo(bodyVary, 'body', selection)
          : undefined,
      shell: baked?.shell,
      // An upgradeable ISR fallback: 1 lets the client replace it with a runtime prefetch, 2 (`ensureStatic`) does not.
      fallback:
        baked?.fallback && !paramPrerendered
          ? ensureStatic === 'prefetch' || ensureStatic === 'navigation'
            ? 2
            : 1
          : undefined,
      // The latest render's verdict on the tree's static hints, which may be stale after a revalidation.
      runtimeNeeded: baked && routeRuntimePrefetch(route) ? baked.runtimeNeeded : undefined,
    })
    if (headOutlined) {
      bodyResponse.headers.set('x-pnext-head-outlined', headFetchedFirst(selection) ? 'first' : '1')
    }
    // The artifact's holes wait on data (session, URL or hanging params) only a runtime request fills.
    if (
      baked?.runtime &&
      routeRuntimePrefetch(route) &&
      ensureStatic !== 'prefetch' &&
      ensureStatic !== 'navigation'
    ) {
      bodyResponse.headers.set('x-pnext-needs-runtime', '1')
    }
    // A FULL prefetch answered with a shell: the same marker the runtime-prefetch downgrade uses.
    if (partialPrefetchDowngrade) {
      bodyResponse.headers.set('x-pnext-runtime-prefetch', '1')
      if (!postponed) bodyResponse.headers.set('x-pnext-runtime-complete', '1')
    }
    return withRewriteHeaders(bodyResponse, rewriteHeaders)
  }

  // `/_tree`: the RootTreePrefetch. Non-page targets get an empty (dynamic) tree so the client
  // falls back to a full nav fetch; an unmatched (or closed-param rejected) URL is a routing 404.
  const routeId = selection?.route.id
  const bakedTree = routeId ? readSegmentTree(config.outPath, routeId) : undefined
  const meta =
    selection?.route.kind === 'page' && (isStatic || routeRuntimePrefetch(selection.route))
      ? readSegmentMeta(config.outPath, selection.route.id)
      : undefined
  const hints = partialPrefetchHints(selection, meta)
  const format = url.searchParams.has('_rsc') ? 'flight' : 'json'
  // The route tree's SHAPE is static in Next: a baked tree reuses for the static window even for a
  // dynamic route (markUrlStaticFresh only warms the elision map when x-nextjs-stale-time > 0).
  const payload =
    (routeId &&
      bakedTree &&
      restampTree(bakedTree, {
        staleTime: isStatic ? effectiveStaleTime(meta, true, false) : staleTimeSecondsFor(true),
        isStatic,
      })) ||
    buildRootTreePrefetch({
      pathname: matchPathname,
      isStatic,
      staleTimeSeconds: staleTimeSecondsFor(isStatic),
      routeId: selection?.route.id,
      runtimePrefetch:
        (selection?.route.segmentConfig as { prefetch?: unknown } | undefined)?.prefetch ===
        'allow-runtime',
      partialPrefetching: hints !== undefined,
      postponed: Boolean(selection?.route.pprHoles?.length),
      // Route identity + this URL's params so the client can key shared segment entries early.
      ...(selection?.route.kind === 'page'
        ? {
            routePattern: selection.route.route,
            catchAllOptional: selection.route.catchAllOptional,
            params: wireParams(selection.params),
          }
        : {}),
      ...(selection?.route.pprMetadata === true
        ? { headOutlined: true, ...(headFetchedFirst(selection) ? { headFirst: true } : {}) }
        : {}),
    })
  // The static-prefetch attempt is this URL's own verdict, never the route's OR-merged one.
  if (hints !== undefined)
    payload.tree.h = ((payload.tree.h ?? 0) & ~PrefetchHint.ShouldAttemptStaticPrefetch) | hints
  const headers = {
    // A Partial Prefetching route's identity and hints ride the HEADERS: the client picks its flow
    // before the body streams.
    ...(hints !== undefined
      ? {
          [SEGMENT_ROUTE_HEADER]: selection!.route.route,
          'x-pnext-prefetch-hints': String(payload.tree.h),
        }
      : {}),
    // Announced on the HEADERS too, so the client keeps head-before-body order without the tree body.
    ...(selection?.route.pprMetadata === true
      ? { 'x-pnext-head-outlined': headFetchedFirst(selection) ? 'first' : '1' }
      : {}),
    // The client warms these beside its body request, so the warm never trails the prefetch.
    ...(selection?.route.clientEntry
      ? { 'x-pnext-assets': routeModuleTags(config, selection.route) }
      : {}),
    'x-nextjs-deployment-id': deploymentId(),
  }
  return withRewriteHeaders(
    treePrefetchResponse(payload, { format, status: selection ? 200 : 404, headers }),
    rewriteHeaders,
  )
}

/**
 * A Partial Prefetching route's hints: ShouldAttemptStaticShell when the App Shell artifact serving
 * this URL waited on no session data (or `ensureStatic` forces it). Undefined for other routes.
 */
function partialPrefetchHints(
  selection: ReturnType<typeof selectRouteForRequest>,
  meta: SegmentMeta | undefined,
): number | undefined {
  if (selection?.route.kind !== 'page' || !routeRuntimePrefetch(selection.route)) return undefined
  const { route } = selection
  // No baked artifact to judge from: the route goes straight to its runtime requests, unless this
  // URL prerendered whole (it read no runtime data).
  const runtime =
    shellEntryFor(route, selection.params)?.shellRuntime ??
    (meta
      ? (meta.shellRuntime ?? meta.runtime ?? 0)
      : paramsPrerendered(route, selection.params)
        ? 0
        : undefined)
  const ensureStatic = route.segmentConfig?.ensureStatic
  const shellStatic =
    ensureStatic !== undefined || (runtime !== undefined && !(runtime & RUNTIME_SESSION))
  // The prefetch hint follows this URL's own prerender, like Next's per-prerender tree.
  const keys = routeParamKeys(route)
  const own = route.pprSubShells?.find(
    c =>
      Object.keys(c.concreteParams).length === keys.length &&
      paramSetMatches(c.concreteParams, selection.params, keys),
  )
  const prefetchRuntime = own ? (own.runtime ?? 0) : meta ? (meta.runtime ?? 0) : runtime
  const prefetchStatic =
    ensureStatic === 'prefetch' ||
    ensureStatic === 'navigation' ||
    (prefetchRuntime !== undefined && !(runtimeNeededBits(route, 0, prefetchRuntime) & 2))
  return (
    PrefetchHint.SubtreeHasPartialPrefetching |
    (shellStatic ? PrefetchHint.ShouldAttemptStaticShell : 0) |
    (prefetchStatic ? PrefetchHint.ShouldAttemptStaticPrefetch : 0)
  )
}

/**
 * The vary payload stamped onto a segment response - the segment's own vary names plus the route identity
 * and concrete params the client needs to build the shared cache key for OTHER URLs of the same route.
 */
function segmentVaryInfo(
  vary: ResponseVaryParams,
  kind: 'body' | 'head' | 'layout' | 'page',
  selection: NonNullable<ReturnType<typeof selectRouteForRequest>>,
): SegmentVaryInfo {
  return {
    vary: varyNamesFor(vary, kind),
    // w9-segment-split: a BODY response carries the layout chain and the page in
    // one document, so its own `vary` stays their union (it is only byte-correct
    // for a URL matching both). The split sets ride alongside it so the client
    // can file the two frames separately and re-fetch just the one that varied.
    // Only when the render actually TRACKED something: a document answered from
    // a prerender cache reads no params, and an empty set would file the page
    // frame as shareable across every param value (see varyTrusted).
    ...(kind === 'body' && (vary.params.length > 0 || vary.search)
      ? {
          layoutVary: varyNamesFor(vary, 'layout'),
          pageVary: varyNamesFor(vary, 'page'),
        }
      : {}),
    route: selection.route.route,
    params: wireParams(selection.params),
  }
}

/**
 * True when a segment's tracked vary set may be published as-is: the render recorded at least one
 * access, or the route has no params for it to record. An untrusted set is published as UNKNOWN,
 * which keys the entry on its exact URL instead of sharing it across param values.
 *
 * An EMPTY tracked set on a route that HAS params is only ever the truth for a `fallbackParams`
 * render, where the params genuinely hung. For a CONCRETE-param render the same empty set is more
 * often an artifact, and the failure modes are not symmetric: over-varying costs a cache hit,
 * under-varying serves one param's content for another.
 *
 * `runtimePrefetch` is the second escape hatch: an EXPLICIT `allow-runtime` render that happened
 * LIVE tracked its param access for real, so an empty set there means the params were never read
 * before the render postponed. Never pass it for a BAKED body, produced outside any tracking scope.
 */
function varyTrusted(
  vary: ResponseVaryParams,
  selection: NonNullable<ReturnType<typeof selectRouteForRequest>>,
  kind: 'body' | 'layout' | 'page',
  fallbackParams = false,
  runtimePrefetch = false,
): boolean {
  if (kind === 'layout') {
    if (vary.layout.length > 0 || vary.layoutSearch) return true
  } else if (kind === 'page') {
    // The mirror of the layout arm: a PAGE frame is trustworthy on its OWN tracked access. An empty page
    // set is common and honest - a page that reads no params while its layout reads them all - but on a
    // params-bearing route it is indistinguishable from an untracked render, so it falls through to the
    // same "route has no params" test the body arm ends on.
    if (vary.page.length > 0 || vary.pageSearch) return true
  } else {
    if (vary.params.length > 0 || vary.search) return true
    if (fallbackParams) return true
    if (runtimePrefetch) return true
  }
  return Object.keys(selection.params).length === 0
}

/** Route params in the JSON-safe shape the client's vary keying reads. */
function wireParams(params: Record<string, unknown>): Record<string, string | string[]> {
  const wire: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) wire[key] = (value as unknown[]).map(paramText)
    else if (value !== undefined && value !== null) wire[key] = paramText(value)
  }
  return wire
}

/** Route param values are strings (or string arrays); coerce defensively. */
function paramText(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
}

/**
 * True when the route's segment chain declares a `loading` convention (or its
 * page/layout source wraps content in <Suspense>). A default prefetch of such a
 * route renders its loading shell (truncated at the boundary) instead of a
 * hanging dynamic render, so the miss short-circuit must not fire for it.
 */
function routeHasLoadingBoundary(route: RouteManifestEntry): boolean {
  if (routeHasLoadingFile(route)) return true
  // No `loading` file, but the PAGE itself wraps its params-dependent subtree in <Suspense>. That boundary
  // truncates the prefetch render exactly like a loading convention does, so the route serves the shared
  // fallback shell instead of a segment miss. Page file only - a layout's <Suspense> says nothing about
  // where the page's own render stops.
  return pageHasInPageSuspense(route.file)
}

/**
 * A `loading` convention file in the route's OWN app segment chain marks a guaranteed truncation point -
 * the render stops at it, never hanging. (sourceFiles also lists framework modules; anchor on the app
 * directory.)
 */
function routeHasLoadingFile(route: RouteManifestEntry): boolean {
  const appMarker = route.file.lastIndexOf('/app/')
  const appDir = appMarker === -1 ? undefined : route.file.slice(0, appMarker + '/app/'.length)
  if (appDir === undefined) return false
  return (route.sourceFiles ?? [route.file]).some(
    file => file.startsWith(appDir) && /[\\/]loading\.[jt]sx?$/.test(file),
  )
}

/** The vary set of a prefetch answered from a PPR SUB-SHELL: the concrete params it was baked for. */
function subShellVary(
  route: RouteManifestEntry,
  params: Record<string, unknown>,
): ResponseVaryParams | undefined {
  const names = Object.keys(subShellFor(route, params)?.concreteParams ?? {}).sort()
  if (!names.length) return undefined
  return responseVaryParamsFromWire({ vary: names, layoutVary: names, pageVary: [] })
}

function subShellFor(route: RouteManifestEntry, params: Record<string, unknown>) {
  return route.pprSubShells?.find(candidate =>
    paramSetMatches(
      candidate.concreteParams,
      params as Record<string, RouteParamValue>,
      Object.keys(candidate.concreteParams),
    ),
  )
}

/** The root-param prefix sub-shell whose prefetch shell serves `params`, when the build baked one. */
function shellEntryFor(route: RouteManifestEntry, params: Record<string, unknown>) {
  const shells = route.pprSubShells?.filter(candidate => candidate.shellRuntime !== undefined)
  const exact = shells?.find(candidate =>
    paramSetMatches(
      candidate.concreteParams,
      params as Record<string, RouteParamValue>,
      Object.keys(candidate.concreteParams),
    ),
  )
  if (exact || !shells?.length) return exact
  // Another root-param value runs the same App Shell code: its own shell renders on demand.
  const keys = Object.keys(shells[0]!.concreteParams)
  if (keys.some(key => params[key] === undefined)) return undefined
  const concreteParams = Object.fromEntries(keys.map(key => [key, params[key] as RouteParamValue]))
  return { ...shells[0]!, key: subShellKey(concreteParams), concreteParams }
}

/**
 * The static body of a prefetch: the URL's most specific baked prerender (`servedPprShell` picks the
 * full-param sub-shell, else the root-prefix one, else the base shell; a stale base shell regenerates
 * single-flight). On a Partial Prefetching route a non-prerendered URL is answered with the prefetch
 * shell baked for its root-param prefix, and a per-URL prerender whose vary names a non-root param
 * carries that shell alongside so sibling params paint it instantly.
 */
async function bakedBody(
  config: ResolvedConfig,
  selection: NonNullable<ReturnType<typeof selectRouteForRequest>>,
  url: URL,
  meta: SegmentMeta | undefined,
): Promise<{
  html: string
  postponed: boolean
  vary: ResponseVaryParams | undefined
  runtime: number
  /** The served shell is still an upgradeable fallback for this URL. */
  fallback: boolean
  runtimeNeeded?: number
  shell?: SegmentAppShell
} | null> {
  const { route, params } = selection
  const regen = {
    config,
    route,
    params,
    url: new URL(`http://pnext.local${url.pathname}`),
    boundedRegen: true,
  }
  // The body prefetch arrived: its own fallback scheduling supersedes the tree's warm.
  clearTimeout(pendingTreeWarms.get(url.pathname))
  pendingTreeWarms.delete(url.pathname)
  const pprShells = await pprShell()
  const served = await pprShells.servedPprShell(regen)
  const rootEntry = shellEntryFor(route, params)
  const paramKeys = routeParamKeys(route)
  const shellRender = { ...regen, prefetchShell: true, runtimeRegen: true }
  // The App Shell serving this URL: the root-prefix prefetch shell when baked, else the route's.
  const appShell = (root = rootEntry) =>
    root
      ? freshPrefetchShell(
          shellSegmentFile(config.outPath, route.id, root.key),
          pprSubShellPath(config.outPath, route.id, root.key),
          () =>
            pprShells.renderSubShell({
              ...shellRender,
              concreteParams: root.concreteParams,
              paramKeys,
            }),
        )
      : freshPrefetchShell(
          bodySegmentFile(config.outPath, route.id),
          pprShellPath(config.outPath, route.id),
          () =>
            paramKeys.length
              ? pprShells.renderFallbackShell(shellRender)
              : pprShells.renderPartialShell(shellRender),
        )
  const stamp = (html: string) => pprShells.withRequestRouteParams(html, params)
  const partial = routeRuntimePrefetch(route)
  if (!served) {
    // An ungenerated root-param value: its App Shell renders blocking, like Next's on-demand shell.
    const html = partial && rootEntry ? await appShell(rootEntry) : undefined
    return html === undefined
      ? null
      : {
          html: stamp(html),
          postponed: true,
          vary: responseVaryParamsFromWire(rootEntry!.shellVary ?? { vary: [] }),
          runtime: rootEntry!.shellRuntime ?? 0,
          fallback: false,
          runtimeNeeded: meta?.runtimeNeeded,
        }
  }
  const { shell: picked, fallback } = served
  if (picked.softStale) void pprShells.regenerateStalePprShell(regen)
  const concrete = Object.keys(picked.concreteParams ?? {})
  // Only a regeneration or promotion reports runtime data: its verdicts outrank the build's, and a
  // regenerated base shell's become the route's.
  let runtimeNeeded = meta?.runtimeNeeded
  if (picked.runtimeData !== undefined) {
    const shellRuntime =
      rootEntry?.shellRuntime ?? (picked.runtimeData & RUNTIME_SHELL ? RUNTIME_SESSION : 0)
    runtimeNeeded = runtimeNeededBits(route, shellRuntime, picked.runtimeData)
    if (meta && concrete.length === 0 && picked.runtimeData !== meta.runtime) {
      meta = {
        ...meta,
        postponed: picked.holes.length > 0,
        runtime: picked.runtimeData,
        shellRuntime,
        runtimeNeeded,
      }
      void writeSegmentMeta(config.outPath, route.id, meta).catch(() => undefined)
    }
  }
  // By value: a promoted (in-memory) shell carries its own params object for the same prefix.
  const entry = route.pprSubShells?.find(
    c =>
      Object.keys(c.concreteParams).length === concrete.length &&
      paramSetMatches(c.concreteParams, picked.concreteParams!, concrete),
  )
  // The base prerender is every such URL's static prefetch; the App Shell is a prefix of it.
  if (concrete.length === 0) {
    return {
      html: stamp(picked.shell),
      postponed: picked.holes.length > 0 || picked.metadataDynamic,
      vary: meta?.vary ? responseVaryParamsFromWire(meta) : undefined,
      runtime: meta?.runtime ?? 0,
      fallback,
      runtimeNeeded,
    }
  }
  if (partial && entry?.shellVary && concrete.length < paramKeys.length) {
    const html = await appShell(entry)
    if (html === undefined) return null
    return {
      html: stamp(html),
      postponed: true,
      vary: responseVaryParamsFromWire(entry.shellVary),
      runtime: entry.shellRuntime ?? 0,
      fallback,
      runtimeNeeded,
    }
  }
  // Untracked: every frame is a function of the params the artifact was baked for.
  const vary = responseVaryParamsFromWire(
    entry?.vary ?? { vary: concrete.sort(), layoutVary: concrete, pageVary: concrete },
  )
  const rootNames = rootParamNames(config, route)
  const shell =
    partial &&
    concrete.length === paramKeys.length &&
    vary.params.some(name => !rootNames.includes(name))
      ? await appShell()
      : undefined
  return {
    html: stamp(picked.shell),
    postponed: picked.holes.length > 0 || route.pprMetadata === true,
    vary,
    runtime: entry?.runtime ?? picked.runtimeData ?? 0,
    fallback,
    runtimeNeeded,
    ...(shell !== undefined
      ? {
          shell: {
            html: shell,
            route: route.route,
            vary: rootEntry?.shellVary?.vary ?? [],
          },
        }
      : {}),
  }
}

const pendingPrefetchShells = new Map<string, Promise<string | undefined>>()

/**
 * The baked prefetch shell at `file`, re-rendered (single-flight) when the shell it was cut from
 * (`source`, already validated fresh by loadPprShell) was regenerated after it.
 */
async function freshPrefetchShell(
  file: string,
  source: string,
  render: () => Promise<{ shell: string } | null>,
): Promise<string | undefined> {
  const mtime = (path: string) =>
    stat(path).then(
      stats => stats.mtimeMs,
      () => undefined,
    )
  const [baked, sourceMtime] = await Promise.all([mtime(file), mtime(source)])
  if (baked !== undefined && (sourceMtime === undefined || sourceMtime <= baked)) {
    return readFile(file, 'utf8')
  }
  let pending = pendingPrefetchShells.get(file)
  if (!pending) {
    pending = getRenderExtensions()
      .collectRenderMeta(render, {
        refreshFetches: true,
        blockingStaleFetches: true,
        prerender: true,
      })
      .then(async ({ value }) => {
        if (!value) return undefined
        await writeFileAtomic(file, value.shell).catch(() => undefined)
        return value.shell
      })
      .finally(() => pendingPrefetchShells.delete(file))
    pendingPrefetchShells.set(file, pending)
  }
  return pending
}

/** True when the route EXPLICITLY opts into runtime prefetching via segment config. */
function routeExplicitRuntimePrefetch(route: RouteManifestEntry): boolean {
  const prefetch = (route.segmentConfig as { prefetch?: unknown } | undefined)?.prefetch
  return prefetch === 'allow-runtime' || prefetch === 'unstable_eager'
}

/**
 * True when the route opts into rendering its body prefetch as a runtime-
 * prefetch prerender: `unstable_instant = true` (page or layout chain) or
 * `export const prefetch = 'allow-runtime'`. A leaf-most `unstable_instant =
 * false` opts back out even when a layout (or `allow-runtime`) opts in.
 */
function routeRuntimePrefetchRender(route: RouteManifestEntry): boolean {
  const config = route.segmentConfig
  if (config?.unstableInstant === false) return false
  // Stable `instant` alone keeps a full prefetch full (Next 16.4); `unstable_instant` or a prefetch export opts in.
  if (config?.unstableInstant === true && !config.stableInstant) return true
  return config?.prefetch === 'allow-runtime'
}

const runtimePrefetchByRoute = new WeakMap<RouteManifestEntry, boolean>()
const clientStaticByRoute = new WeakMap<RouteManifestEntry, boolean>()

function routeUsesRuntimePrefetch(route: RouteManifestEntry): boolean {
  let uses = runtimePrefetchByRoute.get(route)
  if (uses === undefined) {
    uses =
      routeExplicitRuntimePrefetch(route) ||
      (!clientStaticPrefetchable(route) &&
        /\b(?:searchParams|useSearchParams)\b/.test(readTextOrEmpty(route.file)))
    runtimePrefetchByRoute.set(route, uses)
  }
  return uses
}

function readTextOrEmpty(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * A CLIENT page's params/searchParams access resolves client-side from the live URL, so its server
 * render is a pure function of the exact URL and is servable complete on a default prefetch. Only
 * true when no server segment in the chain reads real request data.
 */
function clientStaticPrefetchable(route: RouteManifestEntry): boolean {
  let result = clientStaticByRoute.get(route)
  if (result === undefined) {
    // Only the route's own app segments matter (sourceFiles also lists framework modules).
    const appDir = route.file.slice(0, route.file.lastIndexOf('/app/') + '/app/'.length)
    result =
      route.client === true &&
      (route.sourceFiles ?? []).every(
        file =>
          file === route.file ||
          !appDir ||
          !file.startsWith(appDir) ||
          !/\b(?:cookies|headers|connection|draftMode)\s*\(/.test(readTextOrEmpty(file)),
      )
    clientStaticByRoute.set(route, result)
  }
  return result
}

/**
 * Render the runtime-prefetch (unstable_instant) shell for a full segment prefetch: request data sampled,
 * connection() content omitted. Best-effort - null falls back to the ordinary full render.
 */
async function renderInstantPrefetchShell({
  config,
  selection,
  pathname,
  url,
  request,
  fallbackParams = false,
  appShell,
  nav,
}: {
  config: ResolvedConfig
  selection: NonNullable<ReturnType<typeof selectRouteForRequest>>
  pathname: string
  url: URL
  request: Request
  /** App Shells: render the SHARED shell (params hang, request data resolves). */
  fallbackParams?: boolean
  /** Runtime App Shell (`3`): these root params stay concrete, every other param and prefetch() hang. */
  appShell?: string[]
  /** The client's nav state: a runtime request renders the delta below the layouts it already has. */
  nav?: ReturnType<typeof parseNavState>
}): Promise<{
  html: string
  postponed: boolean
  vary: ResponseVaryParams
  /** Shortest `use cache` stale window this render actually sampled. */
  staleSeconds?: number
} | null> {
  if (selection.route.kind !== 'page') return null
  const renderUrl = new URL(url)
  renderUrl.pathname = pathname
  renderUrl.searchParams.delete('_rsc')
  const headers = new Headers(request.headers)
  headers.delete(NEXT_ROUTER_PREFETCH_HEADER)
  headers.delete(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER)
  headers.set(SEGMENT_RENDER_HEADER, '1')
  // Tracked so the response can publish which params it actually read.
  let staleSeconds: number | undefined
  const { renderRuntimePrefetchDocument } = await pprShell()
  const tracked = await withVaryParamsTracking(() =>
    getRenderExtensions().collectRenderMeta(
      async () => {
        const value = await withRouteRuntime(selection.route.segmentConfig?.runtime, () =>
          renderRuntimePrefetchDocument({
            config,
            route: selection.route,
            params: selection.params,
            url: renderUrl,
            request: new Request(renderUrl, { headers }),
            ...(nav ? { nav: { soft: true, state: nav, childrenPath: pathname } } : {}),
            ...(fallbackParams ? { fallbackParams: true } : {}),
            ...(appShell
              ? {
                  prefetchShell: true,
                  fallbackConcreteParams: Object.fromEntries(
                    appShell.map(name => [name, selection.params[name]!]),
                  ),
                  fallbackParamKeys: routeParamKeys(selection.route),
                }
              : {}),
          }),
        )
        // Read inside the collection scope: the shortest window any cache this
        // render SAMPLED reported (a `use cache: private` one included), which
        // is how long the request-sampled payload may be reused.
        staleSeconds = getRenderExtensions().currentCacheStaleSeconds()
        return value
      },
      {
        fetchCache: selection.route.segmentConfig?.fetchCache,
        route: pathname,
      },
    ),
  )
  const rendered = tracked.value.value
  return rendered
    ? {
        ...rendered,
        // An App Shell is keyed on the root params it read: everything else hung.
        vary: appShell ? restrictVary(tracked.vary, appShell) : tracked.vary,
        ...(staleSeconds !== undefined ? { staleSeconds } : {}),
      }
    : null
}

async function renderRuntimeSegment({
  config,
  selection,
  pathname,
  url,
  request,
  keepPrefetchHeader = false,
  nav,
}: {
  config: ResolvedConfig
  selection: NonNullable<ReturnType<typeof selectRouteForRequest>>
  pathname: string
  url: URL
  request: Request
  /** Keep next-router-prefetch so the render truncates at its static shell. */
  keepPrefetchHeader?: boolean
  /**
   * The client's echoed nav state. Threading it makes the render apply the
   * same shared-layout skip as a navigation render (Next dedupes shared
   * layouts on prefetches via next-url too), so a prefetch never re-executes
   * a layout the origin page already renders.
   */
  nav?: ReturnType<typeof parseNavState>
}): Promise<
  | {
      body: string
      postponed: boolean
      vary: ResponseVaryParams
      /** Shortest `use cache` stale window this render actually resolved. */
      staleSeconds?: number
    }
  | undefined
> {
  if (selection.route.kind !== 'page') return undefined
  const renderUrl = new URL(url)
  renderUrl.pathname = pathname
  renderUrl.searchParams.delete('_rsc')
  const headers = new Headers(request.headers)
  if (!keepPrefetchHeader) headers.delete(NEXT_ROUTER_PREFETCH_HEADER)
  headers.delete(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER)
  // The segment header is stripped so the render takes the ordinary document
  // path, but the renderer still has to know this body is a PREFETCH payload
  // and not a navigation: a prefetch that retains a shared layout must render
  // the delta (skip marker) rather than resume the prebuilt shell, which
  // carries the origin page's layout markup back to a client that has it.
  headers.set(SEGMENT_RENDER_HEADER, '1')
  const renderRequest = new Request(renderUrl, { headers })
  // Segment-M2 deliverable 1: track param access for the whole render, INCLUDING
  // the body stream — the tracking scope closes only once the body is read.
  const tracked = await withVaryParamsTracking(async () => {
    const rendered = await getRenderExtensions().collectRenderMeta(
      () =>
        withRouteRuntime(selection.route.segmentConfig?.runtime, () =>
          renderPageResponse({
            config,
            route: selection.route,
            params: selection.params,
            url: renderUrl,
            request: renderRequest,
            ...(nav ? { nav: { soft: true, state: nav, childrenPath: pathname } } : {}),
          }),
        ),
      {
        fetchCache: selection.route.segmentConfig?.fetchCache,
        route: pathname,
      },
    )
    if (!rendered.value.ok) return undefined
    // The render's OWN window (the `use cache` finalizer stamped the shortest
    // life it actually resolved, private caches included) — authoritative for a
    // request-sampled payload, whose baked route meta only knows the public
    // caches' longer window.
    const header = Number(rendered.value.headers.get('x-nextjs-stale-time'))
    return {
      body: await rendered.value.text(),
      postponed: rendered.value.headers.get('x-nextjs-postponed') === '1',
      ...(Number.isFinite(header) && header > 0 ? { staleSeconds: header } : {}),
    }
  })
  return tracked.value ? { ...tracked.value, vary: tracked.vary } : undefined
}

/** Segment request key for the outlined dynamic head (metadata) of a route. */
const HEAD_SEGMENT_PATH = '/_head'

/**
 * The segment request key for a route's LAYOUT frame - the document with the page's markup cut out.
 * Requested when the client's page frame for a URL is a hit but its layout frame is not.
 */
const LAYOUT_SEGMENT_PATH = '/_layout'

/**
 * The segment request key for a route's PAGE frame - the page slot alone, with the layout chain cut away.
 * The inverse of `/_layout`, requested by a navigation that already owns the destination's layout, or
 * holds a valid cached layout frame for it.
 */
const PAGE_SEGMENT_PATH = '/_page'

/**
 * Marks the render behind a segment-prefetch response, after the segment header
 * itself has been stripped. The renderer keys its shared-layout delta on this
 * (see fullSegmentPrefetchSkipsSharedLayout).
 */
const SEGMENT_RENDER_HEADER = 'x-pnext-segment-render'

const DOCUMENT_TITLE_PATTERN = /<title(?:\s[^>]*)?>[\s\S]*?<\/title>/

/** The document's `<title>…</title>` markup, or null when it has none. */
function extractDocumentTitle(html: string): string | null {
  return DOCUMENT_TITLE_PATTERN.exec(html)?.[0] ?? null
}

/**
 * True when this route's outlined head must be fetched BEFORE its body. A route with DYNAMIC PARAMS
 * shares one body across every param value while its metadata varies per URL, so the head is its own
 * leading segment and is answered first. A PARAMLESS route has nothing to share - its head is
 * outlined out of the one body response and arrives after it.
 */
function headFetchedFirst(selection: { route: RouteManifestEntry }): boolean {
  return selection.route.pprMetadata === true && /[:*]/.test(selection.route.route)
}

/** The document with its `<title>` removed, or null when it has none. */
function outlineDocumentTitle(html: string): string | null {
  const match = DOCUMENT_TITLE_PATTERN.exec(html)
  if (!match) return null
  return html.slice(0, match.index) + html.slice(match.index + match[0].length)
}

/**
 * Cut a streamed document down to its dynamic continuation (the hidden stream chunk divs plus everything
 * after them), wrapped as a minimal parseable document. Null when the document has no streamed chunks -
 * nothing dynamic to resume, so the caller serves the full document.
 */
function resumeOnlyDocument(html: string): string | null {
  const cut = html.indexOf('<div hidden data-pnext-stream')
  if (cut === -1) return null
  const end = html.lastIndexOf('</body>')
  const chunks = end > cut ? html.slice(cut, end) : html.slice(cut)
  return `<!DOCTYPE html><html><body>${chunks}</body></html>`
}

function segmentMissResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'content-type': RSC_CONTENT_TYPE_HEADER,
      'x-nextjs-postponed': '2',
      'cache-control': 'private, no-store',
    },
  })
}

/** x-nextjs-rewritten-path/query values for a matched config rewrite. */
interface RewriteHeaderInfo {
  path?: string
  query?: string
}

const segmentRewriteCache = new Map<string, Promise<CompatRewrite[]>>()

function loadSegmentRewrites(config: ResolvedConfig): Promise<CompatRewrite[]> {
  let cached = segmentRewriteCache.get(config.root)
  if (!cached) {
    cached = loadCompatRewrites(config.root)
    segmentRewriteCache.set(config.root, cached)
  }
  return cached
}

/**
 * Resolve next.config `rewrites` for an RSC/segment request. Returns the
 * destination pathname (used for route matching) plus the rewritten-path/query
 * header values Next emits on RSC responses. The `_rsc` cache-buster is a CDN
 * key, not an app param, so it is excluded from the query matched/appended by
 * the rewrite (otherwise it would leak into x-nextjs-rewritten-query).
 */
async function resolveSegmentRewrite(
  config: ResolvedConfig,
  request: Request,
  url: URL,
): Promise<{ pathname: string; headers: RewriteHeaderInfo } | undefined> {
  const rewrites = await loadSegmentRewrites(config)
  if (rewrites.length === 0) return undefined
  const query = new URLSearchParams(url.searchParams)
  query.delete('_rsc')
  const result = resolveCompatRewrite(rewrites, url.pathname, {
    host: request.headers.get('host') ?? '',
    headers: request.headers,
    cookies: parseCookieHeader(request.headers.get('cookie')),
    query,
  })
  if (!result) return undefined
  const resolvedQuery = result.search.toString()
  return {
    pathname: result.pathname,
    headers: {
      // Path header only when the pathname actually changed; query header only
      // when the destination carries a query (mirrors recordRewrite in the
      // full-render path).
      ...(result.pathname !== url.pathname ? { path: result.pathname } : {}),
      ...(resolvedQuery ? { query: resolvedQuery } : {}),
    },
  }
}

/**
 * Stamp x-nextjs-rewritten-path/query on a segment/RSC response. Interceptor
 * responses short-circuit before the protocol finalizer runs, so the compat
 * rewrite headers must be set here directly. No-op when no rewrite matched.
 */
function withRewriteHeaders(response: Response, info: RewriteHeaderInfo | undefined): Response {
  // Interceptor responses bypass the normal response-finalizer pipeline, so
  // they must merge the router's CDN vary contract themselves.
  mergeRouterVary(response.headers)
  if (info?.path !== undefined) response.headers.set('x-nextjs-rewritten-path', info.path)
  if (info?.query !== undefined) response.headers.set('x-nextjs-rewritten-query', info.query)
  return response
}

// Stamp x-nextjs-stale-time on router responses that a `use cache` route did
// not already stamp, so both prefetches and navigation-seeded entries learn
// their reuse window from the route mode.
const APP_ROUTE_KINDS = new Set<ResponseFinalizerContext['routeKind']>([
  'html',
  'data',
  'route-handler',
])

export const prefetchStaleTimeFinalizer: ResponseFinalizer = ctx => {
  if (!APP_ROUTE_KINDS.has(ctx.routeKind)) return
  if (ctx.request.headers.get(RSC_HEADER) !== '1') return
  if (!ctx.request.headers.has('x-pnext-soft-nav')) return
  if (ctx.headers.has('x-nextjs-stale-time')) return
  const prefetchRequest = ctx.request.headers.get(NEXT_ROUTER_PREFETCH_HEADER) === '1'
  const postponedResponse = ctx.headers.get('x-nextjs-postponed') === '1'
  // routeMode: a static/isr prerender reuses for the static window, a dynamic render for the dynamic
  // window, an unknown mode conservatively for the dynamic one. A shell-only (postponed) PREFETCH
  // response carries only static data, so its shell reuses for the static window regardless.
  //
  // A URL whose params the BUILD PRERENDERED is static even though `routeModeOf`
  // reports the route `dynamic` (it ignores `prerenderedParams`, and an
  // interception/parallel-slot render is request-time by nature). Corrected here
  // rather than in `routeModeOf`: routeMode also drives cache-control and the
  // ISR promotion, which must keep seeing the route-level mode.
  const runtime = getRequestRuntime()
  const selection = runtime
    ? selectRouteForRequest(runtime.routes, ctx.request.url.pathname, undefined)
    : null
  const isStatic =
    ctx.routeMode === 'static' ||
    ctx.routeMode === 'isr' ||
    (prefetchRequest && postponedResponse) ||
    (selection !== null && paramsPrerendered(selection.route, selection.params ?? {}))
  // A statically-served prerender never re-runs its `use cache` scopes, so the
  // use-cache finalizer can't stamp the route's own cacheLife window here. The
  // build persisted it into the route's segment meta — prefer that over the
  // mode default so a page's cacheLife({stale}) drives client expiry.
  if (runtime && selection?.route.kind === 'page') {
    const meta = readSegmentMeta(runtime.config.outPath, selection.route.id)
    ctx.headers.set('x-nextjs-stale-time', String(effectiveStaleTime(meta, isStatic)))
    return
  }
  ctx.headers.set('x-nextjs-stale-time', String(staleTimeSecondsFor(isStatic)))
}

// Wire-compat content type: Next answers router fetches (rsc: 1) with
// `text/x-component`, and suites assert exactly that on soft-nav responses.
// Only the pnext HTML-swap router's own fetches are flipped (x-pnext-soft-nav
// marks them); plain document loads keep text/html.
export const rscContentTypeFinalizer: ResponseFinalizer = ctx => {
  if (ctx.routeKind !== 'html') return
  if (ctx.request.headers.get(RSC_HEADER) !== '1') return
  if (!ctx.request.headers.has('x-pnext-soft-nav')) return
  ctx.headers.set('content-type', RSC_CONTENT_TYPE_HEADER)
}

export const rscDeploymentFinalizer: ResponseFinalizer = ctx => {
  if (!APP_ROUTE_KINDS.has(ctx.routeKind)) return
  if (ctx.request.headers.get(RSC_HEADER) !== '1') return
  if (!ctx.headers.has('x-nextjs-deployment-id')) {
    ctx.headers.set('x-nextjs-deployment-id', deploymentId())
  }
}

function readSegmentMeta(outPath: string, routeId: string): SegmentMeta | undefined {
  const file = segmentMetaFile(outPath, routeId)
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as SegmentMeta
  } catch {
    return undefined
  }
}

async function writeSegmentMeta(
  outPath: string,
  routeId: string,
  meta: SegmentMeta,
): Promise<void> {
  const file = segmentMetaFile(outPath, routeId)
  await writeFile(`${file}.tmp`, JSON.stringify(meta))
  await rename(`${file}.tmp`, file)
}

function effectiveStaleTime(
  meta: SegmentMeta | undefined,
  isStatic: boolean,
  declared = true,
): number {
  const configured = staleTimeSecondsFor(isStatic)
  if (!meta) return configured
  // The route's own cacheLife() window - a declared 0 is "re-fetch on every reveal", not a default.
  if (declared && meta.staleTimeDeclared) return meta.staleTime
  const builtDefault = isStatic
    ? DEFAULT_STATIC_STALE_TIME_SECONDS
    : DEFAULT_DYNAMIC_STALE_TIME_SECONDS
  if (meta.staleTime === builtDefault) return configured
  // A STATIC-data response (a postponed/truncated shell) of a route whose meta was built with the DYNAMIC
  // default must reuse for the static window - the meta's 0 describes the route's dynamic resume, not its
  // static shell. Pinning the shell always-stale made every re-revealed link refetch the route tree.
  if (isStatic && meta.staleTime === DEFAULT_DYNAMIC_STALE_TIME_SECONDS) return configured
  return meta.staleTime
}

function readSegmentTree(outPath: string, routeId: string): string | undefined {
  const file = treeSegmentFile(outPath, routeId)
  if (!existsSync(file)) return undefined
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/** The baked tree restamped with this request's staleTime and staticness; null when unreadable. */
function restampTree(
  tree: string,
  stamp: { staleTime: number; isStatic: boolean },
): RootTreePrefetch | null {
  try {
    const payload = JSON.parse(tree.startsWith('0:') ? tree.slice(2) : tree) as RootTreePrefetch
    payload.staleTime = stamp.staleTime
    payload.isStatic = stamp.isStatic
    return payload
  } catch {
    return null
  }
}

function cacheBustingToken(url: URL, headers?: Headers): string {
  let hash = 5381
  // Like Next's setCacheBustingSearchParam, the token derives from the router
  // negotiation HEADERS too: the `/_tree` and `/_index` variants of one URL
  // must never share a token, or a Vary-ignoring CDN would replay one for the
  // other after a redirect strips the client's own cache-buster.
  const variant = headers
    ? `|${headers.get(NEXT_ROUTER_PREFETCH_HEADER) ?? ''}|${headers.get(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER) ?? ''}|${headers.get('next-url') ?? ''}`
    : ''
  const input = `${url.pathname}?${url.searchParams.toString()}${variant}`
  for (let index = 0; index < input.length; index++) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(index)
  }
  return (hash >>> 0).toString(36)
}

function withRscQuery(url: URL, headers?: Headers): string {
  const next = new URL(url)
  next.searchParams.delete('_rsc')
  next.searchParams.set('_rsc', cacheBustingToken(next, headers))
  return next.href
}

/**
 * Static siblings of the route's deepest dynamic segment, for the RSC payload.
 * Next's flight data carries the sibling names of a dynamic trie level so the
 * client never predicts over a static route; the static-siblings suite asserts
 * the names appear in the server response.
 */
function routeStaticChildren(
  routes: readonly RouteManifestEntry[],
  route: RouteManifestEntry,
): string[] {
  return staticSiblingNames(routes, nextRoutePattern(route.route).split('/').filter(Boolean))
}

/**
 * The trailing flight marker appended to a full-route RSC body: the leaf
 * segment name Next's flight payload carries (`__PAGE__`) plus the route
 * identity, in the same shape `fullRouteRscResponse` sends for a prefetch. An
 * HTML comment so it stays inert for anything that parses the body as markup.
 */
function flightSegmentMarker(routeId: string, isStatic: boolean): string {
  return `\n<!--pnext-flight:${JSON.stringify({ route: routeId, isStatic, segment: '__PAGE__' })}-->`
}

/**
 * Remove a leading `<!DOCTYPE html>` from a streamed document body (first
 * chunk(s) only; the rest of the stream passes through untouched) and append
 * `tail` once the stream ends. Used on the full-route RSC path so an `RSC: 1`
 * response is never mistakable for a document while keeping the rendered
 * content byte-identical otherwise.
 */
function stripDocumentDoctype(response: Response, tail = ''): Response {
  if (!response.body) return response
  const prefix = '<!DOCTYPE html>'
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffered = ''
  let resolved = false
  let tailEmitted = false
  const emit = (controller: TransformStreamDefaultController<Uint8Array>, text: string) => {
    if (text) controller.enqueue(encoder.encode(text))
  }
  const transformed = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (resolved) {
          // The late-metadata section is not document bytes: the tail belongs
          // to the DOCUMENT, so it goes out ahead of the marker.
          const text = decoder.decode(chunk, { stream: true })
          const late = text.indexOf(LATE_METADATA_MARKER)
          if (late !== -1 && !tailEmitted) {
            tailEmitted = true
            emit(controller, text.slice(0, late))
            emit(controller, tail)
            emit(controller, text.slice(late))
            return
          }
          emit(controller, text)
          return
        }
        buffered += decoder.decode(chunk, { stream: true })
        if (buffered.length < prefix.length && prefix.startsWith(buffered)) return
        resolved = true
        emit(controller, buffered.startsWith(prefix) ? buffered.slice(prefix.length) : buffered)
      },
      flush(controller) {
        if (!resolved) emit(controller, buffered)
        if (!tailEmitted) emit(controller, tail)
      },
    }),
  )
  return new Response(transformed, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

function fullRouteRscResponse(
  routeId: string,
  isStatic: boolean,
  staleTime: number,
  staticChildren: string[] = [],
): Response {
  const payload = {
    route: routeId,
    isStatic,
    segment: '__PAGE__',
    ...(staticChildren.length > 0 ? { staticChildren } : {}),
  }
  return new Response(`0:${JSON.stringify(payload)}`, {
    status: 200,
    headers: {
      'content-type': RSC_CONTENT_TYPE_HEADER,
      'x-nextjs-stale-time': String(staleTime),
      'x-nextjs-deployment-id': deploymentId(),
      'cache-control': 'private, no-store',
    },
  })
}
