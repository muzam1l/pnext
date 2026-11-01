// A separate import() entry lets esbuild drop the runtime's test-only exports.
export {
  softNavigate,
  prefetchRoute,
  evictClientRouterCache,
  rearmVisiblePrefetches,
  installRouterFull,
  commitLinkNavigation,
  onPopState,
} from './runtime'
import {
  setExportDocumentFetcher,
  setLoadingShellPredictionPolicy,
  setNavigationHistoryPolicy,
  setPrefetchStaleTimePolicy,
  setRevalidationPrefetchDelay,
  setSegmentCachePolicy,
  setShellStaleTimePolicy,
  setStylesheetReconciler,
} from './policies'

declare const __PNEXT_ROUTER_POLICY_SETTERS__: boolean | undefined

// Compat's deferred installers set policies through this chunk; core builds define the flag false and drop it.
export const policySetters =
  typeof __PNEXT_ROUTER_POLICY_SETTERS__ === 'undefined' || __PNEXT_ROUTER_POLICY_SETTERS__
    ? {
        setExportDocumentFetcher,
        setLoadingShellPredictionPolicy,
        setNavigationHistoryPolicy,
        setPrefetchStaleTimePolicy,
        setRevalidationPrefetchDelay,
        setSegmentCachePolicy,
        setShellStaleTimePolicy,
        setStylesheetReconciler,
      }
    : undefined
