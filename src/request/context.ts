import { AsyncLocalStorage } from 'node:async_hooks'
import {
  cacheComponents,
  hangingPromise,
  isPrerendering,
  isRuntimePrefetchPrerender,
  markRuntimeApiOnAwait,
  PostponeError,
} from '../render/ppr'
import type { NextRequest, RouteParamValue } from '../types'

// Request work-unit store (CORE seam for compat after()/onRequestError).
//
// A single request-scoped AsyncLocalStorage spanning the WHOLE response lifecycle (matching,
// render/handler, streaming, close). Distinct from the render-scoped requestStorage below, created per
// render/handler run: the work unit is created once per request in the start/dev handlers and its
// after-queue is flushed exactly once when the response fully closes - on every path (stream end, redirect,
// notFound, thrown error, client abort). Flushing runs detached so it never blocks or delays the response.
//
// Compat builds after(), onRequestError classification, cookie-mutation phase rules and testmode fetch
// proxying on top of these accessors. Core only owns the store and the flush.

/** The lifecycle phase the request is currently executing in. */
export type WorkUnitPhase = 'render' | 'action' | 'handler' | 'middleware' | 'after'

/** How the matched route is being served — set by the responding call site. */
export type WorkUnitRouteKind = 'html' | 'data' | 'static-asset' | 'route-handler'

/** Per-request work unit carrying phase + the after-task queue. */
export interface WorkUnit {
  phase: WorkUnitPhase
  /** Tasks queued via queueAfterTask, drained once on response close. */
  afterTasks: (() => unknown)[]
  /** Guard so the after-queue flushes exactly once across all close paths. */
  flushed: boolean
  /** How the response is being produced (set by the responding call site). */
  routeKind?: WorkUnitRouteKind
  /** Caching disposition of the matched route, when known. */
  routeMode?: 'static' | 'isr' | 'dynamic'
  /** Opaque hints for response finalizers. */
  responseHints?: Record<string, unknown>
  /**
   * Opaque compat scratch space keyed by well-known symbols (testmode proxy
   * info, onRequestError dedupe flag). Core never reads these; it only carries
   * the store across the request lifecycle. Kept off the typed surface so core
   * grows no dependency on compat.
   */
  compat?: Record<symbol, unknown>
}

// Anchored on globalThis (like requestStorage below) so compiled compat
// bundles that inline their own copy of this module still observe the same
// per-request work unit — canonical-URL recording happens in core while its
// readers (pages-router SSR state, navigation hooks) run from built bundles.
const WORK_UNIT_STORAGE = Symbol.for('pnext.workUnitStorage')
const workUnitStorage = ((globalThis as Record<PropertyKey, unknown>)[WORK_UNIT_STORAGE] ??=
  new AsyncLocalStorage<WorkUnit>()) as AsyncLocalStorage<WorkUnit>

/** Run `callback` inside a fresh request work unit (start/dev per-request scope). */
export function runWithWorkUnit<T>(phase: WorkUnitPhase, callback: () => T): T {
  const unit: WorkUnit = { phase, afterTasks: [], flushed: false }
  return workUnitStorage.run(unit, callback)
}

/** The active request work unit, or undefined outside a request scope. */
export function getWorkUnit(): WorkUnit | undefined {
  return workUnitStorage.getStore()
}

/** Set the current work-unit phase (compat toggles render/action/handler/...). */
export function setPhase(phase: WorkUnitPhase): void {
  const unit = workUnitStorage.getStore()
  if (unit) unit.phase = phase
}

/** Record how the current request is being served (drives finalizers + funnel). */
export function setWorkUnitRoute(
  routeKind: WorkUnitRouteKind,
  routeMode?: WorkUnit['routeMode'],
  responseHints?: Record<string, unknown>,
): void {
  const unit = workUnitStorage.getStore()
  if (!unit) return
  unit.routeKind = routeKind
  if (routeMode) unit.routeMode = routeMode
  if (responseHints) unit.responseHints = responseHints
}

/**
 * Queue a task to run after the response fully closes. Returns false when no
 * work unit is active. Compat's after() delegates here; core never enqueues.
 */
export function queueAfterTask(task: () => unknown): boolean {
  const unit = workUnitStorage.getStore()
  if (!unit) return false
  unit.afterTasks.push(task)
  return true
}

/**
 * Drain the active work unit's after-queue exactly once. Detached (awaited only
 * internally) so it never blocks the response; runs inside the work unit so
 * queued tasks can enqueue further tasks (nested after()). Idempotent across the
 * multiple close paths (stream end / redirect / abort / error).
 */
export function flushWorkUnit(unit: WorkUnit | undefined = workUnitStorage.getStore()): void {
  if (!unit || unit.flushed) return
  unit.flushed = true
  if (unit.afterTasks.length === 0) return
  // Drain under a SHALLOW COPY carrying `phase: 'after'` rather than mutating
  // the shared unit. The flush is detached and async, so setting `phase` on the
  // unit itself leaked: every later render seen under that unit (the build/PPR
  // work unit is long-lived, not per-request) then tripped
  // `assertRequestApiAllowedInAfter` and 500'd with "used connection() inside
  // after()". Every other field stays shared by reference; only the phase and
  // the queue diverge, and nested after() enqueues onto the copy's queue via
  // the store, which is exactly what this loop drains.
  const afterUnit: WorkUnit = { ...unit, phase: 'after' }
  const flushing = workUnitStorage.run(afterUnit, async () => {
    while (afterUnit.afterTasks.length) {
      const tasks = afterUnit.afterTasks
      afterUnit.afterTasks = []
      for (const task of tasks) {
        try {
          await task()
        } catch (error) {
          console.error('after() task failed:', error)
        }
      }
    }
  })
  pendingFlushes.add(flushing)
  void flushing.finally(() => pendingFlushes.delete(flushing))
}

const pendingFlushes = new Set<Promise<void>>()

/**
 * Await all in-flight after-queue flushes (graceful shutdown). Bounded by
 * timeoutMs so a hung after() task can't block process exit.
 */
export async function drainWorkUnits(timeoutMs = 10_000): Promise<void> {
  if (pendingFlushes.size === 0) return
  await Promise.race([
    Promise.allSettled([...pendingFlushes]),
    new Promise(resolve => setTimeout(resolve, timeoutMs)),
  ])
}

/**
 * Flush the given work unit's after-queue once the response has fully closed - when its body stream ends (or
 * immediately for a bodyless response) and when the client aborts mid-stream. The flush is detached, never
 * awaited on the response path, so it cannot delay TTFB or stream completion. Returns a response whose body
 * is observed for close; bodyless responses flush immediately.
 */
export function flushWorkUnitOnClose(
  response: Response,
  unit: WorkUnit | undefined,
  signal?: AbortSignal,
): Response {
  if (!unit) return response
  if (!response.body) {
    flushWorkUnit(unit)
    return response
  }
  // An explicit Content-Length means the body is fully buffered upstream (image
  // optimizer, static files) — nothing can enqueue after-tasks while it drains.
  // Re-wrapping it in a close-observing stream would switch the transfer to
  // chunked and drop the Content-Length header; flush immediately instead.
  if (response.headers.has('content-length')) {
    flushWorkUnit(unit)
    return response
  }
  const reader = response.body.getReader()
  const settle = () => {
    signal?.removeEventListener('abort', settle)
    flushWorkUnit(unit)
  }
  if (signal?.aborted) settle()
  else signal?.addEventListener('abort', settle, { once: true })
  // Bun cancels a response body when its client disconnects. A TransformStream
  // observes normal EOF through flush(), but cancellation bypasses flush and
  // only propagates upstream. Own the outer stream so both terminal paths
  // settle the request work unit, even when Request.signal is not the original
  // socket-owned signal after request rewriting.
  const observed = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read()
        if (chunk.done) {
          settle()
          controller.close()
        } else {
          controller.enqueue(chunk.value)
        }
      } catch (error) {
        settle()
        controller.error(error)
      }
    },
    cancel(reason) {
      settle()
      return reader.cancel(reason)
    },
  })
  return new Response(observed, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

interface RequestScope {
  request: NextRequest
  params: Record<string, RouteParamValue>
  /** Work registered via after() from 'next/server', flushed once the request callback settles. */
  afterCallbacks?: (() => unknown)[]
  /** Optional response-headers channel render/handler paths may provide (e.g. draftMode set-cookie). */
  responseHeaders?: Headers
}

const REQUEST_STORAGE = Symbol.for('pnext.requestStorage')
const requestStorage = ((globalThis as Record<PropertyKey, unknown>)[REQUEST_STORAGE] ??=
  new AsyncLocalStorage<RequestScope>()) as AsyncLocalStorage<RequestScope>

export function currentRequest() {
  return requestStorage.getStore()?.request
}

// Work-unit store bridge for the deep-internal shim
// `next/dist/server/app-render/work-unit-async-storage.external` (compat).
//
// That shim must be genuine CommonJS (apps `require()` it), so it cannot import TypeScript request context;
// it reads this getter off globalThis instead. Published from here rather than from ppr.ts because this
// module is where the request storage is globalThis-anchored, i.e. the copy that observes live request
// scope regardless of which module copy loaded.
//
// The store is NEVER undefined: callers do `getStore().type` during build prerenders as well as live
// requests. `prerender-runtime` mirrors Next's runtime-prefetch work unit; `prerender` covers any other
// prerender scope, including the fallback when no request scope exists.
const WORK_UNIT_EXTERNAL = Symbol.for('pnext.workUnitExternal')

interface WorkUnitExternalStore {
  type: 'request' | 'prerender' | 'prerender-runtime'
  cookies: unknown
  headers: Headers
}

function workUnitExternalStore(): WorkUnitExternalStore {
  const request = currentRequest()
  const type = isRuntimePrefetchPrerender()
    ? 'prerender-runtime'
    : isPrerendering() || !request
      ? 'prerender'
      : 'request'
  return {
    type,
    cookies: request?.cookies,
    headers: request?.headers ?? new Headers(),
  }
}

;(globalThis as Record<PropertyKey, unknown>)[WORK_UNIT_EXTERNAL] = workUnitExternalStore

/**
 * Capture the current request scope (if any) and return a wrapper that re-runs a function inside it.
 * after() uses this so a callback registered during a route handler or server action still sees
 * headers()/cookies()/connection() when it runs later during the work-unit flush, which itself carries no
 * request scope. A callback registered during a page render captures no scope, so its request-API access
 * throws - matching Next's phase semantics.
 */
export function captureRequestScope(): <T>(fn: () => T) => T {
  const scope = requestStorage.getStore()
  if (!scope) return fn => fn()
  return fn => requestStorage.run(scope, fn)
}

export function currentParams() {
  return requestStorage.getStore()?.params ?? {}
}

export function runWithRequest<T>(
  request: NextRequest | undefined,
  callback: () => T,
  params: Record<string, RouteParamValue> = {},
  extras: { responseHeaders?: Headers } = {},
): T {
  if (!request) return callback()
  const scope: RequestScope = {
    request,
    params,
    afterCallbacks: [],
    responseHeaders: extras.responseHeaders,
  }
  const result = requestStorage.run(scope, callback)
  if (isThenable(result)) {
    return (result as PromiseLike<unknown>).then(
      value => {
        void flushAfterCallbacks(scope)
        return value
      },
      error => {
        void flushAfterCallbacks(scope)
        throw error
      },
    ) as T
  }
  void flushAfterCallbacks(scope)
  return result
}

/**
 * Register a callback to run once the surrounding runWithRequest callback
 * settles. Returns false when no request scope is active.
 */
export function registerAfterCallback(callback: () => unknown): boolean {
  const scope = requestStorage.getStore()
  if (!scope) return false
  ;(scope.afterCallbacks ??= []).push(callback)
  return true
}

/** Response-headers channel for the active request scope, when a caller provided one. */
export function currentResponseHeaders(): Headers | undefined {
  return requestStorage.getStore()?.responseHeaders
}

async function flushAfterCallbacks(scope: RequestScope) {
  while (scope.afterCallbacks?.length) {
    const callbacks = scope.afterCallbacks
    scope.afterCallbacks = []
    for (const callback of callbacks) {
      try {
        await requestStorage.run(scope, callback)
      } catch (error) {
        console.error('after() callback failed:', error)
      }
    }
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function'
}

/**
 * Build-time bailout probe: while active, every request API throws Next's
 * DynamicServerError instead of reading the synthetic prerender request. The
 * build uses it to find a request API call that OUTLIVES the render (scheduled
 * in a timer), which is the shape Next surfaces as a prerender error. Anchored
 * on globalThis so a compiled bundle carrying its own copy of this module reads
 * the same flag, and module-level rather than ALS-scoped because the calls it
 * looks for run outside the render's async context by definition.
 */
const BAILOUT_PROBE = Symbol.for('pnext.dynamicBailoutProbe')

export function beginDynamicBailoutProbe(route: string): void {
  ;(globalThis as Record<PropertyKey, unknown>)[BAILOUT_PROBE] = route
}

export function endDynamicBailoutProbe(): void {
  delete (globalThis as Record<PropertyKey, unknown>)[BAILOUT_PROBE]
}

function dynamicBailoutRoute(): string | undefined {
  const route = (globalThis as Record<PropertyKey, unknown>)[BAILOUT_PROBE]
  return typeof route === 'string' ? route : undefined
}

/**
 * compat.next.legacyRequestAPIs — Next 15's transitional sync request APIs. Core owns the boolean cell
 * (set from loadConfig); compat's cookies()/headers()/draftMode() read it. globalThis-anchored so a
 * prebundled server entry carrying its own copy of this module sees the same flag.
 */
const LEGACY_REQUEST_APIS = Symbol.for('pnext.legacyRequestAPIs')

export function setLegacyRequestAPIs(enabled: boolean): void {
  ;(globalThis as Record<PropertyKey, unknown>)[LEGACY_REQUEST_APIS] = enabled
}

export function legacyRequestAPIs(): boolean {
  return (globalThis as Record<PropertyKey, unknown>)[LEGACY_REQUEST_APIS] === true
}

export function requireRequest(api: string) {
  const probeRoute = dynamicBailoutRoute()
  if (probeRoute !== undefined) {
    const error = new Error(
      `Route ${probeRoute} couldn't be rendered statically because it used \`${api.replace(/\(\)$/, '')}\`. ` +
        `See more info here: https://nextjs.org/docs/messages/dynamic-server-error`,
    )
    error.name = 'DynamicServerError'
    throw error
  }
  const request = currentRequest()
  if (!request) {
    // In a partial prerender, request access marks the surrounding Suspense
    // boundary as a dynamic hole rather than failing the build.
    if (isPrerendering()) throw new PostponeError(api)
    throw new Error(`${api} can only be used while rendering a dynamic PNext request.`)
  }
  return request
}

/**
 * Produce the value of an async request API (cookies/headers/params/searchParams). At request time, or under
 * a legacy prerender, it resolves to `produce()`. Under a cacheComponents prerender it returns a HANGING
 * PROMISE so that creating the promise does not postpone - only awaiting it inside a Suspense subtree does
 * (dynamic-at-await-site).
 */
export function requestApiPromise<T>(api: string, produce: () => T): Promise<T> {
  // Under a cacheComponents prerender the value hangs: awaiting it postpones the
  // boundary, while merely observing its rejection (the request-apis stash-and-
  // observe pattern) yields the "rejects when the prerender is complete" message
  // — see hangingPromise.
  if (isPrerendering() && cacheComponents()) {
    // A runtime-prefetch prerender (`unstable_instant`) samples a real request:
    // cookies()/headers()/params resolve from it, so their content lands in the
    // prefetch response. Only connection() stays a hanging promise — it marks
    // content that must NEVER be served from a prefetch.
    if (isRuntimePrefetchPrerender() && api !== 'connection()') {
      // Awaiting the resolved value arms the sync-IO abort: anything the render
      // computes with Date.now() & co. AFTER a runtime API resolved belongs to
      // the navigation, not the prefetch (see runWithRuntimePrefetchSyncIoAbort).
      return markRuntimeApiOnAwait(Promise.resolve(produce()))
    }
    return hangingPromise<T>(api)
  }
  // Legacy PPR (experimental_ppr, cacheComponents off): keep the call-site
  // throw so the existing shell path postpones exactly as before.
  return Promise.resolve(produce())
}
