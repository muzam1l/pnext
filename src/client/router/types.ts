// Shared shapes of the client router: fetched pages, navigation options, the
// parallel-route nav state, and the entry-module handles the router imports.
export interface PrefetchedPage {
  html: string
  finalUrl: string
  ok: boolean
  /** Entry-bound whole-page client props restored before mounting a history traversal. */
  p?: unknown
  /** `x-nextjs-stale-time` from the response (seconds), when the server sent it. */
  staleTimeSeconds?: number
  /** Complete body segment was emitted from a prerendered route artifact. */
  segmentPrerendered?: boolean
  /**
   * A partial-prefetch response: only the static shell, dynamic continuation
   * cut server-side (`x-nextjs-postponed` on a prefetch fetch). Contributes its
   * loading shell to the shell cache but must never commit as a document.
   */
  shellOnly?: boolean
  /**
   * This response arrived as a FRAMED segment payload and has already been filed with the per-segment
   * policy. A prefetch that came back as a whole document instead - a route the server does not serve
   * segments for, or a segment-unaware server - is recorded from its markup once it settles, so the
   * per-segment cache is fed by ordinary link prefetches either way.
   */
  segmentRecorded?: boolean
  /**
   * This SHELL response published no vary set, so how much of this URL it covers is UNKNOWN - the
   * route's baked fallback shell, rendered with every param hanging. It paints like any other shell,
   * but it is not this URL's own prefetched data: the params-dependent content behind its boundary
   * has never been fetched, so the URL's prefetch stays only as fresh as the dynamic window. A shell
   * that DOES publish its vary set is exact about its coverage and keeps the static window.
   */
  varyCoverageUnknown?: boolean
}

export interface LoadingShellPrediction {
  html: string
  route: {
    // Bracket-free colon form (`/:slug*`); `catchAllOptional` distinguishes an
    // optional catch-all so it survives being written back to __PNEXT_ROUTE__.
    route: string
    params: Record<string, string | string[]>
    catchAllOptional?: boolean
  }
  prefetch?: 'shell' | 'eager'
  /**
   * The predicted 'shell' route is RUNTIME-prefetched (request-sampled): its
   * shell content is derived from the sampled URL's params, so it is NOT shared
   * across the route's other URLs the way a static partial shell is.
   */
  runtimePrefetch?: boolean
}

export interface NavigationScrollOptions {
  pop?: boolean
  scroll?: boolean
}

export type NavigationScrollAction = (url: URL, options: NavigationScrollOptions) => void
export type StylesheetReconciler = (incoming: Document) => void

export type LoadingShellPredictionPolicy = (
  url: URL,
  shells: ReadonlyMap<string, string>,
) => LoadingShellPrediction | undefined

export interface PrefetchOptions {
  /** Link element that triggered the prefetch; receives lifecycle events. */
  element?: Element
  /** Public router.prefetch should match Next and throw for unparseable URLs. */
  strict?: boolean
  /** `prefetch={true}` full-page prefetch — reuses for the static window. */
  full?: boolean
  /**
   * Hover/touch/focus intent: the prefetch rides the scheduler's reserved
   * Intent lane (most-recently-hovered link starts immediately, ahead of
   * queued viewport prefetches).
   */
  intent?: boolean
  /**
   * unstable_dynamicOnHover upgrade: when the route's static shell is already
   * cached, ask the server for the dynamic continuation only (the response
   * must not re-send static content the client already holds) and merge it
   * into the cached shell.
   */
  hoverResume?: boolean
  /** Called once when this prefetch is invalidated. */
  onInvalidate?: () => void
  /**
   * Seed the prefetch for the URL the browser is ALREADY on. Next embeds a runtime-prefetch stream in
   * the initial HTML of an allow-runtime route; pnext asks the server for the same payload instead,
   * which means prefetching the current URL - the one case the same-URL guards must not elide.
   */
  currentUrl?: boolean
}

export interface SoftNavigateOptions extends NavigationScrollOptions {
  replace?: boolean
  /** Parallel-route state to send instead of the current document's (popstate). */
  navState?: DocumentNavState
  /** Restore this document without fetching (popstate to a cached entry). */
  cachedPage?: PrefetchedPage
  /** router.refresh()/revalidation surface: bypass caches, fetch fresh (internal). */
  refreshLike?: boolean
  /**
   * A same-URL LINK click: refresh the PAGE segments only. It takes the refresh-like path (no loading
   * flash, caches evicted, no new history entry) but KEEPS the live layout segments, so the request
   * may skip shared layouts exactly like any other navigation.
   */
  pageRefresh?: boolean
  /**
   * Remount everything the incoming document renders - no client-page preservation. An error
   * boundary's reset() refreshes precisely to throw the failed tree away, so keeping it alive would
   * replay the error.
   */
  remount?: boolean
  /**
   * The incoming document is freshly rendered server data that supersedes the live tree (the response
   * to a revalidating action, or the document a post-action redirect landed on): take ALL of its
   * server segments instead of grafting the live layouts over them, or the write would be invisible.
   * Island preservation is unaffected - useActionState must survive.
   */
  freshSegments?: boolean
}

/** Mirrors NavState in src/types.ts (kept local: this file ships to browsers). */
export interface DocumentNavState {
  children?: string
  /** Search string the children tree rendered with (refetch-URL semantics). */
  childrenSearch?: string
  /** Slot dir -> source URL (`path` or `path?query`) its content rendered from. */
  slots?: Record<string, string>
  /**
   * The document is an interception HOST render (server-stamped): the URL is the intercepted target
   * but the children tree kept rendering the host page. Such a render is host-bound - never
   * origin-agnostic, never a direct target render.
   */
  hostRender?: boolean
}

export interface ActiveEntry {
  /** `keepRoots`: live island roots the next document reuses — do not unmount. */
  unmount?: (keepRoots?: Set<Element>) => void
}

/** Mount container of a whole-page client route (element or marker-range proxy). */
export interface ClientPageRoot {
  isConnected?: boolean
  /** Page-slot comment anchors when the entry dissolved `div#pnext-page`. */
  __pnextAnchors?: [Comment, Comment]
}

export interface EntryModule {
  mountRoute?: () => Promise<unknown> | void
}

/** Mirror of core's PrefetchMode; the router keeps no imports outside its chunk. */
export type LinkPrefetchMode = false | 'intent' | 'visible' | 'load'

declare global {
  interface Window {
    /** App-wide default prefetch mode (config `prefetch`), injected by the server. */
    __PNEXT_PREFETCH__?: LinkPrefetchMode
    __PNEXT_ROUTER_INSTALLED__?: boolean
    __PNEXT_ROUTER_IMPORTS__?: number
    __PNEXT_ACTIVE_ENTRY__?: ActiveEntry
    /** The entry's guarded remount hook — mounts only what a prior pass missed. */
    __PNEXT_MOUNT_ISLANDS__?: () => unknown
    /**
     * The container a whole-page `'use client'` route is mounted on. A real
     * `#pnext-page` element in a nested/segment context; otherwise the virtual
     * container the entry builds over the dissolved page's comment anchors
     * (carried on `__pnextAnchors`). See matchPreservedClientPage.
     */
    __PNEXT_CLIENT_PAGE_ROOT__?: ClientPageRoot
    __PNEXT_LOCATION_LISTENERS__?: Set<() => void>
    next?: {
      router?: {
        push?: (href: string) => Promise<void>
        replace?: (href: string) => Promise<void>
        prefetch?: (href: string) => Promise<PrefetchedPage | null>
      }
    }
  }
}

export interface SegmentCacheRecord {
  /** Requested pathname (percent-encoding preserved). */
  pathname: string
  /** Requested query string (leading `?` included, `_rsc` still present). */
  search: string
  /** Segment request key the response answered (`/_index`, `/_head`, …). */
  segmentPath: string
  /**
   * Wire shape of `body`: a framed segment payload (a prefetch response) or a
   * whole HTML document (a navigation response / the hard-loaded page). The
   * policy decodes its vary metadata differently for each.
   */
  kind?: 'segment' | 'document'
  /** The raw segment payload text, for the policy's own decoding. */
  body: string
  /** The payload the router committed for this segment. */
  html: string
  /** Reuse window in milliseconds. */
  staleTimeMs: number
  /** True when the payload is a whole document, not a truncated shell. */
  complete: boolean
  /** True when the bytes are a pure function of the URL (a prerender). */
  static: boolean
  /** True when the payload came from a runtime (request-sampled) prefetch. */
  runtime: boolean
  /**
   * The server DECLARED this payload its POSTPONED (PPR) shell for this exact URL - the
   * truncated prefetch response `x-nextjs-postponed` marks. Such a payload is the
   * destination's own prerendered static stage, holes and all.
   */
  postponedShell?: boolean
}

export interface SegmentCacheLookup {
  pathname: string
  search: string
  segmentPath: string
}

export interface SegmentCacheHit {
  html: string
  /** True when this hit may commit a navigation with no network request. */
  networkFree: boolean
  /**
   * True when a PREFETCH of this URL has nothing left to fetch. Weaker than
   * `networkFree`: a shell shared across params satisfies the prefetch (its
   * static half is already cached) while the NAVIGATION still fetches the
   * dynamic remainder. Absent (older policies) reads as `networkFree`.
   */
  prefetchSatisfied?: boolean
  /**
   * This hit is THIS URL's own postponed (PPR) shell - the static stage the server
   * prerendered for it, not a sibling's bytes. It paints even when its whole page is one
   * unresolved boundary, because that boundary IS what the destination renders until its
   * dynamic stage lands.
   */
  postponedShell?: boolean
}

export interface SegmentCachePolicy {
  record: (input: SegmentCacheRecord) => void
  take: (input: SegmentCacheLookup) => SegmentCacheHit | null
  /**
   * The route pattern (colon form) the server resolved `pathname` to, or null
   * when this exact pathname was never answered. The route-tree cache uses it
   * as its static-sibling guard.
   */
  routeFor?: (pathname: string) => string | null
  /** True when the colon-form `route` pattern covers `pathname`. */
  matchesRoute?: (route: string, pathname: string) => boolean
  /**
   * The cached bytes a PREFETCH of this segment would re-fetch verbatim: a DIFFERENT URL's entry whose
   * published vary set covers this one. Weaker than `take` - the entry may be a postponed shell, so it
   * never commits - but it is byte-identical by the server's own assertion, so the request is skipped.
   */
  prefetchCovered?: (input: SegmentCacheLookup) => { html: string } | null
  /**
   * w9-segment-split: the PAGE frame is cached but the LAYOUT frame is not,
   * so only `/_layout` has to come off the network.
   */
  needsLayoutFrameOnly?: (input: { pathname: string; search: string }) => boolean
  /**
   * Join a `/_layout` response with this URL's cached PAGE frame into the whole
   * document. Null when the two cannot be proven to line up.
   */
  composeLayoutFrame?: (input: {
    pathname: string
    search: string
    layoutHtml: string
  }) => string | null
  /**
   * True when a RUNTIME-prefetched page frame already covers this URL. Such a route's layout is not
   * statically prefetchable (only the page opted into allow-runtime), so a page-frame hit leaves the
   * prefetch with nothing to fetch - the layout arrives with the navigation's dynamic stage.
   */
  runtimePageFrameSatisfied?: (input: { pathname: string; search: string }) => boolean
  /**
   * w9-segment-split (G2): this URL's LAYOUT chain is already cached (or, for a
   * same-URL navigation, already on screen), so the navigation may fetch the
   * `/_page` frame alone. `sameUrl` is what authorises the live document's own
   * layout as the frame.
   */
  needsPageFrameOnly?: (input: { pathname: string; search: string; sameUrl: boolean }) => boolean
  /**
   * Splice a `/_page` response into that cached layout frame. Null means the
   * two could not be proven to line up — the caller fetches the whole document.
   */
  composePageFrame?: (input: {
    pathname: string
    search: string
    sameUrl: boolean
    pageHtml: string
  }) => string | null
  /**
   * File the LAYOUT frame of a committed whole document, so a later same-URL
   * navigation can refresh the page segments without re-fetching the layouts.
   */
  recordDocumentLayout?: (input: {
    pathname: string
    search: string
    html: string
    staleTimeMs: number
  }) => void
  /** A same-URL navigation refreshes page segments only. */
  evictPageSegments: () => void
  /** A revalidation invalidates every segment entry. */
  clear: () => void
}
