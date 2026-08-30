import { useEffect, useState } from 'preact/hooks'
import { ReadonlyURLSearchParams, type HrefOptions } from './navigation'
import { blockJavascriptUrl, prefetchRoute, softNavigate } from '../client/router'
import { seedHistoryEntry } from '../client/router/history'
import {
  emitLocationChange,
  locationListeners,
  scheduleNavigationScroll,
} from '../client/router/events'
import { routeHref } from '../routing/href'
import type { RouteParams, RouteParamValue, RoutePath } from '../types'

export type NavigateOptions<Route extends RoutePath> = HrefOptions<Route> & {
  scroll?: boolean
}

export type PrefetchOptions<Route extends RoutePath> = HrefOptions<Route> & {
  kind?: 'auto' | 'full'
  onInvalidate?: () => void
}

export interface PNextRouter {
  push<Route extends RoutePath>(
    route: Route,
    ...options: RouteParams<Route> extends Record<string, never>
      ? [options?: NavigateOptions<Route>]
      : [options: NavigateOptions<Route>]
  ): void
  replace<Route extends RoutePath>(
    route: Route,
    ...options: RouteParams<Route> extends Record<string, never>
      ? [options?: NavigateOptions<Route>]
      : [options: NavigateOptions<Route>]
  ): void
  prefetch<Route extends RoutePath>(
    route: Route,
    ...options: RouteParams<Route> extends Record<string, never>
      ? [options?: PrefetchOptions<Route>]
      : [options: PrefetchOptions<Route>]
  ): void
  refresh(): void
  back(): void
  forward(): void
  bfcacheId: string
}

export { ReadonlyURLSearchParams }

export interface CurrentRoute<Route extends RoutePath = RoutePath> {
  route: Route | null
  pathname: string
  params: RouteParams<Route>
  searchParams: ReadonlyURLSearchParams
}

interface RouteState {
  route?: string
  params?: Record<string, RouteParamValue>
  catchAllOptional?: boolean
  staticChildren?: string[]
  bfcacheId?: string
  /** `prefetch = 'allow-runtime'`: this route's shell is request-sampled. */
  runtimePrefetch?: boolean
}

/**
 * `__PNEXT_ROUTE__.route` is stored on the wire in bracket-free colon form
 * (`/:teamSlug/:slug*`) so no `[x]`/`%5Bx%5D` placeholder ever reaches a
 * response body. The public `useRoute()` contract exposes the familiar bracket
 * pattern (`/[teamSlug]/[...slug]`), so convert back at the API boundary.
 */
function bracketRoutePattern(state: RouteState): string | null {
  const route = state.route
  if (route == null) return null
  return route
    .replace(/:([\w$]+)\*/g, state.catchAllOptional ? '[[...$1]]' : '[...$1]')
    .replace(/:([\w$]+)/g, '[$1]')
}

declare global {
  interface Window {
    __PNEXT_ROUTE__?: RouteState
    __PNEXT_HISTORY_PATCHED__?: boolean
  }
}

// This module is the reason the hard-loaded entry needs its history ids before first render:
// `bfcacheId` below reads them, and `patchHistory` carries them onto an app-level pushState. Seeding
// here rather than in the hub's installRouter keeps a page whose client graph never touches router
// state from paying for them.
seedHistoryEntry()

export function useRouter(): PNextRouter {
  return router
}

const router: PNextRouter = {
  push(route, ...[options]) {
    navigate(routerHref(route, options), 'push', options?.scroll)
  },
  replace(route, ...[options]) {
    navigate(routerHref(route, options), 'replace', options?.scroll)
  },
  prefetch(route, ...[options]) {
    void prefetchRoute(routerHref(route, options), {
      strict: true,
      full: options?.kind === 'full',
      onInvalidate: options?.onInvalidate,
    })
  },
  refresh() {
    void softNavigate(window.location.href, { replace: true, scroll: false })
  },
  back() {
    window.history.back()
  },
  forward() {
    window.history.forward()
  },
  get bfcacheId() {
    return routeState().bfcacheId ?? ''
  },
}

function routerHref<Route extends RoutePath>(
  route: Route,
  options: HrefOptions<Route> | undefined,
) {
  return hasHrefParts(options) ? routeHref(route, options) : String(route)
}

function hasHrefParts<Route extends RoutePath>(
  options: HrefOptions<Route> | undefined,
): options is HrefOptions<Route> {
  return Boolean(options && ('params' in options || 'search' in options || 'hash' in options))
}

export function usePathname() {
  return useLocation().pathname
}

export function useSearchParams(): ReadonlyURLSearchParams {
  return new ReadonlyURLSearchParams(useLocation().search)
}

export function useParams<Route extends RoutePath = RoutePath>() {
  useLocation()
  return (routeState().params ?? {}) as RouteParams<Route>
}

export function useRoute<Route extends RoutePath = RoutePath>(): CurrentRoute<Route> {
  const location = useLocation()
  return {
    route: bracketRoutePattern(routeState()) as Route | null,
    pathname: location.pathname,
    params: (routeState().params ?? {}) as RouteParams<Route>,
    searchParams: new ReadonlyURLSearchParams(location.search),
  }
}

export function useLinkStatus() {
  return { pending: false }
}

function useLocation() {
  // Read the URL live each render so any render pairs the address bar with its params;
  // state is only the re-render trigger (unchanged-URL broadcasts bail out).
  const location = currentLocation()
  const [, setLocationKey] = useState(() => locationSignature(location))

  useEffect(() => {
    patchHistory()
    const listener = () =>
      setLocationKey(previous => {
        const next = locationSignature(currentLocation())
        return previous === next ? previous : next
      })
    locationListeners().add(listener)
    // Re-read once the listener is attached: the URL can move between the
    // render that captured it and this effect (a history traversal landing
    // while a swapped-in tree mounts), and nothing was listening for that one.
    // Raw popstate is deliberately NOT a subscription source: on a full
    // traversal the address bar moves before the cached document commits, so
    // rendering that URL into the departing island can consume the only route
    // change before the persistent island is grafted into the committed tree.
    // The router broadcasts shallow traversals immediately and full traversals
    // after their DOM commit.
    listener()
    return () => locationListeners().delete(listener)
  }, [])

  return location
}

function locationSignature(location: { pathname: string; search: string; hash: string }) {
  return `${location.pathname}${location.search}${location.hash}`
}

function currentLocation() {
  if (!process.browser && typeof window === 'undefined') {
    return {
      pathname: '/',
      search: '',
      hash: '',
    }
  }
  return {
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
  }
}

function routeState() {
  if (!process.browser && typeof window === 'undefined') return {}
  const state = (history.state as Record<string, unknown> | null) ?? {}
  const routeState = window.__PNEXT_ROUTE__ ?? {}
  const bfcacheId = typeof state.__pnextBfcacheId === 'string' ? state.__pnextBfcacheId : undefined
  return bfcacheId ? ({ ...routeState, bfcacheId } as RouteState) : routeState
}

function navigate(url: string, mode: 'push' | 'replace', scroll = true) {
  if (blockJavascriptUrl(url)) return
  const next = new URL(url, window.location.href)
  if (next.origin !== window.location.origin) {
    const holder = globalThis as { __pnextMpaNavigation?: number }
    holder.__pnextMpaNavigation = (holder.__pnextMpaNavigation ?? 0) + 1
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (mode === 'replace') window.location.replace(next.href)
        else window.location.assign(next.href)
      }),
    )
    return
  }

  if (next.pathname !== window.location.pathname || next.search !== window.location.search) {
    void softNavigate(next.href, { replace: mode === 'replace', scroll })
    return
  }

  if (mode === 'replace') window.history.replaceState(history.state, '', next)
  else window.history.pushState(history.state, '', next)
  scheduleNavigationScroll(next, { scroll })
}

// Exported so compat's link-status can guarantee raw history.pushState /
// replaceState calls broadcast a location change (ending a link's pending
// state) even when no useLocation-based hook has mounted yet.
export function patchHistory() {
  if ((!process.browser && typeof window === 'undefined') || window.__PNEXT_HISTORY_PATCHED__)
    return
  window.__PNEXT_HISTORY_PATCHED__ = true
  const pushState = window.history.pushState.bind(window.history)
  const replaceState = window.history.replaceState.bind(window.history)

  // Broadcast only when the URL actually changes. The router itself calls replaceState with the
  // CURRENT href for bookkeeping - including at the start of every soft navigation - and emitting for
  // those would clear a just-clicked link's pending state.
  //
  // An app-level pushState/replaceState creates an entry that still shows THIS document (shallow
  // routing). Carrying pnext's own entry state over marks the new entry as pointing at the rendered
  // document, so a later traversal is a location broadcast rather than a fetch-and-swap of a URL that
  // may not even exist on the server. Router-initiated calls already carry the keys.
  function copyInternalState(data: unknown): unknown {
    const current = (window.history.state as Record<string, unknown> | null) ?? {}
    const carried: Record<string, unknown> = {}
    for (const key of Object.keys(current)) {
      if (key.startsWith('__pnext')) carried[key] = current[key]
    }
    if (Object.keys(carried).length === 0) return data
    const own = (data as Record<string, unknown> | null) ?? {}
    if (Object.keys(own).some(key => key.startsWith('__pnext'))) return data
    return { ...own, ...carried }
  }
  window.history.pushState = function patchedPushState(data, unused, url) {
    const before = window.location.href
    const result = pushState(copyInternalState(data), unused, url)
    if (window.location.href !== before) emitLocationChange()
    return result
  }
  window.history.replaceState = function patchedReplaceState(data, unused, url) {
    const before = window.location.href
    const result = replaceState(copyInternalState(data), unused, url)
    if (window.location.href !== before) emitLocationChange()
    return result
  }
}
