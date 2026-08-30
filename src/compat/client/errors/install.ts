// Client error runtime install (COMPAT, client half).
//
// Pairs with the server error pipeline: the server owns SSR throws (digest, redaction, boundary/default
// UI). This module owns CLIENT-side throws that happen AFTER hydration, which the server never sees.
//
// PRIMARY = the in-tree `ClientErrorBoundary` wraps every hydrated island and the client page mount.
// It gives Next's NEAREST-BOUNDARY semantics: the boundary renders the route's error.js, control-flow
// errors re-throw past it, and reset() soft-refreshes. A boundary that renders its error UI marks the
// error handled.
//
// LAST RESORT = this window error/unhandledrejection listener, handling ONLY what the boundary path
// could not:
//   1. CONTROL-FLOW errors that escape - driven to their navigation outcome, never shown.
//   2. ACTION errors - left to the action-error overlay, ignored here.
//   3. Errors ALREADY HANDLED by a boundary - ignored, so one failure is never rendered twice.
//   4. UNCAUGHT RENDER escapes (tagged at the preact boundary walk, see ./lazy) - the root render
//      failed, so global-error replaces the document, exactly Next's root boundary.
//   5. Anything else - event-handler throws, third-party script noise, benign browser error events
//      (ResizeObserver loops report with `error: null`) - stays uncaught and the page SURVIVES.
//      Next mounts global-error only from its root render boundary, never from window events
//      (its only production window listeners drive redirect control flow).
//
// Client-escaped errors carry NO digest, matching Next.

import { h, options, render } from 'preact'
import { handleControlFlowError, isControlFlowError } from './control-flow'
import {
  wasErrorHandled,
  type RouteErrorComponent,
  type RouteNotFoundComponent,
} from './error-boundary'
import {
  escalateToGlobalError,
  mountGlobalError,
  registerGlobalErrorComponent,
  wasReportedUncaught,
  type GlobalErrorComponent,
} from './global-error'
import { softRefreshRoute } from './soft-refresh'

export { ClientErrorBoundary, toClientError } from './error-boundary'
export { markErrorHandled, wasErrorHandled } from './error-boundary'
export type { RouteErrorComponent } from './error-boundary'
export { isControlFlowError, handleControlFlowError } from './control-flow'
export { mountGlobalError } from './global-error'
export { softRefreshRoute } from './soft-refresh'

export interface InstallOptions {
  /**
   * The route's nearest error.js component. Now consumed by the entry's
   * ClientErrorBoundary (nearest-boundary primary path); retained here so the
   * install signature stays stable and callers can still thread it.
   */
  errorComponent?: RouteErrorComponent
  notFoundComponent?: RouteNotFoundComponent
  /** The app's global-error.js component, when available (see gaps: build thread). */
  globalErrorComponent?: GlobalErrorComponent
  /**
   * Predicate identifying action errors already handled by the action overlay,
   * so this runtime skips them. Defaults to never-skip when omitted.
   */
  isActionError?: (error: unknown) => boolean
}

let installed = false

// Cross-chunk marker (./lazy tags before this chunk exists): a value the preact boundary walk
// rethrew is a ROOT RENDER failure, the one case the window channel mounts global-error for.
const RENDER_ESCAPE = Symbol.for('pnext.renderEscape')

export function tagRenderEscape(error: unknown): void {
  if (error !== null && typeof error === 'object') {
    try {
      ;(error as Record<symbol, unknown>)[RENDER_ESCAPE] = true
    } catch {
      // frozen throw value: the post-install escalation still mounts synchronously
    }
  }
}

function isRenderEscape(error: unknown): boolean {
  return error !== null && typeof error === 'object' && RENDER_ESCAPE in error
}

// Set by installClientErrors so ./lazy can replay the errors that escaped
// before this chunk landed (a throw during hydration or in a first-paint
// effect) through exactly the same triage.
let escapedErrorHandler: ((error: unknown) => void) | undefined

/** Replay pre-runtime escapes (./lazy buffers them) through the last resort. */
export function drainEscapedErrors(errors: unknown[]): void {
  for (const error of errors) escapedErrorHandler?.(error)
}

export function installClientErrors(options: InstallOptions = {}): void {
  if ((!process.browser && typeof window === 'undefined') || installed) return
  installed = true

  const { globalErrorComponent, isActionError } = options
  // Register so the in-tree ClientErrorBoundary can escalate a no-error.js route
  // straight to global-error (handles `throw undefined`/`null`, which the window
  // channel would drop).
  registerGlobalErrorComponent(globalErrorComponent)

  const onError = (error: unknown): void => {
    // Already caught + rendered by a route boundary: the boundary owns it.
    if (wasErrorHandled(error)) return
    // Control-flow first: navigate, never render (covers control errors thrown
    // outside any boundary, and boundary-rethrown ones that reach the window).
    if (isControlFlowError(error)) {
      handleControlFlowError(error)
      return
    }
    // Action errors belong to the action-error overlay.
    if (isActionError?.(error)) return

    // Only a RENDER escape (the preact boundary walk rethrew it — tagged in ./lazy before this
    // chunk exists, escalated synchronously after install) replaces the document: that is Next's
    // root render boundary. Every other uncaught value — event handlers, third-party scripts,
    // browser noise — stays uncaught and the page survives, as it does under Next.
    if (isRenderEscape(error)) mountGlobalError(error, globalErrorComponent)
  }
  escapedErrorHandler = onError

  window.addEventListener('error', event => {
    // Ignore ResourceLoad errors (no `error` object) — only script throws carry one.
    if ('error' in event && event.error === undefined) return
    // Our own synchronous reportUncaught echo: already mounted + reported.
    if (wasReportedUncaught(event.error)) return
    if (event.error !== undefined) onError(event.error)
  })
  window.addEventListener('unhandledrejection', event => {
    // The escape below already reported this value synchronously; without
    // preventDefault the page would emit a SECOND uncaught-error report.
    if (wasReportedUncaught(event.reason)) {
      event.preventDefault()
      return
    }
    onError(event.reason)
  })

  installRenderEscapeEscalation(globalErrorComponent, isActionError)
  installStreamErrorBoundaries(options.errorComponent, globalErrorComponent)
}

// Synchronous global-error escalation for a render throw no boundary held. Preact signals "nothing
// caught this" by re-throwing out of its internal boundary walk - which runs inside the microtask that
// flushes the re-render, so the value reaches the page as an *unhandled rejection* one task later. Next
// replaces the document during the click that threw, so intercept the escape here and mount
// global-error right away. The value is re-thrown untouched, so the page still reports it as uncaught
// and the window listener above still drives control-flow errors to their navigation.
function installRenderEscapeEscalation(
  globalErrorComponent?: GlobalErrorComponent,
  isActionError?: (error: unknown) => boolean,
): void {
  // `_catchError` in preact's source; `__e` in its published (mangled) build.
  const hooks = options as unknown as Record<string, unknown>
  const key = (['_catchError', '__e'] as const).find(name => typeof hooks[name] === 'function')
  if (!key) return
  const walkBoundaries = hooks[key] as (...args: unknown[]) => unknown
  hooks[key] = function patchedCatchError(this: unknown, ...args: unknown[]) {
    try {
      return walkBoundaries.apply(this, args)
    } catch (error) {
      // Handled by a boundary, control flow, or an action error: those already
      // have an owner — only a genuinely uncaught error escapes to global-error.
      // escalate (not mount): the error must also report as uncaught in THIS
      // task, not a task later via the natural unhandled rejection.
      tagRenderEscape(error)
      if (!wasErrorHandled(error) && !isControlFlowError(error) && !isActionError?.(error)) {
        escalateToGlobalError(error)
      }
      throw error
    }
  }
}

// Streamed-Suspense server errors, routed to the route error.js boundary.
//
// When a server component inside a streaming Suspense boundary throws, the server can only flush a
// static replacement chunk - the page shell already streamed with status 200. Next's behavior is to
// render the NEAREST error.js boundary client-side with the serialized error (redacted message +
// digest) and working reset()/unstable_retry(). The server stamps the serialized error onto the marker;
// here we watch for those markers (initial scan plus a MutationObserver, since stream chunks land after
// the entry module runs) and mount the route error.js over them. Both callbacks soft-refresh, so a
// since-recovered server render replaces the boundary with real content.
const STREAM_ERROR_SELECTOR = 'pnext-error[data-pnext-stream-error][data-pnext-error-message]'

function installStreamErrorBoundaries(
  errorComponent?: RouteErrorComponent,
  globalErrorComponent?: GlobalErrorComponent,
): void {
  if (typeof document === 'undefined') return
  // Announce the runtime so the server's inline stream-error fallback script
  // (renderer streamErrorDocumentScript) defers to this handler.
  ;(window as unknown as Record<string, unknown>).__PNEXT_STREAM_ERROR_RUNTIME__ = true

  const mountMarker = (marker: Element): void => {
    const message = marker.getAttribute('data-pnext-error-message') ?? ''
    const digest = marker.getAttribute('data-pnext-error-digest') ?? undefined
    const error = new Error(message) as Error & { digest?: string }
    if (digest) error.digest = digest
    if (!errorComponent) {
      // No route error.js: Next escalates a streamed-Suspense server error to
      // global-error (the built-in "This page couldn't load" document with the
      // ERROR <digest> footer when none exists — default-error-page-ui suite).
      mountGlobalError(error, globalErrorComponent)
      return
    }
    const host = document.createElement('div')
    marker.replaceWith(host)
    const reset = () => softRefreshRoute()
    render(h(errorComponent, { error, reset, unstable_retry: reset }), host)
  }

  const scan = (root: ParentNode): void => {
    for (const marker of Array.from(root.querySelectorAll(STREAM_ERROR_SELECTOR))) {
      mountMarker(marker)
    }
  }

  const observe = () => {
    scan(document)
    new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const node of Array.from(mutation.addedNodes)) {
          if (!(node instanceof Element)) continue
          if (node.matches(STREAM_ERROR_SELECTOR)) mountMarker(node)
          else scan(node)
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observe, { once: true })
  } else {
    observe()
  }
}
