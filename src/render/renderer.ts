import { existsSync, readFileSync, statSync } from 'node:fs'
import { stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { drainPreplanBuilds } from '../runtime/vendor'
import {
  Component,
  Fragment,
  h,
  options as preactOptions,
  toChildArray,
  type ComponentChildren,
  type ComponentType,
  type VNode,
} from 'preact'
import renderToString, { renderToStringAsync } from 'preact-render-to-string'
import { renderToReadableStream } from 'preact-render-to-string/stream'
import {
  clientReferenceId,
  clientReferenceSymbol,
  ssrClientReference,
  type ClientComponent,
  type ClientReference,
} from '../client/reference'
import { clientEntryName } from '../client/chunk-name'
import { pathToFileHref, type ResolvedConfig } from '../config'
import { markErrorLogged } from '../utils/error-log'
import {
  devClientModuleHref,
  devServerModuleHref,
  importDevModule,
  importModuleOnce,
} from '../runtime/modules'
import { serverBundleTargetForRuntime } from '../runtime/loader'
import {
  getActionModuleExtensions,
  getActiveMetadataExtensions,
  getDocumentScriptExtensions,
  reportStreamBoundaryError,
  getFontExtensions,
  getRenderSpanExtensions,
  getStaticParamsExtensions,
  getStreamRouteExtensions,
  getSuspenseExtensions,
  nextCompatEnabled,
  reactCompatEnabled,
} from './hooks'
import {
  getCssExtensions,
  getRenderExtensions,
  getRequestExtensions,
  getRouterProtocolExtensions,
  reportRequestError,
  type SerializedError,
} from '../extensions'
import {
  assetHref,
  emitFontCssStylesheet,
  emittedAssetName,
  globalCssHref,
  registerCssRuntime,
  routeCssAssetNames,
  routeCssHref,
  withAssetPrefix,
} from '../css/build'
import { dynamicReferenceSymbol, type DynamicReference } from '../api/dynamic'
import {
  isForbiddenError,
  isNotFoundError,
  isRedirectError,
  isUnauthorizedError,
} from '../api/navigation'
import { Suspense } from '../api/suspense'
import { currentRequest, getWorkUnit, runWithRequest } from '../request/context'
import {
  awaitAtTaskBoundary,
  cacheComponents,
  completePrerender,
  currentPrerenderScope,
  hangingPromise,
  isCachedComponent,
  isCsrBailoutPrerender,
  isHangingPromise,
  isPrerendering,
  isPostpone,
  isRuntimePrefetchPrerender,
  isTaskBoundaryPrerender,
  isTaskPostpone,
  markRuntimeApiOnAwait,
  PostponeError,
  runInPrerender,
  runWithCsrBailout,
  runWithPrerenderDeterminism,
  runWithRuntimePrefetchSyncIoAbort,
  runWithTaskBoundaryArmed,
  runWithTaskBoundarySuspended,
  trackPrerenderDynamic,
} from './ppr'
import {
  collectFileCss,
  collectNotFoundCss,
  findConventionFiles,
  findGlobalError,
  findLayouts,
  serverActionsUnsupportedMessage,
} from '../routing/routes'
import { matchSegments, pathnameSegments, slotDirectoriesIn } from '../routing/slots'
import { getRequestRuntime } from '../routing/request-environment'
import { toNextRequest } from '../api/server'
import { assertNotTainted, isElementLike, serializeProps } from '../utils/serialize'
import {
  ISLAND_STATIC_CHILDREN_ATTRIBUTE,
  islandStaticChildren,
  plainIslandChildren,
} from './static-children'
import { islandStaticSlotProps } from './static-slots'
import {
  ISLAND_BOUNDARY_ERROR_DIGEST_ATTRIBUTE,
  ISLAND_BOUNDARY_ERROR_ELEMENT,
  ISLAND_BOUNDARY_ERROR_MESSAGE_ATTRIBUTE,
} from './boundary-error'
import { captureCacheScope, runWithCacheScope } from '../request/cache'
import { registerServerRuntime } from '../runtime/loader'
import { readText } from '../utils/fs'
import { traceEnabled } from '../utils/trace-flags'
import {
  flushDevProfileLines,
  formatProfileDuration,
  recordDevProfileLine,
} from '../utils/dev-profile'
import {
  applyStaticMetadata,
  assetLinkGroups,
  coerceString,
  headLinks,
  metadataIconLinks,
  metadataContext,
  metadataOnlyLinks,
  metadataTags,
  mergeMetadataEntries,
  mergeViewport,
  readModuleMetadata,
  readModuleViewport,
  themeColorTags,
  viewportContent,
  type MetadataExport,
  type MetadataRenderPage,
  type StylesheetLink,
  type ViewportExport,
  type MetadataEntry,
} from './metadata'
import {
  clearRenderBuffer,
  clearResourceHints,
  newRenderBufferFrame,
  RENDER_BUFFER_SCOPE,
  takeRenderBuffer,
  takeResourceHints,
  type RenderBufferFrame,
} from './resource-hints'
import {
  staticMetadataForPath,
  staticMetadataForPathFromFiles,
  staticMetadataForRoute,
  staticMetadataForRouteFromFiles,
  staticRouteMetadataKey,
  withDynamicMetadataRoutes,
  type StaticMetadataFile,
  type StaticMetadataForPath,
} from '../routing/metadata-files'
import {
  createSlotContext,
  currentLayoutSegmentSnapshot,
  currentParamsSnapshot,
  fullLayoutSegments,
  layoutParamsForDir,
  layoutSegmentDepth,
  paramsScopeParams,
  paramsScopeSymbol,
  promiseMarker,
  promisePlaceholderJson,
  promisePlaceholderMarker,
  renderDirSlots,
  revivePromiseProps,
  runInLayoutSegmentScope,
  runInParamsScope,
  slotBoundarySymbol,
  type ResolvedSlotMatch,
  type SlotContext,
} from './slots'
import {
  CsrBailoutContext,
  LayoutSegmentContext,
  RouteParamsContext,
  type LayoutSegmentSnapshot,
  type RouteParamsSnapshot,
} from './island-context'
import { escapeHtml } from '../utils/html'
import { internalErrorHtml, isPnextInternalError } from '../dev/internal-error'
import type {
  Metadata,
  MetadataLink,
  NavState,
  NextRequest,
  PageProps,
  PageSearchParams,
  RouteParamValue,
  RouteManifestEntry,
  ResourceHint,
  ServerComponent,
  ServerComponentResult,
  StaticModuleMetadata,
  Viewport,
} from '../types'

const useCacheJoinerPromiseSymbol = Symbol.for('pnext.compat.useCacheJoinerPromise')
// Prop marking a loading.js Suspense boundary that has ANOTHER loading boundary deeper in the
// tree: it resolves THROUGH in the streaming shell so the DEEPEST fallback is what the shell
// shows. A STRING key, not a symbol: preact's `h()` copies props with `for...in`, which skips
// symbol keys.
const LOADING_THROUGH_PROP = '__pnextLoadingThrough'
// Prop carrying a loading.js boundary's URL depth, stamped onto the streamed
// `<pnext-suspense>` marker as `data-pnext-loading-depth` so the soft-navigation runtime can
// tell whether the boundary sits INSIDE the changing subtree before painting a loading shell:
// one owned by a preserved shared ancestor must not re-arm.
const LOADING_DEPTH_PROP = '__pnextLoadingDepth'
const LOADING_DEPTH_ATTRIBUTE = 'data-pnext-loading-depth'

// The inline-suspense wire form carries no vnode props: preact writes the fallback between
// bare `<!--$s:ID-->` comments, so a loading.js boundary there cannot prove itself to the
// navigation runtime and its fallback never paints (searchparams-reuse-loading "should re-use
// the prefetched loading state"). Lead the fallback with this empty element instead;
// `anchorInlineSuspenseHoles` lifts its attribute onto the hole and drops it.
const LOADING_DEPTH_TAG = 'pnext-loading-depth'

/** Lead a loading.js fallback with its depth marker. Lifted onto the hole, scrubbed otherwise. */
function markInlineLoadingFallback(
  fallback: ComponentChildren,
  depth: number | undefined,
): ComponentChildren {
  if (depth === undefined) return fallback
  return h(
    Fragment,
    null,
    h(LOADING_DEPTH_TAG, { [LOADING_DEPTH_ATTRIBUTE]: String(depth) }),
    fallback,
  )
}

/** Drop depth markers no hole claimed - the marker wire form carries the attribute itself. */
function dropLoadingDepthMarkers(html: string): string {
  return html.includes(LOADING_DEPTH_TAG)
    ? html.replace(new RegExp(`<${LOADING_DEPTH_TAG}[^>]*></${LOADING_DEPTH_TAG}>`, 'g'), '')
    : html
}

/** The `data-pnext-loading-depth` attributes for a Suspense vnode, if any. */
function loadingDepthAttributes(props: unknown): Record<string, string> {
  const depth = (props as Record<string, unknown>)[LOADING_DEPTH_PROP]
  return typeof depth === 'number' ? { [LOADING_DEPTH_ATTRIBUTE]: String(depth) } : {}
}

// Server-action wire-protocol strings (see compat/actions/protocol.ts). Core
// only emits them into progressive-enhancement form markup + the island prop
// marker; the id VALUES are produced by the compat serializeServerActionProp
// extension. Duplicated here (like client.ts) so core carries no static
// import of the compat protocol module.
const ACTION_ID_FIELD = '$pnext_action_id'
const SUBMIT_ACTION_ID_FIELD = '$pnext_submit_action_id'
const ACTION_CLICK_ID_ATTR = 'data-pnext-action-click'
const FORM_STATE_FIELD = '$pnext_form_state'
const PROP_ACTION_MARKER = '$$pnextAction'
const PROP_ERROR_RESET_MARKER = '$$pnextErrorReset'

// Font collection scope (compat/next/font). Default (no compat) runs the
// callback untouched.
function runWithFontScope<T>(callback: () => T): T {
  return getFontExtensions().runWithFontScope(callback)
}

const rawTextRenderingInstalled = Symbol.for('pnext.raw-text-rendering-installed')
const actionSerializeScope = new AsyncLocalStorage<ActionSerializeState>()
// Owns the per-render buffer frame the compat bundles write into; see render/resource-hints.
const renderBufferScope = ((globalThis as Record<PropertyKey, unknown>)[RENDER_BUFFER_SCOPE] ??=
  new AsyncLocalStorage<RenderBufferFrame>()) as AsyncLocalStorage<RenderBufferFrame>
/** True while a render that SUSPENDS in place is running; see installRawTextRendering. */
const suspendingStreamScope = new AsyncLocalStorage<boolean>()

type PNextPreactOptions = typeof preactOptions & {
  [rawTextRenderingInstalled]?: true
  errorBoundaries?: boolean
}

// Preact escapes text children even inside style/script; raw-text elements need
// React-compatible server output.
function installRawTextRendering() {
  const pnextOptions = preactOptions as PNextPreactOptions
  if (pnextOptions[rawTextRenderingInstalled]) return
  pnextOptions[rawTextRenderingInstalled] = true
  // Let preact-render-to-string honor class error boundaries during SSR, so IslandBoundary can
  // bail an island whose stringification throws to a client-rendered placeholder instead of
  // failing the document. Scoped, not a plain `true`: an error boundary's subtree renders with
  // its suspense handler DISABLED, so a suspension thrown under one is captured as an error and
  // a user `getDerivedStateFromError` would swallow the whole streamed subtree. The streaming
  // passes opt out for their duration.
  Object.defineProperty(pnextOptions, 'errorBoundaries', {
    configurable: true,
    get: () => suspendingStreamScope.getStore() !== true,
  })
  const previousVNode = preactOptions.vnode?.bind(preactOptions)
  preactOptions.vnode = vnode => {
    previousVNode?.(vnode)
    applyRawTextChildren(vnode)
    applyServerActionFormVNode(vnode)
    applyLayoutSegmentSnapshot(vnode)
  }
}

const LAYOUT_SCOPE_PROP = '__pnextLayoutScope'
// Rides a client template's stub vnode into clientIslandVNode, which strips it
// and stamps the island host with `data-pnext-template` (see ClientIsland).
const TEMPLATE_MARKER_PROP = '__pnextTemplate'

// A `'use client'` island created inside a layout body runs within that layout's segment scope.
// Capture the scope snapshot onto the island vnode so the SSR pass and client mount can hand it to
// useSelectedLayoutSegment(s) - the island has no server scope of its own once hydrated.
function applyLayoutSegmentSnapshot(vnode: VNode) {
  const type = vnode.type as unknown
  if (typeof type !== 'function') return
  const marked = type as ClientComponent & { [dynamicReferenceSymbol]?: unknown }
  if (!marked[clientReferenceSymbol] && !marked[dynamicReferenceSymbol]) return
  const props = vnode.props as Record<string, unknown>
  if (props[LAYOUT_SCOPE_PROP]) return
  const snapshot = currentLayoutSegmentSnapshot()
  if (snapshot) props[LAYOUT_SCOPE_PROP] = snapshot
}

function applyRawTextChildren(vnode: VNode) {
  if (vnode.type !== 'style' && vnode.type !== 'script') return
  const props = vnode.props as Record<string, unknown>
  if (props.dangerouslySetInnerHTML || props.children == null) return
  const text = rawTextChildren(props.children)
  if (text === undefined) return
  props.dangerouslySetInnerHTML = {
    __html: vnode.type === 'style' ? escapeStyleText(text) : escapeScriptText(text),
  }
  props.children = null
}

function applyServerActionFormVNode(vnode: VNode) {
  const state = actionSerializeScope.getStore()
  if (!state) return
  const props = vnode.props as Record<string, unknown>

  if (vnode.type === 'form') {
    if (typeof props.action !== 'function') return
    const enhanced = serverActionFormProps(props, state)
    if (!enhanced) {
      delete props.action
      return
    }
    const originalChildren = props.children
    for (const key of Object.keys(props)) delete props[key]
    // Hidden fields render LAST so this island's SSR output matches what the client entry produces
    // on hydration (enhanceProgressiveForm appends the hidden id/state inputs) - reordering them
    // desyncs the two and drops sibling inputs.
    Object.assign(props, enhanced.props, {
      children: [originalChildren, ...enhanced.hidden],
    })
    return
  }

  // <button formAction={fn}> / <input formAction={fn}> submitters rendered
  // INSIDE a client island: the core server-tree walk (actionSubmitterVNode)
  // never runs for island subtrees, so enhance them here during preact's own
  // renderToString. Mirror actionSubmitterVNode so a no-JS submit posts the
  // action id (as the submitter's name/value pair) with a multipart method/
  // enctype override regardless of the surrounding form's own attributes.
  if (
    (vnode.type === 'button' || vnode.type === 'input') &&
    typeof props.formAction === 'function'
  ) {
    const id = actionIdForFunction(props.formAction, state)
    delete props.formAction // a function is not a valid attribute value
    if (!id) return
    props.name = SUBMIT_ACTION_ID_FIELD
    props.value = id
    props.formMethod = 'post'
    props.formEncType = 'multipart/form-data'
  }
}

function rawTextChildren(children: unknown): string | undefined {
  if (typeof children === 'string') return children
  if (typeof children === 'number' || typeof children === 'bigint') return String(children)
  if (!Array.isArray(children)) return undefined
  let text = ''
  for (const child of children) {
    if (child == null || typeof child === 'boolean') continue
    const part = rawTextChildren(child)
    if (part === undefined) return undefined
    text += part
  }
  return text
}

const styleTerminator = /(<\/|<)(s)(tyle)/gi
const scriptTerminator = /(<\/|<)(s)(cript)/gi

function escapeStyleText(text: string) {
  return text.replace(
    styleTerminator,
    (_, prefix: string, s: string, suffix: string) =>
      `${prefix}${s === 's' ? '\\73 ' : '\\53 '}${suffix}`,
  )
}

function escapeScriptText(text: string) {
  return text.replace(
    scriptTerminator,
    (_, prefix: string, s: string, suffix: string) =>
      `${prefix}${s === 's' ? '\\u0073' : '\\u0053'}${suffix}`,
  )
}

/** Soft-navigation context for a render (see routing/slots.ts). */
export interface RenderNavOptions {
  /** The request is a client soft navigation. */
  soft?: boolean
  /** Previous render state echoed by the client. */
  state?: NavState
  /**
   * Pathname the children tree renders from. Differs from `url` when an
   * interception or slot-state host render keeps the current page visible
   * while the address bar shows the navigated URL.
   */
  childrenPath?: string
  /** Internal target pathname after rewrites. */
  targetPath?: string
}

interface RenderOptions {
  config: ResolvedConfig
  route: RouteManifestEntry
  params?: Record<string, RouteParamValue>
  url: URL
  request?: Request
  dev?: boolean
  devImportVersion?: string
  layoutFiles?: string[]
  clientComponents?: ClientComponentMap
  clientComponentsPreload?: Promise<ClientComponentMap>
  moduleLoader?: (file: string) => Promise<Record<string, unknown>> | Record<string, unknown>
  clientModuleLoader?: (file: string) => Promise<Record<string, unknown>> | Record<string, unknown>
  staticMetadataFiles?: StaticMetadataFile[]
  staticModuleMetadata?: Record<string, StaticModuleMetadata>
  staticRouteMetadata?: Record<string, StaticMetadataForPath>
  status?: number
  partial?: PartialState
  /**
   * Build a param-independent fallback shell: `params` (and `searchParams`) are
   * hanging promises, so a page that awaits them inside a <Suspense> postpones
   * that boundary while a page that reads them at the top level blocks the
   * prerender (no fallback shell). Stage C cacheComponents fallback-shells.
   */
  fallbackParams?: boolean
  /**
   * Sub-shell: a subset of leading route params is CONCRETE (a prerendered prefix); the rest
   * hang. Reading a concrete param resolves, reading an unfilled one postpones its boundary.
   * Implies fallbackParams; a key set covering all route params makes it a full prerender.
   */
  fallbackConcreteParams?: Record<string, RouteParamValue>
  /** Full param-key set the route defines; the keys NOT in fallbackConcreteParams hang. */
  fallbackParamKeys?: string[]
  nav?: RenderNavOptions
  /** Collects each slot's resolved source path during layout application. */
  slotStateOut?: Record<string, string>
  /**
   * Request-time shell regeneration (stale-shell rebake, segment refresh): same partial prerender
   * but with REAL Date/Math.random - the deterministic clock exists for byte-stable builds, and
   * freezing it at runtime bakes epoch dates and seeded randoms into revalidated output.
   */
  runtimeRegen?: boolean
  /**
   * A `runtimeRegen` render that must KEEP the build-time task-boundary postpone discipline.
   * The promotion fills concrete params, but any boundary whose child depends on uncached
   * request-time I/O must stay a hole - otherwise the upgrade awaits that I/O and bakes a
   * request-specific result into the cached shell, freezing it for every later request.
   * Distinct from ISR stale-shell regen, which runs unbounded to bake refreshed data.
   */
  boundedRegen?: boolean
  /**
   * A confirmation render whose output is only compared, never kept: it must NOT persist its
   * resume-data sidecar, which would double-write or overwrite the base shell's sidecar for an
   * upgrade that is ultimately rejected.
   */
  probeShell?: boolean
  /**
   * This shell prerender produces the PREFETCH body segment, not the document served for a
   * direct request. Short-lived `use cache` scopes (stale below the client's prefetch
   * threshold) are omitted - their boundary keeps its fallback and the navigation fetches live.
   */
  prefetchShell?: boolean
}

interface PageModule {
  default?: ServerComponent<PageProps>
  metadata?: MetadataExport
  viewport?: ViewportExport
  params?: () => Promise<Record<string, RouteParamValue>[]> | Record<string, RouteParamValue>[]
}

interface LayoutModule {
  default?: ServerComponent<{ children: ComponentChildren }>
  metadata?: MetadataExport
  viewport?: ViewportExport
}

interface LoadingModule {
  default?: ServerComponent<Record<string, never>>
}

interface ErrorModule {
  default?: ServerComponent<{ error: Error; reset?: () => void; unstable_retry?: () => void }>
}

interface ServerVNodeProps extends Record<string, unknown> {
  children?: ComponentChildren
}

type ServerVNode = VNode<ServerVNodeProps>

interface PageRender {
  shell: 'generated' | 'layout' | 'global-error'
  body: string
  htmlProps: Record<string, unknown>
  bodyProps: Record<string, unknown>
  head: string
  metadata: Metadata
  stylesheets: StylesheetLink[]
  modulePreloads?: string[]
  dynamicScriptPreloads?: string[]
  resourceHints?: ResourceHint[]
  staticMetadata?: StaticMetadataForPath
  fontPreloads: MetadataLink[]
  propsScript: string
  routeScript: string
  clientScript: string
  /** The route mounts a client tree (whole-page client route or islands). */
  hasClientMounts?: boolean
  devScript: string
  streamChunks: Promise<string>[]
  /** Chunks written AFTER `</html>` (late metadata); no document consumer waits on them. */
  lateChunks?: Promise<string>[]
  status?: number
  headers?: HeadersInit
  viewport: Viewport
  fontCss: string
  bodyIconLinks?: string
  compatBodyScript?: string
  /** Inlined CSS (`<style>`); sits with the stylesheet links, ahead of every head script. */
  headStyles?: string
  headScripts?: string
  documentHeadTags?: string
  metadataUrl?: string
  /** next/script afterInteractive/lazyOnload bootstrap; see renderDeferredScriptRuntime. */
  deferredScripts?: string
  /** CSP nonce parsed off the (possibly middleware-set) request; see documentNonce/stampDocumentNonce. */
  nonce?: string
}

interface LayoutRender {
  tree: ComponentChildren
  metadata: MetadataEntry[]
  runtimeMetadata: boolean
  /** A layout's `generateMetadata` awaited real I/O, so the shell would have flushed without it. */
  metadataMissedFlush: boolean
  slotMatches: ResolvedSlotMatch[]
  viewport: Viewport[]
  documentLayoutFile?: string
}

interface LoadedLayout {
  file: string
  module: LayoutModule
}

interface StreamState {
  nextId: number
  deferred: Promise<string>[]
  dev: boolean
  options: RenderOptions
  clientComponents: ClientComponentMap
  clientReferences: ClientReferenceMap
  clientPageStream?: boolean
  // True until the document `<html>` shell is located. A root layout may wrap
  // its `<html>` in a Suspense (e.g. to force a route dynamic); the html shell
  // cannot be stream-replaced, so such a boundary must block instead of
  // flushing its fallback and deferring the real content.
  shellPending?: boolean
  // Stream every Suspense boundary IN PLACE (one preact render that suspends
  // and resumes) instead of flushing an out-of-order replacement chunk rendered
  // from a fresh root. Required when an ancestor layout/template is a client
  // component: a separate chunk render sits outside its providers. See
  // inlineSuspenseBoundary.
  inlineSuspense?: boolean
  // Server-inserted HTML (CSS-in-JS registries) drained at the moment the shell finished rendering.
  // It belongs in the document head, so it is captured here rather than left for the deferred
  // tail's own drain - the tail's async body starts before the caller assembles the head and would
  // otherwise win the race and flush the shell's styles into the body.
  insertedHead?: string
}

interface ResolveState {
  options: RenderOptions
  clientComponents: ClientComponentMap
  clientReferences: ClientReferenceMap
  partial?: PartialState
  /** Nearest Suspense fallback for a static client-rendering bailout. */
  csrBailoutFallback?: ComponentChildren
  /**
   * Static-skeleton pass for a postponed boundary: a server component that
   * postpones resolves to null instead of failing the pass, so the boundary's
   * static wrapper markup (elements around the dynamic access) still renders.
   * See renderStaticSkeleton.
   */
  swallowPostpones?: boolean
  /**
   * Counts postpones swallowed by the skeleton pass. A boundary slot whose
   * count did not move rendered WITHOUT any dynamic access, so its build-time
   * bytes are final and the request-time resume can skip it entirely (see
   * renderStaticSkeleton / resolvePartialSuspense's request branch).
   */
  swallowedPostpones?: { count: number }
}

// Partial prerendering state threaded through resolveServerTree. Suspense
// boundaries are numbered in pre-order identically at build and request time so
// the dynamic-hole ids recorded during the build shell line up with the
// replacement chunks emitted per request. See src/ppr.ts.
type BuildPartialState = Extract<PartialState, { mode: 'build' }>

type PartialState =
  // shellPending mirrors StreamState.shellPending: true until the document
  // `<html>` shell is located. A root layout may wrap its `<html>` in a Suspense
  // (e.g. `<Suspense><html>…`); that boundary must resolve THROUGH rather than
  // becoming a dynamic hole, since the html shell cannot be a streamed hole.
  | {
      mode: 'build'
      nextId: number
      holes: number[]
      metadataDynamic: boolean
      shellPending?: boolean
      clientOnly?: boolean
    }
  | {
      mode: 'request'
      nextId: number
      known: Set<number>
      chunks: string[]
      metadataDynamic: boolean
      shellPending?: boolean
      /**
       * Per-hole map of the boundary slots the served shell already carries as
       * build-time bytes (parsed back out of the shell's
       * `<template data-pnext-static>`), so the resume re-renders only the
       * genuinely dynamic slots. See parseStaticSlots.
       */
      staticSlots?: Map<number, StaticSlotInfo>
    }

/** A postponed boundary's build-time slot map: which of `count` slots are final. */
interface StaticSlotInfo {
  count: number
  slots: Set<number>
}

type ClientComponentMap = Map<string, ComponentType<Record<string, unknown>>>
type ClientReferenceMap = Map<string, ClientReference>
type ServerReference = ServerComponent<ServerVNodeProps> & {
  [serverReferenceSymbol]?: true
}
const serverReferenceSymbol = Symbol.for('pnext.serverReference')
const loggedBuildErrors = new WeakSet<Error>()
const loggedRuntimeErrors = new WeakSet<Error>()
const pageRootProps = {
  id: 'pnext-page',
  style: { width: '100%', height: '100%' },
}
const pageSlotProps = {
  id: 'pnext-page',
  style: { display: 'contents' },
}
interface ModuleLoadOptions {
  config: ResolvedConfig
  route?: RouteManifestEntry
  dev?: boolean
  devImportVersion?: string
  moduleLoader?: (file: string) => Promise<Record<string, unknown>> | Record<string, unknown>
  clientModuleLoader?: (file: string) => Promise<Record<string, unknown>> | Record<string, unknown>
}

function moduleHref(file: string, options: ModuleLoadOptions) {
  const conditionTarget = serverBundleTargetForRuntime(options.route?.segmentConfig?.runtime)
  return options.dev
    ? devServerModuleHref(options.config, file, options.devImportVersion ?? String(Date.now()), {
        conditionTarget,
      })
    : reactCompatEnabled(options.config)
      ? devServerModuleHref(options.config, file, 'build', { conditionTarget })
      : pathToFileHref(file)
}

function clientModuleHref(file: string, options: ModuleLoadOptions) {
  return reactCompatEnabled(options.config)
    ? devClientModuleHref(
        options.config,
        file,
        options.dev ? (options.devImportVersion ?? String(Date.now())) : 'build',
        // Pages-router page files SSR under Next's pages server conditions
        // (node / edge-light+browser, no react-server); devClientModuleHref
        // derives that per-file from the route's runtime target.
        serverBundleTargetForRuntime(options.route?.segmentConfig?.runtime),
      )
    : moduleHref(file, options)
}

async function importModule(file: string, options: ModuleLoadOptions) {
  // Re-throw a module's FIRST evaluation error on every later request rather
  // than the downstream symptom a half-evaluated module produces.
  let module: Record<string, unknown>
  if (options.moduleLoader) module = await options.moduleLoader(file)
  else if (options.dev) {
    module = await importDevModule<Record<string, unknown>>(await moduleHref(file, options))
  } else {
    const href = await moduleHref(file, options)
    await drainPreplanBuilds()
    module = await importModuleOnce<Record<string, unknown>>(href)
  }
  // Tag any 'use server' action module's exports with their wire id so
  // <form action={fn}> can progressively enhance. Compat-owned; a no-op for a
  // pure-core app (and for non-action modules).
  getActionModuleExtensions().tagActionModuleExports(options.config, file, module)
  return module
}

async function importClientModule(file: string, options: ModuleLoadOptions) {
  if (options.clientModuleLoader) return options.clientModuleLoader(file)
  if (options.moduleLoader) return options.moduleLoader(file)
  const href = await clientModuleHref(file, options)
  if (options.dev) return importDevModule<Record<string, unknown>>(href)
  await drainPreplanBuilds()
  return importModuleOnce<Record<string, unknown>>(href)
}

function clientScriptPath(route: RouteManifestEntry, dev?: boolean) {
  return dev
    ? `/__pnext/client/${route.id}.js`
    : `/${route.clientEntry ?? `assets/${clientEntryName(route)}.js`}`
}

function clientAssetPath(config: ResolvedConfig, asset: string) {
  const pathname = asset.startsWith('/') ? asset : `/${asset}`
  return nextCompatEnabled(config) && pathname.startsWith('/assets/')
    ? `/_next/static/${pathname.slice('/assets/'.length)}`
    : pathname
}

function needsClientEntry(route: RouteManifestEntry) {
  return route.client || route.clientReferences.length > 0 || Boolean(route.needsRouterEntry)
}

interface DocumentParts {
  shell: 'generated' | 'layout'
  htmlProps: Record<string, unknown>
  bodyProps: Record<string, unknown>
  head: string
  body: string
}

interface DocumentPage extends MetadataRenderPage {
  shell: 'generated' | 'layout' | 'global-error'
  body: string
  htmlProps: Record<string, unknown>
  bodyProps: Record<string, unknown>
  head: string
  propsScript: string
  routeScript: string
  clientScript: string
  hasClientMounts?: boolean
  devScript: string
  viewport: Viewport
  fontCss: string
  bodyIconLinks?: string
  bodyMetadata?: string
  /** Document metadata lives below the fold (streamed or deferred), so the head must not carry it. */
  metadataInBody?: boolean
  compatBodyScript?: string
  headStyles?: string
  headScripts?: string
  documentHeadTags?: string
  deferredScripts?: string
  nonce?: string
}

interface RenderTreeExtra {
  propsScript?: string
  status?: number
  viewport?: Viewport
  pageMetadataDir?: string
  /** The anchor page file whose metadata `pageMetadata` was read from. */
  pageFile?: string
  runtimePageMetadata?: boolean
  preferSlotMetadata?: boolean
  /**
   * Stream the viewport's theme-color with the request-time metadata chunk instead of emitting it
   * in the document head. Set only when the not-found boundary's metadata is deferred to request
   * time - an ordinary PPR route keeps its head theme-color and would get a duplicate tag.
   */
  viewportInBody?: boolean
}

function renderDocument(page: DocumentPage) {
  if (page.shell === 'global-error') return page.body
  return `${renderDocumentStart(page)}${renderDocumentEnd()}`
}

// Emit a `<title>` only when a title actually resolved. Next never injects a
// placeholder title: when a route has no metadata title it renders none, letting
// a `<title>` authored directly in the (root) layout's `<head>` stand as the sole
// title (app/index `$('title').first()` asserts exactly that layout title).
function titleTag(title: unknown): string {
  const value = coerceString(title)
  return value ? `<title>${escapeHtml(value)}</title>` : ''
}

// Head order, taken from React's Fizz preamble (Next inherits it verbatim): charset, preconnects,
// the viewport meta, font/high-priority-image preloads, the precedence-ordered stylesheets, the bulk
// preloads, then the bootstrap scripts. Everything registered AFTER that preamble flushes - late
// preloads, and every ordinary <meta>/<title>/metadata <link>, which React hoists rather than writes
// into the preamble - follows in encounter order.
//
// This only reorders the asset links; the head-vs-body split is untouched, so
// metadataOnlyLinks still travel with the metadata and never appear when it streams into the body.
function renderDocumentStart(page: DocumentPage) {
  const rendered = page.shell === 'layout' ? page.body : `<main data-pnext-root>${page.body}</main>`
  const slotMode = pageSlotMarkerMode(page)
  const body = unwrapUnusedPageSlot(rendered, slotMode)
  const viewport = viewportContent(page.viewport)
  const context = metadataContext(page)
  const headPage = page.bodyIconLinks
    ? { ...page, metadata: { ...page.metadata, icons: undefined }, suppressIconLinks: true }
    : page
  const [connects, preloads, stylesheets, bulkPreloads, lateHints] = assetLinkGroups(headPage)
  // Joined with the empty slots dropped: a head with no fonts/hints/inline CSS used to ship a blank
  // line per unused slot, and the bucket split multiplies them.
  const head = [
    '<meta charSet="utf-8"/>',
    connects,
    `<meta name="viewport" content="${escapeHtml(viewport)}"/>`,
    preloads,
    page.fontCss ? `<style data-pnext-font>${page.fontCss}</style>` : '',
    page.headStyles,
    stylesheets,
    bulkPreloads,
    page.headScripts,
    lateHints,
    page.documentHeadTags,
    page.viewport.colorScheme
      ? `<meta name="color-scheme" content="${escapeHtml(page.viewport.colorScheme)}"/>`
      : '',
    themeColorTags(page.viewport.themeColor),
    page.metadataInBody ? '' : titleTag(page.metadata.title),
    page.metadataInBody ? '' : metadataTags(page.metadata, context),
    page.metadataInBody ? '' : metadataOnlyLinks(headPage, context),
    page.head,
  ]
    .filter(Boolean)
    .join('\n    ')
  // Next emits the doctype and <html> on one line; tests match /^<!DOCTYPE html><html/.
  const html = `<!DOCTYPE html><html${documentAttrs(page.htmlProps, page.metadata.lang ? { lang: page.metadata.lang } : {})}>
  <head>
    ${head}
  </head>
  <body${documentAttrs(page.bodyProps)}>
    ${body}
    ${islandMarkerBootstrapTag(slotMode)}
    ${page.bodyMetadata ?? ''}
    ${page.bodyIconLinks ?? ''}
    ${page.bodyIconLinks ? iconInsertionScript() : ''}
    ${page.compatBodyScript ?? ''}
    ${page.propsScript}
    ${page.routeScript}
    ${page.clientScript}
    ${page.deferredScripts ?? ''}
    ${page.devScript}`
  return dropLoadingDepthMarkers(stampDocumentNonce(html, page.nonce))
}

// CSP nonce stamping. A nonce on the request's Content-Security-Policy header is applied,
// after the whole document is assembled, to every emitted `<script>` and every
// preload/modulepreload `<link>` that does not already carry an explicit one - an explicit
// nonce always wins. React stamps every float-emitted tag at emission; pnext has no single
// float registry to hook, so the stamp runs once over the assembled head+body instead.
function documentNonce(request: Request | undefined): string | undefined {
  const csp =
    request?.headers.get('content-security-policy') ??
    request?.headers.get('content-security-policy-report-only')
  if (!csp) return undefined
  for (const directive of csp.split(';')) {
    for (const token of directive.trim().split(/\s+/)) {
      const match = /^'nonce-([^']+)'$/.exec(token)
      if (match?.[1]) return match[1]
    }
  }
  return undefined
}

function stampDocumentNonce(html: string, nonce: string | undefined): string {
  if (!nonce) return html
  const attr = ` nonce="${escapeHtml(nonce)}"`
  return html
    .replace(/<script\b[^>]*>/g, tag =>
      /\bnonce=/.test(tag) ? tag : tag.replace('<script', `<script${attr}`),
    )
    .replace(/<link\b[^>]*>/g, tag =>
      /\brel="(?:preload|modulepreload)"/.test(tag) && !/\bnonce=/.test(tag)
        ? tag.replace('<link', `<link${attr}`)
        : tag,
    )
}

function renderDocumentEnd() {
  // The closing tags flush as one chunk with no interior whitespace so a
  // streamed document ends with exactly `</body></html>` (Next's byte-exact
  // document tail; asserted by the PPR partial-hydration stream-order suite).
  return `
  </body></html>`
}

function metadataBodyHtml(page: MetadataRenderPage) {
  const context = metadataContext(page)
  return [
    titleTag(page.metadata.title),
    metadataTags(page.metadata, context),
    headLinks(page, context),
  ]
    .filter(Boolean)
    .join('\n    ')
}

function metadataRedirectHtml(location: string, status: number) {
  const seconds = status === 308 ? 0 : 1
  const scriptLocation = JSON.stringify(location).replace(/</g, '\\u003c')
  return `<meta id="__next-page-redirect" http-equiv="refresh" content="${seconds};url=${escapeHtml(location)}"/>
    <script>location.replace(${scriptLocation})</script>`
}

async function readDocumentLayout(
  rendered: ComponentChildren,
  documentLayoutFile: string,
  state?: ActionSerializeState,
  renderBody: (vnode: VNode, state?: ActionSerializeState) => Promise<string> = renderVNodeToString,
): Promise<DocumentParts> {
  const html = documentHtmlVNode(rendered)
  const htmlChildren = html ? toChildArray(html.props.children) : []
  const head = htmlChildren.find(child => isVNode(child) && child.type === 'head')
  const body = htmlChildren.find(child => isVNode(child) && child.type === 'body')
  // A root layout that does not return <html>/<body> (a bare fragment) is not fatal in Next - it
  // renders the layout's content into a generated document shell instead of erroring. Fall back to
  // the same generated shell used when no document layout file exists at all.
  if (!html || !isVNode(body)) {
    return {
      shell: 'generated',
      htmlProps: {},
      bodyProps: {},
      head: '',
      body: await renderBody(h(Fragment, null, rendered), state),
    }
  }

  return {
    shell: 'layout',
    htmlProps: cleanDocumentProps(html.props),
    bodyProps: cleanDocumentProps(body.props),
    head: isVNode(head) ? await renderToStringAsync(h(Fragment, null, head.props.children)) : '',
    body: await renderBody(h(Fragment, null, body.props.children), state),
  }
}

function documentHtmlVNode(rendered: ComponentChildren): ServerVNode | undefined {
  if (isVNode(rendered) && rendered.type === 'html') return rendered
  const children = toChildArray(rendered)
  return children.length === 1 && isVNode(children[0]) && children[0].type === 'html'
    ? children[0]
    : undefined
}

function documentShellChildren(rendered: ComponentChildren) {
  const children = toChildArray(rendered)
  return (
    children.some(child => isVNode(child) && child.type === 'head') &&
    children.some(child => isVNode(child) && child.type === 'body')
  )
}

function cleanDocumentProps(props: Record<string, unknown>) {
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(props)) {
    if (
      key === 'children' ||
      key === 'dangerouslySetInnerHTML' ||
      key === 'suppressHydrationWarning' ||
      key === 'key' ||
      key === 'ref'
    ) {
      continue
    }
    next[key] = value
  }
  return next
}

interface CollectedHeadScript {
  props: Record<string, unknown>
  content?: string
}

function clearHeadScripts() {
  clearRenderBuffer('head')
}

function takeHeadScripts() {
  return takeRenderBuffer<CollectedHeadScript>('head')
}

function renderCollectedHeadScripts() {
  return takeHeadScripts().map(renderCollectedHeadScript).join('\n    ')
}

function renderCollectedHeadScript(script: CollectedHeadScript) {
  const attrs = Object.entries(script.props)
    .flatMap(([key, value]) => scriptHeadAttr(documentAttrName(key), value))
    .join(' ')
  const open = attrs ? `<script ${attrs}>` : '<script>'
  return script.content === undefined
    ? `${open}</script>`
    : `${open}${escapeScriptText(script.content)}</script>`
}

function scriptHeadAttr(name: string, value: unknown): string[] {
  if (name === 'strategy' || name === 'dangerouslysetinnerhtml' || name.startsWith('on')) {
    return []
  }
  return documentAttr(name, value)
}

// next/script afterInteractive/lazyOnload scripts (compat/next/script.tsx is the sole producer
// via this well-known global). Next never SSRs the actual <script> tag for these strategies -
// the real element is created client-side once its hydration bootstrap has run, so a script
// that mutates shared state lands after earlier client-component effects rather than racing
// them. pnext has no per-<Script> island for a bare usage inside a Server Component tree, so
// `renderDeferredScriptRuntime` emits one shared bootstrap instead.
interface CollectedDeferredScript {
  strategy: 'afterInteractive' | 'lazyOnload'
  attrs: Record<string, string>
  id?: string
  src?: string
  content?: string
}

function clearDeferredScripts() {
  clearRenderBuffer('deferred')
}

function takeDeferredScripts(): CollectedDeferredScript[] {
  return takeRenderBuffer<CollectedDeferredScript>('deferred')
}

// A `type="module"` script, deferred like the hydration entry and ordered after it, so any
// client component it mounted has already rendered by the time this runs. Creates the real
// <script> elements via the DOM (never innerHTML, which the browser refuses to execute):
// immediately for afterInteractive, after `window.load` + an idle callback for lazyOnload.
// Nonce stamping happens later in stampDocumentNonce, so this tag starts unnonced.
function renderDeferredScriptRuntime(scripts: CollectedDeferredScript[]): string {
  if (scripts.length === 0) return ''
  const payload = JSON.stringify(scripts).replace(/</g, '\\u003c')
  return (
    `<script type="module">(function(items){` +
    `function make(item){` +
    `var el=document.createElement('script');` +
    `for(var k in item.attrs)el.setAttribute(k,item.attrs[k]);` +
    `el.setAttribute('data-nscript',item.strategy);` +
    `if(item.id)el.id=item.id;` +
    `if(item.src)el.src=item.src;` +
    `else if(item.content!==undefined)el.textContent=item.content;` +
    `return el}` +
    `var after=items.filter(function(i){return i.strategy!=='lazyOnload'});` +
    `var lazy=items.filter(function(i){return i.strategy==='lazyOnload'});` +
    `var run=function(){` +
    `after.forEach(function(i){document.body.appendChild(make(i))});` +
    `if(lazy.length){` +
    `var idle=function(){lazy.forEach(function(i){document.body.appendChild(make(i))})};` +
    `var load=function(){typeof requestIdleCallback==='function'?requestIdleCallback(idle):setTimeout(idle,1)};` +
    `if(document.readyState==='complete')load();else window.addEventListener('load',load,{once:true})` +
    `}};` +
    `if(window.__NEXT_HYDRATED)run();else window.addEventListener('pnext:hydrated',run,{once:true});` +
    `})(${payload})</script>`
  )
}

function documentAttrs(props: Record<string, unknown>, defaults: Record<string, unknown> = {}) {
  const normalized = new Map<string, unknown>()
  for (const [key, value] of Object.entries({ ...defaults, ...props })) {
    normalized.set(documentAttrName(key), value)
  }

  const attrs = [...normalized.entries()].flatMap(([name, value]) => documentAttr(name, value))
  return attrs.length > 0 ? ` ${attrs.join(' ')}` : ''
}

function documentAttr(name: string, value: unknown): string[] {
  if (!isDocumentAttrName(name)) return []
  if (value == null || value === false || typeof value === 'function') return []
  if (value === true) return [name]
  if (name === 'style' && isRecord(value)) {
    const style = styleAttr(value)
    return style ? [`style="${escapeHtml(style)}"`] : []
  }
  if (name === 'class' && Array.isArray(value)) {
    const className = value
      .filter(
        (item): item is string | number => typeof item === 'string' || typeof item === 'number',
      )
      .join(' ')
    return className ? [`class="${escapeHtml(className)}"`] : []
  }
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    return []
  }
  return [`${name}="${escapeHtml(String(value))}"`]
}

function documentAttrName(key: string) {
  if (key === 'className') return 'class'
  if (key === 'htmlFor') return 'for'
  return key.toLowerCase()
}

function isDocumentAttrName(name: string) {
  return /^[a-zA-Z_:][a-zA-Z0-9:._-]*$/.test(name)
}

function styleAttr(style: Record<string, unknown>) {
  return Object.entries(style)
    .flatMap(([key, value]) => {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
        return []
      }
      return `${styleName(key)}:${String(value)}`
    })
    .join(';')
}

function styleName(name: string) {
  return name.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)
}

interface RenderProfile {
  label: string
}

interface ProfileRenderOptions {
  dev?: boolean
  route: { route: string }
}

function renderProfile(options: ProfileRenderOptions): RenderProfile | undefined {
  if (!traceEnabled('server') || !options.dev) return undefined
  return { label: options.route.route }
}

async function profileRenderStep<T>(
  profile: RenderProfile | undefined,
  label: string,
  task: () => Promise<T>,
) {
  if (!profile) return task()
  const start = performance.now()
  try {
    return await task()
  } finally {
    profileRenderSince(profile, label, start)
  }
}

function profileRenderSyncStep<T>(
  profile: RenderProfile | undefined,
  label: string,
  task: () => T,
) {
  if (!profile) return task()
  const start = performance.now()
  try {
    return task()
  } finally {
    profileRenderSince(profile, label, start)
  }
}

/** Span timing for regions that can't be wrapped in a callback (mark → log). */
function profileRenderMark(profile: RenderProfile | undefined) {
  return profile ? performance.now() : 0
}

function profileRenderSince(profile: RenderProfile | undefined, label: string, start: number) {
  if (!profile) return
  recordDevProfileLine(
    `dev-profile render ${profile.label} ${label} in ${formatProfileDuration(performance.now() - start)}`,
  )
}

interface RenderRequestOptions {
  params?: Record<string, RouteParamValue>
  request?: Request
  url: URL
  /** Route shape (optional-catch-all name) for vary-params tracking. */
  route?: Pick<RouteManifestEntry, 'catchAll' | 'catchAllOptional'>
  /** Soft-navigation context (host renders read the children source query). */
  nav?: RenderNavOptions
  /** Fallback shell: params/searchParams hang so awaiting them postpones. */
  fallbackParams?: boolean
  /** Sub-shell: leading params concrete, remaining route params hang. */
  fallbackConcreteParams?: Record<string, RouteParamValue>
  /** Full route param-key set (keys absent from fallbackConcreteParams hang). */
  fallbackParamKeys?: string[]
}

interface StaticParamsModule {
  params?: (ctx?: {
    params: Record<string, RouteParamValue>
  }) => Promise<Record<string, RouteParamValue>[]> | Record<string, RouteParamValue>[]
}

/**
 * A pre-settled promise: `status`/`value` are readable synchronously so preact's `use()`
 * returns without suspending. A CLIENT page reading `use(props.searchParams)` renders through
 * the streaming SSR path, which has no Suspense replay, so a bare `Promise.resolve` would make
 * `use()` throw the thenable and abort the stream.
 */
export function settledPromise<T>(value: T): Promise<T> {
  const promise = Promise.resolve(value) as Promise<T> & {
    status?: string
    value?: T
  }
  promise.status = 'fulfilled'
  promise.value = value
  return promise
}

function createPageProps(options: RenderRequestOptions): PageProps {
  // Sub-shell prerender (Stage C-4): a leading prefix of params is concrete; the
  // remaining route params hang. `params` resolves to a proxy where a concrete
  // key returns its value and an unfilled key throws PostponeError on read, so
  // reading a concrete param renders buildtime while reading an unfilled one
  // postpones its boundary. searchParams still hangs (dynamic).
  if (options.fallbackConcreteParams) {
    const concrete = options.fallbackConcreteParams
    const keys = options.fallbackParamKeys ?? Object.keys(concrete)
    return {
      params: Promise.resolve(subShellParamsProxy(concrete, keys)),
      searchParams: hangingPromise('searchParams'),
      request: options.request ? pageRequest(options.request) : undefined,
    }
  }
  // Fallback-shell prerender: params/searchParams are hanging promises so a
  // page awaiting them inside <Suspense> postpones that boundary (fallback
  // shell), while a top-level await blocks the prerender (no fallback shell).
  if (options.fallbackParams) {
    return {
      params: hangingPromise('params'),
      searchParams: hangingPromise('searchParams'),
      request: options.request ? pageRequest(options.request) : undefined,
    }
  }
  if (isPrerendering()) {
    // A runtime-prefetch prerender samples a REAL request, so search params resolve from its URL
    // exactly like a request render - the prefetch response may carry search-param-derived content
    // (the same exception request/context.ts makes for cookies()/headers()/params). A plain static
    // prerender keeps them hanging.
    if (!isRuntimePrefetchPrerender()) {
      return {
        params: settledPromise(trackedParams(options)),
        searchParams: hangingPromise('searchParams'),
        request: options.request ? pageRequest(options.request) : undefined,
      }
    }
  }
  const params = trackedParams(options)
  const searchParams = trackedSearchParams(pageSearchParams(childrenSourceSearchParams(options)))
  return {
    // markRuntimeApiOnAwait is the identity outside a runtime-prefetch
    // prerender; inside one, awaiting params/searchParams arms the sync-IO
    // abort exactly as awaiting cookies()/headers() does.
    params: markRuntimeApiOnAwait(legacySyncProps(settledPromise(params), 'params', params)),
    searchParams: markRuntimeApiOnAwait(
      legacySyncProps(settledPromise(searchParams), 'searchParams', searchParams),
    ),
    request: options.request ? pageRequest(options.request) : undefined,
  }
}

/** Next 15's transitional sync surface on params/searchParams; identity unless compat enables it. */
function legacySyncProps<T extends object>(
  promise: Promise<T>,
  kind: 'params' | 'searchParams',
  value: T,
): Promise<T> {
  return getRenderExtensions().legacySyncProps(promise, kind, value)
}

/**
 * The render's concrete params, wrapped in the compat vary-params tracking view
 * when one is active (segment-prefetch renders). Outside a tracking scope the
 * extension is the identity, so this is a no-op for ordinary renders.
 */
function trackedParams(options: RenderRequestOptions): Record<string, RouteParamValue> {
  const params = options.params ?? {}
  const optional =
    options.route?.catchAllOptional && options.route.catchAll
      ? { optionalCatchAllParam: options.route.catchAll }
      : {}
  return getRenderExtensions().trackVaryParams(params, { kind: 'params', ...optional })
}

function trackedSearchParams(searchParams: PageSearchParams): PageSearchParams {
  return getRenderExtensions().trackVaryParams(searchParams, { kind: 'searchParams' })
}

/**
 * The search params the children page renders with. On a soft HOST render (interception or
 * slot state keeps the current page visible while the URL shows the target) the children page
 * re-renders from its RECORDED source URL, so its searchParams are the query it was originally
 * fetched with, not the target URL's.
 */
function childrenSourceSearchParams(options: RenderRequestOptions): URLSearchParams {
  const nav = options.nav
  if (
    nav?.soft &&
    nav.childrenPath &&
    trimPathname(nav.childrenPath) !== trimPathname(options.url.pathname)
  ) {
    // An absent record means the children tree rendered with an empty query
    // (empty searches are omitted from the embedded state).
    return new URLSearchParams(nav.state?.childrenSearch ?? '')
  }
  return options.url.searchParams
}

/**
 * A sub-shell params object: reading a CONCRETE key returns its value; reading an unfilled key
 * throws PostponeError so the nearest <Suspense> records a hole. Lets a `/[lang]/[slug]`
 * sub-shell render the `[lang]` layout at buildtime while the `[slug]` page postpones.
 */
function subShellParamsProxy(
  concrete: Record<string, RouteParamValue>,
  keys: string[],
): Record<string, RouteParamValue> {
  const keySet = new Set(keys)
  return new Proxy(
    { ...concrete },
    {
      get(target, prop: string | symbol): unknown {
        if (typeof prop === 'string' && keySet.has(prop) && !(prop in concrete)) {
          // An unfilled route param: postpone the boundary reading it.
          throw new PostponeError(`params.${prop}`)
        }
        return (target as Record<string | symbol, unknown>)[prop]
      },
      has(target, prop: string | symbol): boolean {
        if (typeof prop === 'string' && keySet.has(prop) && !(prop in concrete)) {
          throw new PostponeError(`params.${prop}`)
        }
        return prop in target
      },
      ownKeys(target): ArrayLike<string | symbol> {
        if (keySet.size > Object.keys(concrete).length) {
          throw new PostponeError('params')
        }
        return Reflect.ownKeys(target)
      },
    },
  )
}

function pageSearchParams(params: URLSearchParams): PageSearchParams {
  const result: PageSearchParams = {}
  params.forEach((value, key) => {
    // Next's RSC union query (`?_rsc=<hash>`) is a CDN cache key on router
    // fetches, never an app search param — it must not reach page props.
    if (key === '_rsc') return
    const current = result[key]
    if (current === undefined) {
      result[key] = value
    } else if (Array.isArray(current)) {
      current.push(value)
    } else {
      result[key] = [current, value]
    }
  })
  return result
}

function pageRequest(request: Request): NextRequest {
  return toNextRequest(request)
}

function renderScopeRequest(options: RenderRequestOptions): NextRequest {
  return pageRequest(options.request ?? new Request(options.url))
}

async function serializablePageProps(props: PageProps, omitSearchParams = false) {
  const { request: _request, params, searchParams, ...rest } = props
  return {
    ...rest,
    params: await params,
    ...(omitSearchParams ? {} : { searchParams: await searchParams }),
  }
}

export async function staticParamsFor(config: ResolvedConfig, route: RouteManifestEntry) {
  const moduleFiles = [
    ...findLayouts(config.appPath, route.file).filter(file => existsSync(file)),
    route.file,
  ]
  let paramSets: Record<string, RouteParamValue>[] = [{}]
  const allSets: Record<string, RouteParamValue>[] = []
  for (const file of moduleFiles) {
    const staticHref = await moduleHref(file, { config })
    await drainPreplanBuilds()
    const imported = (await import(staticHref)) as Record<string, unknown>
    const module = getStaticParamsExtensions().normalizeModule(imported) as StaticParamsModule
    const generate = module.params
    if (typeof generate !== 'function') continue
    const next: Record<string, RouteParamValue>[] = []
    for (const parent of paramSets) {
      // Next threads the accumulated parent params into each level's
      // generateStaticParams(`{ params }`) so a child can vary its set by the
      // parent segment (e.g. `params.lang === 'fr' ? [...] : [...]`). The
      // top-level layout receives `{}`.
      const results = await generate({ params: parent })
      if (!Array.isArray(results)) continue
      for (const params of results) {
        const combined = { ...parent, ...params }
        allSets.push(combined)
        next.push(combined)
      }
    }
    if (next.length > 0) paramSets = next
  }
  const fullKeys = new Set(route.params)
  if (route.catchAll) fullKeys.add(route.catchAll)
  return {
    paths: paramSets.filter(params => [...fullKeys].every(key => params[key] !== undefined)),
    allSets,
  }
}

const errorOverlayCss = `
.pnext-error {
  --bg: #fafafa; --fg: #18181b; --muted: #71717a; --card: #fff;
  --border: #18181b; --accent: #ef4444; --stack-bg: #18181b; --stack-fg: #fafafa;
  position: fixed; inset: 0; overflow: auto; box-sizing: border-box;
  display: grid; place-items: center; padding: 32px;
  background: var(--bg); color: var(--fg);
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
@media (prefers-color-scheme: dark) {
  .pnext-error { --bg:#09090b; --fg:#fafafa; --muted:#a1a1aa; --card:#18181b; --border:#fafafa; --stack-bg:#000; --stack-fg:#e4e4e7; }
}
.pnext-error__card {
  width: min(640px, 100%); max-height: calc(100dvh - 64px); overflow: auto; box-sizing: border-box;
  background: var(--card); border: 2px solid var(--border); box-shadow: 6px 6px 0 var(--border);
  padding: 22px 24px 20px;
}
.pnext-error__eyebrow {
  display: flex; align-items: center; gap: 8px; margin: 0;
  font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em;
  color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
}
.pnext-error__dot { width: 9px; height: 9px; background: var(--accent); display: inline-block; }
.pnext-error__badge {
  margin-left: auto; border: 1px solid var(--accent); color: var(--accent);
  padding: 1px 7px; font-size: 11px; letter-spacing: 0;
}
.pnext-error__title {
  margin: 14px 0 0; font-size: 22px; line-height: 1.2; font-weight: 700;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
}
.pnext-error__message { margin: 10px 0 0; font-size: 15px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.pnext-error__stack {
  margin: 16px 0 0; max-height: min(360px, 44dvh); overflow: auto;
  white-space: pre-wrap; word-break: break-word;
  background: var(--stack-bg); color: var(--stack-fg); border: 2px solid var(--border);
  padding: 14px; font-size: 12px; line-height: 1.55;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
}
.pnext-error__hint { margin: 14px 0 0; font-size: 12px; color: var(--muted); }
`

export async function renderPage(options: RenderOptions) {
  return (await renderPageWithStatus(options)).html
}

export async function renderPageWithStatus(
  options: RenderOptions,
): Promise<{ html: string; status: number; location?: string }> {
  registerServerRuntime(options.config, options.route.sourceFiles)
  await seedPrerenderSidecar(options)
  const request = renderScopeRequest(options)
  return runWithRequest(
    request,
    () =>
      runWithFontScope(() =>
        runWithCacheScope(async () => {
          const render = async () => {
            const page = await pageRender(options, false)
            const location =
              page.headers && !(page.headers instanceof Headers) && !Array.isArray(page.headers)
                ? page.headers.location
                : undefined
            return {
              html: renderDocument(page),
              status: page.status ?? 200,
              ...(location ? { location } : {}),
            }
          }
          const staticGeneration =
            options.route.segmentConfig?.dynamic !== 'force-static' &&
            // eslint-disable-next-line turbo/no-undeclared-env-vars
            process.env.NEXT_PHASE === 'phase-production-build'
          if (!staticGeneration) return render()
          return runWithCsrBailout(render)
        }),
      ),
    options.params ?? {},
  )
}

export async function renderPageStream(options: RenderOptions) {
  registerServerRuntime(options.config, options.route.sourceFiles)
  await seedPrerenderSidecar(options)

  const request = renderScopeRequest(options)
  return runWithRequest(
    request,
    () =>
      runWithFontScope(() =>
        runWithCacheScope(async () => {
          const page = await pageRender(options, true)
          return pageStream(page)
        }),
      ),
    options.params ?? {},
  )
}

export async function renderPageResponse(options: RenderOptions) {
  registerServerRuntime(options.config, options.route.sourceFiles)
  const method = options.request?.method.toUpperCase() ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'GET, HEAD' },
    })
  }

  const appShellPrefetch =
    options.route.segmentConfig?.prefetch !== undefined ||
    (options.route.hasStaticParams && !options.route.usesRequest)
  const softPprResume =
    options.request?.headers.get('x-pnext-soft-nav') === '1' &&
    (options.request.headers.get('next-router-prefetch') !== '1' || appShellPrefetch)
  // A soft-nav (or app-shell prefetch) of a PPR route can serve the prebuilt shell plus a
  // HOLES-ONLY dynamic resume, as long as the shell fully represents the route. It does NOT
  // when the route composes parallel-route slots or interception: the soft-nav carries slot
  // state the param-free shell never captured, so those keep the full dynamic render. Serving
  // the shell where it fits avoids re-running the route's cached work on every navigation.
  const shellComplete = !options.route.slotDirs?.length && !options.route.interception
  const skipPprForSoftNav =
    softPprResume && (!shellComplete || fullSegmentPrefetchSkipsSharedLayout(options))
  // A full-gsp fallback route (complete generateStaticParams, no build-time base shell, so
  // route.ppr stays false) is still upgrade-eligible: its prerendered params let a request's
  // concrete param prefix be promoted into a route shell. Enter the PPR path when EITHER holds so
  // the shell-miss branch below can schedule that upgrade.
  const pprUpgrade = pprShellUpgradeFor(options.config, options.route, options.url)
  if (
    (options.route.ppr || pprUpgrade !== undefined) &&
    !options.dev &&
    method === 'GET' &&
    !skipPprForSoftNav &&
    !isHtmlLimitedBotRequest(options) &&
    // A DOM bot (Googlebot) bypasses static-shell-only serving: it blocks on and
    // receives the fully resolved dynamic stream instead of a shell it would have
    // to resume, so dynamic APIs (Math.random) never trip an SSG bailout for it.
    !isDomBotRequest(options) &&
    !/(?:^|;\s*)__prerender_bypass=/.test(options.request?.headers.get('cookie') ?? '')
  ) {
    const prebuilt = await loadPprShell(options.config, options.route, options.url)
    if (prebuilt) {
      // Soft tag staleness (revalidateTag with a profile): Next's SWR
      // semantics — this response still serves the stale shell, while a
      // background regeneration refreshes the shell + sidecar for the next one.
      if (prebuilt.softStale) void regenerateStalePprShell(options)
      return renderPprResponse(options, prebuilt)
    }
    // The route HAS a prebuilt shell but it went stale. Serving the baked bytes would launder
    // stale cached data; falling through to a plain dynamic render would cut the cached,
    // resolvable content out of shell-only prefetch responses. Regenerate instead: a fresh
    // partial prerender re-produces the cached fills against the just-invalidated registries
    // and persists the new shell plus sidecar.
    const regenerated = await regenerateStalePprShell(options)
    if (regenerated) return renderPprResponse(options, regenerated)
    // Shell miss on an upgrade-eligible route: warm the more-specific route shell in the background
    // so a subsequent request serves the promoted shell. This response still falls through to the
    // plain dynamic render below.
    if (pprUpgrade !== undefined) schedulePprShellUpgrade(options)
  }

  await seedPrerenderSidecar(options)

  const nextRequest = renderScopeRequest(options)
  return runWithRequest(
    nextRequest,
    () =>
      runWithFontScope(() =>
        runWithCacheScope(async () => {
          // A DOM bot (Googlebot) blocks on the full dynamic tree instead of
          // streaming holes, so the resolved page (and its flight payload) is
          // complete inline — a JS-executing crawler never has to resume a shell.
          const page = await pageRender(
            options,
            canStreamRoute(options) && !isDomBotRequest(options),
          )
          if (page.headers) {
            const location = readLocationHeader(page.headers)
            return new Response(method === 'HEAD' ? null : (location ?? null), {
              status: page.status ?? 307,
              headers: page.headers,
            })
          }

          // Partial prefetch (compat classifies): serve the static shell only —
          // the dynamic continuation is cut and the response marked postponed so
          // the client caches it as a shell, never commits it as a document.
          const shellOnly =
            options.request !== undefined &&
            getRouterProtocolExtensions().shellOnlyRequest(options.request, options.route)
          const truncated = shellOnly && page.streamChunks.length > 0
          return new Response(
            method === 'HEAD' ? null : pageStream(page, shellOnly, renderProfile(options)),
            {
              status: page.status ?? 200,
              headers: {
                'content-type': 'text/html; charset=utf-8',
                ...(truncated ? { 'x-nextjs-postponed': '1' } : {}),
              },
            },
          )
        }),
      ),
    options.params ?? {},
  )
}

function isHtmlLimitedBotRequest(options: RenderOptions): boolean {
  const shouldRenderInBody = getActiveMetadataExtensions(options.config).shouldRenderMetadataInBody
  if (!shouldRenderInBody) return false
  return !shouldRenderInBody({
    config: options.config,
    ...(options.request ? { request: options.request } : {}),
  })
}

// Next's HEADLESS_BROWSER_BOT_UA_RE: bots that execute JS (Googlebot's rendering
// crawler). Distinct from html-limited bots (which only get metadata-in-body).
const DOM_BOT_UA_RE = /Googlebot(?!-)|Googlebot$/i

function isDomBotRequest(options: RenderOptions): boolean {
  const ua = options.request?.headers.get('user-agent') ?? ''
  return DOM_BOT_UA_RE.test(ua)
}

// Minimal React-flight element serialization of a resolved server tree, so resolved dynamic values
// appear in flight rows the way React's own RSC payload encodes them. Non-serializable props are
// dropped - this is a read-only projection of already-rendered output, never re-hydrated.
function flightSerializeTree(node: unknown, depth = 0): unknown {
  if (
    node == null ||
    typeof node === 'boolean' ||
    typeof node === 'function' ||
    typeof node === 'symbol' ||
    typeof node === 'bigint'
  ) {
    return null
  }
  if (typeof node === 'string' || typeof node === 'number') return node
  if (depth > 64) return null
  if (Array.isArray(node)) return node.map(child => flightSerializeTree(child, depth + 1))
  const vnode = node as { type?: unknown; key?: unknown; props?: Record<string, unknown> }
  if (!vnode.props) return null
  const { children, ...rest } = vnode.props
  if (typeof vnode.type === 'string') {
    const props: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(rest)) {
      const kind = typeof value
      if (kind === 'string' || kind === 'number' || kind === 'boolean') props[key] = value
    }
    if (children !== undefined) props.children = flightSerializeTree(children, depth + 1)
    return ['$', vnode.type, vnode.key ?? null, props]
  }
  // Component / fragment: project through its resolved children.
  return children === undefined ? null : flightSerializeTree(children, depth + 1)
}

// The inline `self.__next_f` script a DOM bot expects: the resolved tree encoded
// as a React-flight row. Only emitted for DOM-bot requests to a PPR route, so
// ordinary responses are byte-for-byte unchanged.
function domBotFlightScript(resolved: unknown): string {
  let text: string
  try {
    text = JSON.stringify(flightSerializeTree(resolved))
  } catch {
    return ''
  }
  if (!text || text === 'null') return ''
  const payload = JSON.stringify(text).replace(/</g, '\\u003c')
  return `<script>self.__next_f=self.__next_f||[]</script><script>self.__next_f.push([1,${payload}])</script>`
}

interface PrebuiltShell {
  shell: string
  holes: number[]
  metadataDynamic: boolean
  concreteParams?: Record<string, RouteParamValue>
  /** Stale via a soft tag revalidation: servable once, regenerate in background. */
  softStale?: boolean
}

interface PromotedShell {
  shell: PrebuiltShell
  /**
   * Wall-clock of the promotion. A promoted shell lives in memory, so it has no file mtime for
   * revalidatePath/revalidateTag staleness to age against - this stands in for one.
   */
  promotedAt: number
}

const pprShellUpgrades = new Map<string, PromotedShell>()
const pendingPprShellUpgrades = new Set<string>()
// Upgrade keys whose promoted region resolves NON-DETERMINISTIC (request-time) bytes into the
// static shell - a fallback route that reads its concrete param inside the postponed boundary
// and also produces per-render content there (a fresh OTEL span id, Math.random, Date). Caching
// such a shell would freeze that content, so the base shell must resume it live each time.
// Recorded so the confirmation double-render runs once per key rather than on every shell miss.
const rejectedPprShellUpgrades = new Set<string>()

/**
 * Build-time partial prerender. Renders the route in prerender scope (no request) so request
 * APIs postpone at their Suspense boundary. Returns the static shell plus the hole ids, or null
 * when dynamic data escapes every boundary - the route must then be served fully dynamically.
 */
export async function renderPartialShell(options: RenderOptions): Promise<PrebuiltShell | null> {
  registerServerRuntime(options.config, options.route.sourceFiles)
  const sidecar = getRenderExtensions().prerenderSidecar
  const sidecarContext = prerenderSidecarContext(options)
  await sidecar.begin(sidecarContext)
  // A BUILD shell render under cacheComponents ends at the first task boundary. A runtime
  // regeneration renders against a live server where task-settled work is expected to complete, so
  // it keeps the unbounded behavior - UNLESS it is a bounded shell upgrade, which must postpone
  // uncached request-time I/O exactly as the build-time base shell did.
  const taskBoundary = cacheComponents() && (!options.runtimeRegen || options.boundedRegen === true)
  const renderShellDocument = async (partial: PartialState, bounded: boolean) =>
    runInPrerender(
      async () => {
        // Capture the scope up front so completePrerender runs on EVERY exit path in the finally
        // below, including the throw / `return null` path. Leaving the scope un-aborted there keeps
        // an armed React.cacheSignal() poll timer alive and the build never exits.
        const scope = currentPrerenderScope()
        try {
          const renderTree = () =>
            runWithFontScope(() =>
              runWithCacheScope(() => pageRender({ ...options, partial }, false)),
            )
          const renderShell = () =>
            options.fallbackParams && options.params
              ? runInParamsScope(options.params, renderTree)
              : renderTree()
          return await (options.runtimeRegen
            ? renderShell()
            : runWithPrerenderDeterminism(renderShell))
        } finally {
          // Abandon any hanging request/param promises that were passed out but
          // never awaited inside a boundary — no HANGING_PROMISE_REJECTION in
          // build logs. Runs inside the prerender scope so the AbortController is
          // live.
          completePrerender(scope)
        }
      },
      { taskBoundary: bounded, ...(options.prefetchShell ? { prefetchShell: true } : {}) },
    )
  const freshPartial = (): BuildPartialState => ({
    mode: 'build',
    nextId: 0,
    holes: [],
    metadataDynamic: false,
  })
  let partial = freshPartial()
  try {
    let page: Awaited<ReturnType<typeof renderShellDocument>>
    try {
      page = await renderShellDocument(partial, taskBoundary)
    } catch (error) {
      // Task-boundary work that escaped EVERY <Suspense> would leave the route
      // with no shell at all. Upstream that is a blocking-prerender build error,
      // but pnext cannot yet tell a genuine one from an artifact of its own
      // renderer (a module-level `'use cache'` page is not cache-transformed on
      // this path, so its cached IO reads as uncached here). Redo the shell
      // unbounded so such a route keeps exactly the shell it had before.
      if (!taskBoundary || !isTaskPostpone(error)) throw error
      partial = freshPartial()
      page = await renderShellDocument(partial, false)
    }
    const prebuilt = {
      shell: renderDocumentStart(page),
      holes: partial.holes,
      metadataDynamic: partial.metadataDynamic,
    }
    // The prefetch-shell pass is a SECOND render of a route whose document shell
    // was already baked: persisting its sidecar would overwrite the document's
    // resume data with a copy missing the fills this pass deliberately omitted.
    if (!options.prefetchShell && !options.probeShell) {
      const artifact = await sidecar.collect(sidecarContext)
      if (artifact !== undefined) await sidecar.persist(sidecarContext, artifact)
    }
    return prebuilt
  } catch (error) {
    if (isPostpone(error)) return null
    if (isRedirectError(error) || isNotFoundError(error)) return null
    throw error
  }
}

/**
 * RUNTIME-PREFETCH prerender (`unstable_instant`): render the route against the REAL sampled
 * request, so request APIs resolve and their content lands in the response while
 * connection()-gated content hangs and keeps its Suspense fallback. Served directly as a
 * prefetch body and NEVER persisted into build artifacts or sidecars - it is sampled data.
 */
export async function renderRuntimePrefetchDocument(
  options: RenderOptions,
): Promise<{ html: string; postponed: boolean } | null> {
  registerServerRuntime(options.config, options.route.sourceFiles)
  // Seed (read-only) the resume-data sidecar so 'use cache' scopes resolve
  // their build-time fills; unlike renderPartialShell nothing is collected or
  // persisted back.
  await seedPrerenderSidecar(options)
  const partial: PartialState = {
    mode: 'build',
    nextId: 0,
    holes: [],
    metadataDynamic: false,
  }
  const nextRequest = renderScopeRequest(options)
  try {
    const page = await runWithRequest(
      nextRequest,
      () =>
        runInPrerender(
          async () => {
            // Capture the scope up front so completePrerender runs on every exit
            // path in the finally — a throw / null-return that skipped the abort
            // would leave an armed React.cacheSignal() poll timer alive.
            const scope = currentPrerenderScope()
            try {
              // Sync IO reached AFTER a runtime API resolved is content only the
              // navigation may render: the shims turn it into a postpone for the
              // nearest boundary (silently — nothing is logged).
              return await runWithRuntimePrefetchSyncIoAbort(() =>
                runWithFontScope(() =>
                  runWithCacheScope(() => pageRender({ ...options, partial }, false)),
                ),
              )
            } finally {
              // Abandon hanging connection() promises that were never awaited
              // inside a boundary (no HANGING_PROMISE_REJECTION noise).
              completePrerender(scope)
            }
          },
          { runtimePrefetch: true },
        ),
      options.params ?? {},
    )
    return {
      html: `${renderDocumentStart(page)}${renderDocumentEnd()}`,
      postponed: partial.holes.length > 0 || partial.metadataDynamic,
    }
  } catch (error) {
    if (isPostpone(error)) return null
    if (isRedirectError(error) || isNotFoundError(error)) return null
    throw error
  }
}

/**
 * Stamp the serving request's params into a prebuilt shell's `__PNEXT_ROUTE__` and into every
 * island param scope that carried the baked placeholder.
 *
 * A FALLBACK shell is baked with every param HANGING, so its embedded route state carries the
 * placeholder. Serving those bytes verbatim hands the client placeholder params for a concrete
 * URL: `useParams()` reads exactly this state, and optimistic routing learns a pattern's param
 * SHAPE from it. The island scopes move with it because `data-pnext-params` OVERRIDES the
 * window route state for the island carrying it.
 *
 * Exported for the segment-prefetch path, which answers a default prefetch from the same baked
 * bytes without going through renderPprResponse.
 */
export function withRequestRouteParams(
  shell: string,
  params: Record<string, RouteParamValue> | undefined,
  search?: string,
): string {
  let html = shell
  const match = /(<script>window\.__PNEXT_ROUTE__=)(\{.*?\})(;<\/script>)/.exec(shell)
  let merged = params ?? {}
  if (match && params && Object.keys(params).length > 0) {
    let state: Record<string, unknown> | undefined
    try {
      state = JSON.parse(match[2]!) as Record<string, unknown>
    } catch {
      // A route script we cannot parse is left exactly as baked.
      state = undefined
    }
    if (state) {
      const baked = (state.params ?? {}) as Record<string, RouteParamValue>
      merged = { ...baked, ...params }
      const bakedScope = serializeProps(baked)
      const mergedScope = serializeProps(merged)
      if (bakedScope !== mergedScope) {
        html =
          html.slice(0, match.index) +
          `${match[1]}${serializeProps({ ...state, params: merged })}${match[3]}` +
          html.slice(match.index + match[0].length)
        html = rewriteIslandMarkup(html, text =>
          text.split(islandParamsAttribute(bakedScope)).join(islandParamsAttribute(mergedScope)),
        )
      }
    }
  }
  return withIslandPromiseProps(html, merged, search)
}

const islandParamsAttribute = (json: string) =>
  `${ISLAND_PARAMS_ATTRIBUTE}="${json.replaceAll('"', '&quot;')}"`

/**
 * Re-stamp the `data-pnext-props` placeholders a partial prerender baked for hanging
 * `params`/`searchParams` island props. Without this the shell - deliberately shared across
 * params - hands every request the same `null`, so a client component that destructures
 * `params` instead of calling useParams() reads nothing.
 */
function withIslandPromiseProps(
  html: string,
  params: Record<string, RouteParamValue>,
  search: string | undefined,
): string {
  const replacements: [string, string][] = []
  if (Object.keys(params).length > 0) {
    replacements.push([promisePlaceholderJson('params'), serializeProps(promiseMarker(params))])
  }
  if (search !== undefined) {
    replacements.push([
      promisePlaceholderJson('searchParams'),
      serializeProps(promiseMarker(pageSearchParams(new URLSearchParams(search)))),
    ])
  }
  if (replacements.length === 0) return html
  return rewriteIslandMarkup(html, text => {
    let next = text
    for (const [from, to] of replacements) {
      next = next.split(from).join(to).split(escapeAttribute(from)).join(escapeAttribute(to))
    }
    return next
  })
}

const escapeAttribute = (json: string) => json.replaceAll('"', '&quot;')

// The island marker payload is the element's attribute text, carried inside an
// HTML comment. Only `<`/`>` are unsafe there (a `-->` would close the comment
// early); the materializer re-parses the payload as markup, which turns the
// entities back into the original characters. Keeping the payload as plain text
// (rather than base64) means client props read literally on the wire, the way
// React flight writes them.
export function encodeIslandMarker(attributes: string): string {
  return attributes.replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function decodeIslandMarker(payload: string): string {
  return payload.replaceAll('&lt;', '<').replaceAll('&gt;', '>')
}

/**
 * Apply `rewrite` to the markup AND to the client-island markers the renderer
 * emits for neutral islands (`<!--pnext-client:ATTRIBUTES-->`).
 */
function rewriteIslandMarkup(html: string, rewrite: (text: string) => string): string {
  return rewrite(html).replace(
    /<!--pnext-(client|client-after|page):([^>]*)-->/g,
    (marker, kind: string, encoded: string) => {
      const decoded = decodeIslandMarker(encoded)
      const next = rewrite(decoded)
      return next === decoded ? marker : `<!--pnext-${kind}:${encodeIslandMarker(next)}-->`
    },
  )
}

const ISLAND_PARAMS_ATTRIBUTE = 'data-pnext-params'

/**
 * Request-time resume for a PPR route. Serves the prebuilt static shell immediately, then
 * re-runs the tree with the real request and streams only the dynamic holes into their
 * placeholders. Re-running renders the static parts again and discards them - the cost of not
 * needing React-style resumable state.
 */
export function renderPprResponse(options: RenderOptions, prebuilt: PrebuiltShell) {
  const postponed = prebuilt.holes.length > 0 || prebuilt.metadataDynamic
  const shell = withRequestRouteParams(
    prebuilt.shell,
    options.params,
    options.request ? new URL(options.request.url).search : undefined,
  )
  // Partial prefetch of a PPR route: the prebuilt static shell IS the answer —
  // never run the dynamic resume for a prefetch (its holes stay fallbacks).
  if (
    postponed &&
    options.request !== undefined &&
    getRouterProtocolExtensions().shellOnlyRequest(options.request, options.route)
  ) {
    schedulePprShellUpgrade(options)
    return new Response(`${shell}${renderDocumentEnd()}`, {
      status: options.status ?? 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'x-nextjs-postponed': '1',
      },
    })
  }
  // No holes: the shell IS the complete document — serve it buffered. There is
  // nothing to resume, and a buffered body (content-length, not chunked) lets
  // response-inspecting clients (test harnesses, intermediaries) read it.
  if (!postponed) {
    schedulePprShellUpgrade(options)
    return new Response(`${shell}${renderDocumentEnd()}`, {
      status: options.status ?? 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  }
  const request = renderScopeRequest(options)
  const partial: PartialState = {
    mode: 'request',
    nextId: 0,
    known: new Set(prebuilt.holes),
    chunks: [],
    metadataDynamic: prebuilt.metadataDynamic,
    staticSlots: parseStaticSlots(shell),
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      controller.enqueue(encoder.encode(shell))
      // Next's test builds emit a sentinel between the static shell and the
      // dynamic resume so PPR tests can split the response into its parts
      // (splitResponseWithPPRSentinel). Mirror it under the same env gate.
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      if (process.env.__NEXT_TEST_MODE) {
        controller.enqueue(encoder.encode('<!-- PPR_BOUNDARY_SENTINEL -->'))
      }
      schedulePprShellUpgrade(options)
      void (async () => {
        try {
          await seedPrerenderSidecar(options)
          await runWithRequest(
            request,
            () =>
              runWithFontScope(() =>
                runWithCacheScope(() => pageRender({ ...options, partial }, false)),
              ),
            options.params ?? {},
          )
          for (const chunk of partial.chunks) controller.enqueue(encoder.encode(chunk))
        } catch (error) {
          if (options.dev)
            console.error(error instanceof Error ? (error.stack ?? error.message) : error)
          controller.enqueue(
            encoder.encode(
              renderToString(
                hStreamError(
                  error,
                  Boolean(options.dev),
                  nextCompatEnabled(options.config),
                  needsClientEntry(options.route),
                ),
              ),
            ),
          )
        }
        controller.enqueue(encoder.encode(renderDocumentEnd()))
        controller.close()
      })()
    },
  })
  return new Response(stream, {
    status: options.status ?? 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // A PPR response that served a shell with dynamic holes was postponed;
      // Next stamps this so intermediaries/segment-cache treat it as partial.
      // isNextStart-gated behavior (never dev): loadPprShell is prod+GET only.
      ...(postponed ? { 'x-nextjs-postponed': '1' } : {}),
    },
  })
}

function prerenderSidecarContext(options: Pick<RenderOptions, 'config' | 'route'>) {
  return {
    outPath: options.config.outPath,
    routeId: options.route.id,
    routePath: options.route.route,
  }
}

async function seedPrerenderSidecar(options: RenderOptions): Promise<void> {
  if (!options.route.ppr || options.dev || !options.request) return
  await getRenderExtensions().prerenderSidecar.seed(prerenderSidecarContext(options))
}

/**
 * Build a param-independent fallback shell for a dynamic route with no prerendered param.
 * `params`/`searchParams` are hanging promises: a page that awaits them inside a <Suspense>
 * postpones that boundary; a page that reads them at the top level blocks the prerender and
 * returns null (must be served fully dynamically).
 */
export async function renderFallbackShell(options: RenderOptions): Promise<PrebuiltShell | null> {
  const params =
    options.params ??
    (options.route.catchAll && !options.route.catchAllOptional
      ? { [options.route.catchAll]: [] }
      : undefined)
  return renderPartialShell({ ...options, ...(params ? { params } : {}), fallbackParams: true })
}

/**
 * Build a SUB-SHELL at a given param specificity: the `concreteParams` prefix is prerendered at
 * buildtime while the remaining route params hang. `/es/[slug]` and `/[lang]/[slug]` are two
 * sub-shells of descending specificity; the request path serves the deepest matching one.
 */
export async function renderSubShell(
  options: RenderOptions & {
    concreteParams: Record<string, RouteParamValue>
    paramKeys: string[]
  },
): Promise<PrebuiltShell | null> {
  return renderPartialShell({
    ...options,
    fallbackConcreteParams: options.concreteParams,
    fallbackParamKeys: options.paramKeys,
  })
}

// In-flight stale-shell regenerations, so concurrent requests to a stale route
// share one partial prerender instead of stampeding.
const pendingShellRegens = new Map<string, Promise<PrebuiltShell | null>>()

/**
 * Re-run the partial prerender for a PPR route whose prebuilt shell went stale. Persists the new
 * bytes back over the stale file - updating its mtime past the revalidation marks, so the
 * staleness self-heals - but only when the regenerated holes match the manifest's; a divergent
 * regen is served for this request only.
 */
async function regenerateStalePprShell(options: RenderOptions): Promise<PrebuiltShell | null> {
  const file = pprShellPath(options.config.outPath, options.route.id)
  if (!existsSync(file)) return null
  let pending = pendingShellRegens.get(options.route.id)
  if (!pending) {
    pending = (async () => {
      // Seed the resume-data sidecar first: a hole-less shell serves via the fast path that never
      // seeds, so this process's fetch/use-cache stores may be empty and the regen would refetch
      // entries the revalidation did NOT invalidate. Invalidated records are ignored at read
      // time, so seeding never resurrects revalidated data.
      await getRenderExtensions().prerenderSidecar.seed(prerenderSidecarContext(options))
      // Like ISR's scheduleRegen: a regeneration render must refetch stale-
      // tagged data-cache entries inline (SWR would bake the stale values into
      // the regenerated shell, and the self-healed mtime then hides the
      // staleness forever).
      const { value: prebuilt } = await getRenderExtensions().collectRenderMeta(
        () => renderPartialShell({ ...options, runtimeRegen: true }),
        { blockingStaleFetches: true, route: options.url?.pathname },
      )
      if (prebuilt) {
        const manifestHoles = [...(options.route.pprHoles ?? [])].sort((a, b) => a - b)
        const freshHoles = [...prebuilt.holes].sort((a, b) => a - b)
        if (JSON.stringify(manifestHoles) === JSON.stringify(freshHoles)) {
          await writeFile(file, prebuilt.shell).catch(() => undefined)
        }
      }
      return prebuilt
    })().finally(() => pendingShellRegens.delete(options.route.id))
    pendingShellRegens.set(options.route.id, pending)
  }
  return pending
}

/**
 * The shell bytes a PPR route currently serves for `url` (fresh prebuilt file,
 * else the single-flight stale regeneration). Segment-prefetch artifacts adopt
 * this instead of prerendering independently, so document and `/__PAGE__`
 * payload always carry one regeneration's resume data.
 */
export async function currentPprShellHtml(options: RenderOptions): Promise<string | null> {
  const shell =
    (await loadPprShell(options.config, options.route, options.url)) ??
    (await regenerateStalePprShell(options))
  return shell?.shell ?? null
}

async function loadPprShell(
  config: ResolvedConfig,
  route: RouteManifestEntry,
  url?: URL,
): Promise<PrebuiltShell | null> {
  const revalidateSeconds = route.cacheLife?.revalidateSeconds
  if (revalidateSeconds !== undefined) {
    try {
      const shell = await stat(pprShellPath(config.outPath, route.id))
      if (Date.now() - shell.mtimeMs >= revalidateSeconds * 1000) return null
    } catch {
      return null
    }
  }
  const pprStale = await getRenderExtensions().prerenderSidecar.isStale(
    prerenderSidecarContext({ config, route }),
  )
  if (pprStale === true) return null
  // Tag/path revalidation staleness: a shell baked with cache tags must stop serving once one of
  // those tags - or the route's path - is revalidated. The serving file's mtime is the freshness
  // mark; regeneration rewrites the base shell, self-healing it, and a stale sub-shell file is
  // dropped so the base shell (whose param holes resume per-request) takes over.
  const bakedAtIsStale = (bakedAtMs: number): boolean =>
    getRequestExtensions().staticStaleness(
      url?.pathname ?? (route.route || '/'),
      bakedAtMs,
      route.cacheTags ?? [],
    )
  const shellIsStale = async (file: string): Promise<boolean> => {
    try {
      const stats = await stat(file)
      return bakedAtIsStale(stats.mtimeMs)
    } catch {
      return true
    }
  }
  const softStale = pprStale === 'soft'
  const upgrade = pprShellUpgradeFor(config, route, url)
  if (upgrade) {
    const upgraded = pprShellUpgrades.get(upgrade.key)
    // A runtime-promoted shell is memoized in memory, not on disk, so it needs the same path/tag
    // revalidation check the shell FILES get above, with its promotion time standing in for the
    // file mtime. Without it the memo outlives every invalidation and the page freezes on stale
    // bytes forever. Dropping the stale entry also re-opens promotion (schedulePprShellUpgrade
    // skips any key already in this map), so the fallthrough render warms a fresh shell.
    if (upgraded) {
      if (bakedAtIsStale(upgraded.promotedAt)) pprShellUpgrades.delete(upgrade.key)
      else return upgraded.shell
    }
  }
  // Sub-shell selection (Stage C.2): pick the deepest prebuilt sub-shell whose
  // concrete-param prefix matches the request. subShells are recorded on the
  // route at build in descending specificity; the base shell (route.id) is the
  // least-specific fallback (all params hang).
  const subShells = route.pprSubShells
  if (subShells && subShells.length > 0) {
    const match = url ? selectSubShell(route, subShells, url) : undefined
    if (match) {
      const file = pprSubShellPath(config.outPath, route.id, match.key)
      if (existsSync(file)) {
        if (await shellIsStale(file)) {
          // Self-heal: drop the stale sub-shell so later requests serve the
          // base shell, whose param holes resume with fresh data per request.
          await unlink(file).catch(() => undefined)
        } else {
          return {
            shell: await readText(file),
            holes: match.holes,
            metadataDynamic: Boolean(route.pprMetadata),
            concreteParams: match.concreteParams,
            ...(softStale ? { softStale } : {}),
          }
        }
      }
    }
  }
  const file = pprShellPath(config.outPath, route.id)
  if (!existsSync(file)) return null
  if (await shellIsStale(file)) return null
  return {
    shell: await readText(file),
    holes: route.pprHoles ?? [],
    metadataDynamic: Boolean(route.pprMetadata),
    concreteParams: {},
    ...(softStale ? { softStale } : {}),
  }
}

/**
 * Warm the next more-specific shell without delaying the fallback response.
 * Only parameter prefixes with a generateStaticParams owner are promoted; a
 * remaining fully dynamic suffix stays a hole forever.
 */
export function schedulePprShellUpgrade(
  options: Pick<RenderOptions, 'config' | 'route' | 'url'>,
): void {
  const upgrade = pprShellUpgradeFor(options.config, options.route, options.url)
  if (
    !upgrade ||
    pprShellUpgrades.has(upgrade.key) ||
    pendingPprShellUpgrades.has(upgrade.key) ||
    rejectedPprShellUpgrades.has(upgrade.key)
  )
    return
  pendingPprShellUpgrades.add(upgrade.key)
  void (async () => {
    // A runtime shell upgrade renders against the live server without the build-time resume sidecar
    // seeded in this process. Seed it first, so cache-backed fills resolve from the captured
    // snapshots instead of refetching.
    try {
      await getRenderExtensions().prerenderSidecar.seed(prerenderSidecarContext(options))
    } catch {
      // A missing/failed sidecar seed only forces the upgrade render to refetch;
      // it never blocks the promotion.
    }
    const prebuilt = await renderSubShell({
      ...options,
      concreteParams: upgrade.concreteParams,
      paramKeys: upgrade.paramKeys,
      runtimeRegen: true,
      // Keep the build-time task-boundary postpone discipline: promote the
      // concrete params into the shell, but leave any boundary that depends on
      // uncached request-time I/O a hole (resumed live per request) instead of
      // freezing a request-specific result in pprShellUpgrades.
      boundedRegen: true,
    })
    if (prebuilt) {
      // A PPR route already has a base shell that RESUMES its holes live on every request.
      // Promoting a concrete param must only add param-derived static content on top of that - it
      // must never bake request-time content (a fresh OTEL span id, Math.random, Date) into the
      // static shell in place of the resume. Confirm the promoted shell is reproducible before
      // caching it: re-render once more (no sidecar persist) and diff the bytes; on a mismatch
      // drop the promotion and remember the rejection so the double render is not retried.
      // A NON-PPR route has no base shell to fall back to - its runtime prerender IS the cache
      // entry, so it is cached as-is with no determinism gate.
      let cacheable = true
      if (options.route.ppr) {
        const confirm = await renderSubShell({
          ...options,
          concreteParams: upgrade.concreteParams,
          paramKeys: upgrade.paramKeys,
          runtimeRegen: true,
          boundedRegen: true,
          probeShell: true,
        })
        cacheable = confirm?.shell === prebuilt.shell
      }
      if (cacheable) {
        pprShellUpgrades.set(upgrade.key, {
          shell: { ...prebuilt, concreteParams: upgrade.concreteParams },
          promotedAt: Date.now(),
        })
      } else {
        rejectedPprShellUpgrades.add(upgrade.key)
      }
    }
  })()
    .catch(() => undefined)
    .finally(() => pendingPprShellUpgrades.delete(upgrade.key))
}

const paramFreeRootLayoutCache = new Map<string, boolean>()

/**
 * True when the app's document layout is `app/layout.*` - param-free, so every route branch
 * shares one document. When the root layout lives under a dynamic param instead
 * (`app/[lang]/layout.tsx`), an unknown branch has no shareable shell and must never reuse
 * another branch's promoted shell.
 */
function hasParamFreeRootLayout(config: ResolvedConfig): boolean {
  const cached = paramFreeRootLayoutCache.get(config.appPath)
  if (cached !== undefined) return cached
  const found = ['tsx', 'jsx', 'ts', 'js'].some(ext =>
    existsSync(join(config.appPath, `layout.${ext}`)),
  )
  paramFreeRootLayoutCache.set(config.appPath, found)
  return found
}

/**
 * True when this request could promote a prebuilt fallback shell into a more specific route
 * shell. Such a render must never be persisted as a lazy-static HTML file: later requests would
 * be served straight off disk and never reach the renderer, so the upgraded shell would never
 * reach the client.
 */
export function isPprShellUpgradeEligible(
  config: ResolvedConfig,
  route: RouteManifestEntry,
  url?: URL,
): boolean {
  // Shell upgrades only exist for a route that HAS a PPR base shell. Any other
  // route (a plain ISR route with generateStaticParams, or a non-PPR route under
  // cacheComponents) also has prerenderedParams, but has no shell to upgrade.
  // Treating it as upgrade-eligible only vetoes its lazy-static persistence, so
  // every request re-renders and re-samples request-time content
  // (next-after-app-deploy's "sanity check that it's static";
  // cache-components-allow-otel-spans' cached span ids on /novel/{cache,server}).
  if (!route.ppr) return false
  return pprShellUpgradeFor(config, route, url) !== undefined
}

function pprShellUpgradeFor(config: ResolvedConfig, route: RouteManifestEntry, url?: URL) {
  if (!url || !route.prerenderedParams?.length) return undefined
  if (!hasParamFreeRootLayout(config)) return undefined
  const actual = matchRouteParams(route, url.pathname)
  if (!actual) return undefined
  const paramKeys = [...route.params, ...(route.catchAll ? [route.catchAll] : [])]
  const length = Math.max(
    0,
    ...route.prerenderedParams.map(params => {
      let count = 0
      while (count < paramKeys.length && params[paramKeys[count]!] !== undefined) count++
      return count
    }),
  )
  if (length === 0) return undefined
  const concreteParams: Record<string, RouteParamValue> = {}
  for (let index = 0; index < length; index++) {
    const key = paramKeys[index]!
    const value = actual[key]
    if (value === undefined) return undefined
    concreteParams[key] = value
  }
  return {
    concreteParams,
    paramKeys,
    key: `${route.id}:${JSON.stringify(concreteParams)}`,
  }
}

/**
 * Pick the deepest (most concrete params) prebuilt sub-shell whose param prefix
 * is consistent with the request URL's path segments. Sub-shells are ordered
 * most-specific first, so the first match wins.
 */
function selectSubShell(
  route: RouteManifestEntry,
  subShells: NonNullable<RouteManifestEntry['pprSubShells']>,
  url: URL,
): NonNullable<RouteManifestEntry['pprSubShells']>[number] | undefined {
  const actual = matchRouteParams(route, url.pathname)
  if (!actual) return undefined
  for (const shell of subShells) {
    const ok = Object.entries(shell.concreteParams).every(([key, value]) => {
      const a = actual[key]
      return Array.isArray(value)
        ? Array.isArray(a) && a.join('/') === value.join('/')
        : a === value
    })
    if (ok) return shell
  }
  return undefined
}

/**
 * Extract concrete param values for `route` from a request pathname (used to
 * match a request against prebuilt sub-shell prefixes). Returns undefined when
 * the pathname does not match the route pattern.
 */
function matchRouteParams(
  route: RouteManifestEntry,
  pathname: string,
): Record<string, RouteParamValue> | undefined {
  const pattern = new RegExp(`^${route.pattern}$`)
  const match = pattern.exec(pathname)
  if (!match) return undefined
  const keys = [...route.params, ...(route.catchAll ? [route.catchAll] : [])]
  const params: Record<string, RouteParamValue> = {}
  keys.forEach((key, index) => {
    const raw = match[index + 1]
    if (raw === undefined) return
    const decoded = raw.split('/').map(part => decodeURIComponent(part))
    params[key] = key === route.catchAll ? decoded : decoded[0]!
  })
  return params
}

export function pprShellPath(outPath: string, routeId: string) {
  return `${outPath}/ppr/${routeId}.html`
}

/** Path for a prebuilt sub-shell keyed by its concrete-param prefix signature. */
export function pprSubShellPath(outPath: string, routeId: string, key: string) {
  return `${outPath}/ppr/${routeId}.${key}.html`
}

/**
 * `skipNoindex`: the 404 came out of a server action, where robots the page
 * declared must stay authoritative — the metadata base stops forcing noindex.
 * A default noindex is still injected when nothing declares robots at all.
 */
export async function renderGlobalNotFoundResponse(
  options: Omit<RenderOptions, 'route' | 'params'>,
  { skipNoindex = false }: { skipNoindex?: boolean } = {},
) {
  const globalFile = ['tsx', 'ts', 'jsx', 'js']
    .map(ext => `${options.config.appPath}/global-not-found.${ext}`)
    .find(candidate => existsSync(candidate))
  // Render as GET regardless of the original method: the 404 page is what a
  // browser should see for a stray POST too (Next's MPA fallback), not a 405.
  const notFoundRequest = options.request
    ? new Request(options.request.url, { headers: options.request.headers })
    : undefined

  let response: Response
  if (globalFile) {
    // A user global-not-found.* renders as the WHOLE document (its own <html>,
    // e.g. `<html data-global-not-found="true">`). Feed it as the root document
    // layout with a synthetic empty page so readDocumentLayout emits its <html>
    // verbatim instead of wrapping it in <main>.
    const route: RouteManifestEntry = {
      id: 'global-not-found',
      kind: 'page',
      route: '/_global-not-found',
      pattern: '/_global-not-found',
      file: globalFile,
      params: [],
      mode: 'dynamic',
      hasStaticParams: false,
      usesRequest: false,
      client: false,
      clientReferences: [],
      // Include CSS shared with the root layout: this document replaces the
      // whole page (no root layout render), so the global sheet isn't linked
      // and anything it covered must ship in this route's own chunk.
      cssImports: await collectFileCss(options.config.appPath, [globalFile], {
        includeGlobalCss: true,
      }),
      sourceFiles: [globalFile],
      synthetic: true,
    }
    response = await renderPageResponse({
      ...options,
      ...(notFoundRequest ? { request: notFoundRequest } : {}),
      layoutFiles: [globalFile],
      route,
      status: 404,
    })
  } else {
    // No global-not-found: an unmatched URL renders the app's root not-found.* INSIDE the root
    // layout, so anchor a synthetic route at the app root for layout and boundary discovery. The
    // published runtime is a process global and may belong to ANOTHER app, so adopting its root
    // route would anchor this render outside our appPath and the convention walk would never see
    // the app's own not-found.*.
    const runtime = getRequestRuntime()
    const rootRoute =
      runtime?.config.appPath === options.config.appPath
        ? runtime.routes.find(
            candidate =>
              candidate.kind === 'page' && candidate.route === '/' && !candidate.interception,
          )
        : undefined
    const anchor = rootRoute?.file ?? `${options.config.appPath}/page.tsx`
    const route: RouteManifestEntry = {
      id: 'not-found',
      kind: 'page',
      route: '/_not-found',
      pattern: '/_not-found',
      file: anchor,
      params: [],
      mode: 'dynamic',
      hasStaticParams: false,
      usesRequest: false,
      client: false,
      clientReferences: rootRoute?.clientReferences ?? [],
      // Root not-found ships its own CSS (`/assets/not-found.css`) alongside the
      // root-layout global sheet (`/assets/global.css`, emitted via globalCssHref).
      cssImports: await collectNotFoundCss(options.config.appPath),
      sourceFiles: rootRoute?.sourceFiles ?? [anchor],
      ...(rootRoute?.needsRouterEntry ? { needsRouterEntry: true } : {}),
      // Serve the ROOT route's built client entry: the synthetic id has no
      // entry of its own, and the root entry already registers the root
      // not-found.js client reference + notFoundComponent, so a client
      // not-found island hydrates on the 404 document (not-found/css-precedence
      // clicks its useRouter button).
      ...(rootRoute
        ? { clientEntry: rootRoute.clientEntry ?? `assets/${clientEntryName(rootRoute)}.js` }
        : {}),
    }
    const notFoundOptions: RenderOptions = {
      ...options,
      ...(notFoundRequest ? { request: notFoundRequest } : {}),
      route,
      status: 404,
    }
    // With the global-not-found convention enabled (experimental.globalNotFound)
    // but no global-not-found.* file, an unmatched URL renders the BUILT-IN
    // default 404 — the app's root not-found.* stays reserved for explicit
    // notFound() calls (global-not-found/not-present suite).
    const forceDefault = getRenderExtensions().globalNotFoundEnabled()
    const page = await runWithRequest(
      renderScopeRequest(notFoundOptions),
      () =>
        runWithFontScope(() =>
          runWithCacheScope(() =>
            renderNotFoundPage(notFoundOptions, false, { forceDefault, skipNoindex }),
          ),
        ),
      {},
    )
    response = new Response(pageStream(page), {
      status: 404,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  }
  // Next always marks the not-found page noindex.
  if ((response.headers.get('content-type') ?? '').includes('text/html')) {
    const html = await response.text()
    const withRobots = html.includes('name="robots"')
      ? html
      : html.replace('</head>', '<meta name="robots" content="noindex"/></head>')
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    return new Response(withRobots, { status: response.status, headers })
  }
  return response
}

/**
 * notFound() thrown from a Server Action: the URL DID match a route, so render the not-found
 * boundary within that route (keeping its layout chain and generateMetadata) instead of anchoring
 * at the app root like renderGlobalNotFoundResponse.
 */
export async function renderNotFoundForRoute(
  options: RenderOptions,
  { skipNoindex = false }: { skipNoindex?: boolean } = {},
): Promise<Response> {
  const notFoundRequest = options.request
    ? new Request(options.request.url, { headers: options.request.headers })
    : undefined
  const notFoundOptions: RenderOptions = {
    ...options,
    ...(notFoundRequest ? { request: notFoundRequest } : {}),
    status: 404,
  }
  const page = await runWithRequest(
    renderScopeRequest(notFoundOptions),
    () =>
      runWithFontScope(() =>
        runWithCacheScope(() => renderNotFoundPage(notFoundOptions, false, { skipNoindex })),
      ),
    {},
  )
  const response = new Response(pageStream(page), {
    status: 404,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
  const html = await response.text()
  const withRobots = html.includes('name="robots"')
    ? html
    : html.replace('</head>', '<meta name="robots" content="noindex"/></head>')
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  return new Response(withRobots, { status: response.status, headers })
}

// Everything after this marker is late metadata, not document bytes: the
// router's streamed read commits the document at the marker and folds the
// remainder into the live head.
export const LATE_METADATA_MARKER = '<!--pnext-late-metadata-->'

function pageStream(page: PageRender, shellOnly = false, profile?: RenderProfile) {
  const encoder = new TextEncoder()

  if (page.shell === 'global-error') {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(page.body))
        controller.close()
      },
    })
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        const documentStart = profileRenderMark(profile)
        controller.enqueue(encoder.encode(renderDocumentStart(page)))
        profileRenderSince(profile, 'serialize document start', documentStart)
        // A shell-only response (partial prefetch) ends at the shell: Suspense
        // fallbacks stay in place and the deferred continuation never streams.
        // The pending chunk promises settle unobserved — their work is already
        // in flight and must not surface as an unhandled rejection.
        if (shellOnly && page.streamChunks.length > 0) {
          for (const chunk of page.streamChunks) void chunk.catch(() => undefined)
        } else {
          for await (const chunk of completed(page.streamChunks)) {
            controller.enqueue(encoder.encode(chunk))
          }
        }
        controller.enqueue(encoder.encode(renderDocumentEnd()))
        // Late metadata rides PAST the document end: the streamed-navigation
        // reader commits the document at `</html>` and folds this tail into the
        // live body when it lands, so a slow generateMetadata never holds the
        // navigation's content back.
        const lateChunks = page.lateChunks ?? []
        if (shellOnly) {
          for (const chunk of lateChunks) void chunk.catch(() => undefined)
        } else if (lateChunks.length > 0) {
          // The marker goes out with the document end, not with the metadata:
          // it is what tells the reader the document is complete, so it must
          // not wait for the work it introduces.
          controller.enqueue(encoder.encode(LATE_METADATA_MARKER))
          for await (const chunk of completed(lateChunks)) {
            if (chunk) controller.enqueue(encoder.encode(chunk))
          }
        }
        controller.close()
        profileRenderSince(profile, 'stream document', documentStart)
        // The stream closes after the request handler's flush, so drain the
        // tail here rather than letting it ride on the next request.
        if (profile) flushDevProfileLines()
      })().catch(error => controller.error(error))
    },
  })
}

// Read + regex per request became a read per root-layout EDIT: the answer only
// changes when the file does, and mtime is one syscall against a whole file read.
const documentLayoutDefaults = new Map<string, { mtimeMs: number; hasDefault: boolean }>()

async function routeHasDocumentLayout(layoutFiles: string[]) {
  const rootLayout = layoutFiles[0]
  if (!rootLayout) return false
  let mtimeMs: number
  try {
    mtimeMs = statSync(rootLayout).mtimeMs
  } catch {
    return false
  }
  const cached = documentLayoutDefaults.get(rootLayout)
  if (cached?.mtimeMs === mtimeMs) return cached.hasDefault
  const hasDefault = /\bexport\s+default\b/.test(await readText(rootLayout))
  documentLayoutDefaults.set(rootLayout, { mtimeMs, hasDefault })
  return hasDefault
}

async function pageRender(options: RenderOptions, stream: boolean): Promise<PageRender> {
  options = normalizeRenderOptions(options)
  await getSuspenseExtensions().ensureCompatSuspense(options.config)
  // One-time render-module init: raw <style>/<script> text handling.
  installRawTextRendering()
  getRenderExtensions().onRenderInit()
  const profile = renderProfile(options)
  registerCssRuntime()
  const prepareStart = profileRenderMark(profile)
  try {
    await profileRenderStep(profile, 'tag action modules', () =>
      getActionModuleExtensions().tagActionModulesForRender(options.config, file =>
        importModule(file, options),
      ),
    )
    const clientComponentsPreload = preloadClientReferences(options, profile)
    const clientComponents = await profileRenderStep(
      profile,
      'mark initial client references',
      () => markClientReferences(eagerClientReferences(options), options),
    )

    // A synthetic slot entry's URL has no dedicated children page. The
    // children tree may still match it (e.g. a sibling catch-all): resolve
    // dynamically, falling back to the nearest `default.*`, else nothing.
    let pageFile: string | undefined = options.route.file
    if (options.route.synthetic) {
      if (options.route.childrenDefault) {
        pageFile = options.route.childrenDefault
      } else {
        const childrenMatch = matchSegments(
          options.config.appPath,
          pathnameSegments(trimPathname(options.url.pathname)),
        )
        if (childrenMatch?.file) {
          pageFile = childrenMatch.file
          options = {
            ...options,
            params: { ...(options.params ?? {}), ...childrenMatch.params },
          }
        }
      }
      // No implicit children page matched this synthetic entry (e.g. `/` in an
      // app whose root has only an explicit `@children` slot and no page.tsx).
      // Drop the non-existent anchor file so we don't try to import it; the
      // layout's `children` is supplied by the `@children` slot instead (see
      // childrenFromSlots).
      if (pageFile && !existsSync(pageFile)) pageFile = undefined
    }
    const props = profileRenderSyncStep(profile, 'create page props', () =>
      createPageProps(options),
    )
    const layoutFiles =
      options.layoutFiles ??
      profileRenderSyncStep(profile, 'find layouts', () =>
        findLayouts(options.config.appPath, options.route.file),
      )
    await profileRenderStep(profile, 'detect document layout', () =>
      routeHasDocumentLayout(layoutFiles),
    )
    const renderClientPageOnServer = true
    const pageModule =
      renderClientPageOnServer && pageFile
        ? ((await getRenderSpanExtensions().withFindPageComponentsSpan(options.route.route, () =>
            profileRenderStep(profile, 'import page module', () => importModule(pageFile, options)),
          )) as PageModule)
        : undefined
    let Page = pageModule?.default
    // A client-by-re-export page imported through the SERVER graph can come back as a
    // client-reference STUB: the chain crosses a server module whose client import the server
    // layer stubbed, and the stub renders `children ?? null`, so the no-JS document would ship an
    // empty page. Re-import through the client-layer loader so the page SSRs like a direct
    // 'use client' page.
    if (
      options.route.client &&
      pageFile &&
      typeof Page === 'function' &&
      (Page as unknown as ClientComponent)[clientReferenceSymbol]
    ) {
      const clientPageModule = (await importClientModule(pageFile, options)) as PageModule
      if (typeof clientPageModule.default === 'function') Page = clientPageModule.default
    }
    if (renderClientPageOnServer && !Page && pageFile) {
      throw new Error(`${pageFile} must export a default page component`)
    }
    // Whether the ORIGINAL page export is an async component - captured before the compat
    // layout-scope wrapper below replaces `Page` with a sync closure, which would defeat the async
    // exclusion in the speculative data-warm.
    const pageIsAsyncComponent = isAsyncFunctionComponent(Page)
    // A page (leaf) always sees an EMPTY layout-segment list, regardless of the
    // deepest layout's scope it renders inside. Wrap it in an empty scope so
    // useSelectedLayoutSegment(s) called in a page returns null / []. Client
    // pages (incl. re-exported client defaults, where route.client is false but
    // the page file appears among the route's client references) must NOT be
    // wrapped: replacing the component breaks its client-reference identity
    // (the island machinery matches by identity), and their hooks run
    // client-side anyway.
    const pageIsClientReference =
      options.route.client ||
      Boolean(Page && (Page as unknown as ClientComponent)[clientReferenceSymbol]) ||
      Boolean(pageFile && options.route.clientReferences.some(ref => ref.file === pageFile))
    if (Page && pageIsClientReference) {
      // A `route.client` page carries no client reference (it hydrates directly at `#pnext-page`,
      // not as an island). Tag it so the server tree resolver SSRs it through the preact renderer
      // instead of server-invoking it, which has no hooks dispatcher. Leave its identity intact -
      // no markServerReference, no scope wrapper.
      markClientPageComponent(Page)
      // A client page's props are serialized, and a NextRequest is not a plain object - Next never
      // hands one to a client page either. A page re-exporting a 'use client' default registers the
      // page file as its own client reference, so it islandifies and serializes these props, and
      // leaving `request` on them fails the whole render. Server pages keep it.
      delete (props as { request?: unknown }).request
      // A page is a leaf: useSelectedLayoutSegment(s) must return null / [].
      // A client page island would otherwise capture the innermost layout's
      // live scope, so stamp an empty snapshot onto its props (client hydration
      // reads the same empty snapshot from the island's data attribute).
      if (nextCompatEnabled(options.config)) {
        ;(props as unknown as Record<string, unknown>)[LAYOUT_SCOPE_PROP] = {
          depth: 0,
          segments: [],
          slots: {},
        } satisfies LayoutSegmentSnapshot
      }
    } else if (Page) {
      Page = markServerReference(Page)
      if (nextCompatEnabled(options.config)) {
        const PageComponent = Page
        Page = markServerReference((pageProps: PageProps) =>
          runInLayoutSegmentScope([], () => PageComponent(pageProps)),
        )
      }
    }

    // preact-render-to-string emits an async Client Page as empty HTML and
    // swallows its rejected promise. Resolve it here so its tree is SSR'd and
    // any error reaches the normal render pipeline. PPR still resolves it with
    // hanging props inside the partial tree, where Suspense can postpone it.
    let asyncClientPageResolved = false
    let resolvedAsyncClientPage: unknown
    if (
      Page &&
      pageIsClientReference &&
      !options.partial &&
      !options.fallbackParams &&
      !options.fallbackConcreteParams &&
      isAsyncFunctionComponent(Page)
    ) {
      resolvedAsyncClientPage = await (Page as (pageProps: PageProps) => Promise<unknown>)(props)
      asyncClientPageResolved = true
    }

    // A leaf page sees an empty layout-segment list. A whole-page client
    // component (route.client) SSRs directly and would otherwise inherit its
    // parent client layout's LayoutSegmentContext, so provide an empty context
    // around it. (An island page instead carries the empty snapshot stamped on
    // its props above.)
    const browserOnlyClientPage =
      pageIsClientReference && Page && clientPageRequiresBrowser(Page as ComponentType<PageProps>)
    // Keeping a browser-only page out of the server tree also hides the very throw its `typeof
    // window` guard exists to produce. Next server-renders the page and reports that throw, so probe
    // for it here and discard the markup. An async client page needs no probe: it is resolved above
    // and its throw reaches the render catch directly.
    if (browserOnlyClientPage && !asyncClientPageResolved) {
      await probeBrowserOnlyClientPageError(Page as ComponentType<PageProps>, props)
    }
    let pageNode = asyncClientPageResolved
      ? (resolvedAsyncClientPage as ComponentChildren)
      : Page && !browserOnlyClientPage
        ? h(Page as ComponentType<PageProps>, props)
        : undefined
    // A streamed whole-page client route must NOT sit under an SSR error boundary:
    // preact-render-to-string renders an error boundary's subtree with its suspense handler
    // disabled, so the page's own <Suspense> can no longer stream - the child's thrown promise
    // escapes, is treated as an error, and re-throws as a 500. The stream renderer's own onError
    // still funnels genuine errors. Islands and the non-streaming string pass keep the boundary.
    const willStreamClientPage = stream && options.route.client
    if (
      pageNode &&
      pageIsClientReference &&
      options.partial?.mode !== 'build' &&
      !willStreamClientPage
    ) {
      pageNode = h(ClientPageSsrBoundary, null, pageNode)
    }
    if (pageNode && nextCompatEnabled(options.config)) {
      pageNode = h(
        LayoutSegmentContext.Provider,
        { value: { depth: 0, segments: [], slots: {} } satisfies LayoutSegmentSnapshot },
        pageNode,
      )
    }
    // Speculative data-warm: invoke a sync server page once, discarding the result, so a
    // `use(promise)`-style fetch it memoizes at module scope starts NOW, concurrently with the
    // layouts above it. Render functions are re-invocable by React's contract, so a discarded
    // call is safe; async components are excluded (it would double-run real work), as are all
    // PPR/fallback passes (a use() on a hanging promise must not mark it read).
    if (
      Page &&
      !pageIsClientReference &&
      !pageIsAsyncComponent &&
      !options.partial &&
      !options.fallbackParams &&
      !options.fallbackConcreteParams
    ) {
      const speculativeStart = profileRenderMark(profile)
      try {
        ;(Page as (pageProps: PageProps) => unknown)(props)
      } catch {
        // Speculative only — thrown thenables/errors replay in the real render.
      }
      profileRenderSince(profile, 'speculative page warm', speculativeStart)
    }
    const page = h('div', pageSlotProps, pageNode)
    // loading.js Suspense boundaries are applied per-segment during layout
    // composition (applyLayouts), so a slow LAYOUT — not just a slow leaf page —
    // shows its nearest loading fallback. See buildLoadingBoundaries.
    const loadedPage = page
    const metadataExtensions = getActiveMetadataExtensions(options.config)
    const pageModuleRecord = pageModule as Record<string, unknown> | undefined
    const prebuiltPageMetadata = pageFile ? options.staticModuleMetadata?.[pageFile] : undefined
    const pageMetadata = pageModule
      ? (parent: Metadata) =>
          trackMetadataRedirect(
            metadataExtensions.readModuleMetadata
              ? metadataExtensions.readModuleMetadata(pageModuleRecord!, props, parent, pageFile)
              : prebuiltPageMetadata?.metadata
                ? Promise.resolve(prebuiltPageMetadata.metadata)
                : readModuleMetadata(pageModule),
          ).then(meta => meta ?? {})
      : {}
    const viewportStart = profileRenderMark(profile)
    const pageViewport = pageModule
      ? metadataExtensions.readModuleViewport
        ? await metadataExtensions.readModuleViewport(pageModuleRecord!, props)
        : prebuiltPageMetadata?.viewport
          ? prebuiltPageMetadata.viewport
          : await readModuleViewport(pageModule)
      : undefined
    profileRenderSince(profile, 'page viewport', viewportStart)
    profileRenderSince(profile, 'prepare page (props/metadata reads)', prepareStart)
    const rendered = await getRenderSpanExtensions().withRenderBodySpan(options.route.route, () =>
      profileRenderStep(profile, 'render tree', async () =>
        renderTree(
          {
            ...options,
            layoutFiles,
            clientComponents,
            clientComponentsPreload,
          },
          loadedPage,
          stream,
          pageMetadata,
          {
            propsScript: pageIsClientReference
              ? `<script>window.__PNEXT_PROPS__=${serializeProps(
                  await serializablePageProps(props, options.partial?.mode === 'build'),
                )};</script>`
              : '',
            status: options.status,
            viewport: pageViewport,
            pageMetadataDir: pageFile ? dirname(pageFile) : dirname(options.route.file),
            pageFile,
            runtimePageMetadata: pageModuleRecord
              ? Boolean(metadataExtensions.hasRuntimeMetadata?.(pageModuleRecord))
              : false,
            preferSlotMetadata: true,
          },
        ),
      ),
    )
    return rendered
  } catch (error) {
    // A partial prerender (PPR shell / runtime shell upgrade) must never bake a
    // control-flow outcome into a shell: notFound()/redirect() are per-request
    // results, and a promoted shell replays them with the shell's own 200 status
    // (app-static "should correctly handle statusCode with notFound + ISR").
    // renderPartialShell's catch discards the shell instead.
    //
    // Only the *runtime* shell regeneration paths (schedulePprShellUpgrade /
    // regenerateStalePprShell) opt in: a build-time PPR prerender still needs to
    // produce its notFound() shell, otherwise the route degrades to a fully
    // static artifact with no `postponed`
    // (cache-components-errors "notFound() with dynamic ...").
    if (options.runtimeRegen && (isRedirectError(error) || isNotFoundError(error))) throw error
    if (isRedirectError(error)) {
      return shouldRenderDocumentRedirect(options, error)
        ? renderDocumentRedirect(options, stream, error.location, error.status)
        : renderRedirectPage(error.location, error.status)
    }
    if (isNotFoundError(error)) return renderNotFoundPage(options, stream)
    // authInterrupts (COMPAT-ONLY): forbidden()/unauthorized() render their own
    // convention boundary with a dedicated status. They are gated behind
    // `experimental.authInterrupts` in Next, so core without compat.next treats
    // the sentinel as an ordinary render error (500), never a 403/401.
    if (nextCompatEnabled(options.config)) {
      if (isForbiddenError(error)) return renderAuthInterruptPage(options, stream, 'forbidden')
      if (isUnauthorizedError(error))
        return renderAuthInterruptPage(options, stream, 'unauthorized')
    }
    // Let the partial-prerender caller decide what to do with a postpone that
    // escaped every Suspense boundary instead of masking it as an error page.
    if (options.partial && isPostpone(error)) throw error
    // A real (non-control-flow) render error: report it through the compat error funnel. The
    // renderer catches page errors and produces a 500 page inline instead of rethrowing, so the
    // top-level catch never sees them - this is the single report site for render errors.
    if (!isPostpone(error)) {
      const unit = getWorkUnit()
      const request = options.request
      void reportRequestError(
        error,
        {
          method: request?.method ?? 'GET',
          url: request?.url ?? String(options.url),
          headers: request?.headers ?? new Headers(),
        },
        {
          phase: unit?.phase,
          routeKind: unit?.routeKind,
          ...(unit?.responseHints ?? {}),
          ...(options.route.client ? { renderSource: 'server-rendering' } : {}),
        },
      )
    }
    // An error thrown entirely inside pnext's own frames is a framework bug the app cannot fix:
    // in dev it gets the loud internal-error document (full trace + prefilled GitHub report)
    // instead of hiding behind the app's error boundaries or the generic global-error page.
    if (options.dev) {
      const resolved = resolveThrownError(error, nextCompatEnabled(options.config))
      if (isPnextInternalError(resolved)) {
        logDevError(options, resolved)
        return globalErrorPage(
          internalErrorHtml({
            error: resolved,
            route: options.route.route,
            url: String(options.url),
            digest: (resolved as Error & { digest?: string }).digest,
          }),
          options,
        )
      }
    }
    // A nearest error.* boundary catches first (rendered inside the document).
    // Only when no error boundary exists does global-error.* take over the whole
    // document (it supplies its own <html>/<body>); otherwise the normal error
    // page renders.
    if (!nearestConventionFile(options, 'error.tsx')) {
      const globalError = await renderGlobalErrorPage(options, error)
      if (globalError) return globalError
    }
    return renderErrorPage(options, error, stream)
  }
}

const authInterruptDefaults = {
  forbidden: {
    status: 403 as const,
    title: 'Forbidden',
    message: 'This page could not be accessed.',
  },
  unauthorized: {
    status: 401 as const,
    title: 'Unauthorized',
    message: "You're not authorized to access this page.",
  },
}

// Renders the nearest forbidden.* / unauthorized.* boundary (COMPAT
// authInterrupts). Falls back to Next's built-in HTTP-access fallback UI
// (`.next-error-h1` with the status, `h2` with the message) when no file exists.
async function renderAuthInterruptPage(
  options: RenderOptions,
  stream: boolean,
  kind: 'forbidden' | 'unauthorized',
) {
  const { status, title, message } = authInterruptDefaults[kind]
  const fallbackTree = httpAccessFallbackTree(status, message)
  const file = nearestConventionFile(options, `${kind}.tsx`)
  const boundaryOptions = optionsForNotFoundBoundary(options, file)
  if (!file || !existsSync(file)) {
    return renderTreeOrFallback(
      boundaryOptions,
      fallbackTree,
      stream,
      { title: `${status}: ${message}` },
      { status },
    )
  }
  const module = (await importModule(file, boundaryOptions)) as PageModule
  const Component = markServerReference(module.default)
  if (!Component) {
    return renderTreeOrFallback(
      boundaryOptions,
      fallbackTree,
      stream,
      { title: `${status}: ${message}` },
      { status },
    )
  }
  return renderTreeOrFallback(
    boundaryOptions,
    h('div', pageRootProps, h(Component as unknown as ComponentType<Record<string, never>>, {})),
    stream,
    (await readModuleMetadata(module)) ?? { title },
    { status },
  )
}

// global-error.* replaces the entire document when an error reaches the app root
// uncaught: it renders its own <html>/<body>, so we bypass the document shell
// and emit its markup directly. Returns undefined when no file exists (normal
// error handling applies) or when it too throws.
async function renderGlobalErrorPage(
  options: RenderOptions,
  error: unknown,
): Promise<PageRender | undefined> {
  const file = findGlobalError(options.config.appPath)
  const resolvedError = resolveThrownError(error, nextCompatEnabled(options.config))
  const clientSsrError = isClientPageSsrError(resolvedError)
  logDevError(options, resolvedError, clientSsrError)
  const errorProps = clientSsrError
    ? Object.assign(new Error(resolvedError.message), {
        name: resolvedError.name || 'Error',
        stack: undefined,
      })
    : serializableError(resolvedError, Boolean(options.dev), nextCompatEnabled(options.config))
  if (!file) {
    // No user global-error.*: render the built-in default document ("This page
    // couldn't load"). Compat supplies the Next-pixel-exact markup; a pure-core
    // app has no default global-error document (returns undefined → generic 500).
    const defaultUi = nextCompatEnabled(options.config)
      ? getRenderExtensions().defaultGlobalErrorUi(errorProps)
      : undefined
    if (defaultUi === undefined) return undefined
    const rendered = await renderVNodeToString(h(Fragment, null, defaultUi as ComponentChildren))
    return globalErrorPage(
      withGlobalErrorStylesheet(
        withGlobalErrorReportScript(`<!DOCTYPE html>${rendered}`, errorProps),
        options.config,
      ),
      options,
    )
  }
  try {
    // global-error.js is a client component ('use client'): import it through
    // the client module loader and SSR it to a full document. Server components
    // (no directive) load through the server loader.
    const clientDirective = hasUseClientDirective(await readText(file))
    const module = (
      clientDirective ? await importClientModule(file, options) : await importModule(file, options)
    ) as ErrorModule
    const GlobalError = clientDirective
      ? (module.default as ComponentType<{ error: Error; reset?: () => void }> | undefined)
      : markServerReference(module.default)
    if (!GlobalError) return undefined
    const rendered = await renderVNodeToString(
      h(
        Fragment,
        null,
        h(GlobalError as ComponentType<{ error: Error; reset?: () => void }>, {
          error: errorProps,
          reset: () => undefined,
        }),
      ),
    )
    return globalErrorPage(
      withGlobalErrorStylesheet(
        withGlobalErrorReportScript(`<!DOCTYPE html>${rendered}`, errorProps),
        options.config,
      ),
      options,
    )
  } catch {
    const defaultUi = nextCompatEnabled(options.config)
      ? getRenderExtensions().defaultGlobalErrorUi(errorProps)
      : undefined
    if (defaultUi === undefined) return undefined
    const rendered = await renderVNodeToString(h(Fragment, null, defaultUi as ComponentChildren))
    return globalErrorPage(
      withGlobalErrorStylesheet(
        withGlobalErrorReportScript(`<!DOCTYPE html>${rendered}`, errorProps),
        options.config,
      ),
      options,
    )
  }
}

// See RenderExtensions.globalErrorReportScript: the global-error document (both
// the built-in fallback and a user global-error.*) is a static document with no
// page-hydration bootstrap, so nothing would naturally re-throw the escaped
// error client-side. Compat appends a small inline reporter so the client still
// observes the same uncaught signal Next's real hydration replay produces
// (Playwright `pageerror`); core has no such script (returns undefined, markup
// unchanged).
function withGlobalErrorReportScript(html: string, error: SerializedError): string {
  const script = getRenderExtensions().globalErrorReportScript(error)
  if (!script) return html
  return appendToDocumentBody(html, script)
}

function appendToDocumentBody(html: string, content: string): string {
  const closingBodies = [...html.matchAll(/<\/body\s*>/gi)]
  const closingBody = closingBodies.at(-1)?.index
  if (closingBody === undefined) return html + content
  return html.slice(0, closingBody) + content + html.slice(closingBody)
}

/** Keep a standalone development document connected to the dev server's reload stream. */
export function withDevReloadScript(html: string, request?: Request): string {
  return appendToDocumentBody(html, devReloadScript(documentNonce(request)))
}

function withGlobalErrorStylesheet(html: string, config: ResolvedConfig): string {
  const asset = `${config.outPath}/public/assets/${emittedAssetName(config, 'global-error.css')}`
  if (!existsSync(asset)) return html
  const link = `<link rel="stylesheet" href="${assetHref(config, 'global-error.css')}">`
  if (html.includes('</head>')) return html.replace('</head>', `${link}</head>`)
  return html.replace(/<html(?:\s[^>]*)?>/i, tag => `${tag}<head>${link}</head>`)
}

// A pre-rendered document (its own <html>/<body>). The ordinary document shell
// is skipped entirely, so development adds its reload client directly.
function globalErrorPage(
  html: string,
  options: Pick<RenderOptions, 'dev' | 'request'>,
): PageRender {
  const body = options.dev ? withDevReloadScript(html, options.request) : html
  return {
    shell: 'global-error',
    body,
    htmlProps: {},
    bodyProps: {},
    head: '',
    metadata: {},
    stylesheets: [],
    fontPreloads: [],
    propsScript: '',
    routeScript: '',
    clientScript: '',
    devScript: '',
    streamChunks: [],
    status: 500,
    viewport: {},
    fontCss: '',
  }
}

function normalizeRenderOptions(options: RenderOptions): RenderOptions {
  if (!options.dev || options.devImportVersion) return options
  return { ...options, devImportVersion: String(Date.now()) }
}

// Streaming isolates each Suspense boundary, dropping client-provider context
// from ancestor layouts. Compat can narrow this through the streamRoute hook;
// core routes stream by default.
function canStreamRoute(options: RenderOptions) {
  return getStreamRouteExtensions().canStreamRoute({
    config: options.config,
    route: options.route,
  })
}

function inlineSuspenseRoute(options: RenderOptions) {
  return getStreamRouteExtensions().inlineSuspenseStream({
    config: options.config,
    route: options.route,
  })
}

function renderRedirectPage(location: string, status: number): PageRender {
  return {
    shell: 'generated',
    body: '',
    htmlProps: {},
    bodyProps: {},
    head: '',
    metadata: {},
    stylesheets: [],
    fontPreloads: [],
    propsScript: '',
    routeScript: '',
    clientScript: '',
    devScript: '',
    streamChunks: [],
    status,
    headers: { location },
    viewport: {},
    fontCss: '',
  }
}

function readLocationHeader(headers: HeadersInit): string | null {
  if (headers instanceof Headers) return headers.get('location')
  if (Array.isArray(headers)) return new Headers(headers).get('location')
  return headers.location ?? null
}

/**
 * Redirect errors that escaped a `generateMetadata` call. Next renders metadata inside a
 * Suspense boundary, so a redirect thrown there resolves AFTER the response status is fixed:
 * the document is a 200 carrying the meta-refresh envelope, whatever the route's mode
 * (metadata-navigation "should support redirect in generateMetadata").
 */
const metadataRedirects = new WeakSet<object>()

function noteMetadataRedirect(error: unknown): void {
  if (isRedirectError(error) && typeof error === 'object') metadataRedirects.add(error)
}

/**
 * Tag a metadata promise's redirect rejection. Observes the SAME promise rather than chaining
 * off it: an extra microtask here delays metadata resolution by a tick, which is enough to flip
 * the head-vs-body streaming decision (metadata-streaming "should delay the metadata render to
 * body").
 */
function trackMetadataRedirect<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(noteMetadataRedirect)
  return promise
}

function shouldRenderDocumentRedirect(options: RenderOptions, error: unknown): boolean {
  if (!nextCompatEnabled(options.config)) return false
  const request = options.request
  if (request?.method.toUpperCase() !== 'GET') return false
  if (request.headers.get('rsc') === '1') return false
  // A page/layout redirect on a dynamic route still answers with a real 307 - the render
  // throws before anything is flushed. Metadata is the exception: it is suspended, so its
  // redirect lands after the status - unless this render BLOCKS on metadata (html-limited
  // bot), where the redirect is a real 307 again.
  if (options.route.mode !== 'dynamic') return true
  return metadataRedirects.has(error as object) && !isHtmlLimitedBotRequest(options)
}

async function renderDocumentRedirect(
  options: RenderOptions,
  stream: boolean,
  location: string,
  status: number,
): Promise<PageRender> {
  const page = await renderTreeOrFallback(options, h('div', pageRootProps), stream, {})
  const seconds = status === 308 ? 0 : 1
  const meta = `<meta id="__next-page-redirect" http-equiv="refresh" content="${seconds};url=${escapeHtml(location)}"/>`
  const digest = `NEXT_REDIRECT;replace;${location};${status};`
  const flight = JSON.stringify(`E${JSON.stringify({ digest })}`).replace(/</g, '\\u003c')
  return {
    ...page,
    head: [page.head, meta].filter(Boolean).join('\n    '),
    routeScript: `${page.routeScript}<script>self.__next_f=self.__next_f||[]</script><script>self.__next_f.push([1,${flight}])</script>`,
    status: 200,
  }
}

async function resolveSelectedSlotMetadata(
  options: RenderOptions,
  matches: ResolvedSlotMatch[],
  parentEntries: MetadataEntry[],
): Promise<{ entries: MetadataEntry[]; runtime: boolean }> {
  for (const match of matches) {
    const entries: MetadataEntry[] = []
    let runtime = false
    let hasSource = false
    const props = {
      ...createPageProps(options),
      params: Promise.resolve({ ...(options.params ?? {}), ...match.params }),
    }
    const files = [
      ...match.layoutFiles.map(file => ({ file, kind: 'layout' as const })),
      ...(match.pageFile ? [{ file: match.pageFile, kind: 'page' as const }] : []),
    ]
    for (const { file, kind } of files) {
      const module = await importModule(file, options)
      const extensions = getActiveMetadataExtensions(options.config)
      const moduleRuntime = Boolean(extensions.hasRuntimeMetadata?.(module))
      runtime ||= moduleRuntime
      hasSource ||= moduleRuntime || module.metadata !== undefined
      const metadata = await readRenderModuleMetadata(
        options,
        module,
        props,
        mergeMetadataEntries(parentEntries, entries),
        file,
        options.staticModuleMetadata?.[file]?.metadata,
      )
      if (metadata) {
        entries.push({ metadata, dir: dirname(file), kind })
      }
    }
    if (hasSource) return { entries, runtime }
  }
  return { entries: [], runtime: false }
}

/**
 * One render, one buffer frame: the resource hints, head scripts and deferred scripts this render
 * collects are its own, so a render running alongside it (a build's next route, a not-found
 * document, another request) can neither drain them nor add to them.
 */
function renderTree(...args: Parameters<typeof renderTreeInFrame>): Promise<PageRender> {
  return renderBufferScope.run(newRenderBufferFrame(), () => renderTreeInFrame(...args))
}

async function renderTreeInFrame(
  options: RenderOptions,
  tree: ComponentChildren,
  stream: boolean,
  // Compat resolvers may use the merged ancestor metadata; core static
  // generation ignores it and treats metadata as build-time route data.
  pageMetadata: Metadata | ((parent: Metadata) => Promise<Metadata>) = {},
  extra: RenderTreeExtra = {},
): Promise<PageRender> {
  clearResourceHints()
  clearHeadScripts()
  clearDeferredScripts()
  const profile = renderProfile(options)
  const slotStateOut: Record<string, string> = options.slotStateOut ?? {}
  options = { ...options, slotStateOut }
  const layoutRender = await profileRenderStep(profile, 'apply layouts', () =>
    applyLayouts(options, tree),
  )
  const clientComponents: ClientComponentMap =
    options.clientComponents ?? new Map<string, ComponentType<Record<string, unknown>>>()
  if (options.clientComponentsPreload) {
    if (options.dev && lazyClientReferencePreload()) {
      // Lazy mode: the preload keeps warming in the background; the render
      // blocks only on the references it reaches (ensureClientComponent),
      // seeded with a warm route's settled marking. Soft navigations receive
      // only that settled snapshot from preloadClientReferences; discovery
      // below joins the references present in this render instead of the route.
      options.clientComponentsPreload.catch(() => undefined)
      const settled = settledMarkedReferences.get(options.route.id)
      if (settled) mergeClientComponents(clientComponents, settled)
    } else {
      mergeClientComponents(
        clientComponents,
        await profileRenderStep(
          profile,
          'await client references preload',
          () => options.clientComponentsPreload!,
        ),
      )
    }
  }
  const clientReferences: ClientReferenceMap = new Map(
    options.route.clientReferences.map(reference => [reference.id, reference]),
  )
  await profileRenderStep(profile, 'discover client references', () =>
    addDiscoveredClientReferences(layoutRender.tree, clientComponents, clientReferences, options),
  )
  const streamState: StreamState = {
    nextId: 0,
    deferred: [],
    dev: Boolean(options.dev),
    options,
    clientComponents,
    clientReferences,
    shellPending: Boolean(layoutRender.documentLayoutFile),
    inlineSuspense: stream && !options.partial && inlineSuspenseRoute(options),
  }
  // A root layout that wraps its `<html>` in a Suspense must resolve that
  // boundary through in the partial (PPR) path too — never hole the shell.
  if (options.partial && layoutRender.documentLayoutFile) {
    options.partial.shellPending = true
  }
  const resolveState: ResolveState = {
    options,
    clientComponents,
    clientReferences,
    partial: options.partial,
  }
  const shouldResolveServerTree = !options.route.client || Boolean(layoutRender.documentLayoutFile)
  const resolved = await profileRenderStep(profile, 'resolve server tree', async () =>
    shouldResolveServerTree
      ? options.partial
        ? await resolveServerTree(layoutRender.tree, resolveState)
        : stream
          ? await settleRoot(resolveServerTreeForStream(layoutRender.tree, streamState))
          : await resolveServerTree(layoutRender.tree, resolveState)
      : layoutRender.tree,
  )
  const renderBody =
    stream && (options.route.client || streamState.inlineSuspense)
      ? (vnode: VNode) => renderClientPageStreamShell(vnode, streamState)
      : renderVNodeToString
  const document = await profileRenderStep(profile, 'render document body', async () =>
    layoutRender.documentLayoutFile
      ? await readDocumentLayout(
          resolved,
          layoutRender.documentLayoutFile,
          resolveState,
          renderBody,
        )
      : {
          shell: 'generated' as const,
          htmlProps: {},
          bodyProps: {},
          head: '',
          body: await renderBody(h(Fragment, null, resolved), resolveState),
        },
  )
  // Stable per-root-layout id so the client router can detect root-layout
  // switches and fall back to an MPA navigation (rootLayoutChanged).
  if (layoutRender.documentLayoutFile) {
    document.htmlProps = {
      ...document.htmlProps,
      'data-pnext-root-layout': layoutRender.documentLayoutFile
        .slice(options.config.appPath.length + 1)
        .split('\\')
        .join('/'),
    }
  }
  // SSR-error documents must not hydrate the page component against error HTML;
  // the client entry checks this attribute and lets the error runtime own the tree.
  if ((extra.status ?? 200) >= 500) {
    document.htmlProps = { ...document.htmlProps, 'data-pnext-ssr-error': '' }
  }
  const slotMetadata = extra.preferSlotMetadata
    ? await profileRenderStep(profile, 'slot metadata', () =>
        resolveSelectedSlotMetadata(options, layoutRender.slotMatches, layoutRender.metadata),
      )
    : { entries: [], runtime: false }
  const runtimeMetadata =
    layoutRender.runtimeMetadata || Boolean(extra.runtimePageMetadata) || slotMetadata.runtime
  const metadataMayStream = shouldRenderRuntimeMetadataInBody(options, runtimeMetadata)
  let metadataNavigationHtml = ''
  let resolvedPageMetadata: Metadata
  const lateChunks: Promise<string>[] = []
  // A slow `generateMetadata` must not hold the whole navigation response: the
  // page tree is already rendered at this point, so awaiting it here delays the
  // loading fallback AND the resolved content by the metadata's own duration
  // (navigation "shows a fallback when prefetch completed"). When the metadata
  // is body-streamed anyway, resolve it as a deferred stream chunk instead.
  // Only on an RSC navigation render: a hard document load keeps blocking, so a
  // metadata notFound()/redirect() still owns the whole document.
  // Captured explicitly: the page body already populated the render's cache() scope, and a deferred
  // generateMetadata must reuse it or its cache()-wrapped values drift from what the body rendered.
  const runInCacheScope = captureCacheScope()
  // WHERE the tags land. Next renders metadata inside a Suspense in the body and React hoists
  // whatever resolved before the shell flushed into the head - so FAST metadata reads as a head
  // render and only metadata that misses the flush stays below it (conformance "metadata body
  // placement matches Next" vs metadata-streaming "should delay the metadata render to body").
  // A router payload has no head to hoist into, so it always rides the body.
  const navMetadataRender =
    Boolean(options.nav?.soft) || options.request?.headers.get('rsc') === '1'
  const startedPageMetadata =
    metadataMayStream && !navMetadataRender && typeof pageMetadata === 'function'
      ? runInCacheScope(() => pageMetadata(mergeMetadataEntries(layoutRender.metadata)))
      : undefined
  const runtimeMetadataInBody =
    metadataMayStream &&
    (navMetadataRender ||
      layoutRender.metadataMissedFlush ||
      (startedPageMetadata ? !(await settlesBeforeFlush(startedPageMetadata)) : false))
  const pendingPageMetadata =
    typeof pageMetadata === 'function' &&
    deferrableNavigationMetadata(options, runtimeMetadataInBody, stream)
      ? Promise.resolve().then(() =>
          runInCacheScope(() => pageMetadata(mergeMetadataEntries(layoutRender.metadata))),
        )
      : undefined
  try {
    resolvedPageMetadata = pendingPageMetadata
      ? {}
      : startedPageMetadata
        ? await startedPageMetadata
        : typeof pageMetadata === 'function'
          ? await pageMetadata(mergeMetadataEntries(layoutRender.metadata))
          : pageMetadata
  } catch (error) {
    if (options.partial?.mode === 'build' && isPostpone(error)) {
      options.partial.metadataDynamic = true
      resolvedPageMetadata = {}
    } else if (
      options.request &&
      nextCompatEnabled(options.config) &&
      isNotFoundError(error) &&
      !isHtmlLimitedBotRequest(options)
    ) {
      // Streamed metadata resolves after the status is sent, so notFound() lands as a client
      // boundary on a 200. A bot's metadata BLOCKS, so its notFound() is a real 404
      // (metadata-streaming "blocking 404 response status when html limited bots").
      return renderNotFoundPage(options, stream, { status: 200, nextFlightText: true })
    } else if (!metadataMayStream) {
      // Blocking metadata (an html-limited bot, a build prerender): its control flow still owns
      // the whole response.
      throw error
    } else if (isNotFoundError(error)) {
      return renderNotFoundPage(options, stream, { status: 200, nextFlightText: true })
    } else if (isRedirectError(error) && runtimeMetadataInBody) {
      metadataNavigationHtml = metadataRedirectHtml(error.location, error.status)
      resolvedPageMetadata = {}
    } else {
      // Head-placed metadata carries no body chunk to hold the envelope; the document-level
      // handler emits it (200 + meta refresh, or a real 307 for a blocking bot render).
      throw error
    }
  }
  const streamRuntimeMetadataInBody =
    options.partial?.mode === 'build' ? options.partial.metadataDynamic : runtimeMetadataInBody
  // On a host render the anchor page is the PREVIOUSLY selected slot page. Its metadata is stale
  // - the newly matched slot page is in `slotMetadata.entries` - and the page entry merges last,
  // so it would win the title. Drop the anchor entry when it is itself a superseded slot page;
  // any other case keeps the current order.
  const hostRender =
    Boolean(options.nav?.soft) &&
    trimPathname(options.nav?.targetPath ?? options.url.pathname) !==
      trimPathname(options.nav?.childrenPath ?? options.url.pathname)
  const anchorPageFile = extra.pageFile
  const supersededSlotPage =
    hostRender &&
    anchorPageFile !== undefined &&
    layoutRender.slotMatches.some(
      match =>
        match.pageFile &&
        match.pageFile !== anchorPageFile &&
        anchorPageFile.startsWith(`${match.slotDir}${sep}`),
    )
  const staticMetadataScan = profileRenderMark(profile)
  const staticMetadataBase =
    options.route.interception && options.staticMetadataFiles
      ? staticMetadataForRouteFromFiles(
          options.staticMetadataFiles,
          options.config.appPath,
          options.route.file,
          options.url.pathname,
        )
      : options.route.interception
        ? staticMetadataForRoute(options.config.appPath, options.route.file, options.url.pathname)
        : options.staticMetadataFiles
          ? staticMetadataForPathFromFiles(options.staticMetadataFiles, options.url.pathname)
          : staticMetadataForPath(options.config.appPath, options.url.pathname)
  profileRenderSince(profile, 'static metadata scan', staticMetadataScan)
  const metadataExtensions = getActiveMetadataExtensions(options.config)
  const hasMetadataExtensions = Boolean(metadataExtensions.readModuleMetadata)
  const prebuiltRouteMetadata = hasMetadataExtensions
    ? undefined
    : options.staticRouteMetadata?.[staticRouteMetadataKey(options.url.pathname)]
  // No prebuilt entry means nobody has resolved app/manifest.ts & friends for this
  // pathname yet: dev never prebuilds, and the build only prebuilds paths it knows
  // (so every parameterised route arrives here). Resolving is the only way those
  // documents carry the same metadata-file links as the paramless ones. An app with
  // no dynamic metadata files short-circuits inside withDynamicMetadataRoutes.
  const staticMetadata =
    prebuiltRouteMetadata ??
    (await profileRenderStep(profile, 'dynamic metadata routes', () =>
      withDynamicMetadataRoutes(
        staticMetadataBase,
        options.config.appPath,
        options.route.file,
        options.url.pathname,
        file => importModule(file, options),
      ),
    ))
  const composeMetadata = (pageMeta: Metadata) => {
    const merged = supersededSlotPage
      ? mergeMetadataEntries(layoutRender.metadata, slotMetadata.entries)
      : mergeMetadataEntries(layoutRender.metadata, slotMetadata.entries, {
          metadata: pageMeta,
          dir: extra.pageMetadataDir,
          kind: 'page',
        })
    const pageContext = metadataContext({
      metadata: pageMeta,
      metadataUrl: options.url.href,
      fontPreloads: [],
      stylesheets: [],
    })
    const iconLinks =
      streamRuntimeMetadataInBody && extra.runtimePageMetadata && pageMeta.icons !== undefined
        ? [
            headLinks(
              {
                metadata: { icons: undefined },
                metadataUrl: options.url.href,
                fontPreloads: [],
                stylesheets: [],
                staticMetadata,
              },
              pageContext,
            ),
            metadataIconLinks(pageMeta, pageContext, '    '),
          ]
            .filter(Boolean)
            .join('\n')
        : ''
    const applied = applyStaticMetadata(merged, staticMetadata)
    const bodyPage: MetadataRenderPage = {
      metadata: iconLinks ? { ...applied, icons: undefined } : applied,
      metadataUrl: options.url.href,
      fontPreloads: [],
      stylesheets: [],
      staticMetadata,
      ...(iconLinks ? { suppressIconLinks: true } : {}),
    }
    return { metadata: applied, bodyIconLinks: iconLinks, bodyMetadataPage: bodyPage }
  }
  const { metadata, bodyIconLinks, bodyMetadataPage } = profileRenderSyncStep(
    profile,
    'compose metadata',
    () => composeMetadata(resolvedPageMetadata),
  )
  const bodyMetadata =
    streamRuntimeMetadataInBody && !pendingPageMetadata
      ? [metadataBodyHtml(bodyMetadataPage), metadataNavigationHtml].filter(Boolean).join('\n    ')
      : ''
  if (pendingPageMetadata) {
    lateChunks.push(
      pendingPageMetadata.then(
        pageMeta => {
          const late = composeMetadata(pageMeta ?? {})
          return [
            metadataBodyHtml(late.bodyMetadataPage),
            late.bodyIconLinks,
            late.bodyIconLinks ? iconInsertionScript() : '',
          ]
            .filter(Boolean)
            .join('\n    ')
        },
        // The document is already flushed, so a control-flow throw can no
        // longer replace it: a redirect still navigates from the body, and any
        // other failure degrades to a page with no request-time metadata rather
        // than a torn stream.
        error => (isRedirectError(error) ? metadataRedirectHtml(error.location, error.status) : ''),
      ),
    )
  }
  const viewport = mergeViewport(...layoutRender.viewport, extra.viewport ?? {})
  if (options.partial?.mode === 'request' && options.partial.metadataDynamic) {
    options.partial.chunks.push(
      [
        metadataBodyHtml(bodyMetadataPage),
        // metadataBodyHtml carries no viewport and theme-color is head-only, so
        // a request-time viewport (a not-found boundary's generateViewport)
        // would be lost when its shell head was built without it.
        extra.viewportInBody ? themeColorTags(viewport.themeColor) : '',
        metadataNavigationHtml,
      ]
        .filter(Boolean)
        .join('\n    '),
    )
  }
  const fonts = await profileRenderStep(profile, 'font assets', () =>
    getFontExtensions().collectFontAssets(options.config, { dev: options.dev }),
  )
  const assembleStart = profileRenderMark(profile)
  const resourceHints = profileRenderSyncStep(profile, 'resource hints', () => [
    ...takeResourceHints(),
  ])
  // Dynamic-import chunks ship as Next does: `preload as=script` at low
  // fetchpriority, emitted after the render-blocking stylesheet so they stay
  // off the critical path.
  const dynamicModulePreloads = profileRenderSyncStep(profile, 'dynamic preloads', () =>
    (options.route.clientDynamicImports ?? []).map(asset =>
      withAssetPrefix(options.config, clientAssetPath(options.config, asset)),
    ),
  )
  const deferredScripts = profileRenderSyncStep(profile, 'deferred scripts', () =>
    renderDeferredScriptRuntime(takeDeferredScripts()),
  )
  const nonce = profileRenderSyncStep(profile, 'document nonce', () =>
    documentNonce(options.request),
  )
  const stylesheetPrecedence = profileRenderSyncStep(profile, 'stylesheet precedence', () =>
    getDocumentScriptExtensions().stylesheetPrecedence(options.config),
  )
  const cssHrefStart = profileRenderMark(profile)
  let globalStylesheet =
    // global-not-found replaces the document without the root layout, so the
    // root layout's global sheet must not load (its CSS ships in the route's
    // own chunk, built with includeGlobalCss).
    options.route.id === 'global-not-found' ? undefined : globalCssHref(options.config)
  let routeStylesheet = routeCssHref(options.route, options.config)
  // File names, not logical ones: the inline path READS these off disk, so it has
  // to spell them the way the build emitted them (content-hashed in production).
  const stylesheetAssets = [
    ...(globalStylesheet ? ['global.css'] : []),
    ...routeCssAssetNames(options.route),
  ].map(name => emittedAssetName(options.config, name))
  profileRenderSince(profile, 'css hrefs', cssHrefStart)
  const inlineStylesheets = profileRenderSyncStep(profile, 'inline stylesheets', () =>
    getCssExtensions().inlineStylesheets(options.config, {
      assetNames: stylesheetAssets,
      dev: Boolean(options.dev),
      ...(fonts.css ? { prependCss: fonts.css } : {}),
      ...(nonce ? { nonce } : {}),
    }),
  )
  if (!inlineStylesheets && fonts.css) {
    const fontAsset = await profileRenderStep(profile, 'font stylesheet', () =>
      emitFontCssStylesheet(options.config, options.route.id, fonts.css, stylesheetAssets[0], {
        dev: Boolean(options.dev),
      }),
    )
    const fontHref = assetHref(options.config, fontAsset)
    if (globalStylesheet) globalStylesheet = fontHref
    else if (Array.isArray(routeStylesheet))
      routeStylesheet = [fontHref, ...routeStylesheet.slice(1)]
    else routeStylesheet = fontHref
  }
  const stylesheetsStart = profileRenderMark(profile)
  const stylesheets = (
    inlineStylesheets
      ? []
      : [
          { url: globalStylesheet, dataPrecedence: stylesheetPrecedence },
          {
            url: routeStylesheet,
            dataPrecedence:
              (options.route.clientDynamicImports?.length ?? 0) > 0
                ? 'dynamic'
                : stylesheetPrecedence,
          },
        ]
  )
    .filter((entry): entry is { url: string | string[]; dataPrecedence: string | undefined } =>
      Boolean(entry.url),
    )
    .map(({ url, dataPrecedence }) => ({
      url,
      ...(dataPrecedence ? { dataPrecedence } : {}),
    }))
  profileRenderSince(profile, 'stylesheet list', stylesheetsStart)
  profileRenderSince(profile, 'assemble a: stylesheets', assembleStart)
  const assembleB = profileRenderMark(profile)
  // Without these the browser learns the chunk list only after the entry
  // module arrives, forcing a second request round. Dev entries are single
  // bundles and never populate clientEntryImports.
  const modulePreloads = (options.route.clientEntryImports ?? []).map(asset =>
    withAssetPrefix(options.config, clientAssetPath(options.config, asset)),
  )
  const bootstrapScripts = modulePreloads
    .map(src => `<script async type="module" src="${escapeHtml(src)}"></script>`)
    .join('\n')
  const compatBuildManifestScript =
    nextCompatEnabled(options.config) && !options.dev
      ? `<script src="${escapeHtml(withAssetPrefix(options.config, '/_next/static/pnext/_buildManifest.js'))}"></script>`
      : ''
  // Inlined CSS is a stylesheet, not a script: it belongs at the stylesheet slot so the cascade
  // (and the emitted order) matches the linked path.
  const headStyles = inlineStylesheets?.join('\n') ?? ''
  const headScripts = profileRenderSyncStep(profile, 'head scripts', () =>
    [
      renderCollectedHeadScripts(),
      bootstrapScripts,
      compatBuildManifestScript,
      prefetchModeScript(options.config),
    ]
      .filter(Boolean)
      .join('\n'),
  )
  const clientScript = needsClientEntry(options.route)
    ? `<script async type="module" src="${withAssetPrefix(options.config, clientAssetPath(options.config, clientScriptPath(options.route, options.dev)))}"></script>`
    : ''
  profileRenderSince(profile, 'assemble b: scripts', assembleB)
  const navStateScript = profileRenderSyncStep(profile, 'nav state script', () =>
    navigationStateScript(options, slotStateOut),
  )
  const routeScriptStart = profileRenderMark(profile)
  // Param routes always embed the route state, even with no client entry: the optimistic-routing
  // trie learns a route pattern + prefetch kind from a served shell's `__PNEXT_ROUTE__`, and a
  // fully server-rendered `[param]` page would otherwise never teach it. A DOM bot hitting a PPR
  // route also bypasses static-shell-only serving and receives the fully resolved dynamic stream,
  // so a JS-executing crawler observes the streamed dynamic values.
  const domBotScript =
    (options.route.ppr || cacheComponents()) && isDomBotRequest(options)
      ? domBotFlightScript(resolved)
      : ''
  const pageVary = bakedShellPageVary(options)
  const routeScript =
    navStateScript +
    (needsClientEntry(options.route) || options.route.ppr || options.route.route.includes(':')
      ? `<script>window.__PNEXT_ROUTE__=${serializeProps(
          getRenderExtensions().clientRouteState(options.route, {
            // Bracket-free route encoding: the internal colon form never embeds `[x]`/`%5Bx%5D`
            // placeholders in the response body, which Next's segment-cache suite forbids. Optional
            // catch-all is carried as a separate flag - the colon form alone cannot distinguish
            // `[...slug]` from `[[...slug]]`.
            route: options.route.route,
            ...(options.route.catchAllOptional ? { catchAllOptional: true } : {}),
            params: options.params ?? {},
            ...(pageVary ? { pageVary } : {}),
          }),
        )};</script>`
      : '') +
    domBotScript
  const devScript = options.dev ? devReloadScript() : ''
  profileRenderSince(profile, 'route state script', routeScriptStart)
  profileRenderSince(profile, 'assemble head + scripts', assembleStart)
  return {
    ...document,
    metadata,
    stylesheets,
    modulePreloads,
    dynamicScriptPreloads: dynamicModulePreloads,
    resourceHints,
    staticMetadata,
    fontPreloads: fonts.preloads,
    headStyles,
    headScripts,
    deferredScripts,
    nonce,
    propsScript: extra.propsScript ?? '',
    routeScript,
    clientScript,
    hasClientMounts: pageSlotIsMountTarget(options),
    devScript,
    streamChunks: streamState.deferred,
    lateChunks,
    status: extra.status,
    viewport,
    fontCss: '',
    ...(bodyIconLinks ? { bodyIconLinks } : {}),
    ...(bodyMetadata ? { bodyMetadata } : {}),
    ...(bodyMetadata || pendingPageMetadata ? { metadataInBody: true } : {}),
    compatBodyScript: getDocumentScriptExtensions().documentBodyScripts(options.config),
    // The shell's server-inserted HTML was drained when the stream shell
    // finished (streamState.insertedHead); anything still registered is emitted
    // by the compat hook's own drain, so both end up in the head exactly once.
    documentHeadTags:
      (streamState.insertedHead ?? '') +
      (getDocumentScriptExtensions().documentHeadTags?.(options.config, {
        // A render is "dynamic" (request-dependent) in dev, or for a route built
        // in dynamic mode. Compat gates clientTraceMetadata off this + isNextStart.
        dynamic: options.dev || options.route.mode === 'dynamic',
        rsc: options.request?.headers.get('rsc') === '1',
      }) ?? ''),
    metadataUrl: options.url.href,
  }
}

/**
 * The vary set of the PAGE these bytes carry, when the render is a BAKED SHELL - the params the
 * shell's own markup depends on. A fallback shell renders with every param HANGING, so its bytes
 * provably read none (`[]`); a sub-shell depends on exactly its concrete prefix; any other render
 * reports undefined and keeps keying on its exact URL.
 *
 * Published into `__PNEXT_ROUTE__` because that is what the CLIENT can read back off a HARD-LOADED
 * document - a navigation response carries the same set in its segment payload, but the initial
 * HTML has neither payload nor headers, so without this the seeded entry never shares.
 *
 * Gated on the render OPTIONS, never on `route.ppr`: `ppr` is assigned to the manifest entry AFTER
 * the shell render returns, so a `route.ppr` gate emits nothing into the very bytes that need it.
 */
function bakedShellPageVary(options: RenderOptions): string[] | undefined {
  if (options.fallbackConcreteParams) return Object.keys(options.fallbackConcreteParams)
  if (options.fallbackParams) return []
  return undefined
}

/**
 * Whether this render may resolve `generateMetadata` AFTER the document has flushed, as a deferred
 * stream chunk. Only a navigation that ASKED for it qualifies (`x-pnext-late-metadata`): that
 * client already owns a document, so late metadata simply retitles it. A hard load, a prefetch and
 * every non-streaming or partial render keep the blocking resolve - those are the paths where a
 * metadata notFound()/redirect() still has to replace the whole response.
 */
function deferrableNavigationMetadata(
  options: RenderOptions,
  runtimeMetadataInBody: boolean,
  stream: boolean,
) {
  if (!runtimeMetadataInBody || !stream || options.partial) return false
  const request = options.request
  if (!request) return false
  if (request.headers.get('x-pnext-late-metadata') !== '1') return false
  if (request.headers.get('next-router-prefetch') === '1') return false
  return !getRouterProtocolExtensions().shellOnlyRequest(request, options.route)
}

/**
 * True when `promise` settles without waiting on I/O - a streaming server would still be building
 * the shell, so React would hoist the resolved tags into the head. A timer/network await loses the
 * race and the tags land in the body instead.
 */
function settlesBeforeFlush(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 0)),
  ])
}

function shouldRenderRuntimeMetadataInBody(options: RenderOptions, runtimeMetadata: boolean) {
  if (!runtimeMetadata) return false
  // Placement is a function of the USER AGENT alone (Next's shouldServeStreamingMetadata): a
  // document GET from a browser streams its metadata into the body exactly like an RSC
  // navigation does, and only an html-limited bot gets the blocking head render.
  if (!options.dev && options.route.mode !== 'dynamic') return false
  return Boolean(
    getActiveMetadataExtensions(options.config).shouldRenderMetadataInBody?.({
      config: options.config,
      ...(options.request ? { request: options.request } : {}),
    }),
  )
}

/**
 * Inline script exposing the configured default prefetch mode to the client router, which applies it
 * to links carrying no `data-prefetch` of their own. Emitted only when `prefetch` is configured - an
 * app that leaves it unset keeps the global undefined and the built-in 'visible' default.
 */
function prefetchModeScript(config: ResolvedConfig): string {
  if (config.prefetch === undefined) return ''
  return `<script>window.__PNEXT_PREFETCH__=${JSON.stringify(config.prefetch)};</script>`
}

/**
 * Embeds the render's navigation state (children source path + each slot's
 * resolved source path). The client echoes it on soft-navigation fetches so
 * unmatched slots keep their content, and stores it per history entry for
 * back/forward restoration.
 */
function navigationStateScript(options: RenderOptions, slots: Record<string, string>) {
  const children = trimPathname(options.nav?.childrenPath ?? options.url.pathname)
  // The query the children tree rendered with: the request's on a direct
  // render, the inherited recorded one on a host render (where the request URL
  // is the intercepted target, not the children source).
  const hostRender = Boolean(options.nav?.soft) && children !== trimPathname(options.url.pathname)
  const childrenSearch = hostRender
    ? (options.nav?.state?.childrenSearch ?? '')
    : stripRscSearch(options.url.search)
  // A synthetic slot entry whose children fall back to `default.*`: the path
  // belongs to the parallel slot that matched it, so the children slot is
  // Next's `__DEFAULT__` and reports no selected segment.
  const childrenDefault = Boolean(options.route.synthetic && options.route.childrenDefault)
  // Static classification of the served document, inlined so a HARD LOAD (no `x-nextjs-stale-time`
  // response header) can seed its prefetch entry with the true STATIC reuse window instead of the
  // dynamic default. Mirrors the `staleTime`/`isStatic` fields the `/_tree` payload carries.
  //
  // A `generateStaticParams` route is dynamic-MODE yet the document served for a PRERENDERED param
  // set is a complete static artifact - classify it as static too, or its hard load seeds the
  // dynamic window and every later navigation refetches it.
  const isStatic = options.route.mode === 'static' || rendersPrerenderedParams(options)
  // `route.cacheLife` is captured FROM a render and persisted onto the manifest only afterwards, so
  // it is empty during the build prerender that produces this very document. Prefer the manifest
  // value (serve-time renders), fall back to the live render scope (build prerenders).
  const staleTime =
    options.route.cacheLife?.staleSeconds ?? getRenderExtensions().currentCacheStaleSeconds()
  const state: NavState = {
    children,
    ...(childrenSearch ? { childrenSearch } : {}),
    ...(Object.keys(slots).length > 0 ? { slots } : {}),
    ...(childrenDefault ? { childrenDefault } : {}),
    ...(isStatic ? { isStatic: true } : {}),
    // A BAKED SHELL is not a static DOCUMENT (its holes still stream per
    // request), but the bytes above the holes ARE a prerender. Published
    // separately from `isStatic` so the client can file the hard load's static
    // STAGE as reusable without widening the whole document's reuse window.
    ...(bakedShellPageVary(options) ? { staticStage: true } : {}),
    ...(typeof staleTime === 'number' ? { staleTime } : {}),
    // Mark interception host renders so the client keeps them host-bound (never
    // reused for a navigation from another host, nor as the direct target).
    ...(hostRender ? { hostRender: true } : {}),
  }
  const json = JSON.stringify(state).replace(/</g, '\\u003c')
  return `<script id="__PNEXT_NAV_STATE__" type="application/json">${json}</script>`
}

function trimPathname(pathname: string) {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') || '/' : pathname
}

/**
 * True when this render's params are a set the route PRERENDERS at build and nothing about the
 * render is partial - i.e. the document is a complete static artifact. A fallback/partial shell is
 * explicitly NOT static: the client must keep fetching its dynamic stage.
 */
function rendersPrerenderedParams(options: RenderOptions): boolean {
  if (options.partial || options.fallbackParams || options.fallbackConcreteParams) return false
  const sets = options.route.prerenderedParams
  if (!sets?.length) return false
  const paramKeys = [
    ...options.route.params,
    ...(options.route.catchAll ? [options.route.catchAll] : []),
  ]
  const rendered = options.params ?? {}
  return sets.some(
    set => paramKeys.length > 0 && paramKeys.every(key => sameParamValue(set[key], rendered[key])),
  )
}

/** Compare a manifest param value against a rendered one (encoding-insensitive). */
function sameParamValue(
  expected: RouteParamValue | undefined,
  actual: RouteParamValue | undefined,
) {
  if (expected === undefined || actual === undefined) return false
  const normalize = (value: RouteParamValue) => {
    const text = Array.isArray(value) ? value.join('/') : String(value)
    try {
      return decodeURIComponent(text)
    } catch {
      return text
    }
  }
  return normalize(expected) === normalize(actual)
}

/**
 * A recordable search string: the router's `_rsc` union query is a CDN cache key on soft-nav
 * fetches, never an app search param - recording it would make a later slot re-render see it as
 * page searchParams.
 */
function stripRscSearch(search: string): string {
  if (!search.includes('_rsc')) return search
  const params = new URLSearchParams(search)
  params.delete('_rsc')
  const stripped = params.toString()
  return stripped ? `?${stripped}` : ''
}

async function addDiscoveredClientReferences(
  tree: ComponentChildren,
  components: ClientComponentMap,
  references: ClientReferenceMap,
  options: RenderOptions,
) {
  const discovered = new Map<string, ClientReference>()
  collectClientReferences(tree, discovered)
  // Lazy mode: register ids only; ensureClientComponent imports the references
  // the render actually reaches at emission time. A dev soft navigation is the
  // exception: compile the references in its rendered tree before shell emission
  // so application Suspense cannot expose a compile-only fallback.
  const lazy = Boolean(options.dev) && lazyClientReferencePreload() && !options.nav?.soft
  await Promise.all(
    [...discovered.values()].map(async reference => {
      const resolved = references.get(reference.id) ?? reference
      references.set(reference.id, resolved)
      if (lazy) return
      if (!ssrClientReference(resolved)) return
      if (components.has(reference.id)) return
      const module = await importClientModule(reference.file, options)
      const component = clientComponentExport(module, reference.exportName, reference.file)
      if (!component) return
      component[clientReferenceSymbol] = reference
      components.set(reference.id, component as ComponentType<Record<string, unknown>>)
    }),
  )
}

function collectClientReferences(node: unknown, references: Map<string, ClientReference>) {
  if (node == null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) collectClientReferences(child, references)
    return
  }
  if (!isVNode(node)) return
  const reference =
    typeof node.type === 'function'
      ? (node.type as ClientComponent)[clientReferenceSymbol]
      : undefined
  if (reference) references.set(reference.id, reference)
  collectClientReferences(node.props.children, references)
}

// Build the loading.js fallback VNode for a single segment's `loading.*` file,
// or undefined when the file has no usable default export. Client loading
// components render as islands; server ones are invoked inline.
async function buildLoadingFallback(
  options: RenderOptions,
  loadingFile: string,
): Promise<VNode<any> | undefined> {
  const loadingReference = conventionDefaultReference(options, loadingFile)
  const Loading = loadingReference
    ? (options.clientComponents?.get(loadingReference.id) ?? clientReferenceStub(loadingReference))
    : undefined
  if (Loading) return h(Loading, {})
  const loadingModule = (await importModule(loadingFile, options)) as LoadingModule
  const ServerLoading = markServerReference(loadingModule.default)
  if (!ServerLoading) return undefined
  return h(ServerLoading as ComponentType<Record<string, never>>, {})
}

// Collect each segment's loading.js fallback and assign it to the nearest enclosing layout
// directory. A loading boundary must sit INSIDE that layout, wrapping its children, so a slow
// layout postpones at the parent layout's boundary and shows the fallback. Returns a
// per-layout-dir list ordered deepest-first. Each entry keeps its OWN loading dir: the boundary
// guards the segment that dir names, not the segment below the layout it was hoisted into, and
// everything depth-sensitive has to read that dir.
async function buildLoadingBoundaries(
  options: RenderOptions,
  layoutDirs: string[],
): Promise<Map<string, LoadingBoundary[]>> {
  const fallbackByDir = new Map<string, VNode<any>>()
  for (const loadingFile of findConventionFiles(
    options.config.appPath,
    options.route.file,
    'loading.tsx',
  )) {
    if (!existsSync(loadingFile)) continue
    const fallback = await buildLoadingFallback(options, loadingFile)
    if (fallback) fallbackByDir.set(dirname(loadingFile), fallback)
  }
  const layoutDirSet = new Set(layoutDirs)
  const outermostLayoutDir = layoutDirs[layoutDirs.length - 1]
  const nearestLayoutDir = (loadingDir: string): string | undefined => {
    let dir = loadingDir
    while (dir.startsWith(options.config.appPath)) {
      if (layoutDirSet.has(dir)) return dir
      if (dir === options.config.appPath) break
      dir = dirname(dir)
    }
    return outermostLayoutDir
  }
  const byLayoutDir = new Map<string, LoadingBoundary[]>()
  // Deepest loading dirs first so each layout's list stays deepest-first.
  const loadingDirs = [...fallbackByDir.keys()].sort((a, b) => b.length - a.length)
  for (const loadingDir of loadingDirs) {
    const target = nearestLayoutDir(loadingDir)
    if (!target) continue
    const list = byLayoutDir.get(target) ?? []
    list.push({ fallback: fallbackByDir.get(loadingDir)!, loadingDir })
    byLayoutDir.set(target, list)
  }
  return byLayoutDir
}

/** A `loading.tsx` fallback and the segment dir it actually guards. */
interface LoadingBoundary {
  fallback: VNode<any>
  loadingDir: string
}

function conventionDefaultReference(options: RenderOptions, file: string) {
  return options.route.clientReferences.find(
    reference => reference.file === file && reference.exportName === 'default',
  )
}

function clientReferenceStub(reference: ClientReference) {
  const component = (() => null) as ClientComponent
  component[clientReferenceSymbol] = reference
  return component as ComponentType<Record<string, unknown>>
}

// HTTP-access fallback UI (not-found/forbidden/unauthorized) when the app ships
// no boundary file. Compat skins the Next-pixel-exact markup (`h1.next-error-h1`
// + `h2` message) via the httpAccessFallbackUi render extension; core keeps a
// compact built-in (`<h1>404</h1><h2>message</h2>`) when compat is off.
function httpAccessFallbackTree(status: number, message: string) {
  const skinned = getRenderExtensions().httpAccessFallbackUi(status, message)
  if (skinned !== undefined) return h('div', pageRootProps, skinned as ComponentChildren)
  return h('div', pageRootProps, h('h1', null, String(status)), h('h2', null, message))
}

function defaultNotFoundTree() {
  return httpAccessFallbackTree(404, 'This page could not be found.')
}

/**
 * The built-in 404 document, standalone - no route, no layout chain, no client entry, so nothing
 * of the app's server graph is imported to produce it. A build whose app defines no not-found.*
 * uses this for its `_not-found` artifacts; runtime 404s stay dynamic and DO render through the
 * app's layouts.
 */
export function defaultNotFoundDocument(): string {
  const body = renderToString(h(Fragment, null, defaultNotFoundTree()))
  return (
    '<!DOCTYPE html><html><head><meta charSet="utf-8"/>' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"/>' +
    '<title>404: This page could not be found.</title>' +
    '<meta name="robots" content="noindex"/>' +
    `</head><body>${body}</body></html>`
  )
}

async function renderNotFoundPage(
  options: RenderOptions,
  stream: boolean,
  extra: {
    status?: number
    nextFlightText?: boolean
    forceDefault?: boolean
    skipNoindex?: boolean
  } = {},
) {
  const status = extra.status ?? 404
  // Server-action 404s carry no fallback robots (Next's NonIndex skip).
  const fallbackRobots = extra.skipNoindex ? {} : { robots: 'noindex' }
  // forceDefault: globalNotFound is enabled but no global-not-found.* exists —
  // skip the app's not-found.* boundary and render the built-in default 404.
  const file = extra.forceDefault ? undefined : nearestConventionFile(options, 'not-found.tsx')
  const notFoundOptions = optionsForNotFoundBoundary(options, file)
  if (!file) {
    const page = await renderTreeOrFallback(
      notFoundOptions,
      defaultNotFoundTree(),
      stream,
      { title: '404: This page could not be found.', ...fallbackRobots },
      { status },
    )
    return extra.nextFlightText ? withNextFlightText(page) : page
  }
  // A `'use client'` not-found.js with a discovered client reference renders as an island (same as
  // error.js) so it HYDRATES - its hooks must work on the 404 document. Server-rendering it would
  // serialize child event-handler props as dead action stubs.
  const clientDirective = hasUseClientDirective(await readText(file))
  const clientReference = clientDirective
    ? conventionDefaultReference(notFoundOptions, file)
    : undefined
  const module = (
    clientDirective && clientReference
      ? await importClientModule(file, notFoundOptions)
      : await importModule(file, notFoundOptions)
  ) as PageModule
  let NotFound = module.default
  if (clientDirective && clientReference && NotFound) {
    ;(NotFound as unknown as ClientComponent)[clientReferenceSymbol] = clientReference
  } else {
    NotFound = markServerReference(NotFound)
  }
  if (!NotFound) {
    const page = await renderTreeOrFallback(
      notFoundOptions,
      defaultNotFoundTree(),
      stream,
      { title: '404: This page could not be found.', ...fallbackRobots },
      { status },
    )
    return extra.nextFlightText ? withNextFlightText(page) : page
  }
  // The boundary module's metadata is resolved the same way a page's is, so a
  // not-found.tsx with generateMetadata/generateViewport (compat) contributes
  // its title/description/viewport instead of falling back to 'Not found'
  // (cache-components-errors http-access-fallback-prerender).
  const metaExt = getActiveMetadataExtensions(notFoundOptions.config)
  const metaProps: PageProps = {
    params: Promise.resolve(notFoundOptions.params ?? {}),
    searchParams: Promise.resolve({}),
    ...(notFoundOptions.request ? { request: pageRequest(notFoundOptions.request) } : {}),
  }
  const moduleRecord = module as unknown as Record<string, unknown>
  // A request-time head (generateMetadata/generateViewport) must never be baked
  // into a build-time PPR shell: mark the shell's metadata dynamic and let the
  // request render stream the resolved head into the body instead.
  const runtimeNotFoundMetadata = Boolean(metaExt.hasRuntimeMetadata?.(moduleRecord))
  const skipDynamicHead = notFoundOptions.partial?.mode === 'build' && runtimeNotFoundMetadata
  if (skipDynamicHead) notFoundOptions.partial!.metadataDynamic = true
  const resolvedMetadata = skipDynamicHead
    ? (module.metadata ?? {})
    : ((metaExt.readModuleMetadata
        ? await metaExt.readModuleMetadata(moduleRecord, metaProps, {}, file)
        : await readModuleMetadata(module)) ?? { title: 'Not found' })
  const resolvedViewport = skipDynamicHead
    ? undefined
    : metaExt.readModuleViewport
      ? await metaExt.readModuleViewport(moduleRecord, metaProps)
      : await readModuleViewport(module)
  const page = await renderTreeOrFallback(
    notFoundOptions,
    h('div', pageRootProps, h(NotFound as unknown as ComponentType<Record<string, never>>, {})),
    stream,
    // On the skip path a baked `<title>Not found</title>` would precede the
    // streamed metadata chunk in document order and win `document.title`.
    { ...fallbackRobots, ...resolvedMetadata },
    {
      status,
      ...(resolvedViewport ? { viewport: resolvedViewport } : {}),
      ...(runtimeNotFoundMetadata ? { viewportInBody: true } : {}),
    },
  )
  return extra.nextFlightText ? withNextFlightText(page) : page
}

function optionsForNotFoundBoundary(
  options: RenderOptions,
  boundaryFile: string | undefined,
): RenderOptions {
  // With a boundary file, the boundary sits at that file's segment. Without one, Next injects a
  // default HTTP-access boundary at the *leaf* segment, so every ancestor layout - including
  // nested group layouts - stays mounted around the fallback. Anchor the default boundary at the
  // throwing route's own directory so layout discovery keeps that whole chain.
  const boundaryDir = boundaryFile ? dirname(boundaryFile) : dirname(options.route.file)
  const containsBoundary = (file: string) => {
    const pathFromSegment = relative(dirname(file), boundaryDir)
    return (
      pathFromSegment === '' ||
      (pathFromSegment !== '..' && !pathFromSegment.startsWith(`..${sep}`))
    )
  }
  const layoutFiles = (
    options.layoutFiles ?? findLayouts(options.config.appPath, options.route.file)
  ).filter(containsBoundary)
  const templateFiles = options.route.templateFiles?.filter(containsBoundary)
  return {
    ...options,
    layoutFiles,
    route: {
      ...options.route,
      ...(templateFiles ? { templateFiles } : {}),
    },
  }
}

function withNextFlightText(page: PageRender) {
  const payload = JSON.stringify(page.body).replace(/</g, '\\u003c')
  return {
    ...page,
    routeScript: `${page.routeScript}<script>self.__next_f=self.__next_f||[]</script><script>self.__next_f.push([1,${payload}])</script>`,
  }
}

async function renderErrorPage(options: RenderOptions, error: unknown, stream: boolean) {
  const file = nearestConventionFile(options, 'error.tsx')
  const resolvedError = resolveThrownError(error, nextCompatEnabled(options.config))
  logDevError(options, resolvedError)
  if (!file) return renderGenericErrorPage(options, resolvedError, stream)

  try {
    const clientDirective = hasUseClientDirective(await readText(file))
    const module = (
      clientDirective ? await importClientModule(file, options) : await importModule(file, options)
    ) as ErrorModule
    interface ErrorComponentProps {
      error: Error
      reset?: () => void
      unstable_retry?: () => void
    }
    const ErrorPage = module.default
    if (!ErrorPage) return renderGenericErrorPage(options, resolvedError, stream)
    const ErrorComponent = clientDirective
      ? errorClientComponent(options, file, ErrorPage as ComponentType<ErrorComponentProps>)
      : (markServerReference(ErrorPage) as unknown as ComponentType<ErrorComponentProps>)
    const errorProps = serializableError(
      resolvedError,
      Boolean(options.dev),
      nextCompatEnabled(options.config),
    )
    const reset = errorResetCallback()
    // Awaited inside the try on purpose: a bare `return` hands the rejection to
    // the caller, and an error boundary that fails to render answered with a
    // bodiless 500 instead of the generic error document.
    return await renderTree(
      options,
      h(
        'div',
        pageRootProps,
        h(ErrorComponent, {
          error: errorProps,
          reset,
          unstable_retry: reset,
        }),
      ),
      stream,
      { title: 'Error' },
      { status: 500 },
    )
  } catch {
    return renderGenericErrorPage(options, resolvedError, stream)
  }
}

function errorResetCallback() {
  const reset = () => undefined
  ;(reset as { [PROP_ERROR_RESET_MARKER]?: true })[PROP_ERROR_RESET_MARKER] = true
  return reset
}

function errorClientComponent(
  options: RenderOptions,
  file: string,
  component: ComponentType<{
    error: Error
    reset?: () => void
    unstable_retry?: () => void
  }>,
) {
  const reference = conventionDefaultReference(options, file)
  if (!reference) return component
  ;(component as ClientComponent)[clientReferenceSymbol] = reference
  return component
}

function serializableError(error: Error, dev: boolean, compatNext: boolean) {
  // Compat owns Next's digest protocol + production message redaction. Gate on
  // the render's own config (not just registration): a pure-core render in a
  // process where compat was registered for another app must keep core behavior.
  const compat = compatNext ? getRenderExtensions().serializeError({ error, dev }) : undefined
  if (compat) return compat as Error & { digest?: string }
  return {
    name: error.name,
    message: devVisibleErrorMessage(error, dev, compatNext),
    digest:
      'digest' in error && typeof (error as { digest?: unknown }).digest === 'string'
        ? (error as { digest: string }).digest
        : undefined,
  } as Error & { digest?: string }
}

async function renderGenericErrorPage(options: RenderOptions, error: Error, stream: boolean) {
  logDevError(options, error)
  return renderTreeOrFallback(
    options,
    genericErrorTree(error, Boolean(options.dev), nextCompatEnabled(options.config)),
    stream,
    { title: 'Error' },
    { status: 500 },
  )
}

function genericErrorTree(error: Error, dev: boolean, compatNext: boolean): VNode<any> {
  const genericTitle =
    (compatNext ? getRenderExtensions().genericErrorTitle({ error, dev }) : undefined) ??
    'Application error'
  if (!dev) {
    return h('div', pageRootProps, h('h1', null, genericTitle))
  }

  const isBuildFailure = isBuildError(error)
  const kind = isBuildFailure
    ? 'Build error'
    : error.name && error.name !== 'Error'
      ? error.name
      : 'Runtime error'
  const message = isBuildFailure
    ? 'Fix the build error below, then reload the page.'
    : error.message || 'Something threw while rendering this route.'
  const stack = (error.stack ?? error.message ?? '').trim()

  return h(
    'div',
    { id: 'pnext-page', class: 'pnext-error' },
    h('style', { dangerouslySetInnerHTML: { __html: errorOverlayCss } }),
    h(
      'section',
      { class: 'pnext-error__card', role: 'alert' },
      h(
        'p',
        { class: 'pnext-error__eyebrow' },
        h('span', { class: 'pnext-error__dot' }),
        h('span', null, 'PNext dev server'),
        h('span', { class: 'pnext-error__badge' }, kind),
      ),
      h('h1', { class: 'pnext-error__title' }, isBuildFailure ? 'Build failed' : genericTitle),
      h('p', { class: 'pnext-error__message' }, message),
      stack ? h('pre', { class: 'pnext-error__stack' }, stack) : null,
      h(
        'p',
        { class: 'pnext-error__hint' },
        'Full stack trace was printed to the PNext dev server console.',
      ),
    ),
  )
}

function devVisibleErrorMessage(error: Error, dev: boolean, compatNext: boolean) {
  if (!dev)
    return (
      (compatNext ? getRenderExtensions().genericErrorTitle({ error, dev }) : undefined) ??
      'Application error'
    )
  return isBuildError(error) ? `Build failed:\n${error.message}` : error.message
}

// Render errors are invisible in the response (the user sees the error page), so they must always
// reach the server log, production included. Normalize a thrown value into an Error for the error
// pipeline; compat wraps non-Error throws Next's way, core keeps the plain wrapper.
function resolveThrownError(error: unknown, compatNext: boolean): Error {
  if (error instanceof Error) return error
  const wrapped = compatNext ? getRenderExtensions().wrapThrownValue(error) : undefined
  return wrapped ?? new Error(String(error))
}

/**
 * The logged trace, always carrying the error's identity. Bun drops the `Name: message` header when
 * it source-maps a stack, so a bare frame list would log as `⨯ Error` with nothing to diagnose.
 */
export function errorLogTrace(error: Error): string {
  const name = error.name || 'Error'
  const header = error.message ? `${name}: ${error.message}` : name
  const stack = error.stack
  if (!stack) return header
  if (stack.startsWith(header)) return stack
  // Source-mapping keeps the name and drops `: <message>`, so a stack that opens with the bare name
  // is a header to complete, not one to prepend - matching on the name alone would lose the message.
  if (stack.startsWith(`${name}\n`)) return `${header}${stack.slice(name.length)}`
  return `${header}\n${stack}`
}

function logDevError(options: RenderOptions, error: Error, clientSsrError = false) {
  if (error.name === 'DynamicServerError') return
  const seen = isBuildError(error) ? loggedBuildErrors : loggedRuntimeErrors
  if (seen.has(error)) return
  seen.add(error)
  // Cross-site dedupe: an SSR client error also floats out of the preact
  // stream renderer as an unhandled rejection; share one logged-tag with the
  // rejection guard and the start.ts top-level catch so whichever site fires
  // first wins (dedupe-rsc-error-log asserts one log per error).
  if (!markErrorLogged(error)) return
  const trace = errorLogTrace(error)
  if (clientSsrError) {
    // A client-page SSR error is replayed in the browser (no digest attached),
    // but Next's prod server log still prints it in the `⨯ <trace>` shape —
    // the legacy-link validation suite asserts the `⨯ Error:` first line.
    const prefixed = !options.dev && nextCompatEnabled(options.config)
    console.error(prefixed ? `⨯ ${trace}` : trace)
    return
  }
  // A real render error carries (or is assigned) a boundary digest. Next's prod
  // server log prints the ORIGINAL error trace followed by `digest: '<digest>'`
  // so operators can correlate the redacted client-visible digest with the full
  // server-side stack. Compute it identically to the boundary digest (compat's
  // serializeError is deterministic) and stamp it onto the error so the later
  // serializableError() call reuses the same value the client receives.
  if (!isBuildError(error) && nextCompatEnabled(options.config)) {
    const annotated = error as Error & { digest?: string }
    const digest = serializableError(error, Boolean(options.dev), true).digest
    if (typeof digest === 'string') {
      if (annotated.digest === undefined) annotated.digest = digest
      // Compat formats the exact prod log shape Next emits (⨯-prefixed
      // inspected error with the digest property); core keeps a plain line.
      console.error(
        getRenderExtensions().formatErrorLog(trace, digest, error) ??
          `${trace}\n  digest: '${digest}'`,
      )
      return
    }
  }
  console.error(trace)
}

function isBuildError(error: Error) {
  return (
    /^Build failed with \d+ errors?:/.test(error.message) ||
    Array.isArray((error as { errors?: unknown }).errors)
  )
}

async function renderTreeOrFallback(
  options: RenderOptions,
  tree: ComponentChildren,
  stream: boolean,
  metadata: Metadata,
  extra: {
    propsScript?: string
    status?: number
    viewport?: Viewport
    pageMetadataDir?: string
    runtimePageMetadata?: boolean
    viewportInBody?: boolean
  } = {},
) {
  try {
    return await renderTree(options, tree, stream, metadata, extra)
  } catch {
    return generatedFallbackPage(options, tree, metadata, extra.status ?? 500)
  }
}

function generatedFallbackPage(
  options: RenderOptions,
  tree: ComponentChildren,
  metadata: Metadata,
  status: number,
): PageRender {
  const nonce = documentNonce(options.request)
  return {
    shell: 'generated',
    body: serializeNeutralClientIslands(renderToString(h(Fragment, null, tree))),
    htmlProps: {},
    bodyProps: {},
    head: '',
    metadata,
    stylesheets: [],
    staticMetadata: undefined,
    fontPreloads: [],
    propsScript: '',
    routeScript: '',
    clientScript: '',
    devScript: options.dev ? devReloadScript() : '',
    streamChunks: [],
    status,
    viewport: {},
    fontCss: '',
    ...(nonce ? { nonce } : {}),
  }
}

function nearestConventionFile(options: RenderOptions, name: string) {
  return [...findConventionFiles(options.config.appPath, options.route.file, name)]
    .reverse()
    .find(file => existsSync(file))
}

/**
 * The SSR component for a client reference's export, or `undefined` when the export is a plain
 * non-function VALUE. A `'use client'` module may export a bare value that a server component
 * inlines as a serialized child; such an export has no SSR component to register, so it is skipped
 * rather than failing the build. A genuinely absent export still throws the original diagnostic.
 */
function clientComponentExport(
  module: Record<string, unknown>,
  exportName: string,
  file: string,
): ClientComponent | undefined {
  const component = module[exportName] as ClientComponent | undefined
  if (typeof component === 'function') return component
  if (component === undefined && !(exportName in module)) {
    throw new Error(`${file} must export ${exportName} as a client component`)
  }
  return undefined
}

async function markClientReferences(references: ClientReference[], options: RenderOptions) {
  const components: ClientComponentMap = new Map()
  await Promise.all(
    references.map(async reference => {
      const module = await importClientModule(reference.file, options)
      const component = clientComponentExport(module, reference.exportName, reference.file)
      if (!component) return
      component[clientReferenceSymbol] = reference
      components.set(reference.id, component as ComponentType<Record<string, unknown>>)
    }),
  )
  return components
}

// Dev re-imported and re-marked every one of the route's client references on each request. The
// module identities only change when the dev import version does, so key the marking on it - a save
// bumps the version and drops the whole table.
let markedReferencesVersion: string | undefined
const markedReferences = new Map<string, Promise<ClientComponentMap>>()
// Settled snapshots let the lazy path (PNEXT_LAZY_CLIENT_REFS) merge a warm
// route's marked set synchronously instead of awaiting the full preload.
const settledMarkedReferences = new Map<string, ClientComponentMap>()

function lazyClientReferencePreload() {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  return process.env.PNEXT_LAZY_CLIENT_REFS !== '0'
}

function preloadClientReferences(options: RenderOptions, profile: RenderProfile | undefined) {
  if (!options.dev || !reactCompatEnabled(options.config)) return undefined
  const version = options.devImportVersion
  if (!version) {
    return profileRenderStep(profile, 'preload client references', () =>
      markClientReferences(markableClientReferences(options), options),
    )
  }
  if (version !== markedReferencesVersion) {
    markedReferencesVersion = version
    markedReferences.clear()
    settledMarkedReferences.clear()
  }
  // A dev soft navigation must not join or start the whole route marking pass:
  // its response latency should scale with references in the rendered tree,
  // which addDiscoveredClientReferences compiles before shell emission. Reuse a
  // warm snapshot when available; otherwise discovery starts from an empty map.
  if (lazyClientReferencePreload() && options.nav?.soft) {
    return Promise.resolve(settledMarkedReferences.get(options.route.id) ?? new Map())
  }
  const cached = markedReferences.get(options.route.id)
  if (cached) return cached
  const marking = profileRenderStep(profile, 'preload client references', () =>
    markClientReferences(markableClientReferences(options), options),
  )
  // A failed marking must not stick: the next request re-imports and re-reports.
  markedReferences.set(
    options.route.id,
    marking.catch(error => {
      markedReferences.delete(options.route.id)
      throw error
    }),
  )
  marking.then(
    components => settledMarkedReferences.set(options.route.id, components),
    () => undefined,
  )
  return markedReferences.get(options.route.id)
}

function mergeClientComponents(target: ClientComponentMap, source: ClientComponentMap) {
  for (const [id, component] of source) target.set(id, component)
}

function markableClientReferences(options: RenderOptions) {
  return options.route.clientReferences.filter(ssrClientReference)
}

function eagerClientReferences(options: RenderOptions) {
  if (!options.dev || !reactCompatEnabled(options.config)) return markableClientReferences(options)
  return []
}

function hasUseClientDirective(source: string) {
  return /^\s*(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*(['"])use client\1\s*;?/.test(source)
}

function ClientIsland(
  props: Record<string, unknown> & {
    __pnextClient: ClientReference
    __pnextComponent?: ComponentType<Record<string, unknown>>
    __pnextSerializedProps?: string
    __pnextLayoutScope?: LayoutSegmentSnapshot
    __pnextParamsScope?: RouteParamsSnapshot
    __pnextTemplate?: boolean
    __pnextSkipSsr?: boolean
    __pnextCsrFallback?: ComponentChildren
  },
) {
  const {
    __pnextClient,
    __pnextComponent,
    __pnextSerializedProps,
    __pnextLayoutScope,
    __pnextParamsScope,
    __pnextTemplate,
    __pnextSkipSsr,
    __pnextCsrFallback,
    children,
    ref: _ref,
    ...componentProps
  } = props
  const islandChildren = children as ComponentChildren
  // Plain text/number children survive the boundary inside the serialized
  // props rather than via DOM adoption: a component may interpolate its
  // children into a string (`` `${children} ...` ``) so they never appear as a
  // distinct subtree in the SSR output for pnext-static-children to wrap.
  const plainChildren = plainIslandChildren(islandChildren)
  // Element-valued props ride the same DOM adoption as element children: the SSR pass renders each
  // one inside a `pnext-static-slot` host and the wire carries a `$$pnext_slot` id in its place.
  const ssrProps = islandStaticSlotProps(__pnextClient.id, componentProps, 'ssr')
  const islandProps: Record<string, unknown> = {
    'data-pnext-client': __pnextClient.id,
    // Pre-serialized by clientIslandVNode when render state was available
    // (server-action props become reference markers there).
    'data-pnext-props':
      __pnextSerializedProps ??
      serializeProps(
        islandStaticSlotProps(
          __pnextClient.id,
          plainChildren !== undefined
            ? { ...componentProps, children: plainChildren }
            : componentProps,
          'wire',
        ),
        { allowElements: true },
      ),
    style: { display: 'contents' },
  }
  // A client template island: the soft-nav runtime must REMOUNT it (fresh
  // state) when the segment it wraps navigates, instead of preserving it like
  // a shared layout island (Next's template-per-navigation semantics).
  if (__pnextTemplate) islandProps['data-pnext-template'] = ''
  // The client mount (client/entry.ts) reads this to re-provide the layout
  // segment context so useSelectedLayoutSegment(s) recomputes live per soft nav.
  if (__pnextLayoutScope) {
    islandProps['data-pnext-layout-segments'] = serializeProps(__pnextLayoutScope)
  }
  // The client mount (client/entry.ts) reads this to re-provide the params
  // context so a slot island's useParams sees the slot's own params.
  if (__pnextParamsScope) {
    islandProps['data-pnext-params'] = serializeProps(__pnextParamsScope)
  }
  const staticChildren = islandStaticChildren(__pnextClient.id, islandChildren)

  if (__pnextSkipSsr) {
    return staticChildren
      ? h('pnext-client', { ...islandProps, 'data-pnext-ssr-failed': '' }, staticChildren)
      : h('pnext-client', { ...islandProps, 'data-pnext-ssr-failed': '' })
  }

  if (!ssrClientReference(__pnextClient)) {
    return staticChildren
      ? h('pnext-client', islandProps, staticChildren)
      : h('pnext-client', islandProps)
  }

  if (!__pnextComponent)
    throw new Error(`${__pnextClient.file} is missing a client component reference`)
  // Provide the layout-segment context around the SSR pass so the island's
  // useSelectedLayoutSegment(s) renders byte-exact server values. Plain children render (and
  // serialize) as their raw value so a component that string-interpolates its children produces
  // the same bytes on both sides. A component may not render its children at all on the server (a
  // client-only gate returning null): the markup then never reaches the DOM and adoption would
  // lose it, so probe whether the static-children wrapper actually rendered and, when it did not,
  // emit the children into an inert <template> sidecar the client mount adopts from.
  const adoption = { rendered: false }
  const probedChildren =
    staticChildren !== undefined
      ? h(
          StaticChildrenProbe as ComponentType<{ adoption: { rendered: boolean } }>,
          { adoption },
          staticChildren,
        )
      : undefined
  let island = h(
    __pnextComponent,
    revivePromiseProps(ssrProps),
    plainChildren !== undefined ? islandChildren : probedChildren,
  )
  if (__pnextLayoutScope) {
    island = h(
      LayoutSegmentContext.Provider,
      { value: __pnextLayoutScope },
      island,
    ) as unknown as typeof island
  }
  if (__pnextParamsScope) {
    island = h(
      RouteParamsContext.Provider,
      { value: __pnextParamsScope },
      island,
    ) as unknown as typeof island
  }
  if (__pnextCsrFallback !== undefined) {
    island = h(CsrBailoutContext.Provider, { value: true }, island) as unknown as typeof island
  }
  const fallbackChildren =
    staticChildren !== undefined && plainChildren === undefined
      ? h(
          FallbackStaticChildren as ComponentType<{
            id: string
            adoption: { rendered: boolean }
          }>,
          { id: __pnextClient.id, adoption },
          islandChildren,
        )
      : undefined
  if (actionSerializeScope.getStore()?.clientPageStream) {
    return h(
      'pnext-client',
      islandProps,
      fallbackChildren !== undefined ? ([island, fallbackChildren] as ComponentChildren) : island,
    )
  }
  return h(IslandBoundary, {
    islandProps,
    island,
    fallbackChildren,
    csrFallback: __pnextCsrFallback,
  })
}

// Marks the island's static-children wrapper as rendered when the component
// actually renders its children (depth-first stringification reaches this
// probe before the fallback sibling below).
function StaticChildrenProbe(props: {
  adoption: { rendered: boolean }
  children?: ComponentChildren
}): ComponentChildren {
  props.adoption.rendered = true
  return props.children
}

// Inert sidecar for children the component did not render on the server: an island returning null
// would otherwise lose its element children entirely. The client mount adopts from the template's
// content and removes it. When the island suspends into a streamed chunk both copies are emitted;
// the client prefers the rendered wrapper (earlier in document order).
function FallbackStaticChildren(props: {
  id: string
  adoption: { rendered: boolean }
  children?: ComponentChildren
}) {
  if (props.adoption.rendered) return null
  return h('template', { [ISLAND_STATIC_CHILDREN_ATTRIBUTE]: props.id }, props.children)
}

interface IslandBoundaryProps {
  islandProps: Record<string, unknown>
  island: ComponentChildren
  fallbackChildren?: ComponentChildren
  csrFallback?: ComponentChildren
}

// Per-island SSR error boundary. Normally renders the island's server output inside its
// `pnext-client` host; if stringifying the subtree throws, preact-render-to-string re-renders this
// boundary with `failed` set and we emit a placeholder with its inert static-children sidecar. The
// rest of the document renders normally (no 500) and the client entry mounts the island fresh
// (render, not hydrate), localizing the failure to the one island.
class IslandBoundary extends Component<IslandBoundaryProps, { failed: boolean; error: unknown }> {
  state = { failed: false, error: undefined as unknown }

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error }
  }

  componentDidCatch(error: unknown) {
    // A control-flow signal a client component threw during its SSR render is a navigation/prerender
    // intent, not a render failure - it must propagate (re-thrown in render below), not be
    // localized. Only real errors are reported here.
    if (!isIslandControlFlowSignal(error)) reportClientSsrError(error)
  }

  render(props: IslandBoundaryProps, state: { failed: boolean; error: unknown }) {
    if (state.failed) {
      if (isPostpone(state.error) && props.csrFallback !== undefined) {
        return h(
          'pnext-client',
          { ...props.islandProps, 'data-pnext-ssr-failed': '' },
          props.csrFallback,
        )
      }
      // Propagate control-flow signals to the page-render pipeline so a
      // client-component redirect() during (pre)render becomes a 307 instead of
      // being swallowed into a 200 `data-pnext-ssr-failed` placeholder.
      if (isIslandControlFlowSignal(state.error)) throw state.error
      return h('pnext-client', { ...props.islandProps, 'data-pnext-ssr-failed': '' })
    }
    return h(
      'pnext-client',
      props.islandProps,
      props.fallbackChildren !== undefined
        ? ([props.island, props.fallbackChildren] as ComponentChildren)
        : props.island,
    )
  }
}

// Control-flow signals never represent an island render FAILURE: they must
// propagate to the page-render pipeline (redirect → 307, notFound → 404 UI,
// postpone → PPR hole) exactly as the resolve-walk path (islandBoundaryError-
// Marker) already re-throws them.
function isIslandControlFlowSignal(error: unknown): boolean {
  return (
    isPostpone(error) ||
    isRedirectError(error) ||
    isNotFoundError(error) ||
    isForbiddenError(error) ||
    isUnauthorizedError(error)
  )
}

// Report a client component's SSR failure through the compat error funnel WITH request context.
// preact-render-to-string routes a `'use client'` throw into the nearest class boundary but
// otherwise resolves to '' while floating the rejected render promise, so the boundary at the SSR
// call site is the one place the error can be attributed to the request.
function reportClientSsrError(error: unknown): void {
  const request = currentRequest()
  const unit = getWorkUnit()
  void reportRequestError(
    error,
    {
      method: request?.method ?? 'GET',
      url: request?.url ?? '',
      headers: request?.headers ?? new Headers(),
    },
    {
      phase: unit?.phase,
      routeKind: unit?.routeKind,
      ...(unit?.responseHints ?? {}),
      renderSource: 'server-rendering',
    },
  )
}

// Island error-boundary protocol. preact's SSR error-boundary support only covers the FINAL
// string-render pass, so a Server Component that throws inside an island's CHILDREN used to abort
// the whole resolve walk and funnel to the route's `error.tsx` - bypassing an error boundary the
// app placed directly in the tree, which Next DOES let catch such an error.
//
// Protocol: a client component that can render a caught error tags itself with
// `Symbol.for('pnext.islandErrorBoundary')`. When resolving an island's children throws and the
// island carries the tag, the error is serialized and handed to the component as the
// `__pnextBoundaryError` prop instead of aborting: SSR renders its fallback inline (children are
// dropped - they failed), and the prop rides `data-pnext-props` so the client mount re-creates the
// SAME caught state and the fallback hydrates interactive. Islands WITHOUT the tag propagate to
// the route error page, as do control-flow errors (notFound/redirect/forbidden/unauthorized/
// postpone), which are always re-thrown.

export const ISLAND_BOUNDARY_ERROR_PROP = '__pnextBoundaryError'
const islandErrorBoundarySymbol = Symbol.for('pnext.islandErrorBoundary')

export interface IslandBoundaryErrorMarker {
  name: string
  message: string
  digest?: string
}

/**
 * Convert an island-children resolve error into the serialized marker for the island's
 * `__pnextBoundaryError` prop - or re-throw when the error is control-flow or the island component
 * is not a tagged boundary.
 */
function islandBoundaryErrorMarker(
  error: unknown,
  reference: ClientReference,
  state: {
    options: RenderOptions
    clientReferences: ClientReferenceMap
    clientComponents: ClientComponentMap
  },
): IslandBoundaryErrorMarker {
  if (
    isPostpone(error) ||
    isRedirectError(error) ||
    isNotFoundError(error) ||
    isForbiddenError(error) ||
    isUnauthorizedError(error)
  ) {
    throw error
  }
  if (!isTaggedIslandErrorBoundary(reference, state)) throw error

  const resolvedError = resolveThrownError(error, nextCompatEnabled(state.options.config))
  // Same server-log semantics as the error-page path: the original trace (plus
  // digest under compat) must reach the log exactly once — the boundary renders
  // a redacted message, so the log is the only place the real failure shows.
  logDevError(state.options, resolvedError)
  const serialized = serializableError(
    resolvedError,
    Boolean(state.options.dev),
    nextCompatEnabled(state.options.config),
  )
  return {
    name: serialized.name,
    message: serialized.message,
    ...(typeof serialized.digest === 'string' ? { digest: serialized.digest } : {}),
  }
}

function isTaggedIslandErrorBoundary(
  reference: ClientReference,
  state: { clientReferences: ClientReferenceMap; clientComponents: ClientComponentMap },
): boolean {
  const resolvedReference = state.clientReferences.get(reference.id) ?? reference
  const component = state.clientComponents.get(resolvedReference.id) as
    (ComponentType<Record<string, unknown>> & { [islandErrorBoundarySymbol]?: boolean }) | undefined
  return component?.[islandErrorBoundarySymbol] === true
}

/**
 * RUNTIME-PREFETCH prerender: a server subtree that throws inside an UNTAGGED client island is
 * transported to the client as a marker element (the client entry re-throws it during
 * materialization, so the island's own error boundary catches it) instead of holing the enclosing
 * <Suspense>. That keeps the prefetch COMPLETE, so the navigation commits it without a refetch.
 *
 * Null (re-throw, holing the boundary) outside a runtime prefetch, for control-flow errors, and
 * for TAGGED boundaries, whose richer prop handoff already renders their fallback server-side.
 */
function runtimePrefetchIslandErrorMarker(
  error: unknown,
  reference: ClientReference,
  state: {
    options: RenderOptions
    clientReferences: ClientReferenceMap
    clientComponents: ClientComponentMap
  },
): ComponentChildren | null {
  if (!isRuntimePrefetchPrerender()) return null
  if (isPostpone(error) || isRenderControlFlowError(error)) return null
  if (isTaggedIslandErrorBoundary(reference, state)) return null
  const compat = nextCompatEnabled(state.options.config)
  const resolvedError = resolveThrownError(error, compat)
  // Logged here (once) because the boundary swallows it: the marker carries the
  // redacted message, so the server log is the only place the real trace shows.
  logDevError(state.options, resolvedError)
  const serialized = serializableError(resolvedError, Boolean(state.options.dev), compat)
  return h(ISLAND_BOUNDARY_ERROR_ELEMENT, {
    [ISLAND_BOUNDARY_ERROR_MESSAGE_ATTRIBUTE]: serialized.message,
    ...(typeof serialized.digest === 'string'
      ? { [ISLAND_BOUNDARY_ERROR_DIGEST_ATTRIBUTE]: serialized.digest }
      : {}),
  })
}

/** Clone an island vnode with the boundary-error marker added to its props. */
function withIslandBoundaryError(
  node: ServerVNode,
  marker: IslandBoundaryErrorMarker,
): ServerVNode {
  return { ...node, props: { ...node.props, [ISLAND_BOUNDARY_ERROR_PROP]: marker } }
}

async function resolveServerTree(node: unknown, state: ResolveState): Promise<ComponentChildren> {
  if (node == null || typeof node !== 'object') return node as ComponentChildren
  if (Array.isArray(node)) return Promise.all(node.map(child => resolveServerTree(child, state)))
  if (!isVNode(node)) return node as ComponentChildren

  if (isSuspenseVNode(node)) {
    if (state.partial) return resolvePartialSuspense(node, state, state.partial)
    if (isCsrBailoutPrerender()) {
      const fallback = await resolveServerTree(node.props.fallback, state)
      return resolveServerTree(node.props.children, { ...state, csrBailoutFallback: fallback })
    }
    return resolveServerTree(node.props.children, state)
  }

  if (typeof node.type !== 'function') {
    // Reaching `<html>` directly (no wrapping Suspense) locates the shell — stop
    // treating subsequent boundaries as the document shell wrapper.
    if (state.partial?.shellPending && node.type === 'html') {
      state.partial.shellPending = false
    }
    return elementVNode(node, await resolveServerTree(node.props.children, state), state)
  }

  const component = node.type
  // A per-slot params scope marker (render/slots.ts): re-establish the slot's
  // params as an async scope while resolving its subtree so every island created
  // deep inside captures them (clientIslandVNode reads currentParamsSnapshot).
  if ((component as { [paramsScopeSymbol]?: true })[paramsScopeSymbol]) {
    return runInParamsScope(paramsScopeParams(node.props), () =>
      resolveServerTree(node.props.children, state),
    )
  }
  // A parallel-route slot marker (render/slots.ts): arm the build task boundary
  // while resolving the slot subtree, so a slot that resolves in a task becomes
  // a hole (Next parity) without affecting any other <Suspense>.
  if (
    isTaskBoundaryPrerender() &&
    (component as { [slotBoundarySymbol]?: true })[slotBoundarySymbol]
  ) {
    return runWithTaskBoundaryArmed(() => resolveServerTree(node.props.children, state))
  }
  const dynamicReference = (component as DynamicComponent)[dynamicReferenceSymbol]
  if (dynamicReference) {
    // A compile-injected target that matches a scanned client reference makes
    // this an island without loading the module: non-SSR references
    // (ssr: false, load: 'visible') must never execute on the server.
    const targetReference = dynamicTargetReference(dynamicReference, state)
    if (targetReference) {
      const children = await resolveServerTree(node.props.children, state)
      await ensureClientComponent(targetReference, state)
      return clientIslandVNodeWithPromiseProps(node, targetReference, children, state)
    }
    const Component = markServerReference(await dynamicReference.load())
    return resolveServerTree(
      dynamicVNode(node, Component, await resolveServerTree(node.props.children, state)),
      state,
    )
  }

  const clientComponent = component as ClientComponent
  const reference = clientComponent[clientReferenceSymbol]
  if (reference) {
    await ensureClientComponent(reference, state)
    let children: ComponentChildren = null
    let island = node
    try {
      children = await resolveServerTree(node.props.children, state)
    } catch (error) {
      // Re-throws (aborting the render) unless this island is a tagged error
      // boundary — then it renders its fallback via the marker — or this is a
      // runtime prefetch, which transports the failure into the island's own
      // children instead of holing the enclosing <Suspense>.
      const transported = runtimePrefetchIslandErrorMarker(error, reference, state)
      if (transported) children = transported
      else {
        island = withIslandBoundaryError(node, islandBoundaryErrorMarker(error, reference, state))
      }
    }
    return clientIslandVNodeWithPromiseProps(island, reference, children, state)
  }

  // A whole-page client component hydrates directly at `#pnext-page` from the route's client entry,
  // not through the island machinery, so it carries no client reference. It must be SSR'd by the
  // preact renderer - NEVER server-invoked, which has no hooks dispatcher and would throw a
  // spurious render error into the nearest error boundary. Leave the vnode unresolved so the final
  // renderVNodeToString renders it via preact. A SYNC client-page throw propagates out of that
  // string pass into pageRender's render catch; an ASYNC one is surfaced separately by pageRender's
  // pre-run (preact swallows it as a floating rejection here). An in-tree error.tsx catches first.
  if (isClientPageComponent(component)) {
    if (state.partial?.mode !== 'build') return node
    const previous = state.partial.clientOnly
    state.partial.clientOnly = true
    try {
      return await resolveServerTree(
        await invokeServerComponentWithUse(
          component as ServerComponent<ServerVNodeProps>,
          node.props,
        ),
        state,
      )
    } catch (error) {
      // A hooks-using client page has no dispatcher under direct invocation;
      // leave it unresolved so the preact string pass SSRs it (same as the
      // non-build path) instead of failing the whole shell prerender.
      if (isHookDispatcherError(error)) return node
      throw error
    } finally {
      state.partial.clientOnly = previous
    }
  }
  if (isPreactClassComponent(component)) return node

  const serverComponent = component as ServerComponent<ServerVNodeProps>
  // A `'use cache'` component renders its ENTIRE subtree inside the cache fill upstream, so neither
  // it nor any descendant may trip the prerender's task boundary. Suspend the boundary for this
  // subtree, but ONLY under a task-boundary prerender: everywhere else this scope is inert, and
  // gating keeps the resolve path byte-identical off the shell render.
  if (isTaskBoundaryPrerender() && isCachedComponent(serverComponent)) {
    return runWithTaskBoundarySuspended(() =>
      resolveCachedServerComponent(node, serverComponent, state),
    )
  }
  return resolveCachedServerComponent(node, serverComponent, state)
}

async function resolveCachedServerComponent(
  node: ServerVNode,
  serverComponent: ServerComponent<ServerVNodeProps>,
  state: ResolveState,
): Promise<ComponentChildren> {
  // Static-skeleton pass: a postponing component contributes nothing, but the
  // static markup around it still renders.
  if (state.swallowPostpones) {
    try {
      return await resolveServerTree(
        await invokeServerComponentWithUse(serverComponent, node.props),
        state,
      )
    } catch (error) {
      if (isPostpone(error)) {
        if (state.swallowedPostpones) state.swallowedPostpones.count++
        return null
      }
      throw error
    }
  }
  try {
    return resolveServerTree(await invokeServerComponentWithUse(serverComponent, node.props), state)
  } catch (error) {
    if (
      !shouldInvokeServerComponent(node.type as ComponentType<ServerVNodeProps>) &&
      isHookDispatcherError(error)
    ) {
      return elementVNode(node, await resolveServerTree(node.props.children, state), state)
    }
    throw error
  }
}

/** Navigation control flow (redirect/notFound/forbidden/unauthorized) — never a failure. */
function isRenderControlFlowError(error: unknown): boolean {
  return (
    isRedirectError(error) ||
    isNotFoundError(error) ||
    isForbiddenError(error) ||
    isUnauthorizedError(error)
  )
}

// Partial-prerender handling for a <Suspense> boundary. Every boundary consumes
// one pre-order id in both phases so ids stay aligned. Dynamic subtrees are
// resolved opaquely (partial disabled) so nested boundaries never consume ids.
async function resolvePartialSuspense(
  node: ServerVNode,
  state: ResolveState,
  partial: PartialState,
): Promise<ComponentChildren> {
  // Document-shell wrapper: a root layout can wrap its `<html>` in a Suspense.
  // The shell cannot be a streamed hole, so resolve THROUGH this boundary (no id
  // consumed, no hole recorded) rather than replacing it with a fallback. Inner
  // boundaries reached while resolving still receive their ids, keeping build and
  // request numbering aligned. Mirrors the streaming path's shellPending branch.
  if (partial.shellPending) {
    const resolved = await resolveServerTree(node.props.children, state)
    if (!partial.shellPending || documentHtmlVNode(resolved)) {
      partial.shellPending = false
      return resolved
    }
    // A pre-shell Suspense that does not wrap `<html>` (not expected in a valid
    // root layout): degrade to a blocking resolve so the shell is never lost.
    return resolved
  }

  const id = partial.nextId++
  const opaque: ResolveState = { ...state, partial: undefined }

  if (partial.mode === 'request') {
    if (!partial.known.has(id)) {
      // Static at build time — already baked into the served shell. Descend to
      // keep ids aligned, but its output is discarded this request.
      await resolveServerTree(node.props.children, state)
      return null
    }
    // Slot-granular resume: the served shell already carries this boundary's build-time bytes for
    // every slot the build proved final. Re-rendering those here would ship a SECOND copy rendered
    // at request time, so a build-time sentinel inside one would read "at runtime". Render only the
    // dynamic slots, delimited so promotion can weave both halves back into slot order. Any
    // mismatch in slot count falls back to the whole-boundary re-render below.
    const slotInfo = partial.staticSlots?.get(id)
    const slots = slotInfo ? toChildArray(node.props.children) : []
    if (slotInfo?.count === slots.length && slotInfo.slots.size < slots.length) {
      const parts: string[] = []
      const dynamic: number[] = []
      for (let index = 0; index < slots.length; index++) {
        if (slotInfo.slots.has(index)) continue
        const slotResolved = await resolveServerTree(slots[index], opaque)
        const slotHtml = await renderVNodeToString(h(Fragment, null, slotResolved), opaque)
        parts.push(`<!--${SLOT_MARKER}${index}-->${slotHtml}<!--/${SLOT_MARKER}${index}-->`)
        dynamic.push(index)
      }
      partial.chunks.push(
        renderSuspenseReplacement(
          String(id),
          parts.join(''),
          state.options,
          documentNonce(state.options.request),
          dynamic,
        ),
      )
      return null
    }
    const resolved = await resolveServerTree(node.props.children, opaque)
    const html = await renderVNodeToString(h(Fragment, null, resolved), opaque)
    partial.chunks.push(
      renderSuspenseReplacement(
        String(id),
        html,
        state.options,
        documentNonce(state.options.request),
      ),
    )
    return null
  }

  // Restore points for a task-boundary retry (see the catch): re-resolving the
  // children must not consume a second set of boundary ids or leave the holes
  // recorded by the abandoned attempt behind, or build and request numbering
  // drift apart.
  const nextIdAfterThis = partial.nextId
  const holesBefore = partial.holes.length

  try {
    // Arm the build task boundary for the boundary's own subtree: a component
    // that only settles in a fresh macrotask (a timer, real IO) postpones here
    // instead of baking into the shell, which is what keeps Next's fallback in
    // the prerendered HTML. The catch below re-renders it unbounded whenever the
    // boundary still produced static markup, so only wholly task-dependent
    // content becomes a hole.
    const tracked = await trackPrerenderDynamic(() =>
      isTaskBoundaryPrerender()
        ? runWithTaskBoundaryArmed(() => resolveServerTree(node.props.children, state))
        : resolveServerTree(node.props.children, state),
    )
    if (tracked.dynamic) {
      if (!partial.clientOnly) partial.holes.push(id)
      const fallback = await resolveServerTree(node.props.fallback, opaque)
      return h(
        'pnext-suspense',
        { 'data-pnext-suspense': String(id), ...loadingDepthAttributes(node.props) },
        fallback,
      )
    }
    return tracked.value
  } catch (error) {
    // RUNTIME-PREFETCH prerender: a server subtree that THROWS must not discard the whole prefetch
    // document. The response still carries the shell (the client's nearest error boundary renders
    // it after the navigation re-render) and the server log gets the original trace exactly once.
    // Hole the boundary - its content is NOT final. Control-flow errors keep propagating.
    if (!isPostpone(error) && isRuntimePrefetchPrerender() && !isRenderControlFlowError(error)) {
      logDevError(state.options, resolveThrownError(error, nextCompatEnabled(state.options.config)))
      if (!partial.clientOnly) partial.holes.push(id)
      const fallback = await resolveServerTree(node.props.fallback, opaque)
      return h(
        'pnext-suspense',
        { 'data-pnext-suspense': String(id), ...loadingDepthAttributes(node.props) },
        fallback,
      )
    }
    if (!isPostpone(error)) throw error
    // The static skeleton re-resolves this boundary's children. A slot marker
    // inside re-arms the task boundary, so a slot that resolves entirely in a
    // task yields an EMPTY skeleton (its task work postpones and is swallowed to
    // null); a slot with a genuinely static sibling yields non-empty markup.
    const skeleton = await renderStaticSkeleton(node, opaque, id)
    // A TASK-boundary postpone with static content to keep: upstream React
    // RESUMES a postponed boundary, preserving whatever already rendered inside
    // it. pnext re-renders the whole boundary at request time instead, so holing
    // one that produced markup would downgrade it from build-time to
    // request-time output. Re-render it unbounded so its task content bakes
    // exactly as before; hole only when nothing static was inside it (the
    // parallel-slot shape, where the slot page is the boundary's whole content).
    if (isTaskPostpone(error) && skeleton !== null) {
      partial.nextId = nextIdAfterThis
      partial.holes.length = holesBefore
      return runWithTaskBoundarySuspended(() => resolveServerTree(node.props.children, state))
    }
    if (!partial.clientOnly) partial.holes.push(id)
    const fallback = await resolveServerTree(node.props.fallback, opaque)
    // Next's flight shell carries the boundary's STATIC wrapper markup even
    // though the UI shows the fallback (React postpones at the dynamic access,
    // not at the boundary). Emit that static skeleton as an inert <template>
    // beside the fallback so shell/prefetch responses contain the wrapper
    // bytes (search-params cache-key suites assert on them). The template
    // renders nothing and is replaced along with the boundary on resume.
    return h(
      'pnext-suspense',
      { 'data-pnext-suspense': String(id), ...loadingDepthAttributes(node.props) },
      fallback,
      skeleton,
    )
  }
}

/**
 * Best-effort static skeleton of a postponed boundary's children: re-resolve them with postponing
 * components swallowed to null, so only markup that renders without dynamic data remains. Null when
 * nothing static renders - the boundary then carries only its fallback.
 *
 * The re-resolve runs in its OWN dynamic tracker. This probe happens in the boundary's catch, which
 * is back in the ENCLOSING boundary's async context, so re-subscribing to the same hanging
 * request-API promise would otherwise mark the parent dynamic and turn it into a second hole.
 */
async function renderStaticSkeleton(
  node: ServerVNode,
  opaque: ResolveState,
  id: number,
): Promise<VNode | null> {
  try {
    const swallowed = { count: 0 }
    const state: ResolveState = { ...opaque, swallowPostpones: true, swallowedPostpones: swallowed }
    // Resolve the boundary's DIRECT CHILDREN one slot at a time: a slot that
    // swallowed no postpone rendered with no dynamic access at all, so its
    // build-time bytes are FINAL and the resume can leave them alone. A slot
    // that swallowed one is only a partial skeleton (its dynamic content is
    // missing) and must re-render per request.
    //
    // Keep the task boundary armed for the probe: content that only settles in
    // a macrotask is NOT static, so it must not count as markup worth keeping
    // (it would otherwise re-render the whole boundary unbounded and swallow
    // the hole this postpone was raised for).
    const slots = toChildArray(node.props.children)
    const resolved: ComponentChildren[] = []
    const finalSlots: number[] = []
    for (const slot of slots) {
      const before = swallowed.count
      resolved.push(
        (
          await trackPrerenderDynamic(() =>
            isTaskBoundaryPrerender()
              ? runWithTaskBoundaryArmed(() => resolveServerTree(slot, state))
              : resolveServerTree(slot, state),
          )
        ).value,
      )
      if (swallowed.count === before) finalSlots.push(resolved.length - 1)
    }
    const html = await renderVNodeToString(h(Fragment, null, resolved), state)
    if (!html?.trim()) return null
    // Every slot final (or none): nothing to dedupe on resume — emit exactly the
    // blob this always emitted, byte for byte.
    if (finalSlots.length === 0 || finalSlots.length === slots.length) {
      return h('template', {
        'data-pnext-static': '',
        dangerouslySetInnerHTML: { __html: html },
      }) as VNode
    }
    // Mixed boundary: keep every slot's skeleton markup (shell/prefetch
    // responses assert on those bytes) but delimit the slots with comments so
    // the resume — and the client-side promotion — can take the final ones from
    // here and only the dynamic ones from the streamed chunk.
    const perSlot: string[] = []
    const kept: number[] = []
    for (let index = 0; index < resolved.length; index++) {
      const slotHtml = await renderVNodeToString(h(Fragment, null, resolved[index]), state)
      if (finalSlots.includes(index) && slotHtml.trim()) kept.push(index)
      perSlot.push(`<!--${SLOT_MARKER}${index}-->${slotHtml}<!--/${SLOT_MARKER}${index}-->`)
    }
    if (kept.length === 0 || kept.length === slots.length) {
      return h('template', {
        'data-pnext-static': '',
        dangerouslySetInnerHTML: { __html: html },
      }) as VNode
    }
    return h('template', {
      'data-pnext-static': String(id),
      'data-pnext-slots': kept.join(','),
      'data-pnext-slot-count': String(slots.length),
      dangerouslySetInnerHTML: { __html: perSlot.join('') },
    }) as VNode
  } catch {
    return null
  }
}

/** Comment marker delimiting one boundary slot inside a skeleton/stream chunk. */
const SLOT_MARKER = '$ps:'

/**
 * Read back the per-hole slot map the shell's static skeletons carry. Attribute
 * -only match (never the template's contents), so nested markup can never
 * confuse it; anything that fails to parse simply leaves the hole out of the map
 * and the resume re-renders that boundary whole, as before.
 */
function parseStaticSlots(shell: string): Map<number, StaticSlotInfo> | undefined {
  const pattern =
    /<template data-pnext-static="(\d+)" data-pnext-slots="([\d,]+)" data-pnext-slot-count="(\d+)"/g
  let map: Map<number, StaticSlotInfo> | undefined
  for (const match of shell.matchAll(pattern)) {
    const [, id, list, count] = match as unknown as [string, string, string, string]
    const slots = new Set(list.split(',').map(Number))
    ;(map ??= new Map()).set(Number(id), { count: Number(count), slots })
  }
  return map
}

// Stream a Suspense boundary through whichever mechanism this render uses:
// in-place suspension (one preact render, ancestor client providers stay in
// scope) or an out-of-order replacement chunk (rendered from a fresh root).
function streamSuspenseBoundary(
  node: ServerVNode,
  children: ComponentChildren | Promise<ComponentChildren>,
  state: StreamState,
): ComponentChildren | Promise<ComponentChildren> {
  if (state.inlineSuspense && isPromise(children)) {
    return inlineSuspenseBoundary(node, children, state)
  }
  return deferSuspenseBoundary(node, children, state)
}

// In-place streaming boundary: keep a real (preact/compat) <Suspense> in the
// tree and hand it a component that throws until `children` settles, so the
// single document render emits the fallback now and resumes the content later.
// Unlike deferSuspenseBoundary this never renders from a fresh root, so an
// ancestor client layout's providers still wrap the resumed content.
async function inlineSuspenseBoundary(
  node: ServerVNode,
  children: Promise<ComponentChildren>,
  state: StreamState,
): Promise<ComponentChildren> {
  // Give an immediate failure one task to surface. Nothing has been sent while the resolve walk
  // runs, so a child that throws right away can still take the BLOCKING path: the rejection
  // propagates out, an ancestor island error boundary stamps its handoff marker, and the response
  // carries a real error status. Genuinely slow content wins the race and streams as usual.
  const immediate = await Promise.race([
    children.then(
      () => undefined,
      (error: unknown) => ({ error }),
    ),
    new Promise<undefined>(resolve => {
      setTimeout(() => resolve(undefined), 0)
    }),
  ])
  if (immediate) throw immediate.error

  const boundaryType = (getSuspenseExtensions().compatSuspenseType() ?? node.type) as ComponentType<
    Record<string, unknown>
  >
  const Suspended = suspenseResourceComponent(children, state)
  const fallback = await resolveServerTreeForStream(node.props.fallback, state)
  // The fallback must be a single vnode: the stream renderer renders it with no
  // parent vnode, and its array branch would crash on one (swallowing the
  // fallback entirely). A Fragment wrapper is byte-neutral.
  return h(
    boundaryType,
    { ...node.props, fallback: h(Fragment, null, fallback) },
    h(Suspended, null),
  )
}

// Wraps a pending subtree as a suspending component. A throw AFTER the boundary suspended can only
// ride the boundary's own replacement (the shell and its status already flushed), so it maps to the
// same markup deferSuspenseBoundary emits. A throw that lands BEFORE the boundary ever suspended -
// the shell is still open - is re-thrown instead, taking the normal blocking path with a
// server-rendered error boundary and the right status.
function suspenseResourceComponent(children: Promise<ComponentChildren>, state: StreamState) {
  let resolved: ComponentChildren
  let failure: { error: unknown } | undefined
  let pending = true
  let suspended = false
  const ready = children.then(
    value => {
      resolved = value
      pending = false
    },
    async (error: unknown) => {
      if (suspended) resolved = await streamBoundaryErrorVNode(error, state)
      else failure = { error }
      pending = false
    },
  )
  return function InlineSuspenseBoundaryContent() {
    if (pending) {
      suspended = true
      // Suspending IS throwing a thenable — the stream renderer catches it,
      // flushes the boundary's fallback, and re-renders once it settles.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw ready
    }
    if (failure) throw failure.error
    return resolved
  }
}

// What a streamed boundary shows when its content throws: a navigation intent
// (notFound/redirect) patched into the boundary, or the streamed error UI.
// Mirrors deferSuspenseBoundary's catch, including its reporting — the shell
// (and its status) has already flushed, so the outcome rides this boundary.
async function streamBoundaryErrorVNode(
  error: unknown,
  state: StreamState,
): Promise<ComponentChildren> {
  if (isNotFoundError(error)) return streamNotFoundBoundaryTree(state)
  if (isRedirectError(error)) {
    return h('div', {
      style: { display: 'contents' },
      dangerouslySetInnerHTML: { __html: metadataRedirectHtml(error.location, error.status) },
    })
  }
  reportStreamBoundaryError(error)
  reportStreamRenderError(error, state)
  return hStreamError(
    error,
    state.dev,
    nextCompatEnabled(state.options.config),
    needsClientEntry(state.options.route),
  )
}

// Emit a streaming Suspense boundary: flush its fallback wrapped in a
// `<pnext-suspense>` marker now, and defer the resolved content as a
// replacement chunk. `children` is the (possibly already-resolved) content.
function deferSuspenseBoundary(
  node: ServerVNode,
  children: ComponentChildren | Promise<ComponentChildren>,
  state: StreamState,
): ComponentChildren | Promise<ComponentChildren> {
  const id = String(state.nextId++)
  const nonce = documentNonce(state.options.request)
  state.deferred.push(
    Promise.resolve(children)
      .then(async resolved =>
        renderSuspenseReplacement(
          id,
          await renderVNodeToString(h(Fragment, null, resolved), state),
          state.options,
          nonce,
        ),
      )
      .catch(async error => {
        // notFound()/redirect() thrown deep inside a streamed Suspense boundary are navigation
        // intents, not render errors: the shell (200 status, <head> already flushed) cannot change
        // either at this point, so the outcome is patched into THIS boundary's replacement chunk -
        // the nearest not-found UI plus a noindex meta, or the redirect meta-refresh and
        // location.replace script. Both ride the chunk's own markup rather than the sent head.
        if (isNotFoundError(error)) {
          return renderSuspenseReplacement(
            id,
            await renderStreamNotFoundBoundary(state),
            state.options,
            nonce,
          )
        }
        if (isRedirectError(error)) {
          return renderSuspenseReplacement(
            id,
            metadataRedirectHtml(error.location, error.status),
            state.options,
            nonce,
          )
        }
        reportStreamBoundaryError(error)
        // The shell (200 status) has already flushed, so a real error inside this boundary cannot
        // change the response status. But unlike a Suspense-caught promise it is an uncaught render
        // error (Suspense never catches thrown errors, only suspensions), so it must still reach
        // the server log with a digest and fire the onRequestError funnel exactly once. Control-flow
        // signals are skipped. The streaming analogue of pageRender's render catch.
        reportStreamRenderError(error, state)
        return renderSuspenseReplacement(
          id,
          renderToString(
            hStreamError(
              error,
              state.dev,
              nextCompatEnabled(state.options.config),
              needsClientEntry(state.options.route),
            ),
          ),
          state.options,
          nonce,
        )
      }),
  )
  const markerProps = { 'data-pnext-suspense': id, ...loadingDepthAttributes(node.props) }
  const fallback = resolveServerTreeForStream(node.props.fallback, state)
  if (isPromise(fallback)) {
    return fallback.then(resolved => h('pnext-suspense', markerProps, resolved))
  }
  return h('pnext-suspense', markerProps, fallback)
}

// A real error that escaped a streaming Suspense boundary. Mirrors pageRender's render catch for
// the streaming path, where the status is already committed and only the log/report remain.
// Control-flow signals are navigation intents, not failures. Never throws.
function reportStreamRenderError(error: unknown, state: StreamState): void {
  if (
    isPostpone(error) ||
    isRedirectError(error) ||
    isNotFoundError(error) ||
    isForbiddenError(error) ||
    isUnauthorizedError(error)
  ) {
    return
  }
  const options = state.options
  // Next's prod server log: original trace + `digest: '<digest>'` (compat's
  // `⨯ Error:` shape). Deduped per error object against the boundary/render
  // catch so a single failure logs exactly once.
  logDevError(options, resolveThrownError(error, nextCompatEnabled(options.config)))
  const unit = getWorkUnit()
  const request = options.request
  void reportRequestError(
    error,
    {
      method: request?.method ?? 'GET',
      url: request?.url ?? String(options.url),
      headers: request?.headers ?? new Headers(),
    },
    {
      phase: unit?.phase,
      routeKind: unit?.routeKind,
      ...(unit?.responseHints ?? {}),
      ...(options.route.client ? { renderSource: 'server-rendering' } : {}),
    },
  )
}

function resolveServerTreeForStream(
  node: unknown,
  state: StreamState,
): ComponentChildren | Promise<ComponentChildren> {
  if (node == null || typeof node !== 'object') return node as ComponentChildren
  if (Array.isArray(node))
    return settleChildren(node.map(child => resolveServerTreeForStream(child, state)))
  if (!isVNode(node)) return node as ComponentChildren

  if (isSuspenseVNode(node)) {
    // Snapshot BEFORE recursing: reaching the `<html>` element deeper in this same synchronous call
    // flips `state.shellPending` to false as a side effect, even when the overall `children` result
    // is still a pending promise. Reading the flag AFTER the call would see it already false and
    // skip the shell-locating branch, deferring the whole document behind this outer boundary's
    // (usually absent) fallback.
    const wasShellPending = state.shellPending
    const children = resolveServerTreeForStream(node.props.children, state)
    if (wasShellPending) {
      // Locating the document shell: block this boundary until its content
      // resolves. If it turns out to wrap the `<html>` shell, use the resolved
      // content directly (no fallback flush); otherwise fall back to normal
      // streaming deferral for it.
      return Promise.resolve(children).then(resolved => {
        if (documentHtmlVNode(resolved) || documentShellChildren(resolved)) {
          state.shellPending = false
          return resolved
        }
        return streamSuspenseBoundary(node, resolved, state)
      })
    }
    // Outer loading boundary with a deeper loading boundary inside: await its content (layouts
    // resolve; the inner boundary defers its own dynamic leaf without blocking) and emit it
    // directly, so the shell carries the DEEPEST loading fallback rather than this outer one.
    if ((node.props as Record<string, unknown>)[LOADING_THROUGH_PROP]) {
      return Promise.resolve(children)
    }
    if (!isPromise(children)) return children
    if (isUseCacheJoinerPromise(children)) return children
    return streamSuspenseBoundary(node, children, state)
  }

  if (typeof node.type !== 'function') {
    const isDocument = node.type === 'html'
    // Flip shellPending the moment we ENTER `<html>`, before resolving its
    // (possibly async) children. A page component below is async, so `<html>`'s
    // children resolve to a promise; deferring the flip into that promise's
    // `.then` leaves shellPending true while the async subtree resolves, so a
    // Suspense boundary reached inside the page (e.g. around a slow server
    // component) wrongly takes the doc-shell blocking branch and awaits its slow
    // content before the shell can flush. Mirrors resolveServerTree's html flip.
    if (isDocument) state.shellPending = false
    const children = resolveServerTreeForStream(node.props.children, state)
    if (isPromise(children)) {
      return children.then(resolved => elementVNode(node, resolved, state))
    }
    return elementVNode(node, children, state)
  }

  const component = node.type
  // Per-slot params scope marker: re-establish the slot's params while resolving
  // its subtree so nested islands capture them (see resolveServerTree above).
  if ((component as { [paramsScopeSymbol]?: true })[paramsScopeSymbol]) {
    return runInParamsScope(paramsScopeParams(node.props), () =>
      resolveServerTreeForStream(node.props.children, state),
    )
  }
  const dynamicReference = (component as DynamicComponent)[dynamicReferenceSymbol]
  if (dynamicReference) {
    const targetReference = dynamicTargetReference(dynamicReference, state)
    if (targetReference) {
      const children = resolveServerTreeForStream(node.props.children, state)
      const island = async (resolved: ComponentChildren) => {
        await ensureClientComponent(targetReference, state)
        return clientIslandVNodeWithPromiseProps(node, targetReference, resolved, state)
      }
      return isPromise(children) ? children.then(island) : island(children)
    }
    const children = resolveServerTreeForStream(node.props.children, state)
    const resolved = Promise.resolve(dynamicReference.load()).then(Component =>
      Promise.resolve(children).then(nextChildren =>
        dynamicVNode(node, markServerReference(Component), nextChildren),
      ),
    )
    return resolved.then(next => resolveServerTreeForStream(next, state))
  }

  const clientComponent = component as ClientComponent
  const reference = clientComponent[clientReferenceSymbol]
  if (reference) {
    const island = async (resolved: ComponentChildren, erroredNode = node) => {
      await ensureClientComponent(reference, state)
      return clientIslandVNodeWithPromiseProps(erroredNode, reference, resolved, state)
    }
    const caught = async (error: unknown) => {
      // Re-throws (aborting the render like before) unless this island is a
      // tagged error boundary — then it renders its fallback via the marker —
      // or this is a runtime prefetch, which transports the failure into the
      // island's own children (see runtimePrefetchIslandErrorMarker).
      await ensureClientComponent(reference, state)
      const transported = runtimePrefetchIslandErrorMarker(error, reference, state)
      if (transported) return island(transported)
      const marker = islandBoundaryErrorMarker(error, reference, state)
      return island(null, withIslandBoundaryError(node, marker))
    }
    let children: ComponentChildren | Promise<ComponentChildren>
    try {
      children = resolveServerTreeForStream(node.props.children, state)
    } catch (error) {
      return caught(error)
    }
    return isPromise(children) ? children.then(child => island(child), caught) : island(children)
  }

  // A whole-page client component: SSR via preact, never server-invoke (see the
  // note in resolveServerTree). A sync throw propagates out of the string pass to
  // pageRender's render catch; an async throw is surfaced by pageRender's pre-run.
  if (isClientPageComponent(component)) return node
  if (isPreactClassComponent(component)) return node

  const serverComponent = component as ServerComponent<ServerVNodeProps>
  let result: ServerComponentResult
  try {
    result = invokeServerComponentWithUse(serverComponent, node.props)
  } catch (error) {
    if (!shouldInvokeServerComponent(component) && isHookDispatcherError(error)) {
      const children = resolveServerTreeForStream(node.props.children, state)
      if (isPromise(children)) {
        return children.then(resolved => elementVNode(node, resolved, state))
      }
      return elementVNode(node, children, state)
    }
    throw error
  }
  if (isPromise(result)) {
    const resolved = result.then(value => resolveServerTreeForStream(value, state))
    if (isUseCacheJoinerPromise(result)) {
      ;(resolved as unknown as Record<symbol, unknown>)[useCacheJoinerPromiseSymbol] = true
    }
    return resolved
  }
  return resolveServerTreeForStream(result, state)
}

function settleChildren(children: (ComponentChildren | Promise<ComponentChildren>)[]) {
  const pending = children.filter(isPromise)
  return pending.length > 0 ? Promise.all(children.map(child => Promise.resolve(child))) : children
}

async function settleRoot(node: ComponentChildren | Promise<ComponentChildren>) {
  return node
}

async function* completed<T>(promises: Promise<T>[]) {
  // The array is LIVE: a streamed Suspense replacement that itself contains a
  // pending nested boundary pushes that boundary's chunk into the same array
  // mid-drain (deferSuspenseBoundary during the outer chunk's render). Re-admit
  // after every settle or the stream closes with nested tails orphaned (slow
  // page under slow layout: only the layout chunk ever flushed).
  const pending = new Map<number, Promise<{ index: number; value: T }>>()
  let admitted = 0
  const admit = () => {
    while (admitted < promises.length) {
      const index = admitted++
      pending.set(
        index,
        promises[index]!.then(value => ({ index, value })),
      )
    }
  }
  admit()
  while (pending.size > 0) {
    const { index, value } = await Promise.race(pending.values())
    pending.delete(index)
    admit()
    yield value
    admit()
  }
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === 'object' && value !== null && 'then' in value
}

function isUseCacheJoinerPromise(value: Promise<unknown>): boolean {
  return Boolean((value as unknown as Record<symbol, unknown>)[useCacheJoinerPromiseSymbol])
}

function isVNode(value: unknown): value is ServerVNode {
  return typeof value === 'object' && value !== null && 'type' in value && 'props' in value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSuspenseVNode(node: ServerVNode) {
  const compatSuspense = getSuspenseExtensions().compatSuspenseType()
  return (
    node.type === (Suspense as unknown) ||
    (compatSuspense !== undefined && node.type === compatSuspense) ||
    isPreactCompatSuspenseType(node.type)
  )
}

function isPreactCompatSuspenseType(type: unknown) {
  if (typeof type !== 'function') return false
  const prototype = (type as { prototype?: unknown }).prototype
  return (
    isRecord(prototype) &&
    typeof prototype.__c === 'function' &&
    typeof prototype.componentWillUnmount === 'function' &&
    typeof prototype.render === 'function' &&
    prototype.isReactComponent === true
  )
}

function isPreactClassComponent(component: ComponentType<ServerVNodeProps>) {
  return component.prototype instanceof Component
}

interface ActionSerializeState {
  options: RenderOptions
  clientPageStream?: boolean
}

/**
 * Wire id for a function crossing the server->client boundary. The id policy - a tagged
 * module-level 'use server' export keeps its stable module id; inline actions, .bind() results and
 * HOC wrappers register a live per-render instance - lives entirely in the compat
 * serializeServerActionProp extension. Core owns only the recursive walk and the marker shape.
 * Undefined when compat is off or the function is not an action.
 */
function actionIdForFunction(
  fn: unknown,
  state: ActionSerializeState,
  identifiedOnly = false,
): string | undefined {
  const stubId = (fn as { $$pnextActionId?: unknown } | undefined)?.$$pnextActionId
  if (typeof stubId === 'string') return stubId
  const marker = getRenderExtensions().serializeServerActionProp(fn, {
    config: state.options.config,
    renderKey: state.options,
    identifiedOnly,
  })
  const id = marker?.[PROP_ACTION_MARKER]
  return typeof id === 'string' ? id : undefined
}

function elementVNode(
  node: ServerVNode,
  children: ComponentChildren,
  state?: ActionSerializeState,
) {
  const { children: _children, ...props } = node.props
  const type = typeof node.type === 'symbol' ? Fragment : node.type
  if (type === 'form' && typeof props.action === 'function') {
    return serverActionFormVNode(props, children, state)
  }
  if (
    (type === 'button' || type === 'input') &&
    typeof (props as { formAction?: unknown }).formAction === 'function' &&
    state
  ) {
    return actionSubmitterVNode(type, props, children, state)
  }
  // `onClick` is progressively enhanced ONLY when the function is identifiably a server action. An
  // ordinary client handler must stay untouched: stamping it makes the document-level click
  // listener dispatch a bogus action - and swallow the click with preventDefault - for the whole
  // window between the listener being installed and the island hydrating over the attribute.
  if (typeof type === 'string' && typeof props.onClick === 'function' && state) {
    const id = actionIdForFunction(props.onClick, state, true)
    if (id) {
      delete props.onClick
      props[ACTION_CLICK_ID_ATTR] = id
    }
  }
  return h(type as string, props, children)
}

/** The one message every core server-action refusal uses; see SERVER_ACTIONS_UNSUPPORTED. */
function serverActionUnsupported(options: RenderOptions): Error {
  return new Error(
    serverActionsUnsupportedMessage({
      file: options.route.serverActionFile ?? options.route.file,
      route: options.route.route,
      root: options.config.root,
    }),
  )
}

// Progressive enhancement for <form action={serverAction}>: render a real POST
// form back to the current page URL with the id in a hidden field, so a no-JS
// submit still dispatches (serveAction promotes the field to the next-action
// header) and the JS submit listener picks the id up from the DOM. Tagged
// module-export actions use their stable id; inline/bound functions register a
// live instance. An unidentifiable action renders the form inert.
function serverActionFormVNode(
  props: Record<string, unknown>,
  children: ComponentChildren,
  state?: ActionSerializeState,
) {
  const rest = { ...props }
  delete rest.action
  if (!state) return h('form', rest, children)
  // Core has no action registry and no dispatch endpoint, so there is nothing to
  // wire this form to. Dropping the prop rendered a form that silently submits a
  // GET to the current URL - undebuggable from the browser - so core refuses.
  if (!nextCompatEnabled(state.options.config)) throw serverActionUnsupported(state.options)
  const enhanced = serverActionFormProps(props, state)
  if (!enhanced) return h('form', rest, children)
  return h('form', enhanced.props, enhanced.hidden, children)
}

function serverActionFormProps(props: Record<string, unknown>, state: ActionSerializeState) {
  const { action, ...rest } = props
  delete rest.children
  // useActionState dispatch: identify by the UNDERLYING action and carry the
  // form's current state so a no-JS submit runs action(state, formData) and
  // the server re-renders with the result.
  const meta = (action as { $$pnextFormState?: FormStateMeta } | undefined)?.$$pnextFormState
  const target = meta ? meta.action : action
  const id = actionIdForFunction(target, state)
  if (!id) return undefined
  const hidden: ComponentChildren[] = [
    h('input', { type: 'hidden', name: ACTION_ID_FIELD, value: id }),
  ]
  if (meta) {
    hidden.push(
      h('input', {
        type: 'hidden',
        name: FORM_STATE_FIELD,
        value: JSON.stringify(meta.state ?? null),
      }),
    )
  }
  // No-JS submissions POST back to the current page URL (no action attribute
  // unless a permalink was given), matching compat/actions/protocol.ts.
  return {
    props: {
      ...rest,
      ...(meta?.permalink ? { action: meta.permalink } : {}),
      method: 'post',
      encType: 'multipart/form-data',
    },
    hidden,
  }
}

// <button formAction={fn}> / <input type=submit formAction={fn}>: the submit
// button carries the action id as its name/value pair (submitted only when it
// is the submitter) plus formmethod/formenctype overrides so a no-JS submit
// posts multipart to the page URL regardless of the surrounding form's own
// attributes. The server promotes the LAST id field, so a per-button id wins
// over a form-level hidden field.
function actionSubmitterVNode(
  type: 'button' | 'input',
  props: Record<string, unknown>,
  children: ComponentChildren,
  state: ActionSerializeState,
) {
  const { formAction, ...rest } = props
  if (!nextCompatEnabled(state.options.config)) throw serverActionUnsupported(state.options)
  const id = actionIdForFunction(formAction, state)
  if (!id) return h(type, rest, children)
  return h(
    type,
    {
      ...rest,
      name: SUBMIT_ACTION_ID_FIELD,
      value: id,
      formMethod: 'post',
      formEncType: 'multipart/form-data',
    },
    children,
  )
}

/**
 * Convention props the framework itself supplies as FUNCTIONS (error.tsx's
 * `reset`/`unstable_retry`) are documented API, so a `'use client'` boundary
 * must be able to receive them. They ride the same `$$pnextErrorReset` marker
 * compat writes; core reads it back in utils/serialize. Convention props are
 * always top level, so this is one typeof per prop and no copy when there is
 * nothing to rewrite.
 */
function serializeConventionProps(props: Record<string, unknown>): Record<string, unknown> {
  let out: Record<string, unknown> | undefined
  for (const [key, value] of Object.entries(props)) {
    if (typeof value !== 'function') continue
    if (!(value as { [PROP_ERROR_RESET_MARKER]?: unknown })[PROP_ERROR_RESET_MARKER]) continue
    out ??= { ...props }
    out[key] = { [PROP_ERROR_RESET_MARKER]: true }
  }
  return out ?? props
}

/**
 * Replace function props (server actions handed to a client island) with the
 * serializable action-reference marker the client runtime revives. Non-action
 * functions fall through untouched so serializeProps still reports them.
 */
function serializeActionProps(
  props: Record<string, unknown>,
  state: ActionSerializeState,
): Record<string, unknown> {
  if (!nextCompatEnabled(state.options.config)) return serializeConventionProps(props)
  // Taint check runs on the RAW props: serializeActionValue copies plain (and
  // null-prototype) objects, which would drop the identity `process.env` is
  // recognized by.
  assertNotTainted(props)
  return serializeActionValue(props, state) as Record<string, unknown>
}

/**
 * `seen` memoises copies by IDENTITY, so a cyclic prop reproduces its cycle in
 * the copy instead of recursing until the stack blows (a cyclic client prop was
 * a hard 500). `encodeBinary` then emits its own `$$pnext_ref` for true ancestor
 * cycles; acyclic payloads stay byte-identical since shared siblings still
 * expand there.
 */
function serializeActionValue(
  value: unknown,
  state: ActionSerializeState,
  seen = new Map<object, unknown>(),
): unknown {
  if (typeof value === 'function') {
    if ((value as { [PROP_ERROR_RESET_MARKER]?: unknown })[PROP_ERROR_RESET_MARKER]) {
      return { [PROP_ERROR_RESET_MARKER]: true }
    }
    const id = actionIdForFunction(value, state)
    return id ? { [PROP_ACTION_MARKER]: id } : value
  }
  if (value instanceof Error) {
    const digest = (value as { digest?: unknown }).digest
    return {
      $$pnextError: {
        name: value.name,
        message: value.message,
        ...(typeof digest === 'string' ? { digest } : {}),
      },
    }
  }
  if (Array.isArray(value)) {
    const existingArray = seen.get(value)
    if (existingArray !== undefined) return existingArray
    const out: unknown[] = []
    seen.set(value, out)
    for (const item of value) out.push(serializeActionValue(item, state, seen))
    return out
  }
  if (value !== null && typeof value === 'object' && isPlainObject(value)) {
    const existing = seen.get(value)
    if (existing !== undefined) return existing
    const result: Record<string, unknown> = {}
    seen.set(value, result)
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = serializeActionValue(item, state, seen)
    }
    return result
  }
  return value
}

function isPlainObject(value: object) {
  const proto = Object.getPrototypeOf(value) as object | null
  return proto === Object.prototype || proto === null
}

// Server-tree <form action={fn}> / <button formAction={fn}> progressive
// enhancement lives in serverActionFormVNode / actionSubmitterVNode above (core
// walk) using the compat serializeServerActionProp id lookup. Forms and
// submitters rendered INSIDE client components go through preact's own
// renderToString; the server-side options.vnode hook applyServerActionFormVNode
// enhances them there so no-JS island submits also post the action wire (the
// client action runtime's own options.vnode hook then layers on the JS path).

// Shape of the $$pnextFormState metadata a useActionState dispatch carries
// (compat/react/preact tagFormStateDispatch). serverActionFormVNode reads it to
// identify the underlying action + emit the state hidden field. Structural on
// purpose so core keeps no static import of the compat module.
interface FormStateMeta {
  action: unknown
  state: unknown
  permalink?: string
}

function dynamicTargetReference(
  dynamicReference: Pick<DynamicReference, 'target'>,
  state: { clientReferences: ClientReferenceMap },
) {
  const target = dynamicReference.target
  if (!target) return undefined
  return state.clientReferences.get(`c-${clientReferenceId(target.file, target.exportName)}`)
}

function clientIslandVNode(
  node: ServerVNode,
  reference: ClientReference,
  children: ComponentChildren,
  state: ResolveState,
) {
  const resolvedReference = state.clientReferences.get(reference.id) ?? reference
  const {
    children: _children,
    [LAYOUT_SCOPE_PROP]: layoutScope,
    [TEMPLATE_MARKER_PROP]: templateMarker,
    ...props
  } = node.props as Record<string, unknown> & { children?: unknown }
  const component =
    state.clientComponents.get(resolvedReference.id) ??
    (node.type as ComponentType<Record<string, unknown>>)
  return h(
    ClientIsland,
    {
      ...props,
      // Serialized ahead of ClientIsland (which has no render state): function
      // props that are server actions become revivable reference markers. The
      // layout-scope snapshot is stripped here so it never lands in the
      // component's own props; it rides a dedicated data attribute instead.
      // Plain text/number children join the serialized props (see ClientIsland:
      // they may never appear in the SSR output for DOM adoption to recover).
      // Element props become `$$pnext_slot` markers here; ClientIsland runs the matching 'ssr'
      // walk over the same prop shape, so the ids line up with the server markup.
      __pnextSerializedProps: serializeProps(
        islandStaticSlotProps(
          resolvedReference.id,
          {
            ...serializeActionProps(props, state),
            ...(() => {
              const plain = plainIslandChildren(children)
              return plain !== undefined ? { children: plain } : {}
            })(),
          },
          'wire',
        ),
        { allowElements: true },
      ),
      __pnextClient: resolvedReference,
      __pnextComponent: component,
      __pnextTemplate: templateMarker === true,
      __pnextLayoutScope: layoutScope as LayoutSegmentSnapshot | undefined,
      // Params visible at this island's position in the route (route params plus
      // any enclosing parallel-route slot's own dynamic/catch-all captures). Read
      // from the active params scope (render/slots.ts) so a slot island's
      // useParams sees the slot params, not just the global route params.
      __pnextParamsScope: currentParamsSnapshot(),
      __pnextSkipSsr:
        state.partial?.mode === 'build' && clientReferenceRequiresRuntime(resolvedReference),
      __pnextCsrFallback: state.csrBailoutFallback,
    },
    children,
  )
}

function clientReferenceRequiresRuntime(reference: ClientReference): boolean {
  try {
    const source = readFileSync(reference.file, 'utf8')
    return /\bnew\s+Date\s*\(|\bDate\.now\s*\(|\bMath\.random\s*\(/.test(source)
  } catch {
    return false
  }
}

/**
 * Element-valued island props belong to the SERVER tree: resolve them exactly like element children
 * so nested client references become islands (and server components run) before the island SSRs
 * them into its static slots. `children` is resolved by the caller and re-attached separately.
 */
async function resolveIslandElementProps(
  props: Record<string, unknown>,
  state: ResolveState,
): Promise<Record<string, unknown>> {
  const { children: _children, ...rest } = props
  const resolved = (await resolveElementValues(rest, state, new Set())) as Record<string, unknown>
  return resolved === rest ? props : { ...resolved, children: props.children }
}

async function resolveElementValues(
  value: unknown,
  state: ResolveState,
  seen: Set<object>,
): Promise<unknown> {
  if (isElementLike(value)) return resolveServerTree(value, state)
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return value
  seen.add(value)
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value)
  let changed = false
  const mapped: [string, unknown][] = []
  for (const [key, item] of entries) {
    const next = await resolveElementValues(item, state, seen)
    if (next !== item) changed = true
    mapped.push([key, next])
  }
  seen.delete(value)
  if (!changed) return value
  return Array.isArray(value) ? mapped.map(([, item]) => item) : Object.fromEntries(mapped)
}

async function clientIslandVNodeWithPromiseProps(
  node: ServerVNode,
  reference: ClientReference,
  children: ComponentChildren,
  state: ResolveState,
) {
  // Before serializablePromiseProps: it rebuilds nested plain objects to await
  // buried promises, which drops the object identity the taint check relies on
  // (the later assert in serializeActionProps only sees the rebuilt copies).
  if (nextCompatEnabled(state.options.config)) assertNotTainted(node.props)
  const props = await resolveIslandElementProps(await serializablePromiseProps(node.props), state)
  return clientIslandVNode(
    { ...node, props: { ...props, children: node.props.children } },
    reference,
    children,
    state,
  )
}

/**
 * The wire value for a hanging request-API prop: a re-stampable placeholder for
 * `params`/`searchParams`, a plain null marker for anything else (nothing can
 * restore an unrelated hanging value, and a pending promise on the client is
 * worse than a settled null).
 */
function placeholderPromiseMarker(key: string) {
  return key === 'params' || key === 'searchParams'
    ? promisePlaceholderMarker(key)
    : promiseMarker(null)
}

async function serializablePromiseProps(props: ServerVNodeProps): Promise<ServerVNodeProps> {
  const next: ServerVNodeProps = {}
  for (const [key, value] of Object.entries(props)) {
    next[key] =
      key === 'children'
        ? value
        : isPromise(value) && isHangingPromise(value)
          ? // A fallback shell's params/searchParams promise HANGS: awaiting it
            // here rejects with PostponeError outside every <Suspense>, which
            // destroys the whole partial shell (no shell -> no segment
            // artifacts). Emit the placeholder instead; withRequestRouteParams
            // re-stamps it with the serving request's values.
            placeholderPromiseMarker(key)
          : await deepResolveNestedPromises(value)
  }
  return next
}

/**
 * Await every Promise in a prop and replace it with a `promiseMarker`, at the top level (a page's
 * params) and buried in a nested object/array/Map/Set alike (a react-query dehydrated state keeps
 * its pending-query promise at `state.queries[n].promise`). The marker is what preserves PROMISE
 * IDENTITY across the wire: the client revives it into a pre-fulfilled promise, so a consumer that
 * calls `.then` on it - use(), react-query's tryResolveSync - still finds a thenable.
 *
 * A hanging promise (partial prerender) is never awaited - that would wedge the render - and a
 * nested one has no re-stampable identity, so it settles as null exactly like a non-request-API
 * hanging prop.
 */
async function deepResolveNestedPromises(
  value: unknown,
  seen = new Map<object, unknown>(),
): Promise<unknown> {
  if (isPromise(value)) {
    if (isHangingPromise(value)) return promiseMarker(null)
    return promiseMarker(await deepResolveNestedPromises(await value, seen))
  }
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return seen.get(value)
  if (Array.isArray(value)) {
    const items: unknown[] = []
    seen.set(value, items)
    for (const item of value) items.push(await deepResolveNestedPromises(item, seen))
    return items
  }
  if (value instanceof Map) {
    const map = new Map<unknown, unknown>()
    seen.set(value, map)
    for (const [k, v] of value.entries()) {
      map.set(await deepResolveNestedPromises(k, seen), await deepResolveNestedPromises(v, seen))
    }
    return map
  }
  if (value instanceof Set) {
    const set = new Set<unknown>()
    seen.set(value, set)
    for (const item of value) set.add(await deepResolveNestedPromises(item, seen))
    return set
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return value
  const out: Record<string, unknown> = {}
  seen.set(value, out)
  for (const [key, item] of Object.entries(value))
    out[key] = await deepResolveNestedPromises(item, seen)
  return out
}

async function ensureClientComponent(reference: ClientReference, state: ResolveState) {
  const resolvedReference = state.clientReferences.get(reference.id) ?? reference
  state.clientReferences.set(resolvedReference.id, resolvedReference)
  // Non-SSR references only need registration for the client entry; importing
  // the module would run client code (ssr: false may touch browser globals).
  if (!ssrClientReference(resolvedReference)) return
  if (state.clientComponents.has(resolvedReference.id)) return
  const module = await importClientModule(resolvedReference.file, state.options)
  const component = clientComponentExport(
    module,
    resolvedReference.exportName,
    resolvedReference.file,
  )
  if (!component) return
  component[clientReferenceSymbol] = resolvedReference
  state.clientComponents.set(
    resolvedReference.id,
    component as ComponentType<Record<string, unknown>>,
  )
}

type DynamicComponent = ((props: ServerVNodeProps) => unknown) & {
  [dynamicReferenceSymbol]?: DynamicReference<ServerVNodeProps>
}

function dynamicVNode(
  node: ServerVNode,
  component: ComponentType<ServerVNodeProps>,
  children: ComponentChildren,
) {
  const { children: _children, ...props } = node.props
  return h(component, props, children)
}

/**
 * Invoke a server component. The compat (react) layer wraps the call with use() replay support: a
 * thrown thenable suspends the component, and once it settles the component replays with use() call
 * N resolving to the thenable tracked on the previous attempt. The pure-core default just calls
 * through - core has no use(), so no replay is needed.
 */
function invokeServerComponentWithUse(
  component: ServerComponent<ServerVNodeProps>,
  props: ServerVNodeProps,
): ServerComponentResult | Promise<ServerComponentResult> {
  // awaitAtTaskBoundary is a no-op outside a cacheComponents build shell render;
  // inside one it bounds the component by the prerender's task boundary so
  // task-settled work (setTimeout / real I/O) postpones instead of baking in.
  return awaitAtTaskBoundary(
    getRenderExtensions().wrapServerComponentInvoke(() => component(props)),
  )
}

// A `'use client'` root layout owns `<html>`/`<body>` and uses hooks
// (useState/useReducer). Invoking it via the server-component path has no preact
// hook dispatcher (`__H`), so useState throws `r.__H undefined` and 500s every
// route. Whole-page client components dodge this by staying unresolved for the
// string pass (isClientPageComponent), but the document layout MUST be invoked
// here so readDocumentLayout can split `<html>`/`<body>`. So invoke it under a
// throwaway preact render whose current component owns the hook dispatcher, and
// capture the vnode it returns: hooks run against that dispatcher and the layout's
// INITIAL state is baked into the SSR vnode (the client re-runs it on hydration).
// The captured child subtree is discarded by returning null, so no descendant is
// stringified twice.
function invokeClientRootLayout(
  component: (props: ServerVNodeProps) => unknown,
  props: ServerVNodeProps,
): ComponentChildren {
  let captured: ComponentChildren
  function Capture() {
    captured = component(props) as ComponentChildren
    return null
  }
  renderToString(h(Capture, null))
  return captured
}

function markServerReference<T>(component: T): T {
  if (typeof component === 'function') {
    ;(component as unknown as ServerReference)[serverReferenceSymbol] = true
  }
  return component
}

// A whole-page client component (a `route.client` page) tagged so the server
// tree resolver renders it through preact (renderToStringAsync) rather than
// server-invoking it. See the tagging site in pageRender.
const clientPageComponentSymbol = Symbol.for('pnext.clientPageComponent')
const clientPageSsrErrors = new WeakSet<object>()

class ClientPageSsrBoundary extends Component<
  { children?: ComponentChildren },
  { failed: boolean; error: unknown }
> {
  state = { failed: false, error: undefined as unknown }

  static getDerivedStateFromError(error: unknown) {
    if (error !== null && typeof error === 'object') clientPageSsrErrors.add(error)
    return { failed: true, error }
  }

  render(props: { children?: ComponentChildren }, state: { failed: boolean; error: unknown }) {
    if (state.failed) throw state.error
    return props.children
  }
}

/**
 * Server-render a browser-only client page for its ERROR only: the markup is
 * discarded (the page stays out of the document, as before) and a genuine throw
 * is funnelled to onRequestError the way Next reports a client page that fails
 * to server-render. A bare render has no surrounding providers, so a hook
 * dispatcher failure is an artifact of the probe rather than the app's own
 * error and stays unreported, as do control-flow signals. Build prerenders are
 * skipped: Next reports request errors, not build ones.
 */
async function probeBrowserOnlyClientPageError(
  Page: ComponentType<PageProps>,
  props: PageProps,
): Promise<void> {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  if (process.env.NEXT_PHASE === 'phase-production-build') return
  try {
    await renderToStringAsync(h(Page, props))
  } catch (error) {
    if (isIslandControlFlowSignal(error) || isHookDispatcherError(error)) return
    reportClientSsrError(error)
  }
}

function isClientPageSsrError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && clientPageSsrErrors.has(error)
}

function markClientPageComponent(component: ServerComponent<PageProps>) {
  ;(component as unknown as Record<symbol, boolean>)[clientPageComponentSymbol] = true
}

function isClientPageComponent(component: ComponentType<ServerVNodeProps>) {
  return Boolean((component as unknown as Record<symbol, boolean>)[clientPageComponentSymbol])
}

function clientPageRequiresBrowser(component: ComponentType<PageProps>) {
  return /\btypeof\s+window\s*(?:={2,3}|>)\s*(['"])(?:undefined|u)\1/.test(
    Function.prototype.toString.call(component),
  )
}

function isAsyncFunctionComponent(component: unknown): boolean {
  return typeof component === 'function' && component.constructor.name === 'AsyncFunction'
}

function shouldInvokeServerComponent(component: ComponentType<ServerVNodeProps>) {
  return (
    Boolean((component as unknown as ServerReference)[serverReferenceSymbol]) ||
    component.constructor.name === 'AsyncFunction'
  )
}

function isHookDispatcherError(error: unknown) {
  if (!(error instanceof Error)) return false
  const details = `${error.message}\n${error.stack ?? ''}`
  return (
    details.includes('/preact/hooks/') ||
    details.includes('/preact/dist/') ||
    details.includes("reading '__H'") ||
    details.includes("evaluating 'r.context'") ||
    details.includes('getChildContext')
  )
}

async function readRenderModuleMetadata(
  options: RenderOptions,
  module: Record<string, unknown>,
  props: PageProps,
  parent: Metadata,
  file: string,
  prebuilt?: Metadata,
): Promise<Metadata | undefined> {
  const extensions = getActiveMetadataExtensions(options.config)
  try {
    if (extensions.readModuleMetadata) {
      return await extensions.readModuleMetadata(module, props, parent, file)
    }
    return prebuilt ?? readModuleMetadata(module)
  } catch (error) {
    if (options.partial?.mode === 'build' && isPostpone(error)) {
      options.partial.metadataDynamic = true
      return undefined
    }
    noteMetadataRedirect(error)
    throw error
  }
}

function renderSuspenseReplacement(
  id: string,
  html: string,
  options: RenderOptions,
  nonce?: string,
  slots?: number[],
) {
  // Streamed Suspense content rides in a `<div hidden>` (React/Next's own
  // streaming markup shape) rather than a `<template>`: tests (and tools like
  // cheerio) assert streamed-but-unswapped content sits under a `[hidden]`
  // ancestor, and template contents are invisible to those parsers entirely.
  const nonceAttribute = nonce ? ` nonce="${escapeHtml(nonce)}"` : ''
  // `data-pnext-slots` marks a SLOT-GRANULAR chunk: it carries only the
  // boundary's dynamic slots (comment-delimited), and promotion merges them with
  // the static slots the shell's `<template data-pnext-static>` already holds.
  const slotsAttribute = slots ? ` data-pnext-slots="${escapeHtml(slots.join(','))}"` : ''
  // A page whose slot sits under a Suspense (loading.tsx, a streamed leaf) ships the slot HERE
  // rather than in the shell, so the same mount-target rule the document body applies has to run
  // on the tail: $RC grafts these bytes into the live DOM, and an inert wrapper would re-enter it.
  const body = unwrapUnusedPageSlot(html, streamPageSlotMode(options))
  return `<div hidden data-pnext-stream="${escapeHtml(id)}"${slotsAttribute}>${body}</div><script${nonceAttribute}>${suspenseReplaceScript(id)}</script>`
}

async function renderVNodeToString(vnode: VNode, state?: ActionSerializeState) {
  const html = !state
    ? await renderToStringAsync(vnode)
    : await actionSerializeScope.run(state, () => renderToStringAsync(vnode))
  return serializeNeutralClientIslands(html)
}

/**
 * COMPAT SEAM - server-action element returns (compat/actions/endpoint.ts). The one narrow export
 * the actions cluster reaches into the renderer for.
 *
 * A `'use server'` action may RETURN a React element tree. The endpoint's JSON return serializer
 * cannot carry vnodes, so this resolves the returned subtree with the SAME server-tree machinery a
 * page render uses and stringifies it to the island wire HTML the action client revives. Islands
 * nested in such a return are not re-hydrated (the action serialize path carries no
 * client-reference map).
 */
export async function renderActionReturnElement(
  element: unknown,
  options: RenderOptions,
): Promise<string> {
  const state: ResolveState = {
    options,
    clientComponents: new Map(),
    clientReferences: new Map(),
  }
  const resolved = await resolveServerTree(element, state)
  return renderVNodeToString(h(Fragment, null, resolved))
}

/**
 * preact's stream renderer builds the SHELL synchronously: a component that suspends with no
 * <Suspense> registered above it escapes `start()` as this error instead of being awaited. The
 * non-streaming path has no such limit (renderToStringAsync retries the suspension), so falling
 * back to it keeps a suspending island - a react-query island reading a dehydrated promise, say -
 * rendering exactly as it does on a non-streamed request.
 */
const SYNC_SUSPENSE_MESSAGE = 'Use "renderToStringAsync" for suspenseful rendering.'

function isSyncSuspenseError(error: unknown): boolean {
  return error instanceof Error && error.message === SYNC_SUSPENSE_MESSAGE
}

/** Sentinel: the shell suspended synchronously and must be re-rendered by the awaited path. */
const SHELL_SUSPENDED = Symbol('pnext.shellSuspended')

async function renderClientPageStreamShell(vnode: VNode, state: StreamState): Promise<string> {
  const shell = await suspendingStreamScope.run(true, () =>
    renderSuspendingStreamShell(vnode, state),
  )
  if (shell !== SHELL_SUSPENDED) return shell
  // Deliberately OUTSIDE the suspending-stream scope: that scope disables preact's error
  // boundaries, and the awaited path needs them back on to match the non-streamed render exactly.
  return renderVNodeToString(vnode, state)
}

async function renderSuspendingStreamShell(
  vnode: VNode,
  state: StreamState,
): Promise<string | typeof SHELL_SUSPENDED> {
  state.clientPageStream = true
  // The shell renders inside `new ReadableStream`'s start(), so a synchronous suspension throws
  // out of the CONSTRUCTOR - the read below never happens. Both have to be guarded.
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let first: Awaited<ReturnType<NonNullable<typeof reader>['read']>>
  try {
    const stream = actionSerializeScope.run(state, () => renderToReadableStream(vnode))
    // preact hangs a SECOND promise off the stream - `allReady`, resolved when the whole render
    // (shell + every suspended boundary) lands - and rejects BOTH it and the stream with the same
    // error. Reading the stream owns one of them; nothing owns `allReady`, so a shell that fails
    // reports an unhandled rejection on top of the failure the caller already handled. pnext never
    // awaits full-render completion (the deferred tail below drains the reader instead), so the
    // handler is a discard rather than a second error path.
    void (stream as { allReady?: Promise<void> }).allReady?.catch(() => undefined)
    reader = stream.getReader()
    first = await reader.read()
  } catch (error) {
    if (isSyncSuspenseError(error)) {
      state.clientPageStream = false
      void reader?.cancel().catch(() => undefined)
      return SHELL_SUSPENDED
    }
    // A whole-page client route streams WITHOUT the ClientPageSsrBoundary (an error boundary
    // disables preact's stream suspense), so nothing tags a throw escaping this render. It came
    // from the client tree by construction, so tag it here - otherwise global-error would redact
    // the message and attach a digest as if it were an RSC error. Server-tree routes reach this
    // renderer too, and their throws ARE RSC errors.
    if (
      state.options.route.client &&
      !isIslandControlFlowSignal(error) &&
      error !== null &&
      typeof error === 'object'
    ) {
      clientPageSsrErrors.add(error)
    }
    throw error
  }
  // The shell is complete once the first chunk lands (the tail carries only suspended boundary
  // payloads), so anything a CSS-in-JS registry collected by now is shell content and belongs in the
  // head. Drain it HERE, synchronously after the read, so the deferred tail cannot drain it first
  // and push the shell's styles into the body stream.
  state.insertedHead = getDocumentScriptExtensions().streamInsertedHTML?.() ?? ''

  if (first.done) return ''

  state.deferred.push(
    actionSerializeScope.run(state, async () => {
      const decoder = new TextDecoder()
      let tail = ''
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        tail += decoder.decode(next.value, { stream: true })
      }
      tail += decoder.decode()
      tail = tail.replace(
        /<script>\(function\(\)\{[\s\S]*?customElements\.define\("preact-island"[\s\S]*?<\/script>/,
        '',
      )
      const inserted = getDocumentScriptExtensions().streamInsertedHTML?.() ?? ''
      const refresh = tail.includes('<preact-island')
        ? clientSuspenseRefreshScript(documentNonce(state.options.request))
        : ''
      // Same mount-target rule as the out-of-order chunks: an inline-suspense tail carries the page
      // slot whenever the page itself suspended, and the graft lands it in the live DOM.
      return unwrapUnusedPageSlot(
        serializeNeutralClientIslands(`${inserted}${anchorInlineSuspenseHoles(tail)}${refresh}`),
        streamPageSlotMode(state.options),
      )
    }),
  )
  return serializeNeutralClientIslands(
    anchorInlineSuspenseHoles(new TextDecoder().decode(first.value)),
  )
}

// Turn preact's stream suspense comment markers (`<!--$s:ID-->fallback
// <!--/$s:ID-->`) into a `<pnext-hole data-pnext-hole="ID">` element wrapping
// the fallback. Comment markers do not survive an ancestor client layout's
// hydration, so the deferred graft script ($RC / materializeInlineIslands)
// keys off this element instead. `display:contents` keeps it byte-neutral in
// layout, and it is adopted as the island's static children on hydration.
function anchorInlineSuspenseHoles(html: string): string {
  return (
    html
      .replace(
        /<!--\$s:([^>]+?)-->/g,
        (_match, id: string) =>
          `<pnext-hole data-pnext-hole="${escapeHtml(id)}" style="display:contents">`,
      )
      .replace(/<!--\/\$s:[^>]+?-->/g, '</pnext-hole>')
      // A loading.js fallback leads with its depth marker (markInlineLoadingFallback): lift it
      // onto the hole, which is the only wire form the runtime can read attributes from.
      .replace(
        new RegExp(
          `(<pnext-hole data-pnext-hole="[^"]*")( style="display:contents">)<${LOADING_DEPTH_TAG} ${LOADING_DEPTH_ATTRIBUTE}="(\\d+)"></${LOADING_DEPTH_TAG}>`,
          'g',
        ),
        (_match, open: string, close: string, depth: string) =>
          `${open} ${LOADING_DEPTH_ATTRIBUTE}="${depth}"${close}`,
      )
  )
}

export function clientSuspenseRefreshScript(nonce: string | undefined) {
  const nonceAttribute = nonce ? ` nonce="${escapeHtml(nonce)}"` : ''
  // Graft each streamed island's content over its hole. The hole is a `<pnext-hole>` element rather
  // than preact's `$s:ID` comment markers: hydration of an ancestor client layout removes comment
  // markers before this script - which streams in the deferred tail - can run, but the element
  // survives adoption as the island's static children. Falls back to the comment markers when the
  // element is absent.
  //
  // The grafted content arrives AFTER the document-wide island bootstrap ran, so its islands are
  // still comment markers no scan can see: materialize and re-mount once the graft is done, the same
  // pair PROMO_RUNTIME runs for the `<pnext-suspense>` path. Without it every client component inside
  // a streamed Suspense boundary stays inert server HTML - no hydration, no effects, no data fetch.
  return `<script${nonceAttribute}>$RC=function(i,d){var h=document.querySelector('pnext-hole[data-pnext-hole="'+i+'"]');if(h){while(h.firstChild)h.removeChild(h.firstChild);while(d.firstChild)h.appendChild(d.firstChild);d.remove();return}var s,e,w=document.createTreeWalker(document,128);while(w.nextNode()){var n=w.currentNode;if(n.data==='$s:'+i)s=n;else if(n.data==='/$s:'+i)e=n;if(s&&e)break}if(!s||!e)return;var p=e.previousSibling;while(p&&p!==s){var x=p;p=p.previousSibling;x.remove()}while(d.firstChild)s.after(d.firstChild),s=s.nextSibling;d.remove()};document.querySelectorAll('preact-island[data-target]').forEach(function(d){$RC(d.getAttribute('data-target'),d)});window.__PNEXT_MATERIALIZE_CLIENT_ISLANDS__&&window.__PNEXT_MATERIALIZE_CLIENT_ISLANDS__(document);window.__PNEXT_MOUNT_ISLANDS__&&window.__PNEXT_MOUNT_ISLANDS__()</script>`
}

/**
 * The inline script that turns the comment markers back into elements. Only the comment wire format
 * needs it, so a core document - whose islands are already elements - emits nothing here and a
 * zero-island page ships no JavaScript.
 */
function islandMarkerBootstrapTag(mode: PageSlotMarkerMode): string {
  if (!getRenderExtensions().islandCommentWireFormat()) return ''
  return `<script>${clientIslandMarkerBootstrapSource(mode)}</script>`
}

/**
 * Elements-as-final leaves `div#pnext-page` in the document, but nothing mounts on it unless the
 * slot itself hydrates - and an inert wrapper would break the flat body children Next emits.
 * Elements wire format: unwrap it. Comment wire format: empty the marker's attribute payload, which
 * every materializer already reads as "no element to build" - so the slot stays a pure anchor pair
 * on first paint AND on every soft navigation that lands on this document.
 */
function unwrapUnusedPageSlot(html: string, mode: PageSlotMarkerMode): string {
  if (mode === 'materialize') return html
  if (getRenderExtensions().islandCommentWireFormat()) {
    return html.replace(/<!--pnext-page:[^>]*-->/, '<!--pnext-page:-->')
  }
  const slot = pageSlotSpan(html)
  return slot ? html.slice(0, slot.start) + slot.children + html.slice(slot.end) : html
}

function serializeNeutralClientIslands(html: string) {
  if (!getRenderExtensions().islandCommentWireFormat()) return html
  const islands = html
    .split(/(<(?:script|style)\b[\s\S]*?<\/(?:script|style)>)/gi)
    .map(part => {
      if (/^<(?:script|style)\b/i.test(part)) return part
      return part
        .replace(
          /(<!--\s*-->)<pnext-client\b([^>]*)>([^<]+)<\/pnext-client>/g,
          (_match, separator: string, attributes: string, children: string) =>
            `${separator}${children}<!--pnext-client-after:${encodeIslandMarker(attributes)}-->`,
        )
        .replace(
          /<pnext-client\b([^>]*)>/g,
          (_tag, attributes: string) => `<!--pnext-client:${encodeIslandMarker(attributes)}-->`,
        )
        .replace(/<\/pnext-client>/g, '<!--/pnext-client-->')
        .replace(
          /<pnext-static-children\b([^>]*)>/g,
          (_tag, attributes: string) =>
            `<!--pnext-static-children:${encodeIslandMarker(attributes)}-->`,
        )
        .replace(/<\/pnext-static-children>/g, '<!--/pnext-static-children-->')
    })
    .join('')
  return neutralizePageSlot(islands)
}

// Convert the page-slot div into comment markers. The close tag must be the
// BALANCED match for the slot div — a `[\s\S]*</div>$` regex swallows ancestor
// closing tags into the marker span, leaving the layout unclosed in the
// document (scripts then land inside it and cheerio `.text()` reads them).
function neutralizePageSlot(html: string): string {
  const slot = pageSlotSpan(html)
  if (!slot) return html
  const marker = `<!--pnext-page:${encodeIslandMarker(slot.attributes)}-->${slot.children}<!--/pnext-page-->`
  return html.slice(0, slot.start) + marker + html.slice(slot.end)
}

/** The page slot's attributes, children and outer bounds, or undefined. */
function pageSlotSpan(html: string) {
  const open = /<div\b([^>]*\bid="pnext-page"[^>]*)>/.exec(html)
  if (!open) return undefined
  const childrenStart = open.index + open[0].length
  const tag = /<div\b|<\/div>/g
  tag.lastIndex = childrenStart
  let depth = 1
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    depth += m[0] === '</div>' ? -1 : 1
    if (depth === 0) {
      return {
        start: open.index,
        end: m.index + m[0].length,
        attributes: open[1]!,
        children: html.slice(childrenStart, m.index),
      }
    }
  }
  return undefined
}

/**
 * How the island bootstrap treats the page-slot markers. Next renders a page's children straight
 * into the layout with no wrapper element, and its tests assert structural selectors (`body > p`)
 * against the live DOM, so `div#pnext-page` may only be rebuilt when something actually mounts on
 * it:
 *
 *   - `materialize`: a whole-page client route hydrates on the slot, or a client ROOT layout
 *     re-renders the page through it.
 *   - `keep`: nothing mounts on the slot - the route ships the entry for islands and/or the router
 *     runtime only. The wrapper is not rebuilt, but the comment anchors stay: the page-slot
 *     machinery locates the slot from the comment pair just as well as from the element.
 *   - `drop`: no client runtime at all, so nothing will ever read the anchors.
 */
type PageSlotMarkerMode = 'materialize' | 'keep' | 'drop'

/**
 * Whether anything client-side ever mounts INTO the page slot. Only two things do: a whole-page
 * `'use client'` route (it hydrates on `#pnext-page` itself) and a `'use client'` ROOT layout (the
 * entry's client shell re-renders the document through it and reads the slot as its children).
 * ISLANDS DO NOT - each mounts on its own `pnext-client` host - so an island-only route keeps Next's
 * wrapper-free body. Mirrors client/build.ts `hasClientRootLayout`, which decides whether the entry
 * carries the shell path at all.
 */
function pageSlotIsMountTarget(options: RenderOptions): boolean {
  if (options.route.client) return true
  const rootLayout = (options.layoutFiles ??
    findLayouts(options.config.appPath, options.route.file))[0]
  return Boolean(rootLayout && options.route.clientReferences.some(ref => ref.file === rootLayout))
}

function pageSlotMarkerMode(page: DocumentPage): PageSlotMarkerMode {
  if (!page.clientScript) return 'drop'
  return page.hasClientMounts ? 'materialize' : 'keep'
}

/**
 * The same mode for a streamed tail chunk, which is assembled before the document knows whether it
 * ships a client script. `keep` and `drop` dissolve the slot identically here (only the bootstrap
 * script distinguishes them), so the mount-target question is the whole decision.
 */
function streamPageSlotMode(options: RenderOptions): PageSlotMarkerMode {
  return pageSlotIsMountTarget(options) ? 'materialize' : 'keep'
}

export function clientIslandMarkerBootstrapSource(mode: PageSlotMarkerMode = 'materialize') {
  // Pages that mount nothing on #pnext-page never need the wrapper div: the
  // page's children stay direct children of <body>, matching Next's document
  // structure (tests assert structural selectors like `body > p`). `keep`
  // leaves the comment anchors behind for the router; `drop` removes them.
  const skipPage =
    mode === 'materialize'
      ? ''
      : mode === 'keep'
        ? `if(m[1]==='pnext-page')continue;`
        : `if(m[1]==='pnext-page'){s.remove();let n=s.nextSibling;while(n&&!(n.nodeType===8&&n.data==='/pnext-page'))n=n.nextSibling;if(n)n.remove();continue}`
  // The island's range is collected NON-destructively and, when the parser
  // reparented the markers into different parents (a client `<p>` nested in a
  // server `<p>`, say), by climbing out of the start marker's parent instead of
  // giving up on a sibling-only scan. Mirrors islandMarkerRange in router.ts.
  const range = `let a=[],n=null,y=s;for(;;){n=y.nextSibling;while(!n){const p=y.parentNode;if(!p||p===document.documentElement||p===document)break;y=p;n=y.nextSibling}if(!n)break;if(n.nodeType===8&&n.data==='/'+k)break;a.push(n);y=n}if(!n||n.nodeType!==8||n.data!=='/'+k)continue;const f=a[0];if(f&&f.parentNode!==s.parentNode){f.parentNode.insertBefore(e,f);s.remove()}else{s.replaceWith(e)}for(const x of a)e.append(x);n.remove()`
  // This script runs after the server shell markup and before any client entry can hydrate it.
  // Capture once, then materialize marker ranges. A promotion script that raced ahead keeps its
  // stricter pre-promotion snapshot through the same first-writer-wins guard.
  return `(function(){let W=window;W.__PNEXT_SHELL_HTML__||="<!doctype html>"+document.documentElement.outerHTML;Object.defineProperty(W,"__PNEXT_SHELL_HTML__",{writable:false});(W.__PNEXT_MATERIALIZE_CLIENT_ISLANDS__=r=>{let c=[],w=document.createTreeWalker(r,128);for(;w.nextNode();)c.push(w.currentNode);for(let s of c.reverse()){if(s.data==='$s'||s.data==='/$s'){s.remove();continue}let m=/^(pnext-client(?:-after)?|pnext-static-children|pnext-page):([^>]*)$/.exec(s.data);if(!m||!s.parentNode)continue;${skipPage}let k=m[1]==='pnext-client-after'?'pnext-client':m[1],d=document.createElement('div'),q=k==='pnext-page'?'div':k;d.innerHTML='<'+q+' '+m[2]+'></'+q+'>';let e=d.firstElementChild;if(m[1]==='pnext-client-after'){let a=s.previousSibling;while(a&&!(a.nodeType===8&&!a.data.trim()))a=a.previousSibling;if(!a)continue;let n=a.nextSibling;while(n&&n!==s){let x=n;n=n.nextSibling;e.append(x)}s.replaceWith(e);continue}${range}}})(document)})()`
}

// notFound() thrown inside a streamed Suspense boundary: render the nearest not-found convention
// file in place of the boundary's content, same as the top-level 404 path, but as a plain fragment
// (the document shell already flushed) plus the noindex tag Next always emits.
async function renderStreamNotFoundBoundary(state: StreamState): Promise<string> {
  const body = await renderVNodeToString(
    h(Fragment, null, await streamNotFoundBoundaryTree(state)),
    state,
  )
  return body
}

// The not-found boundary's tree (convention file or built-in fallback) plus the
// noindex tag Next always emits for it. Shared by the out-of-order chunk path
// (stringified) and the in-place suspending path (rendered as vnodes).
async function streamNotFoundBoundaryTree(state: StreamState): Promise<ComponentChildren> {
  const options = state.options
  const file = nearestConventionFile(options, 'not-found.tsx')
  const module = file ? ((await importModule(file, options)) as PageModule) : undefined
  const NotFound = module?.default
  const tree = NotFound
    ? h(NotFound as unknown as ComponentType<Record<string, never>>, {})
    : defaultNotFoundTree()
  return h(Fragment, null, tree, h('meta', { name: 'robots', content: 'noindex' }))
}

function hStreamError(
  error: unknown,
  dev: boolean,
  compatNext: boolean,
  /**
   * The route ships a client entry, so its error runtime
   * (installStreamErrorBoundaries) will escalate this marker itself. The inline
   * fallback below must then NOT be emitted: it fires on DOMContentLoaded and
   * the entry is an `async type="module"` script, so the fallback regularly wins
   * the race and replaces a document the runtime was about to fix up.
   */
  hasClientRuntime = false,
): VNode<any> {
  const resolvedError = resolveThrownError(error, compatNext)
  // Compat: carry the serialized boundary error (redacted message + digest)
  // on the marker so the client error runtime can replace this fallback with
  // the route's error.js boundary (Next renders the nearest error boundary
  // for a server error inside a streamed Suspense hole; its unstable_retry
  // soft-refreshes and recovers). Core keeps the plain generic marker.
  const serialized = compatNext
    ? getRenderExtensions().serializeError({ error: resolvedError, dev })
    : undefined
  // The marker's own content is what stays on screen when nothing escalates it. Dev keeps the
  // diagnostic card there - Next renders the error boundary in dev too, so the marker must be emitted
  // either way; substituting the card for the marker stranded the route's error.js.
  const fallback = dev
    ? genericErrorTree(resolvedError, true, compatNext)
    : ((compatNext
        ? getRenderExtensions().genericErrorTitle({ error: resolvedError, dev })
        : undefined) ?? 'Application error')
  const marker = h(
    'pnext-error',
    {
      'data-pnext-stream-error': true,
      ...(serialized
        ? {
            'data-pnext-error-message': serialized.message,
            ...(serialized.digest ? { 'data-pnext-error-digest': serialized.digest } : {}),
          }
        : {}),
    },
    fallback,
  )
  // A page with no client components ships no error runtime, so nothing can escalate the marker
  // client-side. Emit a self-contained fallback that swaps in the built-in global-error document
  // unless the runtime announces itself (__PNEXT_STREAM_ERROR_RUNTIME__), in which case it owns
  // the marker instead. Dev needs none: its card is already the marker's visible content.
  const fallbackScript =
    !dev && compatNext && !hasClientRuntime ? streamErrorDocumentScript(serialized) : undefined
  if (!fallbackScript) return marker
  return h(
    Fragment,
    null,
    marker,
    h('script', { dangerouslySetInnerHTML: { __html: fallbackScript } }),
  )
}

// Inline bootstrap flushed after a stream-error marker: replaces the document
// with the built-in default global-error UI when no client error runtime is
// installed. The document markup is rendered server-side (sync static tree)
// and embedded as JSON with `<` escaped so `</script>` can't break out.
function streamErrorDocumentScript(
  serialized: { message: string; digest?: string } | undefined,
): string | undefined {
  const defaultUi = getRenderExtensions().defaultGlobalErrorUi(
    (serialized ?? { name: 'Error', message: '' }) as SerializedError,
  )
  if (defaultUi === undefined) return undefined
  // defaultGlobalErrorUi renders a whole <html> document; keep the inner
  // <head>/<body> so it can be assigned to documentElement.innerHTML.
  const documentHtml = renderToString(h(Fragment, null, defaultUi as ComponentChildren))
    .replace(/^<html[^>]*>/, '')
    .replace(/<\/html>$/, '')
  const payload = JSON.stringify(documentHtml).replace(/</g, '\\u003c')
  return (
    '(function(){var swap=function(){' +
    'if(window.__PNEXT_STREAM_ERROR_RUNTIME__)return;' +
    "document.documentElement.id='__next_error__';" +
    `document.documentElement.innerHTML=${payload};};` +
    "if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',swap,{once:true});}" +
    'else{setTimeout(swap,0);}})()'
  )
}

// The shared promotion runtime, installed once and reused by every per-chunk script. It moves a
// streamed chunk's content into its parsed placeholder.
//
// Nested Suspense boundaries can flush their content chunk BEFORE the receiving placeholder has
// parsed, so a missing placeholder parks the id in a pending set rather than dropping the chunk
// (which would lose the content forever and leave the outer boundary promoting an empty
// placeholder). Every successful promotion drains the pending set to a fixed point, and
// DOMContentLoaded flushes stragglers.
//
// The chunk is looked up by stream id rather than DOM position: on a soft navigation the router has
// already materialized the chunks into the parsed document, so `previousElementSibling` would
// resolve to - and delete - whatever innocent node now precedes the script.
const PROMO_RUNTIME =
  'function(){' +
  // Stash the PRE-PROMOTION shell before any streamed chunk has replaced its fallback. The document
  // bootstrap normally wins first; when a fast continuation wins this race instead, retain its
  // stricter pre-promotion copy and let the document bootstrap preserve it.
  //
  // A hard load has no other way back to its static stage: the router seeds its
  // caches from the LIVE document at the load event, by which time every
  // <pnext-suspense> fallback has been promoted away and the document is
  // indistinguishable from a complete static prerender. Recording THAT as the
  // route's static stage would hand a later navigation resolved dynamic content;
  // recording nothing (today) leaves a PPR route with no cached static stage at
  // all after a hard load. See client/router/runtime.ts preHydrationShell.
  'try{window.__PNEXT_SHELL_HTML__="<!doctype html>"+document.documentElement.outerHTML;}catch(e){}' +
  'var P={};' +
  // Group a node's children by the `<!--$ps:k-->…<!--/$ps:k-->` slot markers the
  // renderer emits around each slot of a slot-granular boundary.
  'function S(r){var m={},c=[].slice.call(r.childNodes),cur=null;' +
  'for(var x=0;x<c.length;x++){var d=c[x];' +
  'if(d.nodeType===8){var mm=/^\\$ps:(\\d+)$/.exec(d.data);if(mm){cur=m[mm[1]]=[];continue}' +
  'if(/^\\/\\$ps:\\d+$/.test(d.data)){cur=null;continue}}' +
  'if(cur)cur.push(d);}return m}' +
  'function tryPromote(i){' +
  "var t=document.querySelector('[data-pnext-stream=\"'+i+'\"]');" +
  'if(!t){delete P[i];return true;}' +
  "var e=document.querySelector('pnext-suspense[data-pnext-suspense=\"'+i+'\"]');" +
  'if(!e){P[i]=1;return false;}' +
  // A boundary inside a client island: this promotion rewrites DOM the island's mounted
  // preact tree adopted at hydration, which still names the fallback. Mark the root so the
  // next graft rebuilds it instead of diffing against a node that has left the document.
  'var ci=e.closest?e.closest("pnext-client[data-pnext-client]"):null;if(ci)ci.__pnextStreamGrafted=1;' +
  'var f=document.createDocumentFragment();' +
  // Slot-granular chunk: weave the shell template's build-time slots and the
  // chunk's request-time slots back into their original order, so a static
  // sibling inside a postponed boundary keeps its BUILD-TIME nodes.
  'var tpl=e.querySelector(\'template[data-pnext-static="\'+i+\'"]\'),o=t.getAttribute("data-pnext-slots");' +
  'if(tpl&&o!=null){' +
  'var st=S(tpl.content),dy=S(t),n=+tpl.getAttribute("data-pnext-slot-count");' +
  // The template holds EVERY slot's skeleton (prefetch responses assert on those
  // bytes), so its data-pnext-slots list — not mere presence — decides which
  // ones are final; the rest come from the chunk.
  'var fin=","+tpl.getAttribute("data-pnext-slots")+",";' +
  'for(var k=0;k<n;k++){var g=fin.indexOf(","+k+",")>=0?st[k]:dy[k];' +
  'if(g)for(var q=0;q<g.length;q++)f.appendChild(g[q]);}' +
  '}else{while(t.firstChild)f.appendChild(t.firstChild);}' +
  'e.replaceWith(f);t.remove();delete P[i];return true;' +
  '}' +
  'function drain(){var changed=true;while(changed){changed=false;var k=Object.keys(P);for(var j=0;j<k.length;j++){if(P[k[j]]&&tryPromote(k[j]))changed=true;}}}' +
  'if(document.addEventListener)document.addEventListener("DOMContentLoaded",drain);' +
  'return function(i){' +
  'var ok=tryPromote(i);' +
  'window.__PNEXT_MATERIALIZE_CLIENT_ISLANDS__&&window.__PNEXT_MATERIALIZE_CLIENT_ISLANDS__(document);' +
  'window.__PNEXT_MOUNT_ISLANDS__&&window.__PNEXT_MOUNT_ISLANDS__();' +
  'if(ok)drain();' +
  '};' +
  '}'

function suspenseReplaceScript(id: string) {
  return `(function(){(window.__PNEXT_PROMO__=window.__PNEXT_PROMO__||(${PROMO_RUNTIME})())(${JSON.stringify(id)});var s=document.currentScript;if(s)s.remove();}())`
}

function iconInsertionScript() {
  return `<script>document.querySelectorAll('body link[rel="icon"], body link[rel="apple-touch-icon"]').forEach(el => document.head.appendChild(el))</script>`
}

async function applyLayouts(
  options: RenderOptions,
  children: ComponentChildren,
): Promise<LayoutRender> {
  const profile = renderProfile(options)
  let tree = children
  const metadata: MetadataEntry[] = []
  let runtimeMetadata = false
  let metadataMissedFlush = false
  const viewport: Viewport[] = []
  const layoutProps = createPageProps(options)
  const layouts: LoadedLayout[] = []
  // Cheap leaf span for the page (leaf) segment-module resolution, nested under
  // the render-body span alongside the per-layout segment spans below.
  getRenderSpanExtensions().emitResolveSegmentSpan('__PAGE__')

  // A segment's template.* wraps that segment's children, nested inside its
  // layout (layout > template > children). Slots (@name dirs) become props on
  // the layout of the directory that holds them.
  const templateByDir = new Map(
    (options.route.templateFiles ?? []).map(file => [dirname(file), file] as const),
  )
  const slotContext = createSlotContext(options, {
    importModule,
    markServerReference,
    clientReferenceStub,
    createPageProps,
  })

  // Compat's useSelectedLayoutSegment(s) reads a per-layout scope carrying the
  // URL segments below that layout. Groups appear as literal `(group)` entries,
  // a catch-all as one joined string. Gated on next-compat so pure-core renders
  // are byte-identical (no scope wrapping).
  const withSegments = nextCompatEnabled(options.config)
  const allSegments = withSegments
    ? fullLayoutSegments(options.config.appPath, dirname(options.route.file), options.params ?? {})
    : []
  const segmentScoped = <Props extends ServerVNodeProps>(
    layoutFile: string,
    component: ServerComponent<Props> | undefined,
  ): ServerComponent<Props> | undefined => {
    if (!withSegments || !component) return component
    const layoutDir = dirname(layoutFile)
    const below = allSegments.slice(layoutSegmentDepth(options.config.appPath, layoutDir))
    const scoped: ServerComponent<Props> = props =>
      runInLayoutSegmentScope(below, () => component(props), {
        appPath: options.config.appPath,
        layoutDir,
        slots: slotContext.stateOut,
      })
    return markServerReference(scoped)
  }

  // A `'use client'` layout is an island: it never runs inside a server-side
  // segment scope, so its useSelectedLayoutSegment(s) can't read the live scope.
  // Precompute the snapshot for its own directory and stamp it onto the island
  // props (the same shape currentLayoutSegmentSnapshot produces for a server
  // layout), so the island renders and hydrates with the correct segments.
  const layoutSnapshotFor = (layoutFile: string): LayoutSegmentSnapshot | undefined => {
    if (!withSegments) return undefined
    const layoutDir = dirname(layoutFile)
    const below = allSegments.slice(layoutSegmentDepth(options.config.appPath, layoutDir))
    return runInLayoutSegmentScope(below, () => currentLayoutSegmentSnapshot(), {
      appPath: options.config.appPath,
      layoutDir,
      slots: slotContext.stateOut,
    })
  }

  // Each layout receives only the params introduced AT or ABOVE its directory
  // (Next scopes params per layout level). Gated on next-compat so pure-core
  // layouts keep receiving the full param set.
  const layoutPropsFor = (layoutFile: string): PageProps => {
    if (!withSegments) return layoutProps
    // Sub-shell (Stage C.2): a layout at/above a CONCRETE param renders it
    // buildtime; a layout at/above an unfilled param must hang so its boundary
    // postpones. Slice the concrete-prefix params per the layout's dir depth and
    // wrap in the sub-shell proxy so an unfilled key read throws PostponeError.
    if (options.fallbackConcreteParams) {
      const scoped = layoutParamsForDir(
        options.config.appPath,
        dirname(layoutFile),
        options.fallbackConcreteParams,
      )
      return {
        ...layoutProps,
        params: Promise.resolve(
          subShellParamsProxy(scoped, options.fallbackParamKeys ?? Object.keys(scoped)),
        ),
      }
    }
    // Base fallback shell (all params hang): a layout that awaits params must
    // postpone its boundary too (not read an empty object). Reuse the page-level
    // hanging params promise so the whole shell is param-independent.
    if (options.fallbackParams) return { ...layoutProps, params: hangingPromise('params') }
    // The scoped params go through the vary-tracking extension under the LAYOUT
    // segment kind: compat keys the layout's cache frame on the params this
    // layout reads, independently of the page's own set. Outside a tracking
    // scope the extension is the identity, so ordinary renders pay nothing (see
    // compat/segment/vary-params.ts).
    const scopedParams = getRenderExtensions().trackVaryParams(
      layoutParamsForDir(options.config.appPath, dirname(layoutFile), options.params ?? {}),
      { kind: 'params', segment: 'layout' },
    )
    return {
      ...layoutProps,
      params: legacySyncProps(Promise.resolve(scopedParams), 'params', scopedParams),
    }
  }

  await profileRenderStep(profile, 'import layouts', async () => {
    for (const layoutPath of options.layoutFiles ??
      findLayouts(options.config.appPath, options.route.file)) {
      if (!options.moduleLoader && !existsSync(layoutPath)) continue
      const layoutModule = (await importModule(layoutPath, options)) as LayoutModule
      markServerReference(layoutModule.default)
      // Cheap leaf span for the segment-module resolution (nested under the
      // render-body span). Root layout dir == appPath has no segment label.
      {
        const layoutDir = dirname(layoutPath)
        if (layoutDir !== options.config.appPath) {
          getRenderSpanExtensions().emitResolveSegmentSpan(basename(layoutDir))
        }
      }
      const metadataExtensions = getActiveMetadataExtensions(options.config)
      const layoutModuleRecord = layoutModule as Record<string, unknown>
      runtimeMetadata ||= Boolean(metadataExtensions.hasRuntimeMetadata?.(layoutModuleRecord))
      const prebuiltLayoutMetadata = options.staticModuleMetadata?.[layoutPath]
      const layoutMetadataPromise = readRenderModuleMetadata(
        options,
        layoutModuleRecord,
        layoutProps,
        mergeMetadataEntries(metadata),
        layoutPath,
        prebuiltLayoutMetadata?.metadata,
      )
      // Same head-vs-body race the page metadata runs (see renderTreeInFrame): a layout's slow
      // generateMetadata streams into the body too (metadata-streaming-parallel-routes).
      metadataMissedFlush ||= !(await settlesBeforeFlush(layoutMetadataPromise))
      const layoutMetadata = await layoutMetadataPromise
      if (layoutMetadata) {
        const dir = dirname(layoutPath)
        metadata.push({
          metadata: layoutMetadata,
          dir,
          kind: 'layout',
          root: dir === options.config.appPath,
        })
      }
      const layoutViewport = metadataExtensions.readModuleViewport
        ? await metadataExtensions.readModuleViewport(layoutModuleRecord, layoutProps)
        : prebuiltLayoutMetadata?.viewport
          ? prebuiltLayoutMetadata.viewport
          : await readModuleViewport(layoutModule)
      if (layoutViewport) viewport.push(layoutViewport)
      layouts.push({ file: layoutPath, module: layoutModule })
    }
  })

  // loading.js Suspense boundaries, assigned to their nearest enclosing layout
  // dir. Applied to a layout's CHILDREN before the layout wraps them, so a slow
  // layout postpones at the parent's boundary and shows the fallback.
  const loadingBoundariesByLayoutDir = await buildLoadingBoundaries(
    options,
    layouts.map(layout => dirname(layout.file)),
  )
  // A loading boundary that has ANOTHER loading boundary deeper in the tree resolves THROUGH in the
  // streaming shell: the shell shows the DEEPEST loading fallback, with all layouts above it awaited
  // into the shell. See streamSuspenseBoundary.
  const loadingDirsWithFallback = [...loadingBoundariesByLayoutDir.keys()]
  const hasDeeperLoading = (layoutDir: string) =>
    loadingDirsWithFallback.some(dir => dir !== layoutDir && dir.startsWith(`${layoutDir}${sep}`))
  const applyLoadingBoundaries = (
    layoutDir: string,
    node: ComponentChildren,
  ): ComponentChildren => {
    const fallbacks = loadingBoundariesByLayoutDir.get(layoutDir)
    if (!fallbacks) return node
    // The deepest-fallback shortcut is for navigation/prefetch shells only. A
    // full document stream must emit every loading boundary's fallback like
    // Next (app/index "should render loading.js in initial html for slow layout
    // and page").
    const through = Boolean(options.nav || options.prefetchShell) && hasDeeperLoading(layoutDir)
    let wrapped = node
    for (const { fallback, loadingDir } of fallbacks) {
      // A loading boundary re-arms only when the segment it directly guards changes. On a soft nav
      // that stays within this boundary's subtree - divergence DEEPER than the guarded segment, so
      // that segment is a preserved shared ancestor - the boundary stays resolved and paints no
      // fallback. Skip wrapping so a shared-ancestor loading.tsx does not flash.
      if (softNavPreservesLoadingBoundary(options, loadingDir, documentDir)) continue
      // The guarded child segment's index, carried to the client on the
      // streamed marker: a shell painted for a navigation whose divergence is
      // deeper than this belongs to a preserved ancestor and must not repaint
      // (see showLoadingShell). Only meaningful relative to the document dir.
      const depth = urlDepthOf(documentDir, loadingDir)
      wrapped = h(
        Suspense,
        {
          fallback: markInlineLoadingFallback(fallback, depth),
          ...(through ? { [LOADING_THROUGH_PROP]: true } : {}),
          ...(depth === undefined ? {} : { [LOADING_DEPTH_PROP]: depth }),
        },
        wrapped,
      )
    }
    return wrapped
  }

  // A layout is the DOCUMENT layout (owns `<html>`/`<body>`). Keep existing
  // behavior when the app provides `app/layout.*`, but when that file is missing,
  // detect the nearest route-level layout that actually renders `<html>`/`<body>`.
  const documentLayout = layouts[0]
  const rootLayoutDefault = documentLayout?.module.default
  const documentLayoutFile = documentLayout && rootLayoutDefault ? documentLayout.file : undefined
  // Compose nested segments leaf->root. A segment may ship a `template.*` with
  // no `layout.*` (e.g. app/template/*), so iterate the union of layout and
  // template dirs — not layouts alone — or those templates never render. The
  // document (root) layout dir is composed separately below.
  const layoutByDir = new Map(layouts.map(layout => [dirname(layout.file), layout] as const))
  const documentDir = documentLayoutFile ? dirname(documentLayoutFile) : undefined
  const nestedDirs = [...new Set([...layoutByDir.keys(), ...templateByDir.keys()])]
    .filter(dir => dir !== documentDir)
    .sort((a, b) => b.length - a.length) // deepest first (leaf -> root)
  // Shared-layout retention only applies where the client's segment graft can
  // land: a server layout nested under a CLIENT layout (or client root layout)
  // lives inside an island whose children re-render from the incoming
  // document, so its live DOM cannot be retained — never skip those.
  const rootIsClientLayout = Boolean(
    documentLayoutFile &&
    ((rootLayoutDefault as ClientComponent | undefined)?.[clientReferenceSymbol] ||
      options.route.clientReferences.some(reference => reference.file === documentLayoutFile)),
  )
  const clientLayoutDirs = new Set<string>()
  for (const nestedDir of nestedDirs) {
    const nestedLayout = layoutByDir.get(nestedDir)
    if (nestedLayout && conventionDefaultReference(options, nestedLayout.file)) {
      clientLayoutDirs.add(nestedDir)
    }
  }
  const underClientLayout = (dir: string) =>
    rootIsClientLayout ||
    [...clientLayoutDirs].some(
      clientDir => dir !== clientDir && dir.startsWith(`${clientDir}${sep}`),
    )
  for (const dir of nestedDirs) {
    const layout = layoutByDir.get(dir)
    if (!layout) {
      // Template-only segment: wrap children in the template (island-aware),
      // with no layout or parallel-route slots at this dir.
      tree = await wrapInTemplate(
        options,
        templateByDir.get(dir),
        applyLoadingBoundaries(dir, tree),
      )
      continue
    }
    const { file, module } = layout
    // Shared-layout retention: on a soft navigation whose previous and target children paths both
    // live under this layout's URL prefix, the layout instance is shared and only the segments below
    // the divergence point re-render. Skip executing the layout component (no data refetch, no side
    // effects) and emit only its segment marker, tagged data-pnext-skip so the client grafts its
    // live layout DOM over it.
    const clientLayoutRef = conventionDefaultReference(options, file)
    if (
      !clientLayoutRef &&
      !underClientLayout(dir) &&
      slotDirectoriesIn(dir).length === 0 &&
      sharedSoftNavLayoutDir(options, dir, documentDir)
    ) {
      const scope = segmentScopeFor(options, dir)
      tree = h(
        'pnext-layout',
        {
          'data-pnext-segment': segmentIdentityToken(file),
          'data-pnext-skip': '',
          ...(scope !== undefined ? { 'data-pnext-scope': scope } : {}),
          style: { display: 'contents' },
        } as never,
        (await wrapInTemplate(
          options,
          templateByDir.get(dir),
          applyLoadingBoundaries(dir, tree),
        )) as never,
      )
      continue
    }
    // A nested `'use client'` segment layout must become an island: the module
    // loaded from the server bundle carries no clientReferenceSymbol, so
    // resolveServerTree would server-invoke it (no hooks dispatcher, `r.__H`
    // throws) and no pnext-client host would ever hydrate. Substituting the
    // route's scanned client reference routes it through ClientIsland instead.
    const layoutComponent = clientLayoutRef
      ? (clientReferenceStub(clientLayoutRef) as unknown as ServerComponent<{
          children: ComponentChildren
        }>)
      : segmentScoped(file, module.default)
    // Island props must serialize; `request` never does (and Next passes no
    // request to layouts anyway), so drop it for a client layout.
    const props = layoutPropsFor(file)
    if (clientLayoutRef) {
      delete (props as unknown as Record<string, unknown>).request
      const snapshot = layoutSnapshotFor(file)
      if (snapshot) (props as unknown as Record<string, unknown>)[LAYOUT_SCOPE_PROP] = snapshot
    }
    tree = await wrapSegment(
      options,
      file,
      layoutComponent,
      applyLoadingBoundaries(dir, tree),
      props,
      templateByDir,
      slotContext,
    )
  }

  if (documentLayout && rootLayoutDefault) {
    const rootFile = documentLayout.file
    const rootComponent = segmentScoped(rootFile, rootLayoutDefault)
    const rootLayoutProps = layoutPropsFor(rootFile)
    // A `'use client'` root layout is re-rendered whole on the client (the
    // client shell in entry.ts wraps the page in it). Its parallel-route slot
    // props are server-rendered subtrees that can't serialize, so mark each
    // slot's SSR DOM with a `pnext-slot` wrapper; the client adopts that DOM as
    // the named prop instead of losing it. Server root layouts never re-render
    // client-side, so they keep their bare slot markup.
    const rootIsClient =
      Boolean((rootLayoutDefault as ClientComponent)[clientReferenceSymbol]) ||
      options.route.clientReferences.some(reference => reference.file === rootFile)
    tree = await profileRenderStep(profile, 'invoke root layout', async () => {
      const slotProps = await renderDirSlots(slotContext, dirname(rootFile))
      const wrapped = await wrapInTemplate(
        options,
        templateByDir.get(dirname(rootFile)),
        applyLoadingBoundaries(dirname(rootFile), tree),
      )
      const { children, slots } = childrenFromSlots(slotProps, wrapped)
      const rootProps: ServerVNodeProps = {
        ...rootLayoutProps,
        ...(rootIsClient ? markClientRootSlots(slots) : slots),
        children,
      }
      if (rootIsClient) {
        return invokeClientRootLayout(
          rootComponent as unknown as (props: ServerVNodeProps) => unknown,
          rootProps,
        )
      }
      return componentChildren(
        invokeServerComponentWithUse(rootComponent as ServerComponent<ServerVNodeProps>, rootProps),
      )
    })
  }

  return {
    tree,
    metadata,
    runtimeMetadata,
    metadataMissedFlush,
    slotMatches: slotContext.matches,
    viewport,
    documentLayoutFile,
  }
}

// Wrap each parallel-route slot subtree passed to a CLIENT root layout in a
// `pnext-slot` marker (display:contents, byte-neutral) so the client shell can
// locate each slot's SSR DOM and adopt it as the named prop — server-rendered
// subtrees don't survive prop serialization. Keyed by slot name (nav, auth, …).
function markClientRootSlots(
  slotProps: Record<string, ComponentChildren>,
): Record<string, ComponentChildren> {
  const marked: Record<string, ComponentChildren> = {}
  for (const [name, value] of Object.entries(slotProps)) {
    marked[name] = h(
      'pnext-slot',
      { 'data-pnext-slot': name, style: { display: 'contents' } },
      value,
    )
  }
  return marked
}

// Wraps a segment's children in its template (if any) then its layout (if any),
// passing parallel-route slots as extra layout props. Segments without a layout
// still apply a template so `layout > template > children` holds either way.
async function wrapSegment(
  options: RenderOptions,
  layoutFile: string,
  component: ServerComponent<{ children: ComponentChildren }> | undefined,
  tree: ComponentChildren,
  layoutProps: PageProps,
  templateByDir: Map<string, string>,
  slotContext: SlotContext<RenderOptions>,
): Promise<ComponentChildren> {
  const dir = dirname(layoutFile)
  const wrapped = await wrapInTemplate(options, templateByDir.get(dir), tree)
  if (!component) return wrapped
  const slotProps = await renderDirSlots(slotContext, dir)
  const { children, slots } = childrenFromSlots(slotProps, wrapped)
  const segment = h(component as ComponentType<ServerVNodeProps>, {
    ...layoutProps,
    ...slots,
    children,
  })
  return (component as ClientComponent)[clientReferenceSymbol]
    ? segment
    : serverSegment(layoutFile, segment, segmentScopeFor(options, dir))
}

// An explicit `@children` parallel-route slot directory is Next's way to supply
// the layout's `children` prop directly (rather than via implicit segment
// matching). renderDirSlots surfaces it as a `children` slot prop; when present
// it takes precedence over the segment-matched `wrapped` children. All other
// slots pass through untouched.
function childrenFromSlots(
  slotProps: Record<string, ComponentChildren>,
  wrapped: ComponentChildren,
): { children: ComponentChildren; slots: Record<string, ComponentChildren> } {
  if (!('children' in slotProps)) return { children: wrapped, slots: slotProps }
  const { children, ...slots } = slotProps
  return { children: children ?? wrapped, slots }
}

async function wrapInTemplate(
  options: RenderOptions,
  templateFile: string | undefined,
  tree: ComponentChildren,
): Promise<ComponentChildren> {
  if (!templateFile) return tree
  // A `'use client'` template must become an island (same reasoning as a client
  // layout above): server-invoking it would run hooks with no dispatcher, and
  // it would never hydrate. Route it through ClientIsland via its scanned ref.
  const clientTemplateRef = conventionDefaultReference(options, templateFile)
  if (clientTemplateRef) {
    const Template = clientReferenceStub(clientTemplateRef)
    return h(
      Template as ComponentType<ServerVNodeProps>,
      {
        children: tree,
        [TEMPLATE_MARKER_PROP]: true,
      } as ServerVNodeProps,
    )
  }
  const module = (await importModule(templateFile, options)) as LayoutModule
  const Template = markServerReference(module.default)
  if (!Template) return tree
  return serverSegment(
    templateFile,
    h(Template as ComponentType<ServerVNodeProps>, { children: tree }),
    segmentScopeFor(options, dirname(templateFile)),
  )
}

// A loading boundary at `layoutDir` guards the child segment directly below it. On a soft nav it
// must NOT re-arm when that guarded segment is unchanged - the divergence between the previous and
// target children paths is STRICTLY deeper than the boundary's URL depth, so a closer boundary (or
// none) owns the change. Mirrors sharedSoftNavLayoutDir's soft-nav guards so it only fires where a
// preserved shared-layout graft keeps the boundary's subtree alive on the client.
function softNavPreservesLoadingBoundary(
  options: RenderOptions,
  layoutDir: string,
  documentDir: string | undefined,
): boolean {
  const nav = options.nav
  if (!nav?.soft || !documentDir) return false
  if (options.request?.headers.has('x-pnext-full-render')) return false
  const previous = nav.state?.children
  if (!previous) return false
  if (nav.state?.slots && Object.keys(nav.state.slots).length > 0) return false
  const target = nav.childrenPath ?? options.url.pathname
  const previousSegments = previous.split('/').filter(Boolean)
  const targetSegments = target.split('/').filter(Boolean)
  // Same children path = refresh or search-param-only nav: fresh data expected.
  if (previousSegments.join('/') === targetSegments.join('/')) return false
  // URL depth of the boundary's layout dir (group `(…)` and parallel `@…` dirs
  // own no URL segment). The boundary guards the child segment at this index.
  const depth = urlDepthOf(documentDir, layoutDir)
  if (depth === undefined) return false
  // First index where the previous and target paths diverge.
  let divergence = 0
  const shared = Math.min(previousSegments.length, targetSegments.length)
  while (divergence < shared && previousSegments[divergence] === targetSegments[divergence]) {
    divergence++
  }
  // Preserved when the change is deeper than the segment this boundary guards.
  return divergence > depth
}

/**
 * URL depth of `dir` under the document layout dir - the number of segments it owns in the URL
 * (group `(...)` and parallel `@...` dirs own none). Undefined when either dir is unknown or `dir`
 * lives outside the document layout.
 */
function urlDepthOf(documentDir: string | undefined, dir: string): number | undefined {
  if (!documentDir) return undefined
  const rel = relative(documentDir, dir)
  if (rel.startsWith('..')) return undefined
  return rel.split(sep).filter(part => part && !/^\(.*\)$/.test(part) && !part.startsWith('@'))
    .length
}

/**
 * True when a FULL segment prefetch would retain a shared layout, so the prebuilt PPR shell must not
 * answer it. A prebuilt shell is the whole document, shared layout included; serving it for a
 * prefetch whose nav state says that layout stays mounted sends the ORIGIN page's markup back to a
 * client that already has it. A live render instead emits the layout as a `data-pnext-skip` marker.
 *
 * Scoped to full prefetches: a default/partial prefetch is answered from static data by contract,
 * and a document soft nav keeps resuming the shell so its cached work does not re-run.
 */
function fullSegmentPrefetchSkipsSharedLayout(options: RenderOptions): boolean {
  const headers = options.request?.headers
  if (headers?.get('x-pnext-segment-render') !== '1') return false
  if (headers.get('next-router-prefetch') === '1') return false
  const layoutFiles = findConventionFiles(
    options.config.appPath,
    options.route.file,
    'layout.tsx',
  ).filter(file => existsSync(file))
  const documentDir = layoutFiles[0] ? dirname(layoutFiles[0]) : undefined
  return layoutFiles
    .slice(1)
    .some(file => sharedSoftNavLayoutDir(options, dirname(file), documentDir))
}

/**
 * True when a soft navigation shares this layout dir between its previous and target children paths,
 * so the layout instance is retained and must not re-execute. Conservative gates: request-time soft
 * nav only, a real path change, and no parallel-route slots in the previous state (the client skips
 * segment grafting when slot state shifts).
 */
function sharedSoftNavLayoutDir(
  options: RenderOptions,
  dir: string,
  documentDir: string | undefined,
): boolean {
  const nav = options.nav
  if (!nav?.soft || !documentDir) return false
  // The client asks for a full render when its live DOM cannot host a graft.
  if (options.request?.headers.has('x-pnext-full-render')) return false
  const previous = nav.state?.children
  if (!previous) return false
  if (nav.state?.slots && Object.keys(nav.state.slots).length > 0) return false
  const target = nav.childrenPath ?? options.url.pathname
  const previousSegments = previous.split('/').filter(Boolean)
  const targetSegments = target.split('/').filter(Boolean)
  // Same children path = refresh or search-param-only nav: fresh data expected.
  if (previousSegments.join('/') === targetSegments.join('/')) return false
  const rel = relative(documentDir, dir)
  if (!rel || rel.startsWith('..')) return false
  // URL depth of the layout dir: group `(…)` and parallel `@…` dirs own no
  // URL segment.
  const depth = rel
    .split(sep)
    .filter(part => part && !/^\(.*\)$/.test(part) && !part.startsWith('@')).length
  if (depth <= 0) return false
  if (previousSegments.length < depth || targetSegments.length < depth) return false
  for (let index = 0; index < depth; index++) {
    if (previousSegments[index] !== targetSegments[index]) return false
  }
  return true
}

// `data-pnext-segment` is an opaque per-layout identity marker (the client only tests two renders of
// the SAME layout file for equality). Emitting the raw filesystem path leaked literal `[param]`
// bracket directory names into response bodies, which Next's assertNoEncodedDynamicPlaceholders
// rejects. A stable content hash keeps the identity while staying bracket-free.
function segmentIdentityToken(file: string): string {
  return createHash('sha256').update(file).digest('hex').slice(0, 16)
}

function serverSegment(file: string, children: ComponentChildren, scope?: string) {
  return h(
    'pnext-layout',
    {
      'data-pnext-segment': segmentIdentityToken(file),
      ...(scope !== undefined ? { 'data-pnext-scope': scope } : {}),
      style: { display: 'contents' },
    },
    children,
  )
}

/**
 * The concrete URL-prefix a segment renders for (its dir's URL depth applied to
 * the children path). Stamped as `data-pnext-scope` so the client soft-nav
 * graft can tell two renders of the SAME layout file apart when they render for
 * different dynamic params (e.g. `[category]` as /electronics vs /clothing).
 */
function segmentScopeFor(options: RenderOptions, dir: string): string | undefined {
  const base = options.config.appPath
  if (!base) return undefined
  const rel = relative(base, dir)
  if (rel.startsWith('..')) return undefined
  const depth = rel
    .split(sep)
    .filter(part => part && !/^\(.*\)$/.test(part) && !part.startsWith('@')).length
  if (depth <= 0) return undefined
  const target = options.nav?.childrenPath ?? options.url.pathname
  const segments = target.split('/').filter(Boolean)
  return segments.slice(0, Math.min(depth, segments.length)).join('/')
}

function componentChildren(value: ServerComponentResult): ComponentChildren {
  return value === undefined ? undefined : value
}

// data-pnext-dev tells the soft-navigation runtime to skip this script on
// body swaps — the current document already holds an open event stream.
function devReloadScript(nonce?: string) {
  // css-update swaps every same-origin stylesheet for a cache-busted copy and
  // drops the old one once the new one has loaded, so the page never flashes
  // unstyled and never loses client state. Anything the server could not prove
  // was CSS-only still arrives as `reload`.
  const nonceAttribute = nonce ? ` nonce="${escapeHtml(nonce)}"` : ''
  return `<script${nonceAttribute} data-pnext-dev>
let events;
let generation;
// The stream is a long-lived connection counted against the browser's per-origin
// socket cap (6 on HTTP/1.1). A page the browser keeps alive after navigating away
// (bfcache) holds its own open, so every page load would leak one until the pool is
// exhausted and further requests stall for minutes. Close on the way out, reopen on
// restore.
function connectDevEvents() {
  events = new EventSource('/__pnext/events');
  // The server stamps its build generation on connect: a page restored onto a
  // generation it never saw missed a rebuild while it was disconnected.
  events.addEventListener('ready', event => {
    if (generation !== undefined && event.data !== generation) return location.reload();
    generation = event.data;
  });
  events.addEventListener('reload', () => location.reload());
  events.addEventListener('css-update', event => {
    const links = [...document.querySelectorAll('link[rel=stylesheet]')].filter(link => {
      try { return new URL(link.href, location.href).origin === location.origin; } catch { return false; }
    });
    if (links.length === 0) { location.reload(); return; }
    for (const link of links) {
      const url = new URL(link.href, location.href);
      url.searchParams.set('__pnext_css', event.data);
      const next = link.cloneNode();
      // React tracks precedence-carrying links as its own; the swap is ours.
      next.removeAttribute('data-precedence');
      next.href = url.href;
      const drop = () => link.remove();
      next.addEventListener('load', drop, { once: true });
      next.addEventListener('error', drop, { once: true });
      link.after(next);
    }
  });
}
connectDevEvents();
addEventListener('pagehide', () => events.close());
addEventListener('pageshow', event => { if (event.persisted) connectDevEvents(); });
</script>`
}
