// Client-side control-flow error handling (COMPAT).
//
// notFound()/forbidden()/unauthorized()/redirect() called during a CLIENT-side render throw the same
// control-flow errors the server throws. React routes them to the nearest error boundary, but - exactly
// like Next - a boundary must NOT render its error UI for one: it must RE-THROW so the control error
// propagates. Client-side there is no server render pass to catch it, so this runtime intercepts the
// propagated error and drives the browser to the correct outcome:
//
//   - notFound / forbidden / unauthorized: soft-navigate to the CURRENT url so the server re-renders
//     it. On that render the same control-flow call fires server-side (deterministic for the same
//     inputs) and the server resolves the nearest boundary with the right status.
//   - redirect / permanentRedirect: navigate to the target (soft for same-origin, hard for
//     cross-origin), matching redirect()'s browser path.
//
// Detection reuses the core control-flow predicates so the digest scheme stays single-sourced.

import {
  isForbiddenError,
  isNotFoundError,
  isRedirectError,
  isUnauthorizedError,
  type PNextRedirectError,
} from '../../../api/navigation'
import { isPostpone } from '../../../render/postpone'
import { softNavigate } from '../../../client/router'

/** True for a Next control-flow error that a boundary must re-throw, not render. */
export function isControlFlowError(error: unknown): boolean {
  return (
    isRedirectError(error) ||
    isNotFoundError(error) ||
    isForbiddenError(error) ||
    isUnauthorizedError(error) ||
    isPostpone(error)
  )
}

/**
 * Drive the browser to the outcome a client-side control-flow error demands.
 * Returns true when the error was a control-flow error (and has been handled),
 * false otherwise (a real error the caller must surface to a boundary).
 */
export function handleControlFlowError(error: unknown): boolean {
  if (isRedirectError(error)) {
    applyRedirect(error)
    return true
  }
  if (isNotFoundError(error) || isForbiddenError(error) || isUnauthorizedError(error)) {
    // Re-render the current URL server-side: the same control-flow call fires
    // during that render and the server resolves the matching boundary + status.
    // replace:true keeps history intact (the URL did not change); scroll:false
    // avoids a jump. Fall back to a full reload if the soft-nav itself fails.
    if (process.browser || typeof window !== 'undefined') {
      void softNavigate(location.href, { replace: true, scroll: false }).catch(() => {
        location.reload()
      })
    }
    return true
  }
  if (isPostpone(error)) {
    // A postpone escaping to the client has nothing to resume against here; a
    // reload re-renders from the server. Treated as handled so it never lands
    // in an error boundary as a "real" error.
    if (process.browser || typeof window !== 'undefined') location.reload()
    return true
  }
  return false
}

function applyRedirect(error: PNextRedirectError): void {
  if (!process.browser && typeof window === 'undefined') return
  const target = error.location
  let sameOrigin = false
  try {
    sameOrigin = new URL(target, location.href).origin === location.origin
  } catch {
    sameOrigin = false
  }
  const replace = error.status === 303 || error.status === 307 || error.status === 308
  if (sameOrigin) {
    void softNavigate(target, { replace }).catch(() => {
      hardNavigate(target, replace)
    })
  } else {
    hardNavigate(target, replace)
  }
}

function hardNavigate(target: string, replace: boolean): void {
  if (replace) location.replace(target)
  else location.assign(target)
}
