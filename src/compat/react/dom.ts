/**
 * `react-dom` compat surface. preact/compat provides almost everything; this
 * wrapper adds the form-action hooks React ships in react-dom:
 *
 * - useFormState: the deprecated alias of React.useActionState (identical
 *   signature); implemented in ./preact.
 * - useFormStatus: pending status of the nearest enclosing <form action={fn}>.
 *   Approximated: the pnext client runtime reports in-flight function form
 *   actions to a module store and the hook subscribes to it. When exactly one
 *   submission is in flight (the overwhelmingly common case) the status is
 *   exact; concurrent submissions from different forms all read as pending.
 *   On the server it reports not-pending (matching React SSR).
 * - requestFormReset: passthrough to form.reset(); the client runtime resets
 *   uncontrolled forms after a successful action itself.
 */
import ReactCompat from 'preact/compat'
import { useActionState, useSyncExternalStore } from './preact'
import { registerResourceHint } from '../../render/resource-hints'

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

export function preload(
  href: string,
  options?: {
    as?: string
    crossOrigin?: string
    type?: string
    fetchPriority?: string
    media?: string
    nonce?: string
  },
) {
  registerResourceHint({
    rel: 'preload',
    url: href,
    ...(options?.as ? { as: options.as } : {}),
    ...(options?.type ? { type: options.type } : {}),
    ...(options?.fetchPriority
      ? { fetchPriority: options.fetchPriority as 'high' | 'low' | 'auto' }
      : {}),
    ...(options?.media ? { media: options.media } : {}),
    ...(options?.nonce ? { nonce: options.nonce } : {}),
    ...(options?.crossOrigin
      ? { crossOrigin: options.crossOrigin as 'anonymous' | 'use-credentials' | '' }
      : {}),
  })
}

export function preconnect(href: string, options?: { crossOrigin?: string }) {
  registerResourceHint({
    rel: 'preconnect',
    url: href,
    ...(options?.crossOrigin
      ? { crossOrigin: options.crossOrigin as 'anonymous' | 'use-credentials' | '' }
      : {}),
  })
}

export function prefetchDNS(href: string) {
  registerResourceHint({ rel: 'dns-prefetch', url: href })
}

export function preinit(href: string, options?: { as?: string; crossOrigin?: string }) {
  registerResourceHint({
    rel: 'preload',
    url: href,
    ...(options?.as ? { as: options.as } : {}),
    ...(options?.crossOrigin
      ? { crossOrigin: options.crossOrigin as 'anonymous' | 'use-credentials' | '' }
      : {}),
  })
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

Object.assign(ReactDomCompat, { useFormState, useFormStatus, requestFormReset })
