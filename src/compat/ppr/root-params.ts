// next/root-params runtime (COMPAT).
//
// `next/root-params` exports one async getter per ROOT param. Since the getter NAMES do not affect the
// runtime (each getter just reads its own param off the request ALS param store), a single Proxy-backed
// module satisfies every app.
//
// The build-time scan validates that only real root params are imported - importing a non-root name is
// a build/dev error there - so this runtime is intentionally permissive and a valid getter always works.
// Context errors (server action / route handler / unstable_cache) match Next's messages exactly.

import { currentParams, currentRequest, getWorkUnit } from '../../request/context'
import {
  cacheComponents,
  hangingPromise,
  isPrerendering,
  isRuntimePrefetchPrerender,
} from '../../render/ppr'
import { insideUnstableCacheProducer } from '../cache/revalidate'
import { insideUseCacheProducer, recordUseCacheRootParamRead } from '../cache/use-cache'

/** E-code errors Next throws for root-params used in an unsupported context. */
function rootParamContextError(name: string): Error | undefined {
  const unit = getWorkUnit()
  const call = `\`import('next/root-params').${name}()\``

  const inUseCache = insideUseCacheProducer()
  const inUnstableCache = insideUnstableCacheProducer()

  // Root params inside a `use cache` NESTED within `unstable_cache`: E1140.
  // (The `use cache` scope sits inside the unstable_cache producer, so both
  // markers are active.) Root params are not available in that context.
  if (inUseCache && inUnstableCache) {
    return Object.assign(
      new Error(
        `Root params (${call}) were used inside a cache scope nested within \`unstable_cache\`. Root params are not available in this context.`,
      ),
      { digest: 'E1140' },
    )
  }

  // Inside a plain `use cache` (not under unstable_cache): legal. Record the
  // read so the entry's cache key participates in this root param (Stage B-3),
  // then let the getter resolve the value below (no error).
  if (inUseCache) {
    recordUseCacheRootParamRead(name)
    return undefined
  }

  // Inside `unstable_cache` (a data-cache producer that is NOT a `use cache`
  // scope): E1141.
  if (inUnstableCache) {
    return Object.assign(
      new Error(
        `Root params (${call}) were used inside \`unstable_cache\`. This is not supported. Use \`"use cache"\` instead.`,
      ),
      { digest: 'E1141' },
    )
  }

  if (!unit) return undefined

  if (unit.phase === 'action') {
    return new Error(
      `${call} was used inside a Server Action. This is not supported. ` +
        `Functions from 'next/root-params' can only be called in the context of a route.`,
    )
  }

  // Route handlers are detected via routeKind (core sets no 'handler' phase).
  if (unit.phase !== 'after' && unit.routeKind === 'route-handler') {
    const route = (() => {
      try {
        return new URL(currentRequest()?.url ?? '').pathname
      } catch {
        return ''
      }
    })()
    return new Error(
      `Route ${route} used ${call} inside a Route Handler. ` +
        `Support for this API in Route Handlers is planned for a future version of Next.js.`,
    )
  }

  return undefined
}

/**
 * Read a single root param off the request param store. Async (matching Next's
 * getter shape). A catch-all resolves to an array; an absent optional catch-all
 * resolves to undefined.
 */
export function rootParam<T = string | string[] | undefined>(name: string): Promise<T> {
  const error = rootParamContextError(name)
  if (error) return Promise.reject(error)
  // A runtime-prefetch prerender renders against the REAL sampled request, so root params are concrete
  // there (root params are always available in static prerenders, so a runtime prefetch has them too).
  // Hanging them would postpone the root layout itself - the whole document, not a boundary - and the
  // render would produce no shell at all.
  if (
    !insideUseCacheProducer() &&
    cacheComponents() &&
    isPrerendering() &&
    !isRuntimePrefetchPrerender()
  ) {
    return hangingPromise<T>(`rootParam(${name})`)
  }
  const params = currentParams()
  return Promise.resolve(params[name] as T)
}

/**
 * The aliased module surface: a Proxy whose every string property is an async
 * getter for that root param. `import { lang } from 'next/root-params'` picks up
 * `rootParam('lang')`. Non-root imports are rejected at build (the scan), so
 * this Proxy never needs to distinguish them at runtime.
 */
const rootParamsModule = new Proxy(
  {},
  {
    get(_target, prop: string | symbol): unknown {
      if (typeof prop !== 'string') return undefined
      if (prop === '__esModule') return true
      if (prop === 'default') return undefined
      return () => rootParam(prop)
    },
  },
) as Record<string, () => Promise<unknown>>

export default rootParamsModule
