// OpenTelemetry extension registration (COMPAT).
//
// Wires the Next span taxonomy onto core seams without any core edit:
//   - initHooks (build + start): remember the app root (for @opentelemetry/api resolution) and install
//     the AppRender.fetch span wrapper.
//   - requestExtensions.interceptors: open the root BaseServer.handleRequest span (extracting an incoming
//     traceparent) and set its `next.route`/`http.route` from the matched route pattern. Runs late so it
//     observes the request after action-dispatch and rewrites.
//   - requestExtensions.responseFinalizers: close the root span with the final `http.status_code`,
//     pre-flush.
//   - requestExtensions.onRequestError: mark the root span errored for anything the funnel catches.
//
// Child spans are emitted from their own compat call sites. The root span alone satisfies the bulk of the
// opentelemetry suite. Everything is inert unless next compat is on AND @opentelemetry/api resolves from
// the app.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { ResolvedConfig } from '../../config'
import type { RouteManifestEntry } from '../../types'
import {
  registerInitHooks,
  registerRequestInterceptors,
  registerRequestWarmHooks,
  registerResponseFinalizers,
  getRequestExtensions,
  setRequestExtensions,
  type RequestInterceptor,
  type ResponseFinalizer,
} from '../../extensions'
import { nextCompatEnabled } from '../aliases'
import { getRequestRuntime } from '../../routing/request-environment'
import { selectRouteForRequest } from '../../routing/routes'
import { queueAfterTask } from '../../request/context'
import {
  getDocumentScriptExtensions,
  setRenderSpanExtensions,
  setDocumentScriptExtensions,
  setStreamBoundaryExtensions,
} from '../../render/hooks'
import { setProxyRunObserver } from '../../routing/proxy'
import {
  SPAN_TYPE,
  emitClientComponentLoadingSpan,
  emitLeafSpan,
  emitStartResponseSpan,
  endRootSpan,
  endRootSpanIfUnclosed,
  markRenderSpanError,
  setOtelAppRoot,
  setRootSpanRoute,
  startRootSpan,
  withChildSpan,
  withMiddlewareSpan,
  withPagesApiHandlerSpan,
  withPagesDataSpan,
  withRenderBodySpan,
  withRouteHandlerSpan,
} from '../otel/tracer'
import { getOtelApi } from '../otel/api'
import { installFetchSpan } from '../otel/fetch-span'
import { clientTraceMetadataTags } from '../otel/client-trace-metadata'
import { instrumentationReady } from '../lifecycle/instrumentation'

/**
 * The ROOT-span interceptor. Registered FIRST, before every other sub-registrar, so the
 * `BaseServer.handleRequest` span is open before any short-circuiting interceptor (segment `_tree`
 * prefetches, the RSC protocol responder, action dispatch) produces a response - those responses still
 * flow through the response finalizer, which closes the span. The route attributes are stamped
 * immediately from the pre-rewrite match; the LATE interceptor re-stamps them after rewrites.
 */
export function registerOtelRootInterceptor(config: ResolvedConfig): void {
  if (!nextCompatEnabled(config)) return
  setOtelAppRoot(config.root)

  const rootInterceptor: RequestInterceptor = async request => {
    try {
      // Instrumentation register() installs the app's TracerProvider; opening
      // the root span before it completes would produce a non-recording span.
      await instrumentationReady()
      const url = new URL(request.url)
      startRootSpan({
        method: request.method.toUpperCase(),
        target: url.pathname + url.search,
        rsc: request.headers.get('rsc') === '1',
        headers: request.headers,
      })
      stampMatchedRoute(url.pathname)
      // Safety net for the synchronous-500 error path: core's top-level catch
      // returns a bare 500 WITHOUT running responseFinalizers, so the finalizer
      // never closes the root span there. The work-unit after-queue DOES flush
      // on that path (flushWorkUnit in the catch), so end the span as 500 from
      // an after-task. Idempotent: on success paths the finalizer ends it first.
      queueAfterTask(() => endRootSpanIfUnclosed(500))
    } catch {
      // Never let tracing break the request.
    }
    return undefined
  }
  registerRequestInterceptors(rootInterceptor)
  // Resolving @opentelemetry/api out of the app loads the whole package inside this interceptor on
  // the first request. The result is memoized, so paying it in the dev warm just moves it off that
  // request.
  registerRequestWarmHooks(() => void getOtelApi(config.root))
}

/** Resolve the matched route for `pathname` and stamp it on the root span. */
function stampMatchedRoute(pathname: string): void {
  const runtime = getRequestRuntime()
  if (!runtime) return
  const matched = selectRouteForRequest(runtime.routes, pathname, undefined)
  if (!matched) return
  const routeRuntime = matched.route.segmentConfig?.runtime
  setRootSpanRoute(routeEntryToDisplay(matched.route), {
    edge: routeRuntime === 'edge' || routeRuntime === 'experimental-edge',
    kind: matched.route.kind === 'handler' ? 'handler' : 'page',
    params: matched.params,
  })
}

export function registerOtelExtensions(config: ResolvedConfig): void {
  if (!nextCompatEnabled(config)) return

  const appRoot = config.root
  setOtelAppRoot(appRoot)

  // Install the fetch span wrapper at server (and build) start, AFTER the cache
  // fetch-patch has wrapped globalThis.fetch (register order: cache before otel).
  registerInitHooks(() => {
    installFetchSpan(appRoot)
  })

  // Materialized pages wrappers (compat/pages wrapperSource) call this global —
  // when present — around their getServerSideProps/getStaticProps invocation so
  // the `Render.<kind>` span lands beside the document render span. A global
  // (not an import) keeps the generated bundles pnext-agnostic.
  ;(
    globalThis as { __PNEXT_PAGES_DATA_SPAN__?: typeof withPagesDataSpan }
  ).__PNEXT_PAGES_DATA_SPAN__ = withPagesDataSpan

  // Render-internal spans (nest under the request root span via the work-unit
  // ALS the tracer threads): the render-body span (`render route (app)`), the
  // route-resolution span (`resolve page components`), and cheap leaf
  // segment-module spans. All inert when no root span is open.
  setRenderSpanExtensions({
    withRenderBodySpan: (route, fn) => {
      const displayRoute = routePatternToDisplay(route)
      // A materialized pages route renders through the app pipeline, but Next
      // reports it as the pages-router document render span.
      if (isPagesCompatRoute(route)) {
        return withRenderBodySpan(
          `render route (pages) ${displayRoute}`,
          displayRoute,
          fn,
          SPAN_TYPE.renderDocument,
        )
      }
      return withRenderBodySpan(`render route (app) ${displayRoute}`, displayRoute, fn)
    },
    withFindPageComponentsSpan: (route, fn) => {
      const entry = routeEntryFor(route)
      // A materialized pages-API route reports ONLY its Node.runHandler span
      // (Next's pages-api dispatch has no findPageComponents phase).
      if (entry?.kind === 'handler' && isPagesCompatEntry(entry)) return fn()
      const displayRoute = routePatternToDisplay(route)
      return withChildSpan(
        'resolve page components',
        SPAN_TYPE.findPageComponents,
        { 'next.route': displayRoute },
        fn,
      )
    },
    emitResolveSegmentSpan: segment =>
      emitLeafSpan('resolve segment modules', SPAN_TYPE.getLayoutOrPageModule, {
        'next.segment': segment,
      }),
    withRouteHandlerSpan: (route, fn) =>
      isPagesCompatRoute(route)
        ? withPagesApiHandlerSpan(routePatternToDisplay(route), fn)
        : withRouteHandlerSpan(routePatternToDisplay(route), fn),
  })
  setStreamBoundaryExtensions({ onStreamBoundaryError: markRenderSpanError })

  // clientTraceMetadata meta tags injected once into the document head (dynamic pages only; a production
  // start skips static). Composed with register-render's documentBodyScripts under a separate key.
  // The renderer's `ctx.dynamic` already encodes Next's gating: dev renders are always dynamic, a prod
  // STATIC page is dynamic:false, a prod DYNAMIC page is dynamic:true. So isNextStart:true is safe -
  // clientTraceMetadataTags only drops when isNextStart && !dynamic, exactly the prod-static case.
  const previousHeadTags = getDocumentScriptExtensions().documentHeadTags
  setDocumentScriptExtensions({
    documentHeadTags: (cfg, ctx) =>
      `${previousHeadTags?.(cfg, ctx) ?? ''}${clientTraceMetadataTags({ dynamic: ctx.dynamic, isNextStart: true, rsc: ctx.rsc })}`,
  })

  // Middleware.execute span around the proxy/middleware handler run. Parents
  // under the incoming traceparent (top-level trace), NOT the request root span.
  setProxyRunObserver((request, fn) => withMiddlewareSpan(request, fn))

  const previousOnRequestError = getRequestExtensions().onRequestError
  setRequestExtensions({
    onRequestError: async (error, requestInfo, context) => {
      markRenderSpanError(error)
      await previousOnRequestError(error, requestInfo, context)
    },
  })

  // Late interceptor: re-stamp the route attributes after the rewrite/action
  // interceptors ran, so a rewritten request reports its DESTINATION route
  // (the root span itself was opened by the early interceptor with the
  // original target — see registerOtelRootInterceptor).
  const otelRouteInterceptor: RequestInterceptor = request => {
    try {
      stampMatchedRoute(new URL(request.url).pathname)
    } catch {
      // Never let tracing break the request.
    }
    return Promise.resolve(undefined)
  }
  registerRequestInterceptors(otelRouteInterceptor)

  // Close the root span pre-flush with the final status. Runs on every response-producing path (page
  // render, route handler, static file, redirect, 404). Before closing, emit the pre-flush leaf spans Next
  // nests in the tree: `clientComponentLoading` (page renders only) and `start response` under the open
  // render span for pages, or the root for handlers.
  const otelFinalizer: ResponseFinalizer = ctx => {
    try {
      if (ctx.routeKind === 'html') emitClientComponentLoadingSpan(0)
      if (ctx.routeKind === 'html' || ctx.routeKind === 'route-handler') {
        emitStartResponseSpan()
      }
      endRootSpan(ctx.status)
    } catch {
      // ignore
    }
  }
  registerResponseFinalizers(otelFinalizer)
}

/** The runtime route entry matching a raw route pattern. */
function routeEntryFor(routePattern: string): RouteManifestEntry | undefined {
  return getRequestRuntime()?.routes.find(r => r.route === routePattern)
}

// A hybrid app materializes BOTH trees under `pnext-pages-compat`: native app
// files become `source-app/...` shims, pages files become `source-pages/...`
// wrappers. Only the latter are pages-router routes. The import specifier is a
// stable generator-owned marker; cache per file (routes don't change at start).
const pagesCompatFileCache = new Map<string, boolean>()
function isPagesCompatEntry(entry: RouteManifestEntry | undefined): boolean {
  if (!entry?.file.includes(`${path.sep}pnext-pages-compat${path.sep}`)) return false
  let cached = pagesCompatFileCache.get(entry.file)
  if (cached === undefined) {
    try {
      cached = readFileSync(entry.file, 'utf8').includes('source-pages/')
    } catch {
      cached = false
    }
    pagesCompatFileCache.set(entry.file, cached)
  }
  return cached
}

/** Whether `routePattern` matches a route materialized from `pages/`. */
function isPagesCompatRoute(routePattern: string): boolean {
  return isPagesCompatEntry(routeEntryFor(routePattern))
}

function routeEntryToDisplay(route: RouteManifestEntry): string {
  let value = route.route || '/'
  if (route.catchAll) {
    const token = route.catchAllOptional ? `[[...${route.catchAll}]]` : `[...${route.catchAll}]`
    value = value.replace(`:${route.catchAll}*`, token)
  }
  for (const param of route.params) value = value.replace(`:${param}`, `[${param}]`)
  return value
}

function routePatternToDisplay(route: string): string {
  return route.replace(/:([A-Za-z0-9_]+)\*/g, '[...$1]').replace(/:([A-Za-z0-9_]+)/g, '[$1]')
}
