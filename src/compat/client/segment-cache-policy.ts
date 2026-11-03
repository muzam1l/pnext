// The router's SegmentCachePolicy implementation (COMPAT client policy). Adapts the pure per-segment
// cache in ./segment-cache.ts onto the core router seam. Kept apart from the cache itself so the cache
// stays importable - and unit-testable - without pulling the router, and the whole DOM runtime, into
// the module graph.

import type { SegmentCachePolicy, SegmentCacheRecord } from '../../client/router'
import {
  clearSegmentCache,
  clearSegmentData,
  composeFetchedLayoutFrame,
  composeCachedLayout,
  decodeDocumentSegmentMeta,
  decodeSegmentPayload,
  evictPageSegments,
  evictUrlSegments,
  markDynamicRewrite,
  matchRoutePattern,
  needsLayoutFrameOnly,
  needsPageFrameOnly,
  runtimePageFrameSatisfied,
  recordDocumentLayoutFrame,
  recordSegment,
  resolvedRouteFor,
  segmentPrefetchCovered,
  takeSegment,
  type SegmentPayloadMeta,
} from './segment-cache'
import {
  deferBodyPrefetch,
  followPartialPrefetch,
  learnRedirect,
  predictPartialRoute,
  redirectTarget,
  resetSegmentDataDedupe,
  resetSegmentPrefetchDedupe,
  scheduleRuntimePrefetch,
} from './segment-prefetch'

// Runtime and Partial Prefetching ship only to an app with a runtime-prefetched route (usage.ts).
declare const __PNEXT_RUNTIME_PREFETCHING__: boolean

export function installSegmentCachePolicy(): SegmentCachePolicy {
  return {
    record,
    take: takeSegment,
    // Route-tree reuse seam: the router's `/_tree` cache is keyed by pathname,
    // but a route's TREE is param-independent, so a sibling URL of an already
    // learned route needs no tree request. These two let the router ask the
    // segment cache which route serves a pathname (the static-sibling guard)
    // and whether a colon-form pattern covers it.
    routeFor: resolvedRouteFor,
    matchesRoute: (route, pathname) => matchRoutePattern(route, pathname) !== null,
    markDynamicRewrite,
    redirectTarget,
    needsLayoutFrameOnly,
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
    // Partial Prefetching: the `/_tree` hints pick a static attempt or the policy's own runtime requests.
    ...((typeof __PNEXT_RUNTIME_PREFETCHING__ === 'boolean' ? __PNEXT_RUNTIME_PREFETCHING__ : true)
      ? { predictRoute: predictPartialRoute, deferBodyPrefetch, runtimePageFrameSatisfied }
      : {}),
    evictPageSegments,
    evictUrl: evictUrlSegments,
    // A revalidation invalidates every window: the prefetch dedupe state (tree cache + app-shell request
    // set) must fall with the entries, or a revalidated route stays deduped - and stale - for its whole
    // window. evictPageSegments deliberately keeps it, since a same-URL refresh keeps layout/head dedupe.
    clear: () => {
      clearSegmentCache()
      resetSegmentPrefetchDedupe()
    },
    clearData: () => {
      clearSegmentData()
      resetSegmentDataDedupe()
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
  // Only a complete prerender serves the target alone; anything else still fetches the requested URL.
  if (input.from && input.complete && input.static)
    learnRedirect(
      new URL(input.from),
      new URL(input.pathname + input.search, input.from),
      input.staleTimeMs,
    )
  // A Partial Prefetching full body arrives marked runtime (the shell downgrade), yet it is the static
  // attempt: it never covers the URL's own `2`.
  let partial = false
  if (
    (typeof __PNEXT_RUNTIME_PREFETCHING__ === 'boolean' ? __PNEXT_RUNTIME_PREFETCHING__ : true) &&
    input.kind !== 'document' &&
    input.segmentPath === '/_index'
  ) {
    partial = followPartialPrefetch({
      pathname: input.pathname,
      search: input.search,
      full: input.full === true,
      needsRuntime: input.needsRuntime === true,
      fallback: input.fallback,
      runtimeNeeded: input.runtimeNeeded,
    })
    if (!partial) {
      scheduleRuntimePrefetch({
        pathname: input.pathname,
        search: input.search,
        route: decoded.route,
        runtime: input.runtime,
        complete: input.complete,
      })
    }
  }
  recordSegment({
    segmentPath: input.segmentPath,
    pathname: input.pathname,
    search: input.search,
    html: input.html,
    staleTimeMs: input.staleTimeMs,
    complete: input.complete,
    static: input.static,
    runtime: input.runtime && !partial,
    postponedShell: input.postponedShell,
    ...((typeof __PNEXT_RUNTIME_PREFETCHING__ === 'boolean' ? __PNEXT_RUNTIME_PREFETCHING__ : true)
      ? { runtimeNeeded: input.runtimeNeeded, needsRuntime: input.needsRuntime }
      : {}),
    vary: decoded.vary,
    layoutVary: decoded.layoutVary,
    pageVary: decoded.pageVary,
    staticSiblings: decoded.staticSiblings,
    shell: decoded.shell,
    route: decoded.route,
    params: decoded.params,
  })
}
