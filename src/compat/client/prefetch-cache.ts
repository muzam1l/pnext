// Client prefetch-cache policy (COMPAT - ships to the browser).
//
// Core's router owns a single HTML-swap prefetch cache with a flat TTL. Next's semantics split that
// window into a static staleTime and a dynamic staleTime, overridable through
// `experimental.staleTimes.{static,dynamic}`, and it seeds the cache from visited pages, uses low fetch
// priority for viewport prefetches, and skips prefetching entirely for bot user agents.
//
// The exact static/dynamic distinction Next draws is a property of the RSC segment payload. On the
// HTML-swap model the router can still learn a route's staleness from the `x-nextjs-stale-time`
// response header; when present it wins, otherwise the entry falls back to the configured dynamic
// window. This module is the single source of the windows plus the config override, read by the core
// router through a registered hook so core carries no next.config dependency.
//
// Injected into the client at build time as `window.__PNEXT_STALE_TIMES__`; undefined means Next defaults.

/** Next's built-in prefetch staleTimes (milliseconds). */
// Since Next 15 the DYNAMIC default is 0: dynamic data is never reused across
// navigations unless `experimental.staleTimes.dynamic` opts in. (The loading
// shell of a dynamic route still reuses for the STATIC window.)
export const DEFAULT_DYNAMIC_STALE_TIME_MS = 0
export const DEFAULT_STATIC_STALE_TIME_MS = 300_000
/** Next's runtime-prefetch stale threshold (RUNTIME_PREFETCH_DYNAMIC_STALE). */
const RUNTIME_DOCUMENT_STALE_TIME_MS = 30_000

/** Shape injected by the server (seconds, mirroring next.config). */
interface StaleTimesConfig {
  /** experimental.staleTimes.dynamic (seconds). */
  dynamic?: number
  /** experimental.staleTimes.static (seconds). */
  static?: number
}

declare global {
  interface Window {
    __PNEXT_STALE_TIMES__?: StaleTimesConfig
  }
}

function configuredStaleTimes(): StaleTimesConfig {
  if (!process.browser && typeof window === 'undefined') return {}
  return window.__PNEXT_STALE_TIMES__ ?? {}
}

function windowFromSeconds(value: number | undefined, fallbackMs: number): number {
  // A configured 0 means "always fresh" (never reuse) — honour it exactly.
  return typeof value === 'number' && Number.isFinite(value) ? value * 1000 : fallbackMs
}

/** The dynamic prefetch window in ms (config override or 30s default). */
export function dynamicStaleTimeMs(): number {
  return windowFromSeconds(configuredStaleTimes().dynamic, DEFAULT_DYNAMIC_STALE_TIME_MS)
}

/** The static prefetch window in ms (config override or 300s default). */
export function staticStaleTimeMs(): number {
  return windowFromSeconds(configuredStaleTimes().static, DEFAULT_STATIC_STALE_TIME_MS)
}

/**
 * The reuse window for a prefetched/visited entry. `prefetchFull` marks a `prefetch={true}` full-page
 * prefetch, which Next reuses for the FULL static window even when the route itself is dynamic - it
 * wins over the header. A route that reported an explicit `x-nextjs-stale-time` uses that value;
 * otherwise the entry is treated as dynamic.
 *
 * `static`/`runtime` classify a per-segment entry (the cached static stage a navigation paints before
 * its dynamic stage lands). A STATIC payload reports its own staleness and that value is authoritative:
 * widening it to the configured static window keeps painting an expired static stage. A RUNTIME payload
 * is request-sampled data, never static content: it reuses for the window its own short-lived cache
 * reported, or the dynamic window when the response named none - never the static one.
 *
 * The header value is used RAW here, not through `getStaleTimeMs`: this cache backs the classic
 * staleTimes semantics, where a configured `staleTimes.dynamic: 0` must mean "never reuse". The clamp
 * applies only to the per-segment cache.
 */
export function staleTimeForEntryMs(options: {
  headerStaleTimeSeconds?: number
  prefetchFull?: boolean
  static?: boolean
  runtime?: boolean
  runtimeDocument?: boolean
}): number {
  // A NAVIGATION document of an `allow-runtime` route: its header reports the route's PUBLIC cache
  // window (the private/runtime caches resolve after the headers flushed), but the content is
  // request-sampled. Next files no such entry from a navigation at all - the runtime-prefetch stream is
  // what seeds its segment cache - so anything recorded from the document must not outlive the
  // runtime-prefetch threshold: shorter-lived private caches are hung out of runtime samples entirely.
  if (options.runtimeDocument) {
    const headerMs =
      typeof options.headerStaleTimeSeconds === 'number'
        ? options.headerStaleTimeSeconds * 1000
        : Number.POSITIVE_INFINITY
    return Math.min(headerMs, RUNTIME_DOCUMENT_STALE_TIME_MS)
  }
  if ((options.static || options.runtime) && typeof options.headerStaleTimeSeconds === 'number') {
    return options.headerStaleTimeSeconds * 1000
  }
  if (options.runtime) return dynamicStaleTimeMs()
  if (options.prefetchFull) {
    return Math.max(
      staticStaleTimeMs(),
      typeof options.headerStaleTimeSeconds === 'number'
        ? options.headerStaleTimeSeconds * 1000
        : 0,
    )
  }
  if (typeof options.headerStaleTimeSeconds === 'number') {
    return options.headerStaleTimeSeconds * 1000
  }
  return dynamicStaleTimeMs()
}
