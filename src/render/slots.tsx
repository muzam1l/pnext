/** @jsxImportSource preact */
import { AsyncLocalStorage } from 'node:async_hooks'
import { basename, join, relative, sep } from 'node:path'
import { h, type ComponentChildren, type ComponentType } from 'preact'
import type { RouteParamsSnapshot } from './island-context'
import { Suspense } from '../api/suspense'
import type { ClientReference } from '../client/reference'
import {
  consumedSegments,
  isGroupSegment,
  isSlotSegment,
  matchSegments,
  matchSlotInterceptor,
  pathnameSegments,
  slotConventionFile,
  slotDirectoriesIn,
  type SegmentMatch,
} from '../routing/slots'
import { toPosixPath } from '../utils/fs'
import { PROMISE_MARKER_KEY, revivePromiseMarkers } from '../utils/serialize'
import { getRenderExtensions } from '../extensions'
import type { PageProps, RouteManifestEntry, RouteParamValue, ServerComponent } from '../types'

interface SlotRenderOptions {
  config: { appPath: string }
  url: URL
  nav?: {
    soft?: boolean
    childrenPath?: string
    targetPath?: string
    state?: { childrenSearch?: string; slots?: Record<string, string> }
  }
  route: Pick<RouteManifestEntry, 'clientReferences' | 'slotDirs'>
  params?: Record<string, RouteParamValue>
  clientComponents?: Map<string, ComponentType<Record<string, unknown>>>
  slotStateOut?: Record<string, string>
  moduleLoader?: (file: string) => Promise<Record<string, unknown>> | Record<string, unknown>
}

interface ServerVNodeProps extends Record<string, unknown> {
  children?: ComponentChildren
}

interface PageModule {
  default?: ServerComponent<PageProps>
}

interface LayoutModule {
  default?: ServerComponent<{ children: ComponentChildren }>
}

interface LoadingModule {
  default?: ServerComponent<Record<string, never>>
}

interface SlotRenderDeps<Options extends SlotRenderOptions> {
  importModule: (file: string, options: Options) => Promise<Record<string, unknown>>
  markServerReference: <T>(component: T) => T
  clientReferenceStub: (reference: ClientReference) => ComponentType<Record<string, unknown>>
  createPageProps: (options: Options) => PageProps
}

export interface SlotContext<Options extends SlotRenderOptions = SlotRenderOptions> {
  options: Options
  deps: SlotRenderDeps<Options>
  appPath: string
  urlPath: string
  urlSegments: string[]
  /** The request's search string (`?a=b` or ''), `_rsc` union query stripped. */
  urlSearch: string
  childrenPath: string
  childrenSegments: string[]
  /** Search string the children tree renders with (host renders inherit it). */
  childrenSearch: string
  soft: boolean
  statePaths: Record<string, string>
  stateOut: Record<string, string>
  matches: ResolvedSlotMatch[]
}

export interface ResolvedSlotMatch {
  slotDir: string
  pageFile?: string
  layoutFiles: string[]
  params: Record<string, RouteParamValue>
}

export function createSlotContext<Options extends SlotRenderOptions>(
  options: Options,
  deps: SlotRenderDeps<Options>,
): SlotContext<Options> {
  const urlPath = trimPathname(options.nav?.targetPath ?? options.url.pathname)
  const childrenPath = trimPathname(options.nav?.childrenPath ?? options.url.pathname)
  const urlSearch = stripRscSearch(options.url.search)
  // A host render (children anchored away from the URL) keeps the children
  // tree's own recorded query; a direct render's children query IS the URL's.
  const childrenSearch =
    options.nav?.soft && childrenPath !== trimPathname(options.url.pathname)
      ? (options.nav?.state?.childrenSearch ?? '')
      : urlSearch
  return {
    options,
    deps,
    appPath: options.config.appPath,
    urlPath,
    urlSegments: pathnameSegments(urlPath),
    urlSearch,
    childrenPath,
    childrenSegments: pathnameSegments(childrenPath),
    childrenSearch,
    soft: Boolean(options.nav?.soft),
    statePaths: options.nav?.state?.slots ?? {},
    stateOut: options.slotStateOut ?? {},
    matches: [],
  }
}

function trimPathname(pathname: string) {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') || '/' : pathname
}

/** Split a recorded slot source (`pathname` or `pathname?query`) into parts. */
function sourceParts(source: string): { path: string; search: string } {
  const queryIndex = source.indexOf('?')
  if (queryIndex === -1) return { path: trimPathname(source), search: '' }
  return {
    path: trimPathname(source.slice(0, queryIndex)),
    search: source.slice(queryIndex),
  }
}

/** The router's `_rsc` union query is a CDN cache key, never an app param. */
function stripRscSearch(search: string): string {
  if (!search.includes('_rsc')) return search
  const params = new URLSearchParams(search)
  params.delete('_rsc')
  const stripped = params.toString()
  return stripped ? `?${stripped}` : ''
}

/** Render every `@slot` in `dir` into layout props. */
export async function renderDirSlots<Options extends SlotRenderOptions>(
  context: SlotContext<Options>,
  dir: string,
): Promise<Record<string, ComponentChildren>> {
  const slotDirs = slotDirectoriesIn(dir)
  if (slotDirs.length === 0) return {}
  const consumed = consumedSegments(context.appPath, dir)
  // A `[...catchAll]` layout greedily consumes every remaining URL segment (a catch-all is always the last
  // route segment), so any `@slot` it hosts matches at the index - the empty remaining path. Treat Infinity
  // as "all segments consumed" rather than skipping slot rendering, which would drop the slot entirely on a
  // catch-all route.
  const effectiveConsumed = Number.isFinite(consumed) ? consumed : context.childrenSegments.length
  const props: Record<string, ComponentChildren> = {}
  for (const slotDir of slotDirs) {
    const content = await resolveSlotContent(context, slotDir, effectiveConsumed)
    // An unmatched slot with no `default.*` stays a bare null: wrapping it in
    // the boundary marker would make it a truthy VNode, and an unmatched
    // `@children` slot must stay falsy so childrenFromSlots can fall back to
    // the segment-matched children tree.
    props[basename(slotDir).slice(1)] = content == null ? null : wrapSlotBoundary(content)
  }
  return props
}

async function resolveSlotContent<Options extends SlotRenderOptions>(
  context: SlotContext<Options>,
  slotDir: string,
  consumed: number,
): Promise<ComponentChildren> {
  const key = toPosixPath(relative(context.appPath, slotDir))

  // Interceptor targets are absolute paths, so the navigated URL applies to
  // them regardless of the chain's consumed prefix (that mismatch is exactly
  // what interception markers express). This only happens on a host render
  // (children anchored at the origin path while the URL shows the target);
  // when children == URL the server matched the real route and the slot must
  // not intercept it. Interceptors go before direct matching: an interception
  // route beats a catch-all inside the same slot.
  if (context.soft && context.urlPath !== context.childrenPath) {
    const intercepted = matchSlotInterceptor(context.appPath, slotDir, context.urlPath)
    if (intercepted) {
      context.stateOut[key] = context.urlPath + context.urlSearch
      return renderSlotMatch(context, slotDir, intercepted, context.urlSearch)
    }
  }

  // Each candidate source carries the search string its render uses: a slot
  // re-rendered from a RECORDED source keeps the query it was fetched with
  // (Next's per-segment refetch URL), not the current request's.
  const sources: { path: string; search: string }[] = []
  const pushSource = (path: string, search: string) => {
    if (!sources.some(source => source.path === path)) sources.push({ path, search })
  }
  const rawStateSource = context.statePaths[key]
  const stateSource = rawStateSource ? sourceParts(rawStateSource) : undefined
  const preserveForInterception =
    context.soft &&
    context.urlPath !== context.childrenPath &&
    context.options.route.slotDirs?.some(dir =>
      Boolean(matchSlotInterceptor(context.appPath, dir, context.urlPath)),
    )
  if (
    preserveForInterception &&
    stateSource &&
    segmentsSharePrefix(pathnameSegments(stateSource.path), context.childrenSegments, consumed)
  ) {
    pushSource(stateSource.path, stateSource.search)
  }
  if (segmentsSharePrefix(context.urlSegments, context.childrenSegments, consumed)) {
    pushSource(context.urlPath, context.urlSearch)
  }
  if (
    context.soft &&
    stateSource &&
    segmentsSharePrefix(pathnameSegments(stateSource.path), context.childrenSegments, consumed)
  ) {
    pushSource(stateSource.path, stateSource.search)
  }
  // Host renders (children anchored away from the URL) fall back to the
  // children path itself, so sibling slots keep matching the visible page even
  // without an explicit state entry.
  if (context.childrenPath !== context.urlPath) {
    pushSource(context.childrenPath, context.childrenSearch)
  }

  for (const source of sources) {
    const intercepted =
      context.soft && source.path !== context.urlPath
        ? matchSlotInterceptor(context.appPath, slotDir, source.path)
        : null
    const match =
      intercepted ?? matchSegments(slotDir, pathnameSegments(source.path).slice(consumed))
    if (!match) continue
    context.stateOut[key] = source.path + source.search
    return renderSlotMatch(context, slotDir, match, source.search)
  }

  const defaultFile = slotConventionFile(slotDir, 'default')
  if (!defaultFile) return null
  return renderSlotComponent(context, defaultFile, {})
}

/** Render a matched slot page inside its slot-internal layout chain. */
async function renderSlotMatch<Options extends SlotRenderOptions>(
  context: SlotContext<Options>,
  slotDir: string,
  match: SegmentMatch,
  sourceSearch?: string,
): Promise<ComponentChildren> {
  // A pageless match renders null children under the matched layout chain.
  let tree: ComponentChildren = match.file
    ? await renderSlotComponent(context, match.file, match.params, sourceSearch)
    : null

  // Wrap innermost-out: loading.* at the page's own dir suspends the page;
  // each dir's layout receives its own nested slots as props.
  const chain: string[] = [slotDir]
  for (const name of match.dirs) chain.push(join(chain[chain.length - 1]!, name))
  context.matches.push({
    slotDir,
    ...(match.file ? { pageFile: match.file } : {}),
    layoutFiles: chain.flatMap(dir => slotConventionFile(dir, 'layout') ?? []),
    params: match.params,
  })
  for (const dir of [...chain].reverse()) {
    const loadingFile = slotConventionFile(dir, 'loading')
    if (loadingFile) {
      const module = (await context.deps.importModule(
        loadingFile,
        context.options,
      )) as LoadingModule
      const Loading = context.deps.markServerReference(module.default)
      if (Loading) {
        tree = h(
          Suspense,
          { fallback: h(Loading as ComponentType<Record<string, never>>, {}) },
          tree,
        )
      }
    }
    const layoutFile = slotConventionFile(dir, 'layout')
    if (!layoutFile) continue
    const module = (await context.deps.importModule(layoutFile, context.options)) as LayoutModule
    const Layout = context.deps.markServerReference(module.default)
    if (!Layout) continue
    const nestedSlots = await renderDirSlots(context, dir)
    tree = h(Layout as ComponentType<ServerVNodeProps>, {
      ...slotPageProps(context, match.params, sourceSearch),
      ...nestedSlots,
      children: tree,
    })
  }
  // Any `'use client'` island rendered anywhere inside this slot subtree must
  // see the slot's own params (its dynamic / catch-all captures) from useParams,
  // not just the global route params. Wrap the subtree in a params scope so the
  // renderer stamps each island it resolves within it (see resolveServerTree's
  // paramsScopeSymbol handling + render/island-context.ts RouteParamsContext).
  return wrapSlotParamsScope({ ...(context.options.params ?? {}), ...match.params }, tree)
}

// ---------------------------------------------------------------------------
// Per-slot params scope (CORE seam for compat useParams inside a slot island).
//
// The scope is a marker VNode the server-tree resolver recognizes (via
// paramsScopeSymbol) and re-establishes as an async scope around resolving its
// children, so every island created deep inside the slot subtree captures the
// slot's resolved params. Mirrors the layout-segment scope above.
// ---------------------------------------------------------------------------

export const paramsScopeSymbol = Symbol.for('pnext.paramsScope')

const PARAMS_SCOPE_PROP = '__pnextParams'

const paramsSnapshotStorage = new AsyncLocalStorage<RouteParamsSnapshot>()

type ParamsScopeMarker = ((props: ServerVNodeProps) => ComponentChildren) & {
  [paramsScopeSymbol]?: true
}

const ParamsScopeMarker: ParamsScopeMarker = props => props.children
ParamsScopeMarker[paramsScopeSymbol] = true

// Parallel-route slot marker (task-boundary scoping). A named `@slot` subtree is wrapped in this marker so
// the server-tree resolver can arm the build prerender's task boundary ONLY while resolving slot content.
// That keeps the task-boundary abort - a slot that resolves in a task becomes a hole, matching Next - scoped
// to parallel-route slots, the shape it was designed for, and leaves every other <Suspense> baking its task
// work as before.

export const slotBoundarySymbol = Symbol.for('pnext.slotBoundary')

type SlotBoundaryMarker = ((props: ServerVNodeProps) => ComponentChildren) & {
  [slotBoundarySymbol]?: true
}

const SlotBoundaryMarker: SlotBoundaryMarker = props => props.children
SlotBoundaryMarker[slotBoundarySymbol] = true

/** Wrap a named parallel-route slot subtree in the task-boundary marker. */
export function wrapSlotBoundary(content: ComponentChildren): ComponentChildren {
  return h(SlotBoundaryMarker as ComponentType<ServerVNodeProps>, null, content)
}

/** Read the params for the slot scope active in the current async resolution. */
export function currentParamsSnapshot(): RouteParamsSnapshot | undefined {
  return paramsSnapshotStorage.getStore()
}

/** Run `fn` with the given slot params installed as the active params scope. */
export function runInParamsScope<T>(params: RouteParamsSnapshot, fn: () => T): T {
  return paramsSnapshotStorage.run(params, fn)
}

/** Read the params a params-scope marker VNode carries. */
export function paramsScopeParams(props: Record<string, unknown>): RouteParamsSnapshot {
  return (props[PARAMS_SCOPE_PROP] as RouteParamsSnapshot | undefined) ?? {}
}

function wrapSlotParamsScope(
  params: Record<string, RouteParamValue>,
  tree: ComponentChildren,
): ComponentChildren {
  return h(
    ParamsScopeMarker as ComponentType<ServerVNodeProps>,
    { [PARAMS_SCOPE_PROP]: params },
    tree,
  )
}

async function renderSlotComponent<Options extends SlotRenderOptions>(
  context: SlotContext<Options>,
  file: string,
  params: Record<string, RouteParamValue>,
  sourceSearch?: string,
): Promise<ComponentChildren> {
  const props = slotPageProps(context, params, sourceSearch)

  // A 'use client' page inside a slot renders as an island: the reference
  // stub becomes a hydrated boundary in resolveServerTree. Its promise props
  // (params/searchParams) travel as plain markers the island runtime revives.
  const reference = context.options.route.clientReferences.find(
    item => item.file === file && item.exportName === 'default',
  )
  if (reference) {
    const Component =
      context.options.clientComponents?.get(reference.id) ??
      context.deps.clientReferenceStub(reference)
    return h(Component, {
      params: promiseMarker(await props.params),
      searchParams: promiseMarker(await props.searchParams),
    })
  }

  const module = (await context.deps.importModule(file, context.options)) as PageModule
  const Component = context.deps.markServerReference(module.default)
  if (!Component) return null
  return h(Component as ComponentType<PageProps>, props)
}

export function promiseMarker(value: unknown) {
  return { [PROMISE_MARKER_KEY]: value ?? null }
}

/** The discriminator that makes a placeholder marker rewritable at serve time. */
const PROMISE_PLACEHOLDER_KEY = '__pnextParams'

/**
 * The wire placeholder for a request-API promise prop that a partial prerender must NOT await (see ppr.ts
 * `isHangingPromise`). The baked bytes carry no resolved param, and the discriminator names which request
 * value re-stamps it per serving request - `data-pnext-props` is the third param carrier next to
 * `window.__PNEXT_ROUTE__` and `data-pnext-params`, and all three must agree.
 */
export function promisePlaceholderMarker(kind: 'params' | 'searchParams') {
  return { [PROMISE_MARKER_KEY]: null, [PROMISE_PLACEHOLDER_KEY]: kind }
}

/** The serialized placeholder the serve-time re-stamp searches for. */
export function promisePlaceholderJson(kind: 'params' | 'searchParams'): string {
  return `{"${PROMISE_MARKER_KEY}":null,"${PROMISE_PLACEHOLDER_KEY}":"${kind}"}`
}

/**
 * Revive promise markers into thenables for the SSR pass of an island - the same walk the client
 * entry runs, so a nested marker is a promise on both sides rather than a bare object on one.
 */
export function revivePromiseProps(props: Record<string, unknown>) {
  return revivePromiseMarkers({ ...props }, getRenderExtensions().legacySyncProps)
}

function slotPageProps<Options extends SlotRenderOptions>(
  context: SlotContext<Options>,
  params: Record<string, RouteParamValue>,
  sourceSearch?: string,
): PageProps {
  const base = context.deps.createPageProps(context.options)
  // What createPageProps already resolves searchParams from: the children
  // tree's recorded query on a host render, the request's otherwise (see
  // childrenSourceSearchParams in renderer.ts).
  const baseSearch =
    context.soft && context.childrenPath !== trimPathname(context.options.url.pathname)
      ? context.childrenSearch
      : context.urlSearch
  return {
    ...base,
    params: Promise.resolve({ ...(context.options.params ?? {}), ...params }),
    // A slot rendered from a source whose query differs (a recorded refetch
    // URL, or the target URL's query on a host render) sees ITS source's
    // searchParams — mirrors Next's per-segment refetch semantics.
    ...(sourceSearch !== undefined && sourceSearch !== baseSearch
      ? { searchParams: fulfilledPromise(searchParamsObject(sourceSearch)) }
      : {}),
  }
}

// Repeated keys collect into arrays (Next's searchParams page-prop shape).
function searchParamsObject(search: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {}
  new URLSearchParams(search).forEach((value, key) => {
    if (key === '_rsc') return
    const current = result[key]
    if (current === undefined) result[key] = value
    else if (Array.isArray(current)) current.push(value)
    else result[key] = [current, value]
  })
  return result
}

// Pre-settled promise (status/value readable synchronously) so preact's use()
// does not suspend during streaming SSR — mirrors renderer.ts settledPromise
// (not imported: renderer.ts imports from this module).
function fulfilledPromise<T>(value: T): Promise<T> {
  const promise = Promise.resolve(value) as Promise<T> & { status?: string; value?: T }
  promise.status = 'fulfilled'
  promise.value = value
  return promise
}

function segmentsSharePrefix(a: string[], b: string[], length: number) {
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Layout-segment context (CORE seam for compat useSelectedLayoutSegment(s)).
//
// Each layout in the chain is rendered inside a scope carrying the ordered list
// of URL segments BELOW that layout's own directory. `useSelectedLayoutSegment(s)`
// (compat/next/navigation.ts) reads the active scope. Route groups are kept as
// literal `(group)` entries; a catch-all is a single joined string; a page (leaf)
// component renders with an empty list. The scope is request-render-scoped so
// concurrent renders never leak segments across each other.
// ---------------------------------------------------------------------------

export interface LayoutSegmentScope {
  segments: string[]
  appPath?: string
  layoutDir?: string
  slots?: Record<string, string>
}

const layoutSegmentStorage = new AsyncLocalStorage<LayoutSegmentScope>()

/**
 * Run `fn` inside a layout-segment scope. The synchronous portion of a layout's
 * body (where `useSelectedLayoutSegment(s)` is called, per hook rules) sees
 * `segments`; nested layouts install their own deeper scope which correctly
 * shadows this one across awaits (async_hooks propagation, like runWithRequest).
 */
export function runInLayoutSegmentScope<T>(
  segments: string[],
  fn: () => T,
  scope: Omit<LayoutSegmentScope, 'segments'> = {},
): T {
  return layoutSegmentStorage.run({ segments, ...scope }, fn)
}

/**
 * Snapshot the active layout scope for stamping onto a client island (see
 * render/island-context.ts). `depth` is how many segments the owning layout
 * consumes; `segments` is its resolved "below me" list; `slots` maps each of
 * the layout's OWN parallel-route slot keys to that slot's resolved segments.
 * Returns undefined outside any layout scope (e.g. a leaf page island).
 */
export function currentLayoutSegmentSnapshot():
  { depth: number; segments: string[]; slots: Record<string, string[]> } | undefined {
  const scope = layoutSegmentStorage.getStore()
  if (!scope) return undefined
  const slots: Record<string, string[]> = {}
  let depth = 0
  if (scope.appPath && scope.layoutDir) {
    depth = layoutSegmentDepth(scope.appPath, scope.layoutDir)
    const owner = toPosixPath(relative(scope.appPath, scope.layoutDir))
    const prefix = owner ? `${owner}/@` : '@'
    for (const [dir, path] of Object.entries(scope.slots ?? {})) {
      if (!dir.startsWith(prefix)) continue
      const key = dir.slice(prefix.length)
      if (key.includes('/')) continue
      slots[key] = pathnameSegments(path)
    }
  }
  return { depth, segments: scope.segments, slots }
}

/**
 * Whether a layout-segment scope is currently active. A server component in a
 * layout runs inside one (currentLayoutSegments reads it); an island rendered to
 * string does NOT (its scope closed during the resolve phase), so the compat
 * hook falls back to the island context instead. Distinguishes the two callers.
 */
export function hasLayoutSegmentScope(): boolean {
  return layoutSegmentStorage.getStore() !== undefined
}

/** The active layout's "segments below me", or `[]` outside any layout scope. */
export function currentLayoutSegments(slotKey?: string): string[] {
  const scope = layoutSegmentStorage.getStore()
  if (!scope) return []
  if (!slotKey) return scope.segments
  if (!scope.appPath || !scope.layoutDir) return []
  const owner = toPosixPath(relative(scope.appPath, scope.layoutDir))
  const slotPath = scope.slots?.[owner ? `${owner}/@${slotKey}` : `@${slotKey}`]
  return slotPath ? pathnameSegments(slotPath) : []
}

/**
 * The ordered URL segments from the app root down to the leaf, using the real
 * on-disk directory chain (so route groups appear as literal `(group)` entries),
 * with `[param]` dirs replaced by their decoded value, `[...catchall]` /
 * `[[...catchall]]` dirs replaced by the joined catch-all string, and slots
 * (`@name`) skipped. Empty optional catch-all contributes nothing.
 */
export function fullLayoutSegments(
  appPath: string,
  leafDir: string,
  params: Record<string, RouteParamValue>,
): string[] {
  const relativeDir = relative(appPath, leafDir)
  if (relativeDir.startsWith('..')) return []
  const segments: string[] = []
  for (const name of relativeDir.split(sep).filter(Boolean)) {
    if (isSlotSegment(name)) continue
    if (isGroupSegment(name)) {
      segments.push(name)
      continue
    }
    const optional = /^\[\[\.\.\.([^\]]+)\]\]$/.exec(name)
    const catchAll = optional ?? /^\[\.\.\.([^\]]+)\]$/.exec(name)
    if (catchAll?.[1]) {
      const value = params[catchAll[1]]
      const joined = Array.isArray(value) ? value.join('/') : (value ?? '')
      // An empty optional catch-all contributes no segment at all.
      if (joined) segments.push(joined)
      continue
    }
    const dynamic = /^\[([^\].]+)\]$/.exec(name)
    if (dynamic?.[1]) {
      const value = params[dynamic[1]]
      segments.push(Array.isArray(value) ? value.join('/') : String(value ?? ''))
      continue
    }
    segments.push(name)
  }
  return segments
}

/**
 * The params a layout at `layoutDir` receives: only those introduced by a
 * dynamic segment AT or ABOVE the layout's own directory (Next scopes params
 * per layout level). A catch-all param stays a JSON array; an EMPTY optional
 * catch-all contributes no key at all (so the layout renders no params object).
 * Params below the layout are excluded.
 */
export function layoutParamsForDir(
  appPath: string,
  layoutDir: string,
  params: Record<string, RouteParamValue>,
): Record<string, RouteParamValue> {
  const relativeDir = relative(appPath, layoutDir)
  if (relativeDir.startsWith('..')) return {}
  const scoped: Record<string, RouteParamValue> = {}
  for (const name of relativeDir.split(sep).filter(Boolean)) {
    if (isSlotSegment(name) || isGroupSegment(name)) continue
    const optional = /^\[\[\.\.\.([^\]]+)\]\]$/.exec(name)
    if (optional?.[1]) {
      const value = params[optional[1]]
      // Empty optional catch-all: omit entirely (no params object for the layout).
      if (value !== undefined && (Array.isArray(value) ? value.length > 0 : value != null)) {
        scoped[optional[1]] = value
      }
      continue
    }
    const catchAll = /^\[\.\.\.([^\]]+)\]$/.exec(name)
    if (catchAll?.[1]) {
      const value = params[catchAll[1]]
      if (value !== undefined) scoped[catchAll[1]] = value
      continue
    }
    const dynamic = /^\[([^\].]+)\]$/.exec(name)
    if (dynamic?.[1]) {
      const value = params[dynamic[1]]
      if (value !== undefined) scoped[dynamic[1]] = value
    }
  }
  return scoped
}

/**
 * Count how many entries of `fullLayoutSegments` a layout directory consumes
 * (i.e. the segments AT or ABOVE the layout). The "segments below me" a layout
 * receives is `full.slice(depthOfDir)`. Groups count as one entry (they are
 * present in the full list); slots count as zero.
 */
export function layoutSegmentDepth(appPath: string, layoutDir: string): number {
  const relativeDir = relative(appPath, layoutDir)
  if (relativeDir.startsWith('..') || relativeDir === '') return 0
  let depth = 0
  for (const name of relativeDir.split(sep).filter(Boolean)) {
    if (isSlotSegment(name)) continue
    depth += 1
  }
  return depth
}
