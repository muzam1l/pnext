import {
  decodeSegmentPayload,
  predictedRouteFor,
  recordResolvedRoute,
  recordSegment,
  resolvedRouteFor,
  takeSegment,
  trimOldest,
} from './segment-cache'
import { prefetchRoute } from '../../client/router'
import { currentNavState } from '../../client/router/history'
import { graftSegmentChildren } from '../../client/router/page-slot'

const INDEX_SEGMENT_PATH = '/_index'
const RSC_QUERY = '_rsc'

/** The response's reported staleness in seconds, NaN when it reported none. */
function headerStaleTimeSeconds(response: Response): number {
  const header = response.headers.get('x-nextjs-stale-time')
  return header === null ? Number.NaN : Number(header)
}

function withRscQuery(href: string, variant = ''): string {
  const url = new URL(href, location.href)
  if (url.searchParams.has(RSC_QUERY)) return url.href
  const hash = rscHash(url.pathname + url.search + (variant ? `#${variant}` : ''))
  const separator = url.search ? '&' : '?'
  return `${url.origin}${url.pathname}${url.search}${separator}${RSC_QUERY}=${hash}${url.hash}`
}

function rscHash(input: string): string {
  let hash = 0
  for (let index = 0; index < input.length; index++) {
    hash = (Math.imul(31, hash) + input.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(36)
}

// Prefetched URLs the server redirected, by pathname+search: the target serves their navigations.
const learnedRedirects = new Map<string, { href: string; until: number }>()

export function learnRedirect(from: URL, to: URL, staleTimeMs: number): boolean {
  if (to.origin !== from.origin || to.pathname + to.search === from.pathname + from.search)
    return false
  learnedRedirects.set(from.pathname + from.search, {
    href: to.href,
    until: Date.now() + staleTimeMs,
  })
  trimOldest(learnedRedirects)
  return true
}

export function redirectTarget(url: URL): URL | null {
  const entry = learnedRedirects.get(url.pathname + url.search)
  if (!entry || entry.until <= Date.now()) return null
  const target = new URL(entry.href)
  target.hash = url.hash
  return target
}

interface RuntimeResult {
  complete: boolean
  staleTimeMs: number
}

// Runtime prefetches in flight (until: Infinity) or still fresh, by header + URL.
const runtimeRequested = new Map<string, { until: number; result: Promise<RuntimeResult | null> }>()
// Bumped by every invalidation, so a response in flight across one never repopulates the caches.
let runtimeGeneration = 0
// Static prefetches that landed before the async `_buildManifest.js` ran, by URL; replayed by its callback.
let manifestPending: Map<string, Parameters<typeof scheduleRuntimePrefetch>[0]> | undefined

// Partial Prefetching: an App Shell first (`3` or static), then a per-URL `2` only for a full link.
export const PARTIAL_PREFETCHING = 0b10
export const STATIC_SHELL = 0b100000000000000
const STATIC_PREFETCH = 0b1000000000000000
const HEAD_OUTLINED = 0b100000000
/** Partial Prefetching route pattern (colon form) → the root node's prefetch hints. */
const routeHints = new Map<string, number>()
// Pathname → its Partial Prefetching route; like the hints, it outlives an invalidation.
const partialRoutes = new Map<string, string>()

/** Learn a Partial Prefetching route's hints from its `/_tree` response headers. */
export function recordRouteTree(href: string, headers: Headers): void {
  const route = headers.get('x-pnext-segment-route')
  const hints = Number(headers.get('x-pnext-prefetch-hints'))
  if (!route || !(hints & PARTIAL_PREFETCHING)) return
  const { pathname } = new URL(href, location.href)
  recordResolvedRoute(pathname, route)
  routeHints.set(route, headers.has('x-pnext-head-outlined') ? hints | HEAD_OUTLINED : hints)
  partialRoutes.delete(pathname)
  partialRoutes.set(pathname, route)
  trimOldest(partialRoutes)
}

/** The learned Partial Prefetching route predicted to serve `pathname`: its tree needs no request. */
export function predictPartialRoute(pathname: string): string | null {
  if (routeHints.size === 0) return null
  const route = predictedRouteFor(pathname)
  return route && routeHints.has(route) ? route : null
}

/** The Partial Prefetching hints of the route serving `pathname`, or 0. */
function partialHints(pathname: string): number {
  const route =
    resolvedRouteFor(pathname) ?? partialRoutes.get(pathname) ?? predictedRouteFor(pathname)
  return route ? (routeHints.get(route) ?? 0) : 0
}

/** True when this issues a Partial Prefetching route's runtime requests in place of the static body. */
export function deferBodyPrefetch(href: string, full: boolean, treeHeaders?: Headers): boolean {
  if (treeHeaders) recordRouteTree(href, treeHeaders)
  if (routeHints.size === 0) return false
  const url = new URL(href, location.href)
  url.searchParams.delete(RSC_QUERY)
  const hints = partialHints(url.pathname)
  if (!hints) return false
  const hit = takeSegment({
    pathname: url.pathname,
    search: url.search,
    segmentPath: INDEX_SEGMENT_PATH,
  })
  if (!hit) {
    if (hints & STATIC_SHELL) return false
    void runPartialPrefetch(url, full)
    return true
  }
  // A per-URL runtime prefetch whose published vary set covers this URL is byte-identical for it.
  if (hit.runtime && !hit.appShell) return true
  // A default link stops at the App Shell; a static body leaves a varying head to the router.
  if (!full) return hit.runtime === true
  if (hit.networkFree) return true
  // Only the App Shell is cached: the static attempt comes first, then its own response decides.
  if (hit.appShell && hints & STATIC_PREFETCH) return false
  // The static body said whether a `2` adds anything; its own `runtimeNeeded` bit outranks that.
  // A sibling's covering body is the whole static prefetch, unless an outlined head is still due.
  if (!hit.appShell && hit.needsRuntime === false && !((hit.runtimeNeeded ?? 0) & 2))
    return hit.shared && hit.prefetchSatisfied && !(hints & HEAD_OUTLINED)
  void runtimePrefetchOnce(url, '2')
  return true
}

const FALLBACK_RETRY_MS = 2000
const FALLBACK_RETRIES = 3
/** URL keys whose fallback retry loop has run (at most one loop per URL, ever). */
const fallbackRetried = new Set<string>()

/** An upgradeable ISR fallback landed: retry the static body until the concrete prerender exists (a full link also runtime-prefetches on 1). */
function onFallbackPrefetch(url: URL, full: boolean, fallback: 1 | 2): void {
  if (full && fallback === 1) void runtimePrefetchOnce(url, '2')
  const key = url.pathname + url.search
  if (fallbackRetried.has(key)) return
  fallbackRetried.add(key)
  trimOldest(fallbackRetried)
  void (async () => {
    for (let attempt = 0; attempt < FALLBACK_RETRIES; attempt++) {
      await new Promise(resolve => setTimeout(resolve, FALLBACK_RETRY_MS))
      const response = await fetch(withRscQuery(url.href, 'retry'), {
        headers: {
          rsc: '1',
          'next-router-prefetch': '1',
          'next-router-segment-prefetch': INDEX_SEGMENT_PATH,
        },
        credentials: 'same-origin',
        priority: 'low',
      }).catch(() => null)
      if (!response?.ok) return
      if (response.headers.get('x-pnext-fallback')) continue
      const decoded = decodeSegmentPayload(await response.text(), INDEX_SEGMENT_PATH)
      if (!decoded) return
      const seconds = headerStaleTimeSeconds(response)
      recordSegment({
        segmentPath: INDEX_SEGMENT_PATH,
        pathname: url.pathname,
        search: url.search,
        html: decoded.html,
        staleTimeMs: (Number.isFinite(seconds) ? seconds : 300) * 1000,
        complete: response.headers.get('x-pnext-segment-postponed') !== '1',
        static: response.headers.get('x-nextjs-prerender') === '1',
        runtime: false,
        vary: decoded.vary,
        route: decoded.route,
        params: decoded.params,
        runtimeNeeded: Number(response.headers.get('x-pnext-runtime-needed')) || undefined,
      })
      return
    }
  })()
}

/** A static body prefetch of a Partial Prefetching route landed: follow up with its runtime requests. */
export function followPartialPrefetch(input: {
  pathname: string
  search: string
  full: boolean
  /** The server said a runtime request would return more than this static body (`x-pnext-needs-runtime`). */
  needsRuntime: boolean
  fallback?: 1 | 2
  /** `x-pnext-runtime-needed` bits of the response: 1 shell, 2 prefetch. */
  runtimeNeeded?: number
}): boolean {
  if (routeHints.size === 0) return false
  const hints = partialHints(input.pathname)
  if (!hints) return false
  const url = new URL(input.pathname + input.search, location.href)
  url.searchParams.delete(RSC_QUERY)
  if (input.fallback) onFallbackPrefetch(url, input.full, input.fallback)
  // The response's own verdict outranks the tree's hints, which go stale after a revalidation.
  const needed = input.runtimeNeeded ?? 0
  if (!(hints & STATIC_SHELL) || needed & 1) void runPartialPrefetch(url, input.full)
  else if (input.full && (input.needsRuntime || needed & 2)) void runtimePrefetchOnce(url, '2')
  return true
}

/** The App Shell request, then (for a full link) the per-URL prefetch unless the shell was complete. */
async function runPartialPrefetch(url: URL, full: boolean): Promise<void> {
  const shell = await runtimePrefetchOnce(url, '3')
  if (full && shell?.complete !== true) await runtimePrefetchOnce(url, '2')
}

/** One runtime request per header + URL while in flight or fresh; later callers share its result. */
function runtimePrefetchOnce(url: URL, header: '2' | '3'): Promise<RuntimeResult | null> {
  const search = header === '3' ? '' : url.search
  const key = `${header}:${url.pathname}${search}`
  const pending = runtimeRequested.get(key)
  // A settled request dedupes only while its entry survives (a refresh evicts page segments).
  if (
    pending &&
    pending.until > Date.now() &&
    (pending.until === Number.POSITIVE_INFINITY ||
      takeSegment({ pathname: url.pathname, search, segmentPath: INDEX_SEGMENT_PATH }))
  ) {
    return pending.result
  }
  const generation = runtimeGeneration
  const result = fetchRuntimePrefetch(url, generation, header).then(
    done => {
      if (generation === runtimeGeneration) {
        runtimeRequested.set(key, { until: Date.now() + done.staleTimeMs, result })
      }
      return done
    },
    () => {
      if (generation === runtimeGeneration) runtimeRequested.delete(key)
      return null
    },
  )
  runtimeRequested.set(key, { until: Number.POSITIVE_INFINITY, result })
  return result
}

/**
 * Next's runtime prefetch: once the static body prefetch of a route the build lists as runtime-prefetchable
 * (`_buildManifest.js`) lands, fetch its request-sampled body with `next-router-prefetch: 2`. A complete
 * static response already holds the whole page, so it needs none.
 */
export function scheduleRuntimePrefetch(input: {
  pathname: string
  search: string
  route: string | null | undefined
  runtime: boolean
  complete: boolean
}): void {
  if (input.runtime || input.complete || !input.route) return
  const manifest = globalThis as {
    __BUILD_MANIFEST?: object
    __BUILD_MANIFEST_CB?: () => void
    __PNEXT_RUNTIME_PREFETCH__?: string[]
  }
  if (!manifest.__BUILD_MANIFEST) {
    // Dev documents carry no manifest script, so nothing would ever replay the queue.
    if (!document.querySelector('script[src$="/_buildManifest.js"]')) return
    if (!manifestPending) {
      const pending = (manifestPending = new Map<string, typeof input>())
      const previous = manifest.__BUILD_MANIFEST_CB
      manifest.__BUILD_MANIFEST_CB = () => {
        previous?.()
        for (const queued of pending.values()) scheduleRuntimePrefetch(queued)
        pending.clear()
      }
    }
    manifestPending.set(input.pathname + input.search, input)
    return
  }
  if (!manifest.__PNEXT_RUNTIME_PREFETCH__?.includes(input.route)) return
  const url = new URL(input.pathname + input.search, location.href)
  url.searchParams.delete(RSC_QUERY)
  void runtimePrefetchOnce(url, '2')
}

async function fetchRuntimePrefetch(
  url: URL,
  generation: number,
  header: '2' | '3',
): Promise<RuntimeResult> {
  // The soft-nav trio makes the server render the delta below the layouts the current page shares.
  const response = await fetch(withRscQuery(url.href, header === '3' ? 'shell' : 'runtime'), {
    headers: {
      rsc: '1',
      'next-router-prefetch': header,
      'x-pnext-soft-nav': '1',
      'x-pnext-nav-state': encodeURIComponent(JSON.stringify(currentNavState())),
      'next-url': location.pathname + location.search,
      'x-pnext-root-layout': document.documentElement?.getAttribute('data-pnext-root-layout') ?? '',
    },
    credentials: 'same-origin',
    priority: 'low',
  })
  if (!response.ok) throw new Error(`runtime prefetch ${response.status}`)
  const body = await response.text()
  const seconds = headerStaleTimeSeconds(response)
  const staleTimeMs = (Number.isFinite(seconds) ? seconds : 30) * 1000
  const redirect = response.headers.get('location')
  if (response.redirected || redirect) {
    const to = new URL(response.redirected ? response.url : redirect!, url.href)
    to.searchParams.delete(RSC_QUERY)
    if (learnRedirect(url, to, staleTimeMs)) void prefetchRoute(to.href, { full: header === '2' })
    return { complete: true, staleTimeMs }
  }
  const decoded = decodeSegmentPayload(body, INDEX_SEGMENT_PATH)
  const complete = response.headers.get('x-pnext-runtime-complete') === '1'
  if (!decoded || generation !== runtimeGeneration) return { complete, staleTimeMs }
  recordSegment({
    segmentPath: INDEX_SEGMENT_PATH,
    pathname: url.pathname,
    // An App Shell hangs searchParams, so it serves every query of its URL.
    search: header === '3' ? '' : url.search,
    html: withLiveRoot(decoded.html),
    staleTimeMs,
    complete,
    static: false,
    runtime: true,
    ...(header === '3' ? { sharedAppShell: true } : {}),
    vary: decoded.vary,
    route: decoded.route,
    params: decoded.params,
  })
  return { complete, staleTimeMs }
}

/** The server skipped the shared root layout: put the response's children back under the live one. */
function withLiveRoot(html: string): string {
  if (!html.includes('data-pnext-skip="root"')) return html
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const marker = doc.querySelector('pnext-layout[data-pnext-skip=root]')
  const root = document.body.cloneNode(true) as Element
  for (const script of root.querySelectorAll(':scope > script')) script.remove()
  if (!marker || !graftSegmentChildren(root, marker)) return html
  marker.replaceWith(...root.childNodes)
  return `<!DOCTYPE html>${doc.documentElement.outerHTML}`
}

/** Drop all prefetch dedupe state — a revalidation invalidated every window. */
export function resetSegmentPrefetchDedupe(): void {
  resetSegmentDataDedupe()
  // Route hints outlive it: they describe the build, and a refetched tree replaces them.
  runtimeGeneration += 1
  manifestPending = undefined
}

/** Forget which data requests were made; the route trees (and their hints) stay. */
export function resetSegmentDataDedupe(): void {
  runtimeRequested.clear()
  fallbackRetried.clear()
  learnedRedirects.clear()
}
