// Core extension-point registry (CORE - imports ZERO compat).
//
// Core exposes a small set of mutable registries with working NO-OP defaults so a pure-core app (no
// next/* imports, no compat in pnext.config) runs unchanged. The compat layer populates them at the
// composition root through the single gated dynamic-import seam in compat-bootstrap.ts.
//
// The dependency edge is inverted: core NEVER imports compat. Instead compat imports core and
// registers its behavior here. Types stay intentionally structural (plain function shapes,
// `unknown` payloads) so core carries no type dependency on any compat module.

import type { OnLoadResult, Plugin } from 'esbuild'
import type { CompatAliasTarget, ResolvedConfig } from './config'
import type { StaticMetadataFile } from './routing/metadata-files'
import type { BuildManifest, ClientEntryReason, RouteManifestEntry, RouteParamValue } from './types'
import type { VerboseLogger } from './utils/verbose'
import { escapeRegex } from './utils/code'

// `Bun` through globalThis: pnext ships TypeScript source, so app compilers without
// bun-types typecheck this file and a bare `Bun` identifier would fail them.
const { Bun: bun } = globalThis as unknown as {
  Bun: { hash(input: string | ArrayBufferView): { toString(radix?: number): string } }
}

/** Per-build wiring for the server plugin chain. */
export interface ServerEsbuildPluginOptions {
  /**
   * Vendor react-server pass only: stub a `'use client'` file as a client
   * reference. Composed into the chain's single claiming onLoad, so the scan
   * costs no extra plugin-callback round trips.
   */
  vendorClientBoundary?: (file: string) => Promise<OnLoadResult | undefined>
  /**
   * The build's entries are realpath-resolved before esbuild sees them (the vendor chains), so
   * workspace-link symlinks alone cannot put a symlinked importer in the graph - the symlink-import plugin
   * may skip registration.
   */
  realPathEntries?: boolean
}

// The extension host - ONE instance owning every domain registry below. A normal process runs on the
// module-level default host, and the getX()/setX()/register* surface reads it, so core consumers
// never see the host at all. Anything serving more than one app in one process (the test suite, an
// embedder) creates an isolated host and swaps it in, so registrations cannot leak between apps.

export interface ExtensionHost {
  compatMode: CompatModeExtensions
  render: RenderExtensions
  request: RequestExtensions
  runtime: RuntimeExtensions
  build: BuildExtensions
  routing: RoutingExtensions
  proxy: ProxyExtensions
  proxyResponse: ProxyResponseProtocol
  routerProtocol: RouterProtocolExtensions
  bundler: BundlerExtensions
  importAlias: ImportAliasExtensions
  asset: AssetExtensions
  /** Import-only loadable extensions; page extensions live on `routing`. */
  loadable: string[]
  /** Memoized union of the server-transform chain's sniff tokens. */
  serverSniff?: { pattern: RegExp | undefined }
}

export function createExtensionHost(): ExtensionHost {
  return {
    compatMode: createCompatModeExtensions(),
    render: createRenderExtensions(),
    request: createRequestExtensions(),
    runtime: createRuntimeExtensions(),
    build: createBuildExtensions(),
    routing: createRoutingExtensions(),
    proxy: createProxyExtensions(),
    proxyResponse: createProxyResponseProtocol(),
    routerProtocol: createRouterProtocolExtensions(),
    bundler: createBundlerExtensions(),
    importAlias: createImportAliasExtensions(),
    asset: createAssetExtensions(),
    loadable: [],
  }
}

let activeHost = createExtensionHost()

/** The host every accessor in this module reads. */
export function getExtensionHost(): ExtensionHost {
  return activeHost
}

// Registration guards that live OUTSIDE any host — compat-bootstrap's promises,
// each register-* module's `registered` flag — must clear when the host is
// swapped, or the fresh host is left permanently empty. Module-global on
// purpose: the guards they clear are module-global too.
const resetHandlers: (() => void)[] = []

// The detectors are regex sweeps over whole sources, and a route's layout chain is re-detected for
// every route below it. The answer depends only on the source and the registered detector set, so
// memoize on exactly that. Cleared whenever a detector registers.
const clientEntryReasonCache = new Map<string, ClientEntryReason[]>()

/** Run `handler` whenever the active host is swapped. */
export function onExtensionHostReset(handler: () => void): void {
  resetHandlers.push(handler)
}

/**
 * Tie a registry that lives outside the host (render/hooks, the CSS extras below) to the host's
 * lifetime: compat populates it exactly like the host's own registries, so it must return to its
 * core defaults with them. Restored in place rather than replaced - consumers may hold the object.
 */
export function restoreWithExtensionHost<T extends object>(registry: T): void {
  const defaults = { ...registry }
  onExtensionHostReset(() => {
    for (const key of Object.keys(registry)) delete (registry as Record<string, unknown>)[key]
    Object.assign(registry, defaults)
  })
}

/** Install `host` as the active one; the returned function restores the previous. */
export function setActiveHost(host: ExtensionHost): () => void {
  const previous = activeHost
  activeHost = host
  announceHostChange()
  return () => {
    activeHost = previous
    announceHostChange()
  }
}

/** Swap in a fresh host, dropping every registration on the current one. */
export function resetExtensionHost(): ExtensionHost {
  const host = createExtensionHost()
  setActiveHost(host)
  return host
}

/** Run `callback` against `host`, restoring the previous host afterwards. */
export function withExtensionHost<T>(host: ExtensionHost, callback: () => T): T {
  const restore = setActiveHost(host)
  try {
    const result = callback()
    if (isThenable(result)) return Promise.resolve(result).finally(restore) as T
    restore()
    return result
  } catch (error) {
    restore()
    throw error
  }
}

function announceHostChange() {
  for (const handler of resetHandlers) handler()
  // Consumers latch the loadable-extension set (the server load plugin's filter
  // regex); a swap changes it, so invalidate exactly as a registration would.
  for (const listener of loadableExtensionListeners) listener()
  // Memoized detector answers belong to the host that registered the detectors.
  clientEntryReasonCache.clear()
}

// ---------------------------------------------------------------------------
// Compat mode extensions — populated by compat/aliases.
// ---------------------------------------------------------------------------

export interface ReactCompilerOptions {
  target: string
}

export interface CompatModeExtensions {
  nextEnabled: (config: ResolvedConfig) => boolean
  reactEnabled: (config: ResolvedConfig) => boolean
  reactCompilerOptions: (config: ResolvedConfig) => ReactCompilerOptions | undefined
}

function createCompatModeExtensions(): CompatModeExtensions {
  return {
    nextEnabled: () => false,
    reactEnabled: () => false,
    reactCompilerOptions: () => undefined,
  }
}

export function getCompatModeExtensions(): CompatModeExtensions {
  return activeHost.compatMode
}

export function setCompatModeExtensions(overrides: Partial<CompatModeExtensions>): void {
  Object.assign(activeHost.compatMode, overrides)
}

// ---------------------------------------------------------------------------
// Render extensions — populated by compat/react + compat/actions + compat/cache
// (registerRenderExtensions).
// ---------------------------------------------------------------------------

/** Result of collecting cache metadata around a render (matches compat/cache/revalidate collectRenderCacheMeta). */
export interface RenderCacheMetaResult<T> {
  value: T
  tags: string[]
  revalidateSeconds?: number
  /** Aggregated `use cache` cacheLife expire/stale windows (min across scopes). */
  expireSeconds?: number
  staleSeconds?: number
  noStore?: boolean
}

/** Options threaded into a cache-meta collection scope. */
export interface CollectRenderMetaOptions {
  fetchCache?: string
  refreshFetches?: boolean
  blockingStaleFetches?: boolean
  route?: string
  /** True for build-time static generation renders (prerender fetch caching). */
  prerender?: boolean
  /** True when the render is a route handler (vs a page/layout render). */
  handler?: boolean
  /** True when a static render must reject dynamic request APIs. */
  dynamicError?: boolean
}

export interface RenderExtensions {
  /** Enrich the client route state embedded in a rendered document. */
  clientRouteState: (
    route: Pick<
      RouteManifestEntry,
      | 'route'
      | 'file'
      | 'hasStaticParams'
      | 'usesRequest'
      | 'segmentConfig'
      | 'prerenderedParams'
      | 'params'
      | 'stream'
    >,
    state: {
      route: string
      params: Record<string, RouteParamValue>
      catchAllOptional?: boolean
      pageVary?: string[]
    },
  ) => {
    route: string
    params: Record<string, RouteParamValue>
    catchAllOptional?: boolean
    /** Baked-shell vary set (see renderer `bakedShellPageVary`). */
    pageVary?: string[]
    staticChildren?: string[]
    staticChildrenBySegment?: Record<string, string[]>
    prefetchKind?: 'shell' | 'eager'
    /** `prefetch = 'allow-runtime'` — the shell is per-URL, not route-shared. */
    runtimePrefetch?: boolean
  }
  /**
   * Wrap a single server-component invocation. Compat (react) installs the
   * use()-thenable replay wrapper here (compat/react/preact withUseThenableState
   * + render/index.tsx invokeServerComponentWithUse). Default: call through untouched.
   */
  wrapServerComponentInvoke: <T>(invoke: () => T) => T

  /**
   * Optional one-time render-module initialization side effect. Default: noop.
   */
  onRenderInit: () => void

  /**
   * Convert a value crossing the server->client boundary into a serializable
   * action reference, or return undefined to leave it untouched. Compat
   * (actions) returns the `{ [PROP_ACTION_MARKER]: id }` marker for tagged /
   * inline / bound server-action functions (compat/actions server-tag +
   * protocol + instances + client-plugin). Default: undefined (no rewrite).
   *
   * `context` carries the active render's config + a stable per-render key so
   * compat can scope inline-action instance registration; core passes its
   * RenderOptions object as the key (opaque to core).
   */
  serializeServerActionProp: (
    value: unknown,
    context: ServerActionPropContext,
  ) => ActionRef | undefined

  /**
   * Run `produce` inside a cache-meta collection scope, returning its value plus
   * the tags/revalidate/no-store it recorded. Compat (cache) supplies the real
   * AsyncLocalStorage collector (compat/cache/revalidate collectRenderCacheMeta).
   * Default: run `produce`, report no tags.
   */
  collectRenderMeta: <T>(
    produce: () => Promise<T>,
    options?: CollectRenderMetaOptions,
  ) => Promise<RenderCacheMetaResult<T>>

  /**
   * The effective `use cache` stale window (seconds) recorded SO FAR by the surrounding
   * `collectRenderMeta` scope, without consuming it. The renderer inlines this into a document's
   * `__PNEXT_NAV_STATE__` so a HARD LOAD - which has no `x-nextjs-stale-time` header to read - seeds
   * its caches with the route's real reuse window. The route manifest's `cacheLife` cannot serve
   * here: it is captured FROM this very render and persisted only after the HTML exists.
   */
  currentCacheStaleSeconds: () => number | undefined

  /**
   * Override the generic error shell title. Compat uses this for Next's
   * production client-error page copy; core keeps the compact default.
   */
  genericErrorTitle: (context: GenericErrorTitleContext) => string | undefined

  /**
   * Whether islands travel the wire as comment markers instead of elements. Core's wire format is
   * elements-as-final: `<pnext-client>` hosts and the page slot ship as real elements the entry
   * hydrates in place, so a page with no islands ships no inline JavaScript at all. Next asserts
   * structural selectors against the live DOM (`body > p`), which a wrapper element would break, so
   * compat turns the elements into comment pairs plus a bootstrap that materializes them back.
   */
  islandCommentWireFormat: () => boolean

  /**
   * Serialize a caught render error into the `{ name, message, digest }` shape
   * handed to error.js / global-error.js boundaries. Compat implements Next's
   * digest protocol: hash server errors into a stable digest, pass through a
   * user-supplied `.digest`, redact the message in production (React #441 text),
   * and log the original stack once to the server console. Default: return
   * undefined so core keeps its own compact serialization.
   */
  serializeError: (context: SerializeErrorContext) => SerializedError | undefined

  /**
   * Next-pixel-exact default UI for an HTTP-access fallback (not-found 404,
   * forbidden 403, unauthorized 401) when the app ships no boundary file.
   * Returns a render tree (preact VNode, opaque to core as `unknown`) matching
   * Next's HTTPAccessErrorFallback (`h1.next-error-h1` + `h2` message). Core
   * keeps a compact built-in when this is absent. `status` is the HTTP status,
   * `message` the copy shown in the `h2`.
   */
  httpAccessFallbackUi: (status: number, message: string) => unknown

  /**
   * Next-pixel-exact built-in global-error document ("This page couldn't load"
   * + digest footer) rendered as a whole HTML document when an error escapes the
   * root layout and the app ships no global-error.*. Returns a render tree
   * (preact VNode, opaque to core) or undefined to keep core's compact fallback.
   */
  defaultGlobalErrorUi: (error: SerializedError) => unknown

  /**
   * Inline bootstrap markup appended to a global-error document (built-in
   * fallback or a user global-error.*) so the client observes the escaped
   * error as an uncaught exception, matching Next's hydration-replay signal
   * (Playwright `pageerror`). Returns an HTML string (typically a `<script>`
   * tag) or undefined to render the document with no bootstrap (core default).
   */
  globalErrorReportScript: (error: SerializedError) => string | undefined

  /**
   * Wrap a non-Error thrown value (a `throw undefined`/`null`/'msg' from a
   * server component) into the Error the error pipeline logs and serializes.
   * Compat mirrors Next's RSC transport wrapper: message String(value), a
   * synthetic `at stringify (<anonymous>)` stack, and a raw-value tag so the
   * digest gains Next's `@E394` suffix for nullish throws. Default: undefined
   * (core wraps with a plain `new Error(String(value))`).
   */
  wrapThrownValue: (value: unknown) => Error | undefined

  /**
   * Format the server-console log line for a render error that carries a boundary digest. Compat
   * emits Next's exact prod shape, plus any environment tag the error carries (an error funneled out
   * of a 'use cache' scope inspects as `{ environmentName: 'Cache', digest }`).
   */
  formatErrorLog: (trace: string, digest: string, error?: Error) => string | undefined

  /**
   * True when the app opted into the global-not-found convention: an unmatched URL then renders the
   * global-not-found document, and with no global-not-found.* file it falls back to the BUILT-IN
   * default 404, never the app's root not-found.* boundary (reserved for explicit notFound() calls).
   */
  globalNotFoundEnabled: () => boolean

  /**
   * Wrap a render's concrete `params` / `searchParams` object in a tracking view so compat can record
   * which of them the render actually reads. Core never interprets the result - it just hands the
   * returned object to user code in place of the original. Default: identity.
   */
  trackVaryParams: <T extends Record<string, unknown>>(
    value: T,
    context: VaryParamsTrackingContext,
  ) => T

  /**
   * Give a `params`/`searchParams` promise Next 15's transitional SYNC surface (the resolved keys
   * readable without `await`), behind compat.next.legacyRequestAPIs. The SAME promise comes back —
   * callers hand a settled thenable to `use()`. Default: identity.
   */
  legacySyncProps: <T extends object>(
    promise: Promise<T>,
    kind: 'params' | 'searchParams',
    value: T,
  ) => Promise<T>

  /** Optional opaque state lifecycle around partial prerenders. */
  prerenderSidecar: PrerenderSidecarExtension
}

/** What kind of object `trackVaryParams` is being handed, plus route shape. */
export interface VaryParamsTrackingContext {
  kind: 'params' | 'searchParams'
  /**
   * Which route segment is about to read this object. Compat keys its
   * per-segment vary sets on it, so a layout that reads more params than the
   * page does not force the page's cache entry to vary on them too. Defaults
   * to the leaf page.
   */
  segment?: 'page' | 'layout'
  /**
   * Name of an OPTIONAL catch-all param of this route (`[[...slug]]`), when
   * any. Its key is absent from `params` at the empty value, so tracking it
   * needs the name up front.
   */
  optionalCatchAllParam?: string
}

export interface GenericErrorTitleContext {
  error: Error
  dev: boolean
}

/** Context handed to the error-serialization extension. */
export interface SerializeErrorContext {
  error: Error
  dev: boolean
}

/** The `{ name, message, digest }` object passed to an error boundary component. */
export interface SerializedError {
  name: string
  message: string
  digest?: string
}

/** Opaque scope handed to serializeServerActionProp (config + per-render key). */
export interface ServerActionPropContext {
  config: ResolvedConfig
  /** Stable per-render identity; core passes its RenderOptions object. */
  renderKey: object
  /**
   * Only answer for a function that is IDENTIFIABLY a server action (a tagged
   * module export, a compile-tagged inline `'use server'` closure, an
   * explicitly overridden id). An unidentifiable function must return
   * undefined instead of being registered as a live per-render instance.
   *
   * Used where the call site cannot distinguish a server action from an
   * ordinary client closure: `<button onClick={fn}>` inside a `'use client'`
   * subtree is always a client handler, and registering it would both stamp
   * the element with a bogus action wire and shift the occurrence indices real
   * inline actions are keyed on.
   */
  identifiedOnly?: boolean
}

/** Serializable marker a compat client runtime revives back into an action. */
export type ActionRef = Record<string, unknown>

export interface PrerenderSidecarContext {
  outPath: string
  routeId: string
  routePath: string
}

export interface PrerenderSidecarExtension {
  begin: (context: PrerenderSidecarContext) => void | Promise<void>
  collect: (context: PrerenderSidecarContext) => Promise<unknown>
  persist: (context: PrerenderSidecarContext, value: unknown) => Promise<void>
  seed: (context: PrerenderSidecarContext) => void | Promise<void>
  /**
   * Whether the persisted sidecar/shell went stale. `true` = hard staleness
   * (block and regenerate before responding); `'soft'` = stale-while-
   * revalidate (serve the stale shell once, regenerate in the background).
   */
  isStale: (context: PrerenderSidecarContext) => boolean | 'soft' | Promise<boolean | 'soft'>
}

function createRenderExtensions(): RenderExtensions {
  return {
    clientRouteState: (_route, state) => state,
    wrapServerComponentInvoke: invoke => invoke(),
    onRenderInit: () => undefined,
    serializeServerActionProp: () => undefined,
    collectRenderMeta: async (produce, _options) => ({ value: await produce(), tags: [] }),
    currentCacheStaleSeconds: () => undefined,
    genericErrorTitle: () => undefined,
    islandCommentWireFormat: () => false,
    serializeError: () => undefined,
    httpAccessFallbackUi: () => undefined,
    defaultGlobalErrorUi: () => undefined,
    globalErrorReportScript: () => undefined,
    wrapThrownValue: () => undefined,
    formatErrorLog: () => undefined,
    globalNotFoundEnabled: () => false,
    trackVaryParams: value => value,
    legacySyncProps: promise => promise,
    prerenderSidecar: {
      begin: () => undefined,
      collect: () => Promise.resolve(undefined),
      persist: () => Promise.resolve(),
      seed: () => undefined,
      isStale: () => false,
    },
  }
}

export function getRenderExtensions(): RenderExtensions {
  return activeHost.render
}

export function setRenderExtensions(overrides: Partial<RenderExtensions>): void {
  Object.assign(activeHost.render, overrides)
}

// ---------------------------------------------------------------------------
// Request extensions — populated by compat/actions + compat/next/rewrites +
// compat/cache (registerActionExtensions).
// ---------------------------------------------------------------------------

/**
 * A request interceptor runs before route matching. Return a `Response` to
 * short-circuit, `{ request }` to swap the request (e.g. a rewrite) and
 * continue, or undefined to pass through unchanged. Ordered; core runs them in
 * registration order.
 */
export type RequestInterceptor = (
  request: Request,
  ctx: RequestInterceptorContext,
) => Promise<Response | { request: Request } | undefined>

/** Context handed to each request interceptor. */
export interface RequestInterceptorContext {
  config: ResolvedConfig
  /**
   * The request's path falls OUTSIDE the configured basePath, so core would
   * otherwise 404 it. Only rules that opt out of the basePath (next.config's
   * `basePath: false` rewrites/redirects) may answer such a request; every other
   * interceptor must decline. Absent (falsy) on every in-app request.
   */
  outsideBasePath?: boolean
}

// Response finalizers - ordered fns run before the first flush of every response-producing call site
// (page renders, route handlers, static file serving, redirects, 404s). Finalizers observe the
// outgoing status/headers plus request info and may mutate them in place. Core registers none;
// compat adds RSC Vary values, x-nextjs-* headers and exact ISR cache-control strings here.

/** How the matched route was served — shapes the finalizer decisions. */
export type ResponseRouteKind = 'html' | 'data' | 'static-asset' | 'route-handler'

/** The route's caching disposition when known (page/handler renders). */
export type ResponseRouteMode = 'static' | 'isr' | 'dynamic'

/** Read-only request facts a finalizer keys its header/status decisions on. */
export interface ResponseFinalizerRequest {
  method: string
  url: URL
  headers: Headers
}

/**
 * Mutable finalizer context handed to each finalizer before the first flush.
 * `status` and `headers` are the outgoing response's own status/headers; a
 * finalizer mutates them in place (set `status` to override, append/merge on
 * `headers`). Classification fields are optional so compat can grow (e.g. RSC
 * kind, rewrite tracking) with no core change; ad-hoc compat hints ride on
 * `hints`.
 */
export interface ResponseFinalizerContext {
  request: ResponseFinalizerRequest
  /** How the response was produced. */
  routeKind: ResponseRouteKind
  /** Caching disposition of the matched route, when core knows it. */
  routeMode?: ResponseRouteMode
  /** Outgoing status; assign to override before first flush. */
  status: number
  /** Outgoing headers; mutate in place (merge Vary, set Cache-Control, ...). */
  headers: Headers
  /** Compat-only classification hints (RSC kind, rewrite target, ...). */
  hints?: Record<string, unknown>
}

/** A response finalizer runs before first flush; mutations land on the response. */
export type ResponseFinalizer = (ctx: ResponseFinalizerContext) => void | Promise<void>

/** Request facts handed to the error funnel (Next's onRequestError request arg). */
export interface RequestErrorInfo {
  method: string
  url: string
  headers: Headers
}

/** Work-unit facts handed to the error funnel (phase, matched route kind). */
export interface RequestErrorContext {
  /** The active work-unit phase when the error was caught, if any. */
  phase?: string
  /** How the failing request was being served. */
  routeKind?: ResponseRouteKind
  /** Optional compat-neutral details forwarded by the active work unit. */
  renderSource?: string
  revalidateReason?: string
}

export interface RequestExtensions {
  /** Ordered interceptors run before route matching (action dispatch, rewrites). */
  interceptors: RequestInterceptor[]

  /**
   * Fixed first-request costs an extension would otherwise pay inside the first
   * interceptor (compat registers the `@opentelemetry/api` resolve). Dev runs
   * them in the background after Ready; they must be idempotent, cheap to skip,
   * and never route-specific.
   */
  warmHooks: ((config: ResolvedConfig) => void)[]

  /**
   * Interceptors for a request whose path lies OUTSIDE the configured basePath - one core 404s before
   * any routing. Only rules that explicitly opt out of the basePath belong here; everything else must
   * not see such a request. Never consulted without a basePath.
   */
  outsideBasePathInterceptors: RequestInterceptor[]

  /**
   * Ordered response finalizers run before the first flush on every
   * response-producing call site. Each observes request info + the outgoing
   * status/headers and may mutate status/headers in place. Compat appends RSC
   * Vary values, x-nextjs-* headers, and exact ISR cache-control strings.
   */
  responseFinalizers: ResponseFinalizer[]

  /**
   * The request-level error funnel. Core calls this exactly once from the single place it catches a
   * request error, with the error, request info and work-unit context. Compat classifies control-flow
   * errors vs real errors and implements onRequestError. Core does NOT swallow the error - it still
   * surfaces its own 500.
   */
  onRequestError: (
    error: unknown,
    requestInfo: RequestErrorInfo,
    context: RequestErrorContext,
  ) => void | Promise<void>

  /**
   * Whether a prebuilt static file for `pathname` (written at `mtimeMs`, with the given cache `tags`)
   * has been invalidated since it was built - the ISR on-demand staleness check. Default: never stale.
   */
  staticStaleness: (pathname: string, mtimeMs: number, tags: readonly string[]) => boolean
  /** Why the same static file is stale, when available. */
  staticStalenessReason: (
    pathname: string,
    mtimeMs: number,
    tags: readonly string[],
  ) => 'stale' | 'on-demand' | 'soft' | undefined

  /** Trigger immediate ISR regeneration for pages API res.revalidate(). */
  onDemandRevalidatePath: (pathname: string) => void | Promise<void>

  /**
   * The preview-mode id an `x-prerender-revalidate` request header must match
   * for Next's on-demand revalidation semantics: middleware is skipped and the
   * route re-renders fresh (`x-nextjs-cache: REVALIDATED`). Compat registers
   * the id it writes into prerender-manifest.json. Default: none (no bypass).
   */
  revalidateBypassToken: () => string | undefined
}

function createRequestExtensions(): RequestExtensions {
  return {
    interceptors: [],
    warmHooks: [],
    outsideBasePathInterceptors: [],
    responseFinalizers: [],
    onRequestError: () => undefined,
    staticStaleness: () => false,
    staticStalenessReason: () => undefined,
    onDemandRevalidatePath: () => undefined,
    revalidateBypassToken: () => undefined,
  }
}

export function getRequestExtensions(): RequestExtensions {
  return activeHost.request
}

/** Append request interceptors in order (compat registers action dispatch + rewrites). */
export function registerRequestInterceptors(...interceptors: RequestInterceptor[]): void {
  activeHost.request.interceptors.push(...interceptors)
}

/** Register a fixed first-request cost the dev warm can pay in the background. */
export function registerRequestWarmHooks(...hooks: ((config: ResolvedConfig) => void)[]): void {
  activeHost.request.warmHooks.push(...hooks)
}

/** Pay every registered first-request cost up front. Failures are never fatal. */
export function runRequestWarmHooks(config: ResolvedConfig): void {
  for (const hook of activeHost.request.warmHooks) {
    try {
      hook(config)
    } catch {
      // A warm that fails just leaves the cost on the first request.
    }
  }
}

/** Append interceptors that may answer a request from outside the basePath. */
export function registerOutsideBasePathInterceptors(...interceptors: RequestInterceptor[]): void {
  activeHost.request.outsideBasePathInterceptors.push(...interceptors)
}

/** Append response finalizers in order (compat registers RSC headers + ISR cache-control). */
export function registerResponseFinalizers(...finalizers: ResponseFinalizer[]): void {
  activeHost.request.responseFinalizers.push(...finalizers)
}

/** Register the preview-mode id that authorizes on-demand revalidate requests. */
export function registerRevalidateBypassToken(token: () => string | undefined): void {
  activeHost.request.revalidateBypassToken = token
}

/**
 * Run every registered response finalizer against `response` before it is
 * flushed, then return the response to send. Finalizers see request info + the
 * outgoing status/headers and mutate them in place; when a finalizer changes the
 * status (immutable on a Response) the body is re-wrapped with the new status.
 *
 * The document cache-control default is applied LAST, and only when nothing
 * upstream claimed the header: an ISR/`use cache` route's SWR value, a route
 * handler's own header and compat's RSC `private, no-store` all win over it.
 */
export async function finalizeResponse(
  response: Response,
  request: ResponseFinalizerRequest,
  info: {
    routeKind: ResponseRouteKind
    routeMode?: ResponseRouteMode
    hints?: Record<string, unknown>
    dev?: boolean
  },
): Promise<Response> {
  const finalizers = activeHost.request.responseFinalizers
  const ctx: ResponseFinalizerContext = {
    request,
    routeKind: info.routeKind,
    ...(info.routeMode ? { routeMode: info.routeMode } : {}),
    ...(info.hints ? { hints: info.hints } : {}),
    status: response.status,
    headers: response.headers,
  }
  for (const finalizer of finalizers) await finalizer(ctx)
  applyDocumentCacheControl(ctx, info.dev === true)
  if (ctx.status === response.status) return response
  return new Response(response.body, {
    status: ctx.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

/**
 * What Next answers a DOCUMENT with, byte for byte (measured against stock
 * next@16.2.12, `next start` and `next dev`; see tests/compat/conformance):
 *
 *   dev, every document          `no-cache, must-revalidate`
 *   prod, per-request document   `private, no-cache, no-store, max-age=0, must-revalidate`
 *   prod, pure prerender (200)   `s-maxage=31536000`
 *   prod, ISR / `use cache`      `s-maxage=<revalidate>, stale-while-revalidate=<expire-revalidate>`
 *   route handler                nothing, unless it sets `revalidate`
 *
 * Without one of these an intermediary is free to apply heuristic freshness to
 * a personalised document. A non-200 is never a cacheable prerender in Next
 * (its prerendered 404 still answers with the per-request value), so status
 * gates the static case rather than the route's build-time disposition alone —
 * which is also why no 404/500 render spells its own `no-store` any more: the
 * prod value below already carries it, in Next's words.
 */
const DYNAMIC_DOCUMENT_CACHE_CONTROL = 'private, no-cache, no-store, max-age=0, must-revalidate'
const DEV_DOCUMENT_CACHE_CONTROL = 'no-cache, must-revalidate'
const DOCUMENT_EXPIRE_SECONDS = 31536000

function applyDocumentCacheControl(ctx: ResponseFinalizerContext, dev: boolean): void {
  if (ctx.routeKind !== 'html') return
  if (ctx.headers.has('cache-control')) return
  if (!(ctx.headers.get('content-type') ?? '').startsWith('text/html')) return
  if (dev) {
    ctx.headers.set('cache-control', DEV_DOCUMENT_CACHE_CONTROL)
    return
  }
  if (ctx.status !== 200) {
    ctx.headers.set('cache-control', DYNAMIC_DOCUMENT_CACHE_CONTROL)
    return
  }
  // Compat sets the SWR value itself (its expireTime is configurable and it also
  // covers pages-router getStaticProps); this only catches a core ISR document,
  // which would otherwise be told never to cache a page that is cacheable for N.
  const revalidate = ctx.routeMode === 'isr' ? ctx.hints?.revalidateSeconds : undefined
  if (typeof revalidate === 'number' && revalidate > 0) {
    const swr = Math.max(0, DOCUMENT_EXPIRE_SECONDS - revalidate)
    ctx.headers.set('cache-control', `s-maxage=${revalidate}, stale-while-revalidate=${swr}`)
    return
  }
  ctx.headers.set(
    'cache-control',
    ctx.routeMode === 'static'
      ? `s-maxage=${DOCUMENT_EXPIRE_SECONDS}`
      : DYNAMIC_DOCUMENT_CACHE_CONTROL,
  )
}

export function setRequestExtensions(
  overrides: Partial<Omit<RequestExtensions, 'interceptors' | 'responseFinalizers'>>,
): void {
  Object.assign(activeHost.request, overrides)
}

/**
 * Report a request-level error through the compat error funnel. Core calls this from the single place
 * it catches request errors. Never throws - reporting failures are swallowed so the caller's own
 * error handling proceeds.
 */
export async function reportRequestError(
  error: unknown,
  requestInfo: RequestErrorInfo,
  context: RequestErrorContext,
): Promise<void> {
  try {
    await activeHost.request.onRequestError(error, requestInfo, context)
  } catch (reportError) {
    console.error('onRequestError funnel failed:', reportError)
  }
}

// ---------------------------------------------------------------------------
// Runtime extensions — populated by compat/edge-runtime.
// ---------------------------------------------------------------------------

export interface RuntimeExtensions {
  /** Run user code with Edge-runtime globals installed. Default: no-op. */
  withEdgeRuntime: <T>(callback: () => T) => T
}

function createRuntimeExtensions(): RuntimeExtensions {
  return { withEdgeRuntime: callback => callback() }
}

export function getRuntimeExtensions(): RuntimeExtensions {
  return activeHost.runtime
}

export function setRuntimeExtensions(overrides: Partial<RuntimeExtensions>): void {
  Object.assign(activeHost.runtime, overrides)
}

export function withRouteRuntime<T>(runtime: string | undefined, callback: () => T): T {
  const edge = runtime === 'edge' || runtime === 'experimental-edge'
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const previous = process.env.NEXT_RUNTIME
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  process.env.NEXT_RUNTIME = edge ? 'edge' : 'nodejs'
  try {
    const result = edge ? activeHost.runtime.withEdgeRuntime(callback) : callback()
    if (isThenable(result)) {
      return Promise.resolve(result).finally(() => restoreNextRuntime(previous)) as T
    }
    restoreNextRuntime(previous)
    return result
  } catch (error) {
    restoreNextRuntime(previous)
    throw error
  }
}

function restoreNextRuntime(value: string | undefined) {
  if (value === undefined) {
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    delete process.env.NEXT_RUNTIME
  } else {
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    process.env.NEXT_RUNTIME = value
  }
}

function isThenable<T>(value: T): value is T & PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function'
}

// ---------------------------------------------------------------------------
// Build extensions — populated by compat/actions + compat/cache/fetch-patch
// (registerActionExtensions + registerCacheExtensions).
// ---------------------------------------------------------------------------

/** Minimal build context handed to each build step (kept structural on purpose). */
export interface BuildStepContext {
  config: ResolvedConfig
  routes: unknown[]
  manifest: unknown
  log: BuildStepLogger
}

/**
 * The verbose build logger's step/log surface handed to each build step. Aliased
 * to the concrete VerboseLogger (core utility) so build.ts can pass its logger
 * verbatim without a structural-variance mismatch on `step`.
 */
export type BuildStepLogger = VerboseLogger

/** A build step runs during `pnext build` (action discovery/bundling, manifest writes). */
export type BuildStep = ((ctx: BuildStepContext) => Promise<void>) & {
  /**
   * Opt in to running under the route-facts scan instead of after it. An early step may read `ctx.config`
   * and route *paths* only - the facts (imports, use-client, CSS) are still being materialized while it runs.
   */
  early?: boolean
  /**
   * Gate the build: run serially before any artifact-producing stage, so this
   * step's diagnostics always precede a downstream failure it would have
   * explained. Non-gate steps run concurrently with the client bundle stage.
   */
  gate?: boolean
}
export type BuildCompleteHook = (ctx: {
  config: ResolvedConfig
  manifest: BuildManifest
  log: BuildStepLogger
}) => Promise<void>

export interface CacheLifeStashLike {
  expireSeconds?: number
  staleSeconds?: number
  revalidateSeconds?: number
}

export interface SegmentPrefetchTree {
  tree: SegmentTreeNodeLike
  staleTime: number
  isStatic: boolean
}

export interface SegmentTreeNodeLike {
  name: string
  param: null | { type: 'd' | 'c' | 'oc'; key: string | null; siblings: string[] | null }
  slots: Record<string, SegmentTreeNodeLike> | null
  prefetchHints: number
  sizeBytes?: number
  segmentPath?: string
}

export interface SegmentMetaLike {
  status: number
  staleTime: number
  postponed: boolean
  segmentPaths: string[]
  segmentSizes?: Record<string, number>
  inlinedSegmentPaths?: string[]
  prefetchHints?: Record<string, number>
}

/**
 * Opaque vary-params result of a tracked build render. Core reads only
 * `params`/`search` (to decide whether the set is worth persisting); the full
 * shape lives in compat.
 */
export interface BuildResponseVary {
  params: string[]
  search: boolean
}

export interface BuildCompatExtensions {
  /**
   * Run a build render inside a vary-params tracking scope. Pure-core default:
   * no tracking (`vary` undefined).
   */
  withVaryParamsTracking: <T>(
    produce: () => Promise<T>,
  ) => Promise<{ value: T; vary?: BuildResponseVary }>
  /** The wire vary names for one segment kind of a tracked render. */
  varyNamesFor: (vary: BuildResponseVary, kind: 'body' | 'head' | 'page' | 'layout') => string[]
  warnMetadataIssues: (input: {
    appPath: string
    routes: RouteManifestEntry[]
    staticMetadataFiles: StaticMetadataFile[]
  }) => Promise<void>
  nextOutputExport: () => boolean
  /** The configured `output` mode when it blocks `next start` ('export' | 'standalone'), else undefined. */
  nextOutputMode: () => 'export' | 'standalone' | undefined
  nextScriptWorkersEnabled: () => boolean
  defaultExpireTimeSeconds: () => number | undefined
  takeCacheLifeStash: () => CacheLifeStashLike | undefined
  /**
   * The `Link` header value for the font preloads stashed during the current
   * render work unit (next/font), or undefined when none. A static prerender
   * never runs the response finalizer that would otherwise flush these, so the
   * build bakes the header into the manifest. Must be called inside the render
   * work unit before it unwinds. No-op default for pure-core apps.
   */
  takeFontLinkHeader: () => string | undefined
  normalizeStaticParamsModule: (module: Record<string, unknown>) => Record<string, unknown>
  defaultDynamicStaleTimeSeconds: number
  defaultStaticStaleTimeSeconds: number
  buildRootTreePrefetch: (options: {
    pathname: string
    isStatic: boolean
    staleTimeSeconds?: number
    buildId?: string
    routeId?: string
    bodySizeBytes?: number
    inlineBudgetBytes?: number
    runtimePrefetch?: boolean
    postponed?: boolean
  }) => SegmentPrefetchTree
  rootTreePrefetchText: (payload: SegmentPrefetchTree, format?: 'json' | 'flight') => string
  buildSegmentMeta: (options: {
    status: number
    staleTime: number
    postponed: boolean
    bodySizeBytes?: number
    inlineBudgetBytes?: number
    prefetchHints?: Record<string, number>
  }) => SegmentMetaLike
  /**
   * `--experimental-build-mode generate` prerender diagnostics: Next's exact
   * blocking-prerender error block for a cacheComponents route that cannot be
   * prerendered, or undefined when the route is fine. Pure-core default: no
   * diagnostics (generate never fails).
   */
  diagnoseCacheComponentsPrerender: (input: {
    route: string
    pageFile: string
    appPath: string
    debugPrerender: boolean
  }) => string | undefined
  /**
   * The shared "Error occurred prerendering page" + export-error footer.
   * `omitErrorLine` drops the leading error line for diagnostics that already
   * printed it (see `diagnosticLeadsWithErrorLine`).
   */
  prerenderFailureFooter: (
    route: string,
    debugPrerender: boolean,
    omitErrorLine?: boolean,
  ) => string
  /** Whether a diagnostic block already opens with the prerender-error line. */
  diagnosticLeadsWithErrorLine: (diagnostic: string) => boolean
  /**
   * Persist build inputs the SERVING runtime needs (compat: the
   * `--debug-prerender` flag, which selects the shape of the runtime
   * 'use cache' error log). Pure-core default: no-op.
   */
  recordBuildFlags: (outPath: string, debugPrerender: boolean) => void
  segmentDir: (outPath: string, routeId: string) => string
  treeSegmentFile: (outPath: string, routeId: string) => string
  bodySegmentFile: (outPath: string, routeId: string) => string
  segmentMetaFile: (outPath: string, routeId: string) => string
}

/** Which entry point is running the init hooks (`pnext build` vs a server). */
export interface InitHookContext {
  build: boolean
}

/**
 * Work a build step kicks off and does NOT await - it runs alongside bundling and prerendering, and the CLI
 * awaits it just before the summary, reporting it as its own metric line. Compat registers the typecheck here.
 */
export interface BuildParallelPhase {
  /** Label for the reported line ("Typecheck"). */
  name: string
  /** Resolves with the phase's OWN elapsed ms (not the time spent awaiting it). */
  run: Promise<number>
}

export interface BuildExtensions {
  /** Ordered build steps (compat registers action discovery + server-reference manifest). */
  steps: BuildStep[]
  /** Ordered hooks run after manifest.json is written. */
  completeHooks: BuildCompleteHook[]
  /** Init hooks run at the start of build + start (compat registers installCompatFetchCache). */
  initHooks: ((config: ResolvedConfig, context: InitHookContext) => void)[]
  /** Background phases started by a build step, awaited before the summary. */
  parallelPhases: BuildParallelPhase[]
  compat: BuildCompatExtensions
}

function createBuildExtensions(): BuildExtensions {
  const compat: BuildCompatExtensions = {
    withVaryParamsTracking: async produce => ({ value: await produce() }),
    varyNamesFor: () => [],
    warnMetadataIssues: () => Promise.resolve(),
    nextOutputExport: () => false,
    nextOutputMode: () => undefined,
    nextScriptWorkersEnabled: () => false,
    defaultExpireTimeSeconds: () => undefined,
    takeCacheLifeStash: () => undefined,
    takeFontLinkHeader: () => undefined,
    normalizeStaticParamsModule: module => module,
    defaultDynamicStaleTimeSeconds: 30,
    defaultStaticStaleTimeSeconds: 300,
    buildRootTreePrefetch: options => {
      const staleTime =
        options.staleTimeSeconds ??
        (options.isStatic
          ? compat.defaultStaticStaleTimeSeconds
          : compat.defaultDynamicStaleTimeSeconds)
      const bodySize = options.bodySizeBytes ?? 0
      const budget = options.inlineBudgetBytes ?? 32 * 1024
      const canInlineBody = options.isStatic && !options.postponed && bodySize <= budget
      return {
        tree: {
          name: '',
          param: null,
          slots: {
            children: {
              name: '__PAGE__',
              param: null,
              slots: null,
              prefetchHints: canInlineBody ? 0b10000000 : 0b100000000,
              ...(options.bodySizeBytes !== undefined ? { sizeBytes: options.bodySizeBytes } : {}),
              ...(canInlineBody ? {} : { segmentPath: '/' }),
            },
          },
          prefetchHints: 0b10000 | (canInlineBody ? 0b1000000 : 0),
        },
        staleTime,
        isStatic: options.isStatic,
      }
    },
    rootTreePrefetchText: (payload, format = 'json') => {
      const json = JSON.stringify(payload)
      return format === 'flight' ? `0:${json}` : json
    },
    buildSegmentMeta: options => {
      const inlined =
        !options.postponed &&
        options.bodySizeBytes !== undefined &&
        options.bodySizeBytes <= (options.inlineBudgetBytes ?? 32 * 1024)
      return {
        status: options.status,
        staleTime: options.staleTime,
        postponed: options.postponed,
        segmentPaths: ['/_tree', '/'],
        ...(options.bodySizeBytes !== undefined
          ? { segmentSizes: { '/': options.bodySizeBytes } }
          : {}),
        ...(inlined ? { inlinedSegmentPaths: ['/'] } : {}),
        ...(options.prefetchHints ? { prefetchHints: options.prefetchHints } : {}),
      }
    },
    diagnoseCacheComponentsPrerender: () => undefined,
    prerenderFailureFooter: () => '',
    diagnosticLeadsWithErrorLine: () => false,
    recordBuildFlags: () => undefined,
    segmentDir: (outPath, routeId) => `${outPath}/segments/${routeId}`,
    treeSegmentFile: (outPath, routeId) =>
      `${compat.segmentDir(outPath, routeId)}/_tree.segment.rsc`,
    bodySegmentFile: (outPath, routeId) =>
      `${compat.segmentDir(outPath, routeId)}/index.segment.rsc`,
    segmentMetaFile: (outPath, routeId) =>
      `${compat.segmentDir(outPath, routeId)}/route.segment.meta`,
  }
  return { steps: [], completeHooks: [], initHooks: [], parallelPhases: [], compat }
}

export function getBuildExtensions(): BuildExtensions {
  return activeHost.build
}

export function setBuildCompatExtensions(overrides: Partial<BuildCompatExtensions>): void {
  Object.assign(activeHost.build.compat, overrides)
}

export function registerBuildSteps(...steps: BuildStep[]): void {
  activeHost.build.steps.push(...steps)
}

export function registerBuildCompleteHooks(...hooks: BuildCompleteHook[]): void {
  activeHost.build.completeHooks.push(...hooks)
}

/**
 * Register in-flight background work. The rejection is parked here so a phase
 * that fails long before the CLI awaits it never surfaces as an unhandled
 * rejection; `buildParallelPhaseError` lets the CLI prefer it over a downstream
 * failure it caused (a type error also breaking the prerender, say).
 */
export function registerBuildParallelPhases(...phases: BuildParallelPhase[]): void {
  for (const phase of phases) {
    phase.run.catch((error: unknown) => {
      parallelPhaseErrors.set(phase, error)
    })
  }
  activeHost.build.parallelPhases.push(...phases)
}

const parallelPhaseErrors = new WeakMap<BuildParallelPhase, unknown>()

/** Drop the previous build's phases (one process can run several builds). */
export function clearBuildParallelPhases(): void {
  activeHost.build.parallelPhases.length = 0
}

/** The first registered phase that has ALREADY failed, if any. */
export function buildParallelPhaseError(): unknown {
  for (const phase of activeHost.build.parallelPhases) {
    if (parallelPhaseErrors.has(phase)) return parallelPhaseErrors.get(phase)
  }
  return undefined
}

export function registerInitHooks(
  ...hooks: ((config: ResolvedConfig, context: InitHookContext) => void)[]
): void {
  activeHost.build.initHooks.push(...hooks)
}

/** Run every registered init hook (core calls at build + start startup). */
export function runInitHooks(
  config: ResolvedConfig,
  context: InitHookContext = { build: false },
): void {
  for (const hook of activeHost.build.initHooks) hook(config, context)
}

// Routing extensions - compat registers extra convention filenames (with their boundary semantics)
// and source usage-detection predicates that mark a route as request-dependent. Core scans its own
// generic conventions and reads its own simple exports; the Next-only conventions
// (forbidden/unauthorized) and next/* import detection move here.

/**
 * An extra convention filename compat wants core routing to discover alongside
 * its own special files. `boundary: true` marks it a render boundary the route
 * scanner treats like error/not-found (collected into a route's special files).
 */
export interface RouteConvention {
  name: string
  boundary: boolean
}

/**
 * A usage-detection predicate: given a source module's text, return true when it
 * makes the route request-dependent (dynamic). Compat registers the next/*
 * import detectors (next/headers, next/navigation request hooks, next/server
 * connection()). Core runs these in addition to its own generic checks.
 */
export type UsageDetector = (source: string) => boolean

/** A route module and its rewritten source, supplied across the full import graph. */
export interface RouteDependencySource {
  file: string
  source: string
}

/** Generic route facts an extension can classify from a transitive module graph. */
export interface RouteDependencyContext {
  kind: 'page' | 'handler'
  files: readonly RouteDependencySource[]
}

/** Extension-owned classification. Labels are opaque to core. */
export interface RouteDependencyClassification {
  usesRequest?: boolean
}

export type RouteDependencyClassifier = (
  context: RouteDependencyContext,
) => RouteDependencyClassification | undefined

/**
 * A source predicate that requires a client entry, paired with the REASON it fired. Reasons are the
 * substrate the client build gates feature regions on - a page that ships the runtime only for
 * `<Link>` needs none of the action machinery - so every detector says which fact it observed.
 */
export interface ClientEntryDetector {
  reason: ClientEntryReason
  detect: UsageDetector
}

export interface RoutingExtensions {
  /** Extra convention filenames compat wants discovered (forbidden/unauthorized/...). */
  conventions: RouteConvention[]
  /** Predicates that mark a page/layout source as request-dependent. */
  usageDetection: UsageDetector[]
  /** Classifiers that inspect a route's complete module graph. */
  dependencyClassification: RouteDependencyClassifier[]
  /** Reason-tagged predicates that require a client entry for a server-only page. */
  clientEntryDetection: ClientEntryDetector[]
  /**
   * Extra file extensions (without the leading dot) the route scanner should
   * treat as page/convention files, ADDITIVE to core's built-in
   * tsx/ts/jsx/js/mjs. Compat (next/mdx) registers `mdx`/`md` so `page.mdx` +
   * top-level `.mdx` pages resolve. Consumed lazily by src/routing/routes.ts so
   * registration at bootstrap (before scanRoutes) is honored. Order-preserving,
   * de-duplicated against the base list.
   */
  pageExtensions: string[]
  /**
   * Why every page route must ship the client router entry, even a purely
   * server-rendered one with no client references. Next always emits its
   * app-router bootstrap per page (so instrumentation-client and hydration run
   * on every document) and registers `compat-parity` here; a pure-core app
   * keeps the lean "no client code, no bundle" default with an empty set.
   */
  alwaysClientEntryReasons: Set<ClientEntryReason>
}

function createRoutingExtensions(): RoutingExtensions {
  return {
    conventions: [],
    usageDetection: [],
    dependencyClassification: [],
    clientEntryDetection: [],
    pageExtensions: [],
    alwaysClientEntryReasons: new Set(),
  }
}

export function getRoutingExtensions(): RoutingExtensions {
  return activeHost.routing
}

/** Register extra route convention filenames (compat: forbidden/unauthorized). */
export function registerRouteConventions(...conventions: RouteConvention[]): void {
  activeHost.routing.conventions.push(...conventions)
}

/** Register request-dependency usage detectors (compat: next/* import patterns). */
export function registerUsageDetectors(...detectors: UsageDetector[]): void {
  activeHost.routing.usageDetection.push(...detectors)
}

/** Register transitive route-dependency classifiers. */
export function registerRouteDependencyClassifiers(
  ...classifiers: RouteDependencyClassifier[]
): void {
  activeHost.routing.dependencyClassification.push(...classifiers)
}

/** Register reason-tagged client-entry detectors (compat: server-action forms, next/form). */
export function registerClientEntryDetectors(...detectors: ClientEntryDetector[]): void {
  activeHost.routing.clientEntryDetection.push(...detectors)
  clientEntryReasonCache.clear()
}

/**
 * Register extra page/convention file extensions (without the leading dot),
 * additive to core's built-in tsx/ts/jsx/js/mjs (compat: next/mdx registers
 * `mdx`/`md`). Duplicates (including against the core base list) are ignored by
 * the routing consumer, so calling with an already-present extension is a no-op.
 */
// Loadable = compiles through the server module graph. Superset of page
// extensions: an imported `.md` is loadable but not routable (Next: @next/mdx
// compiles imported .md while pageExtensions may list only mdx). Listeners let
// consumers that latched the set (the server load plugin's per-root filter
// regex) extend it instead of leaving late extensions to Bun's file loader
// (default export = the file path, rendered as a bogus JSX tag).
// Listeners stay module-global: a consumer latches the set once (the server
// load plugin's per-root filter regex) and must keep hearing about it across a
// host swap, which changes the set exactly like a registration does.
const loadableExtensionListeners: (() => void)[] = []

export function onLoadableExtensionsChanged(listener: () => void): void {
  loadableExtensionListeners.push(listener)
}

export function registerLoadableExtensions(...extensions: string[]): void {
  const loadable = activeHost.loadable
  const fresh = [...new Set(extensions)].filter(ext => !loadable.includes(ext))
  if (fresh.length === 0) return
  loadable.push(...fresh)
  for (const listener of loadableExtensionListeners) listener()
}

/** Page extensions plus import-only loadable extensions, deduped. */
export function extraLoadableExtensions(): string[] {
  return [...new Set([...activeHost.routing.pageExtensions, ...activeHost.loadable])]
}

export function registerPageExtensions(...extensions: string[]): void {
  const { pageExtensions } = activeHost.routing
  const fresh = [...new Set(extensions)].filter(ext => !pageExtensions.includes(ext))
  if (fresh.length === 0) return
  pageExtensions.push(...fresh)
  for (const listener of loadableExtensionListeners) listener()
}

/** Record a reason every page route must ship the client router entry. */
export function registerAlwaysClientEntryReason(reason: ClientEntryReason): void {
  activeHost.routing.alwaysClientEntryReasons.add(reason)
}

/** Why every page ships the router entry; empty for a pure-core app. */
export function alwaysClientEntryReasons(): ClientEntryReason[] {
  return [...activeHost.routing.alwaysClientEntryReasons]
}

/** Extra page-file extensions compat registered, in registration order. */
export function extraPageExtensions(): string[] {
  return activeHost.routing.pageExtensions
}

/** The extra boundary-convention names core routing must discover as special files. */
export function extraBoundaryConventionNames(): string[] {
  return activeHost.routing.conventions.filter(c => c.boundary).map(c => c.name)
}

/** True when any registered usage detector marks `source` as request-dependent. */
export function sourceUsesRegisteredRequestApi(source: string): boolean {
  return activeHost.routing.usageDetection.some(detect => detect(source))
}

/** Merge extension classifications for a route's complete module graph. */
export function classifyRouteDependencies(
  context: RouteDependencyContext,
): RouteDependencyClassification {
  const classification: RouteDependencyClassification = {}
  for (const classify of activeHost.routing.dependencyClassification) {
    const result = classify(context)
    if (!result) continue
    if (result.usesRequest) classification.usesRequest = true
  }
  return classification
}

/** Every reason a registered detector requires a client entry for this source. */
export function sourceClientEntryReasons(source: string): ClientEntryReason[] {
  const key = `${source.length}\0${bun.hash(source).toString(36)}`
  const cached = clientEntryReasonCache.get(key)
  if (cached) return cached
  const reasons: ClientEntryReason[] = []
  for (const { reason, detect } of activeHost.routing.clientEntryDetection) {
    if (!reasons.includes(reason) && detect(source)) reasons.push(reason)
  }
  clientEntryReasonCache.set(key, reasons)
  return reasons
}

// ---------------------------------------------------------------------------
// Proxy extensions — populated by compat/next proxy support.
// ---------------------------------------------------------------------------

export interface ProxyExtensions {
  /** File basenames core should consider as request proxy entrypoints. */
  names: readonly string[]
  /** Optional validation hook for framework-specific proxy diagnostics. */
  validateFiles: (config: ResolvedConfig) => Promise<void>
  /** Pick the handler export from a loaded proxy module. */
  handlerExport: (module: Record<string, unknown>) => unknown
  /** Preserve the original proxy URL and Flight headers for advanced routing. */
  skipUrlNormalize: () => boolean
  /** Framework locale derived from the proxy request URL. */
  locale: (url: URL) => string
  /** Notify compat before an external proxy rewrite is fetched. */
  onExternalRewrite: (request: Request) => void
  /**
   * Max request-body bytes buffered on a proxied request before truncation
   * (compat maps experimental.proxyClientMaxBodySize; Next's default is 10MB).
   */
  clientMaxBodySize: () => number
}

function createProxyExtensions(): ProxyExtensions {
  return {
    names: ['proxy'],
    validateFiles: () => Promise.resolve(),
    handlerExport: module => module.proxy ?? module.default,
    skipUrlNormalize: () => false,
    locale: () => '',
    onExternalRewrite: request => void request,
    clientMaxBodySize: () => 10 * 1024 * 1024,
  }
}

export function getProxyExtensions(): ProxyExtensions {
  return activeHost.proxy
}

export function setProxyExtensions(overrides: Partial<ProxyExtensions>): void {
  Object.assign(activeHost.proxy, overrides)
}

// Bundler extensions - populated by compat/cache/use-cache-transform, compat/actions/rewrite and
// compat/actions/client-plugin.

/**
 * A server-source transform applied after core's own transforms. Compat registers rewriteUseCacheSource and
 * rewriteInlineActionTags. Called with the source, its file path, and optionally the project root - several
 * compat transforms accept a root for id derivation, so it is threaded through.
 */
export interface ServerSourceTransform {
  (source: string, file: string, root?: string): string
  /**
   * Cheap trigger tokens (`includes`, or a `test` for the few shapes whitespace makes non-literal). The
   * transform is skipped when the source matches none of them, so it must be a SUPERSET of the transform's
   * own exact gate - an empty array means "configured off, never fires". Attach with `withSniff`. Absent
   * means ungated: the transform always runs and disables the chain gate.
   */
  sniff?: readonly SniffToken[]
}

export type SniffToken = string | RegExp

/**
 * A client-source transform that must await IO (compat: worker bundling emits a
 * chunk before it can substitute the URL). Runs ahead of the sync chain, so a
 * pass that consumes a token the sync passes rewrite (`import.meta.url`) still
 * sees the original source.
 */
export interface AsyncSourceTransform {
  (source: string, file: string, root?: string): Promise<string>
  sniff?: readonly SniffToken[]
}

export interface BundlerExtensions {
  /** Ordered source transforms that must run before generic server transforms. */
  serverSourcePreTransforms: ServerSourceTransform[]
  /** Ordered server-source transforms (compat: use-cache + inline-action tags). */
  serverSourceTransforms: ServerSourceTransform[]
  /** Ordered client-source transforms (compat: next/font + next/root-params). */
  clientSourceTransforms: ServerSourceTransform[]
  /** Awaitable client-source transforms run before `clientSourceTransforms`. */
  clientSourceAsyncPreTransforms: AsyncSourceTransform[]
  /**
   * Transforms applied to already-BUNDLED server output (vendor bundles). Only the passes whose trigger
   * survives bundling belong here - a package can ship a `'use cache'` function, but its imports and aliases
   * were already resolved by the bundler and its `define` constants inlined by esbuild.
   */
  bundledSourceTransforms: ServerSourceTransform[]
  /** esbuild plugins appended to every client build (compat: action client stub). */
  clientEsbuildPlugins: (config: ResolvedConfig) => Plugin[]
  /** esbuild plugins appended to every server build (compat: action client stub). */
  serverEsbuildPlugins: (config: ResolvedConfig, options?: ServerEsbuildPluginOptions) => Plugin[]
  /**
   * Entry-point rewrite consulted where a server bundle's entry is already
   * resolved (compat: the CJS default-interop marker, so its plugin never
   * needs a catch-all onResolve). undefined = use the specifier as-is.
   */
  serverBundleEntry: (
    specifier: string,
    resolveDir: string,
    resolved?: string,
  ) => string | undefined
  /**
   * esbuild `define` constants for every server compile (compat: compiler.define + compiler.defineServer).
   * Lexical by construction - unlike a textual pass it never rewrites inside string literals or comments.
   */
  serverDefines: () => Record<string, string>
  /** Same, for the client graph (compat: compiler.define; defineServer -> undefined). */
  clientDefines: () => Record<string, string>
  /**
   * Files injected into every client entry graph for their side effects
   * (compat: core-js polyfills under experimental.swcEnvOptions).
   */
  clientInjects: () => string[]
  /** Resolve compat-owned package edges while scanning route dependencies. */
  resolveRouteDependency: (root: string, fromFile: string, specifier: string) => string | undefined
  /**
   * Extra `pure` targets (e.g. `console.log`) for the client esbuild `pure`
   * option, so calls with unused results are dropped (compat: compiler.removeConsole).
   */
  clientPureFunctions: (config: ResolvedConfig) => string[]
  /**
   * Standalone static chunks written verbatim into the client `chunks/` dir,
   * independent of the esbuild entry graph (compat: the no-module polyfills
   * chunk). Pure-core apps emit none.
   */
  staticClientChunks: (config: ResolvedConfig) => { name: string; contents: string }[]
}

function createBundlerExtensions(): BundlerExtensions {
  return {
    serverSourcePreTransforms: [],
    serverSourceTransforms: [],
    clientSourceTransforms: [],
    clientSourceAsyncPreTransforms: [],
    bundledSourceTransforms: [],
    clientEsbuildPlugins: () => [],
    serverEsbuildPlugins: () => [],
    serverBundleEntry: () => undefined,
    serverDefines: () => ({}),
    clientDefines: () => ({}),
    clientInjects: () => [],
    resolveRouteDependency: () => undefined,
    clientPureFunctions: () => [],
    staticClientChunks: () => [],
  }
}

export function getBundlerExtensions(): BundlerExtensions {
  return activeHost.bundler
}

/**
 * esbuild `define` for a server compile (`build` or `transform`). Spread into
 * the options; unconfigured apps get `{}` and esbuild sees no `define` at all.
 */
export function serverDefineOptions(): { define?: Record<string, string> } {
  const define = activeHost.bundler.serverDefines()
  return Object.keys(define).length > 0 ? { define } : {}
}

export function registerServerSourceTransforms(...transforms: ServerSourceTransform[]): void {
  activeHost.bundler.serverSourceTransforms.push(...transforms)
  activeHost.serverSniff = undefined
}

export function registerServerSourcePreTransforms(...transforms: ServerSourceTransform[]): void {
  activeHost.bundler.serverSourcePreTransforms.push(...transforms)
  activeHost.serverSniff = undefined
}

export function registerClientSourceTransforms(...transforms: ServerSourceTransform[]): void {
  activeHost.bundler.clientSourceTransforms.push(...transforms)
}

export function registerClientSourceAsyncPreTransforms(
  ...transforms: AsyncSourceTransform[]
): void {
  activeHost.bundler.clientSourceAsyncPreTransforms.push(...transforms)
}

export function registerBundledSourceTransforms(...transforms: ServerSourceTransform[]): void {
  activeHost.bundler.bundledSourceTransforms.push(...transforms)
}

/**
 * Tag a transform with the cheap trigger tokens that gate it. Wraps rather than
 * mutates, so a transform registered on both the server and client chains can
 * be tagged independently.
 */
export function withSniff<T extends ServerSourceTransform | AsyncSourceTransform>(
  sniff: readonly SniffToken[],
  transform: T,
): T {
  return Object.assign(
    (source: string, file: string, root?: string) => transform(source, file, root),
    { sniff },
  ) as T
}

function sniffHit(source: string, sniff: readonly SniffToken[]): boolean {
  for (const token of sniff) {
    if (typeof token === 'string' ? source.includes(token) : token.test(source)) return true
  }
  return false
}

/**
 * The union of every registered transform's tokens: the whole server chain can
 * bail on one deduped scan instead of re-testing per pass. Derived from the
 * registry and regenerated on every registration, so a transform registered
 * without a sniff (`always: true` here) can never be silently skipped. Cached
 * on the host, so a swap starts from the new host's own chain.
 */
function serverSourceSniff() {
  const host = activeHost
  if (host.serverSniff) return host.serverSniff
  const tokens = new Set<string>()
  for (const transform of [
    ...host.bundler.serverSourcePreTransforms,
    ...host.bundler.serverSourceTransforms,
  ]) {
    if (!transform.sniff) return (host.serverSniff = { pattern: undefined })
    for (const token of transform.sniff) {
      tokens.add(`(?:${typeof token === 'string' ? escapeRegex(token) : token.source})`)
    }
  }
  // One alternation scan measured cheaper than N `includes` over the same
  // bytes. With no tokens at all (every transform configured off) the chain can
  // never fire, and `new RegExp('')` would match everything.
  return (host.serverSniff = { pattern: new RegExp(tokens.size ? [...tokens].join('|') : '(?!)') })
}

/** Whether any registered server-source transform can possibly change `source`. */
export function sourceNeedsServerTransforms(source: string): boolean {
  const { pattern } = serverSourceSniff()
  return !pattern || pattern.test(source)
}

function applyTransforms(
  transforms: readonly ServerSourceTransform[],
  source: string,
  file: string,
  root?: string,
): string {
  let next = source
  for (const transform of transforms) {
    // Gate on the running source, not the original: an earlier transform can
    // inject a later one's trigger (e.g. next/font emits next/root-params).
    if (transform.sniff && !sniffHit(next, transform.sniff)) continue
    next = transform(next, file, root)
  }
  return next
}

export function setBundlerExtensions(
  overrides: Partial<
    Omit<
      BundlerExtensions,
      | 'serverSourcePreTransforms'
      | 'serverSourceTransforms'
      | 'clientSourceTransforms'
      | 'clientSourceAsyncPreTransforms'
      | 'bundledSourceTransforms'
    >
  >,
): void {
  Object.assign(activeHost.bundler, overrides)
}

/** Apply every registered pre server-source transform in order. */
export function applyServerSourcePreTransforms(
  source: string,
  file: string,
  root?: string,
): string {
  return applyTransforms(activeHost.bundler.serverSourcePreTransforms, source, file, root)
}

/** Apply every registered server-source transform in order. */
export function applyServerSourceTransforms(source: string, file: string, root?: string): string {
  return applyTransforms(activeHost.bundler.serverSourceTransforms, source, file, root)
}

export function applyClientSourceTransforms(source: string, file: string, root?: string): string {
  return applyTransforms(activeHost.bundler.clientSourceTransforms, source, file, root)
}

/** Whether any awaitable client pre-transform is registered at all. */
export function hasClientSourceAsyncPreTransforms(): boolean {
  return activeHost.bundler.clientSourceAsyncPreTransforms.length > 0
}

export async function applyClientSourceAsyncPreTransforms(
  source: string,
  file: string,
  root?: string,
): Promise<string> {
  let next = source
  for (const transform of activeHost.bundler.clientSourceAsyncPreTransforms) {
    if (transform.sniff && !sniffHit(next, transform.sniff)) continue
    next = await transform(next, file, root)
  }
  return next
}

/** Apply every registered bundled-output transform in order. */
export function applyBundledSourceTransforms(source: string, file: string): string {
  return applyTransforms(activeHost.bundler.bundledSourceTransforms, source, file)
}

// ---------------------------------------------------------------------------
// Import alias extensions — compat registers Next/React alias maps and missing
// import diagnostics. Core owns only framework aliases.
// ---------------------------------------------------------------------------

export interface ImportAliasExtensions {
  aliases: (config: ResolvedConfig, target: CompatAliasTarget) => Record<string, string>
  clientSsrAliases: (config: ResolvedConfig) => Record<string, string>
  missingImportError: (config: ResolvedConfig, specifier: string) => string | undefined
  /**
   * Extra alias overrides layered on top of `aliases` for modules compiled under the true `react-server`
   * layer (currently proxy/middleware). Distinct from the base server target because pages/api keeps the
   * full-hooks `react` shim for backward compatibility while proxy/middleware must not expose client hooks
   * at all.
   */
  reactServerLayerAliases: (config: ResolvedConfig) => Record<string, string>
}

function createImportAliasExtensions(): ImportAliasExtensions {
  return {
    aliases: () => ({}),
    clientSsrAliases: () => ({}),
    missingImportError: () => undefined,
    reactServerLayerAliases: () => ({}),
  }
}

export function getImportAliasExtensions(): ImportAliasExtensions {
  return activeHost.importAlias
}

export function setImportAliasExtensions(overrides: Partial<ImportAliasExtensions>): void {
  Object.assign(activeHost.importAlias, overrides)
}

// ---------------------------------------------------------------------------
// Proxy response protocol — core has generic control headers; compat registers
// the Next middleware header names.
// ---------------------------------------------------------------------------

export interface ProxyResponseProtocol {
  nextHeader: string
  rewriteHeader: string
}

function createProxyResponseProtocol(): ProxyResponseProtocol {
  return {
    nextHeader: 'x-pnext-middleware-next',
    rewriteHeader: 'x-pnext-middleware-rewrite',
  }
}

export function getProxyResponseProtocol(): ProxyResponseProtocol {
  return activeHost.proxyResponse
}

export function setProxyResponseProtocol(overrides: Partial<ProxyResponseProtocol>): void {
  Object.assign(activeHost.proxyResponse, overrides)
}

export interface RouterProtocolExtensions {
  prefetchRequestHeaders: () => string[]
  /**
   * True when this request should receive only the route's static shell - Suspense/loading fallbacks in
   * place, streamed dynamic continuation cut (Next's partial prefetch: a `next-router-prefetch: 1` request
   * never runs dynamic data). Core consults it in renderPageResponse; the classification policy is compat's.
   */
  shellOnlyRequest: (request: Request, route: RouteManifestEntry) => boolean
}

function createRouterProtocolExtensions(): RouterProtocolExtensions {
  return {
    prefetchRequestHeaders: () => [],
    shellOnlyRequest: () => false,
  }
}

export function getRouterProtocolExtensions(): RouterProtocolExtensions {
  return activeHost.routerProtocol
}

export function setRouterProtocolExtensions(overrides: Partial<RouterProtocolExtensions>): void {
  Object.assign(activeHost.routerProtocol, overrides)
}

// Asset extensions - compat registers framework-specific handling for imported static assets (next/image
// static image imports carrying real width/height/blurDataURL and a /_next/static/media asset URL). Core
// keeps a generic behavior when no override is registered.

/**
 * Context for a static-asset module override. `sourcePath` is the asset file on
 * disk, `bytes` its contents. `emit(relativePath, bytes)` writes the asset to
 * the served public tree at that POSIX-relative path and returns its public URL
 * (e.g. `/_next/static/media/pic.<hash>.png`). A handler returns the ESM module
 * text an `import asset from './pic.png'` should evaluate to, or undefined to
 * let core apply its generic default.
 */
export interface StaticAssetModuleContext {
  sourcePath: string
  bytes: Uint8Array
  emit: (relativePath: string, bytes: Uint8Array) => string
}

export interface StaticAssetPathContext {
  sourcePath: string
  hash: string
  base: string
  ext: string
}

export interface AssetExtensions {
  /** URL path prefixes for emitted assets stored under `<out>/public`. */
  staticAssetPublicPrefixes: () => string[]

  /**
   * POSIX relative public path for core's generic imported-asset module. Compat
   * registers Next's `/_next/static/media` layout.
   */
  staticAssetRelativePath: (context: StaticAssetPathContext) => string

  /**
   * Produce the ESM module text for an imported static asset, or undefined to fall back to core's generic
   * asset module. Compat (next/image) returns the static-image descriptor module; pure-core apps register
   * nothing. May return a Promise - every call site already awaits this seam - so a handler can run an async
   * pipeline.
   */
  staticAssetModule: (
    context: StaticAssetModuleContext,
  ) => string | undefined | Promise<string | undefined>

  /**
   * Whether a configured `turbopack.rules` loader chain claims this file. When
   * true, core's generic image/asset resolver (server + client static-asset
   * plugins) steps aside so the compat loader-rule plugin runs the chain
   * instead (e.g. a `*.svg` loader rule preempting the default image pipeline).
   * Compat registers `hasWebpackLoaderRuleFor`; pure-core apps keep the default.
   */
  hasLoaderRuleFor: (filePath: string) => boolean

  /**
   * Run the `turbopack.rules` loader chain configured for `specifier` (which may carry a query) as imported
   * from `importer`, and return the path of the module its output was materialized to - or undefined when no
   * rule claims it. Server modules compile one at a time and route files are inlined into a route bundle, so
   * a rule source never reaches a bundler `onLoad` with its importer's query intact; core's resolvers ask
   * this instead.
   */
  loaderRuleModule: (
    specifier: string,
    importer: string,
  ) => string | undefined | Promise<string | undefined>
}

function createAssetExtensions(): AssetExtensions {
  return {
    staticAssetPublicPrefixes: () => ['/__pnext/static/media/'],
    staticAssetRelativePath: ({ base, hash, ext }) => `__pnext/static/media/${base}.${hash}${ext}`,
    staticAssetModule: () => undefined,
    hasLoaderRuleFor: () => false,
    loaderRuleModule: () => undefined,
  }
}

export function getAssetExtensions(): AssetExtensions {
  return activeHost.asset
}

export function setAssetExtensions(overrides: Partial<AssetExtensions>): void {
  Object.assign(activeHost.asset, overrides)
}

// CSS extras (CORE - no-op defaults; compat populates via register/css-extras).
//
// Lets core's CSS build sites pull in compat CSS handling without a core-to-compat import edge. Every field
// ships a working no-op default, so a pure-core / non-sass app is byte-identical. The single feature today
// is sass/scss.
//
// Unlike the domains above, this registry is a module-level singleton rather than a host field: consumers
// may hold the object across a host swap, so it is restored in place via restoreWithExtensionHost. Call
// getCssExtensions() lazily inside the build functions, not at module top-level, so the registry is already
// populated at bootstrap.

export interface CssExtensions {
  /** Extra CSS-like file extensions, including the dot. */
  extraCssExtensions: () => string[]
  /** Resolve a bare CSS dependency that normal route scanning leaves external. */
  resolveCssDependency: (root: string, fromFile: string, specifier: string) => string | undefined
  /** Keep root not-found CSS with its fallback response instead of every matched route. */
  deferRootNotFoundCss: () => boolean
  /** Replace built stylesheet links with document-head markup when compat requires it. */
  inlineStylesheets: (
    config: ResolvedConfig,
    options: { assetNames: string[]; dev: boolean; nonce?: string; prependCss?: string },
  ) => string[] | undefined
  /** esbuild plugins for the CSS-chunk builds (compat: sass/scss loader). */
  cssChunkPlugins: () => Plugin[]
  /**
   * The scoped class-name map for a CSS-module file this registry handles
   * (`*.module.{scss,sass}`); undefined to defer to core (`*.module.css`).
   */
  resolveCssModule: (file: string) => Record<string, string> | undefined
  /**
   * The ESM module text a client bundle should evaluate for a compat CSS-module
   * import (`export default <map>`); undefined to defer to core.
   */
  loadCssModuleForClient: (file: string) => string | undefined
  /**
   * Partition each route's ordered `cssImports` into chunk slices (Next's CSS
   * chunking). Returns `routeId -> ordered segments`, each segment an ordered
   * slice of that route's imports; routes absent from the map (or with a single
   * segment) keep core's single-chunk behaviour.
   */
  planRouteCssChunks: (routes: { id: string; cssImports: string[] }[]) => Map<string, string[][]>
}

const cssExtensions: CssExtensions = {
  extraCssExtensions: () => [],
  resolveCssDependency: () => undefined,
  deferRootNotFoundCss: () => false,
  inlineStylesheets: () => undefined,
  cssChunkPlugins: () => [],
  resolveCssModule: () => undefined,
  loadCssModuleForClient: () => undefined,
  planRouteCssChunks: () => new Map(),
}

restoreWithExtensionHost(cssExtensions)

export function getCssExtensions(): CssExtensions {
  return cssExtensions
}

export function setCssExtensions(overrides: Partial<CssExtensions>): void {
  Object.assign(cssExtensions, overrides)
}
