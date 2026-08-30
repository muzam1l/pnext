// io() primitive (COMPAT). Marks the content AFTER `await io()` as dynamic under cacheComponents:
// during prerender it is a hanging promise, so awaiting it postpones the boundary and that content
// becomes a runtime hole; at request time it resolves so the content renders. Inside a `use cache`
// scope it is a no-op (the cache is filled at build, so post-io content is buildtime), and without
// cacheComponents it is a no-op entirely.

import { cacheComponents, hangingPromise, isPrerendering } from '../../render/ppr'
import { insideDataCacheProducer } from '../cache/revalidate'

/**
 * A resolved promise pre-tagged with React's tracked-thenable state (`status: 'fulfilled'`).
 * `React.use(io())` is a supported call site, and our use() short-circuits a fulfilled thenable instead
 * of suspending. A plain `Promise.resolve()` has no status, so use() would throw to suspend and -
 * because io() returns a FRESH promise on every replay and the pages render has no use()-thenable
 * replay scope - the component would re-throw forever. `await io()` is unaffected.
 */
function resolvedIo(): Promise<void> {
  const promise = Promise.resolve() as Promise<void> & {
    status?: string
    value?: undefined
  }
  promise.status = 'fulfilled'
  promise.value = undefined
  return promise
}

/**
 * Await this to mark subsequent content dynamic. See module header for the
 * prerender / request / use-cache / no-cacheComponents matrix.
 */
export function io(): Promise<void> {
  if (!cacheComponents()) return resolvedIo()
  // Inside a `use cache` / unstable_cache producer the cache boundary wins: the
  // value is produced at build, so io() does not postpone.
  if (insideDataCacheProducer()) return resolvedIo()
  if (isPrerendering()) return hangingPromise<void>('io()')
  return resolvedIo()
}
