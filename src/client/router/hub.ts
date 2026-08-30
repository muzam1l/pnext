// FIRST-PAINT TIER. Every byte here is in every route entry's static graph, so this module holds
// only what a click must decide before the navigation runtime lands (link eligibility, soft-URL
// resolution) and the mutable state both tiers share. The runtime lives behind ./runtime (idle
// chunk), and because both tiers import THIS module, a seam registered during first paint is already
// in place when the runtime reads it - nothing is replayed.
//
// A symbol only the runtime touches must live in a SEPARATE module even though it would tree-shake
// out of an entry: this module is a chunk SHARED with the runtime chunk, so anything the runtime
// imports from here is kept in the first-paint chunk regardless. ./policies, ./history, ./events and
// the bfcache route key all ride the idle chunk for that reason.
import type { EntryModule } from './types'

// Router-wide mutable state SHARED BY BOTH TIERS. Every field here is committed by more than one
// region (install, soft nav, popstate), so it lives on one record: a module-level `let` can only be
// reassigned inside the module that declares it. State only the runtime touches stays in ./runtime.

export const routerState = {
  // pathname+search of the URL the router last observed. A popstate that leaves both unchanged is a
  // same-document FRAGMENT traversal - Chrome fires popstate, not just hashchange, for those - and
  // treating one as a history traversal would refetch and swap the body, remounting the live tree
  // under the user's feet.
  observedLocationKey: locationKey(),
  // The route key (pathname+search) of the currently committed navigation, used
  // as the departing key on popstate (where `location` already points at the
  // target). Seeded on router init and updated at each committed navigation.
  activeRouteKey: undefined as string | undefined,
  // The entry id whose document is currently on screen. A traversal to that
  // same id — an app-level shallow pushState now carries the id forward — needs
  // no fetch and no swap: the DOM already is this entry's.
  renderedEntryId: undefined as string | undefined,
}

export function locationKey() {
  return typeof location === 'undefined' ? '' : location.pathname + location.search
}

// Installers that only the navigation runtime ever observes — compat's policy
// seams (segment cache, prefetch windows, scroll, stylesheet order). Registering
// one costs first paint a closure holding an `import()`; the facade runs them
// while the runtime chunk loads, so a policy is in place before the first fetch.
const deferredInstalls: (() => unknown)[] = []

export function registerDeferredInstall(install: () => unknown): void {
  deferredInstalls.push(install)
}

export function takeDeferredInstalls(): (() => unknown)[] {
  return deferredInstalls.splice(0)
}

// Compat-registered policy seams FIRST PAINT ITSELF READS. The rest (prefetch
// windows, loading shells, segment cache, export documents) never runs before a
// navigation, so they live in ./policies and ride the runtime chunk.

// `javascript:` URLs are a navigation-time XSS vector; the router refuses them
// at every entry point. The generic block lives in core; the user-facing
// message is framework-specific, so compat supplies a reporter/thrower.
export let blockedJsUrlReporter: ((url: string) => void) | undefined

export function setBlockedJavascriptUrlReporter(reporter: (url: string) => void) {
  blockedJsUrlReporter = reporter
}

// basePath boundary: under a configured basePath a same-origin URL OUTSIDE the
// basePath (a `basePath:false` target) must hard-navigate, not soft-swap. The
// check is a next.config concern, so compat registers it; pure core returns
// false (every same-origin URL stays soft-navigable).
export let softNavBoundary: ((url: URL) => boolean) | undefined

/** Register the compat soft-nav boundary predicate (true → hard navigate). */
export function setSoftNavBoundary(predicate: (url: URL) => boolean) {
  softNavBoundary = predicate
}

export function isJavascriptUrl(href: string) {
  // eslint-disable-next-line no-control-regex
  return /^[\u0000-\u0020]*javascript:/i.test(href)
}

/** True when the URL was a blocked javascript: URL (caller must not navigate). */
export function blockJavascriptUrl(href: string): boolean {
  if (!isJavascriptUrl(href)) return false
  if (blockedJsUrlReporter) blockedJsUrlReporter(href)
  else if (process.browser || typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('pnext:blocked-javascript-url', { detail: href }))
  }
  return true
}

// Whether a href is soft-navigable at all — the one navigation decision the
// first-paint hub has to make synchronously, before the router chunk lands.

export function resolveSoftUrl(href: string) {
  let url: URL
  try {
    url = new URL(href, location.href)
  } catch {
    return null
  }
  if (url.origin !== location.origin) return null
  // Under a configured basePath, a same-origin URL that falls OUTSIDE the
  // basePath (a `basePath:false` target) is not part of the app — it must be a
  // real browser navigation, not a soft swap. Pure core / no-basePath: never
  // outside (predicate returns false), so behavior is unchanged.
  if (softNavBoundary?.(url)) return null
  return url
}

// The synchronous half of link interception: everything a click's default
// action must be decided on before the router chunk can be awaited (modifier
// keys, target/download, javascript: block, same-origin resolution). The hub
// runs this at first paint and queues the result; the installed router runs it
// and commits immediately.

export interface LinkClickTarget {
  link: HTMLAnchorElement
  url: URL
  replace: boolean
  scroll: boolean
}

export function linkFromEvent(event: Event) {
  const target = event.target
  if (!(target instanceof Element)) return null
  return target.closest<HTMLAnchorElement>('a[data-pnext-link]')
}

/**
 * The navigation a click asks for, or null when the browser should keep the
 * click. Preventing the default action is the caller's job EXCEPT for the two
 * cases resolved entirely here: a blocked `javascript:` URL and a `replace`
 * link pointing outside the app (both return null having acted).
 */
export function linkClickTarget(event: MouseEvent): LinkClickTarget | null {
  if (event.defaultPrevented) return null
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return null
  const link = linkFromEvent(event)
  if (!link) return null
  if (link.target && link.target !== '_self') return null
  if (link.hasAttribute('download')) return null
  const href = link.getAttribute('data-pnext-blocked-href') ?? link.getAttribute('href')
  if (!href) return null
  // Refuse javascript: URLs before the browser can run them (the anchor's
  // default action is cancellable from this bubble-phase listener).
  if (blockJavascriptUrl(href)) {
    event.preventDefault()
    return null
  }
  const replace = link.getAttribute('data-pnext-replace') === 'true'
  const url = resolveSoftUrl(href)
  if (!url) {
    if (replace) {
      event.preventDefault()
      window.location.replace(href)
    }
    return null
  }
  return { link, url, replace, scroll: link.getAttribute('data-pnext-scroll') !== 'false' }
}

// Route entry modules: the cache of imported entries plus the guard that keeps
// a router-triggered import from auto-mounting into the live document.

export const entryModuleCache = new Map<string, EntryModule>()

// The document's own entry module registers itself at boot. Without this, the first history
// traversal back to the hard-loaded route pays a real import() - one task yield - and a test reading
// the DOM right after history.back() catches the DEPARTING page. With every step of the cached-entry
// restore microtask-only, the commit lands before any post-traversal task can read.
if (process.browser || typeof window !== 'undefined') {
  ;(
    window as unknown as {
      __PNEXT_REGISTER_ENTRY__?: (src: string, module: EntryModule) => void
    }
  ).__PNEXT_REGISTER_ENTRY__ = (src, module) => {
    const href = entryModuleHref(src)
    if (!entryModuleCache.has(href)) entryModuleCache.set(href, module)
  }
}

// Entries auto-mount when the browser loads them as the document's module
// script. When this router imports an entry (prefetch warmup or navigation)
// the DOM they'd mount into is not this document's, so they must not. The
// counter is only ever non-zero while a router-triggered import is in flight,
// and hard document loads can never overlap one.
export function routerImportActive() {
  return (window.__PNEXT_ROUTER_IMPORTS__ ?? 0) > 0
}

export function entryModuleHref(src: string) {
  return new URL(src, location.href).href
}
