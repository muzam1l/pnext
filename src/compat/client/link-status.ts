// Per-link navigation pending state for `useLinkStatus()` (next/link). A single link is "pending" at a
// time: the last one whose click started an in-flight soft navigation. It clears on completion, and on
// any navigation started elsewhere - all of which broadcast a location change.
import { createContext } from 'preact'
import { softNavigate } from '../../client/router'
import { locationListeners, onNavigationStart } from '../../client/router/events'
import { patchHistory } from '../../api/client-navigation'

export interface LinkStatus {
  pending: boolean
}

export const LinkStatusContext = createContext<LinkStatus>({ pending: false })

type Listener = () => void

let pendingToken: symbol | null = null
// Set right before navigateWithStatus starts its own soft-nav, so the resulting
// synchronous nav-start is recognized as the link's own, not a supersession.
let ownNavStart: symbol | null = null
const listeners = new Set<Listener>()
let wired = false

function notify() {
  for (const listener of [...listeners]) listener()
}

function setPending(token: symbol | null) {
  if (pendingToken === token) return
  pendingToken = token
  notify()
}

// A different navigation starting (router.push, refresh, another link)
// supersedes the pending link immediately, even while its own nav is still
// in flight — its synchronous start isn't the pending link's own.
function onNavStart() {
  if (ownNavStart !== null) {
    ownNavStart = null
    return
  }
  setPending(null)
}

// A location change ends the pending state: for the pending link's own nav this
// only fires at completion (its pushState happens after the fetch resolves);
// for shallow pushState / browser back it fires immediately. Both should clear.
function onLocationChange() {
  setPending(null)
}

function wire() {
  if (wired || (!process.browser && typeof window === 'undefined')) return
  wired = true
  // Raw window.history.pushState/replaceState (shallow routing) must clear the
  // pending link; the patch broadcasts them through locationListeners.
  patchHistory()
  onNavigationStart(onNavStart)
  locationListeners().add(onLocationChange)
  window.addEventListener('popstate', onLocationChange)
}

export function subscribeLinkStatus(_token: symbol, listener: Listener) {
  wire()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function linkPending(token: symbol) {
  return pendingToken === token
}

// Start a soft navigation owned by this link: mark it pending, clear on
// completion. A newer click flips the token, so a stale completion won't clear
// the newer link's pending state.
export function navigateWithStatus(
  token: symbol,
  href: string,
  options: { replace?: boolean; scroll?: boolean },
) {
  ownNavStart = token
  setPending(token)
  void softNavigate(href, options).finally(() => {
    if (pendingToken === token) setPending(null)
  })
}
