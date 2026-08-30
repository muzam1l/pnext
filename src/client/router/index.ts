// First-paint router hub. Generated client entries import this module, so every byte it statically
// reaches is on the critical path of every route: keep it to link interception, history events and
// the seams compat registers into, all of which live in ./hub. The navigation runtime itself
// sits behind ./runtime and is import()ed on idle into its own chunk.
//
// Everything routed through this file is a facade over that chunk. That is the point: a static
// import of softNavigate anywhere in core or compat would otherwise pull the whole runtime back into
// first paint. State BOTH tiers touch lives in ./hub and is imported by both, so a setter
// called before the chunk lands is not replayed - it is already in place when the runtime reads it.
// Chunk membership is decided per module, so each seam is its own module.
import {
  linkClickTarget,
  locationKey,
  resolveSoftUrl,
  routerState,
  takeDeferredInstalls,
} from './hub'
import type { LinkClickTarget } from './hub'
import type { PrefetchOptions, SoftNavigateOptions } from './types'

export {
  blockJavascriptUrl,
  isJavascriptUrl,
  registerDeferredInstall,
  routerImportActive,
  setBlockedJavascriptUrlReporter,
  setSoftNavBoundary,
} from './hub'
// NOTE: ./policies, ./history and ./events are deliberately NOT re-exported
// here. esbuild assigns a chunk per set-of-reaching-entries, computed on the module graph, so a
// re-export edge from this file lands any of them in the first-paint chunk even though every symbol
// tree-shakes away. Their consumers import them directly.
export type {
  LoadingShellPrediction,
  NavigationScrollAction,
  NavigationScrollOptions,
  PrefetchedPage,
  SegmentCacheHit,
  SegmentCacheLookup,
  SegmentCachePolicy,
  SegmentCacheRecord,
  StylesheetReconciler,
} from './types'

type RouterRuntime = typeof import('./runtime')

let runtime: Promise<RouterRuntime> | undefined

/**
 * Load (once) and run against the idle tier. Every facade export chains off
 * this single promise, so calls keep their relative order even when the first
 * of them arrives before the chunk does.
 */
function withRouter<T>(use: (module: RouterRuntime) => T): Promise<Awaited<T>> {
  // Deferred installers land with the runtime chunk, before anything reads a
  // policy. Drained inside the chain (not at call time) so an installer any
  // entry registers after the first facade call still runs.
  runtime ??= import('./runtime').then(async module => {
    await Promise.all(takeDeferredInstalls().map(install => install()))
    return module
  })
  return runtime.then(use) as Promise<Awaited<T>>
}

export function softNavigate(href: string, options?: SoftNavigateOptions) {
  return withRouter(module => module.softNavigate(href, options))
}

export function prefetchRoute(href: string, options?: PrefetchOptions) {
  // Resolved here, not behind the import: `strict` (router.prefetch) reports an unusable href by
  // THROWING at the call site, and a URL this router cannot soft-navigate is a miss that never needs
  // the runtime. The throw is spelled out here rather than in the hub because the hub is a chunk
  // shared with the runtime. Only an unparseable href throws - a cross-origin or out-of-basePath one
  // is a silent miss.
  const url = resolveSoftUrl(href)
  if (!url) {
    if (options?.strict) {
      try {
        new URL(href, location.href)
      } catch {
        throw new Error(`Cannot prefetch '${href}' because it cannot be converted to a URL.`)
      }
    }
    return Promise.resolve(null)
  }
  return withRouter(module => module.prefetchRoute(url.href, options))
}

export function evictClientRouterCache(options?: { rearmVisiblePrefetches?: boolean }) {
  return withRouter(module => module.evictClientRouterCache(options))
}

export function rearmVisiblePrefetches() {
  return withRouter(module => module.rearmVisiblePrefetches())
}

// A click intercepted before the runtime lands waits for it. The wait is
// bounded: a chunk that never arrives (offline, a failed deploy) must still
// navigate, so the queued click falls back to a real browser navigation rather
// than leaving the user on a dead link.
const QUEUED_CLICK_TIMEOUT_MS = 3_000

let pendingClicks: LinkClickTarget[] = []
let pendingPop = false
let installedFull = false
let hardNavTimer: ReturnType<typeof setTimeout> | undefined

function hubLinkClick(event: MouseEvent) {
  const target = linkClickTarget(event)
  if (!target) return
  event.preventDefault()
  pendingClicks.push(target)
  hardNavTimer ??= setTimeout(() => {
    const queued = pendingClicks[0]
    if (queued) location.href = queued.url.href
  }, QUEUED_CLICK_TIMEOUT_MS)
  void loadRuntime()
}

// The browser has already committed the traversal (URL and history state are
// the target's). Record it and let the installed handler run it as an ordinary
// popstate; broadcasting here would move `observedLocationKey` and make that
// handler read the traversal as a shallow one that needs no document.
function hubPopState() {
  pendingPop = true
  void loadRuntime()
}

function loadRuntime() {
  return withRouter(module => {
    if (!installedFull) {
      installedFull = true
      document.removeEventListener('click', hubLinkClick)
      window.removeEventListener('popstate', hubPopState)
      module.installRouterFull()
    }
    clearTimeout(hardNavTimer)
    hardNavTimer = undefined
    const clicks = pendingClicks
    pendingClicks = []
    for (const click of clicks) module.commitLinkNavigation(click)
    if (pendingPop) {
      pendingPop = false
      module.onPopState()
    }
  })
}

function whenIdle(run: () => void) {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => run(), { timeout: 1000 })
  else setTimeout(run, 1)
}

export function installRouter() {
  if ((!process.browser && typeof window === 'undefined') || window.__PNEXT_ROUTER_INSTALLED__)
    return
  window.__PNEXT_ROUTER_INSTALLED__ = true
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
  // Seed the bfcache departing key with the hard-loaded route so the first
  // navigation away stashes this route's island state under the right key.
  // `locationKey()` IS `bfRouteKey(location.pathname, location.search)` — the
  // hub's own definition — and it is already on the first-paint graph.
  routerState.activeRouteKey = locationKey()

  document.addEventListener('click', hubLinkClick)
  window.addEventListener('popstate', hubPopState)
  whenIdle(() => void loadRuntime())
}
