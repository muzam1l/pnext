// Client half of `output: 'export'`.
//
// An exported app is a directory of files behind whatever static host the user points at it, so the
// router has no server to negotiate with: no RSC content type, no segment-prefetch header, no
// redirect/rewrite map. The exporter compensates by writing every document twice - once as the page
// itself and once as flat sibling artifacts - and stamps each exported document with
// `window.__PNEXT_OUTPUT_EXPORT__`. This module turns that flag into the router's document fetcher,
// reproducing the URL shapes Next uses so the same static hosts (and proxy rewrites) keep working:
//
//   navigation   /another        -> /another.txt
//                /another/       -> /another/index.txt
//   prefetch     /another        -> /another/__next._full.txt
//
// The prefetch shape puts the request one path segment below the route, which is what lets a host-level
// rewrite of the page also cover the data request. A host-level REDIRECT typically does not, so - like
// Next - a HEAD probe resolves the page's final URL first.

import { setExportDocumentFetcher } from '../../client/router/policies'

/** The exported segment file carrying a route's complete document. */
const SEGMENT_FILE = '__next._full.txt'

/** A document read out of the export tree, with the route URL it belongs to. */
interface ExportedDocument {
  html: string
  finalUrl: string
}

// Registered at MODULE scope rather than from installNavCompat(): the router
// issues the document's first prefetches before the compat entry finishes its
// install sequence, and those would otherwise fall through to a server that
// isn't there. Module initialization runs before any of it, and the marker is
// an inline script in <head>, so it is already set by the time this evaluates.
if (outputExportMode()) setExportDocumentFetcher(fetchExportedDocument)

/** Whether the running document was served out of an export tree. */
function outputExportMode(): boolean {
  return (
    (process.browser || typeof window !== 'undefined') &&
    (window as { __PNEXT_OUTPUT_EXPORT__?: boolean }).__PNEXT_OUTPUT_EXPORT__ === true
  )
}

/** `/another` -> `/another.txt`; `/another/` -> `/another/index.txt`. */
function documentUrl(url: URL): URL {
  const target = new URL(url.href)
  target.pathname += target.pathname.endsWith('/') ? 'index.txt' : '.txt'
  return target
}

/** `/another` (or `/another/`) -> `/another/__next._full.txt`. */
function segmentUrl(url: URL): URL {
  const target = new URL(url.href)
  const directory = target.pathname.endsWith('/') ? target.pathname.slice(0, -1) : target.pathname
  target.pathname = `${directory}/${SEGMENT_FILE}`
  return target
}

/**
 * Fetch a route's document from the export tree. Returns null when the host rejects the route or the
 * artifact is missing - the router then falls back to a hard navigation, which is the correct outcome
 * for a path the exporter never wrote.
 */
async function fetchExportedDocument(
  href: string,
  init: RequestInit,
  prefetch: boolean,
): Promise<ExportedDocument | null> {
  const url = new URL(href, location.href)
  let pageUrl = url
  if (prefetch) {
    // Resolve host-level redirects on the PAGE path before asking for a file
    // beside it: a host that redirects `/old` to `/new` has no reason to also
    // redirect `/old/__next._full.txt`, which the exporter never wrote.
    const probe = await fetch(url.href, { method: 'HEAD', credentials: 'same-origin' }).catch(
      () => null,
    )
    // `Response#ok` is false for a followed 3xx chain, so test the range.
    if (!probe || probe.status < 200 || probe.status >= 400) return null
    if (probe.redirected) pageUrl = new URL(probe.url)
  }
  const target = prefetch ? segmentUrl(pageUrl) : documentUrl(pageUrl)
  const response = await fetch(target.href, init)
  if (!response.ok) return null
  const html = await response.text()
  // Static hosts answer an unknown path with a catch-all document or a
  // directory listing rather than a 404; neither is a pnext document.
  if (!html.includes('<html')) return null
  return {
    html,
    finalUrl: prefetch ? pageUrl.href : navigatedUrl(response, url),
  }
}

/**
 * The route URL a navigation landed on: the response URL with the artifact
 * suffix peeled back off when the host redirected, otherwise the requested URL.
 */
function navigatedUrl(response: Response, requested: URL): string {
  if (!response.redirected) return requested.href
  try {
    const url = new URL(response.url)
    url.pathname = url.pathname.endsWith('/index.txt')
      ? url.pathname.slice(0, -'index.txt'.length)
      : url.pathname.replace(/\.txt$/, '')
    return url.href
  } catch {
    return requested.href
  }
}
