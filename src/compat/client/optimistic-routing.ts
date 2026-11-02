// Optimistic routing (Next's route-prediction trie) - COMPAT client policy.
//
// After a route pattern is learned from one URL (its prefetched/visited shell carries
// `window.__PNEXT_ROUTE__`), a navigation to a DIFFERENT URL matching the same pattern paints that
// cached loading shell instantly with the predicted params - no tree prefetch needed.
//
// Two guards keep predictions honest, both mirroring Next:
//   - `staticChildren`: literal siblings of the dynamic level. A target whose segment names a static
//     sibling must resolve on the server, since the sibling route wins over the dynamic pattern, so
//     prediction bails.
//   - rewrite detection: a shell whose OWN stored pathname does not match its route pattern was
//     produced by a rewrite. Such a response must never seed predictions - the rewrite may map a
//     sibling URL somewhere else entirely, or vary on search params.

import type { RouteParamValue } from '../../types'
import { restampSharedParams, sameParams } from './segment-cache'

interface RouteState {
  // Bracket-free colon form: `:id` for a dynamic segment, `:slug*` for a
  // catch-all; `catchAllOptional` distinguishes `[[...slug]]` (matches zero
  // segments) from `[...slug]` (requires at least one).
  route: string
  params: Record<string, RouteParamValue>
  catchAllOptional?: boolean
  staticChildren?: string[]
  staticChildrenBySegment?: Record<string, string[]>
  prefetchKind?: 'shell' | 'eager'
  /** `prefetch = 'allow-runtime'`: the shell is request-sampled PER URL. */
  runtimePrefetch?: boolean
  closedParams?: boolean
}

interface PredictedShell {
  html: string
  route: RouteState
  prefetch?: 'shell' | 'eager'
  /**
   * True when the predicted shell belongs to an `allow-runtime` route. Its content is derived from the
   * sampled request's params, so a cached shell of ONE param value says nothing about another - the
   * router must still prefetch every unseen URL of the route (a `partial` shell, being static, is shared).
   *
   * ...UNLESS `experimental.appShells` is on: there the runtime prefetch of a non-eager route renders
   * with its `params` HANGING, so the cached shell IS the route's shared App Shell and says the same
   * thing for every param. Revealing another link of the route then has nothing to fetch.
   */
  runtimePrefetch?: boolean
}

/** `experimental.appShells`, stamped into the document by register-render. */
function appShellsEnabled(): boolean {
  if (!process.browser && typeof window === 'undefined') return false
  return (window as { __PNEXT_APP_SHELLS__?: boolean }).__PNEXT_APP_SHELLS__ === true
}

export function predictNextLoadingShell(
  url: URL,
  shells: ReadonlyMap<string, string>,
): PredictedShell | undefined {
  // Most recently stored shells first (Map preserves insertion order).
  for (const [pathname, html] of [...shells.entries()].reverse()) {
    const state = routeStateFromShell(html)
    // A closed param decides whether the route exists at all: the server must resolve the URL.
    if (!state || state.closedParams) continue
    // A shell's own URL must fit its route pattern before it can teach the
    // route trie. This catches rewrites, including a dynamic response served
    // for a known static sibling.
    const storedParams = matchRoute(state, pathname)
    if (
      !storedParams ||
      (Object.keys(state.params).length > 0 && !sameParams(storedParams, state.params))
    )
      continue
    const params = matchRoute(state, url.pathname)
    if (params) {
      return {
        html: restampSharedParams(html, params),
        route: {
          route: state.route,
          params,
          ...(state.catchAllOptional ? { catchAllOptional: true } : {}),
        },
        ...(state.prefetchKind ? { prefetch: state.prefetchKind } : {}),
        ...(state.runtimePrefetch && !appShellsEnabled() ? { runtimePrefetch: true } : {}),
      }
    }
  }
  return undefined
}

function routeStateFromShell(html: string): RouteState | undefined {
  const raw = /window\.__PNEXT_ROUTE__=(\{.*?\});<\/script>/.exec(html)?.[1]
  if (!raw) return undefined
  try {
    const state = JSON.parse(raw) as RouteState
    return typeof state.route === 'string' && state.params && typeof state.params === 'object'
      ? state
      : undefined
  } catch {
    return undefined
  }
}

function matchRoute(
  state: RouteState,
  pathname: string,
): Record<string, RouteParamValue> | undefined {
  const pattern = state.route.split('/').filter(Boolean)
  const target = pathname.split('/').filter(Boolean).map(decodeSegment)
  const params: Record<string, RouteParamValue> = {}
  let cursor = 0
  for (let index = 0; index < pattern.length; index++) {
    const segment = pattern[index]!
    // Colon form: `:slug*` is a catch-all, `:id` a single dynamic segment.
    const catchAll = /^:([\w$]+)\*$/.exec(segment)
    const dynamic = catchAll ? null : /^:([\w$]+)$/.exec(segment)
    const siblingKey = String(index)
    const siblings =
      state.staticChildrenBySegment?.[siblingKey] ??
      (index === pattern.length - 1 ? state.staticChildren : undefined)
    // A dynamic trie node is usable only after the server has said its static
    // siblings are complete. This is the production-only null-vs-empty rule.
    if ((dynamic || catchAll) && siblings === undefined) return undefined
    if (siblings?.includes(target[cursor] ?? '')) return undefined
    if (catchAll) {
      const name = catchAll[1]!
      if (state.catchAllOptional) {
        // `[[...slug]]`: matches the base path plus any nested tail.
        const rest = target.slice(cursor)
        if (rest.length > 0) params[name] = rest.map(encodeURIComponent)
        return params
      }
      // `[...slug]`: a catch-all learned from a parallel slot must not predict a
      // sibling URL for the primary route. Only reuse it when the source shell
      // itself was rendered through that catch-all, and require ≥1 segment.
      if (!Array.isArray(state.params[name])) return undefined
      const rest = target.slice(cursor)
      if (rest.length === 0) return undefined
      params[name] = rest.map(encodeURIComponent)
      return params
    }
    const value = target[cursor++]
    if (value === undefined) return undefined
    if (dynamic) params[dynamic[1]!] = encodeURIComponent(value)
    else if (segment !== value) return undefined
  }
  return cursor === target.length ? params : undefined
}

function decodeSegment(segment: string) {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}
