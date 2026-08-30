import path from 'node:path'
import { safeDecode } from '../utils/decode'
import { readDirListing, toPosixPath } from '../utils/fs'
import type { InterceptionMarker, RouteParamValue } from '../types'

// Parallel-route (@slot) and intercepting-route ((.)segment) tree matching.
// Slot content resolves at request time against the filesystem: the app source
// tree is present in dev and production alike (start imports source modules),
// so matching walks directories directly instead of precomputing every slot
// combination into the manifest.

const pageExtensions = ['tsx', 'ts', 'jsx', 'js', 'mjs'] as const

const interceptionMarkers: InterceptionMarker[] = ['(..)(..)', '(...)', '(..)', '(.)']
const interceptionLevels: Record<InterceptionMarker, number> = {
  '(.)': 0,
  '(..)': 1,
  '(..)(..)': 2,
  '(...)': Number.POSITIVE_INFINITY,
}

export function interceptionMarkerOf(segment: string): InterceptionMarker | undefined {
  return interceptionMarkers.find(
    marker => segment.startsWith(marker) && segment.length > marker.length,
  )
}

export function interceptionMarkerLevels(marker: InterceptionMarker) {
  return interceptionLevels[marker]
}

export function isSlotSegment(name: string) {
  return name.startsWith('@')
}

export function isGroupSegment(name: string) {
  return name.startsWith('(') && name.endsWith(')') && !interceptionMarkerOf(name)
}

/** Nearest existing `<base>.<ext>` convention file in `dir`. */
export function slotConventionFile(dir: string, base: string) {
  const { files } = readDirListing(dir)
  for (const extension of pageExtensions) {
    if (files.has(`${base}.${extension}`)) return path.join(dir, `${base}.${extension}`)
  }
  return undefined
}

function childDirectories(dir: string) {
  return readDirListing(dir).dirs
}

/** `@slot` directories directly inside `dir`. */
export function slotDirectoriesIn(dir: string) {
  return childDirectories(dir)
    .filter(isSlotSegment)
    .map(name => path.join(dir, name))
}

/**
 * URL segments consumed by walking from `appPath` to `dir` (both absolute).
 * Group and @slot directories consume nothing; `[param]` consumes one segment;
 * a catch-all consumes the rest (represented as Infinity). Interception marker
 * directories count as their bare segment (correct for `(.)`; deeper markers
 * shift the mapping and are not supported for slot resolution below them).
 */
export function consumedSegments(appPath: string, dir: string) {
  const relative = path.relative(appPath, dir)
  if (relative.startsWith('..')) return 0
  let consumed = 0
  for (const name of relative.split(path.sep).filter(Boolean)) {
    if (isGroupSegment(name) || isSlotSegment(name)) continue
    const marker = interceptionMarkerOf(name)
    const bare = marker ? name.slice(marker.length) : name
    if (/^\[\[?\.\.\./.test(bare)) return Number.POSITIVE_INFINITY
    consumed += 1
  }
  return consumed
}

export interface SegmentMatch {
  /**
   * The matched page file. Absent for a pageless match - a fully-consumed path that still has a layout or
   * parallel slots to render, Next's implicit null children inside intercepted units.
   */
  file?: string
  /** Directories entered from (excluding) the start dir to the page's dir. */
  dirs: string[]
  /** Params captured while matching (decoded). */
  params: Record<string, RouteParamValue>
}

interface MatchOptions {
  /** Enter interception marker dirs as if they were their bare segment. */
  markersAsSegments?: boolean
}

/**
 * Match URL `segments` against the children tree rooted at `dir`. Specificity:
 * a page at the exact depth, then literal children, then group dirs
 * (transparent), then `[param]`, then `[...catchAll]`, then `[[...opt]]`.
 */
export function matchSegments(
  dir: string,
  segments: string[],
  options: MatchOptions = {},
  params: Record<string, RouteParamValue> = {},
  dirs: string[] = [],
): SegmentMatch | null {
  const children = childDirectories(dir)
  const groups = children.filter(isGroupSegment)

  if (segments.length === 0) {
    const page = slotConventionFile(dir, 'page')
    if (page) return { file: page, dirs, params }
    for (const group of groups) {
      const match = matchSegments(path.join(dir, group), [], options, params, [...dirs, group])
      if (match) return match
    }
    for (const name of children) {
      const param = optionalCatchAllName(bareName(name, options))
      if (!param) continue
      const match = matchSegments(path.join(dir, name), [], options, { ...params, [param]: [] }, [
        ...dirs,
        name,
      ])
      if (match) return match
    }
    // Inside an intercepted unit a fully-consumed path may have no page yet
    // still render: a layout (or parallel slots) with implicit null children.
    if (
      options.markersAsSegments &&
      (slotConventionFile(dir, 'layout') || children.some(isSlotSegment))
    ) {
      return { dirs, params }
    }
    return null
  }

  const [head, ...rest] = segments as [string, ...string[]]

  // Literal segment.
  for (const name of children) {
    if (bareName(name, options) !== head) continue
    const match = matchSegments(path.join(dir, name), rest, options, params, [...dirs, name])
    if (match) return match
  }

  // Route groups are transparent at this level.
  for (const group of groups) {
    const match = matchSegments(path.join(dir, group), segments, options, params, [...dirs, group])
    if (match) return match
  }

  // Dynamic `[param]`.
  for (const name of children) {
    const param = dynamicParamName(bareName(name, options))
    if (!param) continue
    const match = matchSegments(
      path.join(dir, name),
      rest,
      options,
      { ...params, [param]: safeDecode(head) },
      [...dirs, name],
    )
    if (match) return match
  }

  // `[...catchAll]` and `[[...opt]]` consume everything remaining.
  for (const name of children) {
    const bare = bareName(name, options)
    const param = catchAllName(bare) ?? optionalCatchAllName(bare)
    if (!param) continue
    const match = matchSegments(
      path.join(dir, name),
      [],
      options,
      { ...params, [param]: segments.map(safeDecode) },
      [...dirs, name],
    )
    if (match) return match
  }

  return null
}

function bareName(name: string, options: MatchOptions) {
  if (isSlotSegment(name)) return '\0'
  const marker = interceptionMarkerOf(name)
  if (!marker) return name
  return options.markersAsSegments ? name.slice(marker.length) : '\0'
}

function dynamicParamName(name: string) {
  const match = /^\[([^\].]+)\]$/.exec(name)
  return match?.[1]
}

function catchAllName(name: string) {
  const match = /^\[\.\.\.([^\]]+)\]$/.exec(name)
  return match?.[1]
}

function optionalCatchAllName(name: string) {
  const match = /^\[\[\.\.\.([^\]]+)\]\]$/.exec(name)
  return match?.[1]
}

/**
 * The children fallback for a URL whose page is provided by a parallel slot:
 * walk the children tree along `segments` while directories exist, returning
 * the deepest `default.*` seen. Missing default means the children slot
 * renders nothing (Next's implicit null default).
 */
export function childrenDefaultFile(dir: string, segments: string[]): string | undefined {
  let current = dir
  let best = slotConventionFile(current, 'default')
  for (const segment of segments) {
    const next = childSegmentDir(current, segment)
    if (!next) break
    current = next
    best = slotConventionFile(current, 'default') ?? best
  }
  return best
}

function childSegmentDir(dir: string, segment: string): string | undefined {
  const children = childDirectories(dir)
  if (children.includes(segment)) return path.join(dir, segment)
  for (const group of children.filter(isGroupSegment)) {
    const nested = childSegmentDir(path.join(dir, group), segment)
    if (nested) return nested
  }
  const dynamic = children.find(name => dynamicParamName(name))
  if (dynamic) return path.join(dir, dynamic)
  return undefined
}

export interface InterceptorUnit {
  /** The marker directory (absolute). Content below renders when intercepted. */
  dir: string
  /** Route-style target prefix segments from the app root (e.g. `['groups', ':id', 'new']`). */
  targetSegments: string[]
  /** Regex source matching the target prefix (no anchors). */
  targetPattern: string
  /** Params captured by targetPattern, in group order. */
  params: { name: string; catchAll: boolean }[]
  /** The final target token is a catch-all (consumes every remaining segment). */
  catchAllTail: boolean
}

/**
 * Interception marker directories inside a slot tree, with their full-path
 * target prefixes resolved against the slot's owner path. Only top-level
 * marker units are returned: markers nested under another marker resolve as
 * plain segments during `matchSegments({ markersAsSegments: true })`.
 */
export function slotInterceptorUnits(appPath: string, slotDir: string): InterceptorUnit[] {
  const owner = routeTokensForDir(appPath, path.dirname(slotDir))
  if (!owner) return []
  const units: InterceptorUnit[] = []
  collectInterceptorUnits(slotDir, owner, [], units)
  return units
}

interface RouteToken {
  route: string
  pattern: string
  param?: string
  catchAll?: boolean
}

function collectInterceptorUnits(
  dir: string,
  owner: RouteToken[],
  inner: RouteToken[],
  units: InterceptorUnit[],
) {
  for (const name of childDirectories(dir)) {
    const child = path.join(dir, name)
    if (isSlotSegment(name) || isGroupSegment(name)) {
      collectInterceptorUnits(child, owner, inner, units)
      continue
    }
    const marker = interceptionMarkerOf(name)
    if (marker) {
      const bare = name.slice(marker.length)
      const levels = interceptionLevels[marker]
      const context = [...owner, ...inner]
      const kept =
        levels === Number.POSITIVE_INFINITY
          ? []
          : context.slice(0, Math.max(0, context.length - levels))
      const target = [...kept, segmentToken(bare)]
      units.push({
        dir: child,
        targetSegments: target.map(token => token.route),
        targetPattern: target.map(token => token.pattern).join('/'),
        params: target
          .filter(token => token.param)
          .map(token => ({ name: token.param!, catchAll: Boolean(token.catchAll) })),
        catchAllTail: Boolean(target[target.length - 1]?.catchAll),
      })
      continue
    }
    collectInterceptorUnits(child, owner, [...inner, segmentToken(name)], units)
  }
}

/**
 * Route tokens (URL-contributing segments) for a directory under the app
 * root; groups and @slots contribute nothing; markers resolve their levels.
 * Returns undefined when the dir is outside the app root.
 */
export function routeTokensForDir(appPath: string, dir: string): RouteToken[] | undefined {
  const relative = path.relative(appPath, dir)
  if (relative.startsWith('..')) return undefined
  let tokens: RouteToken[] = []
  for (const name of toPosixPath(relative).split('/').filter(Boolean)) {
    if (isGroupSegment(name) || isSlotSegment(name)) continue
    const marker = interceptionMarkerOf(name)
    if (marker) {
      const levels = interceptionLevels[marker]
      tokens =
        levels === Number.POSITIVE_INFINITY
          ? []
          : tokens.slice(0, Math.max(0, tokens.length - levels))
      tokens.push(segmentToken(name.slice(marker.length)))
      continue
    }
    tokens.push(segmentToken(name))
  }
  return tokens
}

function segmentToken(name: string): RouteToken {
  const optional = optionalCatchAllName(name)
  if (optional) return { route: `:${optional}*`, pattern: '(.*)', param: optional, catchAll: true }
  const catchAll = catchAllName(name)
  if (catchAll) return { route: `:${catchAll}*`, pattern: '(.*)', param: catchAll, catchAll: true }
  const param = dynamicParamName(name)
  if (param) return { route: `:${param}`, pattern: '([^/]+)', param }
  return { route: name, pattern: escapeRegex(name) }
}

/**
 * Try to match `pathname` against a slot's interceptor units: the unit's
 * target prefix must match the head of the pathname and the remainder must
 * resolve to a page inside the marker directory (markers below the unit are
 * treated as plain segments).
 */
export function matchSlotInterceptor(
  appPath: string,
  slotDir: string,
  pathname: string,
): SegmentMatch | null {
  const segments = pathnameSegments(pathname)
  const markerOwner = markerOwnerTokens(appPath, slotDir)
  if (markerOwner) {
    const params = matchTargetTokens(markerOwner, pathname)
    if (params) {
      const rest = markerOwner.at(-1)?.catchAll ? [] : segments.slice(markerOwner.length)
      const inner = matchSegments(slotDir, rest, { markersAsSegments: true }, params, [])
      if (inner) return inner
    }
  }
  // Specificity: non-catch-all first, deeper targets first, fewer dynamic
  // params first (a literal `(.)foo` beats `(.)[param]` for /foo).
  const units = slotInterceptorUnits(appPath, slotDir).sort(
    (a, b) =>
      Number(a.catchAllTail) - Number(b.catchAllTail) ||
      b.targetSegments.length - a.targetSegments.length ||
      a.params.length - b.params.length,
  )
  for (const unit of units) {
    const regex = new RegExp(`^/${unit.targetPattern}(?:/(.*))?$`)
    const match = regex.exec(pathname.replace(/\/+$/, '') || '/')
    if (!match) continue
    const params: Record<string, RouteParamValue> = {}
    unit.params.forEach((param, index) => {
      const value = match[index + 1] ?? ''
      params[param.name] = param.catchAll
        ? value.split('/').filter(Boolean).map(safeDecode)
        : safeDecode(value)
    })
    const rest = unit.catchAllTail ? [] : segments.slice(unit.targetSegments.length)
    const inner = matchSegments(unit.dir, rest, { markersAsSegments: true }, params, [])
    if (inner) {
      return {
        file: inner.file,
        dirs: [path.basename(unit.dir), ...inner.dirs],
        params: inner.params,
      }
    }
  }
  return null
}

function markerOwnerTokens(appPath: string, slotDir: string): RouteToken[] | null {
  const relative = path.relative(appPath, slotDir)
  if (relative.startsWith('..')) return null
  const segments = toPosixPath(relative).split('/').filter(Boolean)
  const markerIndex = segments.findIndex(segment => Boolean(interceptionMarkerOf(segment)))
  if (markerIndex === -1) return null
  return (
    routeTokensForDir(appPath, path.join(appPath, ...segments.slice(0, markerIndex + 1))) ?? null
  )
}

function matchTargetTokens(
  tokens: RouteToken[],
  pathname: string,
): Record<string, RouteParamValue> | null {
  const pattern = tokens.map(token => token.pattern).join('/')
  const regex = new RegExp(`^/${pattern}(?:/.*)?$`)
  const match = regex.exec(pathname.replace(/\/+$/, '') || '/')
  if (!match) return null
  const params: Record<string, RouteParamValue> = {}
  tokens
    .filter(token => token.param)
    .forEach((token, index) => {
      const value = match[index + 1] ?? ''
      params[token.param!] = token.catchAll
        ? value.split('/').filter(Boolean).map(safeDecode)
        : safeDecode(value)
    })
  return params
}

export function pathnameSegments(pathname: string) {
  return pathname.split('?')[0]!.split('/').filter(Boolean)
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
