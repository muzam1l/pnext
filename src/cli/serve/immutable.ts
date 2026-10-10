import { getAssetExtensions } from '../../extensions'

export const immutableCacheControl = 'public, max-age=31536000, immutable'

/**
 * Everything the build emits under `assets/` (served at `/_next/static/*` in
 * compat) is immutable, which is the promise Next makes for that whole
 * namespace. It holds because every one of those names carries a content hash:
 * esbuild's for chunks and fonts, assetContentHash for the route entries and the
 * stylesheets (see fingerprintClientEntries / fingerprintAsset), and a build id
 * for `_next/static/<id>/_*Manifest.js`. An UNHASHED name must never reach here —
 * the same URL would answer different bytes after a deploy, and every browser
 * that saw the old ones would keep them for a year.
 *
 * Route outputs (prerendered html, handler bodies) live outside both prefixes
 * and stay revalidating; so do the app's own public/ files (manifest.publicAssets).
 */
export function immutableAssetPath(relativePath: string) {
  return immutableAssetPrefixes().some(prefix => relativePath.startsWith(prefix))
}

/** The public-relative prefixes `immutableAssetPath` covers. */
export function immutableAssetPrefixes() {
  return [
    'assets/',
    '_next/static/',
    ...getAssetExtensions()
      .staticAssetPublicPrefixes()
      .map(prefix => prefix.replace(/^\/+/, '')),
  ]
}
