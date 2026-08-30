import type { PrefetchMode, RouteParamValue } from '../types'

export type SearchValue = string | number | boolean | null | undefined
export type SearchInput = URLSearchParams | Record<string, SearchValue | SearchValue[]>

export interface HrefParts {
  params?: Record<string, RouteParamValue>
  search?: SearchInput
  hash?: string
}

/**
 * A request for pnext's own build output: `/assets/*`, and next-compat's `/_next/static/*` - the
 * same output under the path Next serves it from (see assetPathname). Every bypass that must not
 * treat build output as a page (proxy, trailing-slash canonicalization) asks HERE, so moving the
 * emitted prefix can never leave a bypass knowing only the old one.
 */
export function isBuildAssetPathname(pathname: string) {
  return pathname.startsWith('/assets/') || pathname.startsWith('/_next/static/')
}

export function routeHref(route: string, options: HrefParts = {}) {
  const path = applyTrailingSlash(fillParams(route, options.params ?? {}))
  const search = searchString(options.search)
  const hash = hashString(options.hash)
  return `${path}${search}${hash}`
}

declare global {
  interface Window {
    __PNEXT_TRAILING_SLASH__?: boolean
    __PNEXT_PREFETCH__?: PrefetchMode
  }
  var __PNEXT_TRAILING_SLASH__: boolean | undefined
  var __PNEXT_PREFETCH__: PrefetchMode | undefined
}

// With `trailingSlash: true` the server 308s bare page URLs to their slashed
// form; Links render the canonical (slashed) href directly, like Next. Set
// once per process by the server runtime from the resolved config. On the
// client the value is read from the injected window global (register-render's
// trailingSlashScript), mirroring basePath / skipTrailingSlash.
// Anchored on globalThis, not a module local: this module is dual-copied into
// the client/prebundled bundles, where setTrailingSlashUrls never runs.
export function setTrailingSlashUrls(enabled: boolean) {
  globalThis.__PNEXT_TRAILING_SLASH__ = enabled
}

function isTrailingSlashEnabled(): boolean {
  if (process.browser || typeof window !== 'undefined')
    return window.__PNEXT_TRAILING_SLASH__ === true
  return globalThis.__PNEXT_TRAILING_SLASH__ === true
}

export function getTrailingSlashUrls() {
  return isTrailingSlashEnabled()
}

// The app-wide default prefetch mode (config `prefetch`), for links that set
// none of their own. Isomorphic like the trailing-slash seam: the server sets it
// from the resolved config, the client reads the injected window global
// (renderer's prefetchModeScript).
export function setDefaultPrefetchMode(mode: PrefetchMode | undefined) {
  globalThis.__PNEXT_PREFETCH__ = mode
}

export function getDefaultPrefetchMode(): PrefetchMode {
  const mode =
    process.browser || typeof window !== 'undefined'
      ? window.__PNEXT_PREFETCH__
      : globalThis.__PNEXT_PREFETCH__
  return mode === undefined ? 'visible' : mode
}

// The configured basePath ('' when unset). Set once per process by the server
// runtime from the resolved config (registerServerRuntime), mirroring the
// trailing-slash seam. Core render code (metadata) reads it through
// withBasePath so file-convention asset hrefs (og-image, manifest) carry the
// prefix without a compat/next.config import in core.
let basePathPrefix = ''

export function setBasePathPrefix(value: string) {
  basePathPrefix = value
}

export function getBasePathPrefix() {
  return basePathPrefix
}

/**
 * Prefix a root-relative in-app path with the configured basePath (Next's
 * addBasePath). Absolute/protocol-relative URLs, non-root-relative strings, and
 * paths already under the basePath are returned unchanged. A no-basePath app is
 * always a no-op. Any query/hash on the path rides along untouched.
 */
export function withBasePath(path: string) {
  const base = basePathPrefix
  if (!base) return path
  if (!path.startsWith('/') || path.startsWith('//')) return path
  if (path === base || path.startsWith(`${base}/`)) return path
  return `${base}${path}`
}

export function applyTrailingSlash(pathname: string) {
  const [, path = '', rest = ''] = /^([^?#]*)([\s\S]*)$/.exec(pathname) ?? []
  if (!path.startsWith('/')) return pathname
  if (isTrailingSlashEnabled()) {
    // Add the canonical trailing slash (skip root, already-slashed, and files).
    if (path === '/' || path.endsWith('/') || /\.[^/]+$/.test(path)) return pathname
    return `${path}/${rest}`
  }
  // trailingSlash:false — Next strips a trailing slash from hrefs so the anchor
  // matches the canonical (unslashed) form and avoids a 308 on click. Root and
  // file paths (`/a.txt/` is not a thing) are left alone.
  if (path === '/' || !path.endsWith('/') || /\.[^/]+\/$/.test(path)) return pathname
  return `${path.replace(/\/+$/, '')}${rest}`
}

function fillParams(route: string, params: Record<string, RouteParamValue>) {
  const filled = route
    // Optional catch-all `[[...slug]]` must be matched before the plain
    // catch-all form so its doubled brackets aren't mis-parsed.
    .replace(/\[\[\.\.\.([^\]]+)\]\]/g, (_match, key: string) => encodeParam(params[key], true))
    .replace(/\[\.\.\.([^\]]+)\]/g, (_match, key: string) => encodeParam(params[key], true))
    .replace(/\[([^\]]+)\]/g, (_match, key: string) => encodeParam(params[key], false))
  // An absent optional catch-all (`[[...slug]]`) leaves a dangling `/`; drop it
  // so /docs/:slug* with no params yields /docs, not /docs/.
  return collapseTrailingSlash(filled)
}

function collapseTrailingSlash(pathname: string) {
  if (pathname.length <= 1) return pathname
  return pathname.replace(/\/+$/, '') || '/'
}

function encodeParam(value: RouteParamValue | undefined, catchAll: boolean) {
  if (Array.isArray(value)) {
    const encoded = value.map(segment => encodeURIComponent(segment))
    return catchAll ? encoded.join('/') : (encoded[0] ?? '')
  }
  return encodeURIComponent(value ?? '')
}

function searchString(search: SearchInput | undefined) {
  if (!search) return ''
  const params = search instanceof URLSearchParams ? search : objectSearchParams(search)
  const value = params.toString()
  return value ? `?${value}` : ''
}

function objectSearchParams(search: Record<string, SearchValue | SearchValue[]>) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(search)) {
    const values = Array.isArray(value) ? value : [value]
    for (const item of values) {
      if (item == null) continue
      params.append(key, String(item))
    }
  }
  return params
}

function hashString(hash: string | undefined) {
  if (!hash) return ''
  return hash.startsWith('#') ? hash : `#${hash}`
}

/**
 * Malformed percent-encoding in the request path (e.g. `/%2`, a lone `%` or an
 * out-of-range escape) is a 400 "Bad Request" before any routing, matching
 * Next. Returns the response when the path cannot be decoded, else null.
 */
export function malformedUrlResponse(request: Request): Response | null {
  let pathname: string
  try {
    pathname = new URL(request.url).pathname
  } catch {
    return new Response('Bad Request', { status: 400 })
  }
  if (!pathname.includes('%')) return null
  try {
    decodeURIComponent(pathname)
    return null
  } catch {
    return new Response('Bad Request', { status: 400 })
  }
}

/**
 * The canonical form of `pathname` under the given `trailingSlash` setting:
 * with it on, a bare page path gains a trailing slash; with it off, a slashed
 * path loses it. Root (`/`) and file-ish paths (an extension in the last
 * segment) are always left untouched. Returns the pathname unchanged when it is
 * already canonical.
 */
export function canonicalTrailingSlashPath(pathname: string, trailingSlash: boolean): string {
  if (pathname === '/' || pathname === '') return pathname
  if (/\.[^/]+$/.test(pathname)) return pathname
  const slashed = pathname.endsWith('/')
  if (trailingSlash ? slashed : !slashed) return pathname
  return trailingSlash ? `${pathname.replace(/\/+$/, '')}/` : pathname.replace(/\/+$/, '') || '/'
}

/**
 * Next-style trailing-slash normalization: with `trailingSlash: true` page
 * URLs 308-redirect to their slashed form; with it off (the default) slashed
 * URLs redirect to the bare form. File-ish paths (extensions) and internal
 * paths are untouched. Returns null when the URL is already canonical.
 */
export function trailingSlashRedirect(
  config: { trailingSlash?: boolean; skipTrailingSlashRedirect?: boolean },
  url: URL,
  method: string,
): Response | null {
  // skipTrailingSlashRedirect: the app serves both slashed and unslashed URLs
  // as-is, so no canonical redirect is ever emitted (route matching already
  // tolerates a trailing slash via normalizePathname).
  if (config.skipTrailingSlashRedirect) return null
  if (method !== 'GET' && method !== 'HEAD') return null
  const pathname = url.pathname
  if (pathname === '/' || pathname === '') return null
  if (pathname.startsWith('/__pnext') || isBuildAssetPathname(pathname)) return null
  const target = canonicalTrailingSlashPath(pathname, Boolean(config.trailingSlash))
  if (target === pathname) return null
  return new Response(null, {
    status: 308,
    headers: { location: `${target}${url.search}` },
  })
}
