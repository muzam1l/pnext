export {
  forbidden,
  notFound,
  PNextForbiddenError,
  PNextNotFoundError,
  PNextRedirectError,
  PNextUnauthorizedError,
  unauthorized,
} from '../../api/navigation'
import {
  permanentRedirect as pnextPermanentRedirect,
  PNextForbiddenError,
  PNextNotFoundError,
  PNextRedirectError,
  PNextUnauthorizedError,
  ReadonlyURLSearchParams,
  redirect as pnextRedirect,
} from '../../api/navigation'
import { isPostpone, PostponeError } from '../../render/postpone'
import { currentParams, currentRequest } from '../../request/context'
import { useContext } from 'preact/hooks'
import {
  currentLayoutSegments,
  currentParamsSnapshot,
  hasLayoutSegmentScope,
} from '../../render/slots'
import {
  CsrBailoutContext,
  LayoutSegmentContext,
  RouteParamsContext,
} from '../../render/island-context'
import { canonicalUrlHref } from './canonical-url'
import { isUnrecognizedActionError } from '../actions/unrecognized-error'
import { stripBasePath } from '../client/base-path'
import { addBasePath } from '../client/base-path'
import type { CurrentRoute, PNextRouter } from '../../api/client-navigation'
import type { RouteParams, RoutePath } from '../../types'

export type { RedirectStatus } from '../../api/navigation'
export type { CurrentRoute, PNextRouter } from '../../api/client-navigation'
export { ReadonlyURLSearchParams }

export const RedirectType = {
  push: 'push',
  replace: 'replace',
} as const

export type RedirectType = (typeof RedirectType)[keyof typeof RedirectType]

export function redirect(location: string, type?: RedirectType): never {
  try {
    // Next prefixes a root-relative redirect target with basePath; absolute URLs (including same-host
    // targets outside the basePath) are left as-is. Normalizing here means every downstream consumer -
    // the page-GET redirect response and the server-action redirect envelope - sees a basePath-space
    // location uniformly.
    pnextRedirect(addBasePath(location))
  } catch (error) {
    // Server actions honor push/replace history semantics on the client;
    // carry the requested type on the control-flow error.
    if (type && error instanceof PNextRedirectError) {
      ;(error as PNextRedirectError & { redirectType?: RedirectType }).redirectType = type
    }
    throw error
  }
}

export function permanentRedirect(location: string, _type?: RedirectType): never {
  pnextPermanentRedirect(addBasePath(location))
}

/** Rethrow framework control-flow errors so user catch blocks don't swallow them. */
export function unstable_rethrow(error: unknown): void {
  if (
    error instanceof PNextRedirectError ||
    error instanceof PNextNotFoundError ||
    error instanceof PNextForbiddenError ||
    error instanceof PNextUnauthorizedError ||
    isPostpone(error)
  ) {
    throw error
  }
}

const serverRouter: PNextRouter = {
  push: () => undefined,
  replace: () => undefined,
  prefetch: () => undefined,
  refresh: () => undefined,
  back: () => undefined,
  forward: () => undefined,
  bfcacheId: '',
}

export function useRouter(): PNextRouter {
  return serverRouter
}

export function usePathname() {
  return stripBasePath(currentUrl().pathname)
}

export function useSearchParams(): ReadonlyURLSearchParams {
  if (useContext(CsrBailoutContext) && isStaticCsrBailout()) {
    throw new PostponeError('useSearchParams')
  }
  return new ReadonlyURLSearchParams(currentUrl().search)
}

function isStaticCsrBailout(): boolean {
  const storage = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for('pnext.csrBailoutStorage')
  ] as { getStore?: () => boolean | undefined } | undefined
  return storage?.getStore?.() === true
}

export function useParams<Route extends RoutePath = RoutePath>() {
  return resolveParams() as RouteParams<Route>
}

/**
 * A SERVER component inside a parallel-route slot runs within the slot's params scope (route params plus
 * the slot's own dynamic/catch-all captures), so read it directly. A `'use client'` component in a slot
 * is SSR'd as an island, rendered to string OUTSIDE that scope, so it falls back to the
 * RouteParamsContext the renderer provides around the island - matching what the client re-provides at
 * mount. Otherwise the global route params apply. useContext is safe because the context branch only
 * runs during a preact render.
 */
function resolveParams(): Record<string, string | string[]> {
  const scope = currentParamsSnapshot()
  if (scope) return scope
  // Island SSR (a `'use client'` component in a slot) reads the snapshot from
  // the RouteParamsContext the renderer wraps around it. useContext is only
  // valid inside a preact render; a plain server component resolved by direct
  // call has no hook context, so guard it and fall back to the global params.
  try {
    const snapshot = useContext(RouteParamsContext)
    if (snapshot) return snapshot
  } catch {
    // not in a preact render — fall through to global route params
  }
  return currentParams()
}

export function useRoute<Route extends RoutePath = RoutePath>(): CurrentRoute<Route> {
  const url = currentUrl()
  return {
    route: null,
    pathname: url.pathname,
    params: resolveParams() as RouteParams<Route>,
    searchParams: new ReadonlyURLSearchParams(url.search),
  }
}

export function useSelectedLayoutSegment(parallelRoutesKey?: string): string | null {
  const segments = selectedLayoutSegments(parallelRoutesKey)
  return segments[parallelRoutesKey ? segments.length - 1 : 0] ?? null
}

export function useSelectedLayoutSegments(parallelRoutesKey?: string): string[] {
  // A defensive copy so callers can't mutate the render-scoped array.
  return [...selectedLayoutSegments(parallelRoutesKey)]
}

/**
 * A SERVER component in a layout runs inside the layout-segment scope, so read it directly. A
 * `'use client'` layout is SSR'd as an island, rendered to string OUTSIDE that scope, so it falls back
 * to the LayoutSegmentContext the renderer provides around the island - matching what the client
 * re-provides at mount. useContext is safe: the no-scope branch only runs during a preact render.
 */
function selectedLayoutSegments(parallelRoutesKey?: string): string[] {
  if (hasLayoutSegmentScope()) return currentLayoutSegments(parallelRoutesKey)
  const snapshot = useContext(LayoutSegmentContext)
  if (!snapshot) return []
  return parallelRoutesKey ? (snapshot.slots[parallelRoutesKey] ?? []) : snapshot.segments
}

export function useLinkStatus() {
  return { pending: false }
}

/**
 * The canonical (as-requested) URL for the active render. After a rewrite the
 * request URL is the destination, so hooks that must reflect what the browser
 * asked for read the recorded canonical URL first (see canonical-url.ts).
 */
function currentUrl() {
  return new URL(canonicalUrlHref() ?? currentRequest()?.url ?? 'http://pnext.local/')
}

/**
 * True for the error a server-action dispatch throws when the server no longer
 * recognizes the action id (version skew). Matches the message the pnext
 * action endpoint sends for an unknown id.
 */
export function unstable_isUnrecognizedActionError(error: unknown): boolean {
  return isUnrecognizedActionError(error)
}

// CSS-in-JS SSR insertion hook (Next exports it from next/navigation).
export { useServerInsertedHTML } from '../react/server-inserted-html'
