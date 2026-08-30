// Builds a Next-shaped route-types manifest from pnext's route entries, an
// independent scan of app-dir layouts/slots and the pages/ directory, plus the
// redirects/rewrites from next.config. Feeds the Next-identical codegen in
// ./typegen.ts. Compat-only.
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import type { ResolvedConfig } from '../../config'
import type { RouteManifestEntry } from '../../types'
import { toPosixPath } from '../../utils/fs'

/** path-to-regexp group info, mirroring Next's `getRouteRegex().groups`. */
export interface Group {
  pos: number
  repeat: boolean
  optional: boolean
}

export interface ManifestRouteInfo {
  path: string
  groups: Record<string, Group>
}

export interface RouteTypesManifest {
  appRoutes: Record<string, ManifestRouteInfo>
  pageRoutes: Record<string, ManifestRouteInfo>
  layoutRoutes: Record<string, ManifestRouteInfo & { slots: string[] }>
  appRouteHandlerRoutes: Record<string, ManifestRouteInfo>
  redirectRoutes: Record<string, ManifestRouteInfo>
  rewriteRoutes: Record<string, ManifestRouteInfo>
  appPagePaths: Set<string>
  pagesRouterPagePaths: Set<string>
  layoutPaths: Set<string>
  appRouteHandlers: Set<string>
  pageApiRoutes: Set<string>
  filePathToRoute: Map<string, string>
}

const PAGE_EXTENSIONS = ['tsx', 'ts', 'jsx', 'js', 'mdx', 'md']
const LAYOUT_NAMES = new Set(PAGE_EXTENSIONS.map(ext => `layout.${ext}`))

function isGroupSegment(name: string): boolean {
  return name.startsWith('(') && name.endsWith(')')
}

function isSlotSegment(name: string): boolean {
  return name.startsWith('@')
}

function decodeLiteral(segment: string): string {
  return segment.replace(/%5[Ff]/g, '_')
}

/** Extract groups (param name -> shape) from a bracket-syntax route. */
function groupsFromBracketRoute(route: string): Record<string, Group> {
  const groups: Record<string, Group> = {}
  let pos = 1
  for (const segment of route.split('/').filter(Boolean)) {
    const optionalCatchAll = /^\[\[\.\.\.(.+)\]\]$/.exec(segment)
    if (optionalCatchAll?.[1]) {
      groups[optionalCatchAll[1]] = { pos: pos++, repeat: true, optional: true }
      continue
    }
    const catchAll = /^\[\.\.\.(.+)\]$/.exec(segment)
    if (catchAll?.[1]) {
      groups[catchAll[1]] = { pos: pos++, repeat: true, optional: false }
      continue
    }
    const param = /^\[(.+)\]$/.exec(segment)
    if (param?.[1]) {
      groups[param[1]] = { pos: pos++, repeat: false, optional: false }
    }
  }
  return groups
}

/**
 * Turn a pnext `route` (`:param` / `:param*` form, groups already stripped and
 * `%5F` decoded) plus its catch-all flags into Next bracket syntax.
 */
function bracketRouteFromEntry(entry: RouteManifestEntry): string {
  const segments = entry.route
    .split('/')
    .filter(Boolean)
    .map(segment => {
      const catchAll = /^:(.+)\*$/.exec(segment)
      if (catchAll?.[1]) {
        const name = catchAll[1]
        return name === entry.catchAll && entry.catchAllOptional ? `[[...${name}]]` : `[...${name}]`
      }
      const param = /^:(.+)$/.exec(segment)
      if (param?.[1]) return `[${param[1]}]`
      return segment
    })
  return `/${segments.join('/')}`.replace(/\/$/, '') || '/'
}

/** Bracket route derived from a directory path relative to app/ (for layouts). */
function bracketRouteFromDir(relativeDir: string): string {
  const segments: string[] = []
  for (const segment of relativeDir.split('/').filter(Boolean)) {
    if (isGroupSegment(segment) || isSlotSegment(segment)) continue
    if (/^\[\[?\.\.\..+\]\]?$/.test(segment) || /^\[.+\]$/.test(segment)) {
      segments.push(segment)
    } else {
      segments.push(decodeLiteral(segment))
    }
  }
  return `/${segments.join('/')}`.replace(/\/$/, '') || '/'
}

function pagesRouteFromRelative(relative: string): string {
  const withoutExt = relative.replace(/\.[^.]+$/, '')
  const trimmed = withoutExt.replace(/\/index$/, '').replace(/^index$/, '')
  const route = `/${trimmed}`.replace(/\/$/, '') || '/'
  return route
}

async function walkFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walkFiles(full)))
    else out.push(full)
  }
  return out
}

/**
 * A private app segment (`_foo`, but not `%5F`-encoded or a group/slot) makes
 * the whole route non-routable.
 */
function isPrivate(relativeDir: string): boolean {
  return relativeDir
    .split('/')
    .some(seg => seg.startsWith('_') && !isGroupSegment(seg) && !isSlotSegment(seg))
}

// path-to-regexp custom-route source -> bracket routes. The fixture only uses
// `:name`, `:name+`, `:name*`; other modifiers/patterns are skipped like Next.
function convertCustomRouteSource(source: string): string[] {
  const normalized = source.startsWith('/') ? source : `/${source}`
  const converted = normalized
    .split('/')
    .map(segment => {
      const optional = /^:(.+)\*$/.exec(segment)
      if (optional?.[1]) return `[[...${optional[1]}]]`
      const catchAll = /^:(.+)\+$/.exec(segment)
      if (catchAll?.[1]) return `[...${catchAll[1]}]`
      const param = /^:([A-Za-z0-9_]+)$/.exec(segment)
      if (param?.[1]) return `[${param[1]}]`
      return segment
    })
    .join('/')
  return [converted.replace(/\/$/, '') || '/']
}

interface CustomRoute {
  source: string
}
type RedirectsFn = () => Promise<CustomRoute[]> | CustomRoute[]
type RewritesFn = () =>
  | Promise<
      | CustomRoute[]
      | { beforeFiles?: CustomRoute[]; afterFiles?: CustomRoute[]; fallback?: CustomRoute[] }
    >
  | CustomRoute[]
  | { beforeFiles?: CustomRoute[]; afterFiles?: CustomRoute[]; fallback?: CustomRoute[] }

export interface BuildManifestInput {
  config: ResolvedConfig
  routes: RouteManifestEntry[]
  nextConfig: { redirects?: unknown; rewrites?: unknown }
}

export async function buildRouteTypesManifest({
  config,
  routes,
  nextConfig,
}: BuildManifestInput): Promise<RouteTypesManifest> {
  const relApp = (file: string) => toPosixPath(path.relative(config.root, file))
  const isHybrid = config.appPath.includes('pnext-pages-compat')
  const sourceAppPath = (entry: RouteManifestEntry): string | undefined => {
    if (!isHybrid) return entry.file
    const basename = entry.kind === 'page' ? /^page\.(?:tsx?|jsx?|mdx?)$/ : /^route\.(?:tsx?|jsx?)$/
    const source = entry.sourceFiles.find(file => {
      const normalized = toPosixPath(file)
      return normalized.includes('/source-app/') && basename.test(path.basename(normalized))
    })
    if (!source) return undefined
    const relative = toPosixPath(source).split('/source-app/')[1]
    return relative ? path.join(config.root, 'app', relative) : undefined
  }

  const manifest: RouteTypesManifest = {
    appRoutes: {},
    pageRoutes: {},
    layoutRoutes: {},
    appRouteHandlerRoutes: {},
    redirectRoutes: {},
    rewriteRoutes: {},
    appPagePaths: new Set(),
    pagesRouterPagePaths: new Set(),
    layoutPaths: new Set(),
    appRouteHandlers: new Set(),
    pageApiRoutes: new Set(),
    filePathToRoute: new Map(),
  }

  // App pages + route handlers from pnext's scanned entries. Skip synthetic /
  // interception entries (typegen resolves interceptors to their canonical page
  // which is already scanned). When in hybrid mode (app + pages), config.appPath
  // points at a generated compat directory containing wrappers for both app and
  // pages. For typegen we only want original app routes in AppRoutes, not pages
  // wrappers which belong in PageRoutes.
  const hybridFilteredRoutes = isHybrid
    ? routes.filter(entry => {
        const file = entry.file
        if (!file.includes('pnext-pages-compat')) return true
        const sourceFiles = (entry as { sourceFiles?: string[] }).sourceFiles ?? []
        const isPagesWrapper = sourceFiles.some(sf => sf.includes('source-pages'))
        if (isPagesWrapper) return false
        return true
      })
    : routes

  for (const entry of hybridFilteredRoutes) {
    if (entry.synthetic || entry.interception || entry.metadataRoute) continue
    const source = sourceAppPath(entry)
    if (!source) continue
    const bracket = bracketRouteFromEntry(entry)
    const rel = relApp(source)
    const info: ManifestRouteInfo = { path: rel, groups: groupsFromBracketRoute(bracket) }
    if (entry.kind === 'page') {
      if (!manifest.appRoutes[bracket]) manifest.appRoutes[bracket] = info
      // appPagePaths/filePathToRoute (the validator inputs) are populated by an independent filesystem scan
      // below, NOT from runtime entries: pnext's scanner collapses parallel-route slot pages onto a single
      // representative route entry, which mis-maps a slot page's route and drops its siblings, breaking the
      // generated validator's tsc.
    } else {
      if (!manifest.appRouteHandlerRoutes[bracket]) manifest.appRouteHandlerRoutes[bracket] = info
      manifest.appRouteHandlers.add(rel)
      manifest.filePathToRoute.set(rel, bracket)
    }
  }

  // Layouts + slots: independent app-dir scan (pnext entries don't carry them).
  const appFiles = await walkFiles(isHybrid ? path.join(config.root, 'app') : config.appPath)
  const appPath = isHybrid ? path.join(config.root, 'app') : config.appPath
  for (const file of appFiles) {
    const relative = toPosixPath(path.relative(appPath, file))
    const base = path.basename(relative)
    if (!LAYOUT_NAMES.has(base)) continue
    const dir = path.dirname(relative) === '.' ? '' : path.dirname(relative)
    if (isPrivate(dir)) continue
    const bracket = bracketRouteFromDir(dir)
    const rel = relApp(file)
    if (!manifest.layoutRoutes[bracket]) {
      manifest.layoutRoutes[bracket] = {
        path: rel,
        groups: groupsFromBracketRoute(bracket),
        slots: [],
      }
    }
    manifest.layoutPaths.add(rel)
    manifest.filePathToRoute.set(rel, bracket)
  }

  // Slots: `@name` dirs whose nearest ancestor layout owns them. A path can
  // pass through multiple slot dirs (e.g. `@modal/(.)test-nested/@sidebar`);
  // the slot that owns a given file is the deepest (last) one on the path,
  // not the first, since the layout receiving the prop lives directly under it.
  for (const file of appFiles) {
    const relative = toPosixPath(path.relative(appPath, file))
    const segments = relative.split('/')
    let slotIndex = -1
    for (let i = segments.length - 1; i >= 0; i--) {
      if (isSlotSegment(segments[i]!)) {
        slotIndex = i
        break
      }
    }
    if (slotIndex === -1) continue
    const slotName = segments[slotIndex]!.slice(1)
    const ownerDir = segments.slice(0, slotIndex).join('/')
    if (isPrivate(ownerDir)) continue
    const ownerRoute = bracketRouteFromDir(ownerDir)
    const layout = manifest.layoutRoutes[ownerRoute]
    if (layout && !layout.slots.includes(slotName)) layout.slots.push(slotName)
  }

  // App pages for the validator: an independent filesystem scan of every `page.{ext}` (including
  // parallel-route slot pages), each mapped to its dir-derived route with group/slot segments stripped.
  // Next validates each page file's `default` export against `AppPageConfig<its-route>`; a slot page like
  // `dashboard/@analytics/page.tsx` renders at `/dashboard`, so it must validate against `/dashboard`.
  // Guarded to routes that are actually routable, so private and interception pages are excluded - the
  // AppPageConfig<Route> constraint requires `Route extends AppRoutes`.
  const PAGE_BASENAMES = new Set(PAGE_EXTENSIONS.map(ext => `page.${ext}`))
  for (const file of appFiles) {
    const relative = toPosixPath(path.relative(appPath, file))
    if (!PAGE_BASENAMES.has(path.basename(relative))) continue
    const dir = path.dirname(relative) === '.' ? '' : path.dirname(relative)
    if (isPrivate(dir)) continue
    const route = bracketRouteFromDir(dir)
    if (!manifest.appRoutes[route]) continue
    const rel = relApp(file)
    manifest.appPagePaths.add(rel)
    manifest.filePathToRoute.set(rel, route)
  }

  // Pages Router: pages/*.{ext} (non-api) -> pageRoutes; pages/api/** -> pageApiRoutes.
  const pagesDir = path.join(config.root, 'pages')
  for (const file of await walkFiles(pagesDir)) {
    const relative = toPosixPath(path.relative(pagesDir, file))
    if (!PAGE_EXTENSIONS.some(ext => relative.endsWith(`.${ext}`))) continue
    const base = path.basename(relative)
    if (base.startsWith('_app.') || base.startsWith('_document.') || base.startsWith('_error.')) {
      continue
    }
    const rel = relApp(file)
    const isApi = relative === 'api' || relative.startsWith('api/')
    const route = pagesRouteFromRelative(relative)
    if (isApi) {
      manifest.pageApiRoutes.add(rel)
      manifest.filePathToRoute.set(rel, route)
    } else {
      manifest.pageRoutes[route] = { path: rel, groups: groupsFromBracketRoute(route) }
      manifest.pagesRouterPagePaths.add(rel)
      manifest.filePathToRoute.set(rel, route)
    }
  }

  // redirects / rewrites from next.config.
  const redirects = nextConfig.redirects
  if (typeof redirects === 'function') {
    const list = await (redirects as RedirectsFn)()
    for (const item of list ?? []) {
      for (const route of convertCustomRouteSource(item.source)) {
        manifest.redirectRoutes[route] = { path: route, groups: groupsFromBracketRoute(route) }
      }
    }
  }

  const rewrites = nextConfig.rewrites
  if (typeof rewrites === 'function') {
    const result = await (rewrites as RewritesFn)()
    const sources = Array.isArray(result)
      ? result
      : [...(result?.beforeFiles ?? []), ...(result?.afterFiles ?? []), ...(result?.fallback ?? [])]
    for (const item of sources) {
      for (const route of convertCustomRouteSource(item.source)) {
        manifest.rewriteRoutes[route] = { path: route, groups: groupsFromBracketRoute(route) }
      }
    }
  }

  return manifest
}
