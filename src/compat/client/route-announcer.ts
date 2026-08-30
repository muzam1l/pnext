// Route announcer (next/navigation a11y): a `<next-route-announcer>` custom
// element whose shadow root holds an `aria-live="assertive"` node. Screen
// readers announce client-side route changes that would otherwise be silent
// (no full document load). The DOM name is Next-specific, so it lives in compat;
// core exposes an `onNavigationCommit` hook that this module subscribes to.
import { onNavigationCommit } from '../../client/router/events'

const ANNOUNCER_TAG = 'next-route-announcer'

let announcerNode: HTMLElement | undefined

// Next skips the very first render (no initial announcement): the announcer
// starts empty and only updates on subsequent navigations. `onNavigationCommit`
// only fires inside softNavigate, so it never runs for the hard load — but we
// also guard against announcing an unchanged value.
let lastAnnouncement = ''

function ensureAnnouncer(): HTMLElement | undefined {
  if (typeof document === 'undefined') return undefined
  if (announcerNode?.isConnected) return announcerNode

  const existing = document.getElementsByTagName(ANNOUNCER_TAG)[0]
  if (existing instanceof HTMLElement && existing.shadowRoot) {
    announcerNode = existing.shadowRoot.childNodes[0] as HTMLElement
    return announcerNode
  }

  const host = document.createElement(ANNOUNCER_TAG)
  host.style.cssText = 'position:absolute'
  const shadow = host.attachShadow({ mode: 'open' })
  // A <div>, matching Next's app-router announcer exactly — a <p> here leaks
  // into shadow-piercing selectors (e.g. a test's `p` lookup racing an action
  // result) that Next's DOM never matches.
  const live = document.createElement('div')
  live.setAttribute('aria-live', 'assertive')
  live.setAttribute('id', '__next-route-announcer__')
  live.setAttribute('role', 'alert')
  // Visually hidden but available to assistive tech (Next's own styles).
  live.style.cssText =
    'position:absolute;border:0;height:1px;margin:-1px;padding:0;width:1px;clip:rect(0 0 0 0);overflow:hidden;white-space:nowrap;word-wrap:normal'
  shadow.appendChild(live)
  document.body.appendChild(host)
  announcerNode = live
  return live
}

// Priority order matches Next: document.title, then the first <h1>, then the
// pathname. Read after the body swap + head sync so the new title/heading are
// already in the DOM.
function routeAnnouncement(): string {
  if (document.title) return document.title
  const h1 = document.querySelector('h1')
  const text = h1?.textContent?.trim()
  if (text) return text
  return location.pathname
}

function announce() {
  const node = ensureAnnouncer()
  if (!node) return
  const next = routeAnnouncement()
  if (next === lastAnnouncement) return
  lastAnnouncement = next
  node.textContent = next
}

export function installRouteAnnouncer() {
  if (!process.browser && typeof window === 'undefined') return
  // Create the empty announcer up front so it exists on first load with `''`.
  ensureAnnouncer()
  onNavigationCommit(announce)
}
