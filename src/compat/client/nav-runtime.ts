// DEFERRED TIER of the navigation compat layer (see ./nav-compat). Every policy
// here is read by the router runtime and by nothing else, so it loads with the
// runtime chunk — the installers finish before the facade hands the runtime out,
// so the first fetch already sees Next's windows and caches.
import { setSoftNavBoundary } from '../../client/router'
import { installSegmentCachePolicy } from './segment-cache-policy'
import { installExportDocumentFetcher } from '../export/client'
import { reconcileNextStylesheets } from './css-order'
import { staleTimeForEntryMs, staticStaleTimeMs } from './prefetch-cache'
import { isOutsideBasePath } from './base-path'
import { predictNextLoadingShell } from './optimistic-routing'
import { applyNextNavigationScroll } from './navigation-scroll'
import { installRouteAnnouncer } from './route-announcer'

import {
  onNavigationCommit,
  onNavigationStart,
  setNavigationScrollAction,
  withSilentLocationChange,
} from '../../client/router/events'
import { historyState } from '../../client/router/history'
import { installSuspenseCatch, setSuspendHook, type SuspenseVNode } from '../react/use'

// Compat builds load this module as the router runtime (register/bundler.ts).
export * from '../../client/router/runtime-entry'

declare const __PNEXT_STATIC_EXPORT__: boolean | undefined
declare const __PNEXT_HAS_BASE_PATH__: boolean | undefined

// Type-only: the setters arrive on the runtime module, so this chunk shares no module with it.
type PolicySetters = Pick<
  typeof import('../../client/router/policies'),
  | 'setExportDocumentFetcher'
  | 'setLoadingShellPredictionPolicy'
  | 'setNavigationHistoryPolicy'
  | 'setPrefetchStaleTimePolicy'
  | 'setRevalidationPrefetchDelay'
  | 'setSegmentCachePolicy'
  | 'setShellStaleTimePolicy'
  | 'setStylesheetReconciler'
>

/** Pending thenables an island root's own boundary caught: a navigation commits once they settle. */
export const rootSuspensions = new Set<PromiseLike<unknown>>()

function trackRootSuspension(error: unknown, vnode: SuspenseVNode) {
  const thenable = error as PromiseLike<unknown> | null
  if (typeof thenable?.then !== 'function') return
  // The nearest Suspense; one directly under a render root is an island root's own boundary.
  let boundary = vnode.__
  while (boundary && !boundary.__c?.__c) boundary = boundary.__
  if (boundary && !boundary.__?.__) {
    rootSuspensions.add(thenable)
    const settle = () => void rootSuspensions.delete(thenable)
    thenable.then(settle, settle)
  }
}

export function installNavigationHistoryPolicy(
  setNavigationHistoryPolicy: PolicySetters['setNavigationHistoryPolicy'],
) {
  let pendingPush: { sequence: number; href: string; state: Record<string, unknown> } | undefined
  function releasePendingPush() {
    if (!pendingPush) return
    const { href, state } = pendingPush
    pendingPush = undefined
    withSilentLocationChange(() => history.replaceState(state, '', href))
  }
  setSuspendHook(trackRootSuspension)
  setNavigationHistoryPolicy({
    start(replace) {
      installSuspenseCatch()
      rootSuspensions.clear()
      if (replace) pendingPush = undefined
    },
    push(state, href, sequence, silent) {
      if (silent) {
        pendingPush ??= { sequence, href: location.href, state: historyState() }
        pendingPush.sequence = sequence
        history.replaceState(state, '', href)
      } else {
        releasePendingPush()
        history.pushState(state, '', href)
      }
    },
    async commit(sequence) {
      // Held while the destination's island roots suspend; a newer navigation ends the wait.
      while (rootSuspensions.size && pendingPush?.sequence === sequence) {
        let off!: () => void
        await Promise.race([
          Promise.allSettled([...rootSuspensions]),
          new Promise<void>(resolve => (off = onNavigationStart(() => resolve()))),
        ])
        off()
      }
      if (pendingPush?.sequence !== sequence) return
      const { href, state } = pendingPush
      pendingPush = undefined
      const entryState = historyState()
      const committedHref = location.href
      // Return the borrowed entry before opening the committed destination, without notifying subscribers.
      withSilentLocationChange(() => {
        history.replaceState(state, '', href)
        history.pushState(entryState, '', committedHref)
      })
    },
  })
}

export function installNavPolicies(router: PolicySetters) {
  installNavigationHistoryPolicy(router.setNavigationHistoryPolicy)
  // Route announcer: mount the empty `<next-route-announcer>` and update it on
  // every soft-nav commit (a11y — announce client route changes to AT). Next
  // mounts it at hydration; it announces nothing until the first navigation, and
  // this tier lands on idle, long before one can happen.
  installRouteAnnouncer(onNavigationCommit)
  // `output: 'export'` document fetching, in place before the router's first prefetch.
  if (typeof __PNEXT_STATIC_EXPORT__ === 'undefined' || __PNEXT_STATIC_EXPORT__)
    installExportDocumentFetcher(router.setExportDocumentFetcher)
  // Prefetch staleTime policy: static 300s / dynamic 0, with the
  // experimental.staleTimes override injected as window.__PNEXT_STALE_TIMES__,
  // and a response `x-nextjs-stale-time` header overriding both when present.
  router.setPrefetchStaleTimePolicy(staleTimeForEntryMs)
  router.setRevalidationPrefetchDelay(300)
  // Loading-shell window: a route's cached loading boundary (and the prefetch
  // entry carrying it) reuses for the STATIC window even when its dynamic data
  // is immediately stale — Next's split staleness model.
  router.setShellStaleTimePolicy(staticStaleTimeMs)
  router.setLoadingShellPredictionPolicy(predictNextLoadingShell)
  // Per-segment (vary-params) client cache — Segment-M2 deliverable 3. Entries
  // are keyed on the params a segment provably reads, so one entry serves every
  // param value it does not depend on.
  router.setSegmentCachePolicy(installSegmentCachePolicy())
  setNavigationScrollAction(applyNextNavigationScroll)
  router.setStylesheetReconciler(reconcileNextStylesheets)
  // basePath boundary: a same-origin URL outside the configured basePath must
  // hard-navigate (a `basePath:false` target), not soft-swap.
  if (typeof __PNEXT_HAS_BASE_PATH__ === 'undefined' || __PNEXT_HAS_BASE_PATH__)
    setSoftNavBoundary(isOutsideBasePath)
}
