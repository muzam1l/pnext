'use client'
/** @jsxImportSource preact */

import { Component, Fragment, h, type ComponentChildren, type ComponentType } from 'preact'
import { isControlFlowError } from '../client/errors/control-flow'
import { untagPrimitiveThrow } from '../client/errors/primitive-throw'

export interface ErrorInfo {
  error: unknown
  reset: () => void
  unstable_retry: () => void
}

// Island error-boundary protocol (see render/renderer.ts): when a Server Component inside this
// boundary's children throws during the SSR resolve walk, the renderer serializes the error into this
// prop on the island - used twice. On SSR the initial state is the caught state, so the fallback renders
// inline; on hydration the prop rides `data-pnext-props`, so the client mount re-creates the SAME caught
// state and the server-rendered fallback hydrates interactive. Without this handoff the client would
// remount with "no error" and blank out the fallback. The renderer only performs the handoff for
// components carrying `Symbol.for('pnext.islandErrorBoundary')`, stamped below.
const ISLAND_BOUNDARY_ERROR_PROP = '__pnextBoundaryError'
const islandErrorBoundarySymbol = Symbol.for('pnext.islandErrorBoundary')

interface IslandBoundaryErrorMarker {
  name?: string
  message?: string
  digest?: string
}

interface CatchErrorProps {
  children?: ComponentChildren
  clearError?: () => void
  [ISLAND_BOUNDARY_ERROR_PROP]?: IslandBoundaryErrorMarker
}

interface CatchErrorState {
  error: unknown
  hasError: boolean
  version: number
}

function reviveBoundaryError(marker: IslandBoundaryErrorMarker): Error & { digest?: string } {
  const error = new Error(String(marker.message ?? '')) as Error & { digest?: string }
  if (marker.name) error.name = String(marker.name)
  if (typeof marker.digest === 'string') error.digest = marker.digest
  return error
}

function initialCatchErrorState(props: CatchErrorProps): CatchErrorState {
  const marker = props[ISLAND_BOUNDARY_ERROR_PROP]
  if (marker && typeof marker === 'object') {
    return { error: reviveBoundaryError(marker), hasError: true, version: 0 }
  }
  return { error: undefined, hasError: false, version: 0 }
}

export function unstable_catchError<Props extends Record<string, unknown>>(
  Fallback: (props: Props, info: ErrorInfo) => ComponentChildren,
): ComponentType<Props & CatchErrorProps> {
  class CatchError extends Component<Props & CatchErrorProps, CatchErrorState> {
    state: CatchErrorState = initialCatchErrorState(this.props)

    static getDerivedStateFromError(error: unknown): Partial<CatchErrorState> {
      // Router signals belong to their owning route boundary. Capturing one
      // here turns a redirect/notFound into a stale local fallback instead of
      // letting the client control-flow handler complete the navigation.
      if (isControlFlowError(error)) throw error
      return { error: normalizeBoundaryError(error), hasError: true }
    }

    reset = () => {
      this.props.clearError?.()
      this.setState(state => ({
        error: undefined,
        hasError: false,
        version: state.version + 1,
      }))
    }

    unstable_retry = () => {
      // App-Router only: `unstable_retry` re-runs the server render, which the Pages Router has no
      // equivalent of. The discriminator is the rendering context, NOT the user-supplied `clearError`
      // prop (the Pages fixture passes it too) - App-Router documents always render the segment tree as
      // <pnext-layout>/[data-pnext-root] elements; Pages ones never do.
      if (!isAppRouterDocument()) {
        throw new Error(
          '`unstable_retry()` can only be used in the App Router. Use `reset()` in the Pages Router.',
        )
      }
      if (!process.browser && typeof window === 'undefined') {
        this.reset()
        return
      }
      // Refresh FIRST, reset when it settles. Resetting immediately re-renders the children while the
      // refresh response is still in flight; anything the user does in that window is wiped when the
      // body swap lands, so a rapid retry-then-interact cycle loses the new state. Deferring the reset
      // closes that window (if the swap remounted this boundary the setState is a no-op on an unmounted
      // instance, which preact ignores). A failed refresh still resets.
      const refreshed = routerRefresh()
      void Promise.resolve(refreshed)
        .catch(() => undefined)
        .then(() => this.reset())
    }

    render(props: Props & CatchErrorProps, state: CatchErrorState) {
      if (state.hasError) {
        // Strip the internal handoff marker; the user's fallback gets the
        // component's own props (title, clearError, ...), matching Next.
        const { [ISLAND_BOUNDARY_ERROR_PROP]: _marker, ...rest } = props
        return Fallback(rest as unknown as Props, {
          error: state.error,
          reset: this.reset,
          unstable_retry: this.unstable_retry,
        })
      }
      return h(Fragment, { key: state.version }, props.children)
    }
  }
  // Opt in to the renderer's island error-boundary handoff (see above).
  ;(CatchError as unknown as Record<symbol, boolean>)[islandErrorBoundarySymbol] = true
  return CatchError
}

function isAppRouterDocument(): boolean {
  if (typeof document === 'undefined') return false
  return Boolean(document.querySelector('pnext-layout, [data-pnext-root]'))
}

function routerRefresh() {
  const global = window as unknown as {
    __PNEXT_ROUTER__?: { refresh?: () => Promise<void> | void }
  }
  return global.__PNEXT_ROUTER__?.refresh?.()
}

function normalizeBoundaryError(error: unknown): unknown {
  // Preact-core interop tag (see client/errors/primitive-throw.ts): a client
  // `throw undefined`/`null` arrives here re-thrown as a tagged Error so it
  // survived preact's own `e.then` suspense check without crashing. Unwrap
  // back to the raw value Next passes to error UIs.
  const untagged = untagPrimitiveThrow(error)
  if (untagged !== error) return untagged
  if (error instanceof Error) {
    // Fallback for any crash that slips through un-tagged (defense in depth).
    if (error.message === "Cannot read properties of undefined (reading 'then')") return undefined
    if (error.message === "Cannot read properties of null (reading 'then')") return null
  }
  return error
}
