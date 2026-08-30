// Per-segment client cache (COMPAT client policy).
//
// The router's own caches are whole-URL, which cannot express Next's central segment-cache property:
// a segment that provably never READ a param is shareable across every value of that param, so
// `/vary/a` and `/vary/b` hit ONE entry.
//
// This module adds that layer. The server publishes, per segment response, `vary` (the param names
// the render actually read; `'?'` = it read searchParams, so the whole query keys it), `route` (the
// matched route pattern in colon form) and `params` (the concrete params of the URL that produced
// the response). Entries here are keyed by (segmentPath, route, the VARY SUBSET of params,
// query-if-varied), so an empty vary set collapses every param value onto one entry.
//
// Reuse policy: a navigation NEVER short-circuits on a cache hit unless the entry is COMPLETE (a
// whole document, not a truncated shell) AND STATIC (its bytes are a pure function of the URL) AND
// still FRESH. Everything else paints what it has and still issues the dynamic-stage request.
// Runtime prefetches are the one request-sampled exception: a COMPLETE one commits network-free, an
// incomplete one is shell-only.
//
// Cross-URL sharing is deliberately conservative: only a STATIC entry may serve a URL other than the
// one it was fetched for, the target must match the entry's learned route pattern, and a pathname
// already known to resolve to a DIFFERENT route is never predicted.

import {
  normalizeSegmentSearch,
  segmentVaryCacheKey,
  SEARCH_PARAMS_SENTINEL,
  VARY_KEY_SEPARATOR,
} from '../segment/vary-key'
import {
  composeSegmentFrames,
  pageSlotRange,
  stripPageSlotContent,
  stripStreamedContinuation,
} from '../segment/page-slot'

/** LRU bound, matching the router's own segment caches. */
const SEGMENT_ENTRY_LIMIT = 64

/**
 * w9-segment-split: the two derived frames of a body response. The LAYOUT frame
 * is the response document with the page's markup cut out; the PAGE frame is the
 * document as received (only its page-slot content is ever read back out). They
 * are filed under their OWN vary sets, so a navigation whose layout varied and
 * whose page did not re-fetches `/_layout` alone and composes it with the
 * cached page frame.
 */
export const LAYOUT_FRAME_PATH = '/_layout'
export const PAGE_FRAME_PATH = '/_page'

/** The body-segment request key the router sends (`/` is the legacy alias). */
export const BODY_SEGMENT_PATHS = ['/_index', '/', PAGE_FRAME_PATH] as const

export interface SegmentPayloadMeta {
  /** Segment vary names (may include the `?` sentinel), or null when unknown. */
  vary: string[] | null
  /**
   * w9-segment-split: the LAYOUT frame's own vary set, when the server split
   * the response. Null/absent means the response was not split and only the
   * whole-document entry is filed.
   */
  layoutVary?: string[] | null
  /** w9-segment-split: the PAGE frame's own vary set, when the server split. */
  pageVary?: string[] | null
  /** Matched route pattern in colon form, or null. */
  route: string | null
  /** Concrete params of the URL that produced the payload. */
  params: Record<string, string | string[]>
  /**
   * The route's shared APP SHELL, when the per-URL prerender carried one. Filed
   * as its own param-independent entry so a navigation to another param of the
   * route paints instantly.
   */
  shell?: { html: string; route: string }
  /**
   * Literal siblings of each DYNAMIC level of the route, keyed by segment index
   * (the server's `staticChildrenBySegment`). A pathname naming one of them is
   * served by its own static route, so this payload must never key onto it.
   */
  staticSiblings?: Record<string, string[]>
}

export interface SegmentRecordInput extends SegmentPayloadMeta {
  /** Segment request path (`/_index`, `/_head`, …). */
  segmentPath: string
  /** Requested pathname (percent-encoding preserved). */
  pathname: string
  /** Requested query string (leading `?` optional). */
  search: string
  /** The payload the router would commit for this segment. */
  html: string
  /** Reuse window in milliseconds. */
  staleTimeMs: number
  /** True when the payload is a whole document, not a truncated shell. */
  complete: boolean
  /** True when the bytes are a pure function of the URL (a prerender). */
  static: boolean
  /** True when the payload came from a runtime (request-sampled) prefetch. */
  runtime: boolean
  /** True when the server marked the payload its POSTPONED (PPR) shell for this URL. */
  postponedShell?: boolean
  /** True when this is an extracted route-wide App Shell, valid for sibling params too. */
  sharedAppShell?: boolean
  /** True when the route's catch-all is optional (`[[...slug]]`). */
  catchAllOptional?: boolean
}

interface SegmentEntry {
  key: string
  html: string
  /** The URL this payload was fetched for, canonicalized (`_rsc` stripped). */
  url: string
  time: number
  staleTimeMs: number
  complete: boolean
  static: boolean
  runtime: boolean
  postponedShell: boolean
  sharedAppShell: boolean
}

export interface SegmentHit {
  html: string
  /** True when this hit may commit a navigation with no network request. */
  networkFree: boolean
  /**
   * True when a PREFETCH of this URL has nothing left to fetch: the entry is fresh and its own vary set
   * justifies serving this URL. Weaker than `networkFree` - a navigation may still need the dynamic
   * remainder.
   */
  prefetchSatisfied: boolean
  runtime: boolean
  /**
   * The entry is an authorised static shell stage: either this URL's own
   * postponed PPR shell, or an extracted route-wide App Shell.
   */
  postponedShell: boolean
}

interface LearnedRoute {
  route: string
  vary: string[]
  catchAllOptional: boolean
  /** Literal siblings of the route's dynamic levels, by segment index. */
  staticSiblings?: Record<string, string[]>
}

const entries = new Map<string, SegmentEntry>()
/**
 * Learned route vary sets, per segment path, keyed by route + vary set.
 *
 * One route can publish SEVERAL vary sets for the same segment: the per-URL
 * prefetch of `/static-posts/1` reports `['id']` (it rendered the param), while
 * the App-Shell prefetch of the same route reports `[]` (params hung). Both are
 * live candidates for a lookup, so they are kept side by side rather than
 * overwriting each other; `candidateKeys` tries the most specific first.
 * Insertion order = learn order.
 */
const learnedRoutes = new Map<string, Map<string, LearnedRoute>>()
/** pathname -> the route pattern the SERVER resolved it to (sibling guard). */
const resolvedRoutes = new Map<string, string>()

/** Wall clock, overridable in tests (the e2e suites mock `Date`). */
function now(): number {
  return Date.now()
}

// ---------------------------------------------------------------------------
// Recording.
// ---------------------------------------------------------------------------

export function recordSegment(input: SegmentRecordInput): void {
  // A fully-static prerender may carry the route's params-hanging App Shell
  // alongside its concrete per-URL body. File that extracted shell through the
  // same cache seam as every other response so all producers (the router policy
  // and the standalone segment-prefetch scheduler) prime the fallback vary
  // path consistently.
  if (input.shell) {
    recordAppShell({
      segmentPath: input.segmentPath,
      pathname: input.pathname,
      search: '',
      html: input.shell.html,
      staleTimeMs: input.staleTimeMs,
      complete: false,
      static: true,
      runtime: false,
      vary: [],
      route: input.shell.route,
      params: input.params,
    })
  }
  recordOneSegment(input)
  // w9-segment-split: a body response the server split also files its two
  // frames, each under its OWN vary set. Additive — the whole-document entry
  // above is untouched, so nothing that hits today starts missing.
  if (!BODY_SEGMENT_PATHS.includes(input.segmentPath as (typeof BODY_SEGMENT_PATHS)[number])) {
    return
  }
  if (input.segmentPath === PAGE_FRAME_PATH) return
  // The response's layout frame, filed under this URL's EXACT key. Independent of `layoutVary` - the
  // server publishes that set only when it can prove what the layout read, but a frame keyed on the
  // URL it was fetched for needs no such proof. BOTH layout-frame records are skipped when the payload
  // carries no page slot: `stripPageSlotContent` would hand back the whole document, and a "layout
  // frame" with no slot to splice into makes `needsPageFrameOnly` promise a composition that always
  // fails - two serial round trips for one navigation.
  const framable = pageSlotRange(input.html) !== null
  if (framable) {
    recordOneSegment({
      ...input,
      segmentPath: LAYOUT_FRAME_PATH,
      html: stripPageSlotContent(input.html),
      // Exact-URL only: no route, no vary set, so this frame is never shared
      // across params the way a `layoutVary` frame is.
      route: null,
      params: {},
      vary: null,
      complete: false,
    })
  }
  if (framable && input.layoutVary) {
    recordOneSegment({
      ...input,
      segmentPath: LAYOUT_FRAME_PATH,
      html: stripPageSlotContent(input.html),
      vary: input.layoutVary,
      // A layout frame is never the whole page: it may paint, but a navigation
      // still needs the page below it.
      complete: false,
    })
  }
  if (input.pageVary) {
    recordOneSegment({ ...input, segmentPath: PAGE_FRAME_PATH, vary: input.pageVary })
  }
}

/**
 * Extract and file a route-wide App Shell from a prerender response.
 *
 * Next publishes a byte boundary and decodes the Flight prefix again. PNext's
 * segment payload carries HTML, whose equivalent boundary is the first
 * streamed continuation: removing those resolved chunks leaves the original
 * params-hanging Suspense shell.
 */
export function recordAppShell(input: SegmentRecordInput): void {
  recordSegment({
    ...input,
    html: stripStreamedContinuation(input.html),
    complete: false,
    static: true,
    runtime: false,
    postponedShell: true,
    sharedAppShell: true,
    vary: [],
  })
}

/**
 * A payload is REWRITE-PRODUCED when the route the server resolved does not describe the URL it was
 * served at - either structurally, or in its concrete param values.
 *
 * Such a payload must never teach the route trie: a rewrite maps ONE url somewhere, and a sibling URL
 * of the same shape may rewrite somewhere else entirely, or not at all. Learning from it would hand
 * every URL of the pattern a "free" shared shell it is not entitled to, so the router would paint a
 * loading boundary for a URL it has never seen.
 *
 * Params the payload leaves ABSENT are not a divergence: an App Shell renders with its params hanging,
 * and that shell IS shared across params by design.
 */
function isRewriteResponse(input: SegmentRecordInput): boolean {
  if (!input.route) return false
  // The catch-all tail is matched in its OPTIONAL form regardless of what the payload declared: a
  // `[[...slug]]` index response does not always carry `catchAllOptional` on the wire, and reading
  // its absence as "the URL is a segment short" would mis-file every optional-catchall index as a
  // rewrite. The guard's bias is to accuse only what it can prove.
  const derived = matchRoutePattern(input.route, input.pathname, true)
  if (!derived) return true
  return Object.entries(input.params).some(([name, value]) => {
    const own = derived[name]
    if (own === undefined) return false
    return Array.isArray(value) || Array.isArray(own)
      ? !Array.isArray(value) ||
          !Array.isArray(own) ||
          value.length !== own.length ||
          value.some((part, index) => part !== own[index])
      : value !== own
  })
}

function recordOneSegment(rawInput: SegmentRecordInput): void {
  // A rewrite payload is filed EXACT-URL only (no route, no vary set): it stays
  // available for the URL it was fetched for and is invisible to every other.
  const input: SegmentRecordInput = isRewriteResponse(rawInput)
    ? { ...rawInput, route: null, vary: null }
    : rawInput
  if (rawInput.route) {
    // LRU-bound like `entries`: one record per distinct pathname otherwise
    // grows without limit (memory-pressure leak-slope test).
    resolvedRoutes.delete(input.pathname)
    // The resolved-route record stays TRUE even for a rewrite: the server
    // really did answer this pathname with that route, and the sibling guard
    // in `candidateKeys` reads it to keep other routes off this URL.
    resolvedRoutes.set(rawInput.pathname, rawInput.route)
    while (resolvedRoutes.size > SEGMENT_ENTRY_LIMIT) {
      const oldest = resolvedRoutes.keys().next().value
      if (oldest === undefined) break
      resolvedRoutes.delete(oldest)
    }
  }
  const key = entryKey(input.segmentPath, input.route, input.params, input.search, input.vary, {
    pathname: input.pathname,
  })
  if (input.route && input.vary !== null) {
    let byRoute = learnedRoutes.get(input.segmentPath)
    if (!byRoute) {
      byRoute = new Map<string, LearnedRoute>()
      learnedRoutes.set(input.segmentPath, byRoute)
    }
    const learnedKey = `${input.route}${VARY_KEY_SEPARATOR}${[...input.vary].sort().join(',')}`
    // The sibling set is a property of the ROUTE, not of one response: a payload
    // that omits it (a framed segment truncated above the state script) must not
    // un-learn what an earlier one published.
    const staticSiblings = input.staticSiblings ?? byRoute.get(learnedKey)?.staticSiblings
    // Re-inserting moves the route to the end: most recently learned wins on
    // lookup, mirroring the loading-shell prediction order.
    byRoute.delete(learnedKey)
    byRoute.set(learnedKey, {
      route: input.route,
      vary: input.vary,
      catchAllOptional: input.catchAllOptional === true,
      ...(staticSiblings ? { staticSiblings } : {}),
    })
    // LRU-bound like `entries`/`resolvedRoutes`: a route publishing a new vary
    // set per prefetch (dynamic params in the vary set) would otherwise grow this
    // map without limit (memory-pressure leak-slope test).
    trimLearnedRoutes(byRoute)
  }
  const sharedAppShell = input.sharedAppShell === true || isRouteWideAppShell(input)
  const existing = entries.get(key)
  // A fully-static response can extract and cache this route shell with its
  // own static window, then a concurrent runtime-shell response for the same
  // fallback key can arrive with the full response's zero window. Next tracks
  // shell-stage freshness independently; do not let that duplicate erase the
  // already-fresh extracted shell.
  if (
    sharedAppShell &&
    input.staleTimeMs <= 0 &&
    existing?.sharedAppShell &&
    now() - existing.time < existing.staleTimeMs
  ) {
    touch(key)
    return
  }
  entries.set(key, {
    key,
    html: input.html,
    url: input.pathname + normalizeSegmentSearch(input.search),
    time: now(),
    staleTimeMs: input.staleTimeMs,
    complete: input.complete,
    static: input.static,
    runtime: input.runtime,
    postponedShell: input.postponedShell === true,
    sharedAppShell,
  })
  touch(key)
  trim()
}

/**
 * A runtime App Shell response renders the route with its params hanging. Its
 * empty fallback vary path and absent concrete route params distinguish it
 * from an ordinary postponed response for one URL.
 */
function isRouteWideAppShell(input: SegmentRecordInput): boolean {
  if (!input.postponedShell || !input.static || !input.route || input.vary?.length !== 0)
    return false
  const concrete = matchRoutePattern(input.route, input.pathname, true)
  if (concrete !== null && Object.keys(concrete).some(name => input.params[name] === undefined)) {
    return true
  }
  // PNext restamps concrete params onto the shell payload for client state,
  // even though the render itself hung them. The navigation-state child keeps
  // the params-hanging route pattern, unlike an ordinary exact-URL PPR shell.
  const match = /<script id="__PNEXT_NAV_STATE__" type="application\/json">(.*?)<\/script>/s.exec(
    input.html,
  )
  if (!match?.[1]) return false
  try {
    return (JSON.parse(match[1]) as { children?: unknown }).children === input.route
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Lookup.
// ---------------------------------------------------------------------------

/**
 * The cached segment usable for `pathname`+`search`, or null.
 *
 * `networkFree` is the spec's commit rule: only a complete + static + fresh
 * entry (or a complete runtime prefetch) lets a navigation skip the dynamic
 * stage. Everything else is returned for painting only.
 */
export function takeSegment(options: {
  pathname: string
  search: string
  segmentPath: string
}): SegmentHit | null {
  const requestedUrl = options.pathname + normalizeSegmentSearch(options.search)
  const usable: {
    candidate: { key: string; learnedKey?: string; params?: Record<string, string | string[]> }
    entry: SegmentEntry
  }[] = []
  for (const candidate of candidateKeys(options.segmentPath, options.pathname, options.search)) {
    const entry = entries.get(candidate.key)
    if (!entry) continue
    if (now() - entry.time >= entry.staleTimeMs) {
      entries.delete(candidate.key)
      continue
    }
    // A shared (different-URL) hit is sound for STATIC content - and for a request-sampled payload
    // the SERVER's own vary set authorised: a non-exact candidate key exists only because a learned
    // route published a vary set, and that set is the server's assertion of what the payload depends
    // on. Everything else stays exact-URL: a request-sampled payload belongs to the URL it sampled.
    const shared = entry.url !== requestedUrl
    const varyAuthorised = candidate.learnedKey !== undefined
    if (shared && !entry.static && !(entry.runtime && varyAuthorised)) continue
    usable.push({ candidate, entry })
  }
  // Candidate ORDER is specificity (exact URL first), but an INCOMPLETE first
  // match yields to a RUNTIME prefetch of this exact URL: an `allow-runtime`
  // route's request-sampled payload is the only one carrying the content behind
  // its Suspense boundaries, while a document-derived entry for the same URL
  // holds the fallbacks. A complete first match already covers everything a
  // runtime sample could, so it keeps the established first-match order.
  const first = usable[0]
  const chosen =
    first && !first.entry.complete
      ? (usable.find(({ entry }) => entry.runtime && entry.url === requestedUrl) ?? first)
      : first
  if (chosen) {
    const { candidate, entry } = chosen
    const key = candidate.key
    const shared = entry.url !== requestedUrl
    touch(key)
    // A learned route that is still serving lookups is live: re-insert it so the
    // LRU bound evicts the route patterns nobody navigates to.
    if (candidate.learnedKey) touchLearnedRoute(options.segmentPath, candidate.learnedKey)
    return {
      // A SHARED payload was rendered for a DIFFERENT URL of the same route, so the concrete params
      // baked into its three param carriers belong to that URL. Re-stamp them for the URL being served -
      // the client-side mirror of the server's `withRequestRouteParams`, and the same soundness rule:
      // the vary set authorises sharing the CONTENT, never the param values.
      html:
        shared && candidate.params ? restampSharedParams(entry.html, candidate.params) : entry.html,
      // A COMPLETE + STATIC entry is network-free even when SHARED: a static prerender whose vary set
      // does not contain the differing param is by construction byte-identical for this URL, so there
      // is nothing left to fetch. Everything else stays exact-URL only: a shared SHELL (an App Shell
      // whose params hung) is missing the per-param content, and a shared request-sampled payload
      // belongs to the URL it sampled. Both may paint, but the navigation must still issue its request.
      networkFree: entry.complete && (entry.static || (!shared && entry.runtime)),
      // A PREFETCH asks a weaker question than a commit: is there anything left to fetch FOR THIS URL?
      // An exact-URL hit always answers no. A SHARED hit answers no when the sharing was authorised -
      // either the payload is static, or a published vary set let `candidateKeys` produce the shared
      // match. The navigation that follows still fetches the dynamic remainder.
      prefetchSatisfied: !shared || (optimisticRoutingEnabled() && (entry.static || entry.runtime)),
      runtime: entry.runtime,
      // An ordinary postponed response only describes the URL it rendered, so
      // sharing clears its paint licence. An extracted App Shell was rendered
      // with route params deliberately hanging and is the server's shell stage
      // for every sibling param, so it retains that licence.
      postponedShell: entry.postponedShell && (!shared || entry.sharedAppShell),
    }
  }
  return null
}

/**
 * `experimental.optimisticRouting` (default ON; register-render stamps the
 * document only for an app that turned it OFF).
 *
 * With it off, a prefetch of a URL that was never fetched still goes to the
 * wire even when a sibling entry's vary set covers it: optimistic reuse of
 * another URL's entry to answer a prefetch IS the feature the flag names, and
 * the suites that pin the pre-flag behavior block that first request
 * (`segment-cache/search-params` shared-loading-state). The reuse a NAVIGATION
 * makes (`networkFree`) is a separate, older contract and stays on.
 */
function optimisticRoutingEnabled(): boolean {
  return (
    (globalThis as { __PNEXT_NO_OPTIMISTIC_ROUTING__?: boolean })
      .__PNEXT_NO_OPTIMISTIC_ROUTING__ !== true
  )
}

/**
 * True when a PREFETCH of this segment has nothing left to fetch because a fresh entry the server's
 * own vary set covers is already cached.
 *
 * Deliberately separate from `takeSegment`: this answers only "skip the wire", never "what may this
 * navigation paint or commit". A PPR shell is postponed and carries no `x-nextjs-prerender`, so it is
 * not static and `takeSegment` will not share it - but when the server published a vary set that does
 * NOT name the differing param, that set is its assertion that the shell's bytes are identical for
 * this URL.
 *
 * A request-sampled (`runtime`) payload is excluded: its bytes belong to the URL it was sampled for,
 * and the App-Shell scheduler relies on re-fetching them.
 */
export function segmentPrefetchCovered(options: {
  pathname: string
  search: string
  segmentPath: string
}): { html: string } | null {
  const requestedUrl = options.pathname + normalizeSegmentSearch(options.search)
  for (const candidate of candidateKeys(options.segmentPath, options.pathname, options.search)) {
    const entry = entries.get(candidate.key)
    if (!entry) continue
    if (now() - entry.time >= entry.staleTimeMs) continue
    if (entry.runtime) continue
    // An exact-URL hit is `takeSegment`'s business (it already dedupes there);
    // this predicate exists for the SHARED case the vary set authorised.
    if (entry.url === requestedUrl || candidate.learnedKey === undefined) continue
    return {
      html: candidate.params ? restampSharedParams(entry.html, candidate.params) : entry.html,
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// w9-segment-split: composed lookups.
// ---------------------------------------------------------------------------

/**
 * Whether a navigation may commit a COMPOSED (layout frame + page frame)
 * document. Off by default: the split frames are recorded unconditionally (they
 * cost one extra entry and can only ever add hits), but composing them changes
 * what a navigation PAINTS, and that is the half of the split that has not been
 * validated end to end. `setSegmentSplitCommit(true)` opts in.
 */
let segmentSplitCommit = false

export function setSegmentSplitCommit(enabled: boolean): void {
  segmentSplitCommit = enabled
}

export function segmentSplitCommitEnabled(): boolean {
  return segmentSplitCommit
}

/**
 * A document composed from the cached LAYOUT and PAGE frames of this URL, or null when either frame
 * misses (or composition is off / the frames have no page slot to splice). This is the layout/page
 * split's payoff: a sibling URL can miss the whole-document entry (the layout read the differing
 * param) but hit the page frame, so only the layout has to come off the network.
 */
export function takeComposedSegment(options: {
  pathname: string
  search: string
}): SegmentHit | null {
  if (!segmentSplitCommit) return null
  const layout = takeSegment({ ...options, segmentPath: LAYOUT_FRAME_PATH })
  if (!layout) return null
  const page = takeSegment({ ...options, segmentPath: PAGE_FRAME_PATH })
  if (!page) return null
  const html = composeSegmentFrames(layout.html, page.html)
  if (html === null) return null
  return {
    html,
    // A composed document is only as committable as its weaker half.
    networkFree: layout.networkFree && page.networkFree,
    prefetchSatisfied: layout.prefetchSatisfied && page.prefetchSatisfied,
    runtime: layout.runtime || page.runtime,
    // Composed from two frames: it is the destination's own static stage only when both
    // halves are.
    postponedShell: layout.postponedShell && page.postponedShell,
  }
}

// ---------------------------------------------------------------------------
// w9-segment-split (G2): per-segment NAVIGATION — fetch `/_page`, keep the
// layout.
// ---------------------------------------------------------------------------

/**
 * The layout frame of a whole DOCUMENT the router committed (the hard-loaded
 * page, a navigation response). Kept apart from `entries`:
 *
 *  - a document carries no vary metadata, so the frame is only ever valid for
 *    the exact URL it was rendered for, and
 *  - it is only ever consumed by a SAME-URL navigation (Next's "refresh the
 *    page segments, keep the layouts" semantics). A later navigation BACK to
 *    this URL must not paint a layout this old, so `cachedLayoutFrame` takes it
 *    only when the caller says the destination is the current location.
 */
interface DocumentLayoutFrame {
  html: string
  time: number
  staleTimeMs: number
}
const documentLayoutFrames = new Map<string, DocumentLayoutFrame>()
/** Small on purpose: only the live URL's frame is ever read back. */
const DOCUMENT_LAYOUT_LIMIT = 8

export function recordDocumentLayoutFrame(input: {
  pathname: string
  search: string
  html: string
  staleTimeMs: number
}): void {
  // No page slot: `stripPageSlotContent` would return the whole document, and a
  // composed document would then carry the page twice.
  if (pageSlotRange(input.html) === null) return
  const key = input.pathname + normalizeSegmentSearch(input.search)
  documentLayoutFrames.delete(key)
  documentLayoutFrames.set(key, {
    html: stripPageSlotContent(input.html),
    time: now(),
    staleTimeMs: input.staleTimeMs,
  })
  while (documentLayoutFrames.size > DOCUMENT_LAYOUT_LIMIT) {
    const oldest = documentLayoutFrames.keys().next().value
    if (oldest === undefined) break
    documentLayoutFrames.delete(oldest)
  }
}

/**
 * The LAYOUT frame a navigation to this URL may keep: a cached `/_layout` segment (fetched, or derived
 * from a prefetch of this URL), or - for a navigation to the URL already on screen - the live
 * document's own frame.
 */
function cachedLayoutFrame(options: {
  pathname: string
  search: string
  sameUrl: boolean
}): string | null {
  const hit = takeSegment({
    pathname: options.pathname,
    search: options.search,
    segmentPath: LAYOUT_FRAME_PATH,
  })
  // The continuation chunks are cut at CONSUMPTION time, so every source of a
  // layout frame — the server's `/_layout` response, a frame derived from a
  // prefetch, the live document's — is covered by one rule.
  if (hit) return stripStreamedContinuation(hit.html)
  if (!options.sameUrl) return null
  const frame = documentLayoutFrames.get(options.pathname + normalizeSegmentSearch(options.search))
  if (!frame) return null
  if (now() - frame.time >= frame.staleTimeMs) return null
  return stripStreamedContinuation(frame.html)
}

/**
 * True when a navigation to this URL may fetch the PAGE frame alone: its layout chain is already
 * cached (or already on screen), so `/_page` carries everything the commit still needs. This is the
 * gate the router asks BEFORE it goes to the wire - the commit itself goes through
 * `composeCachedLayout`, and any failure there falls back to the whole-document fetch.
 */
export function needsPageFrameOnly(options: {
  pathname: string
  search: string
  sameUrl: boolean
}): boolean {
  return cachedLayoutFrame(options) !== null
}

/**
 * Splice a `/_page` response into this URL's cached layout frame, yielding the document the
 * whole-document response would have been. Null when the frame is gone (it can expire between the
 * gate and the response) or the two cannot be proven to line up.
 */
export function composeCachedLayout(options: {
  pathname: string
  search: string
  sameUrl: boolean
  pageHtml: string
}): string | null {
  const layout = cachedLayoutFrame(options)
  return layout === null ? null : composeSegmentFrames(layout, options.pageHtml)
}

/**
 * Compose a just-fetched `/_layout` response with this URL's cached PAGE frame into the whole
 * document the `/_index` request would have returned. The layout-only fetch is only worth issuing if
 * the navigation that follows can still paint a complete page, so the two frames are joined HERE, at
 * record time, and filed as an ordinary whole-document entry. Null when the page frame is gone or the
 * two cannot be proven to line up.
 */
export function composeFetchedLayoutFrame(options: {
  pathname: string
  search: string
  layoutHtml: string
}): string | null {
  const page = takeSegment({
    pathname: options.pathname,
    search: options.search,
    segmentPath: PAGE_FRAME_PATH,
  })
  if (!page) return null
  return composeSegmentFrames(stripStreamedContinuation(options.layoutHtml), page.html)
}

/**
 * True when the PAGE frame for this URL is cached but its LAYOUT frame is not: the navigation should
 * fetch `/_layout` alone rather than the whole route.
 */
/**
 * True when a RUNTIME-prefetched PAGE frame already covers this URL. Only the page opts into
 * `prefetch = 'allow-runtime'`; the layouts above it have no static data to prefetch (their
 * params-dependent content sits behind a Suspense boundary and resolves in the dynamic stage), so once
 * the page frame's vary set covers the URL the prefetch has nothing left to fetch.
 */
export function runtimePageFrameSatisfied(options: { pathname: string; search: string }): boolean {
  const requestedUrl = options.pathname + normalizeSegmentSearch(options.search)
  for (const candidate of candidateKeys(PAGE_FRAME_PATH, options.pathname, options.search)) {
    const entry = entries.get(candidate.key)
    if (!entry?.runtime) continue
    if (now() - entry.time >= entry.staleTimeMs) continue
    // SHARED coverage only: a URL the client fetched for itself keeps its own
    // prefetch (a stale/incomplete entry of that URL must still refetch); this
    // rule exists for the sibling param the vary set already covers.
    if (entry.url === requestedUrl || candidate.learnedKey === undefined) continue
    return true
  }
  return false
}

export function needsLayoutFrameOnly(options: { pathname: string; search: string }): boolean {
  if (takeSegment({ ...options, segmentPath: LAYOUT_FRAME_PATH })) return false
  return takeSegment({ ...options, segmentPath: PAGE_FRAME_PATH }) !== null
}

/**
 * Every cache key that could serve this URL, most specific first: the EXACT-URL key (what a response
 * with no vary metadata is filed under), then the learned route/vary keys, widest vary set first, so
 * a per-URL entry always beats the route's shared App Shell for the URL it was fetched for.
 *
 * When the server has told us which route serves this exact pathname, only that route's keys are
 * considered - a static sibling of a dynamic segment is never predicted onto the dynamic pattern.
 */
function candidateKeys(
  segmentPath: string,
  pathname: string,
  search: string,
): { key: string; learnedKey?: string; params?: Record<string, string | string[]> }[] {
  const keys: { key: string; learnedKey?: string; params?: Record<string, string | string[]> }[] = [
    { key: entryKey(segmentPath, null, {}, search, null, { pathname }) },
  ]
  const byRoute = learnedRoutes.get(segmentPath)
  if (!byRoute) return keys
  const ownRoute = resolvedRoutes.get(pathname)
  const learned = [...byRoute.entries()]
    .reverse()
    .filter(([, candidate]) => ownRoute === undefined || candidate.route === ownRoute)
    // Stable sort: within one specificity the most recently learned wins.
    .sort(([, a], [, b]) => b.vary.length - a.vary.length)
  for (const [learnedKey, candidate] of learned) {
    const params = matchRoutePattern(candidate.route, pathname, candidate.catchAllOptional)
    if (!params) continue
    // The pattern matches, but the segment it matched is a literal the server
    // published as a STATIC SIBLING of this dynamic level: that sibling's own
    // route serves the URL, so the dynamic route's shared bytes are not its.
    if (namesStaticSibling(pathname, candidate.staticSiblings)) continue
    keys.push({
      key: entryKey(segmentPath, candidate.route, params, search, candidate.vary, { pathname }),
      learnedKey,
      params,
    })
  }
  return keys
}

function entryKey(
  segmentPath: string,
  route: string | null,
  params: Record<string, string | string[]>,
  search: string,
  vary: string[] | null,
  context: { pathname: string },
): string {
  return segmentVaryCacheKey({
    route: route ?? '',
    segmentPath,
    params,
    search,
    vary: route ? vary : null,
    pathname: context.pathname,
  })
}

// ---------------------------------------------------------------------------
// Route pattern matching (pure — the unit tests drive this directly).
// ---------------------------------------------------------------------------

/**
 * Match `pathname` against a colon-form route pattern (`/vary/:cat`,
 * `/blog/:slug*`) and return its params, or null when it does not match.
 * `optionalCatchAll` lets a trailing `:slug*` match zero segments.
 */
export function matchRoutePattern(
  pattern: string,
  pathname: string,
  optionalCatchAll = false,
): Record<string, string | string[]> | null {
  const patternParts = pattern.split('/').filter(Boolean)
  const pathParts = pathname.split('/').filter(Boolean)
  const params: Record<string, string | string[]> = {}
  let cursor = 0
  for (const part of patternParts) {
    const catchAll = /^:([\w$]+)\*$/.exec(part)
    if (catchAll) {
      const rest = pathParts.slice(cursor).map(decodeSegment)
      if (rest.length === 0 && !optionalCatchAll) return null
      if (rest.length > 0) params[catchAll[1]!] = rest
      return params
    }
    const dynamic = /^:([\w$]+)$/.exec(part)
    const value = pathParts[cursor++]
    if (value === undefined) return null
    if (dynamic) params[dynamic[1]!] = decodeSegment(value)
    else if (part !== value) return null
  }
  return cursor === pathParts.length ? params : null
}

// ---------------------------------------------------------------------------
// Shared-payload param re-stamping (pure — no DOM, driven by the unit tests).
// ---------------------------------------------------------------------------

/** The island prop placeholder the server fills per request (slots.tsx). */
const PROMISE_MARKER_KEY = '__pnextPromise'
const ISLAND_PARAMS_ATTRIBUTE = 'data-pnext-params'

/**
 * Rewrite every param carrier in a payload rendered for a SIBLING URL of the
 * same route so it describes `params` instead.
 *
 * Three carriers, all of which must agree (the server's `withRequestRouteParams`
 * writes exactly these three): `window.__PNEXT_ROUTE__` (what `useParams()`
 * reads), the `data-pnext-params` island scopes (which OVERRIDE the window
 * state for the island carrying them), and the `data-pnext-props` promise
 * markers a partial prerender baked for a hanging `params` prop. Leaving any of
 * them behind hands the destination URL the source URL's params for the whole
 * time its dynamic stage is in flight.
 *
 * The payload's own embedded route state is the source of truth for what to
 * replace: only values byte-identical to ITS params are rewritten, so app
 * content that merely happens to contain the same string is untouched.
 */
function restampSharedParams(html: string, params: Record<string, string | string[]>): string {
  const match = /(window\.__PNEXT_ROUTE__=)(\{.*?\})(;?<\/script>)/s.exec(html)
  if (!match?.[2]) return html
  let state: Record<string, unknown>
  try {
    state = JSON.parse(match[2]) as Record<string, unknown>
  } catch {
    // A route script we cannot parse cannot be re-stamped safely.
    return html
  }
  const baked = (state.params ?? {}) as Record<string, string | string[]>
  const bakedJson = paramsJson(baked)
  const targetJson = paramsJson(params)
  if (bakedJson === targetJson) return html
  const rewritten =
    html.slice(0, match.index) +
    `${match[1]}${paramsJson({ ...state, params })}${match[3]}` +
    html.slice(match.index + match[0].length)
  const replacements: [string, string][] = [
    [islandParamsAttribute(bakedJson), islandParamsAttribute(targetJson)],
    [promiseMarkerJson(bakedJson), promiseMarkerJson(targetJson)],
  ]
  return rewriteIslandMarkup(rewritten, text => {
    let next = text
    for (const [from, to] of replacements) {
      next = next.split(from).join(to).split(escapeAttribute(from)).join(escapeAttribute(to))
    }
    return next
  })
}

const islandParamsAttribute = (json: string) =>
  `${ISLAND_PARAMS_ATTRIBUTE}="${json.replaceAll('"', '&quot;')}"`
const promiseMarkerJson = (json: string) => `{"${PROMISE_MARKER_KEY}":${json}}`
const escapeAttribute = (json: string) => json.replaceAll('"', '&quot;')

/** `serializeProps`' output shape, mirrored so the strings compare byte-wise. */
const JSON_ESCAPES: Record<string, string> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
}

function paramsJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, char => JSON_ESCAPES[char] ?? char)
}

/**
 * Apply `rewrite` to the markup AND to the island markers the renderer emits for neutral islands - the
 * same two-surface pass the server does, since an island's params live inside the marker until it
 * materializes.
 */
function rewriteIslandMarkup(html: string, rewrite: (text: string) => string): string {
  return rewrite(html).replace(
    /<!--pnext-(client|client-after|page):([^>]*)-->/g,
    (marker, kind: string, encoded: string) => {
      const decoded = encoded.replaceAll('&lt;', '<').replaceAll('&gt;', '>')
      const next = rewrite(decoded)
      return next === decoded
        ? marker
        : `<!--pnext-${kind}:${next.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}-->`
    },
  )
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    // A malformed escape is the route-cache identity as written; keep it.
    return segment
  }
}

// ---------------------------------------------------------------------------
// Eviction.
// ---------------------------------------------------------------------------

/**
 * A same-URL navigation refreshes PAGE segments only: the layout/head segments of the current tree stay
 * cached (Next's router.refresh semantics - the shared layout is not re-fetched). Everything below the
 * page segment is dropped.
 */
export function evictPageSegments(): void {
  for (const key of [...entries.keys()]) {
    if (BODY_SEGMENT_PATHS.some(path => key.startsWith(path + VARY_KEY_SEPARATOR))) {
      entries.delete(key)
    }
  }
  // The vary sets learned for those page segments describe payloads that are
  // gone; keeping them would leak one map per route across refreshes.
  for (const path of BODY_SEGMENT_PATHS) learnedRoutes.delete(path)
}

/** Drop every entry (a revalidation invalidates the whole segment cache). */
export function clearSegmentCache(): void {
  entries.clear()
  learnedRoutes.clear()
  resolvedRoutes.clear()
  // A revalidation invalidates the layouts too: a `/_page`-only navigation
  // after one would keep painting the pre-revalidation layout chain.
  documentLayoutFrames.clear()
}

/** Test seam: the number of live entries. */
export function segmentEntryCount(): number {
  return entries.size
}

function touch(key: string): void {
  const entry = entries.get(key)
  if (!entry) return
  entries.delete(key)
  entries.set(key, entry)
}

function trim(): void {
  while (entries.size > SEGMENT_ENTRY_LIMIT) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) return
    entries.delete(oldest)
  }
}

function touchLearnedRoute(segmentPath: string, learnedKey: string): void {
  const byRoute = learnedRoutes.get(segmentPath)
  const learned = byRoute?.get(learnedKey)
  if (!byRoute || !learned) return
  byRoute.delete(learnedKey)
  byRoute.set(learnedKey, learned)
}

function trimLearnedRoutes(byRoute: Map<string, LearnedRoute>): void {
  while (byRoute.size > SEGMENT_ENTRY_LIMIT) {
    const oldest = byRoute.keys().next().value
    if (oldest === undefined) return
    byRoute.delete(oldest)
  }
}

/**
 * The route pattern the SERVER resolved `pathname` to (learned from a segment
 * or document payload), or null when this exact pathname was never answered.
 *
 * The router's route-tree cache uses it as the static-sibling guard: a pathname
 * the server resolved to its OWN route must never be predicted onto a dynamic
 * sibling pattern.
 */
export function resolvedRouteFor(pathname: string): string | null {
  return resolvedRoutes.get(pathname) ?? null
}

/** Test seam: how many route/vary sets are remembered for a segment path. */
export function learnedRouteCount(segmentPath: string): number {
  return learnedRoutes.get(segmentPath)?.size ?? 0
}

// ---------------------------------------------------------------------------
// Wire decoding.
// ---------------------------------------------------------------------------

/**
 * Decode a segment response body into its payload plus vary metadata. Returns null when the body is not
 * the expected segment payload (a header-stripping proxy, a plain document, ...).
 */
export function decodeSegmentPayload(
  body: string,
  expectedSegment: string,
): (SegmentPayloadMeta & { html: string }) | null {
  const json = body.startsWith('0:') ? body.slice(2) : body
  let payload: {
    segment?: unknown
    html?: unknown
    vary?: unknown
    layoutVary?: unknown
    pageVary?: unknown
    route?: unknown
    params?: unknown
    shell?: unknown
  }
  try {
    payload = JSON.parse(json) as typeof payload
  } catch {
    return null
  }
  if (payload.segment !== expectedSegment || typeof payload.html !== 'string') return null
  const payloadSiblings = staticSiblingsFromPayloadHtml(payload.html)
  return {
    html: payload.html,
    vary: Array.isArray(payload.vary) ? payload.vary.map(String) : null,
    // Absent (not null) when the server did not split the response — the shape
    // stays byte-identical to the pre-split payload for every such response.
    ...(Array.isArray(payload.layoutVary) ? { layoutVary: payload.layoutVary.map(String) } : {}),
    ...(Array.isArray(payload.pageVary) ? { pageVary: payload.pageVary.map(String) } : {}),
    route: typeof payload.route === 'string' ? payload.route : null,
    params: normalizeWireParams(payload.params),
    ...(payloadSiblings ? { staticSiblings: payloadSiblings } : {}),
    ...(appShellOf(payload.shell) ? { shell: appShellOf(payload.shell)! } : {}),
  }
}

/** The `shell` field of a segment payload, when it carries a usable one. */
function appShellOf(value: unknown): { html: string; route: string } | null {
  const shell = value as { html?: unknown; route?: unknown } | null | undefined
  if (!shell || typeof shell.html !== 'string' || typeof shell.route !== 'string') return null
  return { html: shell.html, route: shell.route }
}

/**
 * Decode the segment metadata of a whole HTML DOCUMENT - a navigation response or the initial
 * hard-loaded page - rather than a framed segment payload.
 *
 * An ordinary document render carries no vary set (the server only tracks param access inside a
 * segment-prefetch render), so the vary set is UNKNOWN and the entry keys on its exact URL. The route
 * identity it does carry still matters: it teaches the sibling guard which route serves this pathname.
 *
 * A document resumed from a BAKED SHELL is the exception: the server publishes that shell's own vary
 * set as `pageVary`, and that set IS the assertion the exact-URL fallback exists for want of. Without
 * it a hard load of `/route/foo` seeds an entry no navigation to `/route/bar` can key onto.
 */
export function decodeDocumentSegmentMeta(html: string): SegmentPayloadMeta {
  const state = documentRouteState(html)
  if (!state) return { vary: null, route: null, params: {} }
  const siblings = staticSiblingsOf(state)
  return {
    vary: Array.isArray(state.pageVary) ? state.pageVary.map(String) : null,
    route: typeof state.route === 'string' ? state.route : null,
    params: normalizeWireParams(state.params),
    ...(siblings ? { staticSiblings: siblings } : {}),
  }
}

interface WireRouteState {
  route?: unknown
  params?: unknown
  pageVary?: unknown
  staticChildren?: unknown
  staticChildrenBySegment?: unknown
}

/** The `window.__PNEXT_ROUTE__` state embedded in a rendered document. */
function documentRouteState(html: string): WireRouteState | null {
  const match = /window\.__PNEXT_ROUTE__=(\{.*?\});?<\/script>/s.exec(html)
  if (!match?.[1]) return null
  try {
    return JSON.parse(match[1]) as WireRouteState
  } catch {
    return null
  }
}

/**
 * The literal siblings the server published for each dynamic level of the
 * route, keyed by segment index (`staticChildrenBySegment`, plus the legacy
 * deepest-level `staticChildren` at the pattern's last dynamic index).
 */
function staticSiblingsOf(state: WireRouteState): Record<string, string[]> | undefined {
  const siblings: Record<string, string[]> = {}
  const bySegment = state.staticChildrenBySegment
  if (typeof bySegment === 'object' && bySegment !== null) {
    for (const [index, names] of Object.entries(bySegment as Record<string, unknown>)) {
      if (Array.isArray(names)) siblings[index] = names.map(String)
    }
  }
  if (Array.isArray(state.staticChildren) && typeof state.route === 'string') {
    const parts = state.route.split('/').filter(Boolean)
    const deepest = parts.reduce((last, part, index) => (part.startsWith(':') ? index : last), -1)
    if (deepest >= 0 && siblings[String(deepest)] === undefined) {
      siblings[String(deepest)] = state.staticChildren.map(String)
    }
  }
  return Object.keys(siblings).length > 0 ? siblings : undefined
}

/** A framed segment payload's static siblings, read off the HTML it carries. */
function staticSiblingsFromPayloadHtml(html: string): Record<string, string[]> | undefined {
  const state = documentRouteState(html)
  return state ? staticSiblingsOf(state) : undefined
}

/**
 * True when `pathname` names one of the learned route's STATIC SIBLINGS at one of its dynamic levels -
 * `/products/sale` beside `/products/:id`.
 *
 * The pattern match alone cannot tell the two apart: a dynamic segment matches any literal, so a
 * learned route's (param-shared) entry would otherwise serve the sibling's URL with the dynamic
 * route's bytes. The server publishes the literal siblings of every dynamic level alongside the route,
 * the same signal the optimistic predictor bails on. Only a POSITIVE match rejects: a route whose
 * siblings the server did not publish keeps sharing exactly as before.
 */
function namesStaticSibling(
  pathname: string,
  siblings: Record<string, string[]> | undefined,
): boolean {
  if (!siblings) return false
  const parts = pathname.split('/').filter(Boolean).map(decodeSegment)
  return Object.entries(siblings).some(([index, names]) => {
    const segment = parts[Number(index)]
    return segment !== undefined && names.includes(segment)
  })
}

function normalizeWireParams(value: unknown): Record<string, string | string[]> {
  if (typeof value !== 'object' || value === null) return {}
  const params: Record<string, string | string[]> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(raw)) params[key] = (raw as unknown[]).map(stringifyParam)
    else if (raw !== undefined && raw !== null) params[key] = stringifyParam(raw)
  }
  return params
}

/** Wire params are strings; anything else is coerced defensively. */
function stringifyParam(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
}

/** True when a decoded vary set makes the segment query-dependent. */
export function varyIncludesSearch(vary: readonly string[] | null): boolean {
  return vary?.includes(SEARCH_PARAMS_SENTINEL) === true
}
