// Optimistic-routing route state (COMPAT - may import core freely).
//
// Next's client router builds a route-prediction trie from visited routes; a dynamic segment's trie node
// records its STATIC SIBLINGS (literal segments at the same URL level) so a prediction never shadows a
// static route. pnext ships the same information inline: the `__PNEXT_ROUTE__` state of a rendered
// document carries `staticChildren` - the literal sibling names at the route's deepest dynamic level.
//
// Siblings are computed from the ROUTE MANIFEST in URL space, which is what makes the Next-parity cases
// fall out for free: route groups collapse, parallel-route slot pages appear via their synthetic slot
// URLs, and page-less intermediate directories still surface as static children without leaking their
// nested names.

import type { RouteManifestEntry, RouteParamValue } from '../../types'
import { getRequestRuntime } from '../../routing/request-environment'
import { getNextConfig } from './config-loader'

interface RouteState {
  route: string
  params: Record<string, RouteParamValue>
  catchAllOptional?: boolean
  staticChildren?: string[]
  staticChildrenBySegment?: Record<string, string[]>
  prefetchKind?: 'shell' | 'eager'
  /**
   * `prefetch = 'allow-runtime'`: the route's shell is RUNTIME-prefetched (request-sampled,
   * param-derived), so unlike a static `partial` shell it is NOT shared across params - every URL of the
   * route needs its own prefetch.
   */
  runtimePrefetch?: boolean
  /**
   * The vary set of the BAKED SHELL these bytes came from (renderer's
   * `bakedShellPageVary`). Passed straight through by the spread below: the
   * client segment cache reads it off a hard-loaded document to key that
   * document's static stage across the route's params.
   */
  pageVary?: string[]
}

/**
 * `route.route` pattern segments in the client's bracket-free colon form (`:id`, `:slug*`). Both the
 * manifest routes and the embedded `__PNEXT_ROUTE__` state use this encoding, so siblings computed here
 * align with the pattern the client trie matches against - and no `[x]` placeholder ever reaches a body.
 */
function publicSegments(route: string): string[] {
  if (route === 'index' || route === '/') return []
  return route.split('/').filter(Boolean)
}

function isDynamicSegment(segment: string): boolean {
  return segment.startsWith(':')
}

/**
 * Literal sibling names at the deepest level of `pattern` (the level its dynamic/catch-all tail owns).
 * A manifest route contributes the literal it places at that level when its leading segments are
 * compatible with the pattern's prefix - literal-vs-literal must match, and a dynamic segment on either
 * side matches anything. Over-collecting is safe: it only suppresses a prediction that then falls back
 * to the server.
 */
export function staticSiblingNames(
  routes: readonly Pick<RouteManifestEntry, 'route' | 'kind' | 'interception'>[],
  pattern: readonly string[],
): string[] {
  for (let index = pattern.length - 1; index >= 0; index--) {
    if (isDynamicSegment(pattern[index]!)) return staticSiblingNamesAt(routes, pattern, index)
  }
  return []
}

/** Literal static siblings for every dynamic level in a route prediction. */
export function staticSiblingNamesBySegment(
  routes: readonly Pick<RouteManifestEntry, 'route' | 'kind' | 'interception'>[],
  pattern: readonly string[],
): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  for (let index = 0; index < pattern.length; index++) {
    if (!isDynamicSegment(pattern[index]!)) continue
    const siblings = staticSiblingNamesAt(routes, pattern, index)
    // An empty array is meaningful: unlike an absent entry, it says this
    // production route table knows there are no literal siblings here.
    result[String(index)] = siblings
  }
  return result
}

function staticSiblingNamesAt(
  routes: readonly Pick<RouteManifestEntry, 'route' | 'kind' | 'interception'>[],
  pattern: readonly string[],
  level: number,
): string[] {
  if (!isDynamicSegment(pattern[level]!)) return []
  const names = new Set<string>()
  for (const route of routes) {
    if (route.kind !== 'page' || route.interception) continue
    const segments = publicSegments(route.route)
    if (segments.length <= level) continue
    let compatible = true
    for (let index = 0; index < level; index++) {
      const own = pattern[index]!
      const other = segments[index]!
      if (isDynamicSegment(own) || isDynamicSegment(other)) continue
      if (own !== other) {
        compatible = false
        break
      }
    }
    if (!compatible) continue
    const name = segments[level]!
    if (!isDynamicSegment(name)) names.add(name)
  }
  return [...names].sort()
}

/** True when the build enumerated exactly this param set for the route. */
function paramsPrerendered(
  route: Pick<RouteManifestEntry, 'prerenderedParams' | 'params'>,
  params: Record<string, RouteParamValue>,
): boolean {
  const sets = route.prerenderedParams
  if (!sets?.length) return false
  // A PPR SUB-shell carries only the params the build made concrete (the rest
  // are still holes), so its state is not the full URL's — never "prerendered".
  if (Object.keys(params).length !== (route.params ?? []).length) return false
  return sets.some(set => {
    const names = Object.keys(set)
    return (
      names.length === Object.keys(params).length &&
      names.every(name => String(set[name]) === String(params[name]))
    )
  })
}

/**
 * Enrich the client route state of a rendered document with the static
 * siblings of every dynamic segment. Reads the route table from the
 * request runtime (published by start/dev handlers and by the build's
 * prerender pass); without one the state passes through unchanged and the
 * client simply never predicts (safe fallback).
 */
export function nextClientRouteState(
  route: Pick<
    RouteManifestEntry,
    | 'route'
    | 'file'
    | 'hasStaticParams'
    | 'usesRequest'
    | 'segmentConfig'
    | 'prerenderedParams'
    | 'params'
    | 'stream'
  >,
  state: RouteState,
): RouteState {
  const pattern = state.route.split('/').filter(Boolean)
  const routes = getRequestRuntime()?.routes
  if (!routes) return state
  const staticChildrenBySegment = staticSiblingNamesBySegment(routes, pattern)
  const staticChildren = staticSiblingNames(routes, pattern)
  // Global `partialPrefetching: 'unstable_eager'` makes every route without a
  // per-segment `prefetch` export eager (the App Shells Speculative-skip does
  // not apply anywhere); a per-segment export still wins.
  const globalEager =
    (getNextConfig() as { partialPrefetching?: unknown }).partialPrefetching === 'unstable_eager'
  const declared = route.segmentConfig?.prefetch
  // `generateStaticParams` only makes a route eager for the param sets it actually enumerated. When
  // THIS URL's params were not among them and the route has a `loading` boundary, its page is dynamic
  // here - the server answers the default prefetch with the loading shell, and calling it eager would
  // escalate the reveal to a FULL prefetch that fetches the dynamic body and erases the loading state.
  const partiallyEnumerated =
    route.stream?.hasLoadingBoundary === true && !paramsPrerendered(route, state.params)
  const prefetchKind =
    declared === 'unstable_eager' ||
    (declared === undefined &&
      (globalEager || (route.hasStaticParams && !route.usesRequest && !partiallyEnumerated)))
      ? 'eager'
      : declared === 'allow-runtime' || declared === 'partial'
        ? 'shell'
        : undefined
  return {
    ...state,
    ...(staticChildren.length > 0 ? { staticChildren } : {}),
    ...(Object.keys(staticChildrenBySegment).length > 0 ? { staticChildrenBySegment } : {}),
    ...(prefetchKind ? { prefetchKind } : {}),
    // Only `allow-runtime` shells are request-sampled per URL; a `partial` shell
    // is a static prerender the whole route shares.
    ...(declared === 'allow-runtime' ? { runtimePrefetch: true } : {}),
  }
}
