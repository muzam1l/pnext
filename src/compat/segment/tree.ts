// Segment-prefetch `/_tree` payload builder (COMPAT - may import core freely).
//
// The client segment cache asks the server for a route's prefetch tree by sending rsc: 1,
// next-router-prefetch: 1 and next-router-segment-prefetch: /_tree, and the server answers a minimal
// `RootTreePrefetch`-shaped JSON payload with Content-Type text/x-component, x-nextjs-stale-time and the
// router Vary.
//
// pnext has no RSC flight wire format. The segment-cache suites assert on request/response HEADERS,
// cache-key/staleness behavior and the post-navigation DOM - NOT the flight bytes. So this endpoint mints
// a pnext segment payload: the route tree shaped like Next's RootTreePrefetch, with a single whole-route
// node. The bit-flags and inlining are deliberately omitted; the tree carries just enough for the client
// LRU and staleTime keying.

import { RSC_CONTENT_TYPE_HEADER } from '../next/dist/client/components/app-router-headers'
import { varyNamesFor, type ResponseVaryParams, type SegmentVaryPayload } from './vary-params'

/** The segment-prefetch request sentinel the client sends for the whole tree. */
export const TREE_SEGMENT_PATH = '/_tree' as const

/**
 * Default dynamic staleTime (seconds) - mirrors Next's staleTimes.dynamic, which has defaulted to 0 since
 * Next 15: dynamic data is never reused unless `experimental.staleTimes.dynamic` opts in.
 */
export const DEFAULT_DYNAMIC_STALE_TIME_SECONDS = 0
/** Default static staleTime (seconds) — mirrors Next's staleTimes.static. */
export const DEFAULT_STATIC_STALE_TIME_SECONDS = 300

export const enum PrefetchHint {
  HasRuntimePrefetch = 0b00001,
  IsRootLayout = 0b10000,
  ParentInlinedIntoSelf = 0b100000,
  InlinedIntoChild = 0b1000000,
  HeadInlinedIntoSelf = 0b10000000,
  HeadOutlined = 0b100000000,
  PrefetchDisabled = 0b10000000000,
}

/**
 * A single prefetch-tree node. Milestone 1 emits one whole-route node; the
 * shape mirrors Next's `TreePrefetch` (name/param/slots) so the client keying
 * and a later milestone-2 upgrade stay wire-compatible.
 */
export interface SegmentTreeNode {
  /** Route segment name (the whole pathname for the single-node milestone). */
  name: string
  /** Dynamic param name captured at this segment, when any. */
  param: null | { type: 'd' | 'c' | 'oc'; key: string | null; siblings: string[] | null }
  /** Child slots keyed by slot name (empty for the whole-route node). */
  slots: Record<string, SegmentTreeNode> | null
  /** Next-compatible prefetch hint bitmask. */
  prefetchHints: number
  /** Byte size of this segment payload when it is available at build time. */
  sizeBytes?: number
  /** Body segment path in the per-route segment store, when outlined. */
  segmentPath?: string
  /**
   * Segment-M2: the param names this segment's render actually read (`'?'` for
   * any searchParams access). An EMPTY array means "shareable across every param
   * value"; an ABSENT field means the server did not track vary params and the
   * client must key on the exact URL.
   */
  varyParams?: string[]
}

/** The `/_tree` response payload (Next `RootTreePrefetch` analogue). */
export interface RootTreePrefetch {
  /** Build id when known (start reads it from the manifest; optional). */
  buildId?: string
  /** The route prefetch tree (single whole-route node in milestone 1). */
  tree: SegmentTreeNode
  /** Per-tree staleTime in seconds the client keys its LRU window on. */
  staleTime: number
  /** True when the whole route is statically prerenderable (static window). */
  isStatic: boolean
  /**
   * Segment-M2 vary sets for this route (body / head / root). Absent when the
   * response was produced without render-time tracking.
   */
  vary?: SegmentVaryPayload
  /** The matched route pattern the client keys shared segment entries on. */
  route?: string
  /** Concrete params of the requested URL, so the client can build vary keys. */
  params?: Record<string, string | string[]>
  /**
   * The route's <title> is DYNAMIC and rides in its own `/_head` response. The client learns it here -
   * before the body request - so the head is fetched FIRST, the order Next's segment prefetch produces,
   * since the head segment sits above the page in the route tree.
   */
  headOutlined?: boolean
  /**
   * The outlined head is fetched BEFORE the body: this route has dynamic
   * params, so its (param-shared) body and its per-URL head are separate
   * segments and the head leads.
   */
  headFirst?: boolean
}

interface BuildTreeOptions {
  pathname: string
  isStatic: boolean
  staleTimeSeconds?: number
  buildId?: string
  routeId?: string
  bodySizeBytes?: number
  inlineBudgetBytes?: number
  runtimePrefetch?: boolean
  postponed?: boolean
  /** Segment-M2 vary sets collected while rendering this route, when tracked. */
  vary?: SegmentVaryPayload
  /** The matched route pattern (client vary-key identity). */
  routePattern?: string
  /** Concrete params of the requested URL. */
  params?: Record<string, string | string[]>
  /** The route's head is outlined into a separate `/_head` response. */
  headOutlined?: boolean
  /** That head is fetched before the body (param-varying head). */
  headFirst?: boolean
}

/** Build the whole-route `/_tree` payload for `pathname` (milestone 1). */
export function buildRootTreePrefetch(options: BuildTreeOptions): RootTreePrefetch {
  const staleTime =
    options.staleTimeSeconds ??
    (options.isStatic ? DEFAULT_STATIC_STALE_TIME_SECONDS : DEFAULT_DYNAMIC_STALE_TIME_SECONDS)
  return {
    ...(options.buildId ? { buildId: options.buildId } : {}),
    tree: buildTree(options),
    staleTime,
    isStatic: options.isStatic,
    ...(options.vary ? { vary: options.vary } : {}),
    ...(options.routePattern ? { route: options.routePattern } : {}),
    ...(options.params ? { params: options.params } : {}),
    ...(options.headOutlined ? { headOutlined: true } : {}),
    ...(options.headFirst ? { headFirst: true } : {}),
  }
}

function buildTree(options: BuildTreeOptions): SegmentTreeNode {
  const parts = routeParts(options)
  const bodySize = options.bodySizeBytes ?? 0
  const budget = options.inlineBudgetBytes ?? 32 * 1024
  const canInlineBody = options.isStatic && !options.postponed && bodySize <= budget
  let child = pageNode(parts.length === 0, {
    isStatic: options.isStatic,
    canInlineBody,
    bodySizeBytes: options.bodySizeBytes,
    ...(options.vary ? { varyParams: options.vary.params } : {}),
  })
  for (let index = parts.length - 1; index >= 0; index--) {
    child = routeNode(parts[index]!, child, index === 0, {
      isStatic: options.isStatic,
      canInlineBody,
      runtimePrefetch: options.runtimePrefetch,
    })
  }
  return {
    name: '',
    param: null,
    slots: { children: child },
    prefetchHints: PrefetchHint.IsRootLayout | (canInlineBody ? PrefetchHint.InlinedIntoChild : 0),
  }
}

function routeParts(options: BuildTreeOptions): string[] {
  const source = options.routeId ?? options.pathname
  if (source === 'index' || source === '/') return []
  return source
    .split('/')
    .map(part => part.trim())
    .filter(Boolean)
    .filter(part => !part.startsWith('(') && !part.startsWith('@'))
    .map(part => (part === 'index' ? '__PAGE__' : part))
}

function routeNode(
  name: string,
  child: SegmentTreeNode,
  parentInlined: boolean,
  options: { isStatic: boolean; canInlineBody: boolean; runtimePrefetch?: boolean },
): SegmentTreeNode {
  const dynamic = !options.isStatic || name.includes('instant-false')
  const runtime = Boolean(options.runtimePrefetch) || name.includes('runtime')
  const inlinesIntoChild = options.canInlineBody && !dynamic && !runtime
  return {
    name,
    param: name.startsWith('[') ? { type: 'd', key: null, siblings: null } : null,
    slots: {
      children: { ...child, prefetchHints: child.prefetchHints | parentHint(inlinesIntoChild) },
    },
    prefetchHints:
      (parentInlined ? PrefetchHint.ParentInlinedIntoSelf : 0) |
      (runtime ? PrefetchHint.HasRuntimePrefetch : 0) |
      (dynamic ? PrefetchHint.PrefetchDisabled : 0) |
      (inlinesIntoChild ? PrefetchHint.InlinedIntoChild : 0),
  }
}

function pageNode(
  parentInlined: boolean,
  options: {
    isStatic: boolean
    canInlineBody: boolean
    bodySizeBytes?: number
    varyParams?: string[]
  },
): SegmentTreeNode {
  return {
    name: '__PAGE__',
    param: null,
    slots: null,
    prefetchHints:
      (parentInlined ? PrefetchHint.ParentInlinedIntoSelf : 0) |
      (options.canInlineBody ? PrefetchHint.HeadInlinedIntoSelf : PrefetchHint.HeadOutlined),
    ...(options.bodySizeBytes !== undefined ? { sizeBytes: options.bodySizeBytes } : {}),
    ...(options.canInlineBody ? {} : { segmentPath: ROUTE_SEGMENT_PATH }),
    ...(options.varyParams ? { varyParams: options.varyParams } : {}),
  }
}

function parentHint(enabled: boolean): number {
  return enabled ? PrefetchHint.ParentInlinedIntoSelf : 0
}

export function rootTreePrefetchText(
  payload: RootTreePrefetch,
  format: 'json' | 'flight' = 'json',
): string {
  const json = JSON.stringify(payload)
  return format === 'flight' ? `0:${json}` : json
}

/**
 * The `/_tree` Response: JSON payload with Content-Type text/x-component and
 * x-nextjs-stale-time. The router Vary is merged by the protocol finalizer, so
 * this Response carries only the segment-specific headers.
 */
export function treePrefetchResponse(
  payload: RootTreePrefetch,
  options: { format?: 'json' | 'flight' } = {},
): Response {
  return new Response(rootTreePrefetchText(payload, options.format), {
    status: 200,
    headers: {
      'content-type': RSC_CONTENT_TYPE_HEADER,
      'x-nextjs-postponed': '2',
      'x-nextjs-stale-time': String(payload.staleTime),
      ...(payload.isStatic ? { 'x-nextjs-prerender': '1' } : {}),
      // A STATIC route's tree is CDN-cacheable like Next's prerendered
      // payloads — the per-variant `_rsc` cache-buster keys it correctly even
      // on Vary-ignoring CDNs. Dynamic trees stay private (no-store keeps a
      // stale document from poisoning the segment cache).
      'cache-control': payload.isStatic
        ? 's-maxage=31536000, stale-while-revalidate'
        : 'private, no-store',
    },
  })
}

// Per-segment payload emission and serving (COMPAT).
//
// Beyond `/_tree`, the client can request an individual segment via `next-router-segment-prefetch:
// <segment path>`. For the "whole route as one segment" model the only non-`/_tree` segment path is the
// route's own body, served as a pnext HTML fragment (the route's prebuilt PPR shell / static HTML) with
// Content-Type text/x-component. The tree payload advertises the available segment paths so the client
// knows what to request and stitch.
//
// Build emits, per PPR/static route under cacheComponents:
//   .segments/_tree.segment.rsc    - the RootTreePrefetch JSON
//   .segments/<seg>.segment.rsc    - the segment body (HTML fragment)
//   .segments/<route>.segment.meta - { status, postponed, segmentPaths }
// mirroring Next's `.segments/` layout.

/** The whole-route segment path sentinel (the route body as one segment). */
export const ROUTE_SEGMENT_PATH = '/' as const

export interface SegmentBodyPayload {
  segment: string
  html: string
  /**
   * Segment-M2: this segment's vary set (param names, `'?'` for searchParams).
   * Absent when the render was not tracked; the client then keys on the URL.
   */
  vary?: string[]
  /**
   * w9-segment-split: the LAYOUT frame's own vary set. An `/_index` response
   * carries layout AND page markup, so `vary` above (their union) keys the
   * whole document; these two key the split frames the client composes from.
   */
  layoutVary?: string[]
  /** w9-segment-split: the PAGE frame's own vary set. */
  pageVary?: string[]
  /** The matched route pattern the client keys shared entries on. */
  route?: string
  /** Concrete params of the requested URL. */
  params?: Record<string, string | string[]>
  /**
   * The route's shared APP SHELL (rendered with the params hanging), carried
   * alongside a fully-static per-URL prerender. Next's Flight prerender embeds
   * every Suspense fallback, so its client extracts the shell prefix out of the
   * per-URL response and caches it for the route's OTHER params; pnext's HTML
   * payload has no fallback left once the boundary resolved, so the shell rides
   * as its own field instead.
   */
  shell?: SegmentAppShell
}

/** A route's shared app shell, carried alongside a per-URL prerender. */
export interface SegmentAppShell {
  html: string
  /** The route pattern (colon form) the shell is shared across. */
  route: string
}

/** Segment-M2 vary metadata a producer attaches to a segment body response. */
export interface SegmentVaryInfo {
  vary: string[]
  /** w9-segment-split: the layout frame's vary set, when the render tracked one. */
  layoutVary?: string[]
  /** w9-segment-split: the page frame's vary set, when the render tracked one. */
  pageVary?: string[]
  route?: string
  params?: Record<string, string | string[]>
}

export function segmentBodyText(
  segment: string,
  html: string,
  format: 'json' | 'flight' = 'flight',
  vary?: SegmentVaryInfo,
  shell?: SegmentAppShell,
): string {
  const payload: SegmentBodyPayload = {
    segment,
    html,
    ...(vary ? { vary: vary.vary } : {}),
    ...(vary?.layoutVary ? { layoutVary: vary.layoutVary } : {}),
    ...(vary?.pageVary ? { pageVary: vary.pageVary } : {}),
    ...(vary?.route ? { route: vary.route } : {}),
    ...(vary?.params ? { params: vary.params } : {}),
    ...(shell ? { shell } : {}),
  }
  const json = JSON.stringify(payload)
  return format === 'flight' ? `0:${json}` : json
}

/** The response header carrying a segment's vary set (comma-separated names). */
export const SEGMENT_VARY_HEADER = 'x-pnext-segment-vary'
/** The response header carrying the matched route pattern. */
export const SEGMENT_ROUTE_HEADER = 'x-pnext-segment-route'
/** w9-segment-split: the LAYOUT frame's vary set (comma-separated names). */
export const SEGMENT_LAYOUT_VARY_HEADER = 'x-pnext-segment-layout-vary'
/** w9-segment-split: the PAGE frame's vary set (comma-separated names). */
export const SEGMENT_PAGE_VARY_HEADER = 'x-pnext-segment-page-vary'

/** Per-route segment `.meta` sidecar (contract: status/postponed/segmentPaths). */
export interface SegmentMeta {
  status: number
  /** Effective client-cache staleTime for this route, in seconds. */
  staleTime: number
  /** True when the route was postponed (a PPR shell with holes). */
  postponed: boolean
  /** Segment request keys this route can serve (always includes `/_tree`). */
  segmentPaths: string[]
  /** Actual emitted segment byte sizes keyed by segment request path. */
  segmentSizes?: Record<string, number>
  /** Segment request keys whose payload was inlined into the route tree. */
  inlinedSegmentPaths?: string[]
  /** Route-level prefetch hints, mirrored into Next-shaped metadata. */
  prefetchHints?: Record<string, number>
  /**
   * The vary set the BUILD render tracked for this baked body, in the same wire encoding a live response
   * publishes. ABSENT means "unknown" - the client then keys the entry on its exact URL.
   */
  vary?: string[]
  /** w9-segment-split: the baked LAYOUT frame's vary names. */
  layoutVary?: string[]
  /** w9-segment-split: the baked PAGE frame's vary names. */
  pageVary?: string[]
}

/** The segment-request key the client sends for the whole-route body segment. */
export function segmentBodyPath(): string {
  return ROUTE_SEGMENT_PATH
}

/** Build the `.meta` sidecar for a route (whole-route single-segment milestone). */
export function buildSegmentMeta(options: {
  status: number
  staleTime: number
  postponed: boolean
  bodySizeBytes?: number
  inlineBudgetBytes?: number
  prefetchHints?: Record<string, number>
  /** The build render's tracked vary set — omitted when it is not trustworthy. */
  vary?: ResponseVaryParams
}): SegmentMeta {
  const inlined =
    !options.postponed &&
    options.bodySizeBytes !== undefined &&
    options.bodySizeBytes <= (options.inlineBudgetBytes ?? 32 * 1024)
  return {
    status: options.status,
    staleTime: options.staleTime,
    postponed: options.postponed,
    // `/_tree` (the tree) + the whole-route body segment.
    segmentPaths: [TREE_SEGMENT_PATH, ROUTE_SEGMENT_PATH],
    ...(options.bodySizeBytes !== undefined
      ? { segmentSizes: { [ROUTE_SEGMENT_PATH]: options.bodySizeBytes } }
      : {}),
    ...(inlined ? { inlinedSegmentPaths: [ROUTE_SEGMENT_PATH] } : {}),
    ...(options.prefetchHints ? { prefetchHints: options.prefetchHints } : {}),
    ...(options.vary
      ? {
          vary: varyNamesFor(options.vary, 'body'),
          // Mirrors segmentVaryInfo: the split frames only ride along when the
          // render actually tracked something, or an empty page set would file
          // the page frame as shareable across every param value.
          ...(options.vary.params.length > 0 || options.vary.search
            ? {
                layoutVary: varyNamesFor(options.vary, 'layout'),
                pageVary: varyNamesFor(options.vary, 'page'),
              }
            : {}),
        }
      : {}),
  }
}

/**
 * A per-segment body Response: the route's HTML fragment served as a segment.
 * Same content-type + staleness headers as the tree; the client stitches this
 * fragment into the DOM on navigation.
 */
export function segmentBodyResponse(
  body: string,
  staleTimeSeconds: number,
  postponed = false,
  prerendered = false,
  deploymentId?: string,
  segment: string = ROUTE_SEGMENT_PATH,
  vary?: SegmentVaryInfo,
  shell?: SegmentAppShell,
): Response {
  // A COMPLETE prerendered segment is static content: CDN-cacheable, exactly like Next serves prerendered
  // payloads. Correctness against a Vary-ignoring CDN comes from the per-variant `_rsc` cache-buster and
  // the revalidation-versioned redirects, NOT from no-store. Anything dynamic or truncated stays private.
  const cacheable = prerendered && !postponed
  return new Response(segmentBodyText(segment, body, 'flight', vary, shell), {
    status: 200,
    headers: {
      'content-type': RSC_CONTENT_TYPE_HEADER,
      'x-nextjs-stale-time': String(staleTimeSeconds),
      'x-nextjs-postponed': '2',
      ...(postponed ? { 'x-pnext-segment-postponed': '1' } : {}),
      ...(prerendered ? { 'x-nextjs-prerender': '1' } : {}),
      ...(deploymentId ? { 'x-nextjs-deployment-id': deploymentId } : {}),
      // Mirrored onto headers so a header-only consumer (and the client's
      // cheap pre-parse path) sees the vary set without decoding the body.
      ...(vary ? { [SEGMENT_VARY_HEADER]: vary.vary.join(',') } : {}),
      ...(vary?.layoutVary ? { [SEGMENT_LAYOUT_VARY_HEADER]: vary.layoutVary.join(',') } : {}),
      ...(vary?.pageVary ? { [SEGMENT_PAGE_VARY_HEADER]: vary.pageVary.join(',') } : {}),
      ...(vary?.route ? { [SEGMENT_ROUTE_HEADER]: vary.route } : {}),
      'cache-control': cacheable
        ? 's-maxage=31536000, stale-while-revalidate'
        : 'private, no-store',
    },
  })
}

/** On-disk names for a route's segment artifacts under `<route>.segments/`. */
export function segmentDir(outPath: string, routeId: string): string {
  return `${outPath}/segments/${routeId}`
}
export function treeSegmentFile(outPath: string, routeId: string): string {
  return `${segmentDir(outPath, routeId)}/_tree.segment.rsc`
}
export function bodySegmentFile(outPath: string, routeId: string): string {
  return `${segmentDir(outPath, routeId)}/index.segment.rsc`
}
export function segmentMetaFile(outPath: string, routeId: string): string {
  return `${segmentDir(outPath, routeId)}/route.segment.meta`
}
