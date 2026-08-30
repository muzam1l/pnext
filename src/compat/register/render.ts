// Render extension registration (COMPAT - may import core freely).
//
// Wires the react/next render behaviors into the core render registries at the gated bootstrap seam. Two
// homes:
//
//   src/extensions.ts (shared render registry):
//     - wrapServerComponentInvoke <- invokeServerComponentWithUse (use()-thenable replay for synchronous
//       server components).
//     - onRenderInit              <- optional compat one-time render init.
//
//   src/render/hooks.ts (render-only companion registry):
//     - fontExtensions     <- runWithFontScope + fontAssets (next/font CSS + preloads). Next-compat only.
//     - suspenseExtensions <- the preact/compat Suspense identity the streaming walker treats as a
//       boundary. React-compat, loaded lazily.
//
// serializeServerActionProp, collectRenderMeta and the server-action module tagging hooks are populated
// by the actions and cache sub-registrars; this file owns the react and font/suspense hooks.

import type { ResolvedConfig } from '../../config'
import { onExtensionHostReset, setRenderExtensions } from '../../extensions'
import { setReactCompatActive } from '../react/preact'

// preact's global vnode hook cannot be uninstalled, so it follows the host.
onExtensionHostReset(() => setReactCompatActive(false))
import {
  nextCompatEnabled,
  reactCompatEnabled,
  setDocumentScriptExtensions,
  setFontExtensions,
  setMetadataExtensions,
  setStaticParamsExtensions,
  setStreamRouteExtensions,
  setSuspenseExtensions,
} from '../../render/hooks'
import { withAssetPrefix } from '../../css/build'
import { polyfillsChunkPath } from '../bundler/polyfill'
import { nextRouterShimScript } from '../react/router-shim'
import { renderPartytownHeadScripts } from '../next/script'
import { ensureCompatSuspense, compatSuspenseType } from '../../compat/aliases'
import { invokeServerComponentWithUse } from '../react/server-component-use'
import {
  fontAssets,
  fontPreloadDomScript,
  fontSizeAdjustMeta,
  prewarmFonts,
  runWithFontScope,
} from '../next/font/runtime'
import {
  hasRuntimeMetadata,
  readNextModuleMetadata,
  readNextModuleViewport,
  shouldRenderMetadataInBody,
} from '../metadata'
import { aliasGenerateStaticParams } from '../static-params'
import { getNextConfig } from '../next/config-loader'
import { withSyncProps } from '../next/legacy-request-apis'
import { renderServerInsertedHTML, setServerInsertedHTMLScope } from '../react/server-inserted-html'
import { nextClientRouteState } from '../next/route-state'
import { earlySubmitCaptureScript } from '../actions/early-submit'
import { getWorkUnit, legacyRequestAPIs } from '../../request/context'
import {
  createVaryParamsAccumulator,
  createVaryingParams,
  createVaryingSearchParams,
  normalizeOptionalCatchAllParams,
} from '../segment/vary-params'
import type { VaryParamsTrackingContext } from '../../extensions'

export function registerRenderExtensions(config: ResolvedConfig): void {
  // The react layer only matters when react/next compat is on. A next-only
  // predicate would miss react-compat-only apps (which still render server
  // components with use() and need the compat Suspense identity for streaming).
  if (!reactCompatEnabled(config)) return

  setReactCompatActive(true)

  setServerInsertedHTMLScope(() => {
    const workUnit = getWorkUnit()
    if (!workUnit) return undefined
    return (workUnit.compat ??= {})
  })

  setRenderExtensions({
    wrapServerComponentInvoke: invokeServerComponentWithUse,
    genericErrorTitle: ({ dev }) => (dev ? undefined : 'This page couldn\u2019t load'),
  })

  setSuspenseExtensions({ ensureCompatSuspense, compatSuspenseType })

  // next/font is a next-compat feature; a react-only app renders no fonts.
  if (nextCompatEnabled(config)) {
    setStreamRouteExtensions({
      canStreamRoute: canStreamNextRoute,
      inlineSuspenseStream: needsInlineSuspenseStream,
    })
    setMetadataExtensions({
      enabled: nextCompatEnabled,
      hasRuntimeMetadata,
      readModuleMetadata: readNextModuleMetadata,
      readModuleViewport: readNextModuleViewport,
      shouldRenderMetadataInBody,
    })
    setStaticParamsExtensions({ normalizeModule: aliasGenerateStaticParams })
    setRenderExtensions({
      clientRouteState: nextClientRouteState,
      trackVaryParams: trackRenderVaryParams,
      legacySyncProps: withSyncProps,
      // Next asserts structural selectors (`body > p`) against the live DOM, so
      // island hosts and the page slot travel as comment pairs and the inline
      // bootstrap materializes them. Core ships the elements as final.
      islandCommentWireFormat: () => true,
    })
    setDocumentScriptExtensions({
      stylesheetPrecedence: cfg => (nextCompatEnabled(cfg) ? 'next' : undefined),
    })
    setFontExtensions({
      runWithFontScope,
      collectFontAssets: fontAssets,
      prewarmFontAssets: prewarmFonts,
    })
    setDocumentScriptExtensions({
      documentBodyScripts: cfg =>
        `${flightDataBootstrapScript()}${renderPartytownHeadScripts()}${basePathScript(cfg.basePath)}${trailingSlashScript(cfg.trailingSlash)}${skipTrailingSlashScript(cfg.skipTrailingSlashRedirect)}${staleTimesScript()}${segmentSchedulerScript()}${legacySyncPropsScript()}${appShellsScript()}${optimisticRoutingScript()}${nextRouterShimScript()}<script>${earlySubmitCaptureScript()}</script>${fontPreloadDomScript()}`,
      documentHeadTags: () =>
        `${polyfillsScript(config)}${fontSizeAdjustMeta()}${renderServerInsertedHTML()}`,
      streamInsertedHTML: renderServerInsertedHTML,
    })
  }
}

/**
 * Hand a render's `params`/`searchParams` back wrapped in a tracking view when a vary-params scope is
 * open (a segment-prefetch render). Each call allocates its OWN body-segment accumulator, tagged with the
 * caller's segment kind so the response publishes the layout and page vary sets side by side instead of
 * one union. Outside a scope the accumulator is null and the original object passes through untouched, so
 * ordinary document renders pay nothing.
 */
function trackRenderVaryParams<T extends Record<string, unknown>>(
  value: T,
  context: VaryParamsTrackingContext,
): T {
  const accumulator = createVaryParamsAccumulator(context.segment ?? 'page')
  if (!accumulator) {
    // Segment-M2 deliverable 5: Next's params shape (an EMPTY optional catch-all
    // carries no key) applies to every render, not just tracked ones.
    return context.kind === 'searchParams'
      ? value
      : normalizeOptionalCatchAllParams(value, context.optionalCatchAllParam ?? null)
  }
  return context.kind === 'searchParams'
    ? createVaryingSearchParams(accumulator, value)
    : createVaryingParams(accumulator, value, context.optionalCatchAllParam ?? null)
}

/**
 * Next's flight transport inlines its RSC payload as `self.__next_f.push(...)` chunks, and app code (plus
 * Next's own e2e assertions) treats the presence of that global as "this document carries inlined server
 * data". pnext streams its payload through a different global, so nothing here reads `__next_f` - this
 * declares the array and pushes an empty marker so the documented global exists with Next's shape. Inert
 * by construction.
 */
function flightDataBootstrapScript(): string {
  return `<script>(self.__next_f=self.__next_f||[]).push([0])</script>`
}

// Next emits a `<script noModule>` tag referencing the polyfills chunk in the
// document head. It never executes in module-capable browsers; it exists so the
// served HTML carries the same polyfills tag Next does (the emitted chunk is
// written by the client build's static-chunk seam). assetPrefix is applied so a
// CDN-hosted asset base still resolves.
function polyfillsScript(config: ResolvedConfig): string {
  return `<script src="${withAssetPrefix(config, polyfillsChunkPath())}" noModule=""></script>`
}

function canStreamNextRoute(input: {
  config: ResolvedConfig
  route: { client?: boolean; stream?: unknown }
}) {
  if (!nextCompatEnabled(input.config)) return true
  // Whole-page client routes stream through a single Preact render, preserving
  // ancestor provider context across their Suspense boundaries.
  if (input.route.client) return true
  const stream = input.route.stream as
    { hasLoadingBoundary?: boolean; ancestorClientReferences?: string[] } | undefined
  // No stream metadata means a non-page route (handlers never reach the page
  // renderer) — nothing to stream.
  if (!stream) return false
  // Out-of-order streaming isolates each Suspense boundary and drops client-provider context inherited
  // from ancestor layouts/templates. When no ancestor ships a client reference there is nothing to lose;
  // when one does, the route still streams through the single-render inline-suspense path, which keeps the
  // whole tree in one preact render so ancestor providers stay in scope.
  return true
}

// A route whose ancestor layouts/templates ship client references streams in
// place (one preact render that suspends at each boundary) instead of flushing
// replacement chunks rendered from a fresh root, which would drop the ancestor
// islands' provider context around the boundary's content.
function needsInlineSuspenseStream(input: {
  config: ResolvedConfig
  route: { client?: boolean; stream?: unknown }
}) {
  if (!nextCompatEnabled(input.config) || input.route.client) return false
  const stream = input.route.stream as { ancestorClientReferences?: string[] } | undefined
  return (stream?.ancestorClientReferences?.length ?? 0) > 0
}

// Inline script exposing experimental.staleTimes so the client prefetch cache
// honors config overrides (defaults 30s dynamic / 300s static apply otherwise).
function staleTimesScript(): string {
  const experimental = getNextConfig().experimental as
    { staleTimes?: { dynamic?: number; static?: number } } | undefined
  const staleTimes = experimental?.staleTimes
  if (!staleTimes) return ''
  return `<script>window.__PNEXT_STALE_TIMES__=${JSON.stringify(staleTimes)};</script>`
}

// The client prefetch bandwidth scheduler (concurrency limits + hover-reserved lanes) reproduces Next's
// SEGMENT-CACHE scheduler, which only exists under cacheComponents. A classic prefetch app must fire all
// visible prefetches without throttling - the app-client-cache full-prefetch tests clear their request
// listener between two staggered prefetches and would see the delayed one land as an unexpected request.
// Core defaults to scheduling, so plain compat stamps an explicit `false` to opt out.
function segmentSchedulerScript(): string {
  const config = getNextConfig() as { cacheComponents?: unknown }
  return config.cacheComponents === true
    ? `<script>window.__PNEXT_SEGMENT_SCHEDULER__=true;</script>`
    : `<script>window.__PNEXT_SEGMENT_SCHEDULER__=false;</script>`
}

// `experimental.appShells`: the client fires a SECOND, param-stripped prefetch
// per params-reading route to prime that route's shared App Shell (compat/
// client/segment-prefetch.ts). Strictly opt-in — without the flag the extra
// request would break the request-count contracts of every other suite.
// Under compat.next.legacyRequestAPIs the server's params/searchParams promises also carry the
// resolved object's own keys (withSyncProps). Those keys cannot travel on the wire, so the client
// rebuilds them - but only if it knows the surface existed, or a strict app would grow one.
function legacySyncPropsScript(): string {
  return legacyRequestAPIs() ? `<script>window.__PNEXT_SYNC_PROPS__=1;</script>` : ''
}

function appShellsScript(): string {
  const experimental = getNextConfig().experimental as { appShells?: unknown } | undefined
  return experimental?.appShells === true
    ? `<script>window.__PNEXT_APP_SHELLS__=true;</script>`
    : ''
}

// `experimental.optimisticRouting` defaults ON, so this is an OPT-OUT marker:
// only an app that explicitly disabled it stamps the document, and the client
// segment cache then stops letting one URL's entry satisfy another URL's
// PREFETCH (compat/client/segment-cache.ts). Navigation reuse is unaffected.
function optimisticRoutingScript(): string {
  const experimental = getNextConfig().experimental as { optimisticRouting?: unknown } | undefined
  return experimental?.optimisticRouting === false
    ? `<script>window.__PNEXT_NO_OPTIMISTIC_ROUTING__=true;</script>`
    : ''
}

/**
 * Inline script exposing the configured basePath to the client. `next/form` and other compat client code
 * read `window.__PNEXT_BASE_PATH__` to prefix soft-nav targets. Emitted only when a basePath is set - a
 * bare app keeps the global undefined, treated as ''.
 */
function basePathScript(basePath: string): string {
  if (!basePath) return ''
  return `<script>window.__PNEXT_BASE_PATH__=${JSON.stringify(basePath)};</script>`
}

/**
 * Inline script exposing skipTrailingSlashRedirect to the client so Link hrefs and client navigation
 * preserve the author's exact trailing slash. Emitted only when the flag is set - a normal app keeps the
 * global undefined, treated as false.
 */
function skipTrailingSlashScript(skip: boolean | undefined): string {
  if (!skip) return ''
  return `<script>window.__PNEXT_SKIP_TRAILING_SLASH__=true;</script>`
}

function trailingSlashScript(trailingSlash: boolean | undefined): string {
  if (trailingSlash !== true) return ''
  return `<script>window.__PNEXT_TRAILING_SLASH__=true;</script>`
}
