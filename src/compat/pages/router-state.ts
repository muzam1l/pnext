// Pages-router SSR state (COMPAT). The materialized page wrappers call pagesRouterSsrState() with their
// pages-route pattern and resolved params; the resulting state (pattern pathname, canonical asPath,
// merged query) is stashed on the anchored per-request scope so the next/router shim - which SSRs the
// page component from a separately compiled bundle - returns the values Next's useRouter() would. The
// wrapper also serializes the state into a `<script type="application/json">` node so the browser-side
// shim reads the same values after hydration and after soft navigations.

import type { RouteParamValue } from '../../types'

export interface PagesRouterSsrState {
  /** Pages-route pattern, e.g. `/blog/[slug]`. */
  pathname: string
  /** The as-requested URL (path + original search), pre-rewrite. */
  asPath: string
  /** Rewrite-destination search params merged with dynamic route params. */
  query: Record<string, string | string[]>
}

const STATE_KEY = Symbol.for('pnext.pagesRouterState')
const REQUEST_STORAGE = Symbol.for('pnext.requestStorage')
const WORK_UNIT_STORAGE = Symbol.for('pnext.workUnitStorage')
const CANONICAL_URL_KEY = Symbol.for('pnext.compat.navigation.canonicalUrl')

interface StorageLike {
  getStore(): Record<PropertyKey, unknown> | undefined
}

// All reads go through the globalThis-anchored storages (never module-local
// imports): the wrapper bundle, the router shim bundle, and core each carry
// their own compiled copy of this module, and only the anchored instances are
// shared between them.
function anchoredScope(key: symbol): Record<PropertyKey, unknown> | undefined {
  const storage = (globalThis as Record<PropertyKey, unknown>)[key] as StorageLike | undefined
  return storage?.getStore?.()
}

function currentRequestUrl(): string | undefined {
  const scope = anchoredScope(REQUEST_STORAGE)
  const request = scope?.request as { url?: string } | undefined
  return typeof request?.url === 'string' ? request.url : undefined
}

function canonicalHref(): string | undefined {
  const unit = anchoredScope(WORK_UNIT_STORAGE)
  const compat = unit?.compat as Record<symbol, unknown> | undefined
  const value = compat?.[CANONICAL_URL_KEY]
  return typeof value === 'string' ? value : undefined
}

/**
 * Compute and stash the pages-router state for the active render. `pattern` is the pages-route pattern
 * the materializer knows statically; `params` the resolved dynamic params. Query mirrors Next: the
 * (rewrite-destination) request search merged with the route params, params winning. asPath is the
 * canonical URL the browser asked for - its own search, never a rewrite's.
 */
export function pagesRouterSsrState(
  pattern: string,
  params: Record<string, RouteParamValue> | undefined,
): PagesRouterSsrState {
  const requestUrl = currentRequestUrl()
  const canonical = canonicalHref() ?? requestUrl
  const query: Record<string, string | string[]> = {}
  if (requestUrl) {
    for (const [key, value] of new URL(requestUrl).searchParams) {
      // The router-fetch cache key rides soft-navigation request URLs; it is
      // never part of the page's query.
      if (key !== '_rsc') query[key] = value
    }
  }
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) query[key] = value
  }
  let asPath = pattern
  if (canonical) {
    const url = new URL(canonical)
    asPath = `${url.pathname}${url.search}`
  }
  const state: PagesRouterSsrState = { pathname: pattern, asPath, query }
  const scope = anchoredScope(REQUEST_STORAGE)
  if (scope) scope[STATE_KEY] = state
  return state
}

/** The state stashed by the active render's page wrapper, if any. */
export function currentPagesRouterState(): PagesRouterSsrState | undefined {
  const scope = anchoredScope(REQUEST_STORAGE)
  const state = scope?.[STATE_KEY]
  return state ? (state as PagesRouterSsrState) : undefined
}

/** Serialize state for the inline JSON node (script-safe: `<` escaped). */
export function serializePagesRouterState(state: PagesRouterSsrState): string {
  return JSON.stringify(state).replace(/</g, '\\u003c')
}
