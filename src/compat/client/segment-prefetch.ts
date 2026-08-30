import {
  decodeSegmentPayload,
  recordAppShell,
  recordSegment,
  segmentPrefetchCovered,
  takeSegment,
} from './segment-cache'
import { getStaleTimeMs } from '../segment/vary-key'

const SEGMENT_PREFETCH_HEADER = 'next-router-segment-prefetch'
const APP_SHELL_PREFETCH_HEADER = 'x-pnext-app-shell'
const INDEX_SEGMENT_PATH = '/_index'
const TREE_SEGMENT_PATH = '/_tree'
const RSC_QUERY = '_rsc'
const SEGMENT_CACHE_LIMIT = 64

type Priority = 'low' | 'high'

interface SegmentEntry {
  time: number
  staleTimeMs: number
}

interface ScheduledPrefetch {
  controller: AbortController
  priority: Priority
}

const treeCache = new Map<string, SegmentEntry>()
const scheduled = new WeakMap<Element, ScheduledPrefetch>()
const watched = new WeakSet<Element>()
let observer: IntersectionObserver | undefined
let installed = false

export function installSegmentPrefetchRuntime(): void {
  if ((!process.browser && typeof window === 'undefined') || installed) return
  installed = true
  document.addEventListener('pointerover', onIntent, true)
  document.addEventListener('touchstart', onIntent, { capture: true, passive: true })
  document.addEventListener('focusin', onIntent, true)
  watchLinks()
}

function watchLinks(): void {
  scanLinks(document.documentElement)
  const mutations = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element) scanLinks(node)
      }
    }
  })
  mutations.observe(document.documentElement, { childList: true, subtree: true })
}

function scanLinks(root: Element): void {
  const links = [...root.querySelectorAll<HTMLAnchorElement>('a[data-pnext-link]')]
  if (root.matches('a[data-pnext-link]')) links.push(root as HTMLAnchorElement)
  for (const link of links) {
    if (watched.has(link)) continue
    if (link.getAttribute('data-prefetch') === 'false') continue
    watched.add(link)
    observer ??= new IntersectionObserver(onVisibility)
    observer.observe(link)
  }
}

function onVisibility(entries: IntersectionObserverEntry[]): void {
  for (const entry of entries) {
    const link = entry.target
    if (entry.isIntersecting) {
      // Revealing a link prefetches the BODY segment too, not just the route
      // tree: Next's default prefetch fetches the route's static data, and the
      // shared segment cache is fed from that body response (see
      // `prefetchSegment`). A tree-only reveal left the cache empty, so the
      // navigation that follows had nothing cached to paint.
      schedule(link, 'low')
    } else {
      scheduled.get(link)?.controller.abort()
      scheduled.delete(link)
    }
  }
}

function onIntent(event: Event): void {
  const link = linkFromEvent(event)
  if (!link || link.getAttribute('data-prefetch') === 'false') return
  scheduled.get(link)?.controller.abort()
  scheduled.delete(link)
  schedule(link, 'high')
}

function schedule(link: Element, priority: Priority): void {
  const href = link.getAttribute('href')
  if (!href || isBotUserAgent()) return
  const url = softUrl(href)
  if (!url) return
  const current = scheduled.get(link)
  if (current?.priority === 'high') return
  const controller = new AbortController()
  scheduled.set(link, { controller, priority })
  void prefetchSegments(url, { priority, signal: controller.signal })
    // Best-effort: an aborted (link left viewport / superseded) or failed
    // segment prefetch must never surface as an unhandled rejection — the
    // client error runtime would swap the live page for the global error.
    .catch(() => undefined)
    .finally(() => {
      if (scheduled.get(link)?.controller === controller) scheduled.delete(link)
    })
}

async function prefetchSegments(
  url: URL,
  options: { priority: Priority; signal: AbortSignal },
): Promise<void> {
  const staleTimeMs = await prefetchSegment(url, TREE_SEGMENT_PATH, options)
  if (options.signal.aborted) return
  await prefetchSegment(url, INDEX_SEGMENT_PATH, options, staleTimeMs)
}

async function prefetchSegment(
  url: URL,
  segment: string,
  options: { priority: Priority; signal: AbortSignal },
  fallbackStaleTimeMs = 30_000,
): Promise<number> {
  // Dedupe against the VARY-AWARE segment cache, never a second URL-keyed map in
  // front of it: `recordSegment` files every body response under its vary key, so
  // a route whose segments read no params already has an entry serving this URL
  // and re-fetching it is the network request the suites assert never happens.
  // The tree response carries no vary metadata, so it keeps its own pathname map.
  if (segment === TREE_SEGMENT_PATH) {
    const cached = treeCache.get(url.pathname)
    if (cached && Date.now() - cached.time < cached.staleTimeMs) return cached.staleTimeMs
  } else {
    // A hit alone is not a dedupe: `takeSegment` also returns PAINT-only
    // entries (a postponed body, a shared shell, another URL's runtime
    // sample), and those still have real content to fetch. Only a
    // network-free hit dedupes here. (client/router/index.ts's
    // `segmentVaryPrefetchSatisfied` uses the weaker `prefetchSatisfied`; this
    // is the App-Shell scheduler, whose shells are shared by construction, so
    // the weaker rule would dedupe away the shell fetch that primes them.)
    const hit = takeSegment({
      pathname: url.pathname,
      search: url.search,
      segmentPath: INDEX_SEGMENT_PATH,
    })
    if (hit?.networkFree === true) return fallbackStaleTimeMs
    // …plus the one case `takeSegment` deliberately refuses to share: a PPR
    // SHELL (postponed, so neither complete nor `x-nextjs-prerender`) whose
    // published vary set already covers this URL. Nothing about it would differ
    // if we fetched it again.
    const covered = segmentPrefetchCovered({
      pathname: url.pathname,
      search: url.search,
      segmentPath: INDEX_SEGMENT_PATH,
    })
    if (covered) return fallbackStaleTimeMs
  }
  const response = await fetch(withRscQuery(url.href), {
    headers: {
      rsc: '1',
      'next-router-prefetch': '1',
      [SEGMENT_PREFETCH_HEADER]: segment,
    },
    credentials: 'same-origin',
    priority: options.priority,
    signal: options.signal,
  })
  if (!response.ok) return fallbackStaleTimeMs
  const body = await response.text()
  const staleTimeMs = getStaleTimeMs(headerStaleTimeSeconds(response))
  // The RECORDED entry keeps the response's own window: a `stale: 0` /
  // expireNow payload is born stale by contract, and clamping it would let a
  // revalidated route serve pre-revalidation bytes for 30s. The floor exists
  // to stop a prefetch LOOP, so it applies to the dedupe window only.
  const rawSeconds = headerStaleTimeSeconds(response)
  const recordStaleTimeMs = (Number.isFinite(rawSeconds) ? rawSeconds : 300) * 1000
  if (segment === TREE_SEGMENT_PATH) {
    treeCache.set(url.pathname, { time: Date.now(), staleTimeMs })
    trim(treeCache)
  }
  // The BODY response is the route's static stage. Recording it into the shared
  // segment cache is the whole point of the prefetch: without it the payload was
  // fetched, timed and thrown away, and the navigation that followed a reveal
  // had nothing to paint (Segment-M2 fix-forward 3). The tree response carries no
  // markup, so only the body segment is recorded.
  if (segment === INDEX_SEGMENT_PATH) recordBodySegment(url, response, body, recordStaleTimeMs)
  return staleTimeMs
}

/** File one `/_index` body-prefetch response into the shared segment cache. */
function recordBodySegment(url: URL, response: Response, body: string, staleTimeMs: number): void {
  const decoded = decodeSegmentPayload(body, INDEX_SEGMENT_PATH)
  if (!decoded) return
  // Mirrors the router's own segment-prefetch bookkeeping (client/router/index.ts
  // recordSegmentEntry): a runtime (request-sampled) shell reports its own
  // completeness, everything else is complete unless the render postponed.
  const runtime = response.headers.get('x-pnext-runtime-prefetch') === '1'
  const complete = runtime
    ? response.headers.get('x-pnext-runtime-complete') === '1'
    : response.headers.get('x-pnext-segment-postponed') !== '1'
  recordSegment({
    segmentPath: INDEX_SEGMENT_PATH,
    pathname: url.pathname,
    search: url.search,
    html: decoded.html,
    staleTimeMs,
    complete,
    static: response.headers.get('x-nextjs-prerender') === '1',
    runtime,
    vary: decoded.vary,
    ...(decoded.shell ? { shell: decoded.shell } : {}),
    route: decoded.route,
    params: decoded.params,
  })
  // A per-URL static prerender of a params-reading route also primes the route's
  // shared App Shell (no-op unless experimental.appShells is on).
  scheduleAppShellPrefetch({
    pathname: url.pathname,
    route: decoded.route,
    vary: decoded.vary,
    static: response.headers.get('x-nextjs-prerender') === '1',
    complete,
    runtime,
  })
}

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

function linkFromEvent(event: Event): Element | null {
  const target = event.target
  return target instanceof Element ? target.closest('a[data-pnext-link]') : null
}

function softUrl(href: string): URL | null {
  try {
    const url = new URL(href, location.href)
    return url.origin === location.origin ? url : null
  } catch {
    return null
  }
}

function isBotUserAgent(): boolean {
  return /Googlebot(?!-)|Googlebot$|bingbot|Slurp|DuckDuckBot|Baiduspider|YandexBot/i.test(
    navigator.userAgent,
  )
}

function trim(cache: Map<string, SegmentEntry>): void {
  while (cache.size > SEGMENT_CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) return
    cache.delete(oldest)
  }
}

// App Shells: the second (param-stripped) prefetch.
//
// Revealing a link fires the ordinary per-segment prefetch of that exact URL. Under
// `experimental.appShells` a route whose segments DO read params gets a second request as well: the
// route's shared App Shell, rendered with `params` hanging. Its vary set comes back EMPTY, so the client
// files it at the fallback vary path and a navigation to any other param of the same route paints it
// instantly while the per-URL response streams in.
//
// Only ever fired for a route the server answered with a COMPLETE STATIC per-URL prerender: a
// runtime-prefetch route's own body prefetch already IS the shared shell, and a param-independent
// response (empty vary set) already serves every URL.

/** Routes whose shared shell has been requested; one request per route, ever. */
const appShellRequested = new Set<string>()

export interface AppShellPrefetchInput {
  /** The URL whose per-segment prefetch just landed. */
  pathname: string
  /** Route pattern the response reported (colon form), or null. */
  route: string | null
  /** The response's vary set, or null when it published none. */
  vary: readonly string[] | null
  static: boolean
  complete: boolean
  runtime: boolean
}

export function scheduleAppShellPrefetch(input: AppShellPrefetchInput): void {
  if (!appShellsEnabled()) return
  if (input.runtime || !input.static || !input.complete) return
  const route = input.route
  // A route with no dynamic segment has nothing to share across params, and a
  // response that read no params is already the shared entry.
  if (!route?.includes(':')) return
  if (!input.vary || input.vary.length === 0) return
  if (appShellRequested.has(route)) return
  appShellRequested.add(route)
  void fetchAppShell(input.pathname).catch(() => {
    // Best-effort: a failed shell prefetch just means the next navigation to an
    // unprefetched param of this route waits for its own response.
    appShellRequested.delete(route)
  })
}

async function fetchAppShell(pathname: string): Promise<void> {
  const response = await fetch(withRscQuery(pathname, 'app-shell'), {
    headers: {
      rsc: '1',
      'next-router-prefetch': '1',
      [SEGMENT_PREFETCH_HEADER]: INDEX_SEGMENT_PATH,
      [APP_SHELL_PREFETCH_HEADER]: '1',
    },
    credentials: 'same-origin',
    priority: 'low',
  })
  if (!response.ok) return
  const decoded = decodeSegmentPayload(await response.text(), INDEX_SEGMENT_PATH)
  if (!decoded) return
  recordAppShell({
    segmentPath: INDEX_SEGMENT_PATH,
    pathname,
    search: '',
    html: decoded.shell?.html ?? decoded.html,
    // Recorded with the response's own window (NaN → the old 300s fallback):
    // the 30s floor is a re-prefetch dedupe rule, not a payload lifetime.
    staleTimeMs: (seconds => (Number.isFinite(seconds) ? seconds : 300) * 1000)(
      headerStaleTimeSeconds(response),
    ),
    complete: false,
    static: response.headers.get('x-nextjs-prerender') === '1',
    runtime: false,
    vary: [],
    route: decoded.shell?.route ?? decoded.route,
    params: decoded.params,
  })
}

function appShellsEnabled(): boolean {
  if (!process.browser && typeof window === 'undefined') return false
  return (window as { __PNEXT_APP_SHELLS__?: boolean }).__PNEXT_APP_SHELLS__ === true
}

/** Test seam: forget which routes have already primed their shared shell. */
export function resetAppShellPrefetches(): void {
  appShellRequested.clear()
}

/** Drop all prefetch dedupe state — a revalidation invalidated every window. */
export function resetSegmentPrefetchDedupe(): void {
  treeCache.clear()
  appShellRequested.clear()
}
