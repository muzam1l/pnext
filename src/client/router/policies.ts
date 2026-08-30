// IDLE-TIER POLICY SEAMS. Compat registers Next-shaped policies for prefetch windows, loading
// shells, stylesheet order, the segment cache and export-mode documents; core keeps a flat-TTL
// default for each. Every one is WRITTEN by compat's deferred installer and READ only inside
// ./runtime, so this module belongs to neither entry's static graph - it rides the runtime chunk.
// Seams first paint itself reads stay in ./hub.
import type {
  LoadingShellPredictionPolicy,
  SegmentCachePolicy,
  StylesheetReconciler,
} from './types'

// Fallback reuse window when compat did not register a staleTime policy (pure
// core has no static/dynamic split).
export const PREFETCH_TTL_MS = 300_000

// The static/dynamic staleTime split + experimental.staleTimes override are Next
// semantics; the policy lives in compat (compat/client/prefetch-cache) and is
// registered here so core keeps its flat-TTL default when no compat is present.
export interface PrefetchStaleContext {
  /** Value of `x-nextjs-stale-time` on the prefetch response (seconds), if any. */
  headerStaleTimeSeconds?: number
  /** True for a full-page (prefetch={true}) prefetch — uses the static window. */
  prefetchFull?: boolean
  /**
   * The payload is STATIC (a prerender: bytes are a pure function of the URL). Such a route reports
   * its own staleness, which is authoritative - it must not be widened to the configured static
   * window, or a cached static stage outlives the data it was built from.
   */
  static?: boolean
  /**
   * The payload came from a RUNTIME (request-sampled) prefetch: cookies/headers
   * holes filled at prefetch time. Never static content, so it reuses for the
   * dynamic window at most.
   */
  runtime?: boolean
  /**
   * A NAVIGATION document of an `allow-runtime` route. Its stale-time header
   * reports the route's public cache window; the request-sampled content it
   * carries is only good for the runtime-prefetch threshold (compat caps it).
   */
  runtimeDocument?: boolean
}
export let prefetchStaleTimePolicy: ((ctx: PrefetchStaleContext) => number) | undefined

/** Register the compat prefetch-staleTime policy (ms). */
export function setPrefetchStaleTimePolicy(policy: (ctx: PrefetchStaleContext) => number) {
  prefetchStaleTimePolicy = policy
}

export function prefetchStaleTimeMs(ctx: PrefetchStaleContext): number {
  return prefetchStaleTimePolicy?.(ctx) ?? PREFETCH_TTL_MS
}

// The loading-shell reuse window (Next's STATIC staleTime: the cached loading
// boundary of a route outlives its dynamic data). Compat registers the
// configured static window; core falls back to the flat TTL.
export let shellStaleTimePolicy: (() => number) | undefined
export let loadingShellPredictionPolicy: LoadingShellPredictionPolicy | undefined
export let stylesheetReconciler: StylesheetReconciler | undefined
export let revalidationPrefetchDelayMs = 0

/** Register the compat loading-shell staleTime (ms) — Next's static window. */
export function setShellStaleTimePolicy(policy: () => number) {
  shellStaleTimePolicy = policy
}

/** Register framework-specific matching for cached loading shells. */
export function setLoadingShellPredictionPolicy(policy: LoadingShellPredictionPolicy) {
  loadingShellPredictionPolicy = policy
}

/** Register framework-specific stylesheet ordering after a document swap. */
export function setStylesheetReconciler(reconciler: StylesheetReconciler | undefined) {
  stylesheetReconciler = reconciler
}

/** Register a framework-specific delay before invalidated prefetches retry. */
export function setRevalidationPrefetchDelay(delayMs: number) {
  revalidationPrefetchDelayMs = Math.max(0, delayMs)
}

export function shellStaleTimeMs(): number {
  return shellStaleTimePolicy?.() ?? PREFETCH_TTL_MS
}

// Export-mode document source. An exported build has no server to negotiate with, so its documents
// come from flat artifacts written beside each page. Registered by compat, and ONLY when the running
// document came out of an export; once registered it replaces the server protocol wholesale, so a
// null result is a miss, not a fallback.
type ExportDocumentFetcher = (
  href: string,
  init: RequestInit,
  prefetch: boolean,
) => Promise<{ html: string; finalUrl: string } | null>
export let exportDocumentFetcher: ExportDocumentFetcher | undefined

/** Register the compat `output: 'export'` document fetcher. */
export function setExportDocumentFetcher(fetcher: ExportDocumentFetcher) {
  exportDocumentFetcher = fetcher
}

// Next's segment cache (compat/client/segment-cache).
export let segmentCachePolicy: SegmentCachePolicy | undefined

export function setSegmentCachePolicy(policy: SegmentCachePolicy): void {
  segmentCachePolicy = policy
}
