// after() - next/server (COMPAT).
//
// Registers work to run AFTER the response is fully sent. It builds on the core request work-unit:
// queueAfterTask enqueues onto the per-request after-queue that core flushes exactly once when the
// response closes - on every path (stream end, redirect(), notFound(), thrown error, client abort).
// Nested after() works because the flush runs the queue inside the work unit and re-drains newly
// enqueued tasks.
//
// When the surrounding platform provides the Vercel request-context waitUntil, each after task is also
// handed to it so a serverless platform keeps the invocation alive until it settles. When no work unit
// is active, the task runs on the microtask queue as a best-effort fallback.

import { captureCacheScope } from '../../request/cache'
import {
  captureRequestScope,
  currentRequest,
  getWorkUnit,
  queueAfterTask,
  setPhase,
} from '../../request/context'
import { currentRenderCacheMeta } from '../cache/revalidate'
import {
  afterRequestApisAllowed,
  recordRequestPath,
  runWithAfterRequestApiScope,
} from './after-scope'

type AfterTask<T> = Promise<T> | (() => T | Promise<T>)

const requestContextSymbol = Symbol.for('@next/request-context')

/**
 * Marks an error that escaped an after() task during a BUILD prerender. The build's per-route
 * skip-and-warn catch reads it to fail the build instead of silently degrading the route to dynamic -
 * Next fails the build when after() throws while prerendering.
 */
export const AFTER_PRERENDER_ERROR = Symbol.for('pnext.afterPrerenderError')

interface VercelRequestContext {
  get?: () => { waitUntil?: (promise: Promise<unknown>) => void } | undefined
}

/** The platform waitUntil, when a Vercel-style request context is present. */
function platformWaitUntil(): ((promise: Promise<unknown>) => void) | undefined {
  const holder = (globalThis as Record<symbol, unknown>)[requestContextSymbol] as
    VercelRequestContext | undefined
  return holder?.get?.()?.waitUntil
}

/**
 * Run a single after task, forwarding its settled promise to the platform
 * waitUntil when available. Errors are logged with Next's exact `after()` prefix
 * (phase-changes/cookies asserts the "An error occurred in a function passed to
 * `after()`:" text) and never rethrown, so one failing task cannot break others.
 */
async function runAfterTask<T>(task: AfterTask<T>): Promise<void> {
  const promise = Promise.resolve()
    .then(() => (typeof task === 'function' ? task() : task))
    .then(
      () => undefined,
      error => {
        console.error(
          `An error occurred in a function passed to \`after()\`: ${
            error instanceof Error
              ? (error.stack ?? `${error.name}: ${error.message}`)
              : String(error)
          }`,
        )
      },
    )
  platformWaitUntil()?.(promise)
  await promise
}

/**
 * Like runAfterTask but for build prerenders: the task's rejection propagates
 * so a throwing after() fails the page's prerender (next-after-app-static),
 * rather than being logged and swallowed. The settled promise is still forwarded
 * to the platform waitUntil (with errors swallowed there to avoid an unhandled
 * rejection) so a serverless platform keeps the invocation alive until it ends.
 */
async function settleAfterTask<T>(task: AfterTask<T>): Promise<void> {
  const promise = Promise.resolve().then(() => (typeof task === 'function' ? task() : task))
  platformWaitUntil()?.(
    promise.then(
      () => undefined,
      () => undefined,
    ),
  )
  try {
    await promise
  } catch (error) {
    // Tag so the build's per-route catch fails the build rather than degrading
    // the route to dynamic. The tag rides the same error object up through the
    // static after-drain (which re-throws it) to cli/build.ts.
    if (error && typeof error === 'object') {
      ;(error as Record<symbol, unknown>)[AFTER_PRERENDER_ERROR] = true
    }
    throw error
  }
}

/**
 * Run a prerender after() task in the 'after' phase, naming its route. The
 * runtime flush sets the work unit to phase 'after' before draining; a build
 * prerender drains through the render cache meta instead, so the phase + route
 * are set here so request-API guards fire with Next's exact message (both
 * no-op when there is no work unit, e.g. a route-handler prerender).
 */
function runInPrerenderAfterPhase<T>(
  route: string | undefined,
  requestApisAllowed: boolean,
  fn: () => T,
): T {
  setPhase('after')
  if (route) recordRequestPath(route)
  return runWithAfterRequestApiScope(requestApisAllowed, fn)
}

/**
 * next/server after(): schedule a callback or promise to run once the response
 * has been fully sent. Legal in dynamic pages, route handlers, server actions,
 * middleware, and generateMetadata().
 */
export function after<T>(task: AfterTask<T>): void {
  // Capture the request scope at call time so a callback registered during a route handler or server
  // action still resolves request APIs when it runs later in the flush. A page render does NOT capture:
  // its after() callbacks run detached, so headers()/cookies()/connection() throw Next's "used inside
  // after()" error. The phase distinguishes them - renders stay 'render', handlers set routeKind,
  // actions set phase 'action'.
  const unit = getWorkUnit()
  const isHandlerOrAction =
    unit?.phase === 'action' || unit?.phase === 'middleware' || unit?.routeKind === 'route-handler'
  const isNestedRequestAfter =
    unit?.phase === 'after' && Boolean(currentRequest()) && afterRequestApisAllowed()
  // Handlers and actions capture the live request scope so headers()/cookies() keep working inside their
  // after() callbacks. A page render (or generateMetadata) instead captures only the React cache()
  // scope, so cache() shares the render's memo cache in the callback while the request scope stays
  // detached and headers()/cookies()/connection() still throw Next's "used inside after()" error.
  const withScope =
    isHandlerOrAction || isNestedRequestAfter ? captureRequestScope() : captureCacheScope()
  // Static-generation render (build prerender or ISR regeneration): there is
  // no response close to flush against, so the task queues on the render's
  // cache meta and the render drains it once produce settles (Next waits for
  // after() during prerendering). Build prerenders propagate rejections so a
  // throwing after() fails the page's prerender (next-after-app-static);
  // runtime regenerations log-and-continue like every other runtime path.
  const meta = currentRenderCacheMeta()
  if (meta && (meta.prerender === true || meta.blockingStaleFetches === true)) {
    // A build/ISR prerender runs with no work unit, so the top-level routeKind check above cannot tell a
    // route-handler prerender from a page one - meta.handler does. A handler prerender captures the live
    // request scope so request APIs resolve inside after(); a page prerender keeps only the cache scope
    // so they throw "used inside after()".
    const prerenderScope = meta.handler ? captureRequestScope() : withScope
    const route = meta.route
    const requestApisAllowed = Boolean(meta.handler)
    const run = meta.prerender
      ? () =>
          prerenderScope(() =>
            runInPrerenderAfterPhase(route, requestApisAllowed, () => settleAfterTask(task)),
          )
      : () =>
          prerenderScope(() =>
            runWithAfterRequestApiScope(requestApisAllowed, () => runAfterTask(task)),
          )
    ;(meta.afterTasks ??= []).push(run)
    return
  }
  const requestApisAllowed = Boolean(isHandlerOrAction || isNestedRequestAfter)
  const queued = queueAfterTask(() =>
    withScope(() => runWithAfterRequestApiScope(requestApisAllowed, () => runAfterTask(task))),
  )
  if (queued) return
  // No active work unit (e.g. called at module scope): best-effort microtask.
  void withScope(() => runWithAfterRequestApiScope(requestApisAllowed, () => runAfterTask(task)))
}
