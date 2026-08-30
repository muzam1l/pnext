// The router's SegmentCachePolicy implementation (COMPAT client policy). Adapts the pure per-segment
// cache in ./segment-cache.ts onto the core router seam. Kept apart from the cache itself so the cache
// stays importable - and unit-testable - without pulling the router, and the whole DOM runtime, into
// the module graph.

import type { SegmentCacheHit, SegmentCachePolicy, SegmentCacheRecord } from '../../client/router'
import {
  BODY_SEGMENT_PATHS,
  clearSegmentCache,
  composeFetchedLayoutFrame,
  composeCachedLayout,
  decodeDocumentSegmentMeta,
  decodeSegmentPayload,
  evictPageSegments,
  matchRoutePattern,
  needsLayoutFrameOnly,
  needsPageFrameOnly,
  runtimePageFrameSatisfied,
  recordDocumentLayoutFrame,
  recordSegment,
  resolvedRouteFor,
  segmentPrefetchCovered,
  takeComposedSegment,
  takeSegment,
  type SegmentPayloadMeta,
} from './segment-cache'
import { resetSegmentPrefetchDedupe, scheduleAppShellPrefetch } from './segment-prefetch'

export function installSegmentCachePolicy(): SegmentCachePolicy {
  return {
    record,
    take,
    // Route-tree reuse seam: the router's `/_tree` cache is keyed by pathname,
    // but a route's TREE is param-independent, so a sibling URL of an already
    // learned route needs no tree request. These two let the router ask the
    // segment cache which route serves a pathname (the static-sibling guard)
    // and whether a colon-form pattern covers it.
    routeFor: resolvedRouteFor,
    matchesRoute: (route, pathname) => matchRoutePattern(route, pathname) !== null,
    // w9-segment-split: when this URL's PAGE frame is cached and only its
    // LAYOUT varied, the prefetch fetches `/_layout` alone instead of the whole
    // route. Inert until segment-split commit is enabled (the composition half
    // is what makes the half-fetched document paintable).
    needsLayoutFrameOnly: input => needsLayoutFrameOnly(input),
    runtimePageFrameSatisfied,
    // w9-segment-split (G2), the live half: when this URL's LAYOUT chain is
    // already cached (or already on screen, for a same-URL click), the
    // navigation fetches `/_page` and splices the answer back into it. The
    // router falls back to the whole document whenever these answer no/null.
    needsPageFrameOnly,
    // w9-segment-split: join a layout-only prefetch response with this URL's
    // cached page frame. The router commits the result as the whole document,
    // and treats a null as "this prefetch is unusable" — a layout frame alone
    // would paint a page-less document.
    composeLayoutFrame: composeFetchedLayoutFrame,
    composePageFrame: composeCachedLayout,
    recordDocumentLayout: recordDocumentLayoutFrame,
    prefetchCovered: segmentPrefetchCovered,
    evictPageSegments,
    // A revalidation invalidates every window: the prefetch dedupe state (tree cache + app-shell request
    // set) must fall with the entries, or a revalidated route stays deduped - and stale - for its whole
    // window. evictPageSegments deliberately keeps it, since a same-URL refresh keeps layout/head dedupe.
    clear: () => {
      clearSegmentCache()
      resetSegmentPrefetchDedupe()
    },
  }
}

function record(input: SegmentCacheRecord): void {
  const decoded: SegmentPayloadMeta | null =
    input.kind === 'document'
      ? // A navigation response / the hard-loaded document: no framed payload
        // and no vary set, so it keys on its exact URL (fix-forward 2).
        decodeDocumentSegmentMeta(input.body)
      : decodeSegmentPayload(input.body, input.segmentPath)
  // No decodable payload (a header-stripping proxy, a plain document): there is
  // no vary metadata to key on, so nothing worth caching here — the router's
  // own whole-URL caches already hold it.
  if (!decoded) return
  // App Shells (fix-forward 5): a per-URL static prerender of a params-reading
  // route also primes the route's SHARED shell, so navigations to its other
  // params paint instantly. No-op unless experimental.appShells is on.
  scheduleAppShellPrefetch({
    pathname: input.pathname,
    route: decoded.route,
    vary: decoded.vary,
    static: input.static,
    complete: input.complete,
    runtime: input.runtime,
  })
  recordSegment({
    segmentPath: input.segmentPath,
    pathname: input.pathname,
    search: input.search,
    html: input.html,
    staleTimeMs: input.staleTimeMs,
    complete: input.complete,
    static: input.static,
    runtime: input.runtime,
    ...(input.postponedShell ? { postponedShell: true } : {}),
    vary: decoded.vary,
    // w9-segment-split: pass the layout/page vary sets through so the cache can
    // file the two frames alongside the whole-document entry.
    ...(decoded.layoutVary ? { layoutVary: decoded.layoutVary } : {}),
    ...(decoded.pageVary ? { pageVary: decoded.pageVary } : {}),
    // The route's static siblings, so a learned dynamic pattern never keys onto
    // a literal sibling's URL.
    ...(decoded.staticSiblings ? { staticSiblings: decoded.staticSiblings } : {}),
    ...(decoded.shell ? { shell: decoded.shell } : {}),
    route: decoded.route,
    params: decoded.params,
  })
}

function take(input: {
  pathname: string
  search: string
  segmentPath: string
}): SegmentCacheHit | null {
  const hit = takeSegment(input)
  if (hit) {
    return {
      html: hit.html,
      networkFree: hit.networkFree,
      prefetchSatisfied: hit.prefetchSatisfied,
      postponedShell: hit.postponedShell,
    }
  }
  // w9-segment-split: the whole-document entry missed because ONE of the two
  // frames varied. Compose the cached layout + page frames instead of going to
  // the network for both. No-op until segment-split commit is enabled.
  if (!BODY_SEGMENT_PATHS.includes(input.segmentPath as (typeof BODY_SEGMENT_PATHS)[number])) {
    return null
  }
  const composed = takeComposedSegment({ pathname: input.pathname, search: input.search })
  return composed
    ? {
        html: composed.html,
        networkFree: composed.networkFree,
        prefetchSatisfied: composed.prefetchSatisfied,
        postponedShell: composed.postponedShell,
      }
    : null
}
