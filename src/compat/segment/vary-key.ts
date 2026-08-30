// Pure vary-set cache-key helpers, shared by the SERVER vary tracker (./vary-params.ts) and the CLIENT
// segment cache. This module must stay browser-safe: no node: imports - the server-side ALS accumulator
// machinery lives in vary-params.ts, which re-exports these for server callers.

/** The searchParams sentinel: any query access varies the whole query string. */
export const SEARCH_PARAMS_SENTINEL = '?'

/**
 * Field separator inside a segment cache key. A NUL can never appear in a
 * pathname, a route pattern, or a param value, so no field boundary is ambiguous
 * (the same convention router.ts uses for its own composite cache keys).
 */
export const VARY_KEY_SEPARATOR = '\u0000'

/** Next's floor on a prefetch reuse window, and its default when unreported. */
const MIN_PREFETCH_STALE_TIME_SECONDS = 30
const DEFAULT_PREFETCH_STALE_TIME_SECONDS = 300

/**
 * The reuse window (ms) for a prefetch response reporting `seconds` of staleness. Next clamps every
 * prefetch stale time to a 30s FLOOR and treats an absent/unparseable `x-nextjs-stale-time` as the 300s
 * static default. Taking the header raw instead makes a `stale-time: 0` response born stale, so every
 * reveal refetches it - a prefetch loop, never a cache hit.
 */
export function getStaleTimeMs(seconds: number): number {
  const reported = Number.isFinite(seconds) ? seconds : DEFAULT_PREFETCH_STALE_TIME_SECONDS
  return Math.max(reported, MIN_PREFETCH_STALE_TIME_SECONDS) * 1000
}

export function encodeVarySet(names: readonly string[], search = false): string {
  const parts = search ? [...names, SEARCH_PARAMS_SENTINEL] : [...names]
  return parts.join(',')
}

export function decodeVarySet(text: string | null | undefined): string[] | null {
  if (text === null || text === undefined) return null
  if (text === '') return []
  return text.split(',').filter(Boolean)
}

/**
 * The cache key of one segment entry: its route and segment path, plus ONLY the params the segment
 * provably reads (and the query when it read searchParams).
 *
 * An empty vary set yields a key with no param component, so every param value of that route shares a
 * single entry - the whole point of vary tracking. A `null` vary set means the server did not report one:
 * fall back to the exact URL so nothing is ever shared unsoundly.
 */
export function segmentVaryCacheKey(options: {
  /** Route identity (the matched route pattern or id). */
  route: string
  /** Segment request path (`/_index`, `/_head`, `/_tree`, …). */
  segmentPath: string
  /** Concrete params of the URL being keyed. */
  params: Readonly<Record<string, string | string[] | undefined>>
  /** The URL's query string (with or without a leading `?`). */
  search?: string
  /** The segment's vary set, or null when the server reported none. */
  vary: readonly string[] | null
  /** Full URL path, used verbatim when `vary` is null (unknown). */
  pathname: string
}): string {
  const { route, segmentPath, params, vary, pathname } = options
  const search = normalizeSearch(options.search)
  if (vary === null) return `${segmentPath}${VARY_KEY_SEPARATOR}!${pathname}${search}`
  const varied = [...vary].sort()
  const parts: string[] = []
  for (const name of varied) {
    if (name === SEARCH_PARAMS_SENTINEL) continue
    parts.push(`${name}=${encodeParamValue(params[name])}`)
  }
  const query = varied.includes(SEARCH_PARAMS_SENTINEL) ? search : ''
  return `${segmentPath}${VARY_KEY_SEPARATOR}${route}${VARY_KEY_SEPARATOR}${parts.join('&')}${query}`
}

/**
 * The canonical form of a query string inside a segment cache key: sorted, with
 * the `_rsc` CDN cache-buster removed. Exported so callers that compare two
 * URLs for entry identity (the client cache's exact-URL check) normalize them
 * exactly the way the key does.
 */
export function normalizeSegmentSearch(search: string | undefined): string {
  return normalizeSearch(search)
}

function normalizeSearch(search: string | undefined): string {
  if (!search) return ''
  const text = search.startsWith('?') ? search.slice(1) : search
  if (!text) return ''
  // `_rsc` is a CDN cache-buster, never an app param: it must not key entries.
  const query = new URLSearchParams(text)
  query.delete('_rsc')
  const pairs = [...query.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  if (pairs.length === 0) return ''
  return `?${pairs.map(([key, value]) => `${key}=${value}`).join('&')}`
}

function encodeParamValue(value: string | string[] | undefined): string {
  if (value === undefined) return 'absent'
  if (Array.isArray(value)) return value.map(part => encodeURIComponent(part)).join('/')
  return encodeURIComponent(value)
}
