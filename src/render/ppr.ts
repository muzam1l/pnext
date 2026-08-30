import { AsyncLocalStorage } from 'node:async_hooks'

// Partial Prerendering (Next.js-compatible "mixed" model).
//
// At build time a PPR route is rendered in a "prerender" scope where there is
// no request. Any access to request data (cookies()/headers()/...) throws a
// PostponeError instead of a hard failure. The renderer catches that error at
// the nearest <Suspense> boundary, keeps the fallback in the static shell, and
// records the boundary as a dynamic "hole". At request time the shell is served
// immediately and only the recorded holes are re-rendered with the real request
// and streamed in.
//
// Stage C (cacheComponents) generalizes this: request APIs become HANGING
// PROMISES during prerender rather than throwing synchronously at the call
// site. The postpone fires at the first `await` of the hanging promise inside a
// Suspense subtree (dynamic-at-await-site), matching Next's semantic where
// passing `cookies()` as an un-awaited promise to a child does NOT make the
// parent dynamic. Awaiting it does.

// PostponeError + isPostpone live in a client-safe module (no node:async_hooks)
// so client control-flow code can import isPostpone without pulling this module
// (and its AsyncLocalStorage) into the browser bundle. Re-exported here so
// every server caller keeps importing them from ppr.
export { PostponeError, isPostpone } from './postpone'
import { isPostpone as isPostponeError, PostponeError } from './postpone'

// The prerender scope carries an AbortController so a hanging promise whose
// settlement microtask has not yet run stays pending once the prerender has
// produced its shell (see hangingPromise's `scope.signal.aborted` guard).
interface PrerenderScope {
  /** Fires when the prerender pass has produced its shell. */
  readonly signal: AbortSignal
  abort: () => void
  /**
   * A RUNTIME-PREFETCH prerender (`unstable_instant` full prefetch): the render runs against a real sampled
   * request, so request APIs RESOLVE from it instead of hanging - only connection()-gated content stays
   * dynamic, its promise hanging so the boundary records a hole. Nothing this request-sampled render
   * produces may be persisted into build artifacts.
   */
  readonly runtimePrefetch?: boolean
  /**
   * Runtime-prefetch prerenders only: a runtime API (cookies/headers/params/searchParams, or a `use cache`
   * read) has been AWAITED somewhere in this render. From that point on, synchronous platform IO aborts its
   * boundary - see runWithRuntimePrefetchSyncIoAbort.
   */
  awaitedRuntimeApi?: boolean
  /**
   * A prerender whose output becomes a PREFETCH shell (the body segment the client's segment cache stores),
   * NOT the document served for a direct request. Short-lived `use cache` scopes are omitted from it exactly
   * as they are from a runtime prefetch - the client's stale window for the prefetch would otherwise be
   * governed by a cache that expires before it.
   */
  readonly prefetchShell?: boolean
  /**
   * A BUILD prerender running under Next's task-boundary semantics (see
   * awaitAtTaskBoundary). Only set for a cacheComponents build shell render.
   */
  readonly taskBoundary?: boolean
}

// Anchored on globalThis (like requestStorage in request/context.ts) so a
// compiled compat copy of this module shares the same prerender-scope ALS —
// unanchored, a second module instance splits prerender detection.
const PRERENDER_STORAGE = Symbol.for('pnext.prerenderStorage')
const prerenderStorage = ((globalThis as Record<PropertyKey, unknown>)[PRERENDER_STORAGE] ??=
  new AsyncLocalStorage<PrerenderScope>()) as AsyncLocalStorage<PrerenderScope>

const CSR_BAILOUT_STORAGE = Symbol.for('pnext.csrBailoutStorage')
const csrBailoutStorage = ((globalThis as Record<PropertyKey, unknown>)[CSR_BAILOUT_STORAGE] ??=
  new AsyncLocalStorage<boolean>()) as AsyncLocalStorage<boolean>

interface PrerenderDynamicTracker {
  dynamic: boolean
}

const prerenderDynamicTrackerStorage = new AsyncLocalStorage<PrerenderDynamicTracker>()

export async function trackPrerenderDynamic<T>(callback: () => Promise<T>): Promise<{
  value: T
  dynamic: boolean
}> {
  const tracker: PrerenderDynamicTracker = { dynamic: false }
  const value = await prerenderDynamicTrackerStorage.run(tracker, callback)
  return { value, dynamic: tracker.dynamic }
}

function markPrerenderDynamic(): void {
  const tracker = prerenderDynamicTrackerStorage.getStore()
  if (tracker) tracker.dynamic = true
}

// ---------------------------------------------------------------------------
// Build-shell dynamic-source tracking.
//
// A cacheComponents route whose only dynamic access is `params` inside a
// <Suspense> boundary produces a hole during the partial-shell prerender, yet
// must NOT be served as a postponed fallback shell: params are part of the URL
// and always available at request time, so the route is served with a blocking
// dynamic render (Next's fallback-shells "without IO should not postpone").
// A hole caused by cached IO (`use cache`/cached fetch) or by request data
// other than params (cookies()/headers()/connection()/searchParams) is a
// genuine partial-shell postpone and keeps the fallback-shell path.
//
// Anchored on globalThis because the built compat-server bundle loads its own
// copy of this module (same reason revalidate.ts / cache-fill state anchor
// there): the cache runtime recording a fill lives in a different module copy
// from the build driver that begins/reads the window.
const SHELL_SOURCES = Symbol.for('pnext.shellDynamicSources')
interface ShellSourceState {
  active: boolean
  cacheIO: boolean
  nonParamsRequest: boolean
}
function shellSourceState(): ShellSourceState {
  const root = globalThis as Record<PropertyKey, unknown>
  return (root[SHELL_SOURCES] ??= {
    active: false,
    cacheIO: false,
    nonParamsRequest: false,
  }) as ShellSourceState
}

/** Arm shell-source tracking for one partial-shell prerender (resets counters). */
export function beginShellSourceTracking(): void {
  const state = shellSourceState()
  state.active = true
  state.cacheIO = false
  state.nonParamsRequest = false
}

/** Read + disarm the dynamic sources observed during the last shell prerender. */
export function endShellSourceTracking(): { cacheIO: boolean; nonParamsRequest: boolean } {
  const state = shellSourceState()
  const result = { cacheIO: state.cacheIO, nonParamsRequest: state.nonParamsRequest }
  state.active = false
  return result
}

/** Record a request-API postpone by name (params is URL-derived, everything else is real request IO). */
function recordShellRequestApi(api: string): void {
  const state = shellSourceState()
  if (state.active && api !== 'params') state.nonParamsRequest = true
}

/** Record that cached IO (a `use cache`/fetch/unstable_cache fill) ran during the shell. */
function recordShellCacheIO(): void {
  const state = shellSourceState()
  if (state.active) state.cacheIO = true
}

/** Render `callback` in prerender mode so request APIs postpone instead of throwing. */
export function runInPrerender<T>(
  callback: () => T,
  options: { runtimePrefetch?: boolean; prefetchShell?: boolean; taskBoundary?: boolean } = {},
): T {
  const controller = new AbortController()
  activePrerenderControllers().add(controller)
  const scope: PrerenderScope = {
    signal: controller.signal,
    abort: () => controller.abort(),
    ...(options.runtimePrefetch ? { runtimePrefetch: true, awaitedRuntimeApi: false } : {}),
    ...(options.prefetchShell ? { prefetchShell: true } : {}),
    ...(options.taskBoundary ? { taskBoundary: true } : {}),
  }
  return prerenderStorage.run(scope, callback)
}

// The build process force-aborts every prerender AbortController created since
// the last sweep as a belt-and-braces backstop: completePrerender already aborts
// each scope on its own exit path, but a scope whose callback wired a timer to
// React.cacheSignal() (a slow cache component polling `setTimeout(..., { signal:
// React.cacheSignal() })`) and then escaped in a way that skipped its abort would
// keep the event loop alive and hang the whole build. Anchored on globalThis for
// the usual dual-module-copy reason (build driver vs built compat-server bundle).
const ACTIVE_PRERENDER_CONTROLLERS = Symbol.for('pnext.activePrerenderControllers')
function activePrerenderControllers(): Set<AbortController> {
  const root = globalThis as Record<PropertyKey, unknown>
  return (root[ACTIVE_PRERENDER_CONTROLLERS] ??= new Set<AbortController>()) as Set<AbortController>
}

/**
 * Force-abort (and forget) every prerender AbortController created since the last
 * call. Call once per built route after its shell render returns so no route's
 * stray cacheSignal-bound timer can outlive its render and hang the build.
 */
export function abortActivePrerenderScopes(): void {
  const controllers = activePrerenderControllers()
  for (const controller of controllers) controller.abort()
  controllers.clear()
}

export function isPrerendering() {
  return prerenderStorage.getStore() !== undefined
}

/** Run a legacy static render where client URL hooks defer to Suspense. */
export function runWithCsrBailout<T>(callback: () => T): T {
  return csrBailoutStorage.run(true, callback)
}

/** True while a legacy static render must defer URL-dependent client islands. */
export function isCsrBailoutPrerender(): boolean {
  return csrBailoutStorage.getStore() === true
}

/** True inside a runtime-prefetch prerender (see PrerenderScope.runtimePrefetch). */
export function isRuntimePrefetchPrerender(): boolean {
  return prerenderStorage.getStore()?.runtimePrefetch === true
}

/** True inside a prefetch-shell prerender (see PrerenderScope.prefetchShell). */
export function isPrefetchShellPrerender(): boolean {
  return prerenderStorage.getStore()?.prefetchShell === true
}

/** The active prerender scope (undefined outside a prerender). */
export function currentPrerenderScope(): PrerenderScope | undefined {
  return prerenderStorage.getStore()
}

/**
 * Complete the active prerender. Called after a shell has been produced: aborts
 * the scope so any hanging promise whose settlement microtask has not yet run
 * stays pending (see hangingPromise's `scope.signal.aborted` guard) rather than
 * rejecting post-shell. Idempotent.
 */
export function completePrerender(scope: PrerenderScope | undefined): void {
  if (!scope) return
  scope.abort()
}

// Task-boundary prerender (cacheComponents build parity).
//
// Next ends a build prerender at the first TASK boundary: work that settles while the microtask queue
// drains lands in the static shell, while anything needing a fresh macrotask (setTimeout, setImmediate,
// real I/O) does NOT - the surrounding <Suspense> keeps its fallback and the content is filled in at request
// time. Upstream that falls out of React's `prerender` being started in one task and aborted in the next.
//
// pnext resolves the server tree itself rather than through React's prerender, so the boundary is modelled
// per server-component invocation: the component's promise races a deadline that fires once the microtask
// queue has drained. A microtask-settled component always wins the race; a task-settled one loses and
// postpones.
//
// The drain is counted in microtask turns rather than armed with `setImmediate`, because `setImmediate` is
// only ordered against the CHECK phase of the loop: a component's already-expired `setTimeout` sitting in
// the TIMERS phase beats it roughly half the time whenever a loop turn runs long, which baked Suspense
// content into the static shell instead of postponing. Microtasks cannot be preempted by any timer or I/O
// callback, so the verdict is the same on a quiet machine and under a saturated CPU.
//
// Arming the deadline per invocation, rather than once for the whole render, is what keeps a SIBLING static
// subtree renderable after another subtree hit the boundary - the parallel-routes case, where the `@slot`
// becomes a hole but `children` must still bake into the shell.

const taskPostponeSymbol = Symbol.for('pnext.taskPostpone')

/**
 * A postpone raised by the task boundary rather than by a request API. Escaping
 * every <Suspense> boundary means the route cannot produce a static shell at
 * all, which Next reports as a blocking-prerender build error.
 */
export function isTaskPostpone(error: unknown): boolean {
  return isPostponeError(error) && taskPostponeSymbol in error
}

function taskPostponeError(): PostponeError {
  const error = new PostponeError('task')
  Object.defineProperty(error, taskPostponeSymbol, { value: true })
  return error
}

/** True inside a build prerender running under task-boundary semantics. */
export function isTaskBoundaryPrerender(): boolean {
  return prerenderStorage.getStore()?.taskBoundary === true
}

const taskBoundaryArmedStorage = new AsyncLocalStorage<true>()
const taskBoundarySuspendedStorage = new AsyncLocalStorage<true>()

/**
 * Render `callback` with the task boundary ARMED. The renderer arms it only while resolving a <Suspense>
 * subtree, because that is the only place a task postpone can be safely absorbed - the boundary records a
 * hole and keeps its fallback. Task work ABOVE every boundary is left unbounded so it still bakes into the
 * shell, matching Next, where such work escaping the root is a separate blocking-prerender concern.
 */
export function runWithTaskBoundaryArmed<T>(callback: () => T): T {
  return taskBoundaryArmedStorage.run(true, callback)
}

/**
 * Render `callback` with the task boundary suspended. Used for a `'use cache'` component's subtree: upstream
 * the whole subtree renders inside the cache fill, so its (possibly task-settled) IO belongs in the static
 * shell just like the fill's own - see the module-level `'use cache'` page shape, where the cached component
 * returns immediately and its children do the IO.
 */
export function runWithTaskBoundarySuspended<T>(callback: () => T): T {
  return taskBoundarySuspendedStorage.run(true, callback)
}

// compat/cache/use-cache tags both shapes of "renders inside a cache scope" with globally-registered
// symbols, so reading them keeps core free of a compat import: the `'use cache'` wrapper itself, and the
// render-once memo wrapper it puts on every server component inside a produced (cached) tree.
const useCacheWrapperSymbol = Symbol.for('pnext.compat.useCacheWrapper')
const useCacheMemoWrappedSymbol = Symbol.for('pnext.compat.useCacheMemoWrapped')

/** Whether `component` renders inside a compat `'use cache'` scope. */
export function isCachedComponent(component: unknown): boolean {
  if (typeof component !== 'function') return false
  const tagged = component as unknown as Record<symbol, unknown>
  return tagged[useCacheWrapperSymbol] === true || tagged[useCacheMemoWrappedSymbol] === true
}

/**
 * Bound a server-component invocation by the prerender's task boundary. Outside
 * a task-boundary prerender (request renders, non-cacheComponents builds) the
 * value is returned untouched, so this is a no-op on every serving path.
 */
export function awaitAtTaskBoundary<T>(value: T): T {
  if (!isTaskBoundaryPrerender()) return value
  // Only armed inside a <Suspense> subtree (see runWithTaskBoundaryArmed), and
  // never inside a `'use cache'` subtree (runWithTaskBoundarySuspended).
  if (taskBoundaryArmedStorage.getStore() !== true) return value
  if (taskBoundarySuspendedStorage.getStore() === true) return value
  if (typeof (value as { then?: unknown } | null)?.then !== 'function') return value
  const deadline = taskDeadline()
  // Cancel on settle so a component that wins the race does not leave its
  // deadline burning through the rest of its microtask budget.
  return Promise.race([value as PromiseLike<unknown>, deadline.promise]).finally(
    deadline.cancel,
  ) as T
}

// Cache fills are the one kind of task-queue work a build prerender must WAIT for rather than cut off.
// Upstream this falls out of Next's two-pass model: a warmup render fills every cache,
// `cacheSignal().cacheReady()` waits for them, and only then does the real prerender run with its
// task-boundary abort, so by then every cached read settles from memory in a microtask. pnext renders once,
// so instead the deadline yields while a fill is still in flight and re-arms when the last one settles.
// Net effect matches: cached IO lands in the shell, uncached task work does not.
//
// A fill that never settles must not hang the build (the E236 fill-timeout guard covers 'use cache', but
// nothing bounds an unstable_cache producer), so the deadline only ever defers to fills a bounded number of
// times before firing anyway.
const MAX_CACHE_FILL_DEFERRALS = 50

interface CacheFillState {
  pending: number
  waiters: (() => void)[]
}

// The build process and the built compat-server bundle load their own copies of
// this module (same reason revalidate.ts / build-prerender-errors.ts anchor
// their state), and the cache runtime registering a fill lives in the other
// copy from the renderer arming the deadline. Anchor the counter on globalThis
// so both copies share one window.
const CACHE_FILL_STATE = Symbol.for('pnext.prerenderCacheFills')

function cacheFillState(): CacheFillState {
  const root = globalThis as Record<PropertyKey, unknown>
  return (root[CACHE_FILL_STATE] ??= { pending: 0, waiters: [] }) as CacheFillState
}

/**
 * Register an in-flight cache fill so a prerender's task boundary waits for it.
 * Cheap enough to run unconditionally (a counter plus one `.then`), which keeps
 * it correct even where the caller's module copy cannot see the prerender ALS.
 * Returns `fill` for chaining.
 */
export function trackPrerenderCacheFill<T>(fill: Promise<T>): Promise<T> {
  recordShellCacheIO()
  const state = cacheFillState()
  state.pending += 1
  const settled = () => {
    state.pending -= 1
    if (state.pending > 0) return
    const waiters = state.waiters
    state.waiters = []
    for (const waiter of waiters) waiter()
  }
  fill.then(settled, settled)
  return fill
}

// How many microtask turns count as "the queue drained". Generous enough that no
// realistic chain of already-resolved awaits (in this component or in the
// siblings interleaving with it) runs out of budget, and still free: the whole
// drain happens inside one event-loop turn, and it is cancelled the moment the
// component it guards settles.
const MICROTASK_DRAIN_TURNS = 1000

function taskDeadline(): { promise: Promise<never>; cancel: () => void } {
  let cancelled = false
  const promise = new Promise<never>((_resolve, reject) => {
    let deferrals = 0
    const drain = (remaining: number) => {
      if (cancelled) return
      if (remaining === 0) {
        const state = cacheFillState()
        if (state.pending > 0 && deferrals < MAX_CACHE_FILL_DEFERRALS) {
          // Cache fills are the one kind of task work the boundary waits for:
          // yield until the last one settles, then drain again.
          deferrals += 1
          state.waiters.push(() => drain(MICROTASK_DRAIN_TURNS))
          return
        }
        reject(taskPostponeError())
        return
      }
      // Yield through BOTH pre-macrotask queues each turn: the nextTick queue
      // ahead of us runs first (a component awaiting `process.nextTick` must
      // still land in the shell), then a microtask hop. Neither queue can be
      // preempted by a timer or an I/O callback, which is what makes the verdict
      // load-independent.
      const next = () => void Promise.resolve().then(() => drain(remaining - 1))
      if (typeof process?.nextTick === 'function') process.nextTick(next)
      else next()
    }
    drain(MICROTASK_DRAIN_TURNS)
  })
  // The losing copy of a raced deadline must never reach the unhandled-rejection
  // channel (the race attaches its own handler to the winning one).
  promise.catch(() => undefined)
  return {
    promise,
    cancel: () => {
      cancelled = true
    },
  }
}

/**
 * A promise that never resolves during prerender. Its settlement depends on how the render observes it,
 * matching Next's two cacheComponents contracts:
 *   - AWAITED (a `.then` with a fulfillment handler - the dynamic-at-await-site signal): rejects with
 *     PostponeError so the await throws and the nearest <Suspense> records a hole.
 *   - Only observed for rejection, or passed around and never awaited - the "stash the promise and observe
 *     its rejection later" pattern: rejects instead with the "During prerendering, <api> rejects when the
 *     prerender is complete" message so a subscribed rejection handler observes it.
 * Either way the internal `.catch` below keeps an un-subscribed copy off the unhandled-rejection channel.
 */
/**
 * The Error a hanging request-API promise rejects with once the prerender completes. Next names the API in
 * backticks and its Node runtime prints the error as `Error: <message>`. Bun's console inspector would
 * otherwise render an Error as lowercase `error:` plus a code frame, so a Node-style `util.inspect` custom
 * hook returns the canonical form - the request-apis e2e suite substring-matches exactly that.
 */
function prerenderCompleteError(api: string): Error {
  const message = `During prerendering, \`${api}\` rejects when the prerender is complete.`
  const error = new Error(message)
  Object.defineProperty(error, Symbol.for('nodejs.util.inspect.custom'), {
    value: () => {
      const stackTail = (error.stack ?? '').split('\n').slice(1).join('\n')
      return stackTail ? `Error: ${message}\n${stackTail}` : `Error: ${message}`
    },
    enumerable: false,
    configurable: true,
  })
  return error
}

/**
 * Tag read off a hanging promise's Proxy. A consumer that only wants to KNOW a promise is a hanging
 * request-API promise, rather than consume its value, must be able to ask without marking the prerender
 * dynamic - so the tag arm sits ahead of the then/catch/finally arms in the `get` trap.
 */
const HANGING_PROMISE = Symbol.for('pnext.hangingPromise')

/**
 * True for the promise `hangingPromise` returns. Used by the island-props
 * serializer: awaiting a fallback-shell `params`/`searchParams` promise on the
 * way to a client component would postpone OUTSIDE every <Suspense> and destroy
 * the whole partial shell, when the island's props are not the consumer that
 * should postpone anything.
 */
export function isHangingPromise(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[HANGING_PROMISE] === true
  )
}

export function hangingPromise<T = never>(api: string): Promise<T> {
  const scope = prerenderStorage.getStore()
  // Outside a prerender scope this should not be called; return a caught
  // rejection defensively so a stray await surfaces rather than hangs forever.
  if (!scope) {
    const stray = Promise.reject<T>(new PostponeError(api))
    stray.catch(() => undefined)
    return stray
  }

  // The promise settles exactly once, via whichever observation happens first: a consumer awaiting it (a
  // `.then` with a fulfillment handler) rejects with PostponeError so the await throws and the boundary
  // records a hole; the prerender completing (scope abort) rejects with the "rejects when the prerender is
  // complete" Error so stashed-promise subscribers observe it. It must stay PENDING until one of those
  // happens - settling on a timer or microtask races late awaiters into the wrong rejection.
  let settle: ((error: Error) => void) | undefined
  const promise = new Promise<T>((_resolve, reject) => {
    settle = (error: Error) => reject(error)
  })
  const rejectAwaited = () => settle?.(new PostponeError(api))
  if (scope.signal.aborted) {
    settle?.(prerenderCompleteError(api))
  } else {
    scope.signal.addEventListener('abort', () => settle?.(prerenderCompleteError(api)), {
      once: true,
    })
  }
  // Swallow the rejection for the un-subscribed copy so a hanging promise nobody
  // observed never surfaces as an unhandled rejection; an actual awaiter/handler
  // still observes the throw (it subscribes to the same promise).
  promise.catch(() => undefined)
  return new Proxy(promise, {
    get(target, property) {
      // Before every observation arm: reading the tag must not mark dynamic.
      if (property === HANGING_PROMISE) return true
      if (property === 'then') {
        return (...args: Parameters<typeof target.then>) => {
          // A fulfillment handler means the value is being consumed (an await or
          // value-taking `.then`): mark the boundary dynamic and postpone.
          if (typeof args[0] === 'function') rejectAwaited()
          markPrerenderDynamic()
          recordShellRequestApi(api)
          return target.then(...args)
        }
      }
      if (property === 'catch') {
        return (...args: Parameters<typeof target.catch>) => {
          markPrerenderDynamic()
          recordShellRequestApi(api)
          return target.catch(...args)
        }
      }
      if (property === 'finally') {
        return (...args: Parameters<typeof target.finally>) => {
          markPrerenderDynamic()
          recordShellRequestApi(api)
          return target.finally(...args)
        }
      }
      const value: unknown = Reflect.get(target, property, target)
      return value
    },
  })
}

// ---------------------------------------------------------------------------
// Global cacheComponents flag (Stage C).
//
// Next 16 gates PPR-by-default on `nextConfig.cacheComponents: true` rather
// than the per-route `experimental_ppr` opt-in. Core owns the flag storage
// (a boolean cell); compat sets it from getNextConfig() during registration.
// The renderer/routing/build read it to decide whether every route is a PPR
// candidate and whether request APIs hang.
// ---------------------------------------------------------------------------

// globalThis-anchored: the prebundled server entry inlines its own copy of this module.
const CACHE_COMPONENTS = Symbol.for('pnext.cacheComponents')

export function setCacheComponents(enabled: boolean): void {
  ;(globalThis as Record<PropertyKey, unknown>)[CACHE_COMPONENTS] = enabled
}

export function cacheComponents(): boolean {
  return (globalThis as Record<PropertyKey, unknown>)[CACHE_COMPONENTS] === true
}

// ---------------------------------------------------------------------------
// Prerender determinism (Stage C-5).
//
// During a build prerender, incidental Math.random()/Date.now()/new Date() must
// not vary or fail the build. We patch them to deterministic values for the
// duration of a build prerender pass and restore afterwards. Build-only and
// single-route-at-a-time, so global patching is safe; at request time the real
// implementations run (random varies across requests). Applied only under
// cacheComponents so the legacy path is byte-identical.
// ---------------------------------------------------------------------------

// Real wall-clock that survives the determinism patch below. Cache bookkeeping
// (use-cache storedAt) must never be stamped with the frozen build clock — a
// `storedAt: 0` entry reads as perpetually expired at runtime.
const REAL_NOW = Symbol.for('pnext.realNow')
export function realNow(): number {
  const stored = (globalThis as Record<PropertyKey, unknown>)[REAL_NOW]
  return typeof stored === 'function' ? (stored as () => number)() : Date.now()
}

// A `use cache` body is allowed to be non-deterministic - its output is what gets cached, and Next's
// work-unit store inside a cache scope is `cache`, not `prerender-runtime`, so
// abortOnSynchronousPlatformIOAccess never applies there. The scope ALS is read off its globalThis symbol
// rather than imported: ppr.ts is core and must not depend on compat/cache.
const USE_CACHE_SCOPE_STORAGE = Symbol.for('pnext.compat.useCacheScopeStorage')

function insideUseCacheScope(): boolean {
  const storage = (globalThis as Record<PropertyKey, unknown>)[USE_CACHE_SCOPE_STORAGE] as
    { getStore(): unknown } | undefined
  return storage?.getStore() !== undefined
}

export async function runWithPrerenderDeterminism<T>(fn: () => Promise<T>): Promise<T> {
  if (!cacheComponents()) return fn()
  const deterministicTime = 1
  const realRandom = Math.random
  const RealDate = Date
  ;(globalThis as Record<PropertyKey, unknown>)[REAL_NOW] = RealDate.now.bind(RealDate)
  let counter = 0
  Math.random = () => {
    counter = (counter * 1103515245 + 12345) & 0x7fffffff
    return (counter % 1000000) / 1000000
  }
  const PatchedDate = function (this: unknown, ...args: unknown[]) {
    if (!new.target) return new RealDate(deterministicTime).toString()
    if (args.length === 0) return new RealDate(deterministicTime)
    return Reflect.construct(RealDate, args) as Date
  } as unknown as DateConstructor
  Object.setPrototypeOf(PatchedDate, RealDate)
  Object.defineProperty(PatchedDate, 'prototype', { value: RealDate.prototype })
  PatchedDate.now = () => deterministicTime
  // eslint-disable-next-line no-global-assign
  Date = PatchedDate
  try {
    return await fn()
  } finally {
    Math.random = realRandom
    // eslint-disable-next-line no-global-assign
    Date = RealDate
  }
}

// Sync-IO abort during a runtime-prefetch prerender.
//
// A runtime prefetch renders against a REAL sampled request, so cookies()/headers()/params/`use cache`
// resolve - which means sync IO hidden BEHIND one of them (the classic `await cookies(); return
// <div>{Date.now()}</div>`) is only reachable at runtime, never at build time where validation would catch
// it. Next handles it with abortOnSynchronousPlatformIOAccess: once a runtime API has resolved, the next
// synchronous platform IO call aborts the boundary, silently, because the value is simply left for the
// navigation to render.
//
// pnext mirrors that by shimming the platform globals for the duration of the runtime-prefetch render and
// throwing a postpone (exactly what connection() does) when the scope's `awaitedRuntimeApi` flag is set.
// The shims are gated on the prerender ALS, so a concurrent request render on the same server sees the real
// implementations.

/**
 * Mark a runtime API's promise so AWAITING it arms the sync-IO abort for the rest of the runtime-prefetch
 * render. Outside a runtime-prefetch prerender the promise is returned untouched.
 *
 * Await-precise rather than creation-precise: merely creating (or passing around) `cookies()` must not arm
 * the abort - the same dynamic-at-await-site rule hangingPromise implements, and via the same Proxy trick,
 * since `await` on a native promise bypasses a monkey-patched `then`.
 */
export function markRuntimeApiOnAwait<T>(promise: Promise<T>): Promise<T> {
  const scope = prerenderStorage.getStore()
  if (scope?.runtimePrefetch !== true) return promise
  return new Proxy(promise, {
    get(target, property) {
      if (property === 'then') {
        return (...args: Parameters<typeof target.then>) => {
          // A fulfillment handler means the value is being consumed (an await or
          // a value-taking `.then`) — the point Next considers the runtime API
          // resolved into the render.
          if (typeof args[0] === 'function') scope.awaitedRuntimeApi = true
          return target.then(...args)
        }
      }
      return Reflect.get(target, property, target) as unknown
    },
  })
}

/** Throw the boundary-aborting postpone when sync IO happens post-runtime-API. */
function abortOnSynchronousPlatformIOAccess(): void {
  const scope = prerenderStorage.getStore()
  if (scope?.runtimePrefetch !== true || scope.awaitedRuntimeApi !== true) return
  // Sync IO inside a `use cache` body is legal — see insideUseCacheScope above.
  if (insideUseCacheScope()) return
  throw new PostponeError('sync IO')
}

/** Install `value` as an own property of `owner`, returning a restore thunk. */
function patchMethod(owner: object, key: string, value: unknown): () => void {
  const hadOwn = Object.prototype.hasOwnProperty.call(owner, key)
  const descriptor = Object.getOwnPropertyDescriptor(owner, key)
  try {
    Object.defineProperty(owner, key, {
      value,
      configurable: true,
      writable: true,
      enumerable: descriptor?.enumerable ?? false,
    })
  } catch {
    return () => undefined
  }
  return () => {
    try {
      if (hadOwn && descriptor) Object.defineProperty(owner, key, descriptor)
      else delete (owner as Record<string, unknown>)[key]
    } catch {
      /* nothing sensible to do if the global refuses to be restored */
    }
  }
}

// Two runtime prefetches can be in flight at once, so installation is
// refcounted: the shims go in on 0→1 and come out on 1→0. Anchored on
// globalThis for the usual dual-module-copy reason.
const SYNC_IO_SHIMS = Symbol.for('pnext.runtimePrefetchSyncIoShims')
interface SyncIoShimState {
  depth: number
  restore: (() => void)[]
}
function syncIoShimState(): SyncIoShimState {
  const root = globalThis as Record<PropertyKey, unknown>
  return (root[SYNC_IO_SHIMS] ??= { depth: 0, restore: [] }) as SyncIoShimState
}

function installSyncIoShims(): void {
  const state = syncIoShimState()
  if (++state.depth > 1) return
  const root = globalThis as Record<PropertyKey, unknown>
  const RealDate = Date
  const realRandom = Math.random
  // realNow() must keep reporting the true wall clock while Date.now is shimmed
  // — cache bookkeeping (storedAt/expiry) reads it during the render.
  const previousRealNow = root[REAL_NOW]
  root[REAL_NOW] = RealDate.now.bind(RealDate)
  const PatchedDate = function (this: unknown, ...args: unknown[]) {
    if (!new.target) {
      abortOnSynchronousPlatformIOAccess()
      return new RealDate().toString()
    }
    if (args.length === 0) {
      abortOnSynchronousPlatformIOAccess()
      return new RealDate()
    }
    return Reflect.construct(RealDate, args) as Date
  } as unknown as DateConstructor
  Object.setPrototypeOf(PatchedDate, RealDate)
  Object.defineProperty(PatchedDate, 'prototype', { value: RealDate.prototype })
  PatchedDate.now = () => {
    abortOnSynchronousPlatformIOAccess()
    return RealDate.now()
  }
  // eslint-disable-next-line no-global-assign
  Date = PatchedDate
  Math.random = () => {
    abortOnSynchronousPlatformIOAccess()
    return realRandom()
  }
  state.restore.push(() => {
    // eslint-disable-next-line no-global-assign
    Date = RealDate
    Math.random = realRandom
    root[REAL_NOW] = previousRealNow
  })
  const perf = globalThis.performance as Performance | undefined
  if (perf) {
    const realPerfNow = perf.now.bind(perf)
    state.restore.push(
      patchMethod(perf, 'now', () => {
        abortOnSynchronousPlatformIOAccess()
        return realPerfNow()
      }),
    )
  }
  const webCrypto = globalThis.crypto as Crypto | undefined
  if (typeof webCrypto?.getRandomValues === 'function') {
    const realGetRandomValues = webCrypto.getRandomValues.bind(webCrypto)
    state.restore.push(
      patchMethod(webCrypto, 'getRandomValues', (array: ArrayBufferView) => {
        abortOnSynchronousPlatformIOAccess()
        return realGetRandomValues(array as never)
      }),
    )
  }
}

function restoreSyncIoShims(): void {
  const state = syncIoShimState()
  if (--state.depth > 0) return
  state.depth = 0
  const restore = state.restore
  state.restore = []
  for (const undo of restore) undo()
}

/**
 * Run a runtime-prefetch render with the sync-IO shims installed. Sync IO that
 * happens once a runtime API has been awaited (see markRuntimeApiOnAwait)
 * postpones its nearest <Suspense> boundary instead of returning a value.
 */
export async function runWithRuntimePrefetchSyncIoAbort<T>(fn: () => Promise<T>): Promise<T> {
  installSyncIoShims()
  try {
    return await fn()
  } finally {
    restoreSyncIoShims()
  }
}
