import {
  bumpRevalidationEvent,
  cachedData,
  currentRenderCacheMeta,
  insideDataCacheProducer,
  insideUnstableCacheProducer,
  markPathRevalidated,
  markTagRevalidated,
  markTagStale,
  recordCacheNoStore,
  recordCacheRevalidate,
  recordCacheTags,
} from '../cache/revalidate'
import { recordUseCacheLife, recordUseCacheTags } from '../cache/use-cache'
import { currentRequest, getWorkUnit } from '../../request/context'
import { getNextConfig } from './config-loader'
import { isPrerendering, PostponeError } from '../../render/ppr'
export { io } from '../ppr/io'

export function refresh() {
  const phase = getWorkUnit()?.phase
  if (phase !== 'action' || insideDataCacheProducer()) {
    throw new Error('refresh can only be called from within a Server Action')
  }
  bumpRevalidationEvent()
}

export const unstable_refresh = refresh

/**
 * Revalidation is a side effect and must never run during a render or inside a cached function. At
 * request time a render-phase call throws Next's exact error (the page shows its error UI and the
 * message reaches the server log); during a build prerender the route simply becomes dynamic
 * (postpone). Actions, route handlers and after() are the supported call sites and pass through.
 */
function assertRevalidateOutsideRender(expression: string): void {
  const route = currentRenderCacheMeta()?.route ?? '/'
  const suffix =
    'which is unsupported. To ensure revalidation is performed consistently it must always ' +
    'happen outside of renders and cached functions. See more info here: ' +
    'https://nextjs.org/docs/app/building-your-application/rendering/static-and-dynamic#dynamic-rendering'
  if (insideDataCacheProducer()) {
    throw new Error(
      insideUnstableCacheProducer()
        ? `Route ${route} used "${expression}" inside a function cached with "unstable_cache(...)" ${suffix}`
        : `Route ${route} used "${expression}" inside a "use cache" ${suffix}`,
    )
  }
  // Live request renders only: build prerenders (and their after() drains,
  // which run with the work-unit phase still 'render') keep their existing
  // skip-to-dynamic behavior rather than throwing here.
  if (getWorkUnit()?.phase !== 'render' || isPrerendering()) return
  throw new Error(`Route ${route} used "${expression}" during render ${suffix}`)
}

export function revalidatePath(path: string, type?: 'page' | 'layout') {
  assertRevalidateOutsideRender(`revalidatePath ${path}`)
  markPathRevalidated(path, type)
}

export function revalidateTag(tag: string, profile?: string | CacheLifeProfile) {
  assertRevalidateOutsideRender(`revalidateTag ${tag}`)
  if (profile === undefined) {
    console.warn(
      'Warning: "revalidateTag" without the second argument is now deprecated. Use updateTag(tag) for read-your-writes semantics, or pass a cache profile (e.g. revalidateTag(tag, \'max\')).',
    )
    markTagRevalidated(tag)
    return
  }
  // A cache-life profile whose expiry has already elapsed (the built-in `expireNow`, or any profile with
  // expire/revalidate 0) is an immediate hard expiry, not stale-while-revalidate: the next read must
  // recompute inline and observe a fresh value. Softer profiles keep SWR semantics.
  //
  // The profile is either a cacheLife name or an inline `{ expire }` object. An unknown name is treated
  // as immediate expiry too - Next only softens the invalidation when the profile RESOLVES to a nonzero
  // expiry, so failing hard keeps revalidation observable.
  const resolved = typeof profile === 'string' ? resolveCacheLifeProfile(profile) : profile
  if (!resolved || resolved.expire === 0 || resolved.revalidate === 0) {
    markTagRevalidated(tag)
    return
  }
  markTagStale(tag)
}

/** updateTag is Server-Action-only in Next (read-your-writes expiry). */
export function updateTag(tag: string) {
  const request = currentRequest()
  const inServerAction =
    request?.method?.toUpperCase?.() === 'POST' && Boolean(request.headers?.get?.('next-action'))
  if (!inServerAction) {
    throw new Error(
      'updateTag can only be called from within a Server Action. Use revalidateTag or expireTag for other contexts.',
    )
  }
  markTagRevalidated(tag)
}

// Newer names for the same operations.
export const unstable_expirePath = revalidatePath
export const unstable_expireTag = (tag: string) => {
  assertRevalidateOutsideRender(`expireTag ${tag}`)
  markTagRevalidated(tag)
}
export const expirePath = revalidatePath
export const expireTag = unstable_expireTag

export interface UnstableCacheOptions {
  revalidate?: number | false
  tags?: string[]
}

export function unstable_cache<Args extends unknown[], Result>(
  fn: (...args: Args) => Promise<Result>,
  keyParts?: string[],
  options: UnstableCacheOptions = {},
): (...args: Args) => Promise<Result> {
  const { revalidate } = options
  if (
    revalidate !== undefined &&
    revalidate !== false &&
    (typeof revalidate !== 'number' || revalidate < 0 || !Number.isFinite(revalidate))
  ) {
    throw new Error(
      `Invalid revalidate value "${String(revalidate)}" on "unstable_cache(${fn.toString().slice(0, 60)})", must be a non-negative number or false`,
    )
  }
  const baseKey = keyParts?.length ? keyParts.join(',') : fn.toString()
  return (...args: Args) => {
    // Surrounding prerender/ISR writes inherit this entry's tags and TTL.
    recordCacheTags(options.tags ?? [])
    if (typeof options.revalidate === 'number') recordCacheRevalidate(options.revalidate)
    return cachedData(`${baseKey}:${JSON.stringify(args)}`, () => fn(...args), {
      tags: options.tags,
      revalidateSeconds: typeof options.revalidate === 'number' ? options.revalidate : undefined,
    }) as Promise<Result>
  }
}

/** Opt the surrounding render out of prebuilt static output (Next semantics). */
export function unstable_noStore() {
  recordCacheNoStore()
}

// 'use cache' directive companions: tag/bound the active use-cache entry
// (see cache/use-cache.ts) and propagate to the surrounding render meta so
// prerendered pages inherit tags/TTL.
export function cacheTag(...tags: string[]) {
  recordUseCacheTags(tags)
  recordCacheTags(tags)
}

// Built-in cacheLife profiles (Next defaults). `expire` defaults to the
// config's `expireTime` (one year) when a profile omits it; `stale` feeds the
// `x-nextjs-stale-time` header.
interface CacheLifeProfile {
  revalidate?: number
  expire?: number
  stale?: number
}

const DEFAULT_EXPIRE_TIME = 31536000 // one year, Next's default expireTime.

const builtInCacheLifeProfiles: Record<string, CacheLifeProfile> = {
  default: { revalidate: 900, expire: DEFAULT_EXPIRE_TIME, stale: 300 },
  seconds: { revalidate: 1, expire: 60, stale: 30 },
  minutes: { revalidate: 60, expire: 3600, stale: 300 },
  hours: { revalidate: 3600, expire: 86400, stale: 300 },
  days: { revalidate: 86400, expire: 604800, stale: 300 },
  weeks: { revalidate: 604800, expire: 2592000, stale: 300 },
  max: { revalidate: 2592000, expire: DEFAULT_EXPIRE_TIME, stale: 300 },
}

/** Resolve a cacheLife profile name against config `cacheLife` overrides. */
function resolveCacheLifeProfile(name: string): CacheLifeProfile | undefined {
  const config = getNextConfig()
  const overrides = config.cacheLife as Record<string, CacheLifeProfile> | undefined
  const custom = overrides?.[name]
  const builtIn = builtInCacheLifeProfiles[name]
  if (!custom && !builtIn) return undefined
  const expireTime = typeof config.expireTime === 'number' ? config.expireTime : DEFAULT_EXPIRE_TIME
  const merged = { ...builtIn, ...custom }
  return {
    ...merged,
    expire: merged.expire ?? expireTime,
  }
}

export function cacheLife(
  profile: string | { revalidate?: number; stale?: number; expire?: number },
) {
  const resolved =
    typeof profile === 'string'
      ? resolveCacheLifeProfile(profile)
      : {
          revalidate: typeof profile?.revalidate === 'number' ? profile.revalidate : undefined,
          expire: typeof profile?.expire === 'number' ? profile.expire : undefined,
          stale: typeof profile?.stale === 'number' ? profile.stale : undefined,
        }
  if (!resolved) return
  const { revalidate, expire, stale } = resolved
  recordUseCacheLife({
    ...(revalidate !== undefined ? { revalidateSeconds: revalidate } : {}),
    ...(expire !== undefined ? { expireSeconds: expire } : {}),
    ...(stale !== undefined ? { staleSeconds: stale } : {}),
  })
  if (revalidate !== undefined) recordCacheRevalidate(revalidate)
  if (isPrerendering() && stale === 0) throw new PostponeError('cacheLife')
}
export const unstable_cacheTag = cacheTag
export const unstable_cacheLife = cacheLife
