// Client trailing-slash helper (COMPAT - ships to the browser). Mirrors compat/client/base-path.ts.
//
// The server injects `window.__PNEXT_SKIP_TRAILING_SLASH__` when `next.config.skipTrailingSlashRedirect`
// is set; the server render path reads the globalThis global set when next.config is loaded. With the
// flag on, Link hrefs and client navigation preserve the author's exact trailing slash instead of
// normalizing it. A pure-core app never sets the global, so hrefs go through the usual normalization.

declare global {
  interface Window {
    __PNEXT_SKIP_TRAILING_SLASH__?: boolean
  }
  var __PNEXT_SKIP_TRAILING_SLASH__: boolean | undefined
}

/**
 * True when `skipTrailingSlashRedirect` is configured. Isomorphic: the client
 * reads the `window` global the render layer injects; the server reads the
 * `globalThis` global set when next.config loads. Neither branch imports the
 * esbuild-backed config loader, so this stays safe to ship to the browser.
 */
export function skipTrailingSlashRedirect(): boolean {
  if (process.browser || typeof window !== 'undefined')
    return window.__PNEXT_SKIP_TRAILING_SLASH__ === true
  return globalThis.__PNEXT_SKIP_TRAILING_SLASH__ === true
}
