// Segment-prefetch responder implementation (COMPAT - may import core freely). Provides:
//   - a request interceptor that answers `/_tree` segment-prefetch requests with the minimal
//     RootTreePrefetch payload, Content-Type text/x-component, x-nextjs-stale-time and
//     cache-control private,no-store; the router Vary is merged by the protocol finalizer.
//   - a response finalizer that stamps x-nextjs-stale-time on ordinary prefetch responses that did
//     not already carry one from `use cache`, so the client segment cache learns the reuse window.
//
// The interceptor short-circuits BEFORE route matching / static lookup: a segment prefetch never
// renders a page, it only announces the route tree + staleness. It runs first among compat
// interceptors so an action POST never mistakes a `/_tree` GET.
//
// `_rsc` cache-buster handling: an RSC/prefetch request carries a `?_rsc=<hash>` param the CDN keys
// on. The interceptor accepts any value and never treats it as an app search param.
//
// No-op when compat is off. The `/_tree` sentinel only fires when the client segment-cache runtime
// sends it; the HTML-swap navigation path is untouched.
//
// Registered by ../register/segment.ts, which wires the exports below into the extension registries.

import type { ResolvedConfig } from '../../config'
import type { RouteManifestEntry } from '../../types'
import { nextCompatEnabled } from '../../compat/aliases'
import {
  getRenderExtensions,
  getRequestExtensions,
  type RequestInterceptor,
  type ResponseFinalizer,
  type ResponseFinalizerContext,
  withRouteRuntime,
} from '../../extensions'
import { getRequestRuntime } from '../../routing/request-environment'
import { takeCacheLifeStash } from '../cache/use-cache'
import { matchInterception, parseNavState, selectRouteForRequest } from '../../routing/routes'
import {
  currentPprShellHtml,
  pprShellPath,
  renderPageResponse,
  renderPartialShell,
  renderRuntimePrefetchDocument,
  schedulePprShellUpgrade,
  withRequestRouteParams,
  LATE_METADATA_MARKER,
} from '../../render/renderer'
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
  ROUTE_SEGMENT_PATH,
  TREE_SEGMENT_PATH,
  treeSegmentFile,
  treePrefetchResponse,
  type SegmentAppShell,
  type SegmentMeta,
  type SegmentVaryInfo,
} from './tree'
import {
  responseVaryParamsFromWire,
  varyNamesFor,
  withVaryParamsTracking,
  type ResponseVaryParams,
} from './vary-params'
import { pageHasInPageSuspense } from './loading-boundary'
import { pageSlotFrame, stripPageSlotContent } from './page-slot'
import { withoutInlineCss } from '../css/inline-css'
import { getNextConfig } from '../next/config-loader'
import { CACHE_BUSTING_REDIRECT_HEADER } from '../protocol'
import { staticSiblingNames } from '../next/route-state'
import { loadCompatRewrites, resolveCompatRewrite, type CompatRewrite } from '../next/rewrites'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'

/** experimental.staleTimes.{static,dynamic} from next.config (seconds). */
function configuredStaleTimes(): { static?: number; dynamic?: number } {
  const experimental = getNextConfig().experimental
  if (!experimental || typeof experimental !== 'object') return {}
  const staleTimes = (experimental as { staleTimes?: unknown }).staleTimes
  if (!staleTimes || typeof staleTimes !== 'object') return {}
  const value = staleTimes as { static?: unknown; dynamic?: unknown }
  return {
    ...(typeof value.static === 'number' ? { static: value.static } : {}),
    ...(typeof value.dynamic === 'number' ? { dynamic: value.dynamic } : {}),
  }
}

/**
 * Partial Prefetching: a FULL (`<Link prefetch={true}>`) prefetch is downgraded to a partial/PPR
 * prefetch - the static shell only, never the dynamic data - when the app opts in globally
 * (`partialPrefetching`) or the target route opts in per segment (`export const prefetch =
 * 'partial'`, resolved through the route's whole segment chain so a nested leaf's opt-in reaches
 * the route the scheduler asks about). `'unstable_eager'` is the opposite policy and never downgrades.
 */
function routePartialPrefetch(route: RouteManifestEntry): boolean {
  // ...EXCEPT under App Shells, where `prefetch = 'partial'` means "rely on the shared shell for the
  // DEFAULT prefetch". An explicit `prefetch={true}` link opts back into per-link prefetching there, so
  // its full prefetch must carry this param's own content.
  if (route.segmentConfig?.prefetch === 'partial') return !appShellsEnabled()
  return (getNextConfig() as { partialPrefetching?: unknown }).partialPrefetching === true
}

/** `experimental.appShells` from next.config. */
function appShellsEnabled(): boolean {
  const experimental = getNextConfig().experimental
  if (!experimental || typeof experimental !== 'object') return false
  return (experimental as { appShells?: unknown }).appShells === true
}

/**
 * App Shells: the body prefetch of a runtime-prefetch route serves the SHARED (param-independent)
 * shell, so the render must leave `params` HANGING - the params-dependent subtree stays behind its
 * <Suspense> fallback and the client caches the response at the fallback vary path, reusable for
 * every param. Request data (cookies/headers) still resolves: it is not URL-derived.
 *
 * Strictly opt-in. WITHOUT `appShells` a runtime prefetch is per-URL and its params MUST resolve.
 * An `unstable_eager` segment is excluded even under App Shells: eager routes keep their per-link
 * Speculative prefetch, which carries that param's own content.
 */
function appShellFallbackParams(route: RouteManifestEntry): boolean {
  if (!appShellsEnabled()) return false
  return route.segmentConfig?.prefetch !== 'unstable_eager'
}

function validateRscRequestHeaders(): boolean {
  const experimental = getNextConfig().experimental
  if (!experimental || typeof experimental !== 'object') return false
  return (
    (experimental as { validateRSCRequestHeaders?: unknown }).validateRSCRequestHeaders === true
  )
}

function deploymentId(): string {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  return process.env.NEXT_DEPLOYMENT_ID || process.env.NEXT_PUBLIC_BUILD_ID || 'pnext'
}

/** Effective staleTime (seconds) for a route of the given disposition. */
function staleTimeSecondsFor(isStatic: boolean): number {
  const configured = configuredStaleTimes()
  if (isStatic) return configured.static ?? DEFAULT_STATIC_STALE_TIME_SECONDS
  return configured.dynamic ?? DEFAULT_DYNAMIC_STALE_TIME_SECONDS
}

/** The segment-prefetch header value, or null when this isn't a segment prefetch. */
function segmentPrefetchTarget(request: Request): string | null {
  if (request.headers.get(RSC_HEADER) !== '1') return null
  return request.headers.get(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER)
}

let segmentRevalidationVersion = 0

/** Bumps the segment-prefetch revalidation epoch; called by the registrar's revalidation invalidator hook. */
export function bumpSegmentRevalidationVersion(): void {
  segmentRevalidationVersion += 1
}
const segmentArtifactVersions = new Map<string, number>()

// NOTE: there is deliberately NO server-side "the client's `_rsc` predates the last revalidation,
// bounce it to a fresh CDN key" redirect. Next never issues one: `_rsc` is derived from the
// request's negotiation headers, and freshness after a revalidation comes from the server
// re-rendering the stale artifact, not from rotating the URL. A version bounce here would leak
// server state ACROSS browser sessions, so every page load after a revalidation replays a hash the
// server has already seen at an older version and its first prefetch answers 302 instead of the
// payload - which router-act cannot intercept.

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
  const selection = selectRouteForRequest(runtime.routes, matchPathname, undefined)

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
      matchInterception(runtime.routes, matchPathname, prefetchNav.children)) ||
      (selection?.route.kind === 'page' &&
        (selection.route.slotDirs?.length || selection.route.synthetic)))
  ) {
    return undefined
  }
  const isStatic = selection?.route.kind === 'page' && selection.route.mode === 'static'

  if (segment === TREE_SEGMENT_PATH && selection?.route.kind === 'page' && selection.route.ppr) {
    schedulePprShellUpgrade({ config, route: selection.route, url: new URL(request.url) })
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

  // Beyond `/_tree`: serve a framed segment payload. A segment request must
  // never fall through to the document/static-file path, which would pair
  // text/x-component headers with a full HTML document.
  if (segment !== TREE_SEGMENT_PATH) {
    if (selection?.route.kind !== 'page') {
      return withRewriteHeaders(segmentMissResponse(), rewriteHeaders)
    }
    const routeId = selection.route.id
    const file = bodySegmentFile(config.outPath, routeId)
    const meta = readSegmentMeta(config.outPath, routeId)
    // `/_layout`: w9-segment-split. The client holds a cached PAGE frame for
    // this URL (its vary set does not contain the param that changed) but its
    // LAYOUT frame missed, so it asks for the layout alone. Render the route and
    // cut the page's markup out of the document: the response carries the layout
    // chain only, keyed on the LAYOUT vary set, and the client splices its
    // cached page frame back in (compat/segment/page-slot.ts).
    if (segment === LAYOUT_SEGMENT_PATH) {
      const rendered = await renderRuntimeSegment({
        config,
        selection,
        pathname: matchPathname,
        url,
        request,
        // NOT truncated at the loading boundary. A truncated render serves the route's baked fallback
        // shell, whose params HANG - the layout never reads them, so the response would publish an
        // EMPTY vary set and the client would share one layout frame across every param value. The
        // page's markup is cut out of the finished document instead, which costs a full render but
        // keeps the layout's vary set honest.
        nav: prefetchNav,
      })
      if (!rendered) return withRewriteHeaders(segmentMissResponse(), rewriteHeaders)
      return withRewriteHeaders(
        segmentBodyResponse(
          stripPageSlotContent(rendered.body),
          effectiveStaleTime(meta, true),
          // A layout frame is never the whole page: the navigation still needs
          // the page frame (from cache, or from its own dynamic request).
          true,
          isStatic,
          deploymentId(),
          segment,
          // An EMPTY tracked set on a route that HAS params means the render read none of them -
          // either true (a param-independent layout) or an artifact of the document coming back from
          // a prerender cache. The two are indistinguishable here and the failure modes are not
          // symmetric: over-varying costs a cache hit, under-varying serves one param's layout for
          // another. So publish NO vary set and let the client key the frame on its exact URL.
          varyTrusted(rendered.vary, selection, 'layout')
            ? segmentVaryInfo(rendered.vary, 'layout', selection)
            : undefined,
        ),
        rewriteHeaders,
      )
    }
    // `/_page`: the inverse frame of `/_layout`. The client already renders this route's layout chain
    // - it is navigating WITHIN it, or holds a valid cached layout frame - so it asks for the page
    // slot alone. The response carries the slot markers plus the page's own markup and NOTHING above
    // them. Rendered like `/_layout`: NOT truncated at the loading boundary, so the tracked vary set
    // is the page's honest param access.
    if (segment === PAGE_SEGMENT_PATH) {
      const rendered = await renderRuntimeSegment({
        config,
        selection,
        pathname: matchPathname,
        url,
        request,
        nav: prefetchNav,
      })
      if (!rendered) return withRewriteHeaders(segmentMissResponse(), rewriteHeaders)
      const frame = pageSlotFrame(rendered.body)
      // No page slot (a document whose renderer dropped the markers, a global
      // error page): the frame cannot be proven to line up, so answer a MISS and
      // let the client hard-fall-back to the whole document.
      if (frame === null) return withRewriteHeaders(segmentMissResponse(), rewriteHeaders)
      return withRewriteHeaders(
        segmentBodyResponse(
          frame,
          // Rendered for the NAVIGATION: a dynamic route's frame carries
          // request data, so it reuses for the dynamic window only.
          effectiveStaleTime(meta, isStatic),
          // A page frame is never the whole document: whatever consumes it still
          // owns the layout chain around it.
          true,
          isStatic,
          deploymentId(),
          segment,
          varyTrusted(rendered.vary, selection, 'page')
            ? segmentVaryInfo(rendered.vary, 'page', selection)
            : undefined,
        ),
        rewriteHeaders,
      )
    }
    // App Shells, second request: the client asks for the route's SHARED shell explicitly. Unlike the
    // runtime-prefetch branch below - which only fires for `allow-runtime`/`unstable_instant` routes -
    // this serves a FULLY STATIC route's param-independent shell too: `params` hang, so the
    // params-dependent subtree stays behind its fallback and the response's empty vary set files it at
    // the fallback vary path. Strictly opt-in: without `experimental.appShells` the marker is ignored.
    if (
      (segment === ROUTE_SEGMENT_PATH || segment === '/_index') &&
      appShellsEnabled() &&
      request.headers.get(APP_SHELL_PREFETCH_HEADER) === '1'
    ) {
      const shell = await renderInstantPrefetchShell({
        config,
        selection,
        pathname: matchPathname,
        url,
        request,
        fallbackParams: true,
      })
      if (!shell) return withRewriteHeaders(segmentMissResponse(), rewriteHeaders)
      return withRewriteHeaders(
        segmentBodyResponse(
          shell.html,
          effectiveStaleTime(meta, true),
          true,
          // A shared shell is a pure function of the ROUTE (its params hung),
          // so the client may serve it for any URL of that route — which its
          // reuse policy allows only for static payloads.
          isStatic ||
            (selection.route.hasStaticParams === true && selection.route.usesRequest !== true),
          deploymentId(),
          segment,
          segmentVaryInfo(shell.vary, 'body', selection),
        ),
        rewriteHeaders,
      )
    }
    // A FULL prefetch of a Partial-Prefetching route is served exactly like a
    // default (partial) one — static shell, dynamic boundaries left as holes —
    // and marked so the requesting client still treats it as a shell (the
    // navigation fetches the dynamic continuation).
    const partialPrefetchDowngrade =
      request.headers.get(NEXT_ROUTER_PREFETCH_HEADER) !== '1' &&
      routePartialPrefetch(selection.route)
    const partialPrefetch =
      request.headers.get(NEXT_ROUTER_PREFETCH_HEADER) === '1' || partialPrefetchDowngrade
    const runtimePrefetch = routeUsesRuntimePrefetch(selection.route)
    // Partial Prefetching under App Shells: a route declaring `export const prefetch = 'partial'`
    // relies on its SHARED app shell, so the per-link Speculative prefetch must not additionally fetch
    // that param's own content. Answering the per-link default prefetch with the shared shell (params
    // hang, empty vary set) collapses two requests into the one that carries the shell, and the empty
    // vary set files the entry at the fallback vary path so revealing another param needs nothing from
    // the server.
    //
    // Strictly scoped: `experimental.appShells` plus the segment's OWN `prefetch = 'partial'` opt-in.
    // The global `partialPrefetching` config and `unstable_eager` are deliberately excluded.
    if (
      (segment === ROUTE_SEGMENT_PATH || segment === '/_index') &&
      request.headers.get(NEXT_ROUTER_PREFETCH_HEADER) === '1' &&
      appShellsEnabled() &&
      selection.route.segmentConfig?.prefetch === 'partial'
    ) {
      const shell = await renderInstantPrefetchShell({
        config,
        selection,
        pathname: matchPathname,
        url,
        request,
        fallbackParams: true,
      })
      if (shell) {
        return withRewriteHeaders(
          segmentBodyResponse(
            shell.html,
            effectiveStaleTime(meta, true),
            // A shell, not the whole page: the navigation still fetches the
            // param-specific continuation behind the boundary.
            true,
            // A pure function of the ROUTE (its params hung), so the client may
            // paint it for any URL of that route — which its reuse policy allows
            // only for payloads marked static.
            true,
            deploymentId(),
            segment,
            segmentVaryInfo(shell.vary, 'body', selection),
          ),
          rewriteHeaders,
        )
      }
    }
    // A route that opts into runtime prefetching (`unstable_instant` or `export const prefetch =
    // 'allow-runtime'`) renders its BODY prefetch as a RUNTIME-PREFETCH prerender: the response
    // samples request data while connection()-gated content is omitted, and nothing from this
    // request-sampled render is persisted. The client caches it as a shell, so the navigation still
    // fetches the dynamic continuation.
    //
    // The selection is the ROUTE's opt-in, NOT the prefetch header: the client ALWAYS sends
    // `next-router-prefetch: 1`, so gating on the header would never let the shell render. It stays
    // scoped to the body segment and yields to an explicit partial-prefetch (static) downgrade.
    if (
      // The client sends '/_index' as the body-segment key (router.ts
      // SEGMENT_PREFETCH_HEADER); ROUTE_SEGMENT_PATH ('/') covers direct/legacy
      // callers. Both mean the whole-route body.
      (segment === ROUTE_SEGMENT_PATH || segment === '/_index') &&
      !partialPrefetchDowngrade &&
      routeRuntimePrefetchRender(selection.route)
    ) {
      const fallbackParams = appShellFallbackParams(selection.route)
      const instant = await renderInstantPrefetchShell({
        config,
        selection,
        pathname: matchPathname,
        url,
        request,
        fallbackParams,
      })
      if (instant) {
        // A `pprMetadata` route's <title> is DYNAMIC (generateMetadata reads a param) while this shared
        // shell body legitimately varies on nothing: leaving the title inside it would under-vary the body
        // on its own head and serve one slug's title for another. Outline it here too - the client
        // re-fetches `/_head` per URL - exactly as the baked/full prefetch path below does.
        let instantHtml = instant.html
        let instantHeadOutlined = false
        if (selection.route.pprMetadata === true) {
          const outlined = outlineDocumentTitle(instantHtml)
          if (outlined) {
            instantHtml = outlined
            instantHeadOutlined = true
          }
        }
        // This response owns its window (computed just below from what the
        // sampled render really resolved). Drop the request-level `use cache`
        // aggregate so the header finalizer does not overwrite it with the
        // route's longer public-cache window.
        takeCacheLifeStash()
        const response = segmentBodyResponse(
          instantHtml,
          // A request-sampled payload reuses for the SHORTEST window it sampled,
          // never the route's baked (public-cache) one: the private caches whose
          // values ride in this response go stale first.
          instant.staleSeconds !== undefined
            ? Math.min(instant.staleSeconds, effectiveStaleTime(meta, true))
            : effectiveStaleTime(meta, true),
          true,
          isStatic,
          deploymentId(),
          segment,
          varyTrusted(
            instant.vary,
            selection,
            'body',
            fallbackParams,
            // This render always happened LIVE, so an explicit `allow-runtime`
            // route's empty set is the truth: nothing was read before the
            // render postponed, and every param shares one loading shell.
            routeExplicitRuntimePrefetch(selection.route),
          )
            ? segmentVaryInfo(instant.vary, 'body', selection)
            : undefined,
        )
        // Dedicated marker for the client: ONLY a runtime-prefetch (instant)
        // shell downgrades a full prefetch to shell semantics. The generic
        // postponed flag also rides ordinary PPR full renders, which stream
        // their resumed content and MUST keep committing without a refetch
        // (app-client-cache full-prefetch contract).
        response.headers.set('x-pnext-runtime-prefetch', '1')
        if (instantHeadOutlined) {
          response.headers.set('x-pnext-head-outlined', headFetchedFirst(selection) ? 'first' : '1')
        }
        // A COMPLETE runtime prefetch (the render never postponed - the page reads only cookies/params and
        // does no uncached IO) lets the client commit the following navigation network-free. The response
        // itself stays `postponed` on the wire: it is request-sampled, so it must never become
        // CDN-cacheable nor commit through the whole-document caches.
        if (!instant.postponed) response.headers.set('x-pnext-runtime-complete', '1')
        return withRewriteHeaders(response, rewriteHeaders)
      }
    }
    let body =
      partialPrefetch && (meta?.postponed !== true || !runtimePrefetch)
        ? await readBakedSegment({ config, selection, pathname: matchPathname, file })
        : undefined
    const baked = body !== undefined
    // A default (partial) prefetch of a dynamic page with no baked segment must NOT fall through to a
    // live render: Next answers such prefetches from static data only, and a hanging dynamic render
    // would pin the prefetch connection open forever. Routes that opt into runtime prefetching keep
    // the live render. Exception: a pure params-derived route (generateStaticParams, no request data)
    // IS static content and its live render cannot hang, so it keeps the full render - it can lack a
    // baked segment when its fallback shell failed to bake.
    const paramsOnlyStatic =
      (selection.route.hasStaticParams === true && selection.route.usesRequest !== true) ||
      clientStaticPrefetchable(selection.route)
    // A route with a LOADING boundary renders a truncated loading shell on a default prefetch (Next's
    // "show layout eagerly with loading one level down") - the render stops at the boundary, so it never
    // hangs. Only a dynamic route with NO loading/Suspense boundary would pin the connection open, so the
    // miss short-circuit applies just to those.
    const hasLoadingShell = routeHasLoadingBoundary(selection.route)
    // A route the build already prerendered for THIS param set (generateStaticParams)
    // has a known-good static shell: the prefetch renders that shell truncated at
    // its Suspense boundary (dynamic content stays a hole), so it cannot hang even
    // though the route reads request data (connection()) inside the boundary.
    const paramPrerendered = routeParamPrerendered(selection.route, selection.params)
    // A params-derived route normally serves its complete content on a default prefetch - but only
    // when the build actually knows that content. When THIS param set was never enumerated by
    // generateStaticParams and the route has a `loading` boundary, its page is dynamic for this URL
    // and the default prefetch stops at the loading shell. Truncating there also keeps the published
    // vary set to what the shell really read, so every itemId of a category shares one entry.
    const truncateAtLoading = routeHasLoadingFile(selection.route) && !paramPrerendered
    // A fully STATIC route with no baked segment (no cacheComponents build)
    // also live-renders: its content is static data Next serves complete on a
    // default prefetch, and the render cannot hang.
    if (
      partialPrefetch &&
      !runtimePrefetch &&
      body === undefined &&
      !paramsOnlyStatic &&
      !paramPrerendered &&
      !isStatic &&
      !hasLoadingShell
    ) {
      return withRewriteHeaders(segmentMissResponse(), rewriteHeaders)
    }
    // Segment-M2 deliverable 4: exactly the routes the miss short-circuit above
    // used to swallow, now kept alive by an IN-PAGE <Suspense> boundary. Next
    // answers their default prefetch with the route's SHARED fallback shell:
    // params hang, so the params-dependent child stays behind its Suspense
    // fallback and the (empty) vary set files ONE entry the client reuses for
    // every param value. A concrete-params render would record the child's param
    // access instead and key an identical fallback per URL. Same conditions as
    // the short-circuit, so no route that already served content changes shape;
    // a shell that fails to render falls through to the live truncated render.
    if (
      (segment === ROUTE_SEGMENT_PATH || segment === '/_index') &&
      partialPrefetch &&
      !runtimePrefetch &&
      body === undefined &&
      !paramsOnlyStatic &&
      !paramPrerendered &&
      !isStatic &&
      !routeHasLoadingFile(selection.route)
    ) {
      const shell = await renderInstantPrefetchShell({
        config,
        selection,
        pathname: matchPathname,
        url,
        request,
        fallbackParams: true,
      })
      if (shell) {
        return withRewriteHeaders(
          segmentBodyResponse(
            shell.html,
            effectiveStaleTime(meta, true),
            // A shell, not the whole page: the navigation still fetches the
            // dynamic continuation behind the boundary.
            true,
            // A pure function of the ROUTE (its params hung), so the client may
            // paint it for any URL of that route — which its reuse policy allows
            // only for payloads marked static.
            true,
            deploymentId(),
            segment,
            segmentVaryInfo(shell.vary, 'body', selection),
          ),
          rewriteHeaders,
        )
      }
    }
    // `/_head`: the outlined dynamic head (metadata) of a full prefetch. The
    // client fetches it as a follow-up to an /_index response marked
    // x-pnext-head-outlined, so the title arrives in its own response AFTER
    // the page content (Next fetches metadata separately from segment data,
    // and the suites assert that response order).
    if (segment === HEAD_SEGMENT_PATH) {
      const rendered = await renderRuntimeSegment({
        config,
        selection,
        pathname: matchPathname,
        url,
        request,
        nav: prefetchNav,
      })
      const title = rendered ? extractDocumentTitle(rendered.body) : null
      if (title === null) return withRewriteHeaders(segmentMissResponse(), rewriteHeaders)
      return withRewriteHeaders(
        segmentBodyResponse(
          title,
          effectiveStaleTime(meta, false),
          false,
          false,
          deploymentId(),
          segment,
          // The head segment publishes the HEAD vary set — generateMetadata's
          // own param access, tracked separately from the page body's.
          segmentVaryInfo(rendered!.vary, 'head', selection),
        ),
        rewriteHeaders,
      )
    }
    let postponed: boolean
    // Segment-M2: the vary set of the live render, when one happened. A BAKED
    // segment was produced at build time outside any tracking scope, so it stays
    // undefined and the client keys that entry on the exact URL.
    let bodyVary: ResponseVaryParams | undefined
    // The set came off the BAKED `route.segment.meta`, i.e. the BUILD already applied its own trust rule
    // before persisting it - and only the build has the evidence (was the render tracked? did its params
    // hang?). Re-testing it below with the REQUEST-render rule would discard a fallback shell's honest
    // empty set. Presence in the meta IS the trust.
    let bakedVaryFromMeta = false
    // True when this response is a render TRUNCATED at the route's `loading`
    // boundary (see `truncateAtLoading`): the shell above the boundary, with the
    // dynamic page left as a hole.
    let truncatedShell = false
    /** The live render's own `use cache` window, when one rendered. */
    let renderStaleSeconds: number | undefined
    if (body === undefined) {
      // A route that only IMPLIED runtime prefetching (it reads searchParams, so a baked segment must
      // not alias across search values) still follows the default-prefetch contract: the render is
      // truncated at its loading/Suspense shell, never a full dynamic render. Only an explicit
      // `allow-runtime` serves runtime data on a partial prefetch, and a pure params-derived route
      // serves its complete static content.
      truncatedShell =
        partialPrefetch && !routeExplicitRuntimePrefetch(selection.route) && truncateAtLoading
      const rendered = await renderRuntimeSegment({
        config,
        selection,
        pathname: matchPathname,
        url,
        request,
        keepPrefetchHeader:
          partialPrefetch &&
          !routeExplicitRuntimePrefetch(selection.route) &&
          (!paramsOnlyStatic || truncateAtLoading),
        nav: prefetchNav,
      })
      if (!rendered) return withRewriteHeaders(segmentMissResponse(), rewriteHeaders)
      body = rendered.body
      bodyVary = rendered.vary
      renderStaleSeconds = rendered.staleSeconds
      // A truncated (loading-shell) prefetch is often answered from the route's baked PPR SUB-SHELL, so
      // the request tracked no param access even though the bytes are a known function of the sub-shell's
      // own params. Publish those instead of "unknown" - otherwise every itemId of one category re-fetches
      // a byte-identical shell.
      if (
        truncateAtLoading &&
        bodyVary.params.length === 0 &&
        !bodyVary.search &&
        Object.keys(selection.params).length > 0
      ) {
        bodyVary = subShellVary(selection.route, selection.params) ?? bodyVary
      }
      // The same artifact, one level up: a render answered from this URL's own
      // BUILD prerender executes no user code, so it tracks nothing even though
      // the build render recorded exactly what each segment read. Publish the
      // persisted sets (`route.prerenderVary`) rather than "unknown".
      if (bodyVary.params.length === 0 && !bodyVary.search) {
        bodyVary = prerenderVary(selection.route, matchPathname) ?? bodyVary
      }
      postponed = rendered.postponed || (partialPrefetch && meta?.postponed === true)
      // unstable_dynamicOnHover resume: the client already holds this route's
      // static shell (x-pnext-resume-shell) and a full hover prefetch must not
      // re-send static content it has cached. Strip the document down to its
      // streamed dynamic chunks; the client merges them into its shell.
      if (!partialPrefetch && request.headers.get('x-pnext-resume-shell') === '1') {
        const resume = resumeOnlyDocument(body)
        if (resume) {
          const response = segmentBodyResponse(
            resume,
            effectiveStaleTime(meta, false),
            false,
            false,
            deploymentId(),
            segment,
            varyTrusted(rendered.vary, selection, 'body')
              ? segmentVaryInfo(rendered.vary, 'body', selection)
              : undefined,
          )
          response.headers.set('x-pnext-resume-only', '1')
          return withRewriteHeaders(response, rewriteHeaders)
        }
      }
    } else {
      postponed = meta?.postponed === true
      // Segment-M2: a BAKED body carries the vary set its BUILD render tracked
      // (persisted into `route.segment.meta`). Without it every prerendered
      // route keys on its exact URL and re-fetches the shared shell for every
      // param value. Absent (an older/untracked artifact) stays "unknown".
      bodyVary = meta?.vary ? responseVaryParamsFromWire(meta) : undefined
      bakedVaryFromMeta = bodyVary !== undefined
    }
    // A FULL prefetch of a route with DYNAMIC metadata: outline the <title> out of this response -
    // the client fetches it via `/_head` as a separate, LATER response and merges it back before
    // caching (Next serves the head separately, and the suites assert that order). A PARTIAL prefetch
    // outlines too: its body is just as shared across params. A baked route-level shell was rendered
    // with the params hanging and carries NO <title> at all, but the head is dynamic all the same, so
    // mark it outlined and let the client fetch `/_head`.
    let headOutlined = false
    if (selection.route.pprMetadata === true) {
      const outlined = outlineDocumentTitle(body)
      if (outlined) {
        body = outlined
        headOutlined = true
      } else if (!/<title>/i.test(body)) {
        headOutlined = true
      }
    }
    const completePrerender = baked && !postponed
    // A postponed (shell-only) prefetch response carries only static data, so its shell reuses for the
    // STATIC window regardless of the route's mode. Likewise a DEFAULT prefetch of a route that never
    // reads request data: its content is a pure function of the URL, so even a complete live render reuses
    // for the static window.
    const routeStaleTime = completePrerender
      ? meta && meta.staleTime > 0
        ? meta.staleTime
        : staleTimeSecondsFor(true)
      : effectiveStaleTime(
          meta,
          postponed ||
            isStatic ||
            (partialPrefetch && (!selection.route.usesRequest || paramsOnlyStatic)),
        )
    // A RUNTIME-PREFETCH answer (`prefetch = 'allow-runtime'` downgrading a full
    // prefetch) carries request-sampled data, so it goes stale with the SHORTEST
    // cache the render resolved — typically a `use cache: private` window — not
    // with the route's baked public-cache window.
    const staleTime =
      partialPrefetchDowngrade && renderStaleSeconds !== undefined
        ? Math.min(renderStaleSeconds, routeStaleTime)
        : routeStaleTime
    const bodyResponse = segmentBodyResponse(
      body,
      staleTime,
      postponed,
      // A pure params-derived live render is a prerender: its bytes are a
      // function of the URL alone. Marking it lets the client alias it as
      // reusable full data (no speculative re-fetch of the same URL).
      //
      // A TRUNCATED loading shell of such a route qualifies too: everything it
      // contains sits above the boundary and reads nothing but params, so the
      // client may share it across every URL its vary set covers instead of
      // re-fetching a byte-identical shell per param value.
      baked || isStatic || ((!postponed || truncatedShell) && paramsOnlyStatic),
      deploymentId(),
      segment,
      bodyVary &&
        (bakedVaryFromMeta ||
          varyTrusted(
            bodyVary,
            selection,
            'body',
            false,
            // Live render only (`!baked`): a baked body tracked nothing, so its empty set is the
            // artifact this guard exists for. `allow-runtime` ONLY, not every "explicit"
            // runtime-prefetch route: an `unstable_eager` route RESOLVES its params in this render, so
            // an empty set there is the untracked artifact, not the truth - trusting it published one
            // shared entry for the whole route and elided every later param's prefetch.
            selection.route.segmentConfig?.prefetch === 'allow-runtime' && !baked,
          ))
        ? segmentVaryInfo(bodyVary, 'body', selection)
        : undefined,
      // App Shells: a COMPLETE per-URL prerender carries the route's shared
      // shell alongside it, so a navigation to another param of the route has
      // an instant shell to paint without a second request.
      completePrerender || (!postponed && paramsOnlyStatic)
        ? routeAppShell(config, selection)
        : undefined,
    )
    if (headOutlined) {
      bodyResponse.headers.set('x-pnext-head-outlined', headFetchedFirst(selection) ? 'first' : '1')
    }
    // The client asked for a FULL prefetch; this answer is a shell. Same marker
    // the runtime-prefetch (unstable_instant) downgrade uses — the generic
    // postponed flags never downgrade a full prefetch (ordinary PPR full
    // renders carry them while streaming complete resumed content).
    if (partialPrefetchDowngrade) bodyResponse.headers.set('x-pnext-runtime-prefetch', '1')
    return withRewriteHeaders(bodyResponse, rewriteHeaders)
  }

  // `/_tree`: the RootTreePrefetch. Unmatched/non-page targets get an empty
  // (dynamic) tree so the client falls back to a full nav fetch (never 404s).
  const routeId = selection?.route.id
  const bakedTree = routeId ? readSegmentTree(config.outPath, routeId) : undefined
  if (routeId && bakedTree) {
    // The route tree's SHAPE is static in Next: it reuses for the static window
    // regardless of whether the route itself renders dynamically. markUrlStaticFresh
    // (router.ts) only records a URL's static freshness when x-nextjs-stale-time > 0,
    // so a dynamic route's tree (dynamic window = 0) would never warm the elision
    // map and every re-revealed link would refetch the tree (breaking the
    // encoded-slash-params back-navigation contract). Stamp the STATIC window on the
    // tree even for dynamic routes; the segment body branch keeps its own windows.
    const staleTime = isStatic
      ? effectiveStaleTime(readSegmentMeta(config.outPath, routeId), true)
      : staleTimeSecondsFor(true)
    return withRewriteHeaders(
      new Response(treeWithStaleTime(bakedTree, staleTime, url.searchParams.has('_rsc')), {
        status: 200,
        headers: {
          'content-type': RSC_CONTENT_TYPE_HEADER,
          'x-nextjs-postponed': '2',
          'x-nextjs-stale-time': String(staleTime),
          ...(isStatic ? { 'x-nextjs-prerender': '1' } : {}),
          // Announce head outlining on the tree HEADERS too, so the client
          // can keep head-before-body order without reading the tree body.
          ...(selection?.route.pprMetadata === true
            ? { 'x-pnext-head-outlined': headFetchedFirst(selection) ? 'first' : '1' }
            : {}),
          'x-nextjs-deployment-id': deploymentId(),
          // A static route's baked tree is CDN-cacheable like Next's
          // prerendered payloads; the per-variant `_rsc` cache-buster keys
          // it correctly on Vary-ignoring CDNs.
          'cache-control': isStatic
            ? 's-maxage=31536000, stale-while-revalidate'
            : 'private, no-store',
        },
      }),
      rewriteHeaders,
    )
  }
  const payload = buildRootTreePrefetch({
    pathname: matchPathname,
    isStatic,
    staleTimeSeconds: staleTimeSecondsFor(isStatic),
    routeId: selection?.route.id,
    runtimePrefetch:
      (selection?.route.segmentConfig as { prefetch?: unknown } | undefined)?.prefetch ===
      'allow-runtime',
    postponed: Boolean(selection?.route.pprHoles?.length),
    // Segment-M2: route identity + this URL's params so the client can key
    // shared segment entries before it has fetched a body for this URL.
    ...(selection?.route.kind === 'page'
      ? { routePattern: selection.route.route, params: wireParams(selection.params) }
      : {}),
    ...(selection?.route.pprMetadata === true
      ? { headOutlined: true, ...(headFetchedFirst(selection) ? { headFirst: true } : {}) }
      : {}),
  })
  const treeResponse = treePrefetchResponse(payload, {
    format: url.searchParams.has('_rsc') ? 'flight' : 'json',
  })
  // Mirror the payload's head-outlining on the HEADERS (see baked branch).
  if (selection?.route.pprMetadata === true) {
    treeResponse.headers.set('x-pnext-head-outlined', headFetchedFirst(selection) ? 'first' : '1')
  }
  return withRewriteHeaders(withDeploymentId(treeResponse), rewriteHeaders)
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

/** True when the build prerendered this route for the given param set. */
function routeParamPrerendered(
  route: RouteManifestEntry,
  params: Record<string, unknown>,
): boolean {
  const sets = route.prerenderedParams
  if (!sets?.length) return false
  return sets.some(set => {
    const keys = Object.keys(set)
    return (
      keys.length === Object.keys(params).length &&
      keys.every(key => String(set[key]) === String(params[key]))
    )
  })
}

/**
 * The vary set of a prefetch answered from a PPR SUB-SHELL - the build baked that shell for a param
 * SUBSET, so a request-time render tracks nothing while its bytes are a pure function of exactly
 * those params. The layout chain consumed them; the page contributed only its `loading` fallback, so
 * the PAGE frame stays shareable across every value of the remaining params.
 */
/**
 * The route's shared APP SHELL - the build's params-hanging render. Carried alongside a per-URL
 * prerender so the client can file it at the route's fallback vary path. Undefined for a param-free
 * route, or when the build baked no such shell.
 */
function routeAppShell(
  config: ResolvedConfig,
  selection: NonNullable<ReturnType<typeof selectRouteForRequest>>,
): SegmentAppShell | undefined {
  // Strictly opt-in, like the client's second (param-stripped) shell prefetch:
  // without the flag the extra bytes would ride on every prerender response.
  if (!appShellsEnabled()) return undefined
  if (!selection.route.route.includes(':')) return undefined
  const file = join(config.outPath, 'ppr', `${selection.route.id}.html`)
  if (!existsSync(file)) return undefined
  try {
    return { html: readFileSync(file, 'utf8'), route: selection.route.route }
  } catch {
    return undefined
  }
}

/** The vary sets the BUILD render of this exact prerendered URL tracked. */
function prerenderVary(
  route: RouteManifestEntry,
  pathname: string,
): ResponseVaryParams | undefined {
  const wire = route.prerenderVary?.[pathname || '/']
  return wire ? responseVaryParamsFromWire(wire) : undefined
}

function subShellVary(
  route: RouteManifestEntry,
  params: Record<string, unknown>,
): ResponseVaryParams | undefined {
  const shell = route.pprSubShells?.find(candidate =>
    Object.entries(candidate.concreteParams).every(
      ([name, value]) => String(value) === String(params[name]),
    ),
  )
  const names = Object.keys(shell?.concreteParams ?? {}).sort()
  if (!names.length) return undefined
  return responseVaryParamsFromWire({ vary: names, layoutVary: names, pageVary: [] })
}

async function readBakedSegment({
  config,
  selection,
  pathname,
  file,
}: {
  config: ResolvedConfig
  selection: NonNullable<ReturnType<typeof selectRouteForRequest>>
  pathname: string
  file: string
}): Promise<string | undefined> {
  if (!existsSync(file)) return undefined
  await regenerateStaleSegment({ config, selection, pathname, file })
  try {
    // A baked FALLBACK-shell segment was rendered with every param hanging, so
    // its `__PNEXT_ROUTE__` carries `params: {}`. Stamp this request's params
    // in, exactly as the document path does — the client paints this body as
    // the loading shell and reads its route state for useParams()/prediction.
    return withRequestRouteParams(readFileSync(file, 'utf8'), selection.params)
  } catch {
    return undefined
  }
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
  return config?.unstableInstant === true || config?.prefetch === 'allow-runtime'
}

function routeUsesRuntimePrefetch(route: RouteManifestEntry): boolean {
  if (routeExplicitRuntimePrefetch(route)) return true
  if (clientStaticPrefetchable(route)) return false
  try {
    return /\b(?:searchParams|useSearchParams)\b/.test(readFileSync(route.file, 'utf8'))
  } catch {
    return false
  }
}

/**
 * A CLIENT page's params/searchParams access resolves client-side from the live URL, so its server
 * render is a pure function of the exact URL and is servable complete on a default prefetch. Only
 * true when no server segment in the chain reads real request data.
 */
function clientStaticPrefetchable(route: RouteManifestEntry): boolean {
  if (route.client !== true) return false
  // Only the route's own app segments matter (sourceFiles also lists framework
  // modules, whose text mentions request APIs in comments/implementations).
  const appDir = route.file.slice(0, route.file.lastIndexOf('/app/') + '/app/'.length)
  for (const file of route.sourceFiles ?? []) {
    if (file === route.file) continue
    if (!appDir || !file.startsWith(appDir)) continue
    try {
      if (/\b(?:cookies|headers|connection|draftMode)\s*\(/.test(readFileSync(file, 'utf8'))) {
        return false
      }
    } catch {
      return false
    }
  }
  return true
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
}: {
  config: ResolvedConfig
  selection: NonNullable<ReturnType<typeof selectRouteForRequest>>
  pathname: string
  url: URL
  request: Request
  /** App Shells: render the SHARED shell (params hang, request data resolves). */
  fallbackParams?: boolean
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
  // Segment-M2 deliverable 1: the render runs inside a vary-params tracking
  // scope so the response can publish which params it actually read.
  let staleSeconds: number | undefined
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
            ...(fallbackParams ? { fallbackParams: true } : {}),
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
        vary: tracked.vary,
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
 * App Shells: the client's marker for the SECOND, param-stripped prefetch that
 * primes a route's shared shell (compat/client/segment-prefetch.ts). Only
 * meaningful under `experimental.appShells`.
 */
const APP_SHELL_PREFETCH_HEADER = 'x-pnext-app-shell'

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

/** Modification time of `file`, or undefined when it does not exist. */
function fileMtimeMs(file: string): number | undefined {
  try {
    return statSync(file).mtimeMs
  } catch {
    return undefined
  }
}

async function regenerateStaleSegment({
  config,
  selection,
  pathname,
  file,
}: {
  config: ResolvedConfig
  selection: NonNullable<ReturnType<typeof selectRouteForRequest>>
  pathname: string
  file: string
}): Promise<void> {
  let mtimeMs: number
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    return
  }
  const servedVersion = segmentArtifactVersions.get(file) ?? 0
  const url = new URL(`http://pnext.local${pathname}`)
  // A PPR route's shell is the SAME render this segment body is cut from, so a
  // shell that was rewritten after this artifact makes the artifact stale even
  // when no revalidation is outstanding: without it the document serves the new
  // regeneration's data while the prefetch keeps replaying the old one's.
  const shellMtimeMs =
    selection.route.ppr === true
      ? fileMtimeMs(pprShellPath(config.outPath, selection.route.id))
      : undefined
  const stale =
    servedVersion < segmentRevalidationVersion ||
    getRequestExtensions().staticStaleness(pathname, mtimeMs, []) ||
    (shellMtimeMs !== undefined && shellMtimeMs > mtimeMs)
  if (!stale) return

  // Adopt the shell this route currently serves (regenerating it only when it
  // is itself stale, through the renderer's single-flight) rather than running
  // a second, independent prerender whose cache reads would resolve to their
  // own values.
  if (shellMtimeMs !== undefined) {
    const shell = await currentPprShellHtml({
      config,
      route: selection.route,
      params: selection.params,
      url,
    })
    if (shell !== null) {
      await writeFile(file, shell)
      segmentArtifactVersions.set(file, segmentRevalidationVersion)
      return
    }
  }

  const rendered = await getRenderExtensions().collectRenderMeta(
    () =>
      withRouteRuntime(selection.route.segmentConfig?.runtime, () =>
        renderPartialShell({
          config,
          route: selection.route,
          params: selection.params,
          url,
          runtimeRegen: true,
        }),
      ),
    {
      fetchCache: selection.route.segmentConfig?.fetchCache,
      refreshFetches: true,
      blockingStaleFetches: true,
      route: pathname,
      prerender: true,
    },
  )
  if (!rendered.value) return
  await writeFile(file, rendered.value.shell)
  segmentArtifactVersions.set(file, segmentRevalidationVersion)
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

function parseCookieHeader(header: string | null): Record<string, string> {
  if (!header) return {}
  const cookies: Record<string, string> = {}
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    const key = part.slice(0, index).trim()
    if (key) cookies[key] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return cookies
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

const ROUTER_VARY = [
  'rsc',
  'next-router-state-tree',
  'next-router-prefetch',
  'next-router-segment-prefetch',
]

function mergeRouterVary(headers: Headers): void {
  const existing = headers.get('vary')
  const values = existing
    ? existing
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
    : []
  const present = new Set(values.map(value => value.toLowerCase()))
  for (const value of ROUTER_VARY) {
    if (!present.has(value)) {
      present.add(value)
      values.push(value)
    }
  }
  headers.set('vary', values.join(', '))
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
    (selection !== null && routeParamPrerendered(selection.route, selection.params ?? {}))
  // A NAVIGATION response of a postponed (PPR) route streams the resumed
  // dynamic data: it is a dynamic document and must reuse for the DYNAMIC
  // window (staleTimes.dynamic gates how long the client re-commits it), even
  // though the route's built segment meta carries the shell's static window.
  if (!isStatic && postponedResponse) {
    ctx.headers.set('x-nextjs-stale-time', String(staleTimeSecondsFor(false)))
    return
  }
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

function effectiveStaleTime(meta: SegmentMeta | undefined, isStatic: boolean): number {
  const configured = staleTimeSecondsFor(isStatic)
  if (!meta) return configured
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

function treeWithStaleTime(tree: string, staleTime: number, flight: boolean): string {
  const json = tree.startsWith('0:') ? tree.slice(2) : tree
  try {
    const payload = JSON.parse(json) as { staleTime?: unknown }
    const body = JSON.stringify(
      payload.staleTime === staleTime ? payload : { ...payload, staleTime },
    )
    return flight ? `0:${body}` : body
  } catch {
    return tree
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

// The public URL pattern of a route in the client's bracket form, split into
// segments — the same shape the optimistic-routing trie keys on.
function routePublicPattern(route: Pick<RouteManifestEntry, 'route'>): string[] {
  return route.route
    .replace(/:([a-zA-Z0-9_]+)\*/g, '[...$1]')
    .replace(/:([a-zA-Z0-9_]+)/g, '[$1]')
    .split('/')
    .filter(Boolean)
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
  return staticSiblingNames(routes, routePublicPattern(route))
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

function withDeploymentId(response: Response): Response {
  response.headers.set('x-nextjs-deployment-id', deploymentId())
  return response
}
