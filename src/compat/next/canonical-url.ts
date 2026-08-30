// Canonical (as-requested) URL tracking for next/navigation hooks (COMPAT).
//
// After a config or middleware rewrite, the downstream render sees the DESTINATION URL (the rewrite
// mutates the forwarded request's URL). But Next's usePathname()/useSearchParams() must return the
// CANONICAL URL the browser asked for. This module stashes that original URL on the per-request work
// unit so the SSR hooks can return it.
//
// The setter is invoked from the rewrite observer: when a same-origin rewrite fires, the original URL is
// remembered here. When nothing sets it, the hooks fall back to the request URL.

import { getWorkUnit } from '../../request/context'

const CANONICAL_URL_KEY = Symbol.for('pnext.compat.navigation.canonicalUrl')

/**
 * Record the canonical (original, as-requested) URL for the active request,
 * before a rewrite replaces it with the destination. A no-op outside a request
 * work unit. `from` is the URL the client asked for.
 */
export function recordCanonicalUrl(from: URL): void {
  const unit = getWorkUnit()
  if (!unit) return
  const compat = (unit.compat ??= {})
  // Chained rewrites (middleware → next.config) record in sequence; the
  // canonical URL is what the BROWSER asked for, so only the first wins — a
  // later record's `from` is itself a rewrite destination.
  if (typeof compat[CANONICAL_URL_KEY] === 'string') return
  compat[CANONICAL_URL_KEY] = from.href
}

/** The canonical URL recorded for the active request, or undefined. */
export function canonicalUrlHref(): string | undefined {
  const value = getWorkUnit()?.compat?.[CANONICAL_URL_KEY]
  return typeof value === 'string' ? value : undefined
}
