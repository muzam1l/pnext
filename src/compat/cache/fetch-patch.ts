/**
 * Next-compat fetch patch: honors `{ cache, next: { revalidate, tags } }`
 * fetch options against the process-wide data cache, records tags/revalidate
 * into the surrounding render's cache meta (so prerendered pages inherit
 * them), and dedupes identical GET fetches within one render pass.
 *
 * Installed once per process by `pnext build` / `pnext start` when Next
 * compat is enabled; plain fetches outside a render scope pass through.
 */
import { currentCacheScope } from '../../request/cache'
import {
  cacheComponents,
  hangingPromise,
  isPrerendering,
  realNow,
  trackPrerenderCacheFill,
} from '../../render/ppr'
import { cacheHandlerGet, cacheHandlerSet, hasCacheHandler } from './handler'
import {
  currentRenderCacheMeta,
  currentRenderIsStaticGeneration,
  draftModeBypassActive,
  recordCacheNoStore,
  recordCacheRevalidate,
  recordCacheTags,
  registerDataCacheInvalidator,
  insideDataCacheProducer,
  currentTagRevalidationSeq,
  rdcProcessId,
  rebaseRdcTagSeq,
  pathScopeRevalidated,
  tagsRevalidatedAfterSeq,
  tagsStaleSince,
} from './revalidate'
import { insideUseCacheProducer } from './use-cache'

const MAX_TAGS = 128

interface NextFetchOptions {
  revalidate?: number | false
  tags?: string[]
}

interface FetchSnapshot {
  status: number
  statusText: string
  headers: [string, string][]
  body: Uint8Array
  url: string
}

interface FetchCacheEntry {
  value: Promise<FetchSnapshot>
  storedAt: number
  tags: readonly string[]
  revalidateSeconds?: number
  /** A background stale-while-revalidate refresh is already in flight. */
  refreshing?: boolean
  /** Pathname of the render that produced this entry (path-revalidation scope). */
  route?: string
  /**
   * Other routes that have SERVED this entry. One fetch cache entry is shared by every route issuing the
   * same request, and Next widens its implicit `_N_T_/<route>` soft tag on each read - so
   * revalidatePath('/b') expires an entry that /a produced and /b reused.
   */
  readRoutes?: string[]
  /** Hard-tag-revalidation sequence sampled when this entry was produced. */
  tagSeq: number
  /**
   * The render cache-meta this entry was produced under: an on-demand
   * regeneration (refreshFetches) refetches each entry once per render, then
   * repeated reads dedupe against it.
   */
  refreshedIn?: object
}

export interface FetchRdcRecord {
  key: string
  snapshot: {
    status: number
    statusText: string
    headers: [string, string][]
    body: string
    url: string
  }
  tags: string[]
  storedAt: number
  tagSeq: number
  /** Process that produced this record — `tagSeq` only means anything there. */
  pid?: string
  revalidateSeconds?: number
  route?: string
}

const FETCH_CACHE = Symbol.for('pnext.compat.fetchCache')
const FETCH_CACHE_INSTALLED = Symbol.for('pnext.compat.fetchCacheInstalled')

function fetchCacheStore(): Map<string, FetchCacheEntry> {
  const state = globalThis as Record<PropertyKey, unknown>
  return (state[FETCH_CACHE] ??= new Map<string, FetchCacheEntry>()) as Map<string, FetchCacheEntry>
}

function fetchCacheInstalled(): boolean {
  return (globalThis as Record<PropertyKey, unknown>)[FETCH_CACHE_INSTALLED] === true
}

function markFetchCacheInstalled(): void {
  ;(globalThis as Record<PropertyKey, unknown>)[FETCH_CACHE_INSTALLED] = true
}

const fetchCache = fetchCacheStore()
const fetchCacheLimit = 2048
const FETCH_RDC_CAPTURE = Symbol.for('pnext.compat.fetchRdcCapture')
const FETCH_RDC_RECORDS = Symbol.for('pnext.compat.fetchRdcRecords')

function fetchRdcRecords(): Map<string, FetchCacheEntry> {
  const state = globalThis as Record<PropertyKey, unknown>
  return (state[FETCH_RDC_RECORDS] ??= new Map<string, FetchCacheEntry>()) as Map<
    string,
    FetchCacheEntry
  >
}

function fetchRdcCapture(): Set<string> | undefined {
  return (globalThis as Record<PropertyKey, unknown>)[FETCH_RDC_CAPTURE] as Set<string> | undefined
}

function captureFetchRdcEntry(key: string) {
  fetchRdcCapture()?.add(key)
}

export function beginFetchRdcCapture() {
  ;(globalThis as Record<PropertyKey, unknown>)[FETCH_RDC_CAPTURE] = new Set<string>()
}

export async function collectFetchRdcRecords(): Promise<FetchRdcRecord[]> {
  const capture = fetchRdcCapture()
  if (!capture) return []
  const records: FetchRdcRecord[] = []
  for (const key of capture) {
    const entry = fetchCache.get(key)
    if (!entry) continue
    const snapshot = await entry.value
    records.push({
      key,
      snapshot: {
        status: snapshot.status,
        statusText: snapshot.statusText,
        headers: [...snapshot.headers],
        body: Buffer.from(snapshot.body).toString('base64'),
        url: snapshot.url,
      },
      tags: [...entry.tags],
      storedAt: entry.storedAt,
      tagSeq: entry.tagSeq,
      pid: rdcProcessId(),
      ...(entry.revalidateSeconds !== undefined
        ? { revalidateSeconds: entry.revalidateSeconds }
        : {}),
      ...(entry.route !== undefined ? { route: entry.route } : {}),
    })
  }
  return records
}

export function seedFetchRdcRecords(
  records: readonly FetchRdcRecord[],
  route?: string,
  routeTags: readonly string[] = [],
) {
  for (const record of records) {
    if (!isFetchRdcRecord(record)) continue
    // An RDC artifact is a snapshot: seeding it must never regress a live
    // entry filled more recently (each regen seeds the stale .rdc first).
    const live = fetchCache.get(record.key)
    if (live !== undefined && live.storedAt > record.storedAt) continue
    const entry: FetchCacheEntry = {
      value: Promise.resolve({
        status: record.snapshot.status,
        statusText: record.snapshot.statusText,
        headers: [...record.snapshot.headers],
        body: new Uint8Array(Buffer.from(record.snapshot.body, 'base64')),
        url: record.snapshot.url,
      }),
      storedAt: record.storedAt,
      // A fetch made inside a `use cache` scope carries no tags of its own - the scope's cacheTag()s are
      // the invalidation surface. Stamp the route-level tag union on the seeded snapshot so updateTag()
      // of any of those tags invalidates it (slightly over-broad within the route, never
      // under-invalidating).
      tags: [...new Set([...record.tags, ...routeTags])],
      // Foreign-process sequences are meaningless here — see rebaseRdcTagSeq.
      tagSeq: rebaseRdcTagSeq(record),
      ...(record.revalidateSeconds !== undefined
        ? { revalidateSeconds: record.revalidateSeconds }
        : {}),
      ...(route !== undefined
        ? { route }
        : record.route !== undefined
          ? { route: record.route }
          : {}),
    }
    fetchRdcRecords().set(record.key, entry)
    fetchCache.set(record.key, entry)
  }
}

/** Widen an entry's path-revalidation scope with the route now reading it. */
function noteFetchEntryRoute(entry: FetchCacheEntry, route: string | undefined): void {
  if (route === undefined || route === entry.route) return
  const routes = (entry.readRoutes ??= [])
  if (routes.includes(route)) return
  routes.push(route)
  // A single entry read from an unbounded set of routes (dynamic pathnames)
  // must not grow without limit; the oldest reader's scope is dropped first.
  if (routes.length > 32) routes.shift()
}

/** True when this entry's producing OR any reading route was revalidated. */
function fetchEntryPathRevalidated(entry: FetchCacheEntry): boolean {
  if (pathScopeRevalidated(entry.route, entry.storedAt)) return true
  return (entry.readRoutes ?? []).some(route => pathScopeRevalidated(route, entry.storedAt))
}

function isFetchRdcRecord(value: unknown): value is FetchRdcRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<FetchRdcRecord>
  return (
    typeof record.key === 'string' &&
    !!record.snapshot &&
    typeof record.snapshot.status === 'number' &&
    typeof record.snapshot.statusText === 'string' &&
    Array.isArray(record.snapshot.headers) &&
    record.snapshot.headers.every(
      header =>
        Array.isArray(header) &&
        header.length === 2 &&
        header.every(part => typeof part === 'string'),
    ) &&
    typeof record.snapshot.body === 'string' &&
    typeof record.snapshot.url === 'string' &&
    Array.isArray(record.tags) &&
    record.tags.every(tag => typeof tag === 'string') &&
    typeof record.storedAt === 'number' &&
    Number.isFinite(record.storedAt) &&
    typeof record.tagSeq === 'number' &&
    Number.isInteger(record.tagSeq)
  )
}

export function installCompatFetchCache() {
  if (fetchCacheInstalled()) return
  markFetchCacheInstalled()
  registerDataCacheInvalidator(clearFetchCache)
  const original = globalThis.fetch.bind(globalThis)

  const patched = async function fetch(
    input: Parameters<typeof globalThis.fetch>[0],
    init?: RequestInit & { next?: NextFetchOptions },
  ): Promise<Response> {
    const normalized = await normalizeFetchArgs(input, init)
    if (!normalized) return original(input, init)
    const { request } = normalized
    // A consumed stream body was buffered for the cache key; forward the bytes.
    if (normalized.replacementInit) init = { ...init, ...normalized.replacementInit }

    const nextOptions = init?.next ?? requestNextOptions(input)
    let tags = nextOptions?.tags ?? []
    if (tags.length > MAX_TAGS) {
      console.warn(
        `Warning: exceeded max tag count for ${request.url}, dropped tags: ${tags
          .slice(MAX_TAGS)
          .join(', ')}`,
      )
      tags = tags.slice(0, MAX_TAGS)
    }
    const revalidate = nextOptions?.revalidate
    if (
      revalidate !== undefined &&
      revalidate !== false &&
      (typeof revalidate !== 'number' || revalidate < 0 || !Number.isFinite(revalidate))
    ) {
      throw new Error(
        `Invalid revalidate value "${String(revalidate)}" on "${
          currentRenderCacheMeta()?.route ?? request.url
        }", must be a non-negative number or false`,
      )
    }
    recordCacheTags(tags)
    if (typeof revalidate === 'number' && revalidate > 0) recordCacheRevalidate(revalidate)

    const cacheOption = init?.cache ?? requestCacheOption(input)
    if (
      insideDataCacheProducer() &&
      cacheOption === undefined &&
      revalidate === undefined &&
      tags.length === 0 &&
      // During static generation a plain fetch inside an unstable_cache producer still lands in the
      // incremental cache handler (Next's SSG fetch-sharing optimization; build logs are asserted). At
      // runtime the outer cache boundary memoizes, so bypass. A `use cache` producer's plain fetches
      // ALWAYS bypass: they belong to the outer entry, and the URL-keyed cache would wrongly share them
      // across entries whose keys differ.
      (!currentRenderIsStaticGeneration() || insideUseCacheProducer())
    ) {
      return original(input, init)
    }

    const segmentFetchCache = currentRenderCacheMeta()?.fetchCache
    const segmentForcesCache =
      segmentFetchCache === 'force-cache' || segmentFetchCache === 'only-cache'
    // Explicit no-store signals opt the surrounding route out of prebuilt
    // static output (Next renders it dynamically per request) — unless the
    // segment's fetchCache forces caching, which supersedes them.
    if (
      !segmentForcesCache &&
      (cacheOption === 'no-store' || cacheOption === 'no-cache' || revalidate === 0)
    ) {
      recordCacheNoStore()
    }
    // Route handlers never auto-cache an implicit/default fetch (Next treats
    // both forms as uncached), and it keeps the handler out of prebuilt static
    // output. Pages are unaffected: their ISR output freezes the data at
    // prerender time.
    const handlerDefaultFetch =
      (cacheOption === undefined || cacheOption === 'default') &&
      currentRenderCacheMeta()?.handler === true
    if (handlerDefaultFetch && !segmentForcesCache) recordCacheNoStore()

    const mode = cacheModeFor(
      cacheOption,
      revalidate,
      segmentFetchCache,
      request.method,
      currentRenderIsStaticGeneration() && !handlerDefaultFetch,
    )
    if (mode !== 'cache' && cacheComponents() && isPrerendering() && !insideDataCacheProducer()) {
      return hangingPromise<Response>('fetch()')
    }
    if (mode === 'bypass') return original(input, init)

    const key = fetchCacheKey(request)

    if (mode === 'cache' && !draftModeBypassActive()) {
      const meta = currentRenderCacheMeta()
      const resumeEntry = fetchRdcRecords().get(key)
      if (
        resumeEntry &&
        !tagsRevalidatedAfterSeq([...resumeEntry.tags, ...tags], resumeEntry.tagSeq) &&
        !fetchEntryPathRevalidated(resumeEntry) &&
        (fetchCache.get(key)?.storedAt ?? -1) <= resumeEntry.storedAt
      ) {
        fetchCache.set(key, resumeEntry)
      }
      const preRefreshEntry = fetchCache.get(key)
      // On-demand revalidation refetches each entry ONCE per render (Next skips the cache read entirely
      // under isOnDemandRevalidate), then dedupes via refreshedIn - but only entries the revalidation
      // actually reached. See the matching gate in use-cache.ts: a still-marked route re-renders many
      // times before its prebuilt HTML is written back.
      const refresh =
        meta?.refreshFetches === true &&
        preRefreshEntry?.refreshedIn !== meta &&
        (preRefreshEntry === undefined ||
          tagsRevalidatedAfterSeq([...preRefreshEntry.tags, ...tags], preRefreshEntry.tagSeq) ||
          fetchEntryPathRevalidated(preRefreshEntry) ||
          tagsStaleSince(preRefreshEntry.tags, preRefreshEntry.storedAt) ||
          fetchEntryExpired(preRefreshEntry))
      const revalidateSeconds =
        typeof revalidate === 'number' && revalidate > 0 ? revalidate : undefined
      const blockingStale = currentRenderCacheMeta()?.blockingStaleFetches === true
      // Seed the in-memory entry from the configured cache handler on a miss,
      // so the handler observes every read (its get() logs are asserted) and
      // persists entries across the SWR window / restarts.
      let entry = fetchCache.get(key)
      if (!entry && !refresh && hasCacheHandler()) {
        const persisted = await cacheHandlerGet(key, { tags })
        const snapshot = persistedSnapshot(persisted?.value)
        if (snapshot) {
          entry = {
            value: Promise.resolve(snapshot),
            storedAt: persisted?.lastModified ?? realNow(),
            tags: persisted?.tags ?? tags,
            revalidateSeconds,
            tagSeq: currentTagRevalidationSeq(),
            ...(currentRenderCacheMeta()?.route !== undefined
              ? { route: currentRenderCacheMeta()?.route }
              : {}),
          }
          fetchCache.set(key, entry)
        }
      }
      // This render's route joins the entry's path-revalidation scope before
      // the freshness check, so revalidatePath() of a route that only REUSES a
      // shared entry expires it too.
      if (entry) noteFetchEntryRoute(entry, meta?.route)
      if (
        entry &&
        !refresh &&
        !tagsRevalidatedAfterSeq([...entry.tags, ...tags], entry.tagSeq) &&
        !fetchEntryPathRevalidated(entry)
      ) {
        const tagStale = tagsStaleSince(entry.tags, entry.storedAt)
        // Staleness honours THIS call's revalidate, not only the value baked
        // into the stored entry. The data cache is shared by URL across routes,
        // so a shorter-lived reader (e.g. a `revalidate: 9` fetch) can find an
        // entry first populated by a longer-lived / unversioned reader (a
        // default fetch stores `revalidateSeconds: undefined`, which never
        // expires). Without folding the current revalidate into the check, that
        // reader's window would be silently ignored and its page would never
        // refresh (app-static variable-config-revalidate under a full suite).
        if (
          !tagStale &&
          !fetchEntryExpired(entry) &&
          !currentRequestExpired(entry, revalidateSeconds)
        ) {
          captureFetchRdcEntry(key)
          return snapshotResponse(await entry.value)
        }
        // TTL expiry: serve stale, refresh in the background (Next's SWR
        // data-cache semantics) — except inside an ISR regeneration render,
        // which refetches inline. On-demand invalidation above blocks too.
        if (!blockingStale) {
          if (!entry.refreshing) {
            entry.refreshing = true
            void storeFetchEntry(key, original, input, init, tags, revalidateSeconds, entry)
          }
          captureFetchRdcEntry(key)
          return snapshotResponse(await entry.value)
        }
      }
      const value = storeFetchEntry(key, original, input, init, tags, revalidateSeconds)
      return snapshotResponse(await value)
    }

    // Uncached, but dedupe identical GETs within the render pass.
    const scope = currentCacheScope()
    if (!scope) return original(input, init)
    scope.fetches ??= new Map()
    let pending = scope.fetches.get(key) as Promise<FetchSnapshot> | undefined
    if (!pending) {
      pending = snapshotFetch(original, input, init)
      scope.fetches.set(key, pending)
    }
    return snapshotResponse(await pending)
  }

  globalThis.fetch = patched as typeof globalThis.fetch
}

interface NormalizedFetchRequest {
  url: string
  method: string
  headers: [string, string][]
  body?: string
}

interface NormalizedFetchArgs {
  request: NormalizedFetchRequest
  /** Set when a one-shot body (stream) was buffered and must be re-sent as bytes. */
  replacementInit?: { body: BodyInit }
}

async function normalizeFetchArgs(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: RequestInit,
): Promise<NormalizedFetchArgs | null> {
  try {
    let url: string
    let method = 'GET'
    let headers: Headers

    if (typeof input === 'string' || input instanceof URL) {
      url = String(input)
      method = (init?.method ?? 'GET').toUpperCase()
      headers = new Headers(init?.headers)
    } else if (input instanceof Request) {
      if (input.body != null) return null
      url = input.url
      method = (init?.method ?? input.method).toUpperCase()
      headers = new Headers(init?.headers ?? input.headers)
    } else {
      return null
    }
    if (!/^https?:/.test(url)) return null

    const normalizedBody = await normalizeFetchBody(init?.body)
    if (normalizedBody === null) return null
    return {
      request: { url, method, headers: [...headers.entries()], body: normalizedBody?.key },
      ...(normalizedBody?.replacement !== undefined
        ? { replacementInit: { body: normalizedBody.replacement } }
        : {}),
    }
  } catch {
    return null
  }
}

/**
 * Body to stable key string. Streams are buffered (and must be re-sent as the buffered bytes); FormData
 * is keyed by its entries, since the multipart boundary is random and serializing the whole body would
 * defeat caching; Blob and unknown shapes return null (bypass).
 */
async function normalizeFetchBody(
  body: BodyInit | null | undefined,
): Promise<{ key: string; replacement?: BodyInit } | undefined | null> {
  if (body == null) return undefined
  if (typeof body === 'string') return { key: body }
  if (body instanceof URLSearchParams) return { key: body.toString() }
  if (body instanceof ArrayBuffer) return { key: bytesKey(new Uint8Array(body)) }
  if (ArrayBuffer.isView(body)) {
    return { key: bytesKey(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)) }
  }
  if (body instanceof ReadableStream) {
    const bytes = new Uint8Array(await new Response(body).arrayBuffer())
    return { key: bytesKey(bytes), replacement: bytes as BodyInit }
  }
  if (body instanceof FormData) {
    // Reading entries does not consume the body; fetch re-serializes it.
    const parts: string[] = []
    for (const [name, value] of body.entries()) {
      parts.push(name, typeof value === 'string' ? value : await (value as Blob).text())
    }
    return { key: parts.join(' ') }
  }
  return null
}

function bytesKey(bytes: Uint8Array) {
  return Buffer.from(bytes).toString('base64')
}

function requestNextOptions(input: unknown): NextFetchOptions | undefined {
  return (input as { next?: NextFetchOptions } | null | undefined)?.next
}

function requestCacheOption(input: unknown): RequestCache | undefined {
  if (input instanceof Request) return input.cache
  return undefined
}

type CacheMode = 'cache' | 'dedupe' | 'bypass'

function cacheModeFor(
  cacheOption: RequestCache | undefined,
  revalidate: number | false | undefined,
  segmentFetchCache: string | undefined,
  method: string,
  staticGeneration: boolean,
): CacheMode {
  if (segmentFetchCache === 'force-no-store' || segmentFetchCache === 'only-no-store') {
    return 'dedupe'
  }
  // Segment-level force-cache supersedes even explicit no-store fetch options.
  if (segmentFetchCache === 'force-cache' || segmentFetchCache === 'only-cache') {
    return revalidate === 0 ? 'dedupe' : 'cache'
  }
  if (cacheOption === 'no-store' || cacheOption === 'no-cache' || revalidate === 0) {
    return 'dedupe'
  }
  if (
    cacheOption === 'force-cache' ||
    revalidate === false ||
    (typeof revalidate === 'number' && revalidate > 0)
  ) {
    return 'cache'
  }
  // Auto (no explicit option): uncached per-request at runtime, but during
  // static generation a plain GET defaults to force-cache (Next semantics).
  // POST/PUT/etc. with a request init are never cached.
  //
  // cacheComponents drops that implicit caching: an uncached fetch is DYNAMIC
  // data, so a prerender postpones the boundary around it instead of baking the
  // response in (cache-components-errors dynamic-boundary expects the prerender
  // to keep its `<Suspense>` fallbacks).
  if (staticGeneration && method === 'GET' && !cacheComponents()) return 'cache'
  return 'dedupe'
}

function fetchCacheKey(request: NormalizedFetchRequest): string {
  const headers = request.headers
    .filter(([name]) => name !== 'traceparent' && name !== 'tracestate')
    .sort((a, b) => a[0].localeCompare(b[0]))
  return JSON.stringify([request.method, request.url, headers, request.body ?? null])
}

function fetchEntryExpired(entry: FetchCacheEntry) {
  return (
    entry.revalidateSeconds !== undefined &&
    realNow() - entry.storedAt >= entry.revalidateSeconds * 1000
  )
}

// Staleness as seen by the CURRENT fetch call: its own `revalidate` window,
// applied against the (URL-shared) entry's age. Complements fetchEntryExpired,
// which only knows the window baked in when the entry was stored — a later
// reader with a shorter revalidate must still see its own expiry.
function currentRequestExpired(entry: FetchCacheEntry, revalidateSeconds: number | undefined) {
  return revalidateSeconds !== undefined && realNow() - entry.storedAt >= revalidateSeconds * 1000
}

function storeFetchEntry(
  key: string,
  original: typeof globalThis.fetch,
  input: Parameters<typeof globalThis.fetch>[0],
  init: RequestInit | undefined,
  tags: readonly string[],
  revalidateSeconds: number | undefined,
  serveStale?: FetchCacheEntry,
): Promise<FetchSnapshot> {
  const value = snapshotFetch(original, input, init)
  // Same contract as the 'use cache' / data-cache fills: a build prerender's
  // task boundary waits for an in-flight CACHED fetch rather than cutting it
  // short, so its result still lands in the static shell (core ppr).
  void trackPrerenderCacheFill(value)
  const producingMeta = currentRenderCacheMeta()
  const route = serveStale?.route ?? producingMeta?.route
  const stored: FetchCacheEntry = {
    value,
    // realNow: a build prerender freezes Date.now() to 0 (prerender
    // determinism); a 0-stamped entry persisted into the resume-data sidecar
    // reads as older than every revalidation mark forever.
    storedAt: realNow(),
    tags,
    revalidateSeconds,
    tagSeq: currentTagRevalidationSeq(),
    ...(producingMeta !== undefined ? { refreshedIn: producingMeta } : {}),
    ...(route !== undefined ? { route } : {}),
    // A background refresh replaces the entry: the routes that had joined its
    // revalidation scope keep it (they still read this key).
    ...(serveStale?.readRoutes?.length ? { readRoutes: [...serveStale.readRoutes] } : {}),
  }
  if (serveStale) {
    value.then(
      snapshot => {
        if (snapshot.status === 200) {
          fetchCache.set(key, stored)
          void persistFetchEntry(key, snapshot, tags, revalidateSeconds)
        } else serveStale.refreshing = false
      },
      () => {
        serveStale.refreshing = false
      },
    )
    return value
  }
  if (fetchCache.size >= fetchCacheLimit) {
    const oldest = fetchCache.keys().next().value
    if (oldest !== undefined) fetchCache.delete(oldest)
  }
  fetchCache.set(key, stored)
  captureFetchRdcEntry(key)
  value.then(
    snapshot => {
      // Only 200s are cached (Next does not cache error statuses).
      if (snapshot.status !== 200 && fetchCache.get(key) === stored) fetchCache.delete(key)
      else void persistFetchEntry(key, snapshot, tags, revalidateSeconds)
    },
    () => {
      if (fetchCache.get(key) === stored) fetchCache.delete(key)
    },
  )
  return value
}

/** Snapshot <-> serializable value stored through the custom cache handler. */
interface PersistedFetch {
  status: number
  statusText: string
  headers: [string, string][]
  body: string
  url: string
}

function persistedSnapshot(value: unknown): FetchSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Partial<PersistedFetch>
  if (typeof v.status !== 'number' || typeof v.body !== 'string') return undefined
  return {
    status: v.status,
    statusText: v.statusText ?? '',
    headers: v.headers ?? [],
    body: new Uint8Array(Buffer.from(v.body, 'base64')),
    url: v.url ?? '',
  }
}

async function persistFetchEntry(
  key: string,
  snapshot: FetchSnapshot,
  tags: readonly string[],
  revalidateSeconds: number | undefined,
): Promise<void> {
  if (!hasCacheHandler()) return
  const value: PersistedFetch = {
    status: snapshot.status,
    statusText: snapshot.statusText,
    headers: snapshot.headers,
    body: Buffer.from(snapshot.body).toString('base64'),
    url: snapshot.url,
  }
  // fetchCache/fetchUrl mirror Next's incremental-cache ctx for fetch writes;
  // custom handlers key their logging/persistence off them.
  await cacheHandlerSet(key, value, {
    tags,
    revalidate: revalidateSeconds ?? false,
    fetchCache: true,
    fetchUrl: snapshot.url || undefined,
  })
}

async function snapshotFetch(
  original: typeof globalThis.fetch,
  input: Parameters<typeof globalThis.fetch>[0],
  init?: RequestInit,
): Promise<FetchSnapshot> {
  const response = await original(input, init)
  const body = new Uint8Array(await response.arrayBuffer())
  const headers = [...response.headers.entries()].filter(
    ([name]) => !['content-encoding', 'content-length', 'transfer-encoding'].includes(name),
  )
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body,
    url: response.url,
  }
}

function snapshotResponse(snapshot: FetchSnapshot): Response {
  const response = new Response(snapshot.body.slice() as BodyInit, {
    status: snapshot.status,
    statusText: snapshot.statusText,
    headers: snapshot.headers,
  })
  // Response.url is read-only and lost through the constructor; restore it.
  if (snapshot.url) {
    Object.defineProperty(response, 'url', { value: snapshot.url, configurable: true })
  }
  return response
}

/** Test hook: drop all cached fetch entries. */
export function clearFetchCache() {
  fetchCache.clear()
}
