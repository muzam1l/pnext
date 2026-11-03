// io() primitive (COMPAT). Marks the content AFTER `await io()` as dynamic under cacheComponents:
// during prerender it is a hanging promise, so awaiting it postpones the boundary and that content
// becomes a runtime hole; at request time it resolves so the content renders. Inside a `use cache`
// scope it is a no-op (the cache is filled at build, so post-io content is buildtime), and without
// cacheComponents it is a no-op entirely.
//
// navigation() / prefetch() defer content past a prerender stage: both hang in a prefetch shell,
// a runtime prefetch resolves prefetch() only, and static prerenders and requests resolve both.

import {
  cacheComponents,
  hangingPromise,
  isCsrBailoutPrerender,
  isPrefetchShellPrerender,
  isPrerendering,
  isPrefetchOnlyRuntimePrerender,
  markStageResolved,
  PostponeError,
} from '../../render/ppr'
import { fulfilledThenable, rejectedThenable } from '../react/use'
import { insidePrivateUseCache } from '../cache/use-cache'
import {
  currentRenderCacheMeta,
  insideDataCacheProducer,
  insideUnstableCacheProducer,
} from '../cache/revalidate'
import { assertRequestApiAllowedInAfter } from '../lifecycle/after-scope'

/**
 * Await this to mark subsequent content dynamic. See module header for the
 * prerender / request / use-cache / no-cacheComponents matrix.
 */
export function io(): Promise<void> {
  assertRequestApiAllowedInAfter('io()')
  if (!cacheComponents()) return fulfilledThenable()
  // Inside a `use cache` / unstable_cache producer the cache boundary wins: the
  // value is produced at build, so io() does not postpone.
  if (insideDataCacheProducer()) return fulfilledThenable()
  if (isPrerendering()) return hangingPromise<void>('io()')
  // A client island prerendered into a static page bails out to client render behind its fallback.
  if (isCsrBailoutPrerender()) return rejectedThenable(new PostponeError('io()'))
  return fulfilledThenable()
}

const STAGE_PURPOSE = {
  navigation: ['must only run during an actual navigation', 'a navigation', 'navigation'],
  prefetch: ['must not run in the app shell', 'a prefetch', 'prefetch'],
} as const

function stage(api: 'navigation' | 'prefetch', hangs: boolean): Promise<void> {
  const [purpose, before, deferred] = STAGE_PURPOSE[api]
  const route = currentRenderCacheMeta()?.route ?? ''
  if (!cacheComponents()) {
    throw new Error(
      `Route ${route} used \`${api}()\`, which requires Cache Components to be enabled. Learn more: https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheComponents`,
    )
  }
  assertRequestApiAllowedInAfter(`${api}()`)
  if (insideUnstableCacheProducer()) {
    throw new Error(
      `Route ${route} used \`${api}()\` inside a function cached with \`unstable_cache()\`. The \`${api}()\` function is used to indicate the subsequent code ${purpose}, but \`unstable_cache()\` caches must be able to be produced before ${before}, so this function is not allowed in this scope. See more info here: https://nextjs.org/docs/app/api-reference/functions/unstable_cache`,
    )
  }
  const cache = insidePrivateUseCache()
    ? '"use cache: private"'
    : insideDataCacheProducer()
      ? '"use cache"'
      : undefined
  if (cache) {
    throw new Error(
      `Route ${route} used \`${api}()\` inside ${cache}. This is not currently supported. Instead, move the "use cache" directive to a function that's called below \`await ${api}()\`, so that the cached content is deferred to the ${deferred} without caching the stage boundary itself. See more info here: https://nextjs.org/docs/messages/next-request-in-use-cache`,
    )
  }
  if (hangs) return hangingPromise<void>(`${api}()`)
  if (isPrerendering()) markStageResolved(api === 'navigation' ? 2 : 1)
  return fulfilledThenable()
}

/** Defer the content after `await navigation()` to an actual navigation. */
export function navigation(): Promise<void> {
  return stage('navigation', isPrefetchShellPrerender() || isPrefetchOnlyRuntimePrerender())
}

/** Defer the content after `await prefetch()` out of the app shell. */
export function prefetch(): Promise<void> {
  return stage('prefetch', isPrefetchShellPrerender())
}
