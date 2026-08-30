// Render-layer extension points (CORE - imports ZERO compat).
//
// The foundation registry (src/extensions.ts) owns the four cross-cutting render hooks. This module holds
// the render-ONLY companion hooks that render/index.tsx needs but that do not belong in the shared
// registry: the font scope/asset collector, the compat Suspense identity, and the server-action
// module-tagging lifecycle.
//
// Every hook ships a working NO-OP / pass-through default so a pure-core app renders unchanged. Compat
// populates them from src/compat/register/render.ts at the gated bootstrap seam; the dependency edge is
// inverted - core never imports compat. Types stay structural so core carries no type dependency on any
// compat module.

import type { ResolvedConfig } from '../config'
import type { Metadata, MetadataLink, PageProps, Viewport } from '../types'
import { restoreWithExtensionHost } from '../extensions'

// ---------------------------------------------------------------------------
// Compat enablement gates (pure config reads; kept in core so render never
// imports compat/aliases just to branch on the mode). MUST stay in sync with
// compat/aliases.ts reactCompatEnabled / nextCompatEnabled and the inlined gate
// in compat-bootstrap.ts.
// ---------------------------------------------------------------------------

/** Next compat is on (server actions, next/* modules, authInterrupts). */
export function nextCompatEnabled(config: Pick<ResolvedConfig, 'compat'>): boolean {
  return Boolean(config.compat?.next)
}

/** React compat is on (next implies react; react/react-dom aliasing, use() replay). */
export function reactCompatEnabled(config: ResolvedConfig): boolean {
  return Boolean(config.compat?.next || config.compat?.react || config.compat?.reactCompiler)
}

// ---------------------------------------------------------------------------
// Font extensions — populated by compat/next/font/runtime (registerRender-
// Extensions). Core renders no fonts; the whole subsystem is next-compat.
// ---------------------------------------------------------------------------

/** Resolved next/font CSS + preload links for a render (mirrors ResolvedFontAssets). */
export interface RenderFontAssets {
  css: string
  preloads: MetadataLink[]
}

export interface FontExtensions {
  /**
   * Wrap a render in a font-collection scope so next/font `.className` getters
   * register their definitions. Compat installs the AsyncLocalStorage scope
   * (compat/next/font/runtime runWithFontScope). Default: run untouched.
   */
  runWithFontScope: <T>(callback: () => T) => T

  /**
   * Emit the CSS + preload links for the fonts registered during the current
   * render scope. Compat supplies fontAssets(config, options). Default: none.
   */
  collectFontAssets: (
    config: ResolvedConfig,
    options: { dev?: boolean },
  ) => Promise<RenderFontAssets>

  /**
   * Resolve every font declared by modules loaded so far, without waiting for a render to register
   * them. `collectFontAssets` is network-bound on a cold checkout and sits at the very END of the
   * render, so it serializes behind everything. Called off the request's critical path, it lands in
   * the same memo the render reads. Default: none.
   */
  prewarmFontAssets: (config: ResolvedConfig, options: { dev?: boolean }) => Promise<void>
}

const fontExtensions: FontExtensions = {
  runWithFontScope: callback => callback(),
  collectFontAssets: () => Promise.resolve({ css: '', preloads: [] }),
  prewarmFontAssets: () => Promise.resolve(),
}

export function getFontExtensions(): FontExtensions {
  return fontExtensions
}

export function setFontExtensions(overrides: Partial<FontExtensions>): void {
  Object.assign(fontExtensions, overrides)
}

// Suspense identity - compat apps render React's Suspense (preact/compat), which streaming must recognize
// alongside core's own Suspense marker. Loaded lazily so core apps never pull preact/compat into the server
// process.

export interface SuspenseExtensions {
  /**
   * Lazily resolve the compat Suspense component type (preact/compat) once, so the streaming tree walker can
   * treat it as a boundary. Default is a noop - core streaming uses its own Suspense marker only.
   */
  ensureCompatSuspense: (config: ResolvedConfig) => Promise<void>
  /** The resolved compat Suspense type, or undefined for a pure-core render. */
  compatSuspenseType: () => unknown
}

const suspenseExtensions: SuspenseExtensions = {
  ensureCompatSuspense: () => Promise.resolve(),
  compatSuspenseType: () => undefined,
}

export function getSuspenseExtensions(): SuspenseExtensions {
  return suspenseExtensions
}

export function setSuspenseExtensions(overrides: Partial<SuspenseExtensions>): void {
  Object.assign(suspenseExtensions, overrides)
}

export interface StreamRouteExtensions {
  canStreamRoute: (input: {
    config: ResolvedConfig
    route: { client?: boolean; stream?: unknown }
  }) => boolean
  /**
   * True when the route must stream through a SINGLE preact render (suspending
   * in place) rather than the out-of-order resolve walk, because an ancestor
   * layout/template is a client component whose provider context a separately
   * rendered replacement chunk would lose. See renderClientPageStreamShell.
   */
  inlineSuspenseStream: (input: {
    config: ResolvedConfig
    route: { client?: boolean; stream?: unknown }
  }) => boolean
}

const streamRouteExtensions: StreamRouteExtensions = {
  canStreamRoute: () => true,
  inlineSuspenseStream: () => false,
}

export function getStreamRouteExtensions(): StreamRouteExtensions {
  return streamRouteExtensions
}

export function setStreamRouteExtensions(overrides: Partial<StreamRouteExtensions>): void {
  Object.assign(streamRouteExtensions, overrides)
}

export interface StreamBoundaryExtensions {
  onStreamBoundaryError: (error: unknown) => void | Promise<void>
}

const streamBoundaryExtensions: StreamBoundaryExtensions = {
  onStreamBoundaryError: () => undefined,
}

export function getStreamBoundaryExtensions(): StreamBoundaryExtensions {
  return streamBoundaryExtensions
}

export function setStreamBoundaryExtensions(overrides: Partial<StreamBoundaryExtensions>): void {
  Object.assign(streamBoundaryExtensions, overrides)
}

export function reportStreamBoundaryError(error: unknown): void {
  try {
    const result = streamBoundaryExtensions.onStreamBoundaryError(error)
    if (isThenable(result)) {
      void Promise.resolve(result).catch(reportError => {
        console.error('stream boundary error hook failed:', reportError)
      })
    }
  } catch (reportError) {
    console.error('stream boundary error hook failed:', reportError)
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function'
}

// Metadata resolver - core handles static/build-time metadata. Compat registers request-time/streaming-
// compatible metadata resolvers here without adding a core-to-compat import edge.

export interface MetadataExtensions {
  enabled: (config: ResolvedConfig) => boolean
  hasRuntimeMetadata: (module: Record<string, unknown>) => boolean
  readModuleMetadata: (
    module: Record<string, unknown>,
    props: PageProps,
    parent: Metadata,
    modulePath?: string,
  ) => Promise<Metadata | undefined>
  readModuleViewport: (
    module: Record<string, unknown>,
    props: PageProps,
  ) => Promise<Viewport | undefined>
  shouldRenderMetadataInBody: (input: { config: ResolvedConfig; request?: Request }) => boolean
}

const metadataExtensions: Partial<MetadataExtensions> = {}

export function getMetadataExtensions(): Partial<MetadataExtensions> {
  return metadataExtensions
}

export function getActiveMetadataExtensions(config: ResolvedConfig): Partial<MetadataExtensions> {
  return metadataExtensions.enabled?.(config) ? metadataExtensions : {}
}

export function setMetadataExtensions(overrides: Partial<MetadataExtensions>): void {
  Object.assign(metadataExtensions, overrides)
}

// ---------------------------------------------------------------------------
// Document script injection — compat appends inline scripts to the streamed
// document body (e.g. Next's window.next router shim). Core injects nothing.
// ---------------------------------------------------------------------------

export interface DocumentScriptExtensions {
  /** Optional precedence assigned to renderer-managed stylesheet links. */
  stylesheetPrecedence: (config: ResolvedConfig) => string | undefined

  /**
   * Inline scripts compat injects near the end of the document body, before the
   * props/route/client scripts. Compat (react) returns Next's window.next router
   * shim. Default: '' (core injects no compat scripts).
   */
  documentBodyScripts: (config: ResolvedConfig) => string

  /**
   * Inline tags compat injects into the document `<head>` once per document
   * render. `ctx.dynamic` is true for a request-dependent render (a prod static
   * page is `false` so `next start` skips it; dev renders are always dynamic),
   * while `ctx.rsc` identifies a client navigation/prefetch render. Compat
   * (otel) composes clientTraceMetadata `<meta>` tags here. Default: '' (core
   * injects no compat head tags).
   */
  documentHeadTags?: (config: ResolvedConfig, ctx: { dynamic: boolean; rsc: boolean }) => string

  /** Tags collected after the document shell has flushed. */
  streamInsertedHTML?: () => string
}

const documentScriptExtensions: DocumentScriptExtensions = {
  stylesheetPrecedence: () => undefined,
  documentBodyScripts: () => '',
}

export function getDocumentScriptExtensions(): DocumentScriptExtensions {
  return documentScriptExtensions
}

export function setDocumentScriptExtensions(overrides: Partial<DocumentScriptExtensions>): void {
  Object.assign(documentScriptExtensions, overrides)
}

// ---------------------------------------------------------------------------
// Static params module normalization — core reads params(). Next compat
// registers a module wrapper that exposes generateStaticParams as params().
// ---------------------------------------------------------------------------

export interface StaticParamsExtensions {
  normalizeModule: (module: Record<string, unknown>) => Record<string, unknown>
}

const staticParamsExtensions: StaticParamsExtensions = {
  normalizeModule: module =>
    typeof module.params === 'function' || typeof module.generateStaticParams !== 'function'
      ? module
      : { ...module, params: module.generateStaticParams },
}

export function getStaticParamsExtensions(): StaticParamsExtensions {
  return staticParamsExtensions
}

export function setStaticParamsExtensions(overrides: Partial<StaticParamsExtensions>): void {
  Object.assign(staticParamsExtensions, overrides)
}

// Server-action module tagging - when a server render imports a 'use server' module, compat tags each
// exported function with its wire id so `<form action={fn}>` can progressively enhance without JS. Both
// hooks are no-ops for a pure-core app.

export interface ActionModuleExtensions {
  /**
   * Eagerly import + tag every discovered action module before a page renders,
   * so a <form action={serverAction}> whose action came from a normal import in
   * the page (same module singleton) sees a tagged function. `importModule` is
   * core's own loader, passed in so tagging reuses the render's module cache.
   * Compat supplies the discovery-driven implementation. Default: noop.
   */
  tagActionModulesForRender: (
    config: ResolvedConfig,
    importModule: (file: string) => Promise<Record<string, unknown>>,
  ) => Promise<void>

  /**
   * Tag the exports of a freshly imported module when it is a discovered action
   * module. Core calls this from importModule for every module it loads. Compat
   * gates on isClientActionModule + tags each function export. Default: noop.
   */
  tagActionModuleExports: (
    config: ResolvedConfig,
    file: string,
    module: Record<string, unknown>,
  ) => void
}

const actionModuleExtensions: ActionModuleExtensions = {
  tagActionModulesForRender: () => Promise.resolve(),
  tagActionModuleExports: () => undefined,
}

export function getActionModuleExtensions(): ActionModuleExtensions {
  return actionModuleExtensions
}

export function setActionModuleExtensions(overrides: Partial<ActionModuleExtensions>): void {
  Object.assign(actionModuleExtensions, overrides)
}

// Render span seam - compat (otel) wraps the render-body and route-resolution phases in OpenTelemetry
// spans. Every hook is a pass-through so a pure-core render is untouched; compat threads parenting through
// its own work-unit ALS, never OTel's ContextManager. Callbacks are invoked exactly once around the wrapped
// work and their result returned verbatim.

export interface RenderSpanExtensions {
  /**
   * Wrap the body render (renderTree) so compat emits the
   * `render route (app) <route>` span (`AppRender.getBodyResult`). `route` is
   * the route PATTERN. Default: run `fn` untouched.
   */
  withRenderBodySpan: <T>(route: string, fn: () => Promise<T>) => Promise<T>

  /**
   * Wrap route-component resolution (page module import) so compat emits the
   * `resolve page components` span (`NextNodeServer.findPageComponents`,
   * sibling of the render-body span under the root). Default: run `fn`.
   */
  withFindPageComponentsSpan: <T>(route: string, fn: () => Promise<T>) => Promise<T>

  /**
   * Emit a cheap leaf `resolve segment modules` span
   * (`NextNodeServer.getLayoutOrPageModule`, `next.segment`) for a resolved
   * page/layout segment, nested under the render-body span. `segment` is
   * `__PAGE__` for the leaf page or the dynamic/literal dir label for a layout.
   * Default: noop.
   */
  emitResolveSegmentSpan: (segment: string) => void

  /**
   * Wrap a route-handler invocation so compat emits the
   * `executing api route (app) <route>` span (`AppRouteRouteHandlers.
   * runHandler`). `route` is the core route PATTERN. Default: run `fn`.
   */
  withRouteHandlerSpan: <T>(route: string, fn: () => Promise<T>) => Promise<T>
}

const renderSpanExtensions: RenderSpanExtensions = {
  withRenderBodySpan: (_route, fn) => fn(),
  withFindPageComponentsSpan: (_route, fn) => fn(),
  emitResolveSegmentSpan: () => undefined,
  withRouteHandlerSpan: (_route, fn) => fn(),
}

export function getRenderSpanExtensions(): RenderSpanExtensions {
  return renderSpanExtensions
}

export function setRenderSpanExtensions(overrides: Partial<RenderSpanExtensions>): void {
  Object.assign(renderSpanExtensions, overrides)
}

// Compat populates every registry above at the bootstrap seam, exactly as it
// does the ones in src/extensions.ts — so they return to their core defaults
// with the extension host (one process serving two apps must not blend them).
for (const registry of [
  fontExtensions,
  suspenseExtensions,
  streamRouteExtensions,
  streamBoundaryExtensions,
  metadataExtensions,
  documentScriptExtensions,
  staticParamsExtensions,
  actionModuleExtensions,
  renderSpanExtensions,
]) {
  restoreWithExtensionHost(registry)
}
