// Render-time vary-params tracking (COMPAT - may import core freely). A port of Next's vary-params
// accumulator model.
//
// While a route renders, every `params` / `searchParams` read is recorded into an accumulator so the
// response can tell the client WHICH params a segment actually depends on. A segment whose vary set is
// empty is shareable across every param value of its route - the client segment cache then keys one entry
// for all of them.
//
// pnext's segment model is "whole route as one segment", so the accumulators collapse into three
// published sets per response:
//   - `params` : union of every BODY segment's accesses (page + layouts) + root
//   - `head`   : generateMetadata/generateViewport accesses + root
//   - `root`   : next/root-params accesses, merged into both sets above
// plus a boolean `search` flag, the client-visible form of Next's `'?'` sentinel (searchParams have no
// fixed schema, so ANY access varies the whole query).
//
// Process-wide state (the ALS) is anchored on globalThis: a pnext module can be loaded twice (built copy
// vs original) and a split ALS would silently drop every access recorded by the other copy.

import { AsyncLocalStorage } from 'node:async_hooks'
import { SEARCH_PARAMS_SENTINEL } from './vary-key'

// Pure keying/encoding helpers live in ./vary-key (browser-safe — the client
// segment cache imports them); re-exported here for server callers.
export {
  SEARCH_PARAMS_SENTINEL,
  VARY_KEY_SEPARATOR,
  encodeVarySet,
  decodeVarySet,
  segmentVaryCacheKey,
} from './vary-key'

/** The set of param names a segment read. `'?'` means "any searchParams access". */
export type VaryParams = Set<string>

/**
 * Which segment of the route an accumulator belongs to.
 *
 * The response used to UNION every body accumulator into one published set, which collapses Next's
 * central per-segment property - a LAYOUT that reads `[category, item]` forced the PAGE, which read only
 * `category`, to key on both, so two items of one category could never reuse the page. The accumulators
 * now carry their segment kind so the response can publish the layout and page sets side by side and the
 * client can re-fetch one frame while reusing the other.
 */
export type VarySegmentKind = 'page' | 'layout' | 'head' | 'root'

/**
 * Accumulates vary params for a single segment (or for metadata/rootParams). Mirrors Next's
 * `VaryParamsAccumulator`, including the React thenable protocol fields (status/value/then). pnext has no
 * Flight wire, so the thenable is never serialized - but keeping the shape identical means the Next port
 * reads one-to-one and a future Flight upgrade needs no rework.
 */
export interface VaryParamsAccumulator {
  /** Which route segment this accumulator tracks (page / layout / head / root). */
  kind: VarySegmentKind
  /** Mutable during render — accumulates param access. */
  varyParams: VaryParams
  /** React thenable protocol: 'pending' until finishAccumulatingVaryParams. */
  status: 'pending' | 'fulfilled'
  value: VaryParams
  then(onfulfilled?: ((value: VaryParams) => unknown) | null): void
  /** Callbacks waiting for resolution. */
  resolvers: ((value: VaryParams) => unknown)[]
}

/**
 * Per-response accumulator bag. `segments` grows as each segment's props are
 * created; `head` and `rootParams` are allocated up front.
 */
export interface ResponseVaryParamsAccumulator {
  /** metadata/viewport (the "head" segment). */
  head: VaryParamsAccumulator
  /** `next/root-params` accesses; merged into every other segment's set. */
  rootParams: VaryParamsAccumulator
  /** One accumulator per rendered body segment (page + layouts). */
  segments: Set<VaryParamsAccumulator>
}

export function createSegmentVaryParamsAccumulator(
  kind: VarySegmentKind = 'page',
): VaryParamsAccumulator {
  const accumulator: VaryParamsAccumulator = {
    kind,
    varyParams: new Set<string>(),
    status: 'pending',
    value: new Set<string>(),
    then(onfulfilled) {
      if (!onfulfilled) return
      if (accumulator.status === 'pending') accumulator.resolvers.push(onfulfilled)
      else onfulfilled(accumulator.value)
    },
    resolvers: [],
  }
  return accumulator
}

const emptySet: VaryParams = new Set<string>()

/**
 * A singleton accumulator already resolved to an empty set, for segments known
 * up front to read no params (client components, segments with no user code).
 */
export const emptyVaryParamsAccumulator: VaryParamsAccumulator = {
  kind: 'page',
  varyParams: emptySet,
  status: 'fulfilled',
  value: emptySet,
  then(onfulfilled) {
    if (onfulfilled) onfulfilled(emptySet)
  },
  resolvers: [],
}

export function createResponseVaryParamsAccumulator(): ResponseVaryParamsAccumulator {
  return {
    head: createSegmentVaryParamsAccumulator('head'),
    rootParams: createSegmentVaryParamsAccumulator('root'),
    segments: new Set<VaryParamsAccumulator>(),
  }
}

// ---------------------------------------------------------------------------
// Response scope (ALS).
// ---------------------------------------------------------------------------

const VARY_PARAMS_GLOBALS = Symbol.for('pnext.compat.varyParamsGlobals')

function varyGlobal<T>(name: string, create: () => T): T {
  const root = globalThis as Record<PropertyKey, unknown>
  const container = (root[VARY_PARAMS_GLOBALS] ??= {}) as Record<string, unknown>
  if (!(name in container)) container[name] = create()
  return container[name] as T
}

const varyStorage = varyGlobal(
  'storage',
  () => new AsyncLocalStorage<ResponseVaryParamsAccumulator>(),
)

/** The response accumulator of the render in progress, or null outside one. */
export function currentResponseVaryParams(): ResponseVaryParamsAccumulator | null {
  return varyStorage.getStore() ?? null
}

/**
 * Allocate a fresh body-segment accumulator inside the current response scope. Null when nothing is
 * tracking (a build prerender outside the segment path, a `use cache` producer, a route handler) - callers
 * then skip the proxy entirely.
 */
export function createVaryParamsAccumulator(
  kind: 'page' | 'layout' = 'page',
): VaryParamsAccumulator | null {
  const response = varyStorage.getStore()
  if (!response) return null
  const accumulator = createSegmentVaryParamsAccumulator(kind)
  response.segments.add(accumulator)
  return accumulator
}

/** The HEAD (metadata/viewport) accumulator of the current response, or null. */
export function getMetadataVaryParamsAccumulator(): VaryParamsAccumulator | null {
  return varyStorage.getStore()?.head ?? null
}

// metadata and viewport ship in one payload, so they share one accumulator.
export const getViewportVaryParamsAccumulator = getMetadataVaryParamsAccumulator

/** The rootParams accumulator of the current response, or null. */
export function getRootParamsVaryParamsAccumulator(): VaryParamsAccumulator | null {
  return varyStorage.getStore()?.rootParams ?? null
}

/** Record that `paramName` was read by the segment owning `accumulator`. */
export function accumulateVaryParam(accumulator: VaryParamsAccumulator, paramName: string): void {
  // The shared empty accumulator is immutable — never widen it.
  if (accumulator === emptyVaryParamsAccumulator) return
  accumulator.varyParams.add(paramName)
}

/** Record a `next/root-params` access (varies every segment of the response). */
export function accumulateRootVaryParam(paramName: string): void {
  const accumulator = getRootParamsVaryParamsAccumulator()
  if (accumulator !== null) accumulateVaryParam(accumulator, paramName)
}

// ---------------------------------------------------------------------------
// Tracking views over params / searchParams.
// ---------------------------------------------------------------------------

/**
 * Marker exposing the ORIGINAL (untracked) object behind a tracking view, so a second consumer -
 * `generateMetadata`, whose accesses belong to the HEAD segment, not the page's - can re-wrap the same
 * data against its own accumulator instead of reading through, and widening, the page's set.
 *
 * A symbol key: it never enumerates, never serializes, and never collides with a param literally named
 * `then`/`value`/`status`.
 */
const VARY_TRACKING = Symbol.for('pnext.compat.varyTracking')

export interface VaryTrackingInfo {
  raw: Record<string, unknown>
  kind: 'params' | 'searchParams'
  optionalCatchAllParam: string | null
}

function markVaryTracking(target: object, info: VaryTrackingInfo): void {
  Object.defineProperty(target, VARY_TRACKING, {
    value: info,
    enumerable: false,
    configurable: true,
  })
}

/** The tracking info behind a params/searchParams view, or null when untracked. */
export function varyTrackingInfo(value: unknown): VaryTrackingInfo | null {
  if (typeof value !== 'object' || value === null) return null
  const info = (value as Record<PropertyKey, unknown>)[VARY_TRACKING]
  return (info as VaryTrackingInfo | undefined) ?? null
}

/**
 * A `params` object that records which params the render reads. Two strategies, exactly as Next:
 *  - With an optional catch-all param at its empty value the key is ABSENT from the object, so only a
 *    Proxy can observe reads of it. The traps also track enumeration (`ownKeys`) and `in` checks (`has`),
 *    because user code branching on "is the slug present?" depends on the param.
 *  - Otherwise every param is an own property, so per-property getters suffice - faster than Proxy traps,
 *    and `Object.keys()` alone does NOT vary, matching Next: enumerating names without reading values
 *    does not make the segment param-dependent.
 *
 * PROTOCOL-NAME SAFETY: a param literally named `then`, `value` or `status` must be delivered as plain
 * data. Both strategies read through to the ORIGINAL params object, never to the accumulator, so the
 * thenable protocol can never leak into user-visible params. Reads of a name that is NOT a param - which
 * `await`/`Promise.resolve` probe for - are ignored, so awaiting the params promise never pollutes the
 * vary set.
 */
export function createVaryingParams<T extends Record<string, unknown>>(
  accumulator: VaryParamsAccumulator,
  params: T,
  optionalCatchAllParamName: string | null = null,
): T {
  const originalParams = normalizeOptionalCatchAllParams(params, optionalCatchAllParamName)
  const info: VaryTrackingInfo = {
    raw: originalParams,
    kind: 'params',
    optionalCatchAllParam: optionalCatchAllParamName,
  }
  if (optionalCatchAllParamName !== null) {
    return new Proxy(originalParams, {
      get(target, prop, receiver) {
        if (prop === VARY_TRACKING) return info
        if (
          typeof prop === 'string' &&
          (prop === optionalCatchAllParamName || Object.prototype.hasOwnProperty.call(target, prop))
        ) {
          accumulateVaryParam(accumulator, prop)
        }
        return Reflect.get(target, prop, receiver)
      },
      has(target, prop) {
        if (prop === optionalCatchAllParamName) {
          accumulateVaryParam(accumulator, optionalCatchAllParamName)
        }
        return Reflect.has(target, prop)
      },
      ownKeys(target) {
        // Enumeration means user code may branch on which params exist, so the
        // (possibly absent) optional param counts as read.
        accumulateVaryParam(accumulator, optionalCatchAllParamName)
        return Reflect.ownKeys(target)
      },
    })
  }

  const tracked = {} as Record<string, unknown>
  for (const paramName in originalParams) {
    Object.defineProperty(tracked, paramName, {
      get() {
        accumulateVaryParam(accumulator, paramName)
        return originalParams[paramName]
      },
      enumerable: true,
      configurable: true,
    })
  }
  markVaryTracking(tracked, info)
  return tracked as T
}

/**
 * An optional catch-all at its EMPTY value carries no param in Next - `/optional-catchall` renders with
 * `params` = `{}`, so `params.slug` is undefined and `'slug' in params` is false, which is how the
 * fixtures distinguish "no slug" from a real slug. pnext's matcher fills the key with an empty array,
 * which reads as a present-but-empty slug; strip it here, at the compat boundary that hands params to
 * user code, so the page, generateMetadata and the tracking traps all see Next's shape.
 *
 * A copy is returned only when the key needs removing; otherwise the original object passes through,
 * since identity matters for the tracking info's `raw`.
 */
export function normalizeOptionalCatchAllParams<T extends Record<string, unknown>>(
  params: T,
  optionalCatchAllParamName: string | null,
): T {
  if (optionalCatchAllParamName === null) return params
  const value = params[optionalCatchAllParamName]
  if (!Array.isArray(value) || value.length > 0) return params
  const { [optionalCatchAllParamName]: _empty, ...rest } = params
  return rest as unknown as T
}

/**
 * A `searchParams` object where ANY access - a read, an `in` check, or enumeration - records the `'?'`
 * sentinel. Search params have no fixed schema, so the segment is keyed by the whole query string rather
 * than per-key. A Proxy, not getters, is required so enumerating an EMPTY searchParams object still varies.
 */
export function createVaryingSearchParams<T extends Record<string, unknown>>(
  accumulator: VaryParamsAccumulator,
  originalSearchParams: T,
): T {
  const info: VaryTrackingInfo = {
    raw: originalSearchParams,
    kind: 'searchParams',
    optionalCatchAllParam: null,
  }
  return new Proxy(originalSearchParams, {
    get(target, prop, receiver) {
      if (prop === VARY_TRACKING) return info
      // `then` is probed by `await`/`Promise.resolve` on the wrapping promise;
      // searchParams never legitimately carries it as a protocol member, but a
      // real `?then=` query value must still read through as data. Only skip
      // the sentinel when the key is absent (the probe case).
      if (typeof prop === 'string' && !isPromiseProbe(target, prop)) {
        accumulateVaryParam(accumulator, SEARCH_PARAMS_SENTINEL)
      }
      return Reflect.get(target, prop, receiver)
    },
    has(target, prop) {
      if (typeof prop === 'string') accumulateVaryParam(accumulator, SEARCH_PARAMS_SENTINEL)
      return Reflect.has(target, prop)
    },
    ownKeys(target) {
      accumulateVaryParam(accumulator, SEARCH_PARAMS_SENTINEL)
      return Reflect.ownKeys(target)
    },
  })
}

/** True for a `then` read on an object that has no such key (promise probing). */
function isPromiseProbe(target: object, prop: string): boolean {
  return prop === 'then' && !Object.prototype.hasOwnProperty.call(target, prop)
}

// ---------------------------------------------------------------------------
// Finishing + publishing.
// ---------------------------------------------------------------------------

/**
 * Resolve every accumulator, merging the response's root params into each.
 * Call once rendering is complete. Accumulators left pending are treated as
 * "unknown vary params" by the client (it then keys on the exact URL).
 */
export function finishAccumulatingVaryParams(response: ResponseVaryParamsAccumulator): void {
  const rootVaryParams = response.rootParams.varyParams
  finishSegmentAccumulator(response.head, rootVaryParams)
  for (const segment of response.segments) finishSegmentAccumulator(segment, rootVaryParams)
  finishSegmentAccumulator(response.rootParams, emptySet)
}

function finishSegmentAccumulator(
  accumulator: VaryParamsAccumulator,
  rootVaryParams: VaryParams,
): void {
  if (accumulator.status !== 'pending') return
  const merged = new Set<string>(accumulator.varyParams)
  for (const param of rootVaryParams) merged.add(param)
  accumulator.value = merged
  accumulator.status = 'fulfilled'
  const resolvers = accumulator.resolvers
  accumulator.resolvers = []
  for (const resolve of resolvers) resolve(merged)
}

/**
 * The published vary sets of a finished response. `search` is the `'?'` sentinel
 * lifted out of the param lists (the client keys the query separately, so it
 * never appears as a param name in the wire form).
 */
export interface ResponseVaryParams {
  /**
   * Params the route BODY read, sorted - the UNION of page + layout. Kept as the whole-document key: an
   * `/_index` response carries layout AND page markup, so it is only byte-correct for a URL that matches
   * both sets. The split frames below are what let the client reuse one half of it.
   */
  params: string[]
  /** Params the PAGE (leaf) segment read, sorted. */
  page: string[]
  /** Params the LAYOUT segments read, sorted (union across the layout chain). */
  layout: string[]
  /** Params `generateMetadata`/`generateViewport` read, sorted. */
  head: string[]
  /** Params read through `next/root-params`, sorted. */
  root: string[]
  /** True when the body read searchParams in any way. */
  search: boolean
  /** True when the PAGE segment read searchParams. */
  pageSearch: boolean
  /** True when a LAYOUT segment read searchParams. */
  layoutSearch: boolean
  /** True when the head read searchParams in any way. */
  headSearch: boolean
}

export function collectResponseVaryParams(
  response: ResponseVaryParamsAccumulator,
): ResponseVaryParams {
  finishAccumulatingVaryParams(response)
  // w9-segment-split: the per-kind sets are collected SEPARATELY (no union at
  // the accumulator level). `params` is still published as their union, but
  // only as the whole-`/_index`-document key — the layout/page sets are the
  // ones the split frames key on.
  const body = new Set<string>()
  const page = new Set<string>()
  const layout = new Set<string>()
  for (const segment of response.segments) {
    const target = segment.kind === 'layout' ? layout : page
    for (const name of segment.value) {
      body.add(name)
      target.add(name)
    }
  }
  const head = new Set<string>(response.head.value)
  return {
    params: sortedParamNames(body),
    page: sortedParamNames(page),
    layout: sortedParamNames(layout),
    head: sortedParamNames(head),
    root: sortedParamNames(response.rootParams.value),
    search: body.has(SEARCH_PARAMS_SENTINEL),
    pageSearch: page.has(SEARCH_PARAMS_SENTINEL),
    layoutSearch: layout.has(SEARCH_PARAMS_SENTINEL),
    headSearch: head.has(SEARCH_PARAMS_SENTINEL),
  }
}

function sortedParamNames(set: VaryParams): string[] {
  return [...set].filter(name => name !== SEARCH_PARAMS_SENTINEL).sort()
}

/**
 * Run `produce` inside a fresh vary-params response scope and return its value
 * alongside the collected vary sets. Nested calls reuse the outer scope's
 * accumulator (a segment render nested inside another response must not start a
 * second, disconnected tracking scope).
 */
export async function withVaryParamsTracking<T>(
  produce: () => Promise<T>,
): Promise<{ value: T; vary: ResponseVaryParams }> {
  const outer = varyStorage.getStore()
  if (outer) return { value: await produce(), vary: collectResponseVaryParams(outer) }
  const response = createResponseVaryParamsAccumulator()
  const value = await varyStorage.run(response, produce)
  return { value, vary: collectResponseVaryParams(response) }
}

// ---------------------------------------------------------------------------
// Wire format.
//
// A vary set travels as a comma-separated name list; the search sentinel rides
// as the literal `?` entry (mirroring Next, which keeps it inside the set). An
// EMPTY list means "shareable across every param value"; an ABSENT field means
// "unknown" and the client falls back to exact-URL keying.
// ---------------------------------------------------------------------------

/** The wire payload emitted alongside a segment/tree response. */
export interface SegmentVaryPayload {
  /** Body-segment vary names (may include the `?` sentinel). */
  params: string[]
  /** Head-segment vary names (may include the `?` sentinel). */
  head: string[]
  /** Root-param vary names. */
  root?: string[]
  /** w9-segment-split: the PAGE frame's own vary names. */
  page?: string[]
  /** w9-segment-split: the LAYOUT frame's own vary names. */
  layout?: string[]
}

export function toSegmentVaryPayload(vary: ResponseVaryParams): SegmentVaryPayload {
  return {
    params: encodeVaryNames(vary.params, vary.search),
    head: encodeVaryNames(vary.head, vary.headSearch),
    page: encodeVaryNames(vary.page, vary.pageSearch),
    layout: encodeVaryNames(vary.layout, vary.layoutSearch),
    ...(vary.root.length > 0 ? { root: vary.root } : {}),
  }
}

function encodeVaryNames(names: readonly string[], search: boolean): string[] {
  return search ? [...names, SEARCH_PARAMS_SENTINEL] : [...names]
}

/**
 * Rebuild a `ResponseVaryParams` from the wire name lists a BAKED segment's
 * `.meta` sidecar persisted. The inverse of `varyNamesFor`: the `?` sentinel
 * comes back out as the search flag. Head/root sets are not persisted (the head
 * segment publishes its own), so they come back empty.
 */
export function responseVaryParamsFromWire(wire: {
  vary?: string[]
  layoutVary?: string[]
  pageVary?: string[]
}): ResponseVaryParams {
  const split = (names: readonly string[] | undefined): { names: string[]; search: boolean } => ({
    names: (names ?? []).filter(name => name !== SEARCH_PARAMS_SENTINEL),
    search: (names ?? []).includes(SEARCH_PARAMS_SENTINEL),
  })
  const body = split(wire.vary)
  const layout = split(wire.layoutVary)
  const page = split(wire.pageVary)
  return {
    params: body.names,
    page: page.names,
    layout: layout.names,
    head: [],
    root: [],
    search: body.search,
    pageSearch: page.search,
    layoutSearch: layout.search,
    headSearch: false,
  }
}

/** The wire vary names for one segment kind of a finished response. */
export function varyNamesFor(
  vary: ResponseVaryParams,
  kind: 'body' | 'head' | 'page' | 'layout',
): string[] {
  switch (kind) {
    case 'head':
      return encodeVaryNames(vary.head, vary.headSearch)
    case 'page':
      return encodeVaryNames(vary.page, vary.pageSearch)
    case 'layout':
      return encodeVaryNames(vary.layout, vary.layoutSearch)
    default:
      return encodeVaryNames(vary.params, vary.search)
  }
}
