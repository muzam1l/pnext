import { AsyncLocalStorage } from 'node:async_hooks'

export interface CacheNode {
  children: Map<unknown, CacheNode>
  record?: CacheRecord
}

export type CacheRecord =
  | { status: 'pending'; value: Promise<unknown> }
  | { status: 'resolved'; value: unknown; async: boolean }
  | { status: 'rejected'; error: unknown; async: boolean }

export interface CacheScope {
  functions: WeakMap<object, CacheNode>
  fetches?: Map<string, Promise<unknown>>
  /**
   * Lazily-created controller backing React.cacheSignal() in a request render. The signal stays live
   * for the whole render - including deferred/streamed Suspense boundaries that resolve after the
   * shell has flushed - so a slow cache component's bounded polling is never cut short. A build
   * prerender uses the prerender scope's signal instead, which aborts at completePrerender().
   */
  controller?: AbortController
}

// globalThis-anchored: the prebundled server entry inlines its own copy of this module.
const CACHE_SCOPE_STORAGE = Symbol.for('pnext.cacheScopeStorage')
const storage = ((globalThis as Record<PropertyKey, unknown>)[CACHE_SCOPE_STORAGE] ??=
  new AsyncLocalStorage<CacheScope>()) as AsyncLocalStorage<CacheScope>

export function currentCacheScope() {
  return storage.getStore()
}

/**
 * The AbortSignal for the current cache/render scope (React.cacheSignal()), or null outside any
 * render. A request render's shell can flush while deferred boundaries are still resolving, so this
 * signal is intentionally NOT aborted at shell-flush time - doing so would abort a still-pending slow
 * boundary's polling. Build prerenders get a deterministically-aborting signal from the prerender scope.
 */
export function currentCacheSignal(): AbortSignal | null {
  const scope = storage.getStore()
  if (!scope) return null
  if (!scope.controller) scope.controller = new AbortController()
  return scope.controller.signal
}

export function runWithCacheScope<T>(callback: () => T): T {
  const existing = storage.getStore()
  if (existing) return callback()
  return storage.run({ functions: new WeakMap() }, callback)
}

/**
 * Capture the current cache scope (if any) and return a wrapper that re-runs a
 * function inside it. after() uses this so a callback registered during a page
 * render still shares the render's React cache() memo cache when it runs later
 * in the detached work-unit flush (which otherwise carries no cache scope).
 * Returns an identity wrapper when no scope is active.
 */
export function captureCacheScope(): <T>(fn: () => T) => T {
  const scope = storage.getStore()
  if (!scope) return fn => fn()
  return fn => storage.run(scope, fn)
}
