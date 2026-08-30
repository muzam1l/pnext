/**
 * `react-dom` client-only compat surface.
 *
 * This variant omits any `request/context` dependency so esbuild can compile pure
 * browser bundles. Resource hints are no-ops here; they are only meaningful in the
 * server response-finalization pipeline.
 */
import ReactCompat from 'preact/compat'
import { useActionState, useSyncExternalStore } from './preact'

const ReactDomCompat = Object.assign(ReactCompat, {
  preload,
  preconnect,
  prefetchDNS,
  preinit,
})

export default ReactDomCompat

// The react-dom surface preact/compat provides (named, because preact/compat's
// types use `export =` which blocks `export *`).
export const render = ReactCompat.render
export const hydrate = ReactCompat.hydrate
export const createPortal = ReactCompat.createPortal
export const findDOMNode = ReactCompat.findDOMNode
export const flushSync = ReactCompat.flushSync
export const unmountComponentAtNode = ReactCompat.unmountComponentAtNode
export const unstable_batchedUpdates = ReactCompat.unstable_batchedUpdates
export const version = ReactCompat.version
export {
  ReactDOMSharedInternals as __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED,
  ReactDOMSharedInternals as __DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
} from './internals'

function noOpRecordResourceHint() {
  // intentionally empty: client bundles do not build response headers.
}

export function preload(_href: string, _options?: { as?: string; crossOrigin?: string }) {
  noOpRecordResourceHint()
  // no-op on client; header collection happens in server response finalizers.
}

export function preconnect(_href: string, _options?: { crossOrigin?: string }) {
  noOpRecordResourceHint()
  // no-op on client; header collection happens in server response finalizers.
}

export function prefetchDNS(_href: string) {
  noOpRecordResourceHint()
  // no-op on client; header collection happens in server response finalizers.
}

export function preinit(_href: string, _options?: { as?: string; crossOrigin?: string }) {
  noOpRecordResourceHint()
  // no-op on client; header collection happens in server response finalizers.
}

export const useFormState = useActionState

export interface FormStatusNotPending {
  pending: false
  data: null
  method: null
  action: null
}

export interface FormStatusPending {
  pending: true
  data: FormData
  method: string
  action: string | ((formData: FormData) => void | Promise<void>)
}

export type FormStatus = FormStatusPending | FormStatusNotPending

const NOT_PENDING: FormStatusNotPending = {
  pending: false,
  data: null,
  method: null,
  action: null,
}

// Form-status store, fed by the client entry's function-form-action runtime.
const pendingStack: FormStatusPending[] = []
const listeners = new Set<() => void>()
let storeVersion = 0

/** Called by the client runtime when a function form action starts/finishes. */
export function __pnextPushFormStatus(status: FormStatusPending): () => void {
  pendingStack.push(status)
  notify()
  return () => {
    const index = pendingStack.indexOf(status)
    if (index !== -1) pendingStack.splice(index, 1)
    notify()
  }
}

function notify() {
  storeVersion += 1
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useFormStatus(): FormStatus {
  // No submission is ever in flight during a server render, so the counter is its own server value.
  useSyncExternalStore(
    subscribe,
    () => storeVersion,
    () => storeVersion,
  )
  return pendingStack.length > 0 ? pendingStack[pendingStack.length - 1]! : NOT_PENDING
}

export function requestFormReset(form: HTMLFormElement) {
  if (form && typeof form.reset === 'function') form.reset()
}
