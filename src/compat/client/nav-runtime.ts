// DEFERRED TIER of the navigation compat layer (see ./nav-compat). Every policy
// here is read by the router runtime and by nothing else, so it loads with the
// runtime chunk — the installers finish before the facade hands the runtime out,
// so the first fetch already sees Next's windows and caches.
import { setSoftNavBoundary } from '../../client/router'
import { setNavigationScrollAction } from '../../client/router/events'
import {
  setLoadingShellPredictionPolicy,
  setPrefetchStaleTimePolicy,
  setRevalidationPrefetchDelay,
  setSegmentCachePolicy,
  setShellStaleTimePolicy,
  setStylesheetReconciler,
} from '../../client/router/policies'
import { installSegmentCachePolicy } from './segment-cache-policy'
// `output: 'export'` document fetching. Imported for its module-scope
// registration, which has to beat the router's first prefetches — this module
// resolving before the runtime is handed out is exactly that guarantee.
import '../export/client'
import { reconcileNextStylesheets } from './css-order'
import { staleTimeForEntryMs, staticStaleTimeMs } from './prefetch-cache'
import { isOutsideBasePath } from './base-path'
import { predictNextLoadingShell } from './optimistic-routing'
import { applyNextNavigationScroll } from './navigation-scroll'
import { installRouteAnnouncer } from './route-announcer'

export function installNavPolicies() {
  // Route announcer: mount the empty `<next-route-announcer>` and update it on
  // every soft-nav commit (a11y — announce client route changes to AT). Next
  // mounts it at hydration; it announces nothing until the first navigation, and
  // this tier lands on idle, long before one can happen.
  installRouteAnnouncer()
  // Prefetch staleTime policy: static 300s / dynamic 0, with the
  // experimental.staleTimes override injected as window.__PNEXT_STALE_TIMES__,
  // and a response `x-nextjs-stale-time` header overriding both when present.
  setPrefetchStaleTimePolicy(staleTimeForEntryMs)
  setRevalidationPrefetchDelay(300)
  // Loading-shell window: a route's cached loading boundary (and the prefetch
  // entry carrying it) reuses for the STATIC window even when its dynamic data
  // is immediately stale — Next's split staleness model.
  setShellStaleTimePolicy(staticStaleTimeMs)
  setLoadingShellPredictionPolicy(predictNextLoadingShell)
  // Per-segment (vary-params) client cache — Segment-M2 deliverable 3. Entries
  // are keyed on the params a segment provably reads, so one entry serves every
  // param value it does not depend on.
  setSegmentCachePolicy(installSegmentCachePolicy())
  setNavigationScrollAction(applyNextNavigationScroll)
  setStylesheetReconciler(reconcileNextStylesheets)
  // basePath boundary: a same-origin URL outside the configured basePath must
  // hard-navigate (a `basePath:false` target), not soft-swap.
  setSoftNavBoundary(isOutsideBasePath)
  // NOTE: the standalone segment-prefetch wire runtime (segment-prefetch.ts) is
  // deliberately NOT installed: its intent-time tree/body fetches fed caches
  // nothing consumed and broke Next's request-count contracts (a hover inside a
  // "no-requests" scope must not fetch). The router's own prefetch cache +
  // loading-shell cache cover the segment semantics on the HTML-swap model.
}
