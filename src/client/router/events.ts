// Router event seams: the location-change, navigation-start and navigation-commit listener sets
// compat hooks subscribe to, plus the post-navigation scroll action. All share one tier - an entry
// that reads router state pulls this in at first paint, one that only has a <Link> gets it with the
// runtime chunk - and none may sit in ./hub, which is a chunk shared with the runtime.
import { locationKey, routerState } from './hub'
import type { NavigationScrollAction, NavigationScrollOptions } from './types'

export let navigationScrollAction: NavigationScrollAction | undefined

export function setNavigationScrollAction(action: NavigationScrollAction | undefined) {
  navigationScrollAction = action
}

export function scheduleNavigationScroll(url: URL, options: NavigationScrollOptions = {}) {
  navigationScrollAction?.(url, options)
}

export function locationListeners() {
  window.__PNEXT_LOCATION_LISTENERS__ ??= new Set()
  return window.__PNEXT_LOCATION_LISTENERS__
}

export function emitLocationChange() {
  routerState.observedLocationKey = locationKey()
  if (silentLocationDepth > 0) return
  for (const listener of [...locationListeners()]) listener()
}

let silentLocationDepth = 0

// Moves the address bar without waking usePathname/useParams subscribers: the pre-commit
// optimistic push's URL is ahead of the tree, so broadcasting would desync URL and params.
// observedLocationKey still advances, so a traversal off the pushed entry is a real move.
export function withSilentLocationChange(move: () => void) {
  silentLocationDepth++
  try {
    move()
  } finally {
    silentLocationDepth--
  }
}

// Fires at the start of every soft navigation (link click, router.push,
// refresh). Compat's link-status uses it to end a link's pending state when a
// different navigation supersedes it.
// Annotated pure so an entry that subscribes to nothing (a link-only page)
// shakes the whole seam out of its first-paint closure.
export const navigationStartListeners = /* @__PURE__ */ new Set<() => void>()

export function onNavigationStart(listener: () => void) {
  navigationStartListeners.add(listener)
  return () => navigationStartListeners.delete(listener)
}

export function emitNavigationStart() {
  for (const listener of [...navigationStartListeners]) listener()
}

export const navigationCommitListeners = /* @__PURE__ */ new Set<() => void>()

export function onNavigationCommit(listener: () => void) {
  navigationCommitListeners.add(listener)
  return () => navigationCommitListeners.delete(listener)
}

export function emitNavigationCommit() {
  for (const listener of [...navigationCommitListeners]) listener()
}
