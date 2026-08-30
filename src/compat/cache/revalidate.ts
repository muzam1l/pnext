/**
 * Process-wide revalidation registry backing the next/cache compat surface.
 *
 * pnext renders dynamic routes fresh on every request, so revalidation only
 * has observable meaning for (a) prebuilt static HTML served from the build
 * output and (b) unstable_cache data entries. Paths and tags record the time
 * they were revalidated; consumers compare against their stored-at time.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { currentRequest, getWorkUnit } from '../../request/context'
import { realNow, trackPrerenderCacheFill } from '../../render/ppr'
import { cacheHandlerRevalidateTag } from './handler'
import { modernCacheUpdateTags } from './modern-handler'
import { escapeRegex } from '../../utils/code'
import {
  prerenderErrorCollectionActive,
  recordPrerenderError,
  unstableCacheDynamicApiMessage,
  useCacheDynamicApiMessage,
} from './build-prerender-errors'

/**
 * Draft mode (a __prerender_bypass cookie on the active request) bypasses
 * data-cache reads AND writes: every render sees fresh data and leaves the
 * cached values untouched (Next semantics).
 */
export function draftModeBypassActive() {
  return currentRequest()?.cookies?.has('__prerender_bypass') ?? false
}

// Cross-instance singletons. The `'use cache'` transform pulls this module (and use-cache.ts) into the
// per-app server bundle, so an app that uses `use cache` ends up with a SECOND copy of revalidate.ts,
// distinct from the copy the pnext runtime loads from source. Two copies means two of every
// module-level Map/counter/ALS - the producer scope a cached render enters would be invisible to the
// runtime fetch patch, and a revalidatePath() written by one copy's registry would never be seen by the
// other's staleness reader. Anchor all process-wide state on globalThis so both copies share it.
const REVALIDATE_GLOBALS = Symbol.for('pnext.compat.revalidateGlobals')
const USE_CACHE_ENTRIES = Symbol.for('pnext.compat.useCacheEntries')

function revalidateGlobal<T>(name: string, create: () => T): T {
  const root = globalThis as Record<PropertyKey, unknown>
  const container = (root[REVALIDATE_GLOBALS] ??= {}) as Record<string, unknown>
  if (!(name in container)) container[name] = create()
  return container[name] as T
}

const revalidatedPaths = revalidateGlobal('revalidatedPaths', () => new Map<string, number>())
const revalidatedPathReasons = revalidateGlobal(
  'revalidatedPathReasons',
  () => new Map<string, 'stale' | 'on-demand'>(),
)
const revalidatedTags = revalidateGlobal('revalidatedTags', () => new Map<string, number>())
// Monotonic counters stamped/sampled across the module. Held on a shared object
// (not module `let`s) so both module copies read and bump the same values:
//  - tagSeq: stamped on every hard tag revalidation. In-memory cache entries
//    ('use cache') compare their production-time sequence against it instead of
//    wall-clock timestamps so read-your-writes works even when the updateTag and
//    the re-read land in the same millisecond. The timestamp maps stay for
//    prebuilt-HTML mtime comparisons, which cross request/process boundaries.
//  - lastPathAt: wall-clock of the most recent path revalidation of ANY route;
//    entries produced OUTSIDE a render (no owning route) fall back to it, so any
//    revalidatePath invalidates them.
//  - events: monotonic count of revalidation events (path or tag). Server
//    actions sample it before/after an action to decide whether the client's
//    view needs a refresh (Next invalidates its client router cache).
const counters = revalidateGlobal('counters', () => ({ tagSeq: 0, lastPathAt: 0, events: 0 }))
const revalidatedTagSeq = revalidateGlobal('revalidatedTagSeq', () => new Map<string, number>())
const revalidatedTagReasons = revalidateGlobal(
  'revalidatedTagReasons',
  () => new Map<string, 'stale' | 'on-demand'>(),
)
const staleTags = revalidateGlobal('staleTags', () => new Map<string, number>())
const dataCacheInvalidators = revalidateGlobal('dataCacheInvalidators', () => new Set<() => void>())
export type RevalidationInvalidation =
  { kind: 'path'; path: string } | { kind: 'tag'; tag: string; stale: boolean }

const revalidationInvalidators = revalidateGlobal(
  'revalidationInvalidators',
  () => new Set<(invalidation: RevalidationInvalidation) => void>(),
)

interface RevalidatableUseCacheEntry {
  tags: string[]
  route?: string
  storedAt: number
}

function evictUseCacheEntries(invalidation: RevalidationInvalidation) {
  const entries = (globalThis as Record<PropertyKey, unknown>)[USE_CACHE_ENTRIES] as
    Map<string, RevalidatableUseCacheEntry> | undefined
  if (!entries || (invalidation.kind === 'tag' && invalidation.stale)) return
  for (const [key, entry] of entries) {
    const matches =
      invalidation.kind === 'tag'
        ? entry.tags.includes(invalidation.tag)
        : pathScopeRevalidated(entry.route, entry.storedAt)
    if (matches) entries.delete(key)
  }
}
// Pattern marks: revalidatePath('/x', 'layout') covers the whole subtree, and
// paths containing dynamic segments ('/blog/[author]') cover every match.
const revalidatedPatterns = revalidateGlobal(
  'revalidatedPatterns',
  () => [] as { regex: RegExp; at: number; reason: 'stale' | 'on-demand' }[],
)
const revalidatedPatternsLimit = 256

export function revalidationEventCount() {
  return counters.events
}

/**
 * Signal a client-router refresh without expiring the data cache. refresh()
 * (next/cache) inside a server action re-renders the current route on the
 * client; the action endpoint samples the event count to set the refresh
 * header, so bumping the counter is enough.
 */
export function bumpRevalidationEvent() {
  counters.events += 1
}

export function normalizeRevalidatePath(path: string) {
  let pathname = path.split('?')[0] ?? path
  try {
    pathname = decodeURI(pathname)
  } catch {
    // Keep malformed escape sequences unchanged.
  }
  const trimmed = pathname.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

export function markPathRevalidated(path: string, type?: 'page' | 'layout') {
  counters.events += 1
  // fetch/data cache entries carry the route they were produced under (Next's
  // implicit `_N_T_/route` soft tag). Revalidating a path only invalidates the
  // entries owned by matching routes (see pathScopeRevalidated); route-less
  // entries (produced outside a render) fall back to this global timestamp.
  counters.lastPathAt = Date.now()
  const normalized = normalizeRevalidatePath(path)
  void modernCacheUpdateTags([`_N_T_${normalized}`])
  const reason = getWorkUnit()?.phase === 'action' ? 'stale' : 'on-demand'
  if (normalized.includes('[') || type === 'layout') {
    const source = normalized
      .split('/')
      .map(segment =>
        /^\[?\[\.\.\./.test(segment)
          ? '.+'
          : segment.startsWith('[')
            ? '[^/]+'
            : escapeRegex(segment),
      )
      .join('/')
    const base = normalized === '/' ? '' : source
    const regex = type === 'layout' ? new RegExp(`^${base}(?:/.*)?$`) : new RegExp(`^${source}$`)
    revalidatedPatterns.push({ regex, at: Date.now(), reason })
    if (revalidatedPatterns.length > revalidatedPatternsLimit) revalidatedPatterns.shift()
    const invalidation = { kind: 'path', path: normalized } as const
    evictUseCacheEntries(invalidation)
    notifyRevalidationInvalidators(invalidation)
    return
  }
  revalidatedPaths.set(normalized, Date.now())
  revalidatedPathReasons.set(normalized, reason)
  const invalidation = { kind: 'path', path: normalized } as const
  evictUseCacheEntries(invalidation)
  notifyRevalidationInvalidators(invalidation)
}

export function markTagRevalidated(tag: string) {
  counters.events += 1
  revalidatedTags.set(tag, Date.now())
  revalidatedTagSeq.set(tag, ++counters.tagSeq)
  revalidatedTagReasons.set(tag, getWorkUnit()?.phase === 'action' ? 'stale' : 'on-demand')
  // Forward to a configured cache handler so a persistent backend drops the
  // entry too (best-effort; the in-memory marks are authoritative).
  void cacheHandlerRevalidateTag(tag)
  void modernCacheUpdateTags([tag])
  const invalidation = { kind: 'tag', tag, stale: false } as const
  evictUseCacheEntries(invalidation)
  notifyRevalidationInvalidators(invalidation)
}

export function markTagStale(tag: string) {
  // Deliberately NOT counted as a revalidation event: a profile-based revalidateTag is
  // stale-while-revalidate - the client keeps showing its current (stale) view and must NOT be told to
  // refresh after the action. Fresh data appears only on the next navigation/refresh, which serves stale
  // and regenerates in the background.
  staleTags.set(tag, Date.now())
  void cacheHandlerRevalidateTag(tag)
  void modernCacheUpdateTags([tag])
  notifyRevalidationInvalidators({ kind: 'tag', tag, stale: true })
}

// Marks are integer Date.now() while file mtimes carry fractional
// milliseconds; truncate so a mark landing in the same millisecond as the
// write still counts as newer (worst case: one redundant regeneration).
function markedAfter(at: number | undefined, time: number) {
  return at !== undefined && at >= Math.trunc(time) && at > time - 1
}

export function pathRevalidatedSince(path: string, time: number) {
  const normalized = normalizeRevalidatePath(path)
  if (markedAfter(revalidatedPaths.get(normalized), time)) return true
  return revalidatedPatterns.some(
    pattern => markedAfter(pattern.at, time) && pattern.regex.test(normalized),
  )
}

export function pathRevalidationReasonSince(
  path: string,
  time: number,
): 'stale' | 'on-demand' | undefined {
  const normalized = normalizeRevalidatePath(path)
  if (markedAfter(revalidatedPaths.get(normalized), time)) {
    return revalidatedPathReasons.get(normalized) ?? 'on-demand'
  }
  return revalidatedPatterns.find(
    pattern => markedAfter(pattern.at, time) && pattern.regex.test(normalized),
  )?.reason
}

/**
 * Whether a cache entry produced under `route` (its owning render's pathname,
 * or undefined when produced outside any render) has been invalidated by a
 * revalidatePath since it was stored at `time`. Route-scoped entries match
 * only their own route (respecting layout/dynamic patterns); route-less
 * entries are invalidated by any path revalidation.
 */
export function pathScopeRevalidated(route: string | undefined, time: number): boolean {
  if (route === undefined) return markedAfter(counters.lastPathAt || undefined, time)
  return pathRevalidatedSince(route, time)
}

export function tagsRevalidatedSince(tags: readonly string[], time: number) {
  return tags.some(tag => markedAfter(revalidatedTags.get(tag), time))
}

/** Current hard-tag-revalidation sequence, stamped on an entry at production. */
export function currentTagRevalidationSeq() {
  return counters.tagSeq
}

/**
 * Identifies the process that produced a resume-data-cache record. Stamped into
 * every RDC record at capture and compared at seed, because `tagSeq` only means
 * something within one process (see rebaseRdcTagSeq).
 */
export function rdcProcessId(): string {
  return revalidateGlobal(
    'rdcProcessId',
    () => `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
  )
}

/**
 * Rebase an RDC record's `tagSeq` onto this process's sequence.
 *
 * `tagSeq` counts hard tag revalidations WITHIN a process and resets to 0 on restart, so a sequence
 * serialized by the build (or a previous server process) is meaningless here. A record from a FOREIGN
 * process was produced before anything that happened in this one, so it rebases to 0: any updateTag()
 * of its tags seen by this process invalidates it. Rebasing onto the CURRENT sequence instead hides
 * revalidations that already happened - an RDC seed running on the post-action re-render would restamp
 * the stale record as fresh, so updateTag() in a server action could never surface fresh data.
 *
 * A record this process itself captured keeps its own sequence (clamped, since the counter can be
 * reset), so a shell regenerated right after a revalidation is not immediately re-invalidated by it.
 */
export function rebaseRdcTagSeq(record: { tagSeq: number; pid?: string }): number {
  if (record.pid !== rdcProcessId()) return 0
  return Math.min(record.tagSeq, counters.tagSeq)
}

/**
 * Whether any of `tags` was hard-revalidated after `seq` (the sequence sampled
 * when the entry began producing). Sequence-based so it is immune to the
 * millisecond-precision ambiguity that plagues `tagsRevalidatedSince` for
 * in-memory entries: an updateTag() and an immediate re-read in the same
 * request reliably see the invalidation exactly once.
 */
export function tagsRevalidatedAfterSeq(tags: readonly string[], seq: number) {
  return tags.some(tag => (revalidatedTagSeq.get(tag) ?? 0) > seq)
}

export function tagsRevalidationReasonSince(
  tags: readonly string[],
  time: number,
): 'stale' | 'on-demand' | undefined {
  for (const tag of tags) {
    if (markedAfter(revalidatedTags.get(tag), time)) {
      return revalidatedTagReasons.get(tag) ?? 'on-demand'
    }
  }
  return undefined
}

export function tagsStaleSince(tags: readonly string[], time: number) {
  return tags.some(tag => markedAfter(staleTags.get(tag), time))
}

interface DataCacheEntry {
  value: Promise<unknown>
  storedAt: number
  tags: readonly string[]
  revalidateSeconds?: number
  /** A background stale-while-revalidate refresh is already in flight. */
  refreshing?: boolean
  /** Pathname of the render that produced this entry (path-revalidation scope). */
  route?: string
  /**
   * The render cache-meta this entry was produced under: an on-demand
   * regeneration (refreshFetches) re-produces each entry once per render, then
   * repeated reads dedupe against it.
   */
  refreshedIn?: object
}

const dataCache = revalidateGlobal('dataCache', () => new Map<string, DataCacheEntry>())
const dataCacheLimit = 1024

function dataCacheEntryExpired(entry: DataCacheEntry) {
  return (
    entry.revalidateSeconds !== undefined &&
    realNow() - entry.storedAt >= entry.revalidateSeconds * 1000
  )
}

export interface DataCacheOptions {
  tags?: string[]
  revalidateSeconds?: number
}

/**
 * Memoize an async producer under a stable key. On-demand invalidation
 * (revalidateTag / an on-demand-revalidating render) blocks and re-produces;
 * TTL expiry serves the stale value while refreshing in the background
 * (Next's stale-while-revalidate data-cache semantics). Rejected results are
 * evicted so errors don't stick.
 */
export function cachedData(
  key: string,
  produce: () => Promise<unknown>,
  options: DataCacheOptions = {},
): Promise<unknown> {
  if (draftModeBypassActive()) return produce()
  const entry = dataCache.get(key)
  const meta = cacheMetaStorage.getStore()
  // On-demand revalidation re-produces each entry ONCE per render (Next skips the cache read entirely
  // under isOnDemandRevalidate), then dedupes via refreshedIn - but only entries the revalidation
  // actually reached. See the matching gate in use-cache.ts: a still-marked route re-renders many times
  // before its prebuilt HTML is written back.
  const refresh =
    meta?.refreshFetches === true &&
    entry?.refreshedIn !== meta &&
    entry !== undefined &&
    (tagsRevalidatedSince(entry.tags, entry.storedAt) ||
      pathScopeRevalidated(entry.route, entry.storedAt) ||
      tagsStaleSince(entry.tags, entry.storedAt) ||
      dataCacheEntryExpired(entry))
  if (
    entry &&
    !refresh &&
    !tagsRevalidatedSince(entry.tags, entry.storedAt) &&
    !pathScopeRevalidated(entry.route, entry.storedAt)
  ) {
    recordCacheTags(entry.tags)
    if (entry.revalidateSeconds !== undefined) {
      recordCacheRevalidate(entry.revalidateSeconds)
    }
    const tagStale = tagsStaleSince(entry.tags, entry.storedAt)
    if (!tagStale && !dataCacheEntryExpired(entry)) return entry.value
    // ISR regeneration renders refetch expired entries inline.
    if (cacheMetaStorage.getStore()?.blockingStaleFetches !== true) {
      if (!entry.refreshing) {
        entry.refreshing = true
        void storeDataCacheEntry(key, produce, options, entry)
      }
      return entry.value
    }
  }
  return storeDataCacheEntry(key, produce, options)
}

function storeDataCacheEntry(
  key: string,
  produce: () => Promise<unknown>,
  options: DataCacheOptions,
  serveStale?: DataCacheEntry,
): Promise<unknown> {
  // Collect the tags of fetches/nested caches produced inside this entry so it
  // inherits them (revalidateTag can then invalidate it), and propagate the
  // aggregate up to an enclosing producer once settled.
  const parentProducerTags = producerTagsStorage.getStore()
  const producerTags = new Set<string>(options.tags ?? [])
  const value = producerTagsStorage.run(producerTags, () => runInsideUnstableCacheProducer(produce))
  // Same contract as the 'use cache' fill: a build prerender's task boundary
  // waits for an in-flight data-cache fill rather than cutting it short, so
  // cached IO still lands in the static shell (core ppr).
  void trackPrerenderCacheFill(value)
  const producingMeta = cacheMetaStorage.getStore()
  const stored: DataCacheEntry = {
    value,
    storedAt: realNow(),
    tags: options.tags ?? [],
    revalidateSeconds: options.revalidateSeconds,
    ...(producingMeta !== undefined ? { refreshedIn: producingMeta } : {}),
    ...(serveStale?.route !== undefined
      ? { route: serveStale.route }
      : producingMeta?.route !== undefined
        ? { route: producingMeta.route }
        : {}),
  }
  const applyInheritedTags = () => {
    stored.tags = [...producerTags]
    if (parentProducerTags) for (const tag of producerTags) parentProducerTags.add(tag)
  }
  if (serveStale) {
    // Background refresh: only replace the stale entry once the new value
    // settles, so concurrent readers keep getting the stale value instantly.
    value.then(
      () => {
        applyInheritedTags()
        dataCache.set(key, stored)
      },
      () => {
        serveStale.refreshing = false
      },
    )
    return value
  }
  if (dataCache.size >= dataCacheLimit) {
    const oldest = dataCache.keys().next().value
    if (oldest !== undefined) dataCache.delete(oldest)
  }
  dataCache.set(key, stored)
  value.then(applyInheritedTags, () => {
    if (dataCache.get(key)?.value === value) dataCache.delete(key)
  })
  return value
}

export function clearRevalidationState() {
  revalidatedPaths.clear()
  revalidatedPathReasons.clear()
  revalidatedTags.clear()
  revalidatedTagSeq.clear()
  counters.tagSeq = 0
  revalidatedTagReasons.clear()
  staleTags.clear()
  revalidatedPatterns.length = 0
  counters.lastPathAt = 0
  dataCache.clear()
  for (const invalidate of dataCacheInvalidators) invalidate()
}

export function registerDataCacheInvalidator(invalidate: () => void): () => void {
  dataCacheInvalidators.add(invalidate)
  return () => {
    dataCacheInvalidators.delete(invalidate)
  }
}

export function registerRevalidationInvalidator(
  invalidate: (invalidation: RevalidationInvalidation) => void,
): () => void {
  revalidationInvalidators.add(invalidate)
  return () => {
    revalidationInvalidators.delete(invalidate)
  }
}

function notifyRevalidationInvalidators(invalidation: RevalidationInvalidation) {
  for (const invalidate of revalidationInvalidators) invalidate(invalidation)
}

/**
 * Cache-meta scope wrapped around a render. Data-cache consumers (patched
 * fetch, unstable_cache, 'use cache') record the tags and revalidate periods
 * they used so the surrounding prerender/ISR write can persist them, and read
 * the route's `fetchCache` segment config for cache-mode defaults.
 */
export interface RenderCacheMeta {
  tags: Set<string>
  revalidateSeconds?: number
  /**
   * Effective `use cache` cacheLife expire/stale windows aggregated across the
   * render's cache scopes (min of each). Recorded alongside revalidateSeconds so
   * a build shell prerender can persist the route's SWR cache-control +
   * x-nextjs-stale-time even when the work-unit stash (used by the live-render
   * response finalizer) is not in scope during the async cache propagation.
   */
  expireSeconds?: number
  staleSeconds?: number
  fetchCache?: string
  /** Route path label for error messages (e.g. invalid fetch revalidate). */
  route?: string
  /** On-demand revalidation render: data caches must refetch and overwrite. */
  refreshFetches?: boolean
  /**
   * ISR regeneration render: TTL-expired data-cache entries refetch inline
   * (blocking) instead of serving stale, so the regenerated page carries
   * fresh data instead of lagging one generation behind.
   */
  blockingStaleFetches?: boolean
  /**
   * The render used an explicit no-store signal (fetch cache:'no-store'/
   * 'no-cache', next.revalidate 0, or unstable_noStore()): the route must not
   * be served from prebuilt output.
   */
  noStore?: boolean
  /**
   * Static-generation render (build prerender or ISR regeneration): a plain
   * fetch with no explicit cache option defaults to caching (Next's
   * force-cache-during-static-generation semantics) instead of per-request.
   */
  prerender?: boolean
  /**
   * True when the surrounding render is a route handler. Route handlers are
   * dynamic by default (Next): an explicitly-uncached fetch (cache:'default')
   * opts the handler out of prebuilt static output, whereas a page with the
   * same fetch simply freezes at prerender time.
   */
  handler?: boolean
  /** True when `dynamic = 'error'` must reject request API access. */
  dynamicError?: boolean
  /**
   * after() work queued during a static-generation render. There is no response close to flush against,
   * so the render itself drains the queue once `produce` settles - Next's semantics: a build prerender
   * waits for after() callbacks, and a rejection fails that page's prerender. Compat's after() enqueues;
   * nothing in the cache layer knows what the tasks are.
   */
  afterTasks?: (() => Promise<void>)[]
}

const cacheMetaStorage = revalidateGlobal(
  'cacheMetaStorage',
  () => new AsyncLocalStorage<RenderCacheMeta>(),
)

export function currentRenderCacheMeta() {
  return cacheMetaStorage.getStore()
}

/**
 * True while producing prebuilt static output - a build-time prerender or an ISR regeneration. In that
 * context a plain fetch with no explicit cache option defaults to caching, matching Next's
 * static-generation force-cache default.
 */
export function currentRenderIsStaticGeneration(): boolean {
  const meta = cacheMetaStorage.getStore()
  return meta?.prerender === true || meta?.blockingStaleFetches === true
}

export function recordCacheTags(tags: readonly string[]) {
  // Inside an unstable_cache producer, inner fetch/cache tags are inherited by
  // the producing entry (Next semantics: an unstable_cache boundary collects the
  // tags of every fetch made inside it, so revalidateTag invalidates the entry).
  const producerTags = producerTagsStorage.getStore()
  if (producerTags) for (const tag of tags) producerTags.add(tag)
  const meta = cacheMetaStorage.getStore()
  if (!meta) return
  for (const tag of tags) meta.tags.add(tag)
}

// Hook into the active `use cache` producer scope (registered by use-cache.ts;
// held on the shared global container so both module copies see it). An
// explicit revalidate recorded while a `use cache` entry is producing lowers
// that ENTRY's cacheLife too, matching Next: a `fetch(..., { next:
// { revalidate: 1 } })` inside 'use cache' bounds the cache entry at 1s, not
// just the surrounding route.
const useCacheRevalidateSink = revalidateGlobal('useCacheRevalidateSink', () => ({
  current: undefined as ((seconds: number) => void) | undefined,
}))

export function setUseCacheRevalidateSink(sink: (seconds: number) => void) {
  useCacheRevalidateSink.current = sink
}

export function recordCacheRevalidate(seconds: number) {
  useCacheRevalidateSink.current?.(seconds)
  const meta = cacheMetaStorage.getStore()
  if (!meta) return
  meta.revalidateSeconds =
    meta.revalidateSeconds === undefined ? seconds : Math.min(meta.revalidateSeconds, seconds)
}

/** Record a `use cache` entry's expire window on the render meta (min-combined). */
export function recordCacheExpire(seconds: number) {
  const meta = cacheMetaStorage.getStore()
  if (!meta) return
  meta.expireSeconds =
    meta.expireSeconds === undefined ? seconds : Math.min(meta.expireSeconds, seconds)
}

/** Record a `use cache` entry's stale window on the render meta (min-combined). */
export function recordCacheStale(seconds: number) {
  const meta = cacheMetaStorage.getStore()
  if (!meta) return
  meta.staleSeconds =
    meta.staleSeconds === undefined ? seconds : Math.min(meta.staleSeconds, seconds)
}

export function recordCacheNoStore() {
  // Inside a data-cache producer (unstable_cache / 'use cache') the cache
  // boundary wins: no-store signals do not leak out to the route.
  if (insideProducerStorage.getStore()) return
  const meta = cacheMetaStorage.getStore()
  if (meta) meta.noStore = true
}

const insideProducerStorage = revalidateGlobal(
  'insideProducerStorage',
  () => new AsyncLocalStorage<boolean>(),
)
const producerKindStorage = revalidateGlobal(
  'producerKindStorage',
  () => new AsyncLocalStorage<'use-cache' | 'unstable-cache'>(),
)
// Tags accumulated by fetches/nested caches inside the currently-producing
// unstable_cache entry (see recordCacheTags / storeDataCacheEntry).
const producerTagsStorage = revalidateGlobal(
  'producerTagsStorage',
  () => new AsyncLocalStorage<Set<string>>(),
)
// A dedicated marker for `unstable_cache` specifically (a subset of the general
// data-cache-producer scope, which `use cache` also enters). Root params read
// inside a `use cache` NESTED within an `unstable_cache` are E1140, which needs
// to tell the two producers apart — the general boolean cannot.
const insideUnstableCacheStorage = revalidateGlobal(
  'insideUnstableCacheStorage',
  () => new AsyncLocalStorage<boolean>(),
)

/** Mark fn as running inside a data-cache producer (see recordCacheNoStore). */
export function runInsideDataCacheProducer<T>(
  fn: () => T,
  kind: 'use-cache' | 'unstable-cache' = 'use-cache',
): T {
  return producerKindStorage.run(kind, () => insideProducerStorage.run(true, fn))
}

/** Mark fn as running specifically inside an `unstable_cache` producer. */
export function runInsideUnstableCacheProducer<T>(fn: () => T): T {
  return insideUnstableCacheStorage.run(true, () =>
    runInsideDataCacheProducer(fn, 'unstable-cache'),
  )
}

/** True while executing inside an unstable_cache / 'use cache' producer. */
export function insideDataCacheProducer(): boolean {
  return insideProducerStorage.getStore() === true
}

/** True while executing specifically inside an `unstable_cache` producer. */
export function insideUnstableCacheProducer(): boolean {
  return insideUnstableCacheStorage.getStore() === true
}

export function insidePublicUseCacheProducer(): boolean {
  return producerKindStorage.getStore() === 'use-cache'
}

/**
 * Fail a build prerender when a dynamic request API (`cookies()`/`headers()`/
 * `connection()`) is invoked inside a function cached with `unstable_cache()`.
 * Called from the compat request-API seams (next/headers, next/server). Records
 * Next's exact E838 error so the build aborts (register/use-cache) and throws so
 * the offending fill unwinds. A no-op outside an armed build prerender and
 * outside an unstable_cache producer, so serving-runtime/dev calls are untouched
 * (there, the same APIs simply read live request data).
 */
export function assertNoDynamicApiInsideCache(
  api: 'cookies()' | 'headers()' | 'connection()',
): void {
  if (!insideDataCacheProducer()) return
  const route = cacheMetaStorage.getStore()?.route ?? ''
  const unstable = insideUnstableCacheProducer()
  const message = unstable
    ? unstableCacheDynamicApiMessage(route, api)
    : useCacheDynamicApiMessage(route, api)
  // Build-time prerenders record the error for the build log; the throw itself
  // is unconditional — Next rejects dynamic data inside a cache scope at
  // request time too (500 / generic RSC error in prod).
  if (prerenderErrorCollectionActive()) {
    recordPrerenderError({
      kind: unstable ? 'unstable-cache-dynamic' : 'use-cache-dynamic',
      route,
      consoleBlock: `Error: ${message}`,
    })
  }
  throw new Error(message)
}

export async function collectRenderCacheMeta<T>(
  produce: () => Promise<T>,
  options: {
    fetchCache?: string
    refreshFetches?: boolean
    blockingStaleFetches?: boolean
    route?: string
    prerender?: boolean
    handler?: boolean
    dynamicError?: boolean
  } = {},
): Promise<{
  value: T
  tags: string[]
  revalidateSeconds?: number
  expireSeconds?: number
  staleSeconds?: number
  noStore?: boolean
}> {
  const meta: RenderCacheMeta = {
    tags: new Set(),
    fetchCache: options.fetchCache,
    refreshFetches: options.refreshFetches,
    blockingStaleFetches: options.blockingStaleFetches,
    route: options.route,
    prerender: options.prerender,
    handler: options.handler,
    dynamicError: options.dynamicError,
  }
  const value = await cacheMetaStorage.run(meta, produce)
  await drainStaticAfterTasks(meta)
  return {
    value,
    tags: [...meta.tags],
    ...(meta.revalidateSeconds !== undefined ? { revalidateSeconds: meta.revalidateSeconds } : {}),
    ...(meta.expireSeconds !== undefined ? { expireSeconds: meta.expireSeconds } : {}),
    ...(meta.staleSeconds !== undefined ? { staleSeconds: meta.staleSeconds } : {}),
    ...(meta.noStore ? { noStore: true } : {}),
  }
}

/**
 * Run the after() tasks queued during a static-generation render, re-draining
 * so a task can enqueue further tasks (nested after()). Tasks run inside the
 * meta scope so nested after() re-enters this queue. During a build prerender
 * a rejection fails the page like Next: print Next's prerender-error line for
 * the route and rethrow so the build skips/fails the page. Runtime
 * regeneration tasks are queued pre-wrapped to log-and-continue, so a
 * rejection here is only possible on the prerender path.
 */
async function drainStaticAfterTasks(meta: RenderCacheMeta): Promise<void> {
  while (meta.afterTasks?.length) {
    const tasks = meta.afterTasks
    meta.afterTasks = []
    for (const task of tasks) {
      try {
        await cacheMetaStorage.run(meta, task)
      } catch (error) {
        console.error(
          `Error occurred prerendering page "${meta.route ?? '/'}". Read more: https://nextjs.org/docs/messages/prerender-error`,
        )
        throw error
      }
    }
  }
}
