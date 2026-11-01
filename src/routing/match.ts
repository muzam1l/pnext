/**
 * Request-time routing: matching a pathname against the built route table and finding an app
 * directory's convention files. The route scan that builds the table lives in `./routes`.
 */
import path from 'node:path'
import { readDirListing, toPosixPath } from '../utils/fs'
import { canonicalSegment, safeDecode } from '../utils/decode'
import { extraPageExtensions, getRoutingExtensions } from '../extensions'
import type { NavState, RouteManifestEntry, RouteParamValue } from '../types'

const BASE_PAGE_EXTENSIONS = ['tsx', 'ts', 'jsx', 'js', 'mjs'] as const

/** Base + compat-registered page extensions, de-duplicated in order. */
export function pageExtensions(): string[] {
  return [...new Set([...BASE_PAGE_EXTENSIONS, ...extraPageExtensions()])]
}

const globalErrorBase = 'global-error'

/** Nearest existing file named `<base>.<ext>` for the convention extensions. */
export function conventionFileName(dir: string, base: string) {
  const { files } = readDirListing(dir)
  for (const extension of pageExtensions()) {
    if (files.has(`${base}.${extension}`)) return path.join(dir, `${base}.${extension}`)
  }
  return undefined
}

export function findLayouts(appPath: string, routeFilePath: string) {
  return findConventionFiles(appPath, routeFilePath, 'layout')
}

/**
 * Walk from the route's directory up to `appPath`, returning one convention file per segment ordered
 * root-to-leaf. `name` may be a bare base (`'layout'`) or carry an extension - a known extension is stripped
 * so the full extension list is tried. Each segment resolves to the first existing `<base>.<ext>`; when none
 * exists the `.tsx` candidate is returned so existing callers that filter by `existsSync` keep
 * byte-identical behavior.
 */
export function findConventionFiles(appPath: string, routeFilePath: string, name: string) {
  const base = conventionBase(name)
  const files: string[] = []
  let dir = path.dirname(routeFilePath)

  while (dir.startsWith(appPath)) {
    files.push(conventionFileName(dir, base) ?? path.join(dir, `${base}.tsx`))
    if (dir === appPath) break
    dir = path.dirname(dir)
  }

  return files.reverse()
}

function conventionBase(name: string) {
  const match = new RegExp(`\\.(${pageExtensions().join('|')})$`).exec(name)
  return match ? name.slice(0, -match[0].length) : name
}

/** App-root `global-error.*` file, if present (BuildManifest.globalErrorFile). */
export function findGlobalError(appPath: string) {
  return conventionFileName(appPath, globalErrorBase)
}

export function matchRoute(routes: RouteManifestEntry[], pathname: string, headers?: Headers) {
  // Trailing-slash tolerance: '/route/' matches the same entry as '/route'
  // (Next redirects these away; static file serving already accepts both).
  const normalized = normalizePathname(pathname)
  for (const route of routes) {
    // Interception entries never match a plain (hard) request; they apply
    // only through matchInterception on soft navigations.
    if (route.interception) continue
    const match = routeRegex(route).exec(normalized)
    if (!match) continue
    const params = routeMatchParams(route, match)
    if (!getRoutingExtensions().admitRoute(route, params, headers)) continue
    return { route, params }
  }
  return null
}

export function normalizePathname(pathname: string) {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') || '/' : pathname
}

function routeMatchParams(route: RouteManifestEntry, match: RegExpExecArray) {
  // Page params keep their canonical encoded form; handlers read decoded values.
  const value = route.kind === 'handler' ? safeDecode : canonicalSegment
  const params: Record<string, RouteParamValue> = {}
  route.params.forEach((name, index) => {
    params[name] = value(match[index + 1] ?? '')
  })
  if (route.catchAll) {
    const values = (match[route.params.length + 1] ?? '').split('/').filter(Boolean)
    if (values.length > 0 || !route.catchAllOptional) {
      params[route.catchAll] = values.map(value)
    }
  }
  return params
}

export interface InterceptionRouteMatch {
  route: RouteManifestEntry
  params: Record<string, RouteParamValue>
}

/**
 * Match a soft navigation against interception entries: the entry's target
 * pattern must match the destination and the navigation must originate at or
 * below the interceptor's base (the children path the current document
 * rendered from). The deepest base wins. A no-op when destination equals the
 * origin (a refresh re-renders whatever produced the current document).
 */
export function matchInterception(
  routes: RouteManifestEntry[],
  pathname: string,
  fromPath: string | undefined,
  headers?: Headers,
): InterceptionRouteMatch | null {
  if (!fromPath) return null
  const target = normalizePathname(pathname)
  const from = normalizePathname(fromPath)
  if (target === from) return null
  let best: InterceptionRouteMatch | null = null
  let bestDepth = -1
  for (const route of routes) {
    const interception = route.interception
    if (!interception) continue
    const match = routeRegex(route).exec(target)
    if (!match) continue
    const basePattern = interception.basePattern ? `/${interception.basePattern}` : ''
    if (!new RegExp(`^${basePattern}(?:/.*)?$`).test(from)) continue
    const depth = interception.base.split('/').filter(Boolean).length
    if (depth <= bestDepth) continue
    const params = routeMatchParams(route, match)
    if (!getRoutingExtensions().admitRoute(route, params, headers)) continue
    bestDepth = depth
    best = { route, params }
  }
  return best
}

export interface RouteRenderSelection {
  route: RouteManifestEntry
  params: Record<string, RouteParamValue>
  /** Pathname the children tree renders from (normalized). */
  childrenPath: string
  /** Internal pathname after rewrites, used to resolve interception slots. */
  targetPath: string
}

/**
 * Pick the entry a page request renders. Hard requests match plainly. Soft navigations first consult
 * interception entries; a slot interception (and a synthetic slot URL reached with known origin) renders the
 * ORIGIN's entry as host - the current page stays while the slot content changes - with the children tree
 * anchored at `childrenPath`.
 */
export function selectRouteForRequest(
  routes: RouteManifestEntry[],
  pathname: string,
  nav?: import('../types').NavState,
  headers?: Headers,
): RouteRenderSelection | null {
  const target = normalizePathname(pathname)
  if (nav) {
    const intercepted = matchInterception(routes, target, nav.children, headers)
    if (intercepted) {
      if (!intercepted.route.interception?.slotDir) {
        return {
          route: intercepted.route,
          params: intercepted.params,
          childrenPath: target,
          targetPath: target,
        }
      }
      const host = hostMatch(routes, nav.children)
      if (host) return { ...host, targetPath: target }
    }
  }
  const matched = matchRoute(routes, target, headers)
  if (!matched) return null
  if (nav && matched.route.synthetic && nav.children) {
    const primary = matchRoute(
      routes.filter(route => !route.synthetic),
      target,
      headers,
    )
    const syntheticOwner = matched.route.syntheticSlotDir
      ? path.dirname(matched.route.syntheticSlotDir)
      : undefined
    const primaryFromOwner =
      primary && syntheticOwner ? path.relative(syntheticOwner, primary.route.file) : undefined
    if (
      primary &&
      primaryFromOwner !== undefined &&
      primaryFromOwner !== '..' &&
      !primaryFromOwner.startsWith(`..${path.sep}`)
    ) {
      return {
        route: primary.route,
        params: primary.params,
        childrenPath: target,
        targetPath: target,
      }
    }
    const host = hostMatch(routes, nav.children)
    if (
      host &&
      host.route !== matched.route &&
      matched.route.syntheticSlotDir &&
      host.route.slotDirs?.includes(matched.route.syntheticSlotDir)
    ) {
      return { ...host, targetPath: target }
    }
  }
  return {
    route: matched.route,
    params: matched.params,
    childrenPath: target,
    targetPath: target,
  }
}

/**
 * Navigation headers from the client soft-nav runtime: `x-pnext-soft-nav`
 * marks the fetch and `x-pnext-nav-state` carries the current document's
 * parallel-route state (URI-encoded JSON).
 */
export function parseNavState(request: Pick<Request, 'headers'>): NavState | undefined {
  if (!request.headers.get('x-pnext-soft-nav')) return undefined
  const raw = request.headers.get('x-pnext-nav-state')
  if (!raw) return {}
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as unknown
    if (parsed && typeof parsed === 'object') return parsed
  } catch {
    // Malformed state degrades to a plain soft navigation.
  }
  return {}
}

function hostMatch(
  routes: RouteManifestEntry[],
  fromPath: string | undefined,
): RouteRenderSelection | null {
  if (!fromPath) return null
  const from = normalizePathname(fromPath)
  const host = matchRoute(routes, from)
  if (host?.route.kind !== 'page') return null
  return { route: host.route, params: host.params, childrenPath: from, targetPath: from }
}

const routeRegexCache = new WeakMap<RouteManifestEntry, RegExp>()

function routeRegex(route: RouteManifestEntry) {
  let regex = routeRegexCache.get(route)
  if (!regex) {
    regex = new RegExp(`^${route.pattern}$`)
    routeRegexCache.set(route, regex)
  }
  return regex
}

export function serverActionsUnsupportedMessage(offender: {
  file: string
  route?: string
  root?: string
}) {
  const file = offender.root
    ? toPosixPath(path.relative(offender.root, offender.file))
    : offender.file
  const reach = offender.route ? `, reachable from the route ${offender.route}` : ''
  return [
    `Server actions need next compat, and this app is pure core.`,
    ``,
    `  ${file} has a 'use server' directive${reach}.`,
    ``,
    `pnext will not build this app: core has no server-action registry and no`,
    `dispatch endpoint, so the action could only render as a form that submits`,
    `nowhere.`,
    ``,
    `Fix it one of two ways:`,
    `  1. Enable compat in pnext.config.ts:`,
    `       export default { compat: { next: true } }`,
    `  2. Or delete the 'use server' directive from ${file}, if those exports are`,
    `     only ever called on the server (in core the directive does nothing).`,
  ].join('\n')
}
