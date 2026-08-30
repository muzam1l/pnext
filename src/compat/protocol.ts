// HTTP protocol conformance finalizers (COMPAT - may import core freely).
//
// Registered as core responseFinalizers when compat.next is on. Each runs before the first flush and
// mutates the outgoing headers in place to emit the Next wire-protocol headers pnext core deliberately
// does not know about:
//   - `Vary` merge: append Next's router vary tokens to any existing Vary (user- or middleware-set)
//     instead of overwriting.
//   - `x-nextjs-rewritten-path` / `-query`: on responses whose URL a compat rewrite changed, so the
//     client router can set the canonical URL.
//
// Core owns the generic "merge, do not overwrite" discipline; compat owns the exact Next header
// names and values. A pure-core app registers none of this.

import type { ResolvedConfig } from '../config'
import { getWorkUnit, type WorkUnit } from '../request/context'
import type { RequestInterceptor, ResponseFinalizer, ResponseFinalizerContext } from '../extensions'
import { nextCompatEnabled } from '../compat/aliases'

// Next's router vary tokens appended to every app-router response so a CDN
// keys its cache on the RSC negotiation headers. Order + spelling match Next.
const ROUTER_VARY = [
  'rsc',
  'next-router-state-tree',
  'next-router-prefetch',
  'next-router-segment-prefetch',
]

/** Rewrite tracking recorded per request by the compat rewrite interceptor. */
interface RewriteInfo {
  /** Destination pathname, only when it differs from the requested one. */
  path?: string
  /** Destination query (without leading `?`), only when non-empty. */
  query?: string
}

// Keyed on the request's work unit (stable for the whole response lifecycle);
// the interceptor writes it, the finalizer reads it. A WeakMap so completed
// requests are collected without any explicit teardown.
const rewrites = new WeakMap<WorkUnit, RewriteInfo>()

/**
 * Record that a compat rewrite changed the request URL from `from` to `to`.
 * The response finalizer emits `x-nextjs-rewritten-path/query` from this. A
 * no-op outside a request work unit or when the URL did not actually change.
 */
export function recordRewrite(from: URL, to: URL): void {
  const unit = getWorkUnit()
  if (!unit) return
  if (from.pathname === to.pathname && from.search === to.search) return
  const query = to.search.replace(/^\?/, '')
  // Next reports the path header only when the pathname actually changed, and
  // the query header only when the destination carries a query (a query-only
  // rewrite reports query alone; a path-only rewrite reports path alone).
  rewrites.set(unit, {
    ...(to.pathname !== from.pathname ? { path: to.pathname } : {}),
    ...(query ? { query } : {}),
  })
}

/**
 * Internal marker set by the segment responder's `_rsc` cache-busting 307 so
 * this module's redirect normalization leaves it alone. Never reaches a client.
 */
export const CACHE_BUSTING_REDIRECT_HEADER = 'x-pnext-cache-bust'

const APP_ROUTE_KINDS = new Set<ResponseFinalizerContext['routeKind']>([
  'html',
  'data',
  'route-handler',
])

const protocolFinalizer: ResponseFinalizer = ctx => {
  if (!APP_ROUTE_KINDS.has(ctx.routeKind)) return
  if (!isPlainRedirect(ctx)) mergeVary(ctx.headers, ROUTER_VARY)
  normalizeRscRedirectStatus(ctx)
  applyRewrittenHeaders(ctx)
  applyEdgeRuntimeHeader(ctx)
}

function isPlainRedirect(ctx: ResponseFinalizerContext): boolean {
  if (ctx.status < 300 || ctx.status >= 400 || !ctx.headers.has('location')) return false
  return (
    ctx.request.headers.get('rsc') !== '1' &&
    !ctx.request.headers.has('next-router-prefetch') &&
    !ctx.request.headers.has('next-router-segment-prefetch')
  )
}

// Next's edge SSR/route wrappers stamp `x-edge-runtime: 1` on every response
// from a route whose segment config selects the edge runtime (edge-ssr-app.ts).
// The matched route's runtime rides on the work-unit response hints.
function applyEdgeRuntimeHeader(ctx: ResponseFinalizerContext): void {
  const runtime = ctx.hints?.runtime
  if (runtime === 'edge' || runtime === 'experimental-edge') {
    ctx.headers.set('x-edge-runtime', '1')
  }
}

// Append `values` to the response's Vary header, preserving any existing tokens
// (user- or middleware-set) and never duplicating (case-insensitive).
function mergeVary(headers: Headers, values: readonly string[]): void {
  const existing = headers.get('vary')
  const present = new Set(
    (existing ?? '')
      .split(',')
      .map(token => token.trim().toLowerCase())
      .filter(Boolean),
  )
  const merged = existing
    ? existing
        .split(',')
        .map(token => token.trim())
        .filter(Boolean)
    : []
  for (const value of values) {
    if (present.has(value.toLowerCase())) continue
    present.add(value.toLowerCase())
    merged.push(value)
  }
  if (merged.length > 0) headers.set('vary', merged.join(', '))
}

// Emit x-nextjs-rewritten-path/query when a compat rewrite changed this
// request's URL. Next emits these only on RSC requests (the client router
// restores the canonical URL from them); plain HTML/navigation responses omit
// them. Each header is set only when the rewrite recorded that part. Absent on
// non-rewritten responses (the WeakMap has no entry).
function applyRewrittenHeaders(ctx: ResponseFinalizerContext): void {
  if (ctx.request.headers.get('rsc') !== '1') return
  const unit = getWorkUnit()
  if (!unit) return
  const info = rewrites.get(unit)
  if (!info) return
  if (info.path !== undefined) ctx.headers.set('x-nextjs-rewritten-path', info.path)
  if (info.query !== undefined) ctx.headers.set('x-nextjs-rewritten-query', info.query)
}

function normalizeRscRedirectStatus(ctx: ResponseFinalizerContext): void {
  // A `_rsc` cache-busting bounce (register-segment) is a CDN key rotation, not
  // an app redirect(): Next sends it as a real 307 that every client follows,
  // so it must survive this normalization. The marker is internal — strip it.
  if (ctx.headers.has(CACHE_BUSTING_REDIRECT_HEADER)) {
    ctx.headers.delete(CACHE_BUSTING_REDIRECT_HEADER)
    return
  }
  if (ctx.routeKind !== 'html') return
  if (ctx.request.headers.get('rsc') !== '1') return
  // pnext's own soft-nav client sends rsc:1 but follows real redirects via
  // fetch (it reads response.url as the final URL); rewriting 307/308 to 200
  // would strand it on the source URL. The 200+Location wire form is only
  // meaningful to Next's client, which never sends x-pnext-soft-nav.
  if (ctx.request.headers.has('x-pnext-soft-nav')) return
  if (!ctx.headers.has('location')) return
  if (ctx.status !== 307 && ctx.status !== 308) return
  ctx.status = 200
}

// next-router-state-tree validation (Next's parseAndValidateFlightRouterState).
//
// Next parses the RSC navigation's router state tree against a schema and lets a parse failure escape as
// a 500 - a malformed tree is a protocol violation, not something to render around. pnext's renderer
// ignores the header, so the check lives here, in front of route matching, and is deliberately narrow:
// only a tree that is unparseable, not an array, or whose parallel-routes slot is not an object is
// rejected. Anything Next's own client can send passes untouched.

function isValidFlightRouterState(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  const [segment, parallelRoutes] = value as unknown[]
  if (typeof segment !== 'string' && !Array.isArray(segment)) return false
  if (typeof parallelRoutes !== 'object' || parallelRoutes === null) return false
  if (Array.isArray(parallelRoutes)) return false
  return Object.values(parallelRoutes as Record<string, unknown>).every(isValidFlightRouterState)
}

const routerStateTreeInterceptor: RequestInterceptor = request =>
  Promise.resolve(validateRouterStateTree(request))

function validateRouterStateTree(request: Request): Response | undefined {
  if (request.headers.get('rsc') !== '1') return undefined
  // pnext's own client mirrors its richer nav-state object into this header for
  // wire compat (client/router/index.ts); that object is not a FlightRouterState and is
  // never what this check is about.
  if (request.headers.has('x-pnext-soft-nav')) return undefined
  const header = request.headers.get('next-router-state-tree')
  if (header === null) return undefined

  let tree: unknown
  try {
    tree = JSON.parse(decodeURIComponent(header))
  } catch {
    try {
      tree = JSON.parse(header)
    } catch {
      return new Response('Internal Server Error', { status: 500 })
    }
  }
  return isValidFlightRouterState(tree)
    ? undefined
    : new Response('Internal Server Error', { status: 500 })
}

/** The compat request interceptors this module owns, gated on compat.next. */
export function protocolInterceptors(config: ResolvedConfig): RequestInterceptor[] {
  if (!nextCompatEnabled(config)) return []
  return [routerStateTreeInterceptor]
}

/** The compat protocol finalizers, gated on compat.next. */
export function protocolFinalizers(config: ResolvedConfig): ResponseFinalizer[] {
  if (!nextCompatEnabled(config)) return []
  return [protocolFinalizer]
}
