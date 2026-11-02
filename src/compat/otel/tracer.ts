// OpenTelemetry span emission (COMPAT).
//
// Next's span taxonomy (~12 span types with exact next.span_type / next.span_name / attribute shapes).
// The root `BaseServer.handleRequest` span is opened in a request interceptor, its OTel Context stashed
// on the request WorkUnit, and closed in a responseFinalizer once the status is known. Child spans
// re-enter the stashed root context so they nest under the root - pnext threads parenting through its
// OWN work-unit ALS rather than relying on the app's ContextManager spanning our async boundaries.
//
// Everything is inert unless @opentelemetry/api resolves from the app AND a work unit is active.

import { getWorkUnit, queueAfterTask, type WorkUnit } from '../../request/context'
import { edgeSandbox, getOtelApi, type OtelApi, type OtelContext, type OtelSpan } from './api'

// next.span_type taxonomy (exact strings Next emits; asserted verbatim).
export const SPAN_TYPE = {
  handleRequest: 'BaseServer.handleRequest',
  getBodyResult: 'AppRender.getBodyResult',
  fetch: 'AppRender.fetch',
  runHandler: 'AppRouteRouteHandlers.runHandler',
  generateMetadata: 'ResolveMetadata.generateMetadata',
  createComponentTree: 'NextNodeServer.createComponentTree',
  getLayoutOrPageModule: 'NextNodeServer.getLayoutOrPageModule',
  findPageComponents: 'NextNodeServer.findPageComponents',
  startResponse: 'NextNodeServer.startResponse',
  clientComponentLoading: 'NextNodeServer.clientComponentLoading',
  middleware: 'Middleware.execute',
  prepareRouteModule: 'RouteModule.prepare',
  loadRouteModule: 'LoadComponents.loadRouteModule',
  loadUserland: 'AppRouteRouteModule.loadUserland',
  getRequestHandler: 'NextServer.getRequestHandler',
  nodeRunHandler: 'Node.runHandler',
  renderDocument: 'Render.renderDocument',
  getServerSideProps: 'Render.getServerSideProps',
  getStaticProps: 'Render.getStaticProps',
} as const

// The runtime label the app's exporter reads at export time. Next's test exporter serializes
// `process.env.NEXT_RUNTIME` per span; for a route declared `runtime: 'edge'` Next runs the render in
// the edge sandbox, so its spans say 'edge' while node-server-side spans stay 'nodejs'. pnext runs
// everything in one Bun process, so the tracer mirrors the per-span runtime split by setting
// NEXT_RUNTIME around each span.end() - SimpleSpanProcessor exports synchronously inside end().
type SpanRuntime = 'edge' | 'nodejs'

// Span types Next emits from INSIDE the edge sandbox when the route is edge.
const EDGE_SANDBOX_SPAN_TYPES: ReadonlySet<string> = new Set([
  SPAN_TYPE.getBodyResult,
  SPAN_TYPE.createComponentTree,
  SPAN_TYPE.getLayoutOrPageModule,
  SPAN_TYPE.generateMetadata,
  SPAN_TYPE.fetch,
  SPAN_TYPE.renderDocument,
  SPAN_TYPE.getServerSideProps,
  SPAN_TYPE.getStaticProps,
])

// Per-WorkUnit otel state (stashed on the compat scratch map).
const OTEL_STATE = Symbol.for('pnext.compat.otel.state')
const CLIENT_LOADS = Symbol.for('pnext.compat.otel.clientLoads')

interface ClientLoads {
  used: Set<string>
  start?: number
  end?: number
  duration: number
  pending: number
  report?: () => void
  sealed?: boolean
  queued?: boolean
}

interface OtelState {
  api: OtelApi
  /** Context with the root span active — children re-enter this to nest. */
  rootContext: OtelContext
  /** The root BaseServer.handleRequest span (closed by the finalizer). */
  rootSpan: OtelSpan
  /** Guard so the root span is ended exactly once. */
  rootEnded: boolean
  responseStatus?: number
  rootErrored?: boolean
  middlewareRequest?: boolean
  middlewareInvoked?: boolean
  traceparent?: string | null
  /** The middleware-invoke request's state, whose root span parents this render pass. */
  bubble?: OtelState
  /** Request method, kept for the pattern-rename span name. */
  method: string
  /** Whether this was an RSC request, kept for the pattern-rename span name. */
  rsc: boolean
  /** The raw request target (`pathname + search`) the root span opened with. */
  target: string
  /**
   * The extracted INCOMING context (traceparent applied, no pnext span active). Top-level spans parent
   * here, mirroring Next's spans that sit beside - not under - handleRequest.
   */
  incomingContext: OtelContext
  /**
   * Edge emulation mode for the matched route. 'page': the whole render tree
   * exports as runtime 'edge' with the params-query target (Next renders edge
   * pages inside the sandbox). 'handler': only the runHandler span is 'edge'
   * and it parents on the incoming context (Next's node server keeps its own
   * nodejs spans; the sandbox emits a stand-alone runHandler).
   */
  edgeMode?: 'page' | 'handler'
  /** NEXT_OTEL_VERBOSE=1 wrapper span (NextServer.getRequestHandler). */
  verboseSpan?: OtelSpan
  /**
   * The context a NEW child span parents under. Starts as rootContext; each
   * withChildSpan pushes its own child context for the duration of `fn` so a
   * nested withChildSpan (e.g. `resolve segment modules` inside `build component
   * tree`) nests under its lexical parent, not the root. Restored on settle.
   */
  currentContext: OtelContext
  /** The stamped display route pattern (`/pages/[param]/getServerSideProps`). */
  route?: string
  /**
   * A pages-router data fetcher errored or returned notFound and the fallback span set replaced the
   * render span. Post-fallback render-internal leaves must not surface as root children - Next does not
   * emit them there.
   */
  pagesFallback?: boolean
  /** A materialized pages-API handler ran (suppresses the start-response leaf). */
  pagesApi?: boolean
  renderSpan?: {
    span: OtelSpan
    parentContext: OtelContext
    spanContext: OtelContext
    ended: boolean
    /** markRenderSpanError already set an ERROR status; finish must keep it. */
    errored?: boolean
    /** `next.span_type` the span opened with (runtime label at end). */
    spanType: string
    /**
     * Pages-router notFound/error fallback: Next replaces the route's render
     * span with the fallback page's own spans (`/_error`, `/_not-found`). A
     * discarded span is NEVER ended, so SimpleSpanProcessor never exports it
     * (its children become orphans the suite's tree-builder filters out).
     */
    discarded?: boolean
  }
  componentTreeSpan?: {
    span: OtelSpan
    parentContext: OtelContext
    spanContext: OtelContext
    ended: boolean
  }
  handlerSpan?: {
    span: OtelSpan
    spanType: string
    edge: boolean
    errored: boolean
  }
  /** A route handler threw: Next never reaches `start response` on that path. */
  handlerErrored?: boolean
  /** Layout `generateMetadata` spans of this render, replayed when the error document renders. */
  layoutMetadata?: { name: string; attributes: Record<string, unknown> }[]
}

/** The runtime label for a child span of the given next.span_type. */
function childRuntime(state: OtelState, spanType: string): SpanRuntime {
  return state.edgeMode === 'page' && EDGE_SANDBOX_SPAN_TYPES.has(spanType) ? 'edge' : 'nodejs'
}

let cachedAppRoot: string | undefined
let spanEndDepth = 0

/** Called once at init so the tracer can resolve @opentelemetry/api from the app. */
export function setOtelAppRoot(root: string): void {
  cachedAppRoot = root
}

function api(): OtelApi | null {
  return cachedAppRoot ? getOtelApi(cachedAppRoot) : null
}

function stateOf(unit: WorkUnit | undefined): OtelState | undefined {
  return unit?.compat?.[OTEL_STATE] as OtelState | undefined
}

/**
 * Open the root `BaseServer.handleRequest` span for the active request and stash
 * it (+ its active context) on the work unit. Extracts an incoming `traceparent`
 * so the root span inherits the caller's trace/parent. No-op when otel-api is
 * unavailable, no work unit is active, or a root is already open.
 */
export function startRootSpan(input: {
  method: string
  target: string
  rsc: boolean
  headers: Headers
  middleware?: boolean
}): void {
  const a = api()
  if (!a) return
  const unit = getWorkUnit()
  if (!unit) return
  unit.compat ??= {}
  const previous = stateOf(unit)
  if (previous && (!previous.middlewareRequest || previous.bubble || input.middleware)) return
  if (previous && !previous.middlewareInvoked) return

  // Extract incoming context (traceparent + any custom propagators, e.g. the
  // test's x-custom sampler entry). The carrier is a plain header record.
  const carrier: Record<string, string> = {}
  input.headers.forEach((value, key) => {
    carrier[key] = value
  })
  const overridden = previous && input.headers.get('traceparent') !== previous.traceparent
  const incomingContext = overridden
    ? a.propagation.extract(a.ROOT_CONTEXT, carrier, headerGetter)
    : (previous?.incomingContext ??
      a.propagation.extract(a.context.active(), carrier, headerGetter))

  const spanName = input.method
  const tracer = a.trace.getTracer('next.js', '0.0.1')
  // NEXT_OTEL_VERBOSE=1: Next additionally emits the NextServer.getRequestHandler
  // wrapper span between the incoming context and handleRequest. The verbose
  // suite asserts its span_type + that it parents directly on the incoming
  // traceparent while everything else nests below.
  let verboseSpan: OtelSpan | undefined = previous?.verboseSpan
  let rootParentCtx = previous && !overridden ? previous.rootContext : incomingContext
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  if (!previous && process.env.NEXT_OTEL_VERBOSE === '1') {
    verboseSpan = tracer.startSpan(
      SPAN_TYPE.getRequestHandler,
      {
        kind: a.SpanKind.INTERNAL,
        attributes: {
          'next.span_name': SPAN_TYPE.getRequestHandler,
          'next.span_type': SPAN_TYPE.getRequestHandler,
        },
      },
      incomingContext,
    )
    rootParentCtx = a.trace.setSpan(incomingContext, verboseSpan)
  }
  const rootSpan = tracer.startSpan(
    spanName,
    {
      kind: a.SpanKind.SERVER,
      attributes: {
        'http.method': input.method,
        'http.target': previous?.target ?? input.target,
        'next.rsc': input.rsc,
        'next.span_name': spanName,
        'next.span_type': SPAN_TYPE.handleRequest,
      },
    },
    rootParentCtx,
  )
  const rootContext = a.trace.setSpan(rootParentCtx, rootSpan)
  const state: OtelState = {
    api: a,
    rootContext,
    rootSpan,
    rootEnded: false,
    method: input.method,
    rsc: input.rsc,
    target: previous?.target ?? input.target,
    incomingContext,
    traceparent: input.headers.get('traceparent'),
    ...(verboseSpan ? { verboseSpan } : {}),
    currentContext: rootContext,
    ...(input.middleware || previous?.middlewareRequest ? { middlewareRequest: true } : {}),
    ...(previous ? { bubble: previous } : {}),
  }
  unit.compat[OTEL_STATE] = state
}

/**
 * Set the route name on the root span once the route is matched. `next.route` /
 * `http.route` are the route PATTERN (`/app/[param]/rsc-fetch`); the span name is
 * `[RSC ]<METHOD> <route>` (Next renames from the raw target to the pattern).
 */
export function setRootSpanRoute(
  route: string,
  options: {
    /** The matched route declared `runtime: 'edge'`. */
    edge?: boolean
    /** 'handler' for a route handler, 'page' otherwise. */
    kind?: 'page' | 'handler'
    /** Resolved dynamic params (edge target emulation). */
    params?: Record<string, string | string[]>
  } = {},
): void {
  const state = stateOf(getWorkUnit())
  if (!state) return
  state.route = route
  const { rootSpan } = state
  if (!options.edge) return
  state.edgeMode = options.kind === 'handler' ? 'handler' : 'page'
  if (state.edgeMode !== 'page') return
  // A production start invokes an edge page through the sandbox with the resolved dynamic params
  // appended as query params, so the sandbox-side handleRequest span reports them in its route. Mirror
  // that. Always rebuilt from the ORIGINAL request target - the route is stamped twice (early
  // pre-rewrite and late post-rewrite interceptors) and the params must not accumulate.
  const [pathname = '', search = ''] = splitTarget(state.target)
  const query = new URLSearchParams(search)
  for (const [key, value] of Object.entries(options.params ?? {})) {
    if (Array.isArray(value)) query.set(key, value.join('/'))
    else query.set(key, value)
  }
  const queryText = query.toString()
  if (queryText) {
    rootSpan.setAttribute('http.target', `${pathname}?${queryText}`)
  }
}

function splitTarget(target: string): [string, string] {
  const index = target.indexOf('?')
  return index === -1 ? [target, ''] : [target.slice(0, index), target.slice(index + 1)]
}

/**
 * Close the root span with the final HTTP status. `code:2` (ERROR) + `error.type`
 * for >=500 (synchronous failures); streaming errors keep status 200 and are
 * marked on the render span instead. Idempotent.
 */
export function endRootSpan(status: number): void {
  const state = stateOf(getWorkUnit())
  if (!state || state.rootEnded) return
  state.rootEnded = true
  const { api: a, rootSpan } = state
  const name = `${state.rsc ? 'RSC ' : ''}${state.method}${state.route ? ` ${state.route}` : ''}`
  rootSpan.updateName(name)
  rootSpan.setAttribute('next.span_name', name)
  if (state.route) {
    rootSpan.setAttribute('next.route', state.route)
    rootSpan.setAttribute('http.route', state.route)
  }
  rootSpan.setAttribute('http.status_code', status)
  if (status >= 500) {
    rootSpan.setAttribute('error.type', String(status))
    rootSpan.setStatus({ code: a.SpanStatusCode.ERROR })
  } else if (!state.rootErrored) {
    rootSpan.setStatus({ code: a.SpanStatusCode.UNSET })
  }
  endSpan(rootSpan, state.edgeMode === 'page' ? 'edge' : 'nodejs')
  if (state.bubble) endBubbleSpan(state.bubble, status)
  if (state.verboseSpan) {
    state.verboseSpan.setStatus({ code: a.SpanStatusCode.UNSET })
    endSpan(state.verboseSpan, 'nodejs')
  }
}

/** Close the middleware-invoke span: Next's invoke pass ends with its own status before the render pass. */
function endBubbleSpan(bubble: OtelState, status: number): void {
  if (bubble.rootEnded) return
  bubble.rootEnded = true
  bubble.rootSpan.setAttribute('http.status_code', status)
  bubble.rootSpan.setStatus({
    code: status >= 500 ? bubble.api.SpanStatusCode.ERROR : bubble.api.SpanStatusCode.UNSET,
  })
  endSpan(bubble.rootSpan, 'nodejs')
}

/** Close abandoned requests after their work unit drains. */
export function endRootSpanIfUnclosed(fallbackStatus: number): void {
  const state = stateOf(getWorkUnit())
  if (!state || state.rootEnded) return
  endRootSpan(state.responseStatus ?? fallbackStatus)
}

export function recordResponseStatus(status: number): void {
  const state = stateOf(getWorkUnit())
  if (state) state.responseStatus = status
}

export function markRootSpanError(error: unknown): void {
  const state = stateOf(getWorkUnit())
  if (!state || state.rootEnded) return
  state.rootErrored = true
  markSpanError(state.api, state.rootSpan, error)
}

export function forwardRootTraceHeaders(headers: Headers): void {
  const state = stateOf(getWorkUnit())
  if (!state) return
  const carrier: Record<string, string> = {}
  state.api.propagation.inject(state.rootContext, carrier, carrierSetter)
  if (!carrier.traceparent) return
  headers.set('traceparent', carrier.traceparent)
  if (carrier.tracestate) headers.set('tracestate', carrier.tracestate)
  else headers.delete('tracestate')
  state.traceparent = carrier.traceparent
}

/** The active root span's spanContext. */
export function rootSpanContext(): { traceId: string; spanId: string } | undefined {
  const state = stateOf(getWorkUnit())
  if (!state) return undefined
  const sc = state.rootSpan.spanContext()
  return { traceId: sc.traceId, spanId: sc.spanId }
}

/** The stashed root OTel context (root span active). */
export function rootOtelContext(): { api: OtelApi; context: OtelContext } | undefined {
  const state = stateOf(getWorkUnit())
  if (!state) return undefined
  return { api: state.api, context: state.rootContext }
}

/** The active render context, for client trace propagation. */
export function activeOtelContext(): { api: OtelApi; context: OtelContext } | undefined {
  const state = stateOf(getWorkUnit())
  if (!state) return undefined
  return { api: state.api, context: state.api.context.active() }
}

function runSettled<T>(
  fn: () => T,
  onResult: (value: unknown) => void,
  onError: (error: unknown) => void,
): T {
  try {
    const result = fn()
    if (isThenable(result)) {
      return (result as PromiseLike<unknown>).then(
        value => {
          onResult(value)
          return value
        },
        error => {
          onError(error)
          throw error
        },
      ) as T
    }
    onResult(result)
    return result
  } catch (error) {
    onError(error)
    throw error
  }
}

/**
 * Run `fn` inside a child span nested under the request's root span. The child becomes the active parent
 * for any spans `fn` opens. Returns `fn`'s result. When otel is inert or no root is open, runs `fn`
 * untouched. `onError` lets callers mark render-body (streaming) errors with a message without failing
 * the request.
 */
export function withChildSpan<T>(
  name: string,
  spanType: string,
  attributes: Record<string, unknown>,
  fn: () => T,
  options: { kind?: number; onError?: (span: OtelSpan, error: unknown) => void } = {},
): T {
  const state = stateOf(getWorkUnit())
  if (!state) return fn()
  const { api: a } = state
  // Parent under the lexically-enclosing span (currentContext), not always the
  // root, so nested withChildSpan calls form the right tree.
  const parentContext = state.currentContext
  const tracer = a.trace.getTracer('next.js', '0.0.1')
  const span = tracer.startSpan(
    name,
    {
      kind: options.kind ?? a.SpanKind.INTERNAL,
      attributes: {
        ...attributes,
        'next.span_name': name,
        'next.span_type': spanType,
      },
    },
    parentContext,
  )
  const childContext = a.trace.setSpan(parentContext, span)
  state.currentContext = childContext
  if (
    spanType === SPAN_TYPE.generateMetadata &&
    String(attributes['next.page']).endsWith('/layout')
  )
    (state.layoutMetadata ??= []).push({ name, attributes })
  const settle = (error?: unknown) => {
    // Restore the enclosing context so siblings parent correctly.
    state.currentContext = parentContext
    if (error !== undefined) {
      if (options.onError) options.onError(span, error)
      else {
        span.recordException(error)
        span.setStatus({ code: a.SpanStatusCode.ERROR, message: errorMessage(error) })
      }
    } else {
      span.setStatus({ code: a.SpanStatusCode.UNSET })
    }
    endSpan(span, childRuntime(state, spanType))
  }
  return runSettled(
    () => a.context.with(childContext, fn),
    () => settle(),
    settle,
  )
}

export function withRenderBodySpan<T>(
  name: string,
  route: string,
  fn: () => T,
  spanType: string = SPAN_TYPE.getBodyResult,
): T {
  const state = stateOf(getWorkUnit())
  if (!state) return fn()
  const { api: a } = state
  const parentContext = state.currentContext
  const tracer = a.trace.getTracer('next.js', '0.0.1')
  const span = tracer.startSpan(
    name,
    {
      kind: a.SpanKind.INTERNAL,
      attributes: {
        'next.route': route,
        'next.span_name': name,
        'next.span_type': spanType,
      },
    },
    parentContext,
  )
  const spanContext = a.trace.setSpan(parentContext, span)
  const previousRenderSpan = state.renderSpan
  state.renderSpan = { span, parentContext, spanContext, ended: false, spanType }
  state.currentContext = spanContext

  const finish = (error?: unknown) => {
    const current = state.renderSpan
    if (current?.span !== span || current.ended) return
    current.ended = true
    endComponentTreeSpan(state)
    if (current.discarded) {
      // Pages fallback replaced this span — leave it un-ended (never exported).
      state.renderSpan = previousRenderSpan
      if (state.currentContext === spanContext) state.currentContext = parentContext
      return
    }
    if (error !== undefined) markSpanError(a, span, error)
    // A streaming (Suspense-boundary) error already stamped ERROR through
    // markRenderSpanError — never downgrade it back to UNSET here.
    else if (!current.errored && span.isRecording()) {
      span.setStatus({ code: a.SpanStatusCode.UNSET })
    }
    endSpan(span, childRuntime(state, spanType))
    state.renderSpan = previousRenderSpan
    if (state.currentContext === spanContext) state.currentContext = parentContext
  }

  const queued = queueAfterTask(() => finish())
  try {
    const result = a.context.with(spanContext, fn)
    if (isThenable(result)) {
      return (result as PromiseLike<unknown>).then(
        value => {
          if (!queued) finish()
          return value
        },
        error => {
          markRenderSpanError(error)
          if (!queued) finish(error)
          throw error
        },
      ) as T
    }
    if (!queued) finish()
    return result
  } catch (error) {
    markRenderSpanError(error)
    if (!queued) finish(error)
    throw error
  }
}

export function markRenderSpanError(error: unknown): void {
  const state = stateOf(getWorkUnit())
  const render = state?.renderSpan
  if (!state || !render || render.ended) return
  render.errored = true
  markSpanError(state.api, render.span, error)
}

/**
 * Mark the active route-handler span when dispatch converts its throw to a 500 response. A NODE
 * pages-api handler span (`Node.runHandler`) is the one exception: Next's node server never sees that
 * throw, so only the request root span reports it while the handler span stays UNSET. The edge sandbox
 * does catch it, so the edge pages-api span records the error like an app handler.
 */
export function markHandlerSpanError(error: unknown): void {
  const state = stateOf(getWorkUnit())
  const handler = state?.handlerSpan
  if (!state || !handler || handler.errored) return
  handler.errored = true
  state.handlerErrored = true
  if (handler.spanType !== SPAN_TYPE.runHandler && !handler.edge) return
  markSpanError(state.api, handler.span, error)
}

/**
 * Run a route-handler invocation inside the `executing api route (app) <route>` span. Nodejs handlers
 * nest under the request root span; edge handlers become a TOP-LEVEL span on the incoming context
 * exported as runtime 'edge' - Next's sandbox emits it stand-alone, since a production start does not
 * thread the node server's span into the sandbox.
 */
export function withRouteHandlerSpan<T>(route: string, fn: () => T): T {
  return runHandlerSpan(
    `executing api route (app) ${route}`,
    SPAN_TYPE.runHandler,
    { 'next.route': route },
    fn,
  )
}

function runHandlerSpan<T>(
  name: string,
  spanType: string,
  attributes: Record<string, unknown>,
  fn: () => T,
): T {
  const state = stateOf(getWorkUnit())
  if (!state) return fn()
  const { api: a } = state
  const edge = state.edgeMode === 'handler'
  const parentContext = edge ? state.incomingContext : state.currentContext
  const tracer = a.trace.getTracer('next.js', '0.0.1')
  const span = tracer.startSpan(
    name,
    {
      kind: a.SpanKind.INTERNAL,
      attributes: {
        ...attributes,
        'next.span_name': name,
        'next.span_type': spanType,
      },
    },
    parentContext,
  )
  const spanContext = a.trace.setSpan(parentContext, span)
  const previousContext = state.currentContext
  const previousHandlerSpan = state.handlerSpan
  const handlerSpan = { span, spanType, edge, errored: false }
  state.handlerSpan = handlerSpan
  state.currentContext = spanContext
  const settle = (error?: unknown) => {
    state.currentContext = previousContext
    if (error !== undefined) markHandlerSpanError(error)
    else if (!handlerSpan.errored) {
      span.setStatus({ code: a.SpanStatusCode.UNSET })
    }
    endSpan(span, edge ? 'edge' : 'nodejs')
    if (state.handlerSpan === handlerSpan) state.handlerSpan = previousHandlerSpan
  }
  return runSettled(
    () => a.context.with(spanContext, fn),
    () => settle(),
    settle,
  )
}

/**
 * Run a `pages/api` handler invocation inside the `executing api route (pages) <route>` span (no
 * `next.route` attribute - Next omits it here). Nodejs handlers nest under the request root span; edge
 * handlers become a top-level span on the incoming context, the same split as the app handler. Next's
 * pages-api dispatch emits neither `resolve page components` nor `start response`, so the finalizer's
 * start-response leaf is suppressed for the rest of the request.
 */
export function withPagesApiHandlerSpan<T>(route: string, fn: () => T): T {
  const state = stateOf(getWorkUnit())
  if (state) state.pagesApi = true
  const name = `executing api route (pages) ${route}`
  return runHandlerSpan(name, SPAN_TYPE.nodeRunHandler, {}, fn)
}

/**
 * Run a materialized pages-router data fetcher inside its `Render.<kind>` span. Unlike withChildSpan
 * this parents on the request ROOT span - Next runs data fetching beside, not inside, the document
 * render, so the suite asserts it as a SIBLING of the render span.
 *
 * Fallback emulation on the result: a THROW marks this span ERROR and swaps the open render span for
 * Next's `/_error` render tree; `{ notFound: true }` keeps this span clean (Next reports code 0) and
 * swaps the render span for the `/_not-found` resolution. The route's own render span is DISCARDED in
 * both cases - never ended, never exported - matching Next.
 */
export function withPagesDataSpan<T>(
  kind: 'getServerSideProps' | 'getStaticProps',
  fn: () => T,
): T {
  const state = stateOf(getWorkUnit())
  const route = state?.route
  if (!state || !route) return fn()
  const { api: a } = state
  const spanType =
    kind === 'getServerSideProps' ? SPAN_TYPE.getServerSideProps : SPAN_TYPE.getStaticProps
  const name = `${kind} ${route}`
  const span = a.trace.getTracer('next.js', '0.0.1').startSpan(
    name,
    {
      kind: a.SpanKind.INTERNAL,
      attributes: {
        'next.route': route,
        'next.span_name': name,
        'next.span_type': spanType,
      },
    },
    state.rootContext,
  )
  const settle = (error: unknown, result: unknown) => {
    if (error !== undefined) {
      markSpanError(a, span, error)
      emitPagesErrorFallbackSpans(state, route)
    } else {
      span.setStatus({ code: a.SpanStatusCode.UNSET })
      if ((result as { notFound?: boolean } | null | undefined)?.notFound) {
        emitPagesNotFoundFallbackSpans(state, route)
      }
    }
    endSpan(span, childRuntime(state, spanType))
  }
  return runSettled(
    fn,
    result => settle(undefined, result),
    error => settle(error ?? new Error('getServerSideProps error'), undefined),
  )
}

/** A pre-ended leaf span parented directly on the request root span. */
function emitRootLeafSpan(
  state: OtelState,
  name: string,
  spanType: string,
  attributes: Record<string, unknown>,
  timing?: { startTime: number; endTime: number },
): void {
  const { api: a } = state
  const span = a.trace.getTracer('next.js', '0.0.1').startSpan(
    name,
    {
      kind: a.SpanKind.INTERNAL,
      startTime: timing?.startTime,
      attributes: {
        ...attributes,
        'next.span_name': name,
        'next.span_type': spanType,
      },
    },
    state.rootContext,
  )
  span.setStatus({ code: a.SpanStatusCode.UNSET })
  endSpan(span, 'nodejs', timing?.endTime)
}

/** Discard the route's open render span (see withPagesDataSpan). */
function discardRenderSpan(state: OtelState): void {
  state.pagesFallback = true
  if (state.renderSpan && !state.renderSpan.ended) state.renderSpan.discarded = true
}

// gSSP threw: Next renders `/_error` (its own renderDocument span), resolves
// `/_error`, probes `/500` twice (prod), and the route resolve already fired.
function emitPagesErrorFallbackSpans(state: OtelState, _route: string): void {
  discardRenderSpan(state)
  emitRootLeafSpan(state, 'render route (pages) /_error', SPAN_TYPE.renderDocument, {
    'next.route': '/_error',
  })
  emitRootLeafSpan(state, 'resolve page components', SPAN_TYPE.findPageComponents, {
    'next.route': '/_error',
  })
  for (let i = 0; i < 2; i += 1) {
    emitRootLeafSpan(state, 'resolve page components', SPAN_TYPE.findPageComponents, {
      'next.route': '/500',
    })
  }
}

// gSSP returned { notFound: true }: Next serves the prerendered `/_not-found`
// (prod: a findPageComponents probe only, no render span).
function emitPagesNotFoundFallbackSpans(state: OtelState, _route: string): void {
  discardRenderSpan(state)
  emitRootLeafSpan(state, 'resolve page components', SPAN_TYPE.findPageComponents, {
    'next.route': '/_not-found',
  })
}

/**
 * Leaf `start response` span, which Next emits when the response starts piping. pnext's otel response
 * finalizer calls this right before it closes the root span. Parents under the render span when one is
 * open (page renders), else the root (route handlers). Always exports as runtime 'nodejs', since Next
 * pipes from the node server even for edge routes.
 */
export function emitStartResponseSpan(): void {
  const state = stateOf(getWorkUnit())
  // A handler that threw never starts piping a response in Next; a render that threw still does.
  if (state?.pagesFallback || state?.pagesApi || state?.handlerErrored) return
  if (state?.middlewareInvoked && !state.bubble) return
  emitNodeLeafSpan('start response', SPAN_TYPE.startResponse, {})
}

/** A synchronous page error renders Next's error document, whose layouts run `generateMetadata` again. */
export function emitErrorDocumentMetadataSpans(): void {
  const state = stateOf(getWorkUnit())
  for (const { name, attributes } of state?.layoutMetadata ?? [])
    emitNodeLeafSpan(name, SPAN_TYPE.generateMetadata, attributes)
}

/**
 * Leaf `clientComponentLoading` span with the number of client component modules loaded during the
 * render. pnext SSRs islands only, so the count reflects pnext's own client-module loads - Next's number
 * additionally counts its internal client components, an internals delta not emulated here. Only
 * emitted for page renders, matching Next.
 */
export function emitClientComponentLoadingSpan(count: number): void {
  const state = stateOf(getWorkUnit())
  if (!state?.renderSpan || state.renderSpan.ended) return
  emitRootLeafSpan(state, SPAN_TYPE.clientComponentLoading, SPAN_TYPE.clientComponentLoading, {
    'next.clientComponentLoadCount': count,
  })
}

function clientLoads(): ClientLoads | undefined {
  const unit = getWorkUnit()
  if (!unit) return
  unit.compat ??= {}
  return (unit.compat[CLIENT_LOADS] ??= {
    used: new Set(),
    duration: 0,
    pending: 0,
  }) as ClientLoads
}

export function recordClientComponent(id: string): void {
  const loads = clientLoads()
  if (loads && !loads.sealed) loads.used.add(id)
}

export function beginClientModuleLoad(): (() => void) | undefined {
  const loads = clientLoads()
  if (!loads || loads.sealed) return
  const start = performance.now()
  loads.start ??= start
  loads.pending++
  return () => {
    loads.end = performance.now()
    loads.duration += loads.end - start
    loads.pending--
    if (loads.pending === 0) loads.report?.()
  }
}

export function queueClientComponentLoadingSpan(baseCount: number): void {
  const state = stateOf(getWorkUnit())
  const emitSpan = Boolean(state?.renderSpan)
  const loads = clientLoads()
  if (!loads || loads.queued) return
  loads.queued = true
  queueAfterTask(() => {
    loads.sealed = true
    const report = () => {
      loads.report = undefined
      if (state && emitSpan) {
        emitRootLeafSpan(
          state,
          SPAN_TYPE.clientComponentLoading,
          SPAN_TYPE.clientComponentLoading,
          { 'next.clientComponentLoadCount': baseCount + loads.used.size },
          loads.start !== undefined && loads.end !== undefined
            ? {
                startTime: performance.timeOrigin + loads.start,
                endTime: performance.timeOrigin + loads.end,
              }
            : undefined,
        )
      }
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      const prefix = process.env.NEXT_OTEL_PERFORMANCE_PREFIX
      if (prefix && loads.start !== undefined)
        performance.measure(`${prefix}:next-client-component-loading`, {
          start: loads.start,
          end: loads.start + loads.duration,
        })
    }
    if (loads.pending === 0) report()
    else loads.report = report
  })
}

function emitNodeLeafSpan(
  name: string,
  spanType: string,
  attributes: Record<string, unknown>,
): void {
  const state = stateOf(getWorkUnit())
  if (!state) return
  const { api: a } = state
  const render = state.renderSpan
  const parentContext = render && !render.ended ? render.spanContext : state.rootContext
  const span = a.trace.getTracer('next.js', '0.0.1').startSpan(
    name,
    {
      kind: a.SpanKind.INTERNAL,
      attributes: {
        ...attributes,
        'next.span_name': name,
        'next.span_type': spanType,
      },
    },
    parentContext,
  )
  span.setStatus({ code: a.SpanStatusCode.UNSET })
  endSpan(span, 'nodejs')
}

/** Run middleware under the middleware-invoke span, or the incoming context without one. */
export function withMiddlewareSpan<T>(
  request: Request,
  fn: () => T,
  continues: (result: unknown) => boolean,
): T {
  // The proxy runner already entered the middleware's declared runtime (edge for `middleware.*`,
  // node for `proxy.*` / `config.runtime = 'nodejs'`); Next exports the span with that same label.
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const runtime: SpanRuntime = process.env.NEXT_RUNTIME === 'nodejs' ? 'nodejs' : 'edge'
  const sandbox = runtime === 'edge' ? edgeSandbox.otel : undefined
  const a = sandbox ?? api()
  if (!a) return fn()
  const method = request.method.toUpperCase()
  let target = ''
  try {
    const url = new URL(request.url)
    target = url.pathname + url.search
  } catch {
    target = request.url
  }
  const carrier: Record<string, string> = {}
  request.headers.forEach((value, key) => {
    carrier[key] = value
  })
  const state = stateOf(getWorkUnit())
  if (state?.middlewareRequest) {
    state.middlewareInvoked = true
    state.rootSpan.setAttribute('next.bubble', true)
  }
  const parentCtx =
    state?.middlewareRequest && !sandbox
      ? state.rootContext
      : a.propagation.extract(sandbox ? a.ROOT_CONTEXT : a.context.active(), carrier, headerGetter)
  const name = `middleware ${method}`
  const tracer = a.trace.getTracer('next.js', '0.0.1')
  const span = tracer.startSpan(
    name,
    {
      attributes: {
        'http.method': method,
        'http.target': target,
        'next.span_name': name,
        'next.span_type': SPAN_TYPE.middleware,
      },
    },
    parentCtx,
  )
  const spanCtx = a.trace.setSpan(parentCtx, span)
  const settle = (error?: unknown) => {
    if (error !== undefined) {
      span.recordException(error)
      span.setStatus({ code: a.SpanStatusCode.ERROR, message: errorMessage(error) })
    } else {
      span.setStatus({ code: a.SpanStatusCode.UNSET })
    }
    // Tagged explicitly so the exported runtime is deterministic regardless of settle timing.
    endSpan(span, runtime)
  }
  return runSettled(
    () => a.context.with(spanCtx, fn),
    result => {
      settle()
      // The invoke pass answers 200 when the middleware lets the request continue; the render pass follows.
      if (state?.middlewareRequest && continues(result)) endBubbleSpan(state, 200)
    },
    settle,
  )
}

// A leaf span with no work inside (e.g. resolve-segment-modules markers).
export function emitLeafSpan(
  name: string,
  spanType: string,
  attributes: Record<string, unknown>,
  kind?: number,
): void {
  if (spanType === SPAN_TYPE.getLayoutOrPageModule) {
    emitSegmentSpan(name, spanType, attributes, kind)
    return
  }
  withChildSpan(name, spanType, attributes, () => undefined, kind !== undefined ? { kind } : {})
}

function emitSegmentSpan(
  name: string,
  spanType: string,
  attributes: Record<string, unknown>,
  kind?: number,
): void {
  const state = stateOf(getWorkUnit())
  if (state?.pagesFallback) return
  if (!state?.renderSpan || state.renderSpan.ended) {
    withChildSpan(name, spanType, attributes, () => undefined, kind !== undefined ? { kind } : {})
    return
  }
  const tree = ensureComponentTreeSpan(state)
  const previous = state.currentContext
  state.currentContext = tree.spanContext
  try {
    withChildSpan(name, spanType, attributes, () => undefined, kind !== undefined ? { kind } : {})
  } finally {
    state.currentContext = previous
  }
}

function ensureComponentTreeSpan(state: OtelState) {
  const current = state.componentTreeSpan
  if (current && !current.ended) return current
  const { api: a } = state
  const parentContext = state.renderSpan?.spanContext ?? state.currentContext
  const name = 'build component tree'
  const span = a.trace.getTracer('next.js', '0.0.1').startSpan(
    name,
    {
      kind: a.SpanKind.INTERNAL,
      attributes: {
        'next.span_name': name,
        'next.span_type': SPAN_TYPE.createComponentTree,
      },
    },
    parentContext,
  )
  const spanContext = a.trace.setSpan(parentContext, span)
  const next = { span, parentContext, spanContext, ended: false }
  state.componentTreeSpan = next
  return next
}

/**
 * Bound Next's `build component tree` span to component-tree construction. The span is only a PARENT
 * for the `resolve segment modules` leaves (emitSegmentSpan re-targets into it); everything else the
 * construction awaits - generateMetadata, fetch - stays a SIBLING under the render span, matching Next.
 * So the enclosing context is deliberately left untouched.
 */
export function withComponentTreeSpan<T>(fn: () => T): T {
  const state = stateOf(getWorkUnit())
  if (!state) return fn()
  const previous = state.componentTreeSpan
  const tree = ensureComponentTreeSpan(state)
  const finish = () => {
    if (previous !== tree) endComponentTreeSpan(state)
  }
  try {
    const result = fn()
    if (isThenable(result)) {
      return (result as PromiseLike<unknown>).then(
        value => {
          finish()
          return value
        },
        error => {
          finish()
          throw error
        },
      ) as T
    }
    finish()
    return result
  } catch (error) {
    finish()
    throw error
  }
}

function endComponentTreeSpan(state: OtelState): void {
  const tree = state.componentTreeSpan
  if (!tree || tree.ended) return
  tree.ended = true
  tree.span.setStatus({ code: state.api.SpanStatusCode.UNSET })
  endSpan(tree.span, childRuntime(state, SPAN_TYPE.createComponentTree))
  if (state.currentContext === tree.spanContext) state.currentContext = tree.parentContext
}

const headerGetter = {
  keys(carrier: Record<string, string>): string[] {
    return Object.keys(carrier)
  },
  get(carrier: Record<string, string>, key: string): string | undefined {
    return carrier[key.toLowerCase()] ?? carrier[key]
  },
}

/** Setter for propagation.inject into a plain record carrier. */
export const carrierSetter = {
  set(carrier: Record<string, string>, key: string, value: string): void {
    carrier[key] = value
  },
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function markSpanError(api: OtelApi, span: OtelSpan, error: unknown): void {
  span.setAttribute('error.type', error instanceof Error ? error.name : typeof error)
  span.recordException(error)
  span.setStatus({ code: api.SpanStatusCode.ERROR, message: errorMessage(error) })
}

export function otelExportInProgress(): boolean {
  return spanEndDepth > 0
}

function endSpan(span: OtelSpan, runtime?: SpanRuntime, endTime?: number): void {
  spanEndDepth++
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const previousRuntime = process.env.NEXT_RUNTIME
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  if (runtime) process.env.NEXT_RUNTIME = runtime
  try {
    span.end(endTime)
  } finally {
    if (runtime) {
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      if (previousRuntime === undefined) delete process.env.NEXT_RUNTIME
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      else process.env.NEXT_RUNTIME = previousRuntime
    }
    spanEndDepth--
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function'
}
