import { softNavigate } from '../../../client/router'

/**
 * Soft-refresh the current URL from the server (re-runs the hydrated subtree so a data-dependent
 * failure re-fetches on retry). Shared reset() behaviour for the ClientErrorBoundary the entry wraps
 * around islands and the page mount. Kept in its own module so the entry can reach it without pulling
 * ./install - which rides the deferred tier - into first paint.
 */
export function softRefreshRoute(): void {
  if (!process.browser && typeof window === 'undefined') return
  void softNavigate(location.href, { replace: true, scroll: false, remount: true }).catch(() => {
    location.reload()
  })
}
