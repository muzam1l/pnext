// Client-side error boundary (COMPAT).
//
// A preact class error boundary wrapping a hydrated route/island subtree so a CLIENT-side throw
// post-hydration is caught and rendered by the route's `error.js` instead of tearing down the whole
// preact tree. Mirrors Next's boundary:
//
//   - Control-flow errors are RE-THROWN, never rendered - the install layer's window handler drives
//     them to the correct navigation outcome. A boundary that rendered UI for these would swallow the
//     control flow.
//   - Client-thrown errors have NO digest (only server errors carry one), so the error prop is a plain
//     Error whose message is the throw's String(value); a thrown undefined/null/string passes through
//     unwrapped, matching Next's client channel.
//   - reset() clears the caught error and re-renders the children in place, recovering a
//     client-component error whose failure lived in the hydrated subtree. unstable_retry() additionally
//     soft-refreshes, which is what a data-dependent (server) failure needs.
//
// When no route error component is available the boundary mounts global-error.

import { Component, h, type ComponentChildren, type ComponentType } from 'preact'
import { isControlFlowError, handleControlFlowError } from './control-flow'
import { isNotFoundError } from '../../../api/navigation'
import { normalizeBoundaryError } from './primitive-throw'

// ---------------------------------------------------------------------------
// KNOWN GAP (preact core, not fully fixable from an options hook): a CLIENT
// `throw undefined` / `throw null` can arrive here as a synthetic TypeError when
// preact dereferences `thrown.then` before boundary interception.
// Normalize that sentinel back to raw nullish values so error UIs render as
// `undefined`/`null`, matching Next behavior.
// ---------------------------------------------------------------------------

export type RouteErrorComponent = ComponentType<{
  error: unknown
  reset: () => void
  unstable_retry?: () => void
}>
export type RouteNotFoundComponent = ComponentType<Record<string, never>>

interface BoundaryProps {
  /** The route's nearest error.js component; when absent the boundary escalates. */
  errorComponent?: RouteErrorComponent
  notFoundComponent?: RouteNotFoundComponent
  /**
   * Next's default 404 UI, handed in by the generated runtime - and emitted by it ONLY when some route
   * can reach this fallback (no not-found.* of its own). An app whose boundary routes all have one
   * never ships error-ui.ts.
   */
  builtInNotFound?: RouteNotFoundComponent
  /** Soft-refresh invoked by reset() after clearing the error. */
  onReset?: () => void
  children?: unknown
}

interface BoundaryState {
  // Raw thrown value passed to the error component. A client `throw undefined`/
  // `null`/a string reaches error.js unwrapped (Next passes the raw value on the
  // client channel), so `hasError` — NOT truthiness of `error` — gates rendering:
  // a falsy `undefined`/`null` throw is still a caught error, not "no error".
  error: unknown
  hasError: boolean
  notFound: boolean
}

/**
 * Normalize a client throw into the Error the boundary component receives.
 * Client-side non-Error throws pass through unwrapped (String(value)); no digest
 * is ever attached (digests are a server-error-only signal).
 */
export function toClientError(value: unknown): Error {
  if (value instanceof Error) return value
  // `throw undefined` / `throw null` / `throw 'msg'` → message is String(value).
  return new Error(String(value))
}

// A boundary that catches (or escalates) a real error marks it here so the
// window-listener last resort (install.ts) knows the error was already handled
// by the nearest-boundary path and must NOT also drive it to global-error.
// WeakSet-keyed (only object throws are markable; a primitive throw that reaches
// the window is treated as unhandled, matching "the boundary couldn't hold it").
const handledErrors = new WeakSet<object>()

export function markErrorHandled(error: unknown): void {
  if (error !== null && typeof error === 'object') handledErrors.add(error)
}

export function wasErrorHandled(error: unknown): boolean {
  return error !== null && typeof error === 'object' && handledErrors.has(error)
}

export class ClientErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, hasError: false, notFound: false }

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    if (isNotFoundError(error)) return { notFound: true, hasError: false, error: null }
    // Control-flow errors must not be captured as state — let componentDidCatch
    // re-throw so they propagate past this boundary.
    if (isControlFlowError(error)) return {}
    // Pass the RAW thrown value to error.js (no Error wrapping): a client
    // `throw undefined`/`null`/'msg' renders as `${error}` = 'undefined'/'null'/'msg'.
    return { error: normalizeBoundaryError(error), hasError: true }
  }

  componentDidCatch(error: unknown): void {
    if (isNotFoundError(error)) {
      markErrorHandled(error)
      return
    }
    if (isControlFlowError(error)) {
      // Re-throw past this boundary: React/Next semantics for control errors.
      // The install layer's window handler catches the propagated error and
      // performs the navigation; we still throw so no error UI renders here.
      handleControlFlowError(error)
      throw error
    }
    // A real error the boundary can render (it has a local error.js): mark it so the window-listener
    // last resort ignores it. When there is NO errorComponent this boundary re-throws in render()
    // instead of rendering anything - leave the error UNMARKED so an outer VDOM boundary can still
    // catch it, and so the window-listener last resort recognizes a truly-uncaught error and mounts
    // global-error.
    if (this.props.errorComponent) markErrorHandled(error)
  }

  /**
   * `reset()` re-renders the boundary's children in place - no server round trip. That is the whole
   * difference from `unstable_retry()`, and it matters beyond the request count: a refresh swaps the
   * body, so every node the reset subtree just rendered is replaced a moment later, and anything
   * holding one of those nodes (a click in flight, a test's element handle) loses it.
   */
  reset = (): void => {
    this.setState({ error: null, hasError: false, notFound: false })
  }

  /**
   * Re-run the SERVER render, then re-render: recovers data-dependent failures. A CLIENT-component
   * error carries no digest (digests are a server-only signal) - its failure lives in the hydrated
   * tree, so re-rendering in place recovers it and a soft-refresh would only swap the body, detaching
   * the very nodes a retry-then-interact loop reaches next. Only a server error's stale data needs the
   * round trip.
   */
  unstable_retry = (): void => {
    const digest = (this.state.error as { digest?: unknown } | null)?.digest
    this.setState({ error: null, hasError: false, notFound: false })
    if (typeof digest === 'string' && digest.length > 0) this.props.onReset?.()
  }

  // A client-side notFound() that renders a LOCAL not-found.js has no server
  // round trip, so the `<meta name="robots" content="noindex">` the server
  // would emit for a not-found render is missing. Mirror it on the client:
  // inject the tag while the local boundary is showing, remove it on recovery.
  private addedNoindex = false

  private syncNotFoundRobots(): void {
    if (typeof document === 'undefined') return
    const shouldShow = this.state.notFound && Boolean(this.props.notFoundComponent)
    if (shouldShow && !this.addedNoindex) {
      // Don't stomp an existing robots tag (SSR/metadata already set one).
      if (!document.querySelector('meta[name="robots"]')) {
        const meta = document.createElement('meta')
        meta.setAttribute('name', 'robots')
        meta.setAttribute('content', 'noindex')
        meta.setAttribute('data-pnext-notfound-robots', '')
        document.head.appendChild(meta)
        this.addedNoindex = true
      }
    } else if (!shouldShow && this.addedNoindex) {
      document.querySelector('meta[name="robots"][data-pnext-notfound-robots]')?.remove()
      this.addedNoindex = false
    }
  }

  componentDidMount(): void {
    this.syncNotFoundRobots()
  }

  componentDidUpdate(): void {
    this.syncNotFoundRobots()
  }

  componentWillUnmount(): void {
    if (this.addedNoindex) {
      document.querySelector('meta[name="robots"][data-pnext-notfound-robots]')?.remove()
      this.addedNoindex = false
    }
  }

  render(): ComponentChildren {
    if (this.state.notFound) {
      const NotFoundComponent = this.props.notFoundComponent ?? this.props.builtInNotFound
      return NotFoundComponent ? h(NotFoundComponent, {}) : null
    }
    if (!this.state.hasError) return this.props.children
    const { error } = this.state
    const ErrorComponent = this.props.errorComponent
    if (!ErrorComponent) {
      // Preserve primitive throws for global-error.js directly (window `error`
      // loses raw null/undefined/string). Bubble Error objects to the next outer
      // ClientErrorBoundary so nearest in-tree boundary semantics stay intact.
      if (error === null || typeof error !== 'object') {
        // global-error rides the deferred tier (see ./lazy) — a primitive throw
        // with no error.js is the one path that reaches it from a render.
        void import('./global-error').then(m => m.escalateToGlobalError(error))
        return null
      }
      throw error as Error
    }
    return h(ErrorComponent, { error, reset: this.reset, unstable_retry: this.unstable_retry })
  }
}
