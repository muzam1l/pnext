import { createContext, type Context } from 'preact'

// Island SSR runs prebundled client chunks — a separate module graph with its own copy of this file, so
// a plain createContext() would mint two identity-mismatched contexts. Resolve one shared instance.
function sharedContext<T>(key: string, defaultValue: T): Context<T> {
  const registry = globalThis as typeof globalThis & Record<symbol, Context<unknown>>
  const symbol = Symbol.for(key)
  const existing = registry[symbol]
  if (existing) return existing as Context<T>
  const context = createContext<T>(defaultValue)
  registry[symbol] = context as Context<unknown>
  return context
}

// ---------------------------------------------------------------------------
// Per-island layout-segment context (CORE seam for compat useSelectedLayout-
// Segment(s), sibling to the layout-segment scope in render/slots.ts).
//
// A `'use client'` layout is hydrated as an island and so has no server-side
// layout-segment scope on the client. The renderer stamps each island rendered
// INSIDE a layout scope with a snapshot of that layout's position in the route
// (its `depth` = segments consumed at/above the layout, the resolved `segments`
// below it, and its parallel-route slot segments). The compat hook reads this
// context: on the server render it returns the resolved `segments`/`slots`
// (byte-exact SSR); on the client it recomputes the suffix live from `depth`
// and the current path so soft navigations (which keep a shared layout's island
// mounted and merely re-render it) stay correct.
//
// Kept in core (imports only `preact`) so both the renderer's SSR wrap and the
// entry's client mount reference the SAME context object without the core ->
// compat boundary edge, exactly like the currentLayoutSegments core seam.
// ---------------------------------------------------------------------------

export interface LayoutSegmentSnapshot {
  /** Segments consumed AT or ABOVE the owning layout's directory. */
  depth: number
  /** Resolved URL segments below the owning layout (server-side truth). */
  segments: string[]
  /** Resolved segments per parallel-route slot key (server-side truth). */
  slots: Record<string, string[]>
}

export const LayoutSegmentContext = sharedContext<LayoutSegmentSnapshot | null>(
  'pnext.layoutSegmentContext',
  null,
)

// Per-island params snapshot (CORE seam for compat useParams).
//
// A `'use client'` component rendered inside a parallel-route slot subtree is SSR'd and hydrated as an
// island. Its useParams() must see the params visible at that point in the route - route params PLUS the
// enclosing slot's own dynamic/catch-all params - but the client island only carries the global route
// params, so the slot's params never reach it. The renderer stamps each island created inside a slot's
// params scope with a snapshot of the resolved params and re-provides it here; compat's useParams prefers
// this context when present.
//
// Kept in core (imports only `preact`) so both the renderer's SSR wrap and the entry's client mount
// reference the SAME context object, exactly like LayoutSegmentContext above.

export type RouteParamsSnapshot = Record<string, string | string[]>

export const RouteParamsContext = sharedContext<RouteParamsSnapshot | null>(
  'pnext.routeParamsContext',
  null,
)

/** Marks a client island whose nearest Suspense boundary owns static-generation fallback UI. */
export const CsrBailoutContext = sharedContext('pnext.csrBailoutContext', false)
