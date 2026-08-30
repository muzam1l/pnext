// Bare tier of the client error boundary (see ./error-boundary): a route with no error.*/not-found.*
// still needs one so hydration throws reach the window last resort (not preact's diff) and primitive
// throws keep their raw value en route to global-error. Exactly those two behaviors, ~0.5 KB raw.
import { Component, type ComponentChildren } from 'preact'
import { normalizeBoundaryError } from './primitive-throw'

interface BareBoundaryState {
  error: unknown
  hasError: boolean
}

export class BareErrorBoundary extends Component<{ children?: unknown }, BareBoundaryState> {
  state: BareBoundaryState = { error: null, hasError: false }

  static getDerivedStateFromError(error: unknown): BareBoundaryState {
    return { error: normalizeBoundaryError(error), hasError: true }
  }

  render(): ComponentChildren {
    if (!this.state.hasError) return this.props.children
    const { error } = this.state
    // A primitive would arrive at the window handler as a synthesized Error, so
    // escalate it to global-error directly (deferred tier) with its raw value.
    // Everything else re-throws: unmarked, so the window last resort still sees
    // a genuinely uncaught error and drives it.
    if (error === null || typeof error !== 'object') {
      void import('./global-error').then(module => module.escalateToGlobalError(error))
      return null
    }
    throw error as Error
  }
}
