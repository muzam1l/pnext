import { useContext } from 'preact/hooks'
import {
  ReadonlyURLSearchParams,
  useParams as usePNextParams,
  usePathname,
  useRouter as usePNextRouter,
  useSearchParams,
} from '../../api/client-navigation'
import {
  LayoutSegmentContext,
  type LayoutSegmentSnapshot,
  RouteParamsContext,
} from '../../render/island-context'
import { blockJavascriptUrl } from '../../client/router'
import { isUnrecognizedActionError } from '../actions/unrecognized-error'
import {
  forbidden,
  notFound,
  PNextForbiddenError,
  PNextNotFoundError,
  PNextRedirectError,
  PNextUnauthorizedError,
  unauthorized,
  type RedirectStatus,
} from '../../api/navigation'

export {
  forbidden,
  notFound,
  PNextForbiddenError,
  PNextNotFoundError,
  PNextRedirectError,
  PNextUnauthorizedError,
  unauthorized,
  ReadonlyURLSearchParams,
  usePathname,
  useSearchParams,
}
export type { RedirectStatus }

export const RedirectType = {
  push: 'push',
  replace: 'replace',
} as const

export type RedirectType = (typeof RedirectType)[keyof typeof RedirectType]

let pendingRedirectHref: string | undefined

export function redirect(location: string, type: RedirectType = RedirectType.replace): never {
  redirectInBrowser(location, type)
  return undefined as never
}

export function permanentRedirect(
  location: string,
  type: RedirectType = RedirectType.replace,
): never {
  redirectInBrowser(location, type)
  return undefined as never
}

function redirectInBrowser(location: string, mode: RedirectType) {
  if (!process.browser && typeof window === 'undefined') return

  const href = new URL(location, window.location.href).href
  if (pendingRedirectHref === href) return
  pendingRedirectHref = href
  if (mode === RedirectType.push) window.location.assign(href)
  else window.location.replace(href)
}

export interface NavigateOptions {
  scroll?: boolean
}

export interface PrefetchOptions {
  kind?: 'auto' | 'full'
  onInvalidate?: () => void
}

export interface AppRouterInstance {
  push(href: string, options?: NavigateOptions): void
  replace(href: string, options?: NavigateOptions): void
  prefetch(href: string, options?: PrefetchOptions): void
  refresh(): void
  back(): void
  forward(): void
  /**
   * React Gesture Transitions (`experimental.gestureTransition`): commit the target route OPTIMISTICALLY
   * while a gesture is still in flight, ahead of the canonical `push` the gesture's completion issues.
   * pnext has no partially-committed render state, so the optimistic commit is the same soft navigation
   * - the canonical push that follows re-renders the already current URL.
   */
  experimental_gesturePush(href: string, options?: NavigateOptions): void
  bfcacheId: string
}

// Next's useRouter returns a stable instance across renders. The wrapper is
// stateless (it delegates to core's singleton router), so build it once and
// reuse it — callers rely on referential identity (deps arrays, memoization).
let cachedRouter: AppRouterInstance | undefined
let refreshSuppressed = false

function suppressSameTickRefresh() {
  refreshSuppressed = true
  queueMicrotask(() => {
    refreshSuppressed = false
  })
}

export function useRouter(): AppRouterInstance {
  const router = usePNextRouter()
  const pathname = usePathname()
  const snapshot = useContext(LayoutSegmentContext)
  const bfcacheId = scopedBfcacheId(pathname, snapshot, router.bfcacheId)
  cachedRouter ??= {
    push: (href, options) => {
      if (blockJavascriptUrl(href)) return
      suppressSameTickRefresh()
      router.push(href as never, options as never)
    },
    replace: (href, options) => {
      if (blockJavascriptUrl(href)) return
      suppressSameTickRefresh()
      router.replace(href as never, options as never)
    },
    prefetch: (href, options) => {
      if (blockJavascriptUrl(href)) return
      router.prefetch(href as never, options as never)
    },
    refresh: () => {
      if (refreshSuppressed) return
      router.refresh()
    },
    back: () => router.back(),
    forward: () => router.forward(),
    experimental_gesturePush: (href, options) => {
      if (blockJavascriptUrl(href)) return
      suppressSameTickRefresh()
      // A gesture commits the target route optimistically: the address bar moves as soon as the gesture
      // starts, ahead of the render landing. Start the navigation FIRST (its synchronous prologue reads
      // the current location to key the departing route), as a `replace` so the entry pushed just below
      // is the one it commits into - one new history entry, showing the target URL immediately.
      router.replace(href as never, options as never)
      pushOptimisticEntry(href)
    },
    bfcacheId: '',
  }
  cachedRouter.bfcacheId = bfcacheId
  return cachedRouter
}

// The optimistic history entry a gesture push commits before its render lands.
// Same-origin only; the in-flight soft navigation replaces this entry with the
// committed one (and the patched pushState broadcasts the location change, so
// usePathname/useSearchParams see the target route right away).
function pushOptimisticEntry(href: string) {
  if (!process.browser && typeof window === 'undefined') return
  const target = new URL(href, window.location.href)
  if (target.origin !== window.location.origin) return
  if (target.href === window.location.href) return
  window.history.pushState(window.history.state, '', target.href)
}

export function useParams<
  T extends Record<string, string | string[]> = Record<string, string | string[]>,
>() {
  // An island rendered inside a parallel-route slot is stamped with the slot's
  // own params (route params + the slot's dynamic/catch-all captures) via
  // RouteParamsContext — window.__PNEXT_ROUTE__.params only carries the global
  // route params. Prefer the island-scoped snapshot when present.
  const scoped = useContext(RouteParamsContext)
  const params = usePNextParams()
  return (scoped ?? params) as T
}

interface DocumentNavState {
  children?: string
  slots?: Record<string, string>
  /** Children rendered `default.*` (Next's `__DEFAULT__`) — no selected segment. */
  childrenDefault?: boolean
}

export function useSelectedLayoutSegment(parallelRoutesKey?: string): string | null {
  const segments = clientSelectedSegments(parallelRoutesKey)
  return segments[parallelRoutesKey ? segments.length - 1 : 0] ?? null
}

export function useSelectedLayoutSegments(parallelRoutesKey?: string): string[] {
  return clientSelectedSegments(parallelRoutesKey)
}

/**
 * Client implementation of useSelectedLayoutSegment(s). A `'use client'` layout
 * hydrates as an island with no per-layout server scope; the renderer stamps it
 * with a LayoutSegmentContext snapshot (render/island-context.ts) carrying the
 * layout's `depth` plus the server-resolved segments.
 *
 * - Server render (SSR of the island): return the resolved `segments`/`slots`
 *   from the snapshot so the emitted HTML is byte-exact.
 * - Client render: recompute the suffix live from the layout `depth` and the
 *   current path. `depth` is stable for a given layout, so a shared layout's
 *   island stays correct across soft navigations even when it is preserved and
 *   merely re-rendered (usePathname subscribes, driving the recompute).
 *
 * Without a snapshot (e.g. a client PAGE island, which has no layout scope) it
 * falls back to deriving segments from the server-embedded nav state.
 */
function clientSelectedSegments(parallelRoutesKey?: string): string[] {
  usePathname()
  const snapshot = useContext(LayoutSegmentContext)

  if (!process.browser && typeof window === 'undefined') {
    if (snapshot) {
      return parallelRoutesKey ? (snapshot.slots[parallelRoutesKey] ?? []) : snapshot.segments
    }
    return []
  }

  const navState = documentNavState()
  // A defaulted children slot (Next's `__DEFAULT__`) selects nothing: the URL's
  // segments were matched by a PARALLEL slot, not by children.
  const childrenSegments = () =>
    navState.childrenDefault
      ? []
      : routePatternSegments(navState.children ?? window.location.pathname)

  if (snapshot) {
    if (parallelRoutesKey) return pathSegments(slotPath(parallelRoutesKey) ?? '')
    return childrenSegments().slice(snapshot.depth)
  }

  if (parallelRoutesKey) return pathSegments(slotPath(parallelRoutesKey) ?? '')
  return childrenSegments()
}

function routePatternSegments(pathname: string): string[] {
  const pattern = window.__PNEXT_ROUTE__?.route
  const segments = pathSegments(pathname)
  if (!pattern) return segments
  const patternSegments = pattern.split('/').filter(Boolean)
  // Colon form: a catch-all segment is `:slug*` (both `[...slug]` and
  // `[[...slug]]` collapse the trailing group the same way here).
  const catchAllIndex = patternSegments.findIndex(part => /^:[\w$]+\*$/.test(part))
  if (catchAllIndex === -1) return segments
  const head = segments.slice(0, catchAllIndex)
  const tail = segments.slice(catchAllIndex)
  return tail.length > 0 ? [...head, tail.join('/')] : head
}

function pathSegments(pathname: string): string[] {
  return pathname.split('/').filter(Boolean).map(decodeSegment)
}

function slotPath(parallelRoutesKey: string): string | undefined {
  const slotName = `@${parallelRoutesKey}`
  for (const [dir, pathname] of Object.entries(documentNavState().slots ?? {})) {
    const parts = dir.split(/[\\/]/)
    if (parts[parts.length - 1] === slotName) return pathname
  }
  return undefined
}

function documentNavState(): DocumentNavState {
  const text = document.getElementById('__PNEXT_NAV_STATE__')?.textContent
  if (!text) return {}
  try {
    return JSON.parse(text) as DocumentNavState
  } catch {
    return {}
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

// A layout's bfcacheId must stay stable across a sibling leaf navigation: the shared layout is
// preserved live, so its own form/DOM state must not reset just because the leaf below it navigated.
// The per-history-entry `baseId` changes on every path-changing push, so it cannot be part of a
// layout's key - concatenating it would make the layout's scoped id churn on every sibling nav,
// defeating the whole point of the scope. Instead the layout's id is derived purely from its own scope
// (the path segments it actually owns), stable across siblings and naturally different when the
// scope's own segment changes.
function scopedBfcacheId(pathname: string, snapshot: LayoutSegmentSnapshot | null, baseId: string) {
  if (!baseId) return ''
  if (!snapshot || snapshot.depth <= 0) return baseId
  const segments = pathname.split('/').filter(Boolean)
  if (!segments.length) return baseId
  const scope = segments.slice(0, Math.min(snapshot.depth, segments.length)).join('/')
  return scope ? `layout:${scope}` : baseId
}

export { useLinkStatus } from './link'
export { useServerInsertedHTML } from '../react/server-inserted-html'

/**
 * True for the error a server-action dispatch throws when the server no longer
 * recognizes the action id (version skew). Matches the message the pnext
 * action endpoint sends for an unknown id.
 */
export function unstable_isUnrecognizedActionError(error: unknown): boolean {
  return isUnrecognizedActionError(error)
}
