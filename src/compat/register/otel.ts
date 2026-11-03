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

import { nextResponseMeta } from '../../api/server'
import { conventionFileExists } from '../../runtime/production'
import { isGeneratedPagesLayout, isMaterializedPagesRoute } from '../pages/api'
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
import { selectRouteForRequest } from '../../routing/match'
import { getWorkUnit, queueAfterTask } from '../../request/context'
import {
  getDocumentScriptExtensions,
  setRenderSpanExtensions,
  setDocumentScriptExtensions,
  setStreamBoundaryExtensions,
} from '../../render/hooks'
import { findProxyFile, setProxyRunObserver } from '../../routing/proxy'
import { productionRelease } from '../../runtime/production'
import {
  SPAN_TYPE,
  queueClientComponentLoadingSpan,
  beginClientModuleLoad,
  recordClientComponent,
  emitLeafSpan,
  emitErrorDocumentMetadataSpans,
  emitStartResponseSpan,
  endRootSpanIfUnclosed,
  markRenderSpanError,
  markHandlerSpanError,
  markRootSpanError,
  recordResponseStatus,
  rootOtelContext,
  forwardRootTraceHeaders,
  setOtelAppRoot,
  setRootSpanRoute,
  startRootSpan,
  withChildSpan,
  withMiddlewareSpan,
  withPagesApiHandlerSpan,
  withPagesDataSpan,
  withComponentTreeSpan,
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

  const released = productionRelease(config)
  const hasProxy = Boolean(released ? released.proxy.file : findProxyFile(config))
  const beforeProxy = getRequestExtensions().beforeProxy
  setRequestExtensions({
    beforeProxy: async request => {
      if (beforeProxy) await beforeProxy(request)
      if (!hasProxy) return
      const url = new URL(request.url)
      startRootSpan({
        method: request.method,
        target: url.pathname + url.search,
        rsc: request.headers.get('rsc') === '1',
        headers: request.headers,
        middleware: true,
      })
      forwardRootTraceHeaders(request.headers)
      queueAfterTask(() => endRootSpanIfUnclosed(500))
    },
  })

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
      // Close abandoned requests when their work unit drains.
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

/** The route stamped on this request's root span, kept so later stages never re-match it. */
const STAMPED = Symbol('pnext.otel.stampedRoute')
interface StampedRoute {
  pathname: string
  route: RouteManifestEntry
}
function stampedRoute(): StampedRoute | undefined {
  return getWorkUnit()?.compat?.[STAMPED] as StampedRoute | undefined
}

/** Resolve the matched route for `pathname` and stamp it on the root span (a no-op when unchanged). */
function stampMatchedRoute(pathname: string): void {
  const runtime = getRequestRuntime()
  const unit = getWorkUnit()
  if (!runtime || !unit || stampedRoute()?.pathname === pathname) return
  const matched = selectRouteForRequest(runtime.routes, pathname, undefined)
  if (!matched) return
  ;(unit.compat ??= {})[STAMPED] = { pathname, route: matched.route } satisfies StampedRoute
  const routeRuntime = matched.route.segmentConfig?.runtime
  setRootSpanRoute(routeEntryToDisplay(matched.route), {
    edge: routeRuntime === 'edge' || routeRuntime === 'experimental-edge',
    kind: matched.route.kind === 'handler' ? 'handler' : 'page',
    params: matched.params,
  })
}

// Next's router boundaries contribute loads outside authored client modules.
const NEXT_APP_ROUTER_CLIENT_MODULES = 7

function clientComponentLoadCount(route: RouteManifestEntry | undefined): number {
  if (!route) return NEXT_APP_ROUTER_CLIENT_MODULES
  return NEXT_APP_ROUTER_CLIENT_MODULES + (route.stream?.hasLoadingBoundary ? 1 : 0)
}

export function registerOtelExtensions(config: ResolvedConfig): void {
  if (!nextCompatEnabled(config)) return
  const loadedUserland = new Set<string>()
  const moduleSpanAttributes = { 'next.span_category': 'nextjs' }

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
    onClientModuleLoad: beginClientModuleLoad,
    onClientComponent: recordClientComponent,
    withRenderBodySpan: (route, fn) => {
      const displayRoute = routePatternToDisplay(route)
      if (!isPagesCompatRoute(route)) {
        emitLeafSpan('prepare route module', SPAN_TYPE.prepareRouteModule, moduleSpanAttributes)
      }
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
        () =>
          withChildSpan(
            'load route module',
            SPAN_TYPE.loadRouteModule,
            moduleSpanAttributes,
            () => {
              if (entry?.kind !== 'handler' || loadedUserland.has(entry.file)) return fn()
              loadedUserland.add(entry.file)
              return withChildSpan(
                'load app route module',
                SPAN_TYPE.loadUserland,
                { ...moduleSpanAttributes, 'next.route': displayRoute },
                fn,
              )
            },
          ),
      )
    },
    withComponentTreeSpan: fn => withComponentTreeSpan(fn),
    withGenerateMetadataSpan: (name, attributes, fn) =>
      withChildSpan(name, SPAN_TYPE.generateMetadata, attributes, fn),
    withRootSpanContext: fn => {
      const root = rootOtelContext()
      return root ? root.api.context.with(root.context, fn) : fn()
    },
    withPagesApiSpan: withPagesApiHandlerSpan,
    emitResolveSegmentSpan: (segment, file) => {
      if (!rootOtelContext()) return
      // pnext's own root layouts (synthesized, or the hybrid app's PagesLayout) are no Next segment.
      if (file && (!conventionFileExists(file) || isGeneratedPagesLayout(file))) return
      emitLeafSpan('resolve segment modules', SPAN_TYPE.getLayoutOrPageModule, {
        'next.segment': segment,
      })
    },
    withRouteHandlerSpan: (route, fn) => {
      if (isPagesCompatRoute(route))
        return withPagesApiHandlerSpan(routePatternToDisplay(route), fn)
      emitLeafSpan('prepare route module', SPAN_TYPE.prepareRouteModule, moduleSpanAttributes)
      return withRouteHandlerSpan(routePatternToDisplay(route), fn)
    },
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

  // Middleware and render requests share the middleware-invoke parent.
  setProxyRunObserver((request, fn) =>
    withMiddlewareSpan(
      request,
      fn,
      result =>
        result == null || (result instanceof Response && nextResponseMeta(result) !== undefined),
    ),
  )

  const previousOnRequestError = getRequestExtensions().onRequestError
  setRequestExtensions({
    onRequestError: async (error, requestInfo, context) => {
      markRenderSpanError(error)
      markHandlerSpanError(error)
      // A render error only fails the request span through its 5xx status: a streamed error keeps 200.
      if (context.routeKind !== 'html') markRootSpanError(error)
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

  // Record response facts now; loading metrics and the request span finish after the body.
  const otelFinalizer: ResponseFinalizer = ctx => {
    try {
      if (
        ctx.routeKind === 'html' &&
        !ctx.request.headers.has('next-action') &&
        ctx.request.headers.get('rsc') !== '1'
      ) {
        const route = stampedRoute()?.route
        // Next's pages router reports no client component loading; a 5xx error document loads 3 more.
        if (!route || !isPagesCompatRoute(route.route))
          queueClientComponentLoadingSpan(
            clientComponentLoadCount(route) + (ctx.status >= 500 ? 3 : 0),
          )
      }
      if (ctx.routeKind === 'html' && ctx.status >= 500) emitErrorDocumentMetadataSpans()
      if (ctx.routeKind === 'html' || ctx.routeKind === 'route-handler') {
        emitStartResponseSpan()
      }
      recordResponseStatus(ctx.status)
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
  const config = getRequestRuntime()?.config
  if (!entry || !config) return false
  let cached = pagesCompatFileCache.get(entry.file)
  if (cached === undefined) {
    cached = isMaterializedPagesRoute(config, entry.file)
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
