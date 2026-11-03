// PPR shell baking, serving and promotion: loaded by the build and the first PPR request, never by dev.
import { existsSync } from 'node:fs'
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import renderToString from 'preact-render-to-string'
import { type ResolvedConfig } from '../config'
import { registerServerRuntime } from '../runtime/load'
import { nextCompatEnabled } from './hooks'
import {
  getRenderExtensions,
  getRequestExtensions,
  getRouterProtocolExtensions,
} from '../extensions'
import { isNotFoundError, isRedirectError } from '../api/navigation'
import { runWithRequest } from '../request/context'
import {
  cacheComponents,
  completePrerender,
  currentPrerenderScope,
  isPostpone,
  isTaskPostpone,
  runInPrerender,
  runWithClockTape,
  runWithSyncIoAbort,
} from './ppr'
import { serializeProps } from '../utils/serialize'
import { runWithCacheScope } from '../request/cache'
import { readText } from '../utils/fs'
import { promiseMarker, promisePlaceholderJson, runInParamsScope } from './slots'
import { escapeHtml } from '../utils/html'
import type { RouteParamValue, RouteManifestEntry } from '../types'
import {
  runWithFontScope,
  type RenderOptions,
  type BuildPartialState,
  type PartialState,
  needsClientEntry,
  renderDocumentStart,
  documentNonce,
  renderDocumentEnd,
  compatNextConfig,
  routeParamKeys,
  pageSearchParams,
  renderScopeRequest,
  type PrebuiltShell,
  encodeIslandMarker,
  shellStaleSeconds,
  prerenderSidecarContext,
  seedPrerenderSidecar,
  routeTargetUrl,
  pprShellUpgradeFor,
  matchRouteParams,
  pprShellPath,
  pprSubShellPath,
  subShellKey,
  pageRender,
  routerPayload,
  parseStaticSlots,
  hStreamError,
  SHELL_TIME_SCRIPT,
} from './renderer'

/** A PPR-eligible request: the prebuilt, live, regenerated or promoted shell, or undefined to render dynamically. */
export async function pprShellResponse(
  options: RenderOptions,
  pprUpgrade: ReturnType<typeof pprShellUpgradeFor>,
  draft: boolean,
  softPprResume: boolean,
) {
  const prebuilt = await loadPprShell(options.config, options.route, routeTargetUrl(options))
  // A navigation or draft load re-renders the static parts like Next; unprerendered params still hang.
  const live =
    prebuilt &&
    (draft
      ? Object.keys(prebuilt.concreteParams ?? {}).length < routeParamKeys(options.route).length
      : softPprResume && options.request?.headers.get('next-router-prefetch') !== '1')
      ? await liveShell(options, prebuilt, draft)
      : null
  if (live) return renderPprResponse(options, live)
  if (draft) return undefined
  // A blocking policy waits for the concrete prefix; a shell without it is never served first.
  if (pprUpgrade?.foreground && !shellFillsUpgrade(pprUpgrade, prebuilt)) {
    const shell = await promoteShell(options, pprUpgrade, false)
    if (shell) return renderPprResponse(options, shell)
  }
  if (prebuilt) {
    // Soft tag staleness: serve the stale shell while a background regeneration refreshes it (SWR).
    if (prebuilt.softStale) void regenerateStalePprShell(options)
    return renderPprResponse(options, prebuilt)
  }
  // A stale shell is regenerated rather than served (stale data) or dropped (loses cached fills).
  const regenerated = await regenerateStalePprShell(options)
  if (regenerated) return renderPprResponse(options, regenerated)
  // No shell fills the generated prefix: prerender it on demand, like Next's ISR for a novel param.
  if (pprUpgrade !== undefined && !rejectedPprShellUpgrades.has(pprUpgrade.key)) {
    const shell = await promoteShell(options, pprUpgrade, false)
    if (shell) return renderPprResponse(options, shell)
  }
  return undefined
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
  await registerServerRuntime(options.config, options.route.sourceFiles)
  const sidecar = getRenderExtensions().prerenderSidecar
  const sidecarContext = prerenderSidecarContext(options)
  if (!options.probeShell) await sidecar.begin(sidecarContext)
  // A BUILD shell render under cacheComponents ends at the first task boundary. A runtime
  // regeneration renders against a live server where task-settled work is expected to complete, so
  // it keeps the unbounded behavior - UNLESS it is a bounded shell upgrade, which must postpone
  // uncached request-time I/O exactly as the build-time base shell did.
  const taskBoundary = cacheComponents() && (!options.runtimeRegen || options.boundedRegen === true)
  // Known params join the params scope so `use cache` root-param reads see them; the rest hang.
  const scopedParams = (options.fallbackParams && options.params) || options.fallbackConcreteParams
  const unfilledParams =
    options.fallbackParams || options.fallbackConcreteParams
      ? new Set(
          (options.fallbackParamKeys ?? routeParamKeys(options.route)).filter(
            key => !(key in (scopedParams ?? {})),
          ),
        )
      : undefined
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
              runWithCacheScope(() =>
                pageRender({ ...options, partial, staticStage: true }, false),
              ),
            )
          const renderShell = () =>
            scopedParams ? runInParamsScope(scopedParams, renderTree) : renderTree()
          // Build shells and on-demand (bounded) upgrades postpone sync IO; an unbounded regen bakes it.
          return await (options.runtimeRegen && !options.boundedRegen
            ? renderShell()
            : runWithSyncIoAbort(renderShell))
        } finally {
          // Abandon any hanging request/param promises that were passed out but
          // never awaited inside a boundary — no HANGING_PROMISE_REJECTION in
          // build logs. Runs inside the prerender scope so the AbortController is
          // live.
          completePrerender(scope)
        }
      },
      {
        taskBoundary: bounded,
        unfilledParams,
        prefetchShell: options.prefetchShell,
        route: options.route.route,
      },
    )
  const freshPartial = (): BuildPartialState => ({
    mode: 'build',
    nextId: 0,
    holes: [],
    metadataDynamic: false,
    runtimeData: 0,
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
      ...(partial.runtimeData ? { runtimeData: partial.runtimeData } : {}),
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
  await registerServerRuntime(options.config, options.route.sourceFiles)
  // Seed (read-only) the resume-data sidecar so 'use cache' scopes resolve
  // their build-time fills; unlike renderPartialShell nothing is collected or
  // persisted back.
  await seedPrerenderSidecar(options)
  const partial: PartialState = {
    mode: 'build',
    nextId: 0,
    holes: [],
    metadataDynamic: false,
    runtimeData: 0,
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
              // nearest boundary.
              return await runWithSyncIoAbort(() =>
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
          {
            runtimePrefetch: true,
            route: options.route.route,
            prefetchShell: options.prefetchShell,
          },
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
  const resumes = prebuilt.holes.length > 0 || prebuilt.metadataDynamic
  // A live navigation prefix stays partial even when nothing is left to resume, unless
  // `ensureStatic = 'navigation'` made it a blocking prerender; a document is complete.
  const postponed =
    resumes ||
    (prebuilt.promoted === true &&
      routerPayload(options) &&
      options.route.segmentConfig?.ensureStatic !== 'navigation')
  const staleTime = String(shellStaleSeconds(options.route))
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
    schedulePprShellUpgrade(options, prebuilt)
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
    schedulePprShellUpgrade(options, prebuilt)
    return new Response(`${shell}${renderDocumentEnd()}`, {
      status: options.status ?? 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'x-nextjs-stale-time': staleTime,
      },
    })
  }
  const request = renderScopeRequest(options)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      const partial: PartialState = {
        mode: 'request',
        nextId: 0,
        known: new Set(prebuilt.holes),
        onChunk: html => controller.enqueue(encoder.encode(html)),
        metadataDynamic: prebuilt.metadataDynamic,
        staticSlots: parseStaticSlots(shell),
        ...(Object.keys(prebuilt.concreteParams ?? {}).length < routeParamKeys(options.route).length
          ? { shellHead: shell.slice(0, shell.indexOf('</head>')) }
          : {}),
      }
      controller.enqueue(encoder.encode(shell))
      // Next's test builds emit a sentinel between the shell and the resume (splitResponseWithPPRSentinel).
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      if (process.env.__NEXT_TEST_MODE) {
        controller.enqueue(encoder.encode('<!-- PPR_BOUNDARY_SENTINEL -->'))
      }
      if (!routerPayload(options)) {
        const nonce = documentNonce(options.request)
        const stamp = `<script${nonce ? ` nonce="${escapeHtml(nonce)}"` : ''}>${SHELL_TIME_SCRIPT}</script>`
        controller.enqueue(encoder.encode(stamp))
      }
      schedulePprShellUpgrade(options, prebuilt)
      void (async () => {
        try {
          await seedPrerenderSidecar(options)
          if (embedsRuntimeStage(options.route)) {
            const stage = { filled: new Set<number>(), skeletons: [] as string[] }
            const seconds = await renderRuntimeStage(options, request, {
              ...partial,
              metadataDynamic: false,
              shellHead: undefined,
              stage,
            })
            for (const id of stage.filled) partial.known.delete(id)
            const complete = partial.known.size === 0 && !partial.metadataDynamic
            // The client files everything before this marker, plus the skeletons, as the runtime stage.
            const marker = `<!--pnext-runtime:${seconds ?? ''}${complete ? ':1' : ''}-->`
            const json = (value: string) => JSON.stringify(value).replace(/</g, '\\u003c')
            const skeletons = stage.skeletons.length
              ? `<script type="text/pnext-runtime">${json(stage.skeletons.join(''))}</script>`
              : ''
            const nonce = documentNonce(options.request)
            // A document load keeps its own copy: the live DOM is promoted past this point.
            controller.enqueue(
              encoder.encode(
                routerPayload(options)
                  ? marker + skeletons
                  : `${marker}<script${nonce ? ` nonce="${escapeHtml(nonce)}"` : ''}>self.__PNEXT_RUNTIME_STAGE__="<!doctype html>"+document.documentElement.outerHTML+${json(skeletons)}</script>`,
              ),
            )
          }
          if (partial.known.size > 0 || partial.metadataDynamic)
            await runWithRequest(
              request,
              () =>
                runWithFontScope(() =>
                  runWithCacheScope(() => pageRender({ ...options, partial }, false)),
                ),
              options.params ?? {},
            )
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
      // Postponed; the static stage reuses for the shell window.
      'x-nextjs-postponed': '1',
      'x-nextjs-stale-time': staleTime,
    },
  })
}

// Partial Prefetching caches a navigation's runtime stage, so its response embeds that stage first.
function embedsRuntimeStage(route: RouteManifestEntry): boolean {
  return (
    compatNextConfig().partialPrefetching === true || route.segmentConfig?.prefetch === 'partial'
  )
}

/** Fill the holes request data alone resolves (connection() and sync IO after it still hang). */
async function renderRuntimeStage(
  options: RenderOptions,
  request: ReturnType<typeof renderScopeRequest>,
  partial: PartialState,
): Promise<number | undefined> {
  return runWithRequest(
    request,
    () =>
      runInPrerender(
        async () => {
          const scope = currentPrerenderScope()
          try {
            await runWithSyncIoAbort(() =>
              runWithFontScope(() =>
                runWithCacheScope(() => pageRender({ ...options, partial }, false)),
              ),
            )
          } catch {
            // Whatever the stage could not finish streams with the resume.
          } finally {
            completePrerender(scope)
          }
          return getRenderExtensions().currentCacheStaleSeconds()
        },
        { runtimePrefetch: true, navigationStage: true, route: options.route.route },
      ),
    options.params ?? {},
  )
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

/** Re-render a stale PPR base shell (pattern URL, params hanging) and persist it with its holes. */
export async function regenerateStalePprShell(
  options: RenderOptions,
): Promise<PrebuiltShell | null> {
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
      // A fallback shell regenerates generic and bounded, as the build rendered it.
      const fallback = options.route.params.length > 0 || Boolean(options.route.catchAll)
      const base = {
        config: options.config,
        route: options.route,
        url: new URL(`http://pnext.local${options.route.route}`),
        runtimeRegen: true,
        ...(fallback || options.boundedRegen ? { boundedRegen: true } : {}),
      }
      const { value: prebuilt } = await getRenderExtensions().collectRenderMeta(
        () => (fallback ? renderFallbackShell(base) : renderPartialShell(base)),
        { blockingStaleFetches: true, route: options.url?.pathname },
      )
      if (prebuilt) {
        options.route.builtStatic ??= options.route.pprHoles?.length === 0
        options.route.pprHoles = prebuilt.holes
        options.route.pprRuntimeData = prebuilt.runtimeData
        await writeFile(file, prebuilt.shell).catch(() => undefined)
      }
      return prebuilt
    })().finally(() => pendingShellRegens.delete(options.route.id))
    pendingShellRegens.set(options.route.id, pending)
  }
  return pending
}

/** The shell a PPR route serves `url` now (promoted > sub > base), and whether it is still an upgradeable fallback. */
export async function servedPprShell(
  options: RenderOptions,
): Promise<{ shell: PrebuiltShell; fallback: boolean } | null> {
  const url = routeTargetUrl(options)
  const shell =
    (await loadPprShell(options.config, options.route, url)) ??
    (await regenerateStalePprShell(options))
  if (!shell) return null
  const upgrade = pprShellUpgradeFor(options.route, url)
  const fallback = upgrade !== undefined && !shellFillsUpgrade(upgrade, shell)
  if (fallback) schedulePprShellUpgrade(options, shell)
  return { shell, fallback }
}

export async function loadPprShell(
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
  // Tag/path revalidation staleness: a shell baked with cache tags must stop serving once one of
  // those tags - or the route's path - is revalidated. The serving file's mtime is the freshness
  // mark; regeneration rewrites the base shell, self-healing it, and a stale sub-shell file is
  // dropped so the base shell (whose param holes resume per-request) takes over.
  // `soft` also counts SWR tag revalidations: a per-param shell has no background regeneration.
  const bakedAtIsStale = (bakedAtMs: number, soft = false): boolean => {
    const pathname = url?.pathname ?? (route.route || '/')
    const tags = route.cacheTags ?? []
    return soft
      ? getRequestExtensions().staticStalenessReason(pathname, bakedAtMs, tags) !== undefined
      : getRequestExtensions().staticStaleness(pathname, bakedAtMs, tags)
  }
  const shellIsStale = async (file: string, soft = false): Promise<boolean> => {
    try {
      const stats = await stat(file)
      return bakedAtIsStale(stats.mtimeMs, soft)
    } catch {
      return true
    }
  }
  // Checked before the build-time sidecar: a shell promoted after a revalidation is already fresh.
  const upgrade = pprShellUpgradeFor(route, url)
  if (upgrade) {
    const upgraded = pprShellUpgrades.get(upgrade.key)
    // A runtime-promoted shell is memoized in memory, not on disk, so it needs the same path/tag
    // revalidation check the shell FILES get above, with its promotion time standing in for the
    // file mtime. Without it the memo outlives every invalidation and the page freezes on stale
    // bytes forever. Dropping the stale entry also re-opens promotion (schedulePprShellUpgrade
    // skips any key already in this map), so the fallthrough render warms a fresh shell.
    if (upgraded) {
      pprShellUpgrades.delete(upgrade.key)
      if (!bakedAtIsStale(upgraded.promotedAt, true)) {
        // Re-insert: eviction drops the least recently served entry first.
        pprShellUpgrades.set(upgrade.key, upgraded)
        return upgraded.shell
      }
    }
  }
  const pprStale = await getRenderExtensions().prerenderSidecar.isStale(
    prerenderSidecarContext({ config, route }),
  )
  if (pprStale === true) return null
  const softStale = pprStale === 'soft'
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
        if (await shellIsStale(file, true)) {
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
    // A regeneration's verdict, which may differ from the build's.
    runtimeData: route.pprRuntimeData,
    ...(softStale ? { softStale } : {}),
  }
}

/**
 * Warm the next more-specific shell without delaying the fallback response.
 * Only parameter prefixes with a generateStaticParams owner are promoted; a
 * remaining fully dynamic suffix stays a hole forever.
 */
export function schedulePprShellUpgrade(
  options: Pick<RenderOptions, 'config' | 'route' | 'url' | 'nav'>,
  served?: PrebuiltShell,
): void {
  const upgrade = pprShellUpgradeFor(options.route, routeTargetUrl(options))
  if (
    !upgrade ||
    pprShellUpgrades.has(upgrade.key) ||
    rejectedPprShellUpgrades.has(upgrade.key) ||
    // The served shell already fills the promoted prefix (a prebuilt sub-shell): nothing to warm.
    shellFillsUpgrade(upgrade, served)
  ) {
    return
  }
  void promoteShell(options, upgrade, true).catch(() => undefined)
}

// In-flight promotions, shared by foreground and background callers so one
// concrete prefix renders once however many requests race for it.
const pendingPromotions = new Map<string, Promise<PrebuiltShell | null>>()
const PROMOTED_SHELL_LIMIT = 256

function rememberPromotedShell(key: string, shell: PrebuiltShell): void {
  if (pprShellUpgrades.size >= PROMOTED_SHELL_LIMIT) {
    pprShellUpgrades.delete(pprShellUpgrades.keys().next().value!)
  }
  pprShellUpgrades.set(key, { shell, promotedAt: Date.now() })
}

/** The served shell re-rendered for this request, unpersisted: params it left hanging still hang. */
function liveShell(
  options: RenderOptions,
  prebuilt: PrebuiltShell,
  draft: boolean,
): Promise<PrebuiltShell | null> {
  const keys = routeParamKeys(options.route)
  const concrete = prebuilt.concreteParams ?? {}
  return runWithRequest(
    renderScopeRequest(options),
    async () => {
      const replayable = await getRenderExtensions().prerenderSidecar.seed(
        prerenderSidecarContext(options),
      )
      // Draft mode bypasses caches; otherwise a live render must reproduce the shell's cached values.
      if (replayable === false && !draft) return null
      // Rendered like the build's shell: no request headers or nav state, the pattern URL for hanging params.
      const live = {
        config: options.config,
        route: options.route,
        url: new URL(
          Object.keys(concrete).length ? options.url.pathname : options.route.route,
          options.url,
        ),
        runtimeRegen: true,
        boundedRegen: true,
        probeShell: true,
      }
      return Object.keys(concrete).length
        ? renderSubShell({ ...live, concreteParams: concrete, paramKeys: keys })
        : keys.length
          ? renderFallbackShell(live)
          : renderPartialShell(live)
    },
    concrete,
  ).catch(() => null)
}

function promoteShell(
  options: Pick<RenderOptions, 'config' | 'route' | 'url'>,
  upgrade: NonNullable<ReturnType<typeof pprShellUpgradeFor>>,
  background: boolean,
): Promise<PrebuiltShell | null> {
  // A racing request may have finished this promotion after our shell lookup missed it.
  const promoted = pprShellUpgrades.get(upgrade.key)
  if (promoted) return Promise.resolve(promoted.shell)
  const pending = pendingPromotions.get(upgrade.key)
  if (pending) return pending
  const promotion = (async () => {
    // A runtime shell upgrade renders against the live server without the build-time resume sidecar
    // seeded in this process. Seed it first, so cache-backed fills resolve from the captured
    // snapshots instead of refetching.
    if (background) {
      try {
        await getRenderExtensions().prerenderSidecar.seed(prerenderSidecarContext(options))
      } catch {
        // A missing/failed sidecar seed only forces the upgrade render to refetch.
      }
    }
    // `performance.now()` is prerenderable, so the confirm render replays the first one's clock.
    const clock: number[] = []
    // Like a regeneration, a promotion refetches SWR-stale data rather than baking it.
    const render = async (probeShell: boolean) =>
      (
        await getRenderExtensions().collectRenderMeta(
          () =>
            runWithClockTape(clock, probeShell, () =>
              renderSubShell({
                ...options,
                concreteParams: upgrade.concreteParams,
                paramKeys: upgrade.paramKeys,
                runtimeRegen: true,
                // Keep the build-time task-boundary postpone discipline: promote the concrete params into
                // the shell, but leave any boundary that depends on uncached request-time I/O a hole.
                boundedRegen: true,
                ...(probeShell ? { probeShell } : {}),
              }),
            ),
          { blockingStaleFetches: true, route: options.url?.pathname },
        )
      ).value
    const prebuilt = await render(false)
    // The subtree escapes every boundary: there is no shell to promote, so stop retrying.
    if (!prebuilt) {
      rejectedPprShellUpgrades.add(upgrade.key)
      return null
    }
    const shell = { ...prebuilt, concreteParams: upgrade.concreteParams, promoted: true as const }
    // A PPR route's base shell RESUMES its holes live. A background promotion must never bake
    // request-time content (a span id, Math.random, Date) into the static shell in place of that
    // resume: confirm the promoted shell is reproducible before caching it; on a mismatch remember
    // the rejection so the double render is not retried.
    if (background && options.route.ppr && (await render(true))?.shell !== prebuilt.shell) {
      rejectedPprShellUpgrades.add(upgrade.key)
      return shell
    }
    rememberPromotedShell(upgrade.key, shell)
    void persistPromotedShell(options, shell)
    return shell
  })().finally(() => pendingPromotions.delete(upgrade.key))
  pendingPromotions.set(upgrade.key, promotion)
  return promotion
}

// A promoted shell joins the route's sub-shells on disk, like Next's ISR, so it outlives the memo and a restart.
async function persistPromotedShell(
  options: Pick<RenderOptions, 'config' | 'route'>,
  shell: PrebuiltShell,
): Promise<void> {
  const concreteParams = shell.concreteParams ?? {}
  const key = subShellKey(concreteParams)
  const file = pprSubShellPath(options.config.outPath, options.route.id, key)
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, shell.shell)
  } catch {
    return
  }
  const subShells = (options.route.pprSubShells ??= [])
  if (!subShells.some(entry => entry.key === key))
    subShells.unshift({ key, concreteParams, holes: shell.holes })
}

export function shellFillsUpgrade(
  upgrade: NonNullable<ReturnType<typeof pprShellUpgradeFor>>,
  shell: PrebuiltShell | null | undefined,
): boolean {
  return Object.keys(upgrade.concreteParams).every(key => key in (shell?.concreteParams ?? {}))
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
  return actual && subShellForParams(subShells, actual)
}

function subShellForParams(
  subShells: NonNullable<RouteManifestEntry['pprSubShells']>,
  actual: Record<string, RouteParamValue>,
): NonNullable<RouteManifestEntry['pprSubShells']>[number] | undefined {
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
