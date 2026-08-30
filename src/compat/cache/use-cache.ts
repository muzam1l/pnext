/**
 * Runtime for the 'use cache' directive (minimum honest implementation).
 *
 * A directive-marked function is wrapped by the build-time source rewrite
 * (see use-cache-transform.ts) into `pnextUseCache(id, fn)`: calls memoize
 * per (id + JSON args) in a process-wide store, honoring cacheTag()/
 * cacheLife() from inside the function and revalidateTag() invalidation.
 * Unserializable arguments (functions, cyclic values) bypass the cache.
 *
 * Divergences from Next: values are shared by reference (no RSC
 * serialization boundary), and named custom cache handler kinds fall back to
 * the default handler.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { Fragment, h, type ComponentChildren } from 'preact'
import { Suspense as CoreSuspense } from '../../api/suspense'
import { currentParams, currentRequest, getWorkUnit } from '../../request/context'
import {
  hangingPromise,
  isPrefetchShellPrerender,
  isPrerendering,
  isRuntimePrefetchPrerender,
  markRuntimeApiOnAwait,
  PostponeError,
  realNow,
  trackPrerenderCacheFill,
} from '../../render/ppr'
import {
  currentRenderCacheMeta,
  currentTagRevalidationSeq,
  rdcProcessId,
  rebaseRdcTagSeq,
  draftModeBypassActive,
  pathScopeRevalidated,
  recordCacheExpire,
  recordCacheNoStore,
  recordCacheRevalidate,
  recordCacheStale,
  recordCacheTags,
  runInsideDataCacheProducer,
  setUseCacheRevalidateSink,
  tagsRevalidatedAfterSeq,
  tagsStaleSince,
} from './revalidate'
import {
  hasModernCacheHandler,
  modernCacheEntry,
  modernCacheGet,
  modernCacheGetExpiration,
  modernCacheKey,
  modernCacheRefreshTags,
  modernCacheSet,
} from './modern-handler'
import { funnelCacheRuntimeError } from './runtime-error'
import {
  prerenderErrorCollectionActive,
  recordPrerenderError,
  routeFromCacheId,
  useCacheSearchParamsMessage,
  USE_CACHE_CLOSE_OVER_FUNCTION_BLOCK,
  USE_CACHE_CLOSE_OVER_FUNCTION_MESSAGE,
  USE_CACHE_HANGING_MESSAGE,
} from './build-prerender-errors'

// ---------------------------------------------------------------------------
// Build-prerender `use cache` fill timeout (E236 hanging-input detection).
//
// A `use cache` fill that never resolves during a build prerender would hang
// the build forever. Next races the fill against `experimental.useCacheTimeout`
// (seconds) and, on timeout, rejects with the E236 message. We mirror that only
// while a compat build prerender is armed (see build-prerender-errors); the
// serving runtime and pure-core builds are untouched. The value is seeded from
// next.config by register/use-cache at build start.
// ---------------------------------------------------------------------------

// Anchored on globalThis: begin/seed runs in the build process's copy of this
// module, but `withFillTimeout` runs in the bundled compat-server's copy — a
// module-local `let` would leave the bundle reading the stale default (see the
// same duplication note in build-prerender-errors.ts).
const USE_CACHE_FILL_TIMEOUT = Symbol.for('pnext.compat.useCacheFillTimeout')

function fillTimeoutHolder(): { ms: number } {
  const root = globalThis as Record<PropertyKey, unknown>
  return (root[USE_CACHE_FILL_TIMEOUT] ??= { ms: 50_000 }) as { ms: number }
}

/**
 * Seed the build-time `use cache` fill timeout (milliseconds). Next derives it
 * from `experimental.useCacheTimeout`, clamped during a build to just under
 * `staticPageGenerationTimeout` (register/use-cache passes the already-resolved
 * value). Ignored (left at the 50s default) when undefined.
 */
export function setUseCacheFillTimeout(ms: number | undefined): void {
  if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) {
    fillTimeoutHolder().ms = ms
  }
}

interface UseCacheEntry {
  value: Promise<unknown>
  storedAt: number
  tags: string[]
  revalidateSeconds?: number
  expireSeconds?: number
  staleSeconds?: number
  /** A background stale-while-revalidate refresh is already in flight. */
  refreshing?: boolean
  modernKey?: string
  /** Pathname of the render that produced this entry (path-revalidation scope). */
  route?: string
  /** Hard-tag-revalidation sequence sampled when production began. */
  tagSeq: number
  /**
   * The render cache-meta this entry was produced under. An on-demand
   * regeneration render (refreshFetches) re-produces each entry ONCE and then
   * reuses it, so repeated reads within the regen dedupe (Next refreshes per
   * unique cache, not per call).
   */
  refreshedIn?: object
  /**
   * Nested `use cache` wrapper vnodes embedded in this entry's produced tree
   * that have not yet rendered. Their scopes fold tags + min cacheLife into
   * this entry when they settle (see attributeNestedCacheWrapper); persisting
   * the entry to a modern cache handler waits for the count to drain.
   */
  nestedPending?: number
  /** Invoked each time a pending nested wrapper settles. */
  onNestedSettled?: () => void
}

type RdcValue = null | boolean | number | string | RdcValue[] | { [key: string]: RdcValue }

export interface UseCacheRdcRecord {
  key: string
  value: RdcValue
  tags: string[]
  storedAt: number
  revalidateSeconds?: number
  expireSeconds?: number
  staleSeconds?: number
  tagSeq: number
  /** Process that produced this record — `tagSeq` only means anything there. */
  pid?: string
  route?: string
}

interface UseCacheScope {
  tags: Set<string>
  revalidateSeconds?: number
  expireSeconds?: number
  staleSeconds?: number
  /**
   * The cached-function id producing inside this scope. Root-param reads made
   * during production attribute to this id so the id's read-set (see
   * knownRootParamsByFunctionId) widens and later calls key on those params.
   */
  functionId?: string
  /** Root param NAMES read (via next/root-params) while producing this entry. */
  rootParamsRead?: Set<string>
}

const USE_CACHE_ENTRIES = Symbol.for('pnext.compat.useCacheEntries')
const USE_CACHE_SCOPE_STORAGE = Symbol.for('pnext.compat.useCacheScopeStorage')
const USE_CACHE_KNOWN_ROOT_PARAMS = Symbol.for('pnext.compat.knownRootParamsByFunctionId')
const USE_CACHE_REQUEST_TOKENS = Symbol.for('pnext.compat.useCacheRequestTokens')

function useCacheGlobal<T>(key: symbol, create: () => T): T {
  const state = globalThis as Record<PropertyKey, unknown>
  const existing = state[key] as T | undefined
  if (existing !== undefined) return existing
  const value = create()
  state[key] = value
  return value
}

const entries = useCacheGlobal(USE_CACHE_ENTRIES, () => new Map<string, UseCacheEntry>())
const entriesLimit = 4096
const scopeStorage = useCacheGlobal(
  USE_CACHE_SCOPE_STORAGE,
  () => new AsyncLocalStorage<UseCacheScope>(),
)
const requestTokens = useCacheGlobal(USE_CACHE_REQUEST_TOKENS, () => new WeakMap<object, object>())
const USE_CACHE_RDC_CAPTURE = Symbol.for('pnext.compat.useCacheRdcCapture')
const USE_CACHE_RDC_RECORDS = Symbol.for('pnext.compat.useCacheRdcRecords')

function useCacheRdcRecords(): Map<string, UseCacheRdcRecord> {
  return useCacheGlobal(USE_CACHE_RDC_RECORDS, () => new Map<string, UseCacheRdcRecord>())
}

function useCacheRdcCapture(): Set<string> | undefined {
  return (globalThis as Record<PropertyKey, unknown>)[USE_CACHE_RDC_CAPTURE] as
    Set<string> | undefined
}

function captureUseCacheRdcEntry(key: string) {
  useCacheRdcCapture()?.add(key)
}

export function beginUseCacheRdcCapture() {
  ;(globalThis as Record<PropertyKey, unknown>)[USE_CACHE_RDC_CAPTURE] = new Set<string>()
}

export async function collectUseCacheRdcRecords(): Promise<UseCacheRdcRecord[]> {
  const capture = useCacheRdcCapture()
  if (!capture) return []
  const records: UseCacheRdcRecord[] = []
  for (const key of capture) {
    const entry = entries.get(key)
    if (!entry) continue
    const value = toRdcValue(await entry.value)
    if (value === undefined) continue
    records.push({
      key,
      value,
      tags: [...entry.tags],
      storedAt: entry.storedAt,
      ...(entry.revalidateSeconds !== undefined
        ? { revalidateSeconds: entry.revalidateSeconds }
        : {}),
      ...(entry.expireSeconds !== undefined ? { expireSeconds: entry.expireSeconds } : {}),
      ...(entry.staleSeconds !== undefined ? { staleSeconds: entry.staleSeconds } : {}),
      tagSeq: entry.tagSeq,
      pid: rdcProcessId(),
      ...(entry.route !== undefined ? { route: entry.route } : {}),
    })
  }
  return records
}

/**
 * Union of the tags of every entry captured this prerender - INCLUDING entries whose value cannot
 * serialize into an RDC record. A page-level `use cache` caches its rendered tree; the tree is
 * unserializable but its cacheTag()s must still reach the shell's staleness check.
 */
export async function collectUseCacheRdcTags(): Promise<string[]> {
  const capture = useCacheRdcCapture()
  if (!capture) return []
  const tags = new Set<string>()
  for (const key of capture) {
    const entry = entries.get(key)
    if (!entry) continue
    // Tags are applied to the entry once its production settles.
    await entry.value.catch(() => undefined)
    for (const tag of entry.tags) tags.add(tag)
  }
  return [...tags]
}

export function seedUseCacheRdcRecords(records: readonly UseCacheRdcRecord[], route?: string) {
  for (const record of records) {
    if (!isUseCacheRdcRecord(record)) continue
    // Foreign-process sequences are meaningless here — see rebaseRdcTagSeq.
    const tagSeq = rebaseRdcTagSeq(record)
    // An RDC artifact is a snapshot: seeding it must never regress a live
    // entry produced more recently (each regen seeds the stale .rdc first).
    const live = entries.get(record.key)
    if (live !== undefined && live.storedAt > record.storedAt) continue
    useCacheRdcRecords().set(record.key, { ...record, tagSeq })
    entries.set(record.key, {
      value: Promise.resolve(record.value),
      storedAt: record.storedAt,
      tags: [...record.tags],
      ...(record.revalidateSeconds !== undefined
        ? { revalidateSeconds: record.revalidateSeconds }
        : {}),
      ...(record.expireSeconds !== undefined ? { expireSeconds: record.expireSeconds } : {}),
      ...(record.staleSeconds !== undefined ? { staleSeconds: record.staleSeconds } : {}),
      tagSeq,
      ...(route !== undefined
        ? { route }
        : record.route !== undefined
          ? { route: record.route }
          : {}),
    })
  }
}

function isUseCacheRdcRecord(value: unknown): value is UseCacheRdcRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<UseCacheRdcRecord>
  return (
    typeof record.key === 'string' &&
    Array.isArray(record.tags) &&
    record.tags.every(tag => typeof tag === 'string') &&
    typeof record.storedAt === 'number' &&
    Number.isFinite(record.storedAt) &&
    typeof record.tagSeq === 'number' &&
    Number.isInteger(record.tagSeq) &&
    isRdcValue(record.value)
  )
}

function toRdcValue(value: unknown): RdcValue | undefined {
  if (!isRdcValue(value)) return undefined
  return JSON.parse(JSON.stringify(value)) as RdcValue
}

function isRdcValue(value: unknown, seen = new WeakSet<object>()): value is RdcValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || seen.has(value)) return false
  if (Array.isArray(value)) {
    seen.add(value)
    return value.every(item => isRdcValue(item, seen))
  }
  const prototype = Object.getPrototypeOf(value) as object | null
  if (prototype !== Object.prototype && prototype !== null) return false
  seen.add(value)
  return Object.values(value).every(item => isRdcValue(item, seen))
}

// ---------------------------------------------------------------------------
// Root-param cache-key participation (Stage B-3).
//
// Root params (next/root-params) implicitly join a `use cache` entry's key: two
// invocations under different root params must not share a cached value. But the
// key is computed BEFORE the function runs, and which root params a function
// reads is only discovered DURING production ("conditional reads"). So we track,
// per cached-function id, the set of root-param NAMES it has been observed to
// read, and widen the key on subsequent invocations by joining those params'
// current values. The read-set only grows (a param read on a later, branch-
// dependent invocation upgrades the key for that id going forward), matching
// Next's `knownRootParamsByFunctionId`.
//
// The values are sourced from the request param ALS (currentParams) at key-build
// time; a root param is a plain string / string[] (catch-all) / undefined
// (absent optional catch-all).
// ---------------------------------------------------------------------------

const knownRootParamsByFunctionId = useCacheGlobal(
  USE_CACHE_KNOWN_ROOT_PARAMS,
  () => new Map<string, Set<string>>(),
)

// The app's ROOT param names (segments at/above a root layout), seeded from the
// build-time scan at registration. Anchored on globalThis so the build process
// and the built server bundle read one copy. Only these names may join a cache
// key: a non-root route param must never discriminate entries, and a fallback
// prerender's unknown params must never poison the key.
const USE_CACHE_ROOT_PARAM_NAMES = Symbol.for('pnext.compat.rootParamNames')

/** Seed the scanned root-param name set (register/use-cache, build + serve). */
export function setUseCacheRootParamNames(names: Iterable<string>): void {
  ;(globalThis as Record<PropertyKey, unknown>)[USE_CACHE_ROOT_PARAM_NAMES] = new Set(names)
}

function rootParamNames(): Set<string> | undefined {
  return (globalThis as Record<PropertyKey, unknown>)[USE_CACHE_ROOT_PARAM_NAMES] as
    Set<string> | undefined
}

/**
 * Called by next/root-params' `rootParam(name)` when read inside a `use cache`
 * producer: record the name against the producing function id so future calls
 * key on it. Returns true when a use-cache producer scope was active (the read
 * participated in a cache key); false otherwise (plain request read).
 */
export function recordUseCacheRootParamRead(name: string): boolean {
  const scope = scopeStorage.getStore()
  if (!scope?.functionId) return false
  ;(scope.rootParamsRead ??= new Set()).add(name)
  let known = knownRootParamsByFunctionId.get(scope.functionId)
  if (!known) {
    known = new Set()
    knownRootParamsByFunctionId.set(scope.functionId, known)
  }
  known.add(name)
  return true
}

/** True when a `use cache` producer is currently on the stack (E1140 guard). */
export function insideUseCacheProducer(): boolean {
  return scopeStorage.getStore()?.functionId !== undefined
}

/**
 * Extend the raw cache-key args for `id` with the current values of every root
 * param the id has been observed to read. Sourced lazily so a param discovered
 * on a later invocation immediately participates. Returns the args unchanged
 * when the id has no known root-param reads.
 */
function withRootParamKeyArgs(id: string, args: unknown[]): unknown[] {
  const known = knownRootParamsByFunctionId.get(id)
  const params = currentParams()
  // The first call has no observed read-set yet, but it must still not seed a cross-root entry. Once
  // reads are known, narrow back to that set; until then every KNOWN (resolved) root param is a
  // conservative cache discriminator - never non-root route params (they must not split entries) and
  // never a fallback prerender's unfilled params (they must not poison the key). Over-discrimination
  // costs a duplicate entry, under-discrimination shares a value across roots.
  const roots = rootParamNames()
  const names = known?.size
    ? [...known]
    : Object.keys(params).filter(name => (!roots || roots.has(name)) && params[name] !== undefined)
  if (names.length === 0) return args
  // Stable order (sorted names) so the key is deterministic regardless of the
  // order reads were discovered in.
  const rootParamEntries = names.sort().map(name => [name, params[name]] as const)
  return [{ $pnextRootParams: rootParamEntries }, ...args]
}

/** Test hook. */
export function clearKnownRootParams() {
  knownRootParamsByFunctionId.clear()
}

// Next's `default` cacheLife profile, applied to a `use cache` entry that never
// calls cacheLife(). Kept here (not read from config) so the runtime has no
// dependency on the compat config loader; a config `expireTime`/custom default
// override only affects explicit cacheLife() calls (see compat/next/cache.ts).
const DEFAULT_REVALIDATE_SECONDS = 900
const DEFAULT_EXPIRE_SECONDS = 31536000
const DEFAULT_STALE_SECONDS = 300

// A runtime prefetch (`unstable_instant`) includes a `use cache` scope only when its effective STALE
// window is at least this long; a shorter-lived cache stays a postponed hole. The threshold applies to
// `stale` ONLY, never `expire` - a public cache with a short expire but a long stale is still included.
const RUNTIME_PREFETCH_DYNAMIC_STALE = 30

// A STATIC prerender whose output the client prefetches omits a `use cache` scope that expires inside
// this window: data that short-lived is not worth prerendering, so its boundary stays a hole the
// navigation fills live. Note the two thresholds read DIFFERENT fields: a runtime prefetch gates on
// `stale` (a short-expire/long-stale cache is still prefetchable), a static prefetch shell on `expire`.
const PREFETCH_SHELL_DYNAMIC_EXPIRE = 300

/** How the active prerender gates a short-lived `use cache` scope, if at all. */
function prefetchCacheGate(): 'stale' | 'expire' | null {
  if (isRuntimePrefetchPrerender()) return 'stale'
  if (isPrefetchShellPrerender()) return 'expire'
  return null
}

/**
 * Gate a `use cache` result for a prerender whose output is PREFETCHED. The effective cacheLife is only
 * known once the scope has produced (cacheLife() runs inside it), so resolve the value first, then swap
 * it for a hanging promise - the same postpone mechanism connection() uses - when the window the gate
 * looks at falls short of its threshold.
 */
function gatePrefetchCacheLife<T>(
  result: Promise<T>,
  gate: 'stale' | 'expire',
  life: () => { staleSeconds?: number; expireSeconds?: number } | undefined,
): Promise<T> {
  // Awaiting a cache read inside a runtime prefetch arms the sync-IO abort, the
  // same way awaiting cookies()/params does (identity for the shell gate).
  return markRuntimeApiOnAwait(
    Promise.resolve(result).then(value => {
      const effective = life()
      const short =
        gate === 'stale'
          ? (effective?.staleSeconds ?? DEFAULT_STALE_SECONDS) < RUNTIME_PREFETCH_DYNAMIC_STALE
          : (effective?.expireSeconds ?? DEFAULT_EXPIRE_SECONDS) < PREFETCH_SHELL_DYNAMIC_EXPIRE
      if (short) return hangingPromise<T>('use cache')
      return value
    }),
  )
}

// ---------------------------------------------------------------------------
// cacheLife/response-header plumbing.
//
// A `use cache` entry's cacheLife (revalidate/expire/stale) is stashed on the
// request work unit as it resolves during a render; the register/use-cache
// responseFinalizer reads the aggregate and emits the SWR `cache-control` +
// `x-nextjs-stale-time` headers (mirroring how the font runtime stashes
// preloads for a `Link` header). Only the LONGEST-lived cache scope on the
// page drives the page's cache-control (Next lowers by the min revalidate but
// the page header reflects the effective revalidate/expire/stale of the route).
// ---------------------------------------------------------------------------

/** Well-known key for the per-request cache-life aggregate stash. */
export const USE_CACHE_LIFE = Symbol.for('pnext.compat.useCacheLife')

export interface CacheLifeStash {
  revalidateSeconds?: number
  expireSeconds?: number
  staleSeconds?: number
}

function stashCacheLife(life: CacheLifeStash): void {
  if (
    life.revalidateSeconds === undefined &&
    life.expireSeconds === undefined &&
    life.staleSeconds === undefined
  ) {
    return
  }
  const unit = getWorkUnit()
  if (!unit) return
  const compat = (unit.compat ??= {})
  const existing = (compat[USE_CACHE_LIFE] as CacheLifeStash | undefined) ?? {}
  // Track the minimum revalidate (Next lowers the page revalidate to the
  // shortest cache used) but pair it with that same entry's expire so the
  // emitted SWR window is self-consistent.
  const nextRevalidate = minDefined(existing.revalidateSeconds, life.revalidateSeconds)
  const drivenByThis =
    life.revalidateSeconds !== undefined && life.revalidateSeconds === nextRevalidate
  // `staleSeconds` is its OWN minimum, NOT the min-revalidate entry's: the
  // client router cache is only as fresh as the shortest-lived content on the
  // page, and coupling it let whichever scope rendered first win the window
  // whenever the revalidates tied (the default case).
  const nextStale = minDefined(existing.staleSeconds, life.staleSeconds)
  compat[USE_CACHE_LIFE] = {
    ...(nextRevalidate !== undefined ? { revalidateSeconds: nextRevalidate } : {}),
    ...(drivenByThis
      ? { ...(life.expireSeconds !== undefined ? { expireSeconds: life.expireSeconds } : {}) }
      : {
          ...(existing.expireSeconds !== undefined
            ? { expireSeconds: existing.expireSeconds }
            : {}),
        }),
    ...(nextStale !== undefined ? { staleSeconds: nextStale } : {}),
  }
}

/** Read + clear the cache-life aggregate stashed during the current render. */
export function takeCacheLifeStash(): CacheLifeStash | undefined {
  const unit = getWorkUnit()
  const compat = unit?.compat
  if (!compat) return undefined
  const life = compat[USE_CACHE_LIFE] as CacheLifeStash | undefined
  compat[USE_CACHE_LIFE] = undefined
  return life
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.min(a, b)
}

// An explicit data-cache revalidate (e.g. `fetch(..., { next: { revalidate } })`
// or a nested unstable_cache read) recorded while a `use cache` entry is
// producing lowers the producing entry's own cacheLife, matching Next.
setUseCacheRevalidateSink(seconds => {
  recordUseCacheLife(seconds)
})

/** cacheTag() inside a 'use cache' function: tag the active entry. */
export function recordUseCacheTags(tags: readonly string[]): boolean {
  const scope = scopeStorage.getStore()
  if (!scope) return false
  for (const tag of tags) scope.tags.add(tag)
  return true
}

/** cacheLife() inside a 'use cache' function: bound the active entry's TTL. */
export function recordUseCacheLife(life: number | CacheLifeStash): boolean {
  const scope = scopeStorage.getStore()
  if (!scope) return false
  const revalidate = typeof life === 'number' ? life : life.revalidateSeconds
  const expire = typeof life === 'number' ? undefined : life.expireSeconds
  const stale = typeof life === 'number' ? undefined : life.staleSeconds
  if (revalidate !== undefined) {
    scope.revalidateSeconds =
      scope.revalidateSeconds === undefined
        ? revalidate
        : Math.min(scope.revalidateSeconds, revalidate)
  }
  if (expire !== undefined) {
    scope.expireSeconds =
      scope.expireSeconds === undefined ? expire : Math.min(scope.expireSeconds, expire)
  }
  if (stale !== undefined) {
    scope.staleSeconds =
      scope.staleSeconds === undefined ? stale : Math.min(scope.staleSeconds, stale)
  }
  return true
}

function entryExpired(entry: UseCacheEntry) {
  return (
    entry.revalidateSeconds !== undefined &&
    realNow() - entry.storedAt >= entry.revalidateSeconds * 1000
  )
}

/** Propagate an entry's cache meta to the surrounding render/'use cache' scopes. */
function propagate(entry: UseCacheEntry, parent?: UseCacheScope) {
  const { tags, revalidateSeconds, expireSeconds, staleSeconds } = entry
  recordCacheTags(tags)
  if (revalidateSeconds !== undefined) recordCacheRevalidate(revalidateSeconds)
  // Also aggregate the expire/stale windows onto the render meta so a build
  // shell prerender can persist the route's SWR headers (the work-unit stash
  // below is not in scope during this async propagation — see build.ts).
  if (expireSeconds !== undefined) recordCacheExpire(expireSeconds)
  if (staleSeconds !== undefined) recordCacheStale(staleSeconds)
  // Stash the effective cache-life on the request work unit so the finalizer
  // can emit the SWR cache-control + x-nextjs-stale-time headers.
  stashCacheLife({
    ...(revalidateSeconds !== undefined ? { revalidateSeconds } : {}),
    ...(expireSeconds !== undefined ? { expireSeconds } : {}),
    ...(staleSeconds !== undefined ? { staleSeconds } : {}),
  })
  if (parent) propagateToParent(entry, parent)
}

function propagateToParent(entry: UseCacheEntry, parent: UseCacheScope): void {
  for (const tag of entry.tags) parent.tags.add(tag)
  parent.revalidateSeconds = minDefined(parent.revalidateSeconds, entry.revalidateSeconds)
  parent.expireSeconds = minDefined(parent.expireSeconds, entry.expireSeconds)
  parent.staleSeconds = minDefined(parent.staleSeconds, entry.staleSeconds)
}

export function pnextUseCache<Args extends unknown[], Result>(
  id: string,
  fn: (...args: Args) => Result,
): (...args: Args) => Result {
  const wrapper = (...args: Args): Result => {
    const serializedArgs = installSearchParamsTripwire(serializeCacheBoundaryArgs(args), id) as Args
    // Draft mode skips cache reads/writes but KEEPS the cache-scope rules:
    // dynamic APIs (cookies()/headers()) inside 'use cache' still throw.
    if (draftModeBypassActive()) return draftBypassRun(id, fn, serializedArgs)
    // Element-like arguments become indexed holes: they never affect the key
    // (an element keys as an opaque token either way), the produced tree embeds
    // the hole markers, and each invocation re-instantiates it with ITS fills.
    const holes = extractElementHoles(serializedArgs)
    const keyArgs = declaredArgs(fn, serializedArgs)
    const key = cacheKeyFor(id, withRootParamKeyArgs(id, keyArgs))
    if (isPromiseLike(key)) {
      return key.then(
        resolvedKey => {
          if (resolvedKey === null) return fn(...serializedArgs)
          return readOrProduceEntry(
            resolvedKey,
            id,
            argsJsonFromKey(id, resolvedKey),
            fn,
            holes.args as Args,
            holes.fills,
          )
        },
        () => fn(...serializedArgs),
      ) as Result
    }
    if (key === null) return fn(...serializedArgs)

    return readOrProduceEntry(
      key,
      id,
      argsJsonFromKey(id, key),
      fn,
      holes.args as Args,
      holes.fills,
    )
  }
  ;(wrapper as unknown as Record<symbol, unknown>)[USE_CACHE_WRAPPER] = true
  return wrapper
}

// ---------------------------------------------------------------------------
// searchParams-inside-`use cache` detection (E842).
//
// A cached page receives `{ params, searchParams }` props. Awaiting
// `searchParams` INSIDE the cache scope is unsupported (it is dynamic request
// data). Next passes a searchParams promise that rejects with E842 when read
// inside a cache scope; we mirror it during a build prerender by swapping the
// props' `searchParams` for a tripwire thenable. The tripwire only fires when
// awaited while a `use cache` producer is on the stack (insideUseCacheProducer),
// so cache-key computation (which resolves it OUTSIDE any producer scope) sees
// the real value, and a page that never awaits searchParams (search-params-
// unused) is never tripped. The violation is recorded even when the page catches
// the throw (search-params-caught) so the build still fails.
// ---------------------------------------------------------------------------

function installSearchParamsTripwire(args: unknown[], id: string): unknown[] {
  if (!prerenderErrorCollectionActive()) return args
  const route = routeFromCacheId(id)
  let changed = false
  const out = args.map(arg => {
    if (
      arg !== null &&
      typeof arg === 'object' &&
      !Array.isArray(arg) &&
      !isPromiseLike(arg) &&
      !isElementLike(arg) &&
      isPromiseLike((arg as Record<string, unknown>).searchParams)
    ) {
      changed = true
      return {
        ...arg,
        searchParams: searchParamsTripwire(route, (arg as Record<string, unknown>).searchParams),
      }
    }
    return arg
  })
  return changed ? out : args
}

function withFillTimeout(value: Promise<unknown>, route: string | undefined): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      recordPrerenderError({
        kind: 'hanging',
        route: route ?? '',
        consoleBlock: `Error: ${USE_CACHE_HANGING_MESSAGE}`,
      })
      reject(new Error(USE_CACHE_HANGING_MESSAGE))
    }, fillTimeoutHolder().ms)
    // The timer must not keep the build process alive past the fill settling.
    if (typeof timer.unref === 'function') timer.unref()
    const clear = () => clearTimeout(timer)
    void value.then(resolve, reject).then(clear, clear)
  })
}

function searchParamsTripwire(route: string, real: unknown): PromiseLike<unknown> {
  return {
    then<TResult1 = unknown, TResult2 = never>(
      onFulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
      onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      if (insideUseCacheProducer()) {
        const message = useCacheSearchParamsMessage(route)
        recordPrerenderError({ kind: 'search-params', route, consoleBlock: `Error: ${message}` })
        return Promise.reject(new Error(message)).then(onFulfilled, onRejected)
      }
      return Promise.resolve(real).then(onFulfilled, onRejected)
    },
  }
}

/**
 * `use cache` wrapper for a function that closes over enclosing-scope bindings. Next's compiler encodes
 * closed-over values as bound arguments so they participate in the cache key; the regex transform
 * cannot rewrite the closure, so the captured values are threaded in via `capture()` - evaluated at
 * call time in the closure's scope - and prepended to the key args. The captured values are keyed on
 * but NOT passed to `fn` (the closure reads them directly), matching Next's bound-arg semantics.
 */
export function pnextUseCacheBound<Args extends unknown[], Result>(
  id: string,
  fn: (...args: Args) => Result,
  capture: () => unknown[],
): (...args: Args) => Result {
  const wrapper = (...args: Args): Result => {
    const serializedArgs = serializeCacheBoundaryArgs(args) as Args
    if (draftModeBypassActive()) return draftBypassRun(id, fn, serializedArgs)
    let captured: unknown[]
    try {
      captured = serializeCacheBoundaryArgs(capture())
    } catch {
      return fn(...serializedArgs)
    }
    // Close-over-function detection: a `use cache` closure that captures a non-serializable function
    // cannot cross the cache/RSC boundary. During a build prerender, reject with Next's "Functions
    // cannot be passed directly to Client Components..." error, recorded so the build fails. Gated on
    // the armed build-prerender window, since the cache-components shell path sets no render cache-meta.
    if (prerenderErrorCollectionActive() && captured.some(value => typeof value === 'function')) {
      recordPrerenderError({
        kind: 'close-over',
        route: routeFromCacheId(id),
        consoleBlock: USE_CACHE_CLOSE_OVER_FUNCTION_BLOCK,
      })
      throw new Error(USE_CACHE_CLOSE_OVER_FUNCTION_MESSAGE)
    }
    const holes = extractElementHoles(serializedArgs)
    const keyArgs = [captured, ...declaredArgs(fn, serializedArgs)]
    const key = cacheKeyFor(id, withRootParamKeyArgs(id, keyArgs))
    if (isPromiseLike(key)) {
      return key.then(
        resolvedKey => {
          if (resolvedKey === null) return fn(...serializedArgs)
          return readOrProduceEntry(
            resolvedKey,
            id,
            argsJsonFromKey(id, resolvedKey),
            fn,
            holes.args as Args,
            holes.fills,
          )
        },
        () => fn(...serializedArgs),
      ) as Result
    }
    if (key === null) return fn(...serializedArgs)
    return readOrProduceEntry(
      key,
      id,
      argsJsonFromKey(id, key),
      fn,
      holes.args as Args,
      holes.fills,
    )
  }
  ;(wrapper as unknown as Record<symbol, unknown>)[USE_CACHE_WRAPPER] = true
  return wrapper
}

/**
 * `use cache: private` wrapper. Private caches are NOT shared across requests
 * (they may read request data), but Next still dedupes identical invocations
 * WITHIN a single request: two calls with the same args resolve to one value.
 * We memoize on a per-request store keyed on the work unit, so concurrent
 * requests each get their own store (no cross-request sharing) while repeated
 * calls inside one render join the same in-flight result. recordCacheNoStore()
 * keeps the owning route dynamic.
 */
export function pnextUseCachePrivate<Args extends unknown[], Result>(
  id: string,
  fn: (...args: Args) => Result,
): (...args: Args) => Result {
  const wrapper = (...args: Args): Result => {
    recordCacheNoStore()
    // Private caches are EXCLUDED from prerenders: they may read per-request data, so a build/shell
    // prerender postpones the scope (a dynamic hole under the nearest Suspense boundary; a classic
    // static prerender skips the route to dynamic) and the function is evaluated per request instead.
    // EXCEPTION: a runtime prefetch samples the real request, so a private cache with a long enough
    // stale window IS included; a shorter-lived one stays a postponed hole.
    if (isPrerendering()) {
      if (!isRuntimePrefetchPrerender()) throw new PostponeError('use cache: private')
      return runtimePrefetchPrivate(id, fn, serializeCacheBoundaryArgs(args) as Args) as Result
    }
    const serializedArgs = serializeCacheBoundaryArgs(args) as Args
    if (draftModeBypassActive()) return draftBypassRun(id, fn, serializedArgs)
    // Run the REQUEST-TIME body inside a cache scope too (the prerender path
    // already does, via runtimePrefetchPrivate): without one, a cacheLife()
    // inside a `use cache: private` body is a no-op for the response aggregate,
    // so its stale window never reaches x-nextjs-stale-time and the client
    // reuses the navigation for the page's LONGEST window instead.
    const runScoped = (call: () => Result): Result => {
      const scope: UseCacheScope = { tags: new Set(), functionId: id }
      const result = scopeStorage.run(scope, call)
      const settle = () => {
        if (scope.staleSeconds !== undefined) stashCacheLife({ staleSeconds: scope.staleSeconds })
      }
      if (isPromiseLike(result)) {
        return (result as PromiseLike<unknown>).then(value => {
          settle()
          return value
        }) as Result
      }
      settle()
      return result
    }
    const store = privateCacheStore()
    if (!store) return runScoped(() => fn(...serializedArgs))
    const keyArgs = declaredArgs(fn, serializedArgs)
    const key = cacheKeyFor(id, keyArgs)
    if (isPromiseLike(key)) {
      return key.then(
        resolvedKey =>
          resolvedKey === null
            ? runScoped(() => fn(...serializedArgs))
            : runScoped(() => privateMemo(store, resolvedKey, fn, serializedArgs)),
        () => runScoped(() => fn(...serializedArgs)),
      ) as Result
    }
    if (key === null) return runScoped(() => fn(...serializedArgs))
    return runScoped(() => privateMemo(store, key, fn, serializedArgs))
  }
  ;(wrapper as unknown as Record<symbol, unknown>)[USE_CACHE_WRAPPER] = true
  return wrapper
}

/**
 * Produce a `use cache: private` scope inside a runtime-prefetch prerender and
 * gate it on its effective stale window. Runs inside a cache SCOPE (so
 * cacheLife() is captured) but deliberately NOT inside the data-cache producer:
 * a private cache is allowed to read request data (cookies()/headers()), which
 * a data-cache producer scope would reject. The value is discarded and the
 * boundary postpones when the stale window is under
 * RUNTIME_PREFETCH_DYNAMIC_STALE.
 */
function runtimePrefetchPrivate<Args extends unknown[], Result>(
  id: string,
  fn: (...args: Args) => Result,
  args: Args,
): Promise<unknown> {
  const scope: UseCacheScope = { tags: new Set(), functionId: id }
  const produced = (async () => await scopeStorage.run(scope, () => fn(...args)))()
  // Awaiting the private cache arms the sync-IO abort (see gatePrefetchCacheLife).
  return markRuntimeApiOnAwait(
    produced.then(value => {
      const stale = scope.staleSeconds ?? DEFAULT_STALE_SECONDS
      if (stale < RUNTIME_PREFETCH_DYNAMIC_STALE) return hangingPromise('use cache: private')
      // The sampled value IS in this response, so the response is only as fresh
      // as that private window — the runtime-prefetch payload must expire with
      // it, not with the (longer) public `use cache` window baked into the
      // route's segment meta.
      recordCacheStale(stale)
      return value
    }),
  )
}

/** Well-known key for the per-request private-cache dedup store. */
const PRIVATE_CACHE_STORE = Symbol.for('pnext.compat.privateCacheStore')

// Fallback per-request private-cache store, used when a private `use cache`
// resolves outside the work-unit ALS but still inside the request ALS. Keyed on
// the request object (WeakMap → auto-evicts when the request is GC'd), anchored
// on globalThis so the build orchestrator and the built server bundle share it.
const PRIVATE_STORE_BY_REQUEST = Symbol.for('pnext.compat.privateStoreByRequest')
const privateStoreByRequest = useCacheGlobal(
  PRIVATE_STORE_BY_REQUEST,
  () => new WeakMap<object, Map<string, unknown>>(),
)

function privateCacheStore(): Map<string, unknown> | undefined {
  const unit = getWorkUnit()
  if (unit) {
    const compat = (unit.compat ??= {})
    let store = compat[PRIVATE_CACHE_STORE] as Map<string, unknown> | undefined
    if (!store) {
      store = new Map<string, unknown>()
      compat[PRIVATE_CACHE_STORE] = store
    }
    return store
  }
  // Async server components may resolve outside the work-unit ALS (the renderer re-enters the request
  // ALS, but not always the work unit), and Next still dedupes identical private-cache invocations
  // WITHIN one request. Fall back to a per-request store keyed on the live request object, so two
  // placements in one render join one value while concurrent requests stay isolated.
  const request = currentRequest() as object | undefined
  if (!request) return undefined
  let store = privateStoreByRequest.get(request)
  if (!store) {
    store = new Map<string, unknown>()
    privateStoreByRequest.set(request, store)
  }
  return store
}

function privateMemo<Args extends unknown[], Result>(
  store: Map<string, unknown>,
  key: string,
  fn: (...args: Args) => Result,
  args: Args,
): Result {
  if (store.has(key)) return store.get(key) as Result
  const value = fn(...args)
  store.set(key, value)
  return value
}

function declaredArgs<Args extends unknown[]>(
  fn: (...args: Args) => unknown,
  args: Args,
): unknown[] {
  return args.slice(0, fn.length)
}

function serializeCacheBoundaryArgs(args: unknown[]): unknown[] {
  return args.map(arg => serializeCacheBoundaryValue(arg, new WeakSet<object>()))
}

function serializeCacheBoundaryValue(value: unknown, stack: WeakSet<object>): unknown {
  if (typeof value !== 'object' || value === null || isPromiseLike(value) || isElementLike(value)) {
    return value
  }
  if (stack.has(value)) return value
  stack.add(value)
  try {
    if (Array.isArray(value)) return value.map(item => serializeCacheBoundaryValue(item, stack))
    if (value instanceof Date) return value.toJSON()
    if (value instanceof Map) {
      return [...value].map(([key, nested]) => [
        serializeCacheBoundaryValue(key, stack),
        serializeCacheBoundaryValue(nested, stack),
      ])
    }
    if (value instanceof Set) {
      return [...value].map(item => serializeCacheBoundaryValue(item, stack))
    }
    const iterator = (value as { [Symbol.iterator]?: unknown })[Symbol.iterator]
    if (typeof iterator === 'function') {
      return Array.from(value as Iterable<unknown>, item =>
        serializeCacheBoundaryValue(item, stack),
      )
    }
    const entriesForObject = Object.entries(value)
    if (entriesForObject.length === 0) return value
    return Object.fromEntries(
      entriesForObject.map(([key, nested]) => [key, serializeCacheBoundaryValue(nested, stack)]),
    )
  } finally {
    stack.delete(value)
  }
}

/** Draft-mode bypass: run the producer uncached but still inside the cache
 * scope, so the dynamic-API restrictions (cookies()/headers() inside
 * 'use cache' throw) apply exactly as they do for cached production. */
function draftBypassRun<Args extends unknown[], Result>(
  id: string,
  fn: (...args: Args) => Result,
  args: Args,
): Result {
  const scope: UseCacheScope = { tags: new Set(), functionId: id }
  return runInsideDataCacheProducer(() => scopeStorage.run(scope, () => fn(...args)))
}

function readOrProduceEntry<Args extends unknown[], Result>(
  key: string,
  id: string,
  argsJson: string,
  fn: (...args: Args) => Result,
  args: Args,
  fills: unknown[],
): Result {
  const parent = scopeStorage.getStore()
  const modernKey = hasModernCacheHandler() ? modernCacheKey(id, argsJson) : undefined
  const resumeRecord = useCacheRdcRecords().get(key)
  if (
    resumeRecord &&
    !tagsRevalidatedAfterSeq(resumeRecord.tags, resumeRecord.tagSeq) &&
    !pathScopeRevalidated(resumeRecord.route, resumeRecord.storedAt) &&
    (entries.get(key)?.storedAt ?? -1) <= resumeRecord.storedAt
  ) {
    entries.set(key, {
      value: Promise.resolve(resumeRecord.value),
      storedAt: resumeRecord.storedAt,
      tags: [...resumeRecord.tags],
      ...(resumeRecord.revalidateSeconds !== undefined
        ? { revalidateSeconds: resumeRecord.revalidateSeconds }
        : {}),
      ...(resumeRecord.expireSeconds !== undefined
        ? { expireSeconds: resumeRecord.expireSeconds }
        : {}),
      ...(resumeRecord.staleSeconds !== undefined
        ? { staleSeconds: resumeRecord.staleSeconds }
        : {}),
      tagSeq: resumeRecord.tagSeq,
      ...(resumeRecord.route !== undefined ? { route: resumeRecord.route } : {}),
    })
  }
  const existing = entries.get(key)
  const meta = currentRenderCacheMeta()
  const expired = existing !== undefined && entryExpired(existing)
  // Hard on-demand invalidation: a tag update (revalidateTag/updateTag) after
  // this entry was produced, or a revalidatePath covering the entry's owning
  // route. Both block and re-produce so the read observes the fresh value
  // (read-your-writes within an action; path-scoped revalidation).
  const tagStale = existing !== undefined && tagsRevalidatedAfterSeq(existing.tags, existing.tagSeq)
  const pathStale =
    existing !== undefined && pathScopeRevalidated(existing.route, existing.storedAt)
  const invalidated = tagStale || pathStale
  const swrStale = existing !== undefined && tagsStaleSince(existing.tags, existing.storedAt)
  // On-demand revalidation re-produces each entry ONCE per render, deduped via refreshedIn - but only
  // entries the revalidation actually reached. A revalidation mark outlives a single render (a soft-nav
  // render never writes the prebuilt HTML back), so refreshing unconditionally churned every cache
  // scope on every later render of a still-marked route.
  const refresh =
    meta?.refreshFetches === true &&
    existing?.refreshedIn !== meta &&
    (invalidated || swrStale || expired)
  let modernGet: Promise<unknown> | undefined
  if (modernKey) {
    void modernCacheRefreshTags()
    // Keep the handler read's promise: serving an existing entry awaits it, so the handler's get() -
    // whose logs are asserted - lands on the critical path like Next's, where a custom handler IS the
    // cache. A fire-and-forget read could otherwise log only after the response already flushed.
    modernGet = modernCacheGet(modernKey)
    if (existing && !invalidated) void modernCacheGetExpiration()
  }
  // A regeneration render (blockingStaleFetches) must re-produce not only
  // TTL-expired entries but also soft-stale ones (revalidateTag with a
  // profile): serving them stale would bake the old value into the shell it
  // is regenerating, and the rewritten file's mtime then masks the staleness.
  if (
    existing &&
    !refresh &&
    !invalidated &&
    (!(expired || swrStale) || meta?.blockingStaleFetches !== true)
  ) {
    if ((expired || swrStale) && !existing.refreshing) {
      // TTL expiry outside an ISR regen: serve stale while refreshing in
      // the background (Next's SWR data-cache semantics).
      existing.refreshing = true
      void produceEntry(key, id, argsJson, fn, args, parent, existing, modernKey)
    }
    if (modernKey && parent && existing.revalidateSeconds === undefined) {
      void existing.value.then(
        () => propagateToParent(existing, parent),
        () => undefined,
      )
    }
    propagate(existing, parent)
    captureUseCacheRdcEntry(key)
    const served = withHoleFills(existing.value, fills)
    const out = modernGet ? modernGet.then(() => served) : served
    const servedGate = prefetchCacheGate()
    return (servedGate ? gatePrefetchCacheLife(out, servedGate, () => existing) : out) as Result
  }

  const value = produceEntry(key, id, argsJson, fn, args, parent, undefined, modernKey)
  captureUseCacheRdcEntry(key)
  const out = withHoleFills(value, fills)
  // The producing entry's cacheLife is set once `value` settles (see
  // produceEntry); `entries.get(key)` reads it back after production.
  const producedGate = prefetchCacheGate()
  return (
    producedGate ? gatePrefetchCacheLife(out, producedGate, () => entries.get(key)) : out
  ) as Result
}

function produceEntry<Args extends unknown[], Result>(
  key: string,
  id: string,
  argsJson: string,
  fn: (...args: Args) => Result,
  args: Args,
  parent: UseCacheScope | undefined,
  serveStale?: UseCacheEntry,
  modernKey?: string,
): Promise<unknown> {
  const scope: UseCacheScope = { tags: new Set(), functionId: id }
  // Sample the invalidation-scope inputs at production start: the hard-tag
  // sequence (read-your-writes) and the producing route (path revalidation),
  // mirroring how the fetch/unstable_cache data caches tag entries with their
  // owning route.
  const tagSeq = currentTagRevalidationSeq()
  const producingMeta = currentRenderCacheMeta()
  const route = producingMeta?.route
  const entry: UseCacheEntry = {
    value: undefined as unknown as Promise<unknown>,
    storedAt: realNow(),
    tags: [],
    modernKey,
    tagSeq,
    ...(producingMeta !== undefined ? { refreshedIn: producingMeta } : {}),
    ...(route !== undefined
      ? { route }
      : serveStale?.route !== undefined
        ? { route: serveStale.route }
        : {}),
  }
  const rawValue = (async () =>
    await runInsideDataCacheProducer(() => scopeStorage.run(scope, () => fn(...args))))().then(
    // Render-once semantics: nested server components inside the produced tree
    // execute once for the entry's lifetime (see wrapCachedValue).
    produced => wrapCachedValue(produced, scope, entry),
    // A throw inside the cache scope crosses Next's cache flight boundary
    // before any caller sees it: at runtime that reshapes the error (and, in a
    // plain production build, logs it here and redacts what escapes).
    error => {
      throw prerenderErrorCollectionActive() ? error : funnelCacheRuntimeError(error)
    },
  )
  // E236 hanging-input guard: during a build prerender a fill that never
  // resolves would hang the build; race it against the configured fill timeout
  // and reject with Next's timeout message (recorded so the build fails). Gated
  // on the armed build-prerender window (the cache-components shell path sets no
  // render cache-meta, so we can't rely on meta.prerender here).
  const value = prerenderErrorCollectionActive()
    ? withFillTimeout(rawValue, routeFromCacheId(id))
    : rawValue
  // A build prerender's task boundary must not cut a cache fill short: the
  // whole point of a cached read is that its (possibly task-settled) IO belongs
  // in the static shell. Register it so the boundary waits (core ppr).
  void trackPrerenderCacheFill(value)
  entry.value = value
  let resolveModernEntry: ((entry: ReturnType<typeof modernCacheEntry>) => void) | undefined
  let rejectModernEntry: ((reason?: unknown) => void) | undefined
  if (modernKey) {
    const pendingModernEntry = new Promise<ReturnType<typeof modernCacheEntry>>(
      (resolve, reject) => {
        resolveModernEntry = resolve
        rejectModernEntry = reject
      },
    )
    void modernCacheSet(modernKey, pendingModernEntry)
  }
  if (!serveStale) {
    if (entries.size >= entriesLimit) {
      const oldest = entries.keys().next().value
      if (oldest !== undefined) entries.delete(oldest)
    }
    entries.set(key, entry)
  }
  value.then(
    produced => {
      entry.tags = [...scope.tags]
      // Conditional-read upgrade (Stage B-3): production may have read root
      // params that were not in this entry's key (first-ever call for the id, or
      // a newly-discovered branch-dependent read). Re-store the settled entry
      // under the param-aware key so a concurrent/later call that already keyed
      // on those root params finds this value instead of re-producing. The
      // original key stays populated too (harmless; both point at one value).
      if (scope.rootParamsRead && scope.rootParamsRead.size > 0) {
        const upgradedKey = cacheKeyFor(id, withRootParamKeyArgs(id, args))
        if (typeof upgradedKey === 'string' && upgradedKey !== key) {
          entries.set(upgradedKey, entry)
        }
      }
      // A `use cache` entry with no explicit cacheLife() takes Next's `default`
      // profile (revalidate 900, expire one year, stale 300) so its route
      // emits the SWR cache-control + x-nextjs-stale-time headers.
      entry.revalidateSeconds = scope.revalidateSeconds ?? DEFAULT_REVALIDATE_SECONDS
      entry.expireSeconds = scope.expireSeconds ?? DEFAULT_EXPIRE_SECONDS
      entry.staleSeconds = scope.staleSeconds ?? DEFAULT_STALE_SECONDS
      // Persisting to a modern cache handler waits for embedded nested `use cache` vnodes to render
      // (their scopes fold tags and min cacheLife into this entry - Next resolves the entry only once
      // the whole cached tree has serialized). A fallback timer guards against a tree that is never
      // rendered, so the handler's pending set cannot deadlock.
      const resolveModern = resolveModernEntry
      if (resolveModern) {
        const finalize = () =>
          resolveModern(
            modernCacheEntry({
              value: produced,
              tags: entry.tags,
              staleSeconds: entry.staleSeconds ?? DEFAULT_STALE_SECONDS,
              expireSeconds: entry.expireSeconds ?? DEFAULT_EXPIRE_SECONDS,
              revalidateSeconds: entry.revalidateSeconds ?? DEFAULT_REVALIDATE_SECONDS,
              storedAt: entry.storedAt,
            }),
          )
        if (entry.nestedPending !== undefined && entry.nestedPending > 0) {
          const timer = setTimeout(finalize, 10_000)
          if (typeof timer.unref === 'function') timer.unref()
          entry.onNestedSettled = () => {
            if (entry.nestedPending === 0) {
              clearTimeout(timer)
              finalize()
            }
          }
        } else {
          finalize()
        }
      }
      // Background refresh replaces the stale entry only once settled.
      if (serveStale) entries.set(key, entry)
      propagate(entry, parent)
    },
    () => {
      rejectModernEntry?.()
      if (serveStale) serveStale.refreshing = false
      else if (entries.get(key) === entry) entries.delete(key)
    },
  )
  return value
}

/**
 * Serialize call arguments to a cache key. Non-data values (functions, symbols, React/preact element
 * trees) are replaced with a stable token, mirroring how Next passes such inputs through the cache
 * boundary without keying on them. Cyclic structures bail out (null key = run uncached).
 */
function cacheKeyFor(id: string, args: unknown[]): string | Promise<string | null> | null {
  try {
    const keyValue = resolvePromisesForKey(args, new WeakSet<object>())
    if (isPromiseLike(keyValue)) {
      return Promise.resolve(keyValue).then(
        resolved => stringifyCacheKey(id, resolved),
        () => null,
      )
    }
    return stringifyCacheKey(id, keyValue)
  } catch {
    return null
  }
}

function argsJsonFromKey(id: string, key: string): string {
  return key.startsWith(`${id}:`) ? key.slice(id.length + 1) : '[]'
}

function stringifyCacheKey(id: string, value: unknown): string | null {
  try {
    const json = JSON.stringify(value, (_key, nested: unknown) => {
      if (typeof nested === 'function' || typeof nested === 'symbol') return '$pnext:ref'
      if (typeof nested === 'bigint') return `$pnext:bigint:${nested}`
      if (isElementLike(nested)) return '$pnext:element'
      return nested
    })
    return `${id}:${json}`
  } catch {
    return null
  }
}

function resolvePromisesForKey(value: unknown, stack: WeakSet<object>): unknown {
  if (isPromiseLike(value)) {
    return Promise.resolve(value).then(resolved =>
      resolvePromisesForKey(resolved, new WeakSet<object>()),
    )
  }
  if (typeof value !== 'object' || value === null || isElementLike(value)) return value

  if (stack.has(value)) throw new Error('cyclic cache key')
  stack.add(value)
  try {
    if (Array.isArray(value)) {
      const items = value.map(item => resolvePromisesForKey(item, stack))
      return items.some(isPromiseLike) ? Promise.all(items) : value
    }

    const entriesForObject = Object.entries(value)
    if (entriesForObject.length === 0) return value

    const resolvedEntries = entriesForObject.map(
      ([key, nested]) => [key, resolvePromisesForKey(nested, stack)] as const,
    )
    if (!resolvedEntries.some(([, nested]) => isPromiseLike(nested))) return value

    return Promise.all(
      resolvedEntries.map(([key, nested]) =>
        Promise.resolve(nested).then(resolved => [key, resolved] as const),
      ),
    ).then(entriesList => Object.fromEntries(entriesList))
  } finally {
    stack.delete(value)
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

// Cached element trees: argument holes + render-once subtree semantics.
//
// In Next, everything a `use cache` function CREATES is part of the cached RSC payload (nested server
// components execute once, during the fill), while element/node values PASSED IN are serialized as
// references ("holes") that each invocation fills with its own content. pnext shares values by
// reference instead of serializing, so both halves are mirrored structurally:
//
//   1. Holes: element-like arguments are swapped for hole marker vnodes before keying/producing (they
//      already key as an opaque token, so different children share one entry), and each call
//      re-instantiates the cached tree with ITS elements substituted back in - cloning only the vnodes
//      on hole paths, so unrelated subtrees keep their identity.
//   2. Render-once: when a produced value settles, every plain server-component vnode in it gets its
//      `type` swapped for a per-vnode memo wrapper. The first render executes the component inside the
//      entry's cache scope, so cacheTag()/cacheLife()/no-store semantics attribute correctly, and the
//      result - recursively wrapped the same way - is reused by every other placement and request for
//      the entry's lifetime. Subtrees that received a hole re-execute per invocation.
//
// Wrappers deliberately skip: Suspense identities (the renderer must keep recognizing boundaries),
// Fragment, class components, island/client references and other marked component kinds, and
// `use cache` wrappers themselves (they self-memoize through the entry store, preserving their own
// revalidation). Sync components that throw on detached invocation rethrow unmemoized, so the
// renderer's existing hook-dispatcher fallback still applies.

/** Marks pnextUseCache* wrappers so tree wrapping leaves them to self-memoize. */
const USE_CACHE_WRAPPER = Symbol.for('pnext.compat.useCacheWrapper')
const MEMO_WRAPPED = Symbol.for('pnext.compat.useCacheMemoWrapped')
// Renderer component-kind marks (global symbol registry; see render/renderer.ts,
// client/reference.ts, api/dynamic.tsx, render/slots.tsx).
const clientReferenceSymbol = Symbol.for('pnext.clientReference')
const dynamicReferenceSymbol = Symbol.for('pnext.dynamic')
const paramsScopeSymbol = Symbol.for('pnext.paramsScope')
const clientPageComponentSymbol = Symbol.for('pnext.clientPageComponent')
const useCacheJoinerPromiseSymbol = Symbol.for('pnext.compat.useCacheJoinerPromise')

const HOLE_INDEX_PROP = '__pnextCacheHoleIndex'

/** Inert placeholder; instantiation replaces it before it can ever render. */
function CachedArgumentHole(): null {
  return null
}

function holeElement(index: number) {
  return h(CachedArgumentHole as never, { [HOLE_INDEX_PROP]: index } as never)
}

interface ExtractedHoles {
  args: unknown[]
  fills: unknown[]
}

/**
 * Replace element-like values inside the (already-serialized) argument list
 * with indexed hole vnodes, collecting the real elements in order. Containers
 * are cloned only along changed paths; an argument list with no elements is
 * returned unchanged with an empty fills list.
 */
function extractElementHoles(args: unknown[]): ExtractedHoles {
  const fills: unknown[] = []
  const stack = new WeakSet<object>()
  const walk = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object' || isPromiseLike(value)) return value
    if (isElementLike(value)) {
      fills.push(value)
      return holeElement(fills.length - 1)
    }
    if (stack.has(value)) return value
    stack.add(value)
    try {
      if (Array.isArray(value)) {
        let changed = false
        const next = value.map(item => {
          const out = walk(item)
          if (out !== item) changed = true
          return out
        })
        return changed ? next : value
      }
      const proto: unknown = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) return value
      let changed = false
      const entriesForObject = Object.entries(value).map(([key, nested]) => {
        const out = walk(nested)
        if (out !== nested) changed = true
        return [key, out] as const
      })
      return changed ? Object.fromEntries(entriesForObject) : value
    } finally {
      stack.delete(value)
    }
  }
  const out = args.map(walk)
  return fills.length > 0 ? { args: out, fills } : { args, fills }
}

/** Resolve a cached value for one invocation, substituting its hole fills. */
function withHoleFills(value: Promise<unknown>, fills: unknown[]): Promise<unknown> {
  if (fills.length === 0) return value
  return value.then(resolved => instantiateHoles(resolved, fills, new WeakSet<object>()))
}

function instantiateHoles(value: unknown, fills: unknown[], stack: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object' || isPromiseLike(value)) return value
  if (stack.has(value)) return value
  stack.add(value)
  try {
    if (isElementLike(value)) {
      const vnode = value as {
        type?: unknown
        props?: Record<string, unknown> | null
        key?: unknown
        ref?: unknown
      }
      if (vnode.type === CachedArgumentHole) {
        const index = vnode.props?.[HOLE_INDEX_PROP]
        return typeof index === 'number' ? (fills[index] ?? null) : null
      }
      if (!vnode.props || typeof vnode.props !== 'object') return value
      let changed = false
      const nextProps = Object.fromEntries(
        Object.entries(vnode.props).map(([key, nested]) => {
          const out = instantiateHoles(nested, fills, stack)
          if (out !== nested) changed = true
          return [key, out] as const
        }),
      )
      if (!changed) return value
      return cloneElementLike(vnode, vnode.type, nextProps)
    }
    if (Array.isArray(value)) {
      let changed = false
      const next = value.map(item => {
        const out = instantiateHoles(item, fills, stack)
        if (out !== item) changed = true
        return out
      })
      return changed ? next : value
    }
    const proto: unknown = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return value
    let changed = false
    const entriesForObject = Object.entries(value).map(([key, nested]) => {
      const out = instantiateHoles(nested, fills, stack)
      if (out !== nested) changed = true
      return [key, out] as const
    })
    return changed ? Object.fromEntries(entriesForObject) : value
  } finally {
    stack.delete(value)
  }
}

/** Re-create a vnode via h() so preact's internal fields stay pristine. */
function cloneElementLike(
  vnode: { key?: unknown; ref?: unknown },
  type: unknown,
  props: Record<string, unknown>,
): unknown {
  return h(
    type as never,
    {
      ...props,
      ...(vnode.key !== undefined && vnode.key !== null ? { key: vnode.key } : {}),
      ...(vnode.ref !== undefined && vnode.ref !== null ? { ref: vnode.ref } : {}),
    } as never,
  )
}

/** Wrap a settled cached value's server-component vnodes for render-once reuse. */
function wrapCachedValue(value: unknown, scope: UseCacheScope, entry: UseCacheEntry): unknown {
  return wrapCachedNode(value, scope, entry, new WeakSet<object>()).value
}

interface WrapNodeResult {
  value: unknown
  hasHole: boolean
}

function wrapCachedNode(
  value: unknown,
  scope: UseCacheScope,
  entry: UseCacheEntry,
  stack: WeakSet<object>,
): WrapNodeResult {
  if (value === null || typeof value !== 'object' || isPromiseLike(value)) {
    return { value, hasHole: false }
  }
  if (stack.has(value)) return { value, hasHole: false }
  stack.add(value)
  try {
    if (isElementLike(value)) {
      const vnode = value as {
        type?: unknown
        props?: Record<string, unknown> | null
        key?: unknown
        ref?: unknown
      }
      if (vnode.type === CachedArgumentHole) return { value, hasHole: true }
      let hasHole = false
      let changed = false
      let nextProps = vnode.props ?? undefined
      if (vnode.props && typeof vnode.props === 'object') {
        const entriesForProps = Object.entries(vnode.props).map(([key, nested]) => {
          const result = wrapCachedNode(nested, scope, entry, stack)
          hasHole ||= result.hasHole
          if (result.value !== nested) changed = true
          return [key, result.value] as const
        })
        if (changed) nextProps = Object.fromEntries(entriesForProps)
      }
      // A component whose props carry a hole re-executes per invocation (its
      // props genuinely differ per call); everything else renders once.
      const type = vnode.type
      if (!hasHole && isUseCacheWrapperType(type)) {
        entry.nestedPending = (entry.nestedPending ?? 0) + 1
      }
      const nextType =
        !hasHole && isUseCacheWrapperType(type)
          ? attributeNestedCacheWrapper(
              type as (props: Record<string, unknown>) => unknown,
              scope,
              entry,
            )
          : !hasHole && shouldMemoWrapType(type)
            ? memoServerComponent(type as (props: Record<string, unknown>) => unknown, scope, entry)
            : type
      if (!changed && nextType === type) return { value, hasHole }
      return {
        value: cloneElementLike(vnode, nextType, nextProps ?? {}),
        hasHole,
      }
    }
    if (Array.isArray(value)) {
      let hasHole = false
      let changed = false
      const next = value.map(item => {
        const result = wrapCachedNode(item, scope, entry, stack)
        hasHole ||= result.hasHole
        if (result.value !== item) changed = true
        return result.value
      })
      return { value: changed ? next : value, hasHole }
    }
    const proto: unknown = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return { value, hasHole: false }
    let hasHole = false
    let changed = false
    const entriesForObject = Object.entries(value).map(([key, nested]) => {
      const result = wrapCachedNode(nested, scope, entry, stack)
      hasHole ||= result.hasHole
      if (result.value !== nested) changed = true
      return [key, result.value] as const
    })
    return { value: changed ? Object.fromEntries(entriesForObject) : value, hasHole }
  } finally {
    stack.delete(value)
  }
}

function isUseCacheWrapperType(type: unknown): boolean {
  return (
    typeof type === 'function' &&
    Boolean((type as unknown as Record<symbol, unknown>)[USE_CACHE_WRAPPER]) &&
    !(type as unknown as Record<symbol, unknown>)[MEMO_WRAPPED]
  )
}

/**
 * A nested `use cache` component embedded in an outer cached tree renders OUTSIDE the outer entry's
 * fill (the renderer invokes the vnode after the outer value settled), so its cache metadata would
 * never attribute to the enclosing entry. Wrap the vnode type so the inner wrapper executes inside the
 * outer scope, and fold the accumulated scope aggregates back onto the outer entry once the inner
 * result settles - Next folds a nested cache scope's tags and MIN lifetimes into the enclosing entry.
 * The inner wrapper still self-memoizes through the entry store, preserving its own revalidation.
 */
function attributeNestedCacheWrapper(
  fn: (props: Record<string, unknown>) => unknown,
  scope: UseCacheScope,
  entry: UseCacheEntry,
): (props: Record<string, unknown>) => unknown {
  let settledOnce = false
  const settle = (fold: boolean) => {
    if (fold) foldScopeIntoEntry(scope, entry)
    if (settledOnce) return
    settledOnce = true
    if (entry.nestedPending !== undefined && entry.nestedPending > 0) {
      entry.nestedPending -= 1
      entry.onNestedSettled?.()
    }
  }
  const wrapper = function (this: unknown, props: Record<string, unknown>): unknown {
    if (this !== undefined) return fn.call(this, props)
    const result = scopeStorage.run(scope, () => fn(props))
    if (isPromiseLike(result)) {
      return Promise.resolve(result).then(
        value => {
          settle(true)
          return value
        },
        (error: unknown) => {
          settle(false)
          throw error
        },
      )
    }
    settle(true)
    return result
  }
  const marked = wrapper as unknown as Record<symbol, unknown>
  marked[MEMO_WRAPPED] = true
  marked[USE_CACHE_WRAPPER] = true
  return wrapper
}

/** Fold the scope's accumulated tags + min cacheLife onto a settled entry. */
function foldScopeIntoEntry(scope: UseCacheScope, entry: UseCacheEntry): void {
  entry.tags = [...new Set([...entry.tags, ...scope.tags])]
  entry.revalidateSeconds = minDefined(entry.revalidateSeconds, scope.revalidateSeconds)
  entry.expireSeconds = minDefined(entry.expireSeconds, scope.expireSeconds)
  entry.staleSeconds = minDefined(entry.staleSeconds, scope.staleSeconds)
}

function shouldMemoWrapType(type: unknown): boolean {
  if (typeof type !== 'function') return false
  if (type === Fragment || type === (CoreSuspense as unknown)) return false
  const component = type as unknown as { prototype?: { render?: unknown } } & Record<
    symbol,
    unknown
  >
  // Class components (incl. preact/compat Suspense) need a preact instance.
  if (component.prototype && typeof component.prototype.render === 'function') return false
  if (component[MEMO_WRAPPED] || component[USE_CACHE_WRAPPER]) return false
  if (
    component[clientReferenceSymbol] ||
    component[dynamicReferenceSymbol] ||
    component[paramsScopeSymbol] ||
    component[clientPageComponentSymbol]
  ) {
    return false
  }
  return true
}

/**
 * Per-vnode render-once wrapper. The first detached (server-resolver) invocation runs the real component
 * inside the entry's cache scope and caches the recursively-wrapped result for every later
 * placement/request. Throws - use() thenables, hook-dispatcher errors from non-server components - are
 * rethrown unmemoized so the renderer's replay/fallback paths behave exactly as without the wrapper, and
 * preact-instance invocations bypass the memo entirely.
 */
function memoServerComponent(
  fn: (props: Record<string, unknown>) => unknown,
  scope: UseCacheScope,
  entry: UseCacheEntry,
): (props: Record<string, unknown>) => unknown {
  let memo: { value: unknown; requestToken?: object } | undefined
  const wrapper = function (this: unknown, props: Record<string, unknown>): unknown {
    if (this !== undefined) return fn.call(this, props)
    if (memo) {
      const requestToken = currentUseCacheRequestToken()
      if (
        memo.requestToken &&
        requestToken &&
        memo.requestToken !== requestToken &&
        isPromiseLike(memo.value)
      ) {
        const joined = Promise.resolve(memo.value).then(value => value)
        ;(joined as unknown as Record<symbol, unknown>)[useCacheJoinerPromiseSymbol] = true
        return joined
      }
      return memo.value
    }
    const requestToken = currentUseCacheRequestToken()
    const result = runInsideDataCacheProducer(() => scopeStorage.run(scope, () => fn(props)))
    if (isPromiseLike(result)) {
      const settled = Promise.resolve(result).then(resolved => {
        // Tags declared while the subtree rendered attribute to the entry.
        entry.tags = [...scope.tags]
        return wrapCachedValue(resolved, scope, entry) as ComponentChildren
      })
      memo = { value: settled, ...(requestToken ? { requestToken } : {}) }
      settled.then(undefined, () => {
        // Failures don't stick: the next placement re-executes.
        if (memo?.value === settled) memo = undefined
      })
      return settled
    }
    entry.tags = [...scope.tags]
    const wrapped = wrapCachedValue(result, scope, entry)
    memo = { value: wrapped, ...(requestToken ? { requestToken } : {}) }
    return wrapped
  }
  ;(wrapper as unknown as Record<symbol, unknown>)[MEMO_WRAPPED] = true
  return wrapper
}

function currentUseCacheRequestToken(): object | undefined {
  const request = currentRequest() as object | undefined
  if (!request) return undefined
  let token = requestTokens.get(request)
  if (!token) {
    token = {}
    requestTokens.set(request, token)
  }
  return token
}

function isElementLike(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if ('$$typeof' in record) return true
  return 'type' in record && 'props' in record
}

/** Test hook. */
export function clearUseCacheEntries() {
  entries.clear()
}
