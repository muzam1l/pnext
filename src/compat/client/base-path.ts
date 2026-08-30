// Client basePath helpers (COMPAT - ships to the browser).
//
// The server injects `window.__PNEXT_BASE_PATH__` when `next.config.basePath` is set. The core router
// treats every same-origin URL as soft-navigable, but under a basePath an absolute same-host URL
// *outside* the basePath (a `basePath:false` rewrite target, say) must be a real MPA navigation, not a
// soft swap. These helpers give the core router that boundary check without a next.config dependency.
//
// Core reads them through a registered hook. A pure-core app never sets the global, so basePath() is ''
// and every same-origin URL stays soft-navigable exactly as before.

declare global {
  interface Window {
    __PNEXT_BASE_PATH__?: string
  }
  var __PNEXT_BASE_PATH__: string | undefined
}

/**
 * The configured basePath ('' when unset). Isomorphic: the client reads the
 * `window` global the server injects (register-render basePathScript); the
 * server reads the `globalThis` global set when next.config is loaded
 * (config-loader setNextConfig). Neither branch imports the esbuild-backed
 * config loader, so this stays safe to ship to the browser.
 */
export function basePath(): string {
  if (process.browser || typeof window !== 'undefined') return window.__PNEXT_BASE_PATH__ ?? ''
  return globalThis.__PNEXT_BASE_PATH__ ?? ''
}

/**
 * Prefix a root-relative in-app path with the configured basePath (Next's
 * addBasePath). Absolute URLs, protocol-relative URLs, non-root-relative
 * strings, and paths already under the basePath are returned unchanged. A
 * no-basePath app is always a no-op.
 */
export function addBasePath(path: string): string {
  const base = basePath()
  if (!base) return path
  if (!path.startsWith('/') || path.startsWith('//')) return path
  if (path === '/') return base
  if (path === base || path.startsWith(`${base}/`)) return path
  return `${base}${path}`
}

/** Strip the configured basePath prefix from an in-app path (inverse of addBasePath). */
export function stripBasePath(path: string): string {
  const base = basePath()
  if (!base) return path
  if (path === base) return '/'
  if (path.startsWith(`${base}/`)) return path.slice(base.length)
  return path
}

/**
 * True when `url` is same-origin but falls outside the configured basePath - i.e. the router must
 * hard-navigate to it (a `basePath:false` target). Always false when no basePath is configured.
 */
export function isOutsideBasePath(url: URL): boolean {
  const base = basePath()
  if (!base) return false
  if ((process.browser || typeof window !== 'undefined') && url.origin !== window.location.origin)
    return false
  const path = url.pathname
  return path !== base && !path.startsWith(`${base}/`)
}
