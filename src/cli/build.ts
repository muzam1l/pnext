import { copyFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeVercelOutput } from './adapters/vercel'
import { startWarmChild, type WarmChild } from './adapters/vercel-warm'
import { devOutSegment, loadConfig, pathToFileHref } from '../config'
import { bootstrapCompat } from '../compat-bootstrap'
import {
  buildParallelPhaseError,
  clearBuildParallelPhases,
  getBuildExtensions,
  type BuildResponseVary,
  type BuildStep,
  type BuildStepContext,
  getCompatModeExtensions,
  getRenderExtensions,
  runInitHooks,
  withRouteRuntime,
} from '../extensions'
import { buildClientEntries, emitStaticClientChunks, startClientSources } from '../client/build'
import { beginSourceScope, endSourceScope, sourceCacheStats } from '../resolve/source-text'
import { flushDevModuleCaches } from '../runtime/module-cache'
import { scanFactsStats } from '../resolve/scan-facts'
import { clientEntryName } from '../client/chunk-name'
import { registerServerRuntime, serverBundleTargetForRuntime } from '../runtime/loader'
import {
  buildClientReferenceCss,
  buildGlobalCss,
  buildNotFoundCss,
  buildRouteCss,
  emittedAssetNames,
  prepareRouteCssChunks,
  registerCssRuntime,
  warmCssPipeline,
} from '../css/build'
import { ensureEmptyDir, listFiles, readText, toPosixPath, writeText } from '../utils/fs'
import {
  discoverStaticMetadataFiles,
  metadataRouteHandlerModule,
  staticMetadataCacheControl,
  staticMetadataForPathFromFiles,
  staticMetadataForRouteFromFiles,
  staticMetadataOutputFile,
  staticRouteMetadataKey,
  withDynamicMetadataRoutes,
  type StaticMetadataFile,
} from '../routing/metadata-files'
import { readModuleMetadata, readModuleViewport } from '../render/metadata'
import {
  defaultNotFoundDocument,
  pprShellPath,
  pprSubShellPath,
  renderFallbackShell,
  renderGlobalNotFoundResponse,
  renderPageWithStatus,
  renderPartialShell,
  renderSubShell,
  staticParamsFor,
} from '../render/renderer'
import {
  abortActivePrerenderScopes,
  beginShellSourceTracking,
  cacheComponents,
  endShellSourceTracking,
} from '../render/ppr'
import { handleRouteModule, staticRouteParams, type RouteHandlerModule } from '../routing/handler'
import { runWithCacheScope } from '../request/cache'
import {
  devServerModuleHref,
  resetModuleGraphFailure,
  setEmitCompiledSpecifiersManifest,
  throwIfModuleGraphFailed,
} from '../runtime/modules'
import {
  beginDynamicBailoutProbe,
  endDynamicBailoutProbe,
  runWithWorkUnit,
} from '../request/context'
import { findProxyFile, proxyExternalLoadTarget, validateProxyFiles } from '../routing/proxy'
import { setRequestRuntime } from '../routing/request-environment'
import {
  addClientEntryReason,
  assertNoServerActionsWithoutCompat,
  findLayouts,
  materializeRouteFacts,
  scanRoutes,
} from '../routing/routes'
import { interceptionMarkerLevels } from '../routing/slots'
import { writeTypegen } from './typegen'
import { lookupBuildCache, writeBuildCache } from './build/cache'
import { createVerboseLogger, type VerboseLogger } from '../utils/verbose'
import { bold, cyan, dim, green } from '../utils/ansi'
import type {
  ActionManifestEntry,
  BuildManifest,
  RouteManifestEntry,
  RouteParamValue,
  StaticFileMetadata,
  StaticModuleMetadata,
  StaticRouteMetadata,
} from '../types'

/** Mutable accumulator handed to compat build steps as their `manifest` ctx. */
interface BuildStepState {
  actions: ActionManifestEntry[]
  /** Root-relative 'use server' module paths — known from discovery, so the
   * client stage keys off this instead of waiting for their compile. */
  actionSources?: string[]
  /** First-party files that import a node_modules action module (absolute paths) — see
   * ActionDiscovery.actionImporters; route.sourceFiles never reaches into node_modules itself. */
  actionImporters?: string[]
  /** Work a step handed back rather than finishing inline; awaited before the
   * build manifest is written, so it lands under the client stage. */
  deferred?: Promise<void>
}

type CacheLifeStash = ReturnType<typeof getBuildExtensions>['compat'] extends {
  takeCacheLifeStash: () => infer T
}
  ? NonNullable<T>
  : never
type SegmentMeta = ReturnType<ReturnType<typeof getBuildExtensions>['compat']['buildSegmentMeta']>

function nextCompatEnabled(config: Awaited<ReturnType<typeof loadConfig>>) {
  return getCompatModeExtensions().nextEnabled(config)
}

function reactCompatEnabled(config: Awaited<ReturnType<typeof loadConfig>>) {
  return getCompatModeExtensions().reactEnabled(config)
}

function buildCompat() {
  return getBuildExtensions().compat
}

interface BuildOptions {
  adapter?: 'vercel'
  verbose?: boolean
  /**
   * `next build --debug-build-paths <glob>` parity: restrict the build to the route files matching
   * the (comma-separated) pattern(s), relative to the project root.
   */
  debugBuildPaths?: string
  /**
   * `next build --experimental-build-mode compile|generate` parity: `compile`
   * bundles without prerendering; `generate` runs the prerender/export pass
   * with Next-shaped page-data output (and fails with Next's exact
   * blocking-prerender diagnostics under cacheComponents).
   */
  buildMode?: 'compile' | 'generate'
  /** `next build --debug-prerender`: unminified prerender stacks + codeframes. */
  debugPrerender?: boolean
}

export async function buildProject(root?: string, options: BuildOptions = {}) {
  clearBuildParallelPhases()
  resetModuleGraphFailure()
  // One read per source for the whole build (route-fact walk, action discovery,
  // client loader), released here so nothing survives the build.
  beginSourceScope()
  // Only the vercel adapter's trace step reads the per-artifact specifier
  // sidecars; every other build path pays nothing for them.
  const restoreSpecifiersManifest = setEmitCompiledSpecifiersManifest(options.adapter === 'vercel')
  const lifecycle: { warm?: WarmChild } = {}
  try {
    return await runBuild(root, options, lifecycle)
  } catch (error) {
    // A parallel phase that already failed (a type error) is the root cause of
    // whatever broke downstream; report it instead of the symptom.
    const phaseError = buildParallelPhaseError()
    throw phaseError ?? error
  } finally {
    lifecycle.warm?.kill()
    endSourceScope()
    restoreSpecifiersManifest()
    flushDevModuleCaches()
  }
}

async function runBuild(
  root: string | undefined,
  options: BuildOptions,
  lifecycle: { warm?: WarmChild },
) {
  const verbose = options.verbose ?? false
  const log = createVerboseLogger(verbose, 'build')
  const startedAt = performance.now()

  console.log(
    `${cyan('▲')} ${bold('pnext')} ${dim('— Creating an optimized production build ...\n')}`,
  )
  const config = await loadConfig(root)
  const buildCache = lookupBuildCache(config, options)
  // Compat plugin loader: the single gated seam that populates the core
  // extension registries when compat is enabled (no-op for pure-core apps).
  // A build compiles immediately, so it takes both tiers up front.
  await bootstrapCompat(config)
  log.log(`config loaded — out ${path.relative(config.root, config.outPath) || '.'}`)
  // Run registered init hooks (compat installs the Next fetch-cache patch so prerenders observe
  // force-cache / next: { revalidate, tags }). No-op for pure-core apps. `build: true` keeps
  // server-boot-only hooks out of the build - Next never runs register() during `next build`, so
  // build prerenders must see a noop tracer.
  runInitHooks(config, { build: true })
  const cached = await buildCache
  log.log(`build cache ${cached.reason ?? 'disabled'}`)
  if (cached.manifest) {
    printBuildSummary(
      config,
      cached.manifest.routes,
      cached.manifest.staticFiles ?? {},
      performance.now() - startedAt,
      Boolean(cached.manifest.proxyModule),
    )
    return cached.manifest
  }
  // Load Tailwind on the CSS worker while the steps below run, so the first
  // stylesheet doesn't pay its cold boot.
  warmCssPipeline(config)
  // The warm pass runs in its own process; start it here so its boot overlaps the build and only the
  // warming itself lands on its own step. Every build compiles what the production server would
  // otherwise compile inside its first request; the vercel adapter additionally imports app modules
  // for the bundles only an import writes (see adapters/vercel-warm).
  const warmMode = options.adapter === 'vercel' ? 'full' : 'compile'
  const warm = startWarmChild(config, warmMode)
  lifecycle.warm = warm
  await log.step('prepare output directory', async () => {
    // Build-owned outputs only: `<outRoot>/dev` belongs to a possibly-running
    // dev server and must survive.
    await ensureEmptyDir(config.outPath, [devOutSegment])
    await copyPublicDir(config.publicPath, path.join(config.outPath, 'public'))
  })
  // Prebundled server entry for `pnext start`: framework-only, independent of the
  // app build, so it runs in a child process for the whole build — its bundling
  // heap never stacks on the build's peak RSS and its wall hides under the build.
  // Best-effort — a failure only costs start time. Awaited before the summary.
  const serverEntryDone = import('./serve/entry')
    .then(entry => entry.emitServerEntryChild(config.outPath))
    .catch((error: Error) => {
      console.warn(`pnext build: server entry bundling skipped — ${error.message}`)
    })
  // The document-level stylesheets run their postcss/Tailwind pass on the CSS
  // worker, so they overlap with the route scan below instead of serializing
  // ahead of it. Awaited before prepareRouteCssChunks — route CSS still builds
  // strictly after these two.
  const documentCss = Promise.resolve()
    .then(() => buildGlobalCss(config, { verbose }))
    // 404/not-found documents reference their own CSS chunk; emit it alongside
    // the global chunk so the synthetic not-found routes don't 404 their styles.
    .then(() => buildNotFoundCss(config, { verbose }))
  // Nothing awaits it until below; park the rejection so a CSS failure reports
  // at that await instead of as an unhandled rejection mid-scan.
  documentCss.catch(() => undefined)
  // experimental.nextScriptWorkers: copy the Partytown library so `worker`
  // scripts (rewritten to type="text/partytown") can load it from
  // /_next/static/~partytown/. Tolerates the package being absent. Nothing
  // downstream reads it, so it runs beside the scan instead of ahead of it.
  const partytownLib = log.step('partytown lib', () => copyPartytownLib(config))
  partytownLib.catch(() => undefined)

  let routes = await log.step('scan routes', () => scanRoutes(config.appPath))
  log.log(`found ${routes.length} route${routes.length === 1 ? '' : 's'}`)
  if (options.debugBuildPaths) {
    routes = filterDebugBuildRoutes(config.root, routes, options.debugBuildPaths)
    log.log(
      `--debug-build-paths ${options.debugBuildPaths} — ${routes.length} route${routes.length === 1 ? '' : 's'} kept`,
    )
  }
  // The page routes' server modules are the bulk of the warm pass and depend on
  // nothing but the scan; hand them over now so the child compiles them under
  // the client stage instead of after it.
  warm.prewarm(routes.filter(route => route.kind === 'page').map(route => route.file))
  // Compat build steps (action discovery/bundling + server-reference manifest)
  // populate their output onto this accumulator. Pure-core registers no steps.
  const buildState: BuildStepState = { actions: [] }
  const stepContext = { config, routes, manifest: buildState, log }
  const { steps } = getBuildExtensions()
  // Steps that declare themselves route-fact-independent (action discovery) run UNDER the scan below
  // rather than after it, which would make both strictly serial.
  const earlySteps = runBuildSteps(
    steps.filter(step => step.early),
    stepContext,
  )
  // Nothing awaits it until the client-entry set is computed; park the rejection
  // so a discovery failure reports there instead of as an unhandled rejection.
  earlySteps.catch(() => undefined)
  // The table arrives with its content facts deferred (dev boots on paths
  // alone); a build needs all of them, and needs their scan errors up front.
  // The client stage needs nothing but each route's client file list, so it
  // starts here, route by route as the facts land: the transform chain and the
  // React Compiler run on oxc's threadpool under the rest of the build instead
  // of inside the client stage's own wall.
  const clientSources = startClientSources(config)
  // Unpaced on purpose: the walk holds the loop for ~0.55 s and action
  // discovery beside it cannot resume, but pacing it (setImmediate per route)
  // measures a wash — discovery's 0.6 s of starvation is hidden entirely inside
  // this walk's own wall, and the client stage cannot start before either ends.
  await log.step(
    'scan route facts',
    // eslint-disable-next-line @typescript-eslint/require-await
    async () => materializeRouteFacts(routes, route => clientSources.warmRoutes([route])),
  )
  // Before anything renders: core cannot dispatch a server action, so an app with
  // one fails the build by name instead of shipping forms that go nowhere.
  assertNoServerActionsWithoutCompat(routes, nextCompatEnabled(config), config.root)
  // Render-time extensions read the route table from the request runtime (e.g.
  // compat's static-sibling route state); publish it for the prerender pass the
  // same way the serve handlers do.
  setRequestRuntime({ config, routes, dev: false })
  // Compute the compat CSS-chunk plan across all routes up front (Next's CSS chunking needs the
  // global picture); buildRouteCss then emits one asset per planned slice. No-op for pure-core apps.
  // The plan is derived from the route table alone, so it does NOT wait on the document stylesheets
  // - those are awaited just before the first route stylesheet is emitted, which lets a Tailwind
  // pass run under the build steps and the client bundles instead of ahead of them.
  prepareRouteCssChunks(routes)
  // output:'export' with trailingSlash:false lays prerendered pages out flat
  // (`/a.html` rather than `/a/index.html`). Only meaningful under compat (the
  // Next config carries `output`); pure-core apps always use the dir layout.
  const flatExportLayout =
    nextCompatEnabled(config) && buildCompat().nextOutputExport() && config.trailingSlash !== true
  // The proxy bundle is independent of the remaining build steps; overlap them.
  const proxyBuild = log.step('proxy module', () => buildProxyModule(config))
  proxyBuild.catch(() => undefined)
  // Gate steps (validation) run here so their diagnostics still precede any
  // failure the client stage or the not-found prerender would raise for the
  // same broken app; every other step is a manifest write nothing downstream
  // reads, so it moves under the client bundles below (stage parallelism, §3).
  await runBuildSteps(
    steps.filter(step => !step.early && step.gate),
    stepContext,
  )
  // Static metadata depends on the scan, not on action discovery — collect and
  // copy it while the early steps finish rather than after them.
  const staticFiles: Record<string, StaticFileMetadata> = {}
  const staticMetadata = (async () => {
    const files = await log.step('discover static metadata files', () =>
      Promise.resolve(discoverStaticMetadataFiles(config.appPath)),
    )
    await log.step('static metadata files', () =>
      copyStaticMetadataFiles(config, staticFiles, files),
    )
    return files
  })()
  staticMetadata.catch(() => undefined)
  // Action discovery arms the client-stub set buildClientEntries consumes, so
  // this is the point the early steps have to have landed by. What the step
  // deferred is not part of that arming and is awaited further below.
  await earlySteps
  const deferredSteps = buildState.deferred ?? Promise.resolve()
  deferredSteps.catch(() => undefined)
  const staticMetadataFiles = await staticMetadata
  // Warnings only - nothing downstream reads the result. Started here and awaited after the client
  // stage so it costs the build nothing, and still prints before the first prerendered route line.
  const metadataWarnings = nextCompatEnabled(config)
    ? log.step('next metadata warnings', () =>
        buildCompat().warnMetadataIssues({
          appPath: config.appPath,
          routes,
          staticMetadataFiles,
        }),
      )
    : undefined
  metadataWarnings?.catch(() => undefined)
  const staticModuleMetadata = await log.step('core module metadata', () =>
    collectStaticModuleMetadata(config, routes),
  )

  const actionSources = buildState.actionSources ?? buildState.actions.map(a => a.sourceKey)
  // realpath, not resolve: a hybrid app's routes are scanned through the pages-compat mirror, whose
  // `source-app` is a symlink to the real app dir - the two spellings of one file must compare equal.
  const actionFiles = new Set(
    actionSources.map(source => realFilePath(path.resolve(config.root, source))),
  )
  // A node_modules action module never lands in route.sourceFiles itself (that walk stops at the
  // package boundary), so a route reaching one only through a first-party importer is matched here.
  const actionImporters = new Set((buildState.actionImporters ?? []).map(realFilePath))
  for (const route of routes) {
    if (
      route.kind === 'page' &&
      route.sourceFiles.some(file => {
        const real = realFilePath(file)
        return actionFiles.has(real) || actionImporters.has(real)
      })
    ) {
      addClientEntryReason(route, 'actions')
    }
  }
  const clientRoutes = routes.filter(
    route =>
      route.kind !== 'handler' &&
      (route.client || route.clientReferences.length > 0 || route.needsRouterEntry),
  )
  for (const route of clientRoutes) route.clientEntry = `assets/${clientEntryName(route)}.js`
  const clientBundles = log.step(
    `client bundles (${clientRoutes.length} route${clientRoutes.length === 1 ? '' : 's'})`,
    () =>
      buildClientEntries({
        config,
        routes: clientRoutes,
        outDir: path.join(config.outPath, 'public', 'assets'),
        verbose,
        hasServerActions: actionSources.length > 0,
        pipeline: clientSources,
      }),
  )
  clientBundles.catch(() => undefined)
  // The 404 document links the same content-hashed entries and stylesheets every
  // other document does, and those names are only final once the client stage has
  // fingerprinted them — so this render follows the bundle rather than racing it.
  // Result is consumed after the prerender pass, where it always was.
  const notFoundDocuments = clientBundles.then(() =>
    renderNotFoundDocuments({
      config,
      log,
      skip: options.buildMode === 'compile',
      documentCss,
      staticMetadataFiles,
      staticModuleMetadata,
    }),
  )
  notFoundDocuments.catch(() => undefined)
  // The manifest-writing steps and typegen depend on nothing the client stage produces, so they run
  // under it instead of ahead of it. Awaited first so a step failure still reports before a
  // bundling error.
  const remainingSteps = runBuildSteps(
    steps.filter(step => !step.early && !step.gate),
    stepContext,
  ).then(() => log.step('typegen', () => writeTypegen(config, routes)))
  remainingSteps.catch(() => undefined)
  await remainingSteps
  await clientBundles
  const proxyModule = await proxyBuild
  await partytownLib
  // Standalone static chunks (compat: the no-module polyfills chunk) live
  // outside the esbuild entry graph, so emit them regardless of whether any
  // route produced a client bundle.
  await emitStaticClientChunks(config, path.join(config.outPath, 'public', 'assets'))
  // All three source consumers have run by here; the split says how much of the
  // app was read once and shared rather than read per consumer.
  if (verbose) {
    const sources = sourceCacheStats()
    log.log(
      `source cache — ${sources.reads} reads, ${sources.hits} shared, ${sources.files} files · parses ${JSON.stringify(scanFactsStats())}`,
    )
  }
  await metadataWarnings

  // A throwing after() during a prerender must fail the whole build (Next
  // exits 1), but with `prerenderEarlyExit: false` the errors for every route
  // are collected first — so record it and keep prerendering, then fail at the
  // end once all routes have logged their prerender-error lines.
  let hadAfterPrerenderError = false
  // `dynamic = 'error'` routes that read dynamic data can't be rendered
  // statically; Next fails the build naming each offending route + API. Collect
  // them all (matching prerenderEarlyExit:false) and fail once at the end.
  let hadDynamicErrorFailure = false

  // A handler route whose logical output path doubles as a parent directory for a descendant
  // route's static output cannot be written as a plain file AND host a child directory on one
  // filesystem (Next sidesteps this with a `.body` suffix; pnext mirrors output under public/, so
  // the file and the directory would collide). The ancestor keeps the physical file so it serves
  // statically; each descendant records its prerender-manifest entry but skips the physical copy
  // and serves dynamically. Descendants are detected up-front so the outcome is order-independent.
  const descendantHandlerIds = collectDescendantHandlerIds(routes)

  const isCompile = options.buildMode === 'compile'
  const isGenerate = options.buildMode === 'generate'
  const debugPrerender = options.debugPrerender ?? false
  // Record the build inputs the serving runtime needs (compat: --debug-prerender
  // selects the shape of the runtime 'use cache' error log). No-op for core.
  buildCompat().recordBuildFlags(config.outPath, debugPrerender)
  // Generate mode: Next prints the page-data banner, then ONLY prerender diagnostics until the
  // route table - the cache-components-errors suites capture everything after this line and
  // inline-snapshot it. Per-path lines are buffered and printed after a `Route (app)` header, which
  // ends the suites' capture window.
  const generateRouteLines: string[] = []
  /** Route ids that prerendered a partial (cache-components) shell — Next's `◐`. */
  const partialPrerenders = new Set<string>()
  /** Routes that failed generate-mode prerender diagnostics, in scan order. */
  const generateFailures: { route: string; omitErrorLine: boolean }[] = []
  if (isGenerate) console.log('   Collecting page data ...')

  // Route stylesheets build strictly after the document ones; this is the first
  // point that needs them, so everything above ran alongside the CSS worker.
  await documentCss

  for (const route of routes) {
    if (route.dynamicErrorApi) {
      console.error(
        `Error: Route ${toNextRoutePattern(route.route || '/')} with \`dynamic = "error"\` ` +
          `couldn't be rendered statically because it used ${route.dynamicErrorApi}. ` +
          `See more info here: https://nextjs.org/docs/app/building-your-application/rendering/static-and-dynamic#dynamic-rendering`,
      )
      hadDynamicErrorFailure = true
      continue
    }
    if (route.kind === 'handler') {
      if (isCompile) continue
      if (!(await staticRouteHandlerCandidate(route))) continue
      const dynamicUsage = await staticHandlerDynamicUsage(route)
      if (dynamicUsage) {
        console.log(
          `Caught Error: Dynamic server usage: Route ${route.route || '/'} couldn't be rendered statically because it used \`${dynamicUsage}\`.`,
        )
        continue
      }
      // A single handler prerender failure must not kill the whole build:
      // skip the static copy and let the route serve dynamically at runtime.
      try {
        Object.assign(
          staticFiles,
          await log.step(`route handler ${route.route}`, () =>
            buildStaticRouteHandler(config, route, {
              skipPhysicalWrite: descendantHandlerIds.has(route.id),
            }),
          ),
        )
      } catch (error) {
        rethrowIfProgrammingError(error)
        if (isAfterPrerenderError(error)) hadAfterPrerenderError = true
        warnSkippedStatic(route.route, error instanceof Error ? error.message : String(error))
      }
      continue
    }

    await buildRouteCss(config, route, { verbose })
    for (const reference of route.clientReferences) {
      await buildClientReferenceCss(config, reference, { verbose })
    }

    // Compile mode bundles only — every prerender/export step is generate's.
    if (isCompile) continue

    // Generate mode fails a cacheComponents route whose prerender would block,
    // with Next's exact diagnostic block (owner stack + codeframe under
    // --debug-prerender). Detected before any shell attempt so the failing
    // route emits nothing else into the captured output window.
    if (isGenerate && cacheComponents() && !route.client && !route.interception) {
      // Next names the route by its source pattern (`/use-cache-params/[slug]`),
      // not pnext's `:param` form — the diagnostics quote it verbatim.
      const diagnosticRoute = toNextRoutePattern(route.route || '/')
      const diagnostic = buildCompat().diagnoseCacheComponentsPrerender({
        route: diagnosticRoute,
        pageFile: route.file,
        appPath: config.appPath,
        debugPrerender,
      })
      if (diagnostic) {
        console.error(diagnostic)
        generateFailures.push({
          route: diagnosticRoute,
          omitErrorLine: buildCompat().diagnosticLeadsWithErrorLine(diagnostic),
        })
        continue
      }
    }

    if (route.ppr) {
      await log.step(`ppr shell ${route.route}`, () => buildPprShell(config, route))
      continue
    }

    // Under the global cacheComponents flag every page is a PPR candidate:
    // attempt a shell (a param-independent fallback shell for dynamic-param
    // routes). If dynamic data escapes every boundary the route falls through
    // to the normal static/dynamic build below.
    if (
      cacheComponents() &&
      !route.interception &&
      (!route.client || (route.params.length === 0 && !route.catchAll))
    ) {
      const built = await log.step(`cache-components shell ${route.route}`, () =>
        buildCacheComponentsShell(config, route),
      )
      if (built) {
        // Next marks a partially prerendered route with a distinct glyph in its build output, and
        // suites grep for it. That glyph is for a PARTIAL prerender: a shell with dynamic holes (or
        // blocked metadata), or a param FALLBACK shell whose params only resolve per request. A
        // hole-less shell of a fully-known route keeps Next's static marker.
        const paramFallback =
          (route.params.length > 0 || Boolean(route.catchAll)) && !route.hasStaticParams
        if (paramFallback || (route.pprHoles?.length ?? 0) > 0 || route.pprMetadata) {
          partialPrerenders.add(route.id)
        }
        if (isGenerate) generateRouteLines.push(`  ◐ ${route.route || '/'}`)
        continue
      }
    }
    // A whole-client page cannot consume hanging dynamic params during a shell
    // prerender. Keep it runtime-only until that boundary can postpone.
    if (cacheComponents() && route.client && (route.params.length > 0 || route.catchAll)) continue

    // Segment config gates prerendering: force-dynamic / revalidate 0 /
    // force-no-store routes are never prebuilt; force-static prerenders even
    // when the route reads request data (with an empty synthetic request,
    // Next-style).
    const segmentConfig = route.segmentConfig
    const forceStatic = segmentConfig?.dynamic === 'force-static'
    if (forceStatic && segmentConfig?.runtime === 'edge') {
      console.warn(
        `Page "${route.route}" is using runtime = 'edge' which is currently incompatible with dynamic = 'force-static'. Please remove either "runtime" or "force-static" for correct behavior`,
      )
    }
    const configForcesDynamic =
      segmentConfig?.dynamic === 'force-dynamic' ||
      segmentConfig?.revalidate === 0 ||
      segmentConfig?.fetchCache === 'force-no-store' ||
      // Next never statically prerenders `runtime = 'edge'` pages (they are
      // absent from its prerender manifest / static output); their data
      // stability comes from the fetch cache, not prebuilt HTML. force-static
      // keeps the existing (warned-about) prerender behavior.
      (segmentConfig?.runtime === 'edge' && !forceStatic)

    let staticParams: Awaited<ReturnType<typeof staticParamsFor>> | null = null
    if (!configForcesDynamic && route.hasStaticParams) {
      try {
        staticParams = await log.step(`static params ${route.route}`, () =>
          // Run generateStaticParams inside a prerender meta so an after()
          // scheduled there is drained (and its throw propagates) instead of
          // being logged-and-swallowed as a stray runtime after().
          getRenderExtensions()
            .collectRenderMeta(() => staticParamsFor(config, route), {
              route: route.route,
              prerender: true,
            })
            .then(result => result.value),
        )
      } catch (error) {
        rethrowIfProgrammingError(error)
        if (!isAfterPrerenderError(error)) throw error
        // Next reports a generateStaticParams failure with this exact prefix
        // (naming the route in `[param]` form), followed by the underlying
        // error (the thrown after() message).
        console.error(`Failed to collect page data for ${toNextRoutePattern(route.route)}`)
        console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
        hadAfterPrerenderError = true
        continue
      }
    }
    // Dynamic request APIs normally skip page prerendering. An unstable_cache
    // boundary is the exception: Next executes the fill during prerender so a
    // request API read inside it can fail the build at the exact call site.
    const validateUnstableCacheScope =
      !configForcesDynamic && route.usesRequest && !forceStatic && (await usesUnstableCache(route))
    const paramSets = staticParams
      ? staticParams.paths
      : validateUnstableCacheScope
        ? [{}]
        : configForcesDynamic || (route.usesRequest && !forceStatic)
          ? []
          : route.mode === 'static' && route.params.length === 0 && !route.catchAll
            ? [{}]
            : []
    // Partial sets included: dynamicParams=false checks match governed params
    // against these at request time.
    if (staticParams) route.prerenderedParams = staticParams.allSets
    // NEXT_DEBUG_BUILD parity: Next logs why a route that would otherwise have
    // been prerendered fell back to dynamic (the e2e suite greps this line).
    // This branch covers the request-API bailout (headers()/cookies() in the
    // tree); the no-store fetch bailout is logged after the prerender below.
    if (
      process.env.NEXT_DEBUG_BUILD &&
      paramSets.length === 0 &&
      !staticParams &&
      !configForcesDynamic &&
      route.usesRequest &&
      !forceStatic &&
      route.params.length === 0 &&
      !route.catchAll
    ) {
      logStaticBailout(route.route || '/', await requestApiBailoutReason(route))
    }
    if (paramSets.length === 0) {
      // Next prerenders every non-force-dynamic page and only marks it dynamic once a request API
      // throws, so a call that OUTLIVES the render (scheduled in a timer/microtask) escapes as a
      // build-time DynamicServerError instead. pnext's static scan skips those routes before
      // rendering, so probe just the ones that schedule deferred work - the only shape where the
      // call can outlive the render.
      if (
        !configForcesDynamic &&
        !forceStatic &&
        route.usesRequest &&
        route.params.length === 0 &&
        !route.catchAll &&
        (await schedulesDeferredWork(route))
      ) {
        await probeDeferredDynamicUsage(config, route, staticMetadataFiles, staticModuleMetadata)
      }
      continue
    }
    if (!forceStatic && (await needsRequestOriginForMetadataImages(config.appPath, route))) continue

    await log.step(
      `prerender ${route.route} (${paramSets.length} page${paramSets.length === 1 ? '' : 's'})`,
      async () => {
        for (const rawParams of paramSets) {
          // Next derives prerender params from the encoded URL it builds for a
          // generateStaticParams value, so a page sees `sticks%20%26%20stones`,
          // never the raw `sticks & stones` (prerender-encoding suite). File
          // layout and dynamicParams matching keep the raw values.
          const params = encodeStaticRouteParams(rawParams)
          const routePath = fillRoutePath(route.route, rawParams)
          const file = staticHtmlPath(config.outPath, routePath, flatExportLayout)
          const collision = staticOutputCollision(config.outPath, file)
          if (collision) {
            warnSkippedStatic(routePath, collision)
            continue
          }
          const url = new URL(`http://pnext.local${routePath}`)
          // A single page prerender failure must not kill the whole build:
          // skip the static copy and let the route serve dynamically.
          try {
            // Wrap in a work unit so a `use cache` cacheLife() during the render
            // stashes its effective revalidate/expire/stale (stashCacheLife
            // reads the work-unit scope). We read + persist it below so a pure
            // static HIT can re-emit the SWR headers from start.ts.
            let cacheLife: CacheLifeStash | undefined
            let fontLinkHeader: string | undefined
            let prerenderVary: BuildResponseVary | undefined
            const rendered = await runWithWorkUnit('render', async () => {
              const tracked = await buildCompat().withVaryParamsTracking(() =>
                getRenderExtensions().collectRenderMeta(
                  () =>
                    runWithNextBuildPhase(() =>
                      withRouteRuntime(route.segmentConfig?.runtime, () =>
                        renderPageWithStatus({
                          config,
                          route,
                          params,
                          url,
                          // Empty request so request APIs (cookies/headers) resolve
                          // to empty values instead of failing the prerender.
                          ...(route.usesRequest ? { request: new Request(url) } : {}),
                          staticMetadataFiles,
                          staticModuleMetadata,
                        }),
                      ),
                    ),
                  {
                    fetchCache: segmentConfig?.fetchCache,
                    route: routePath || '/',
                    prerender: true,
                  },
                ),
              )
              const result = tracked.value
              prerenderVary = tracked.vary
              cacheLife = buildCompat().takeCacheLifeStash()
              // A static prerender never runs the response finalizer that flushes
              // font preloads to the `Link` header, so bake it into the manifest
              // headers here (must read the work unit before it unwinds).
              fontLinkHeader = buildCompat().takeFontLinkHeader()
              return result
            })
            // Explicit no-store signals (fetch no-store/no-cache, revalidate
            // 0, unstable_noStore) keep the route dynamic — unless the
            // segment config explicitly opts into static/ISR output.
            const optedStatic =
              forceStatic ||
              typeof segmentConfig?.revalidate === 'number' ||
              segmentConfig?.revalidate === false
            if (rendered.noStore && !optedStatic) {
              if (process.env.NEXT_DEBUG_BUILD) logStaticBailout(routePath || '/', 'no-store fetch')
              continue
            }
            await writeText(file, rendered.value.html)
            recordPrerenderVary(route, routePath || '/', prerenderVary)
            // Prerendered paths print like Next's build output; tooling (and
            // the Next e2e suite) greps for them. Generate mode defers them
            // below the `Route (app)` header so the diagnostics capture window
            // stays clean.
            const routeLine = `${dim('  ○')} ${routePath || '/'}`
            if (isGenerate) generateRouteLines.push(routeLine)
            else console.log(routeLine)
            await emitConcreteNextPageArtifacts(config, route, routePath || '/', {
              html: rendered.value.html,
              status: rendered.value.status,
            })
            const relative = toPosixPath(path.relative(path.join(config.outPath, 'public'), file))
            const revalidateSeconds = combineRevalidate(
              segmentConfig?.revalidate,
              rendered.revalidateSeconds,
            )
            // A `use cache` render stashes its effective cacheLife; the SWR
            // cache-control + x-nextjs-stale-time normally come from a response
            // finalizer, but a pure static HIT never re-renders, so we bake the
            // header strings and the expire/stale windows into the manifest so
            // start.ts can re-emit them on the HIT. The work-unit stash is empty
            // when the build prerender ran without a request work unit; the
            // render cache meta carries the same windows, so fall back to it.
            const defaultExpireTime = buildCompat().defaultExpireTimeSeconds()
            const effectiveCacheLife: CacheLifeStash | undefined =
              cacheLife ??
              (rendered.expireSeconds !== undefined || rendered.staleSeconds !== undefined
                ? {
                    ...(revalidateSeconds !== undefined ? { revalidateSeconds } : {}),
                    ...(rendered.expireSeconds !== undefined
                      ? { expireSeconds: rendered.expireSeconds }
                      : {}),
                    ...(rendered.staleSeconds !== undefined
                      ? { staleSeconds: rendered.staleSeconds }
                      : {}),
                  }
                : revalidateSeconds !== undefined && defaultExpireTime !== undefined
                  ? {
                      revalidateSeconds,
                      expireSeconds: defaultExpireTime,
                    }
                  : undefined)
            const cacheLifeHeaders = cacheLifeResponseHeaders(effectiveCacheLife)
            const headers: [string, string][] = [
              ...(rendered.value.location
                ? [['location', rendered.value.location] as [string, string]]
                : []),
              ...(fontLinkHeader ? [['link', fontLinkHeader] as [string, string]] : []),
              ...cacheLifeHeaders,
            ]
            staticFiles[relative] = {
              status: rendered.value.status,
              headers,
              routeId: route.id,
              kind: 'page',
              ...(revalidateSeconds !== undefined ? { revalidateSeconds } : {}),
              ...(effectiveCacheLife?.expireSeconds !== undefined
                ? { expireSeconds: effectiveCacheLife.expireSeconds }
                : {}),
              ...(effectiveCacheLife?.staleSeconds !== undefined
                ? { staleSeconds: effectiveCacheLife.staleSeconds }
                : {}),
              ...(rendered.tags.length > 0 ? { tags: rendered.tags } : {}),
            }
          } catch (error) {
            rethrowIfProgrammingError(error)
            if (isAfterPrerenderError(error)) hadAfterPrerenderError = true
            warnSkippedStatic(routePath, error instanceof Error ? error.message : String(error))
          }
        }
      },
    )
  }

  // Generate-mode prerender diagnostics fail the pass with Next's exact
  // export-error footer, then end the e2e capture window the way Next's
  // crashed build worker does. Everything before this printed at detection.
  if (isGenerate && generateFailures.length > 0) {
    for (const failed of generateFailures) {
      console.error(
        buildCompat().prerenderFailureFooter(failed.route, debugPrerender, failed.omitErrorLine),
      )
    }
    console.error('Next.js build worker exited with code: 1 and signal: null')
    process.exit(1)
  }
  if (isGenerate) {
    console.log('\nRoute (app)')
    for (const line of generateRouteLines) console.log(line)
  }

  // A render may intentionally turn an exception into a 500 response so the
  // dev server can stay alive. During a production build, however, an emitted
  // module that cannot resolve one of its content-addressed dependencies makes
  // the output unusable and must remain fatal even after that recovery path.
  throwIfModuleGraphFailed()

  // Fail the build after every route has been given the chance to log its
  // prerender error (matching `prerenderEarlyExit: false`).
  if (hadAfterPrerenderError) {
    throw new Error('Build failed because an error was thrown inside `after()` while prerendering.')
  }
  if (hadDynamicErrorFailure) {
    throw new Error(
      'Build failed because a route with `dynamic = "error"` read dynamic data during prerendering.',
    )
  }

  const interceptionPrerenders = isCompile
    ? new Map<string, string[]>()
    : await logInterceptionPrerenders(config, routes)

  const fallback404 = await notFoundDocuments
  await emitNextNotFoundArtifacts(config, fallback404)
  await emitProxyServerArtifacts(config, proxyModule)

  // Next always prerenders the built-in `/_not-found` and `/_global-error`
  // pseudo-routes for an app-router build (even when the app ships no custom
  // not-found / global-error file). The harness synthesizes its
  // prerender-manifest `routes` from staticFiles, and several suites assert the
  // exact prerendered route set (metadata-static-generation, cache-components,
  // metadata-dynamic-routes). Register the entries so they surface. No backing
  // file is required: the runtime static lookup keys off files that exist on
  // disk, so a fileless manifest entry is inert at request time.
  if (config.compat?.next) {
    // `/_global-error` only prerenders when the app has a singular top-level
    // root layout; with route-group root layouts (no app/layout.*) Next skips
    // it and the prerender manifest omits the route. The hybrid pages+app
    // materializer synthesizes an app/layout.js, so inspect the ORIGINAL app
    // (the shim's `source-app` symlink) when it exists.
    const sourceApp = path.join(config.appPath, '..', 'source-app')
    const layoutRoot = existsSync(sourceApp) ? sourceApp : config.appPath
    const hasTopLevelRootLayout = ['tsx', 'ts', 'jsx', 'js'].some(ext =>
      existsSync(path.join(layoutRoot, `layout.${ext}`)),
    )
    const pseudos = hasTopLevelRootLayout
      ? ['_not-found.html', '_global-error.html']
      : ['_not-found.html']
    for (const pseudo of pseudos) {
      if (!(pseudo in staticFiles)) {
        staticFiles[pseudo] = { status: 200, headers: [], kind: 'page' }
      }
    }
  }

  // The action modules' server compile ran under the client stage; the manifest
  // carries its entries, so this is where it has to have landed.
  await deferredSteps
  const actions = buildState.actions
  const manifest: BuildManifest = {
    version: 0,
    root: config.root,
    appDir: config.appPath,
    outDir: config.outPath,
    routes,
    staticFiles,
    // The serving process re-publishes these so a render resolves the same
    // content-hashed names the build emitted.
    assetNames: emittedAssetNames(config.outPath),
    staticMetadataFiles,
    ...(Object.keys(staticModuleMetadata).length > 0 ? { staticModuleMetadata } : {}),
    ...(!config.compat?.next
      ? {
          staticRouteMetadata: await log.step('core route metadata', () =>
            collectStaticRouteMetadata(config, routes, staticMetadataFiles),
          ),
        }
      : {}),
    ...(proxyModule ? { proxyModule } : {}),
    ...(actions.length > 0 ? { actions } : {}),
  }
  await writeBuildManifest(config.outPath, manifest)
  log.log(`wrote manifest.json (${routes.length} route${routes.length === 1 ? '' : 's'})`)
  await log.step('server entry', () => serverEntryDone)
  for (const hook of getBuildExtensions().completeHooks) {
    await hook({ config, manifest, log })
  }
  if (options.adapter === 'vercel')
    await log.step('vercel adapter output', () =>
      writeVercelOutput(config, manifest, { verbose, warm }),
    )
  // Plain build: the adapter owns the child in the branch above. Compiling the
  // rest of the app's modules is build work, so it counts toward the build's own
  // duration rather than hiding after it.
  else await log.step('warm module cache', () => warm.finish(log))

  // Also cover module loads performed by completion hooks or the warm pass.
  throwIfModuleGraphFailed()

  // Bundling is done; the build metric stops here. Phases that ran alongside it
  // (typecheck) are awaited next and reported on their own lines.
  const buildDurationMs = performance.now() - startedAt
  const phases = await settleBuildParallelPhases()
  flushDevModuleCaches()
  await writeBuildCache(config, options, cached)

  printBuildSummary(
    config,
    routes,
    staticFiles,
    buildDurationMs,
    Boolean(proxyModule),
    interceptionPrerenders,
    partialPrerenders,
    phases,
  )
  return manifest
}

/** Run build steps in registration order, each timed under its own label. */
async function runBuildSteps(steps: BuildStep[], ctx: BuildStepContext) {
  for (const [index, step] of steps.entries()) {
    await ctx.log.step(`build step ${step.name || index}`, () => step(ctx))
  }
}

/** Await every background phase, returning each one's own elapsed time. */
async function settleBuildParallelPhases() {
  const phases = getBuildExtensions().parallelPhases
  const timings: { name: string; durationMs: number }[] = []
  for (const phase of phases) timings.push({ name: phase.name, durationMs: await phase.run })
  return timings
}

/**
 * Interception routes that export generateStaticParams are prerendered as FLIGHT-ONLY entries:
 * their paths are reported in the build output, but no public HTML document is written. An
 * intercepted view only ever renders inside its host page, and a hard navigation to the underlying
 * URL must keep hitting the real route - writing `/(.)john/1.html` would shadow neither, just add
 * dead output. Returns the display paths per route id.
 */
async function logInterceptionPrerenders(
  config: Awaited<ReturnType<typeof loadConfig>>,
  routes: RouteManifestEntry[],
): Promise<Map<string, string[]>> {
  const prerenders = new Map<string, string[]>()
  for (const route of routes) {
    if (route.kind !== 'page' || !route.interception) continue
    if (!routeFileExportsStaticParams(route.file)) continue
    let paths: string[]
    try {
      const staticParams = await staticParamsFor(config, route)
      paths = staticParams.paths.map(params =>
        interceptionDisplayRoute(route, fillRoutePath(route.route, params)),
      )
    } catch (error) {
      rethrowIfProgrammingError(error)
      warnSkippedStatic(route.route, error instanceof Error ? error.message : String(error))
      continue
    }
    if (paths.length === 0) continue
    prerenders.set(route.id, paths)
    for (const routePath of paths) console.log(`${dim('  ○')} ${routePath}`)
  }
  return prerenders
}

function routeFileExportsStaticParams(file: string): boolean {
  if (!existsSync(file)) return false
  const source = readTextSync(file)
  return (
    /\bexport\s+(?:async\s+)?function\s+generateStaticParams\b/.test(source) ||
    /\bexport\s+const\s+generateStaticParams\b/.test(source)
  )
}

/**
 * How Next names an interception route: its on-disk path with route groups and
 * `@slot` segments removed, so the marker stays visible
 * (`/(.)[username]/[id]`, `/generate-static-params/(.)[slug]`). `route.route`
 * has already resolved the marker away (that IS the intercepted target), so the
 * marker is re-inserted at the segment the rewind landed on.
 */
function interceptionDisplayRoute(route: RouteManifestEntry, filled?: string): string {
  const interception = route.interception
  if (!interception) return route.route
  const base = interception.base === '/' ? [] : interception.base.split('/').filter(Boolean)
  const levels = interceptionMarkerLevels(interception.marker)
  const target = (filled ?? toNextRoutePattern(route.route)).split('/').filter(Boolean)
  // `route.route` is `<kept base>/<segments below the marker>`; the marker dir
  // itself is the first segment past what the rewind kept.
  const cut = Number.isFinite(levels) ? Math.max(0, base.length - levels) : 0
  const below = target.slice(cut)
  const segments = [...base, `${interception.marker}${below[0] ?? ''}`, ...below.slice(1)]
  return `/${segments.join('/')}`
}

async function writeBuildManifest(outPath: string, manifest: BuildManifest) {
  assertManifestServerArtifacts(outPath, manifest)
  const file = path.join(outPath, 'manifest.json')
  const temporary = path.join(outPath, `.manifest-${process.pid}.tmp`)
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`)
  await rename(temporary, file)
}

function assertManifestServerArtifacts(outPath: string, manifest: BuildManifest) {
  const artifacts = [
    ...(manifest.proxyModule ? [manifest.proxyModule] : []),
    ...(manifest.actions?.map(action => action.modulePath) ?? []),
  ]
  for (const artifact of artifacts) {
    const file = path.resolve(outPath, artifact)
    if (file !== outPath && !file.startsWith(`${outPath}${path.sep}`)) {
      throw new Error(`Build manifest server artifact escapes output directory: ${artifact}`)
    }
    if (!existsSync(file)) {
      throw new Error(`Build manifest server artifact is missing: ${artifact}`)
    }
  }
}

function printBuildSummary(
  config: Awaited<ReturnType<typeof loadConfig>>,
  routes: RouteManifestEntry[],
  staticFiles: Record<string, StaticFileMetadata>,
  durationMs: number,
  hasMiddleware = false,
  interceptionPrerenders = new Map<string, string[]>(),
  partialPrerenders = new Set<string>(),
  parallelPhases: { name: string; durationMs: number }[] = [],
) {
  const pages = routes.filter(route => route.kind !== 'handler').length
  const handlers = routes.length - pages
  const parts = [`${pages} ${pages === 1 ? 'page' : 'pages'}`]
  if (handlers > 0) parts.push(`${handlers} ${handlers === 1 ? 'route handler' : 'route handlers'}`)
  const outDir = path.relative(config.root, config.outPath) || '.'

  // Route table: ○ static, ● SSG (params), ◐ partial prerender, ƒ dynamic.
  console.log('')
  console.log('Route (app)')
  for (const route of routes) {
    const intercepted = interceptionPrerenders.get(route.id)
    const marker =
      route.kind === 'handler'
        ? Object.values(staticFiles).some(file => file.routeId === route.id)
          ? '○'
          : 'ƒ'
        : intercepted
          ? '●'
          : partialPrerenders.has(route.id)
            ? '◐'
            : route.mode === 'dynamic' && !route.hasStaticParams
              ? 'ƒ'
              : route.hasStaticParams
                ? '●'
                : '○'
    // An interception route is named by its own directory path (marker kept),
    // never by the target route it resolves to — which is a real route of its own.
    const label = route.interception ? interceptionDisplayRoute(route) : route.route || '/'
    // Next names a dynamic route by its source pattern (`/[dyn]`), not pnext's
    // `:param` form; compat apps' e2e output is matched against Next's.
    console.log(`  ${marker} ${nextCompatEnabled(config) ? toNextRoutePattern(label) : label}`)
  }
  for (const file of staticMetadataSummaryFiles(staticFiles)) {
    console.log(`  ${dim('○')} /${file}`)
  }
  if (hasMiddleware) {
    console.log('')
    console.log(`  ${dim('ƒ')} Middleware`)
  }
  console.log('')
  console.log(
    `${green('✓')} ${bold('Build complete')} ${dim(`in ${formatBuildDuration(durationMs)}`)}`,
  )
  // Phases that ran alongside the build are their own metric, never folded into
  // the build time — a typecheck fully hidden behind bundling costs 0 wall.
  for (const phase of parallelPhases) {
    console.log(
      `${green('✓')} ${bold(`${phase.name} complete`)} ${dim(`in ${formatBuildDuration(phase.durationMs)}`)}`,
    )
  }
  console.log(`  ${dim(`${parts.join(', ')} → ${outDir}`)}`)
  console.log('')
  console.log(`  Serve the production build: ${cyan('pnext start')}`)
  console.log(`  Analyze the build: ${cyan('pnext analyze')}`)
}

function staticMetadataSummaryFiles(staticFiles: Record<string, StaticFileMetadata>) {
  return Object.entries(staticFiles)
    .filter(([, metadata]) =>
      metadata.headers.some(
        ([name, value]) =>
          name.toLowerCase() === 'cache-control' && value === staticMetadataCacheControl,
      ),
    )
    .map(([file]) => file)
    .sort()
}

function formatBuildDuration(durationMs: number) {
  const totalSeconds = Math.max(0, durationMs) / 1000
  if (totalSeconds < 60) return `${totalSeconds.toFixed(totalSeconds < 10 ? 2 : 1)}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.round(totalSeconds % 60)
  return `${minutes}m ${seconds}s`
}

/**
 * Effective cacheLife + cache tags collected from a shell prerender. A `use
 * cache` page never re-runs its cache scopes when served from prebuilt output,
 * so its SWR cache-control / x-nextjs-stale-time / x-next-cache-tags headers
 * must be captured here and baked into the segment `.meta` (and re-emitted from
 * start.ts on a static HIT). Mirrors the static-prerender loop's capture.
 */
interface ShellCacheMeta {
  cacheLife?: CacheLifeStash
  tags: string[]
  /** Prerendered `Link` header (font preloads + react-dom resource hints). */
  linkHeader?: string
}

/** A baked partial/fallback shell (renderPartialShell's non-null result). */
type PrebuiltShell = NonNullable<Awaited<ReturnType<typeof renderPartialShell>>>

/**
 * Render a shell (partial/fallback) inside a work unit + render cache-meta scope
 * so the `use cache` cacheLife stash and the collected cache tags survive for
 * the caller to persist. Returns the shell (or null when dynamic data escaped).
 */
async function renderShellWithCacheMeta(
  config: Awaited<ReturnType<typeof loadConfig>>,
  route: RouteManifestEntry,
  render: () => Promise<PrebuiltShell | null>,
): Promise<{
  prebuilt: PrebuiltShell | null
  meta: ShellCacheMeta
  vary: BuildResponseVary | undefined
}> {
  // A shell prerender resolves its `use cache` scopes asynchronously and the cacheLife-to-work-unit
  // stash is not in scope during that propagation. collectRenderMeta's render cache-meta IS, so the
  // effective revalidate/expire/stale windows come back on the result.
  let linkHeader: string | undefined
  // A BAKED segment is rendered here, outside any request, so without this scope its param accesses
  // are never tracked and the artifact ships with no vary set - which keys every prerendered route
  // on its exact URL and re-fetches the shared shell for every param value.
  const tracked = await buildCompat().withVaryParamsTracking(async () =>
    runWithWorkUnit('render', async () => {
      const rendered = await getRenderExtensions().collectRenderMeta(
        () => runWithNextBuildPhase(render),
        {
          fetchCache: route.segmentConfig?.fetchCache,
          route: route.route || '/',
          prerender: true,
        },
      )
      // Font preloads + react-dom preload() hints recorded during the shell
      // render become the route's serve-time `Link` header (a PPR resume never
      // re-runs the components that emitted them). Read before the unit unwinds.
      linkHeader = buildCompat().takeFontLinkHeader()
      return rendered
    }),
  )
  const result = tracked.value
  const cacheLife: CacheLifeStash | undefined =
    result.revalidateSeconds !== undefined ||
    result.expireSeconds !== undefined ||
    result.staleSeconds !== undefined
      ? {
          ...(result.revalidateSeconds !== undefined
            ? { revalidateSeconds: result.revalidateSeconds }
            : {}),
          ...(result.expireSeconds !== undefined ? { expireSeconds: result.expireSeconds } : {}),
          ...(result.staleSeconds !== undefined ? { staleSeconds: result.staleSeconds } : {}),
        }
      : undefined
  return {
    prebuilt: result.value,
    meta: {
      ...(cacheLife ? { cacheLife } : {}),
      tags: result.tags,
      ...(linkHeader ? { linkHeader } : {}),
    },
    vary: tracked.vary,
  }
}

/**
 * `use cache` entries whose expiry falls inside Next's DYNAMIC_EXPIRE window (5 minutes - the
 * `seconds` cacheLife profile, or an explicit short `expire`) are OMITTED from the prerender the
 * client prefetches: such data is not worth prefetching, so its boundary stays a hole the
 * navigation fills live.
 */
const DYNAMIC_EXPIRE_SECONDS = 300

/**
 * True when the route's own sources declare a cacheLife that expires inside the dynamic-expire
 * window. A cheap source scan used purely to decide whether the extra prefetch-shell prerender below
 * is worth running - every other route keeps a single shell render.
 */
function routeDeclaresShortLivedCache(route: RouteManifestEntry): boolean {
  for (const file of route.sourceFiles) {
    if (!existsSync(file)) continue
    const source = readTextSync(file)
    for (const literal of source.matchAll(/cacheLife\s*\(\s*\{[^}]*\bexpire\s*:\s*([^,}]+)/gs)) {
      const value = staticNumberExpression(literal[1]!)
      if (value !== undefined && value < DYNAMIC_EXPIRE_SECONDS) return true
    }
    for (const named of source.matchAll(/cacheLife\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const expire = builtInCacheLifeExpire(named[1]!)
      if (expire !== undefined && expire < DYNAMIC_EXPIRE_SECONDS) return true
    }
  }
  return false
}

/**
 * The shell to publish as the route's PREFETCH body segment. pnext bakes ONE shell and serves it
 * both as the HTML document and as the body segment, so a route with a short-lived cache gets a
 * SECOND prerender whose `use cache` gate omits that cache. Only that render feeds the segment
 * artifacts - the prerendered document keeps the cached block inline. Undefined when the route needs
 * no separate prefetch body, or the gated render produced no shell.
 */
async function renderPrefetchBody(
  config: Awaited<ReturnType<typeof loadConfig>>,
  route: RouteManifestEntry,
  render: () => Promise<PrebuiltShell | null>,
): Promise<{ prebuilt: PrebuiltShell; vary: BuildResponseVary | undefined } | undefined> {
  if (!routeDeclaresShortLivedCache(route)) return undefined
  try {
    const { prebuilt, vary } = await renderShellWithCacheMeta(config, route, render)
    return prebuilt ? { prebuilt, vary } : undefined
  } catch {
    // Best-effort: the document shell doubles as the prefetch body, as before.
    return undefined
  } finally {
    abortActivePrerenderScopes()
  }
}

async function buildPprShell(
  config: Awaited<ReturnType<typeof loadConfig>>,
  route: RouteManifestEntry,
) {
  const url = new URL(`http://pnext.local${route.route}`)
  // Render under the production-build phase so build-phase sentinels
  // (process.env.NEXT_PHASE) resolve to their buildtime value in the shell.
  const { prebuilt, meta, vary } = await renderShellWithCacheMeta(config, route, () =>
    renderPartialShell({ config, route, url }),
  )
  if (!prebuilt) {
    // Dynamic data escaped every Suspense boundary — there is no static shell to
    // bake, so drop the PPR flag and let the route render fully dynamically.
    route.ppr = false
    return
  }
  route.pprHoles = prebuilt.holes
  route.pprMetadata = prebuilt.metadataDynamic || undefined
  persistRouteCacheLife(route, meta.cacheLife)
  recordRouteCacheTags(route, meta.tags)
  if (meta.linkHeader) route.linkHeader = meta.linkHeader
  const file = pprShellPath(config.outPath, route.id)
  await mkdir(path.dirname(file), { recursive: true })
  await writeText(file, prebuilt.shell)
  const prefetchBody = (await renderPrefetchBody(config, route, () =>
    renderPartialShell({ config, route, url, prefetchShell: true }),
  )) ?? { prebuilt, vary }
  await emitSegmentArtifacts(
    config,
    route,
    prefetchBody.prebuilt.shell,
    prefetchBody.prebuilt.holes.length > 0,
    meta,
    undefined,
    prefetchBody.vary,
    // renderPartialShell against the PATTERN url: a route-level, params-hanging
    // render, so an empty tracked set is honest (see buildVaryTrusted).
    true,
  )
}

/** Union shell-prerender cache tags onto the route (PPR-shell tag staleness). */
function recordRouteCacheTags(route: RouteManifestEntry, tags: readonly string[]): void {
  if (tags.length === 0) return
  route.cacheTags = [...new Set([...(route.cacheTags ?? []), ...tags])]
}

/** Persist a shell render's effective cacheLife on the route so the static-serve
 * path (start.ts) can re-emit the SWR cache-control + x-nextjs-stale-time headers
 * on a pure static HIT/MISS (the header finalizer only fires on a live render). */
function persistRouteCacheLife(route: RouteManifestEntry, life: CacheLifeStash | undefined): void {
  if (!life) return
  route.cacheLife = {
    ...(life.revalidateSeconds !== undefined ? { revalidateSeconds: life.revalidateSeconds } : {}),
    ...(life.expireSeconds !== undefined ? { expireSeconds: life.expireSeconds } : {}),
    ...(life.staleSeconds !== undefined ? { staleSeconds: life.staleSeconds } : {}),
  }
}

/**
 * Emit the per-route segment artifacts (Stage D M2) alongside a baked shell:
 * `_tree.segment.rsc` (the RootTreePrefetch), `index.segment.rsc` (the route
 * body as one segment), and `route.segment.meta` (status/postponed/segmentPaths).
 * The segment prefetch responder serves these; the client segment cache stitches
 * the body fragment on navigation. Whole-route single-segment milestone.
 */
async function emitSegmentArtifacts(
  config: Awaited<ReturnType<typeof loadConfig>>,
  route: RouteManifestEntry,
  body: string,
  postponed: boolean,
  cacheMeta?: ShellCacheMeta,
  statusOverride?: number,
  vary?: BuildResponseVary,
  /** The body came from the ROUTE-LEVEL shell render, whose params hung. An
   *  EMPTY tracked set is then the truth (a param read would have postponed and
   *  left a hole), not the untracked-render artifact `buildVaryTrusted`
   *  otherwise defends against. Never pass `true` for a CONCRETE-param render. */
  fallbackParamsRender = false,
): Promise<void> {
  const isStatic = route.mode === 'static' && !postponed
  const compat = buildCompat()
  const staleTime =
    staleTimeFromRouteSources(route) ??
    (isStatic ? compat.defaultStaticStaleTimeSeconds : compat.defaultDynamicStaleTimeSeconds)
  const bodySizeBytes = Buffer.byteLength(body)
  const tree = compat.buildRootTreePrefetch({
    pathname: route.route,
    isStatic,
    staleTimeSeconds: staleTime,
    routeId: route.id,
    bodySizeBytes,
    postponed,
    runtimePrefetch:
      (route.segmentConfig as { prefetch?: unknown } | undefined)?.prefetch === 'allow-runtime',
    // The route's <title> is dynamic and ships as its own `/_head` response;
    // announcing it in the TREE lets the client fetch the head before the body
    // (Next's response order) instead of learning it from the body response.
    // A route with dynamic PARAMS answers that head FIRST: its body is shared
    // across param values while the head varies per URL. A PARAMLESS route's
    // head is outlined out of its single body response and follows it.
    ...(route.pprMetadata === true
      ? { headOutlined: true, ...(/[:*]/.test(route.route) ? { headFirst: true } : {}) }
      : {}),
  })
  const meta = compat.buildSegmentMeta({
    status: statusOverride ?? 200,
    staleTime,
    postponed,
    bodySizeBytes,
    prefetchHints: { [route.route]: tree.tree.prefetchHints },
    ...(vary && buildVaryTrusted(route, vary, fallbackParamsRender) ? { vary } : {}),
  })
  await mkdir(compat.segmentDir(config.outPath, route.id), { recursive: true })
  await writeText(compat.treeSegmentFile(config.outPath, route.id), JSON.stringify(tree))
  await writeText(compat.bodySegmentFile(config.outPath, route.id), body)
  await writeText(compat.segmentMetaFile(config.outPath, route.id), JSON.stringify(meta))
  await emitNextSegmentArtifacts(
    config.root,
    route,
    body,
    compat.rootTreePrefetchText(tree, 'flight'),
    meta,
    segmentMetaHeaders(cacheMeta),
  )
}

/**
 * Whether a BUILD render's tracked vary set may be persisted as the route's published set. Mirrors
 * the request path's `varyTrusted`: an EMPTY set on a params-bearing route is more often an artifact
 * (nothing was tracked) than the truth, and under-varying serves one param's content for another, so
 * such a render stays "unknown" (exact-URL keying).
 *
 * The exception is a ROUTE-LEVEL shell render (`fallbackParamsRender`): its params HANG, so a
 * component that read one postponed and left a hole instead of recording an access. The empty set is
 * then the truth - the baked bytes are param-independent by construction.
 */
/**
 * Persist a concrete-param prerender's tracked vary sets on the route entry. The request-time render
 * of such a URL is answered from the prerender, so it executes no user code and tracks nothing;
 * without this the response publishes no vary set and every param value keys its own entry. Only a
 * set the render really recorded is kept - an empty one on a params-bearing route is the
 * untracked-render artifact `buildVaryTrusted` guards against.
 */
function recordPrerenderVary(
  route: RouteManifestEntry,
  routePath: string,
  vary: BuildResponseVary | undefined,
): void {
  if (!vary || !buildVaryTrusted(route, vary, false)) return
  if (vary.params.length === 0 && !vary.search) return
  route.prerenderVary ??= {}
  route.prerenderVary[routePath] = {
    vary: buildCompat().varyNamesFor(vary, 'body'),
    layoutVary: buildCompat().varyNamesFor(vary, 'layout'),
    pageVary: buildCompat().varyNamesFor(vary, 'page'),
  }
}

function buildVaryTrusted(
  route: RouteManifestEntry,
  vary: BuildResponseVary,
  fallbackParamsRender: boolean,
): boolean {
  if (vary.params.length > 0 || vary.search) return true
  if (fallbackParamsRender) return true
  return route.params.length === 0 && !route.catchAll
}

/**
 * The Next-shaped `<route>.meta` `headers` a `use cache` prerender contributes:
 * the SWR cache-control, x-nextjs-stale-time (from cacheLife), and the joined
 * x-next-cache-tags (from the render's collected cache tags). Suites read these
 * directly off the `.meta` sidecar (use-cache: stale config / unstable_cache
 * tags). Empty when the route declared no cacheLife and no tags.
 */
function segmentMetaHeaders(cacheMeta: ShellCacheMeta | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  if (!cacheMeta) return headers
  for (const [key, value] of cacheLifeResponseHeaders(cacheMeta.cacheLife)) headers[key] = value
  if (cacheMeta.tags.length > 0) headers['x-next-cache-tags'] = cacheMeta.tags.join(',')
  return headers
}

async function emitNextSegmentArtifacts(
  root: string,
  route: RouteManifestEntry,
  body: string,
  tree: string,
  meta: SegmentMeta,
  headers: Record<string, string> = {},
): Promise<void> {
  const appPath = nextAppRoutePath(route.route)
  const appFile = path.join(root, '.next', 'server', 'app', appPath)
  const segmentsDir = `${appFile}.segments`
  const nextMeta = {
    status: meta.status,
    // Next's page `.meta` carries the route's response headers (x-nextjs-stale-
    // time, x-next-cache-tags, SWR cache-control) so tooling/suites read a
    // prerendered `use cache` route's effective cache config off disk.
    headers,
    staleTime: meta.staleTime,
    ...(meta.postponed ? { postponed: '1' } : {}),
    segmentPaths: meta.segmentPaths,
    ...(meta.segmentSizes ? { segmentSizes: meta.segmentSizes } : {}),
    ...(meta.inlinedSegmentPaths ? { inlinedSegmentPaths: meta.inlinedSegmentPaths } : {}),
    ...(meta.prefetchHints ? { prefetchHints: meta.prefetchHints } : {}),
  }

  await mkdir(segmentsDir, { recursive: true })
  // A baked shell is stored OPEN (no closing tags) so the serve path can stream resumed holes into
  // it. Next's equivalent file is instead the finished document whenever nothing was postponed, and
  // suites tell a complete prerender from an incomplete shell by testing for the `</html>` tail.
  // Close a hole-free shell here; a postponed one stays open, exactly as Next leaves its partials.
  await writeText(`${appFile}.html`, meta.postponed ? body : `${body}\n  </body></html>`)
  await writeText(`${appFile}.meta`, JSON.stringify(nextMeta))
  await writeText(path.join(segmentsDir, '_tree.segment.rsc'), tree)
  await writeText(path.join(segmentsDir, '_full.segment.rsc'), body)
  await writeText(path.join(segmentsDir, '_index.segment.rsc'), body)

  const routeSegment = appPath === 'index' ? '__PAGE__' : appPath
  await writeNestedSegment(segmentsDir, `${routeSegment}.segment.rsc`, body)
  await writeNestedSegment(segmentsDir, path.join(routeSegment, '__PAGE__.segment.rsc'), body)
}

/**
 * Emit Next-shaped `.next/server/app/<path>.{html,meta}` + `.segments/
 * _tree.segment.rsc` for one CONCRETE statically prerendered page path (a
 * generateStaticParams entry or a param-free static page), carrying the real
 * prerender STATUS (404 for a notFound() prerender, 403 forbidden, 401
 * unauthorized). The http-access-fallback-prerender suite reads these directly
 * (`meta.status`, `meta.segmentPaths` containing '/_tree', the tree segment
 * file). cacheComponents-only: the classic static path keeps its existing
 * artifact set.
 */
async function emitConcreteNextPageArtifacts(
  config: Awaited<ReturnType<typeof loadConfig>>,
  route: RouteManifestEntry,
  routePath: string,
  rendered: { html: string; status: number; postponed?: boolean },
): Promise<void> {
  if (!config.compat?.next || !cacheComponents()) return
  const compat = buildCompat()
  const postponed = rendered.postponed ?? false
  const bodySizeBytes = Buffer.byteLength(rendered.html)
  const staleTime = staleTimeFromRouteSources(route) ?? compat.defaultStaticStaleTimeSeconds
  const tree = compat.buildRootTreePrefetch({
    pathname: routePath,
    isStatic: !postponed,
    staleTimeSeconds: staleTime,
    routeId: route.id,
    bodySizeBytes,
    postponed,
  })
  const meta = compat.buildSegmentMeta({
    status: rendered.status,
    staleTime,
    postponed,
    bodySizeBytes,
  })
  const appFile = path.join(config.root, '.next', 'server', 'app', nextAppRoutePath(routePath))
  const segmentsDir = `${appFile}.segments`
  await mkdir(segmentsDir, { recursive: true })
  await writeText(`${appFile}.html`, rendered.html)
  await writeText(
    `${appFile}.meta`,
    JSON.stringify({
      status: meta.status,
      headers: {},
      staleTime: meta.staleTime,
      ...(postponed ? { postponed: '1' } : {}),
      segmentPaths: meta.segmentPaths,
      ...(meta.segmentSizes ? { segmentSizes: meta.segmentSizes } : {}),
    }),
  )
  await writeText(
    path.join(segmentsDir, '_tree.segment.rsc'),
    compat.rootTreePrefetchText(tree, 'flight'),
  )
}

function staleTimeFromRouteSources(route: RouteManifestEntry): number | undefined {
  let found: number | undefined
  for (const file of route.sourceFiles) {
    if (!existsSync(file)) continue
    const source = readTextSync(file)
    for (const literal of source.matchAll(/cacheLife\s*\(\s*\{[^}]*\bstale\s*:\s*([^,}]+)/gs)) {
      const value = staticNumberExpression(literal[1]!)
      if (value !== undefined) found = minDefined(found, value)
    }
    for (const named of source.matchAll(/cacheLife\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const namedValue = builtInCacheLifeStale(named[1]!)
      if (namedValue !== undefined) found = minDefined(found, namedValue)
    }
  }
  return found
}

function readTextSync(file: string): string {
  try {
    return existsSync(file) && statSync(file).isFile() ? readFileSync(file, 'utf8') : ''
  } catch {
    return ''
  }
}

function staticNumberExpression(expression: string): number | undefined {
  const trimmed = expression.trim()
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed)
  const product = trimmed.split('*').map(part => part.trim())
  if (product.length > 1 && product.every(part => /^\d+(?:\.\d+)?$/.test(part))) {
    return product.reduce((value, part) => value * Number(part), 1)
  }
  return undefined
}

function builtInCacheLifeStale(profile: string): number | undefined {
  switch (profile) {
    case 'seconds':
      // Caches on the 'seconds' profile are OMITTED from static prerenders
      // (their client stale window is below the runtime threshold), so their
      // staleness must not shorten the route's prefetch expiry — only the
      // longer-lived caches that actually land in the prerender count.
      return undefined
    case 'default':
    case 'minutes':
    case 'hours':
    case 'days':
    case 'weeks':
    case 'max':
      return 300
    default:
      return undefined
  }
}

/** `expire` (seconds) of a built-in cacheLife profile. */
function builtInCacheLifeExpire(profile: string): number | undefined {
  switch (profile) {
    case 'seconds':
      return 60
    case 'minutes':
      return 3600
    case 'hours':
      return 86400
    case 'days':
      return 604800
    case 'weeks':
      return 2592000
    case 'default':
    case 'max':
      return 31536000
    default:
      return undefined
  }
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.min(a, b)
}

async function writeNestedSegment(root: string, relative: string, body: string): Promise<void> {
  const file = path.join(root, relative)
  await mkdir(path.dirname(file), { recursive: true })
  await writeText(file, body)
}

function nextAppRoutePath(route: string): string {
  return route.replace(/^\/+/, '') || 'index'
}

/**
 * True when a prebuilt shell's `<body>` renders anything of its own - content that sits OUTSIDE
 * every postponed boundary and therefore reaches the browser as static markup.
 *
 * The postponed boundaries themselves (which carry only their fallback) do not count: a shell whose
 * whole document is one boundary has nothing static to serve. Neither do the runtime's own scripts.
 * Text is the signal, with the self-closing media tags added because they render something too.
 */
function shellRendersContentOutsideHoles(shell: string): boolean {
  // A shell is a PARTIAL document: it usually stops mid-stream with no closing
  // `</body>`, so read from the body tag to whichever comes first.
  const open = /<body[^>]*>/.exec(shell)
  if (!open) return false
  const rest = shell.slice(open.index + open[0].length)
  const body = rest.split('</body>')[0] ?? ''
  const outside = stripBalanced(body, 'pnext-suspense')
    .replace(/<(script|template|style)[^>]*>[\s\S]*?<\/\1>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  if (/<(img|svg|video|canvas|input)[\s>]/.test(outside)) return true
  return outside.replace(/<[^>]*>/g, '').trim().length > 0
}

/**
 * True when the shell's postponed boundaries carry visible fallback UI (a `loading.tsx` / non-empty
 * `<Suspense fallback>`) - a fallback shell worth serving even when everything outside the holes is
 * empty. This is the discriminator between an empty `<Suspense>` wrapped around `<body>` itself
 * (nothing to show, stays blocking) and a route whose whole body is one hole that still paints.
 */
function shellHolesRenderFallbackContent(shell: string): boolean {
  const open = /<body[^>]*>/.exec(shell)
  if (!open) return false
  const body = (shell.slice(open.index + open[0].length).split('</body>')[0] ?? '')
    .replace(/<(script|template|style)[^>]*>[\s\S]*?<\/\1>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  const outside = stripBalanced(body, 'pnext-suspense')
  const text = (h: string) => h.replace(/<[^>]*>/g, '').trim().length
  const media = (h: string) => /<(img|svg|video|canvas|input)[\s>]/.test(h)
  return text(body) - text(outside) > 0 || (media(body) && !media(outside))
}

/** Remove every balanced `<tag>…</tag>` region (nesting-aware) from `html`. */
function stripBalanced(html: string, tag: string): string {
  const open = new RegExp(`<${tag}[\\s>]`, 'g')
  const boundary = new RegExp(`<${tag}[\\s>]|</${tag}>`, 'g')
  let out = ''
  let cursor = 0
  for (let start = open.exec(html); start; start = open.exec(html)) {
    if (start.index < cursor) continue
    out += html.slice(cursor, start.index)
    boundary.lastIndex = start.index + 1
    let depth = 1
    let end = html.length
    for (let hit = boundary.exec(html); hit; hit = boundary.exec(html)) {
      depth += hit[0].startsWith('</') ? -1 : 1
      if (depth === 0) {
        end = hit.index + hit[0].length
        break
      }
    }
    cursor = end
    open.lastIndex = cursor
  }
  return out + html.slice(cursor)
}

/**
 * cacheComponents shell build for a route that did not opt in via
 * experimental_ppr. Param-free routes render a normal partial shell; routes
 * with dynamic params render a param-independent fallback shell (params hang).
 * Returns true when a shell was baked (route is now PPR), false when dynamic
 * data escaped every boundary (route builds normally).
 *
 * Sub-shells (Stage C.2): when a dynamic-param route ships generateStaticParams
 * covering a leading prefix of its params (e.g. `lang` for `/[lang]/[slug]`),
 * one sub-shell is baked per distinct prefix (lang concrete, slug hanging) in
 * addition to the base fallback (all params hang). The request path serves the
 * deepest matching sub-shell so `/es/1` reuses the `/es/[slug]` shell (lang
 * layout buildtime) while `/xx/1` (uncovered lang) falls back to the base shell.
 */
async function buildCacheComponentsShell(
  config: Awaited<ReturnType<typeof loadConfig>>,
  route: RouteManifestEntry,
): Promise<boolean> {
  const url = new URL(`http://pnext.local${route.route}`)
  const hasDynamicParams = route.params.length > 0 || Boolean(route.catchAll)
  // Build-phase so buildtime sentinels resolve correctly in the shell.
  beginShellSourceTracking()
  let renderResult: Awaited<ReturnType<typeof renderShellWithCacheMeta>>
  try {
    renderResult = await renderShellWithCacheMeta(config, route, () =>
      hasDynamicParams
        ? renderFallbackShell({ config, route, url })
        : renderPartialShell({ config, route, url }),
    )
  } finally {
    // Belt-and-braces: force-abort any prerender scope this route left armed so a
    // stray cacheSignal-bound timer can never keep the build's event loop alive.
    abortActivePrerenderScopes()
  }
  const { prebuilt, meta } = renderResult
  const shellSources = endShellSourceTracking()
  // A base fallback shell provides NO partial-shell value when it is either null (dynamic data
  // escaped every boundary) or params-only-empty (its only holes come from `params`, which are
  // URL-derived and resolve at request time). Such a base shell is never served as a postponed
  // response: an uncovered param renders BLOCKING.
  //
  // The tracking has one blind spot, repaired by a source scan: a component that awaits `params`
  // BEFORE calling a request API never reaches that call during the fallback prerender - the params
  // postpone unwinds it at the first await - so `nonParamsRequest` stays false and a genuinely
  // dynamic route reads as params-only. Those routes DO ship a fallback shell in Next. Scanning is
  // one-directional: it can only keep a shell that dynamic tracking already produced, never invent one.
  //
  // "Params-only" is about the HOLES, not the shell: a params-only shell that still renders content
  // OUTSIDE its boundaries is a genuine partial shell - Next serves it and streams the rest, which is
  // what makes the root layout's buildtime sentinel survive. Only a shell with nothing outside its
  // holes is the "no partial-shell value" case the blocking rule is for.
  //
  // ...with one carve-out: a hole that declared its own `cacheLife` is a CACHE entry keyed by the
  // params it postponed on, and the baked base shell would be served as a params-independent
  // prerender (one stale-time, no per-params vary metadata) for every param combination. Routes whose
  // only dynamic content is such a boundary stay dynamic, so each request re-renders the boundary
  // with its own params. The rescue above is for uncached params access.
  const baseShellIsEmpty =
    prebuilt === null ||
    (prebuilt.holes.length > 0 &&
      !prebuilt.metadataDynamic &&
      !shellSources.cacheIO &&
      !shellSources.nonParamsRequest &&
      !(
        meta.cacheLife === undefined &&
        (shellRendersContentOutsideHoles(prebuilt.shell) ||
          shellHolesRenderFallbackContent(prebuilt.shell))
      ) &&
      !(hasDynamicParams && routeSourcesUseRequestApi(config.root, route)))

  if (!baseShellIsEmpty) {
    route.ppr = true
    route.pprHoles = prebuilt.holes
    route.pprMetadata = prebuilt.metadataDynamic || undefined
    persistRouteCacheLife(route, meta.cacheLife)
    recordRouteCacheTags(route, meta.tags)
    if (meta.linkHeader) route.linkHeader = meta.linkHeader
    const file = pprShellPath(config.outPath, route.id)
    await mkdir(path.dirname(file), { recursive: true })
    await writeText(file, prebuilt.shell)
    // A param-free shell that resolved through http-access fallback recovery (a
    // notFound()/forbidden()/unauthorized() above the boundary) must carry the fallback STATUS in
    // its `.meta`, not 200. The shell prerender does not surface it, so probe with a blocking render
    // - the same pattern as the buildSubShells full-param probe.
    let fallbackStatus: number | undefined
    if (!hasDynamicParams && routeSourcesUseHttpFallback(config.root, route)) {
      try {
        const probe = await runWithWorkUnit('render', () =>
          getRenderExtensions()
            .collectRenderMeta(
              () =>
                runWithNextBuildPhase(() =>
                  renderPageWithStatus({ config, route, params: {}, url }),
                ),
              { route: route.route || '/', prerender: true },
            )
            .then(result => result.value),
        )
        if (probe.status !== 200) fallbackStatus = probe.status
      } catch {
        // Probe render failed — the shell itself is unaffected.
      }
    }
    const prefetchBody = (await renderPrefetchBody(config, route, () =>
      hasDynamicParams
        ? renderFallbackShell({ config, route, url, prefetchShell: true })
        : renderPartialShell({ config, route, url, prefetchShell: true }),
    )) ?? { prebuilt, vary: renderResult.vary }
    await emitSegmentArtifacts(
      config,
      route,
      prefetchBody.prebuilt.shell,
      prefetchBody.prebuilt.holes.length > 0,
      meta,
      fallbackStatus,
      prefetchBody.vary,
      // renderFallbackShell/renderPartialShell against the PATTERN url: a
      // route-level, params-hanging render (see buildVaryTrusted).
      true,
    )

    // Descending-specificity sub-shells from generateStaticParams prefixes.
    if (hasDynamicParams && route.hasStaticParams) {
      await buildSubShells(config, route)
    }
    return true
  }

  // The base shell is empty, but a route whose generateStaticParams cover a PARTIAL prefix still
  // ships per-prefix sub-shells that DO resolve the covered params around the remaining hole -
  // genuine partial shells that must postpone. Build those without writing a base shell file, so a
  // request for an uncovered param finds no shell in loadPprShell and falls through to a blocking
  // render, while a covered prefix resumes its sub-shell.
  //
  // Under cacheComponents a FULL static param set is a sub-shell too WHEN the route still holds
  // request-time data: its params are concrete at build time while a connection()/cookies() boundary
  // must postpone. Without this the route falls through to the blocking static prerender, which
  // BAKES that data and leaves the client no dynamic request. The request-API scan keeps this narrow
  // - a route whose full param sets render with no request-time data is a COMPLETE static prerender.
  if (
    hasDynamicParams &&
    route.hasStaticParams &&
    ((await hasPartialStaticPrefix(config, route)) ||
      (cacheComponents() &&
        routeSourcesUseRequestApi(config.root, route) &&
        (await hasFullStaticParamSet(config, route))))
  ) {
    route.ppr = true
    route.pprMetadata = prebuilt?.metadataDynamic || undefined
    if (prebuilt) {
      persistRouteCacheLife(route, meta.cacheLife)
      recordRouteCacheTags(route, meta.tags)
      if (meta.linkHeader) route.linkHeader = meta.linkHeader
    }
    await buildSubShells(config, route)
    return true
  }

  // No partial-prefix sub-shells either: fall through to the normal
  // static/dynamic build (full generateStaticParams sets still prerender;
  // uncovered params render dynamically).
  return false
}

/**
 * True when the route's generateStaticParams cover a PARTIAL leading param prefix (fewer params than
 * the route declares) - the shape that produces a postponing sub-shell with statically-resolved
 * params around a remaining hole. A route whose static params are all FULL sets (or has none) yields
 * no partial sub-shell, so a params-only base fallback shell is served with a blocking render.
 */
async function hasPartialStaticPrefix(
  config: Awaited<ReturnType<typeof loadConfig>>,
  route: RouteManifestEntry,
): Promise<boolean> {
  if (!route.hasStaticParams) return false
  let staticParams: Awaited<ReturnType<typeof staticParamsFor>>
  try {
    staticParams = await staticParamsFor(config, route)
  } catch {
    return false
  }
  const paramKeys = [...route.params, ...(route.catchAll ? [route.catchAll] : [])]
  for (const set of staticParams.allSets) {
    let filled = 0
    while (filled < paramKeys.length && set[paramKeys[filled]!] !== undefined) filled++
    if (filled > 0 && filled < paramKeys.length) return true
  }
  return false
}

/**
 * True when some generateStaticParams set fills EVERY param the route declares.
 * buildSubShells already renders those as concrete, postponing sub-shells; this
 * predicate is what lets them be reached under cacheComponents.
 */
async function hasFullStaticParamSet(
  config: Awaited<ReturnType<typeof loadConfig>>,
  route: RouteManifestEntry,
): Promise<boolean> {
  if (!route.hasStaticParams) return false
  let staticParams: Awaited<ReturnType<typeof staticParamsFor>>
  try {
    staticParams = await staticParamsFor(config, route)
  } catch {
    return false
  }
  const paramKeys = [...route.params, ...(route.catchAll ? [route.catchAll] : [])]
  if (paramKeys.length === 0) return false
  return staticParams.allSets.some(set => paramKeys.every(key => set[key] !== undefined))
}

/**
 * Bake one sub-shell per distinct PARTIAL param prefix from the route's
 * generateStaticParams. A prefix fills a proper leading subset of the route's
 * params (in declaration order) and leaves the rest hanging. Sub-shells are
 * recorded on the route MOST-specific first.
 */
async function buildSubShells(
  config: Awaited<ReturnType<typeof loadConfig>>,
  route: RouteManifestEntry,
): Promise<void> {
  let staticParams: Awaited<ReturnType<typeof staticParamsFor>>
  try {
    staticParams = await staticParamsFor(config, route)
  } catch {
    return
  }
  route.prerenderedParams = staticParams.allSets
  const paramKeys = [...route.params, ...(route.catchAll ? [route.catchAll] : [])]
  // Distinct leading prefixes AND full param sets. A partial prefix fills keys
  // [0..k) (k < len) and leaves the rest hanging → a sub-shell (postponed). A
  // FULL set fills every param → a fully-prerendered shell with no holes (not
  // postponed) that the request path serves for that exact URL.
  const prefixes = new Map<string, Record<string, RouteParamValue>>()
  for (const set of staticParams.allSets) {
    let filled = 0
    while (filled < paramKeys.length && set[paramKeys[filled]!] !== undefined) filled++
    if (filled === 0) continue
    const concrete: Record<string, RouteParamValue> = {}
    for (let i = 0; i < filled; i++) concrete[paramKeys[i]!] = set[paramKeys[i]!]!
    const key = subShellKey(concrete)
    if (!prefixes.has(key)) prefixes.set(key, concrete)
  }
  if (prefixes.size === 0) return

  const subShells: NonNullable<RouteManifestEntry['pprSubShells']> = []
  for (const [key, concreteParams] of prefixes) {
    const routePath = fillRoutePath(route.route, concreteParams)
    const url = new URL(`http://pnext.local${routePath}`)
    // Collect cache meta so a sub-shell's cache tags (its concrete-param
    // prefix lets `use cache` scopes fill that the fallback shell postponed)
    // join the route's tag set for PPR-shell tag staleness.
    const { value: prebuilt, tags } = await runWithWorkUnit('render', () =>
      getRenderExtensions().collectRenderMeta(
        () =>
          runWithNextBuildPhase(() =>
            renderSubShell({ config, route, url, concreteParams, paramKeys }),
          ),
        { fetchCache: route.segmentConfig?.fetchCache, route: routePath || '/', prerender: true },
      ),
    )
    recordRouteCacheTags(route, tags)
    if (!prebuilt) continue
    const file = pprSubShellPath(config.outPath, route.id, key)
    await mkdir(path.dirname(file), { recursive: true })
    await writeText(file, prebuilt.shell)
    subShells.push({ key, concreteParams, holes: prebuilt.holes })
    // A FULL param set is a concrete prerendered path - emit Next's `.{html,meta}` plus tree-segment
    // artifacts for it. The sub-shell is the prerendered html (dynamic holes stay excluded, so a
    // dynamic <head> never leaks into the static copy); a blocking probe render supplies the real
    // HTTP status when the page resolves to an http-access fallback. Postponed iff the sub-shell kept
    // holes, mirrored as Next's `.meta` postponed marker string.
    if (Object.keys(concreteParams).length === paramKeys.length) {
      try {
        const probe = await runWithWorkUnit('render', () =>
          getRenderExtensions()
            .collectRenderMeta(
              () =>
                runWithNextBuildPhase(() =>
                  renderPageWithStatus({
                    config,
                    route,
                    params: encodeStaticRouteParams(concreteParams),
                    url,
                  }),
                ),
              { route: routePath || '/', prerender: true },
            )
            .then(result => result.value),
        )
        // Dynamic metadata counts: the head resumes at request time, so the shell is partial even
        // with zero body holes. The sub-shell render may not re-flag metadataDynamic once the
        // fallback shell recorded it, so the route-level flag joins in. http-access fallback recovery
        // renders a BOUNDARY file's metadata, which the shell flags never see, so the route's source
        // graph is scanned for a dynamic generateMetadata/generateViewport too.
        const postponed =
          prebuilt.holes.length > 0 ||
          prebuilt.metadataDynamic ||
          route.pprMetadata === true ||
          routeSourcesHaveDynamicHead(route)
        await emitConcreteNextPageArtifacts(config, route, routePath, {
          html: postponed ? prebuilt.shell : `${prebuilt.shell}\n  </body></html>`,
          status: probe.status,
          postponed,
        })
      } catch {
        // Probe render failed — the sub-shell itself is unaffected.
      }
    }
  }
  subShells.sort(
    (a, b) => Object.keys(b.concreteParams).length - Object.keys(a.concreteParams).length,
  )
  if (subShells.length > 0) route.pprSubShells = subShells
}

/**
 * Whether any file in the route's source graph CALLS an http-access fallback API
 * (notFound/forbidden/unauthorized) - the only shape whose prerendered `.meta` status can differ from
 * 200, so only these routes pay for a blocking status-probe render alongside their shell.
 */
function routeSourcesUseHttpFallback(root: string, route: RouteManifestEntry): boolean {
  for (const file of route.sourceFiles) {
    // App files only: `sourceFiles` also carries framework entries (pnext's own
    // compat sources name these APIs), which would blocking-probe every route
    // that imports next/server.
    if (!file.startsWith(root) || file.includes(`${path.sep}node_modules${path.sep}`)) continue
    if (!existsSync(file)) continue
    const source = readTextSync(file)
    if (/\b(?:notFound|forbidden|unauthorized)\s*\(\s*\)/.test(source)) return true
  }
  return false
}

/**
 * Whether any APP file in the route's source graph CALLS a request API that is
 * NOT params (connection()/cookies()/headers()/draftMode()). Used only to
 * repair the params-only fallback-shell classification, where a call sequenced
 * after an `await params` is invisible to shell-source tracking. Deliberately
 * narrow on both axes: `searchParams` is left out because the bare identifier
 * appears in far too many prop signatures to be a reliable call signal, and the
 * scan skips the framework/node_modules entries `sourceFiles` also carries
 * (pnext's own `src/ppr.ts` names every one of these APIs). Missing a source
 * only leaves the route on today's blocking path.
 */
function routeSourcesUseRequestApi(root: string, route: RouteManifestEntry): boolean {
  for (const file of route.sourceFiles) {
    if (!file.startsWith(root) || file.includes(`${path.sep}node_modules${path.sep}`)) continue
    if (!existsSync(file)) continue
    // Comments are stripped first: fixtures routinely SAY "no connection()" in
    // prose above a page that has none (`//` inside a string only costs a
    // false negative, which is the safe direction here).
    const source = readTextSync(file)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    if (/\b(?:connection|cookies|headers|draftMode)\s*\(\s*\)/.test(source)) return true
  }
  return false
}

/**
 * Whether any file in the route's source graph exports a dynamic (awaiting, uncached)
 * generateMetadata/generateViewport - including boundary files like not-found.tsx whose dynamic head
 * only renders during fallback recovery.
 */
function routeSourcesHaveDynamicHead(route: RouteManifestEntry): boolean {
  for (const file of route.sourceFiles) {
    if (!existsSync(file)) continue
    const source = readTextSync(file)
    const match =
      /export\s+(?:async\s+)?function\s+(?:generateMetadata|generateViewport)\s*\([^)]*\)\s*(?::[^{]+)?\{/.exec(
        source,
      )
    if (!match) continue
    const body = source.slice(match.index + match[0].length)
    if (/\bawait\b/.test(body.split('\nexport ')[0] ?? body) && !body.includes('use cache')) {
      return true
    }
  }
  return false
}

/**
 * Restrict the scanned route table to files matching `--debug-build-paths` (Next's debugging flag):
 * comma-separated root-relative paths or simple globs. A route is kept when its own file matches;
 * everything else - validation, bundling, prerendering - never sees the dropped routes.
 */
function filterDebugBuildRoutes(
  root: string,
  routes: RouteManifestEntry[],
  patterns: string,
): RouteManifestEntry[] {
  const matchers = patterns
    .split(',')
    .map(pattern => pattern.trim())
    .filter(pattern => pattern.length > 0 && !pattern.startsWith('!'))
    .map(debugBuildPathMatcher)
  if (matchers.length === 0) return routes
  return routes.filter(route => {
    const relative = toPosixPath(path.relative(root, route.file))
    return matchers.some(matcher => matcher(relative))
  })
}

function debugBuildPathMatcher(pattern: string): (file: string) => boolean {
  if (!/[*?]/.test(pattern)) {
    return file => file === pattern || file.endsWith(`/${pattern}`)
  }
  const regex = new RegExp(
    `^${pattern
      .split(/(\*\*\/|\*\*|\*|\?)/)
      .map(part => {
        if (part === '**/') return '(?:.*/)?'
        if (part === '**') return '.*'
        if (part === '*') return '[^/]*'
        if (part === '?') return '[^/]'
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      })
      .join('')}$`,
  )
  return file => regex.test(file)
}

/** Stable on-disk signature for a sub-shell's concrete-param prefix. */
function subShellKey(concrete: Record<string, RouteParamValue>): string {
  return Object.entries(concrete)
    .map(([k, v]) => `${k}-${(Array.isArray(v) ? v.join('_') : v).replace(/[^a-zA-Z0-9_]/g, '_')}`)
    .join('.')
}

/**
 * Bundle the proxy/middleware file with compat server aliases baked in. Raw
 * Bun imports at request time cannot resolve bare compat specifiers
 * (next/server etc.), so start must load this build-time artifact instead.
 */
async function buildProxyModule(config: Awaited<ReturnType<typeof loadConfig>>) {
  await validateProxyFiles(config)
  const file = findProxyFile(config)
  if (!file) return undefined
  const href = await devServerModuleHref(config, file, 'prod', {
    conditionTarget: 'edge',
    externalLoadTarget: proxyExternalLoadTarget(file),
    reactServerLayer: true,
  })
  const compiled = fileURLToPath(href)
  return toPosixPath(path.relative(config.outPath, compiled))
}

/**
 * Render the build's 404 documents: `public/404.html` when the app has a prerenderable not-found
 * convention, and the `_not-found` document Next always emits for a compat build. Returns the
 * latter's HTML. Runs as its own stage alongside the client bundles - it only needs the route table,
 * the stub set and the metadata collected before them.
 */
async function renderNotFoundDocuments({
  config,
  log,
  skip,
  documentCss,
  staticMetadataFiles,
  staticModuleMetadata,
}: {
  config: Awaited<ReturnType<typeof loadConfig>>
  log: VerboseLogger
  skip: boolean
  documentCss: Promise<unknown>
  staticMetadataFiles: StaticMetadataFile[]
  staticModuleMetadata: Record<string, StaticModuleMetadata>
}): Promise<string | undefined> {
  if (skip) return undefined
  const render = async () => {
    const response = await renderGlobalNotFoundResponse({
      config,
      url: new URL('http://pnext.local/_not-found'),
      staticMetadataFiles,
      staticModuleMetadata,
    })
    return response.text()
  }
  // The document links the not-found stylesheet chunk buildNotFoundCss emits.
  await documentCss

  if (await shouldBuildGlobalNotFound(config)) {
    await log.step('global not-found', async () =>
      writeText(path.join(config.outPath, 'public', '404.html'), await render()),
    )
  }
  // Next always prerenders the built-in `/_not-found` document for a compat
  // build even without a prerenderable not-found file (not-found/default reads
  // `.next/server/app/_not-found.html`). When public/404.html was written, the
  // .next artifacts are copied from it; otherwise they need a document here.
  if (!config.compat?.next) return undefined
  if (existsSync(path.join(config.outPath, 'public', '404.html'))) return undefined
  // Nothing prerenderable to render into the document: either the app authored no not-found.* at
  // all, or it authored one and declared it force-dynamic, in which case Next leaves `/_not-found`
  // dynamic and prerenders no custom 404 either. Emit the standalone default rather than boot the
  // whole server graph for an artifact that is never served - the app's *runtime* 404, still
  // dynamic, is what users see.
  return defaultNotFoundDocument()
}

/**
 * The app's 404 convention and whether it is prerenderable. `force-dynamic`
 * opts the not-found route out of prerendering exactly as it does any page.
 */
async function shouldBuildGlobalNotFound(config: Awaited<ReturnType<typeof loadConfig>>) {
  const file = ['tsx', 'ts', 'jsx', 'js']
    .flatMap(ext => [
      path.join(config.appPath, `global-not-found.${ext}`),
      path.join(config.appPath, `not-found.${ext}`),
    ])
    .find(candidate => existsSync(candidate))
  if (!file) return false
  return !/\bexport\s+const\s+dynamic\s*=\s*['"]force-dynamic['"]/.test(await readText(file))
}

/**
 * Materialize Next's `.next/server/middleware.js` (+ `.nft.json`) for a compat build with a
 * proxy/middleware file. buildProxyModule bundles the compiled proxy under a hashed name; Next
 * instead names it `middleware.js` (renaming even a `proxy.ts` source), and providers read the
 * sibling `.nft.json` to know which files to deploy. The trace lists only the emitted
 * `middleware.js` itself, never the original `proxy.js` name - the mismatch this artifact avoids.
 */
async function emitProxyServerArtifacts(
  config: Awaited<ReturnType<typeof loadConfig>>,
  proxyModule: string | undefined,
) {
  if (!config.compat?.next || !proxyModule) return
  const compiled = path.resolve(config.outPath, proxyModule)
  if (!existsSync(compiled)) return

  const serverDir = path.join(config.root, '.next', 'server')
  await mkdir(serverDir, { recursive: true })
  const middlewareFile = path.join(serverDir, 'middleware.js')
  await copyFile(compiled, middlewareFile)

  // NFT files are relative to the trace file's directory and must all exist on
  // disk. The self-contained bundle is the only traced output.
  const files = ['middleware.js'].filter(name => existsSync(path.join(serverDir, name)))
  await writeFile(
    path.join(serverDir, 'middleware.js.nft.json'),
    `${JSON.stringify({ version: 1, files })}\n`,
  )
}

async function emitNextNotFoundArtifacts(
  config: Awaited<ReturnType<typeof loadConfig>>,
  fallback404?: string,
) {
  if (!config.compat?.next) return
  const source = path.join(config.outPath, 'public', '404.html')
  const html = existsSync(source) ? readFileSync(source, 'utf8') : fallback404
  if (html === undefined) return

  const serverDir = path.join(config.root, '.next', 'server')
  const pagesDir = path.join(serverDir, 'pages')
  const notFoundDir = path.join(serverDir, 'app', '_not-found')
  await mkdir(pagesDir, { recursive: true })
  await mkdir(notFoundDir, { recursive: true })
  await writeFile(path.join(pagesDir, '404.html'), html)
  // Next's app-router prerender output for the built-in /_not-found route. The
  // .rsc mirror carries the document body like the segment artifacts do
  // (not-found/default greps both for the noindex marker).
  await writeFile(path.join(serverDir, 'app', '_not-found.html'), html)
  await writeFile(path.join(serverDir, 'app', '_not-found.rsc'), html)

  const pagesManifestFile = path.join(serverDir, 'pages-manifest.json')
  let pagesManifest: Record<string, string> = {}
  try {
    pagesManifest = JSON.parse(readFileSync(pagesManifestFile, 'utf8')) as Record<string, string>
  } catch {
    // First compat build has no pages manifest yet.
  }
  pagesManifest['/404'] = 'pages/404.html'
  await writeFile(pagesManifestFile, `${JSON.stringify(pagesManifest, null, 2)}\n`)

  const clientReferenceManifest = 'page_client-reference-manifest.js'
  await writeFile(path.join(notFoundDir, clientReferenceManifest), 'self.__RSC_MANIFEST={}\n')
  await writeFile(
    path.join(notFoundDir, 'page.js.nft.json'),
    `${JSON.stringify({ version: 1, files: [clientReferenceManifest] }, null, 2)}\n`,
  )
}

async function collectStaticModuleMetadata(
  config: Awaited<ReturnType<typeof loadConfig>>,
  routes: RouteManifestEntry[],
) {
  const metadata: Record<string, StaticModuleMetadata> = {}
  if (config.compat?.next) return metadata

  const files = new Set<string>()
  for (const route of routes) {
    if (route.kind !== 'page') continue
    for (const file of findLayouts(config.appPath, route.file)) {
      if (existsSync(file)) files.add(file)
    }
    files.add(route.file)
  }
  if (files.size === 0) return metadata

  registerServerRuntime(config, [...files])
  registerCssRuntime()
  for (const file of files) {
    const href = reactCompatEnabled(config)
      ? await devServerModuleHref(config, file, 'build')
      : pathToFileHref(file)
    const module = (await import(href)) as {
      metadata?: Parameters<typeof readModuleMetadata>[0]['metadata']
      viewport?: Parameters<typeof readModuleViewport>[0]['viewport']
    }
    const entry: StaticModuleMetadata = {}
    const routeMetadata = await readModuleMetadata(module)
    const viewport = await readModuleViewport(module)
    if (routeMetadata) entry.metadata = routeMetadata
    if (viewport) entry.viewport = viewport
    if (entry.metadata || entry.viewport) metadata[file] = entry
  }

  return metadata
}

async function collectStaticRouteMetadata(
  config: Awaited<ReturnType<typeof loadConfig>>,
  routes: RouteManifestEntry[],
  staticMetadataFiles: StaticMetadataFile[],
) {
  const metadata: Record<string, StaticRouteMetadata> = {}
  if (config.compat?.next) return metadata

  for (const route of routes) {
    if (route.kind !== 'page' || route.interception) continue
    const paramSets = route.prerenderedParams ?? (route.params.length === 0 ? [{}] : [])
    for (const params of paramSets) {
      const routePath = fillRoutePath(route.route, params)
      const base = route.interception
        ? staticMetadataForRouteFromFiles(
            staticMetadataFiles,
            config.appPath,
            route.file,
            routePath,
          )
        : staticMetadataForPathFromFiles(staticMetadataFiles, routePath)
      const resolved = await withDynamicMetadataRoutes(
        base,
        config.appPath,
        route.file,
        routePath,
        file => importMetadataModule(config, file),
      )
      metadata[staticRouteMetadataKey(routePath)] = resolved
    }
  }

  return metadata
}

async function importMetadataModule(
  config: Awaited<ReturnType<typeof loadConfig>>,
  file: string,
): Promise<Record<string, unknown>> {
  const href = reactCompatEnabled(config)
    ? await devServerModuleHref(config, file, 'build')
    : pathToFileHref(file)
  return import(href) as Promise<Record<string, unknown>>
}

async function buildStaticRouteHandler(
  config: Awaited<ReturnType<typeof loadConfig>>,
  route: RouteManifestEntry,
  options: { skipPhysicalWrite?: boolean } = {},
) {
  const skipPhysicalWrite = options.skipPhysicalWrite ?? false
  registerServerRuntime(config, route.sourceFiles)
  // Compat mode loads the compiled module (aliases baked in) so bare next/*
  // imports (next/headers etc.) resolve to the compat layer, not an installed
  // next package. Same pattern as page prerenders.
  const moduleHref = reactCompatEnabled(config)
    ? await devServerModuleHref(config, route.file, 'build', {
        conditionTarget: serverBundleTargetForRuntime(route.segmentConfig?.runtime),
      })
    : pathToFileHref(route.file)
  const imported = (await import(moduleHref)) as Parameters<typeof metadataRouteHandlerModule>[0]
  const routeModule = metadataRouteHandlerModule(imported, route) ?? imported
  const module = (
    nextCompatEnabled(config)
      ? buildCompat().normalizeStaticParamsModule(routeModule as Record<string, unknown>)
      : routeModule
  ) as RouteHandlerModule
  const paramSets = await staticRouteParams(route, module)
  const staticFiles: Record<string, StaticFileMetadata> = {}

  // A generated-param metadata route (`generateSitemaps` / `generateImageMetadata`)
  // knows every id ahead of time, so each expanded pathname is a prerendered
  // route even when the response body itself can't be baked (an ImageResponse
  // settles in a later task, so the loop below skips the physical copy).
  // Record the expansion for the compat prerender-manifest writer.
  if (route.metadataRoute?.generatedParam && paramSets.length > 0) {
    route.metadataRoute.generatedRoutes = paramSets.map(params =>
      fillRoutePath(route.route, params, route.metadataRoute?.generatedParam),
    )
  }

  // force-static handlers see a canonicalized, origin-normalized request (no
  // search/headers/cookies); Next reports the URL against a fixed base host.
  const requestBase =
    route.segmentConfig?.dynamic === 'force-static' ? 'http://localhost:3000' : 'http://pnext.local'
  for (const params of paramSets) {
    const routePath = fillRoutePath(route.route, params, route.metadataRoute?.generatedParam)
    const file = staticRouteHandlerPath(config.outPath, routePath)
    // A descendant handler intentionally forgoes the physical file (its ancestor
    // owns public/<parent>), so don't treat the guaranteed collision as a skip —
    // still render it to capture the prerender-manifest metadata below.
    if (!skipPhysicalWrite) {
      const collision = staticOutputCollision(config.outPath, file)
      if (collision) {
        warnSkippedStatic(routePath, collision)
        continue
      }
    }
    // Wrap in a work unit (like the page prerender path) so an after()
    // scheduled during the handler prerender drains in phase 'after' — the
    // signal draftMode().enable()/disable() guards read to throw "used inside
    // after()" (next-after-app-api-usage draft-mode static route handler).
    const prerender = runWithWorkUnit('render', () =>
      getRenderExtensions().collectRenderMeta(
        () =>
          runWithCacheScope(() =>
            runWithNextBuildPhase(() =>
              withRouteRuntime(route.segmentConfig?.runtime, () =>
                handleRouteModule(module, new Request(`${requestBase}${routePath}`), params, {
                  routeFile: route.file,
                }),
              ),
            ),
          ),
        {
          fetchCache: route.segmentConfig?.fetchCache,
          route: routePath || '/',
          prerender: true,
          handler: true,
          dynamicError: route.segmentConfig?.dynamic === 'error',
        },
      ),
    )
    // Cache-components only prerenders handlers that settle synchronously or
    // in a microtask. A later task (including a delayed response stream)
    // depends on runtime work and must not produce a static file.
    const early = await settleBeforeNextTask(prerender)
    const completed = early ?? (await prerender)
    const rendered =
      early ??
      (route.segmentConfig?.dynamic === 'force-static' || (await handlerHasEntirelyCachedIo(route))
        ? completed
        : undefined)
    if (!rendered) continue
    const response = rendered.value
    // A 5xx means the handler threw during prerender (handleRouteModule funnels
    // uncaught throws to an empty 500). Don't bake a broken response into static
    // output — surface it to the caller's skip-and-warn path so the route serves
    // dynamically instead.
    if (response.status >= 500) {
      throw new Error(`route handler prerender returned ${response.status}`)
    }
    if (rendered.noStore && !staticRouteHandlerExplicitlyCached(route)) continue
    const body = await settleBeforeNextTask(response.clone().arrayBuffer())
    if (!body) continue
    const relative = toPosixPath(path.relative(path.join(config.outPath, 'public'), file))
    // Descendant handlers record their manifest entry (so the synthesized
    // prerender-manifest lists them) but skip the on-disk copy that would
    // collide with the ancestor's file; they serve dynamically at runtime.
    if (!skipPhysicalWrite) {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, new Uint8Array(body))
    }
    const revalidateSeconds = combineRevalidate(
      route.segmentConfig?.revalidate,
      rendered.revalidateSeconds,
    )
    staticFiles[relative] = {
      status: response.status,
      headers: [...response.headers.entries()],
      routeId: route.id,
      ...(revalidateSeconds !== undefined ? { revalidateSeconds } : {}),
      ...(rendered.tags.length > 0 ? { tags: rendered.tags } : {}),
    }
  }

  return staticFiles
}

function settleBeforeNextTask<T>(value: Promise<T>): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) resolve(undefined)
    }, 0)
    void value.then(
      result => {
        settled = true
        clearTimeout(timer)
        resolve(result)
      },
      (error: unknown) => {
        settled = true
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

async function handlerHasEntirelyCachedIo(route: RouteManifestEntry): Promise<boolean> {
  // Synthetic slot routes carry a phantom `page.tsx` anchor that never exists
  // on disk — source sniffing must skip them or the build ENOENTs.
  if (route.synthetic || !existsSync(route.file)) return false
  const source = await readText(route.file)
  // A metadata route handler exports a `default` function rather than `GET`; pnext wraps it into the
  // handler internally. When that default is a top-level `use cache` function every read inside it is
  // cached, so the whole route is prerenderable. Without this the GET sniff below returns false and
  // the route stays runtime-only.
  if (route.metadataRoute && metadataDefaultUsesCache(source)) return true
  const getStart = source.search(/\bexport\s+(?:async\s+)?function\s+GET\s*\(/)
  if (getStart === -1) return false
  const afterGet = source.slice(getStart)
  const nextDeclaration = afterGet.slice(1).search(/^(?:async\s+)?(?:function|const|let)\s+/m)
  const body = nextDeclaration === -1 ? afterGet : afterGet.slice(0, nextDeclaration + 1)
  // Reading the wall clock straight in the GET body - outside any `use cache` scope - is dynamic
  // under cacheComponents: Next taints such a route as dynamic and never prerenders it. Prebuilding
  // it would serve a build-time body that is already stale by the first request, and the background
  // regen would race a subsequent read. Empty-parens only: `new Date(ms)` is deterministic.
  if (/\bnew\s+Date\s*\(\s*\)/.test(body) || /\bDate\s*\.\s*now\s*\(/.test(body)) {
    return false
  }
  const awaited = [...body.matchAll(/\bawait\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(match => match[1]!)
  if (awaited.length === 0) return false

  // `await import(...)` is module evaluation, not request IO: a module that top-level-awaits still
  // resolves the same for every request, so the route stays prerenderable. It only settles in a later
  // task the FIRST time, which is exactly the build's prerender, so the awaited-call check forgives it.
  const cached = new Set<string>(['import'])
  for (const match of source.matchAll(
    /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\(/g,
  )) {
    if (match[2] === 'cache' || match[2] === 'unstable_cache') cached.add(match[1]!)
  }
  for (const match of source.matchAll(
    /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*['"]use cache['"]/g,
  )) {
    cached.add(match[1]!)
  }
  for (const name of awaited) {
    const start = source.search(
      new RegExp(`\\b(?:const\\s+${name}\\s*=|function\\s+${name}\\s*\\()`),
    )
    if (start === -1) continue
    const tail = source.slice(start)
    const next = tail.slice(1).search(/^(?:async\s+)?(?:function|const|let)\s+/m)
    const declaration = next === -1 ? tail : tail.slice(0, next + 1)
    if (/\bcache\s*:\s*['"]force-cache['"]/.test(declaration)) cached.add(name)
  }
  return awaited.every(name => cached.has(name))
}

/**
 * True when a metadata route handler's `default` export is a top-level `'use cache'` function - the
 * whole handler body is cached, so the route prerenders at build time. Allows a leading return-type
 * annotation and comment lines before the directive.
 */
function metadataDefaultUsesCache(source: string): boolean {
  return /\bexport\s+default\s+(?:async\s+)?function\b[^(]*\([^)]*\)\s*(?::[^{]*)?\{\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*['"]use cache['"]/.test(
    source,
  )
}

async function usesUnstableCache(route: RouteManifestEntry): Promise<boolean> {
  if (route.synthetic || !existsSync(route.file)) return false
  const source = await readText(route.file)
  const localNames: string[] = []
  const dynamicNames: string[] = []
  for (const match of source.matchAll(
    /\bimport\s*\{([^}]*)\}\s*from\s*['"]next\/(cache|headers|server)(?:\.js)?['"]/g,
  )) {
    for (const item of match[1]!.split(',')) {
      const [imported, local] = item.trim().split(/\s+as\s+/)
      if (match[2] === 'cache' && imported === 'unstable_cache') {
        localNames.push(local ?? imported)
      } else if (
        (match[2] === 'headers' && (imported === 'cookies' || imported === 'headers')) ||
        (match[2] === 'server' && imported === 'connection')
      ) {
        dynamicNames.push(local ?? imported)
      }
    }
  }
  if (dynamicNames.length === 0) return false
  const dynamicCall = dynamicNames.join('|')
  return localNames.some(name =>
    new RegExp(
      `\\b${name}\\s*\\(\\s*(?:async\\s*)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)?\\s*=>[\\s\\S]{0,1000}?\\b(?:${dynamicCall})\\s*\\(`,
    ).test(source),
  )
}

async function staticHandlerDynamicUsage(route: RouteManifestEntry): Promise<string | undefined> {
  if (!route.usesRequest) return undefined
  if (route.segmentConfig?.dynamic === 'force-static' || route.segmentConfig?.dynamic === 'error') {
    return undefined
  }
  if (route.synthetic || !existsSync(route.file)) return undefined
  const source = await readText(route.file)
  if (/\b(?:request|req)\.url\b/.test(source)) return 'request.url'
  if (/\bnextUrl\s*\.\s*toString\s*\(/.test(source)) return 'nextUrl.toString'
  if (/\bheaders\s*\(/.test(source)) return 'headers()'
  if (/\bcookies\s*\(/.test(source)) return 'cookies()'
  if (/\bconnection\s*\(/.test(source)) return 'connection()'
  return undefined
}

/**
 * Handler routes whose logical output path would collide with a descendant route's output directory.
 * A route is a descendant when another route's path is a strict segment-boundary prefix of it. Only
 * handler descendants matter - pages already write to `public/<route>/index.html`, which nests
 * cleanly. The ancestor keeps its physical file; descendants skip theirs.
 */
function collectDescendantHandlerIds(routes: RouteManifestEntry[]): Set<string> {
  const ids = new Set<string>()
  const paths = routes.map(route => ({ route, norm: (route.route || '/').replace(/\/+$/, '') }))
  for (const { route, norm } of paths) {
    if (route.kind !== 'handler') continue
    const hasAncestor = paths.some(
      other =>
        other.route !== route &&
        other.norm.length > 0 &&
        norm !== other.norm &&
        norm.startsWith(`${other.norm}/`),
    )
    if (hasAncestor) ids.add(route.id)
  }
  return ids
}

async function staticRouteHandlerCandidate(route: RouteManifestEntry) {
  const config = route.segmentConfig
  if (config?.dynamic === 'force-dynamic') return false
  if (config?.revalidate === 0) return false
  if (config?.fetchCache === 'force-no-store') return false
  // A handler that calls revalidatePath/revalidateTag performs a side effect
  // per request; it can never be prerendered (Next keeps it dynamic even with a
  // `revalidate` export), so serving a cached body would drop the revalidation.
  if (route.handlerUsesRevalidationApi) return false
  if (route.metadataRoute) return !route.usesRequest
  // `dynamic = 'error'` deliberately exercises a static render so request API
  // reads can fail at their call sites instead of turning the handler dynamic.
  if (config?.dynamic === 'error') return true
  if (config?.dynamic === 'force-static') return true
  // A `revalidate` export or `generateStaticParams` opts a handler into static
  // (ISR) output even if it reads request data — Next prerenders it with a
  // canonical request. Truly dynamic access (cookies/headers) would surface at
  // runtime, but reading e.g. `req.nextUrl.pathname` is prerender-safe.
  if (staticRouteHandlerExplicitlyCached(route) || route.hasStaticParams) return true
  if (route.usesRequest) return false
  // Since Next 15, GET route handlers are dynamic by default: only an explicit opt-in prerenders one.
  // Under cacheComponents every request-independent handler is a prerender candidate again, EXCEPT
  // one that performs uncached IO (time/randomness outside any `use cache` scope): baking it would
  // freeze `new Date()` at build time while its `use cache` parts must keep live SWR semantics.
  if (!cacheComponents() || route.mode !== 'static') return false
  if (!handlerUsesUncachedIo(route)) return true
  // The uncached-IO sniff is textual, so it also trips on time/randomness that
  // sits inside a helper the handler only ever reaches through an
  // `unstable_cache()` wrapper (cache-components routes `/routes/io-cached`).
  // The call-graph check is authoritative there: when EVERY awaited call in GET
  // resolves to a cached wrapper the IO is cached after all. A handler that
  // also awaits the raw helper (`/routes/io-mixed`) still fails it.
  return handlerHasEntirelyCachedIo(route)
}

/**
 * Whether a handler reads time/randomness OUTSIDE any `use cache` function
 * body. Cache-scoped reads are cached with the entry (fine to prerender);
 * unscoped reads make the handler's output request-dependent under
 * cacheComponents, so it must render per-request.
 */
function handlerUsesUncachedIo(route: RouteManifestEntry): boolean {
  const source = readTextSync(route.file)
  if (!source) return false
  return /\bnew Date\s*\(|\bDate\.now\s*\(|\bMath\.random\s*\(/.test(stripUseCacheBodies(source))
}

/** Blank out every function body whose prologue opens with a 'use cache' directive. */
function stripUseCacheBodies(source: string): string {
  let out = source
  for (;;) {
    const directive = /\{\s*(['"])use cache(?:\s*:\s*[\w-]+)?\1\s*;?/.exec(out)
    if (!directive) break
    const bodyOpen = directive.index + 1
    let balance = 1
    let end = out.length
    for (let i = bodyOpen; i < out.length; i += 1) {
      const ch = out[i]
      if (ch === '{') balance += 1
      else if (ch === '}') {
        balance -= 1
        if (balance === 0) {
          end = i
          break
        }
      }
    }
    out = `${out.slice(0, bodyOpen)}${out.slice(end)}`
  }
  return out
}

function staticRouteHandlerExplicitlyCached(route: RouteManifestEntry) {
  const config = route.segmentConfig
  return (
    config?.dynamic === 'force-static' ||
    config?.revalidate === false ||
    (typeof config?.revalidate === 'number' && config.revalidate > 0)
  )
}

async function needsRequestOriginForMetadataImages(appPath: string, route: RouteManifestEntry) {
  if (!(await routeNullsMetadataBase(route))) return false
  return routeMetadataImageFiles(appPath, route.file)
}

async function routeNullsMetadataBase(route: RouteManifestEntry) {
  const sourceFiles = route.sourceFiles.filter(file => /\.(tsx?|jsx?|mjs|cjs)$/.test(file))
  for (const file of sourceFiles) {
    try {
      if (/\bmetadataBase\s*:\s*null\b|\bmetadataBase\s*=\s*null\b/.test(await readText(file))) {
        return true
      }
    } catch {
      // Ignore generated/virtual paths that are not readable at build time.
    }
  }
  return false
}

function routeMetadataImageFiles(appPath: string, routeFile: string) {
  let dir = path.dirname(routeFile)
  const root = path.resolve(appPath)
  while (dir.startsWith(root)) {
    if (existsSync(dir)) {
      for (const entry of readdirSync(dir)) {
        if (
          /^(opengraph-image|twitter-image)\d*\.(tsx?|jsx?|mjs|png|jpe?g|gif|webp|svg)$/.test(entry)
        ) {
          return true
        }
      }
    }
    if (dir === root) break
    dir = path.dirname(dir)
  }
  return false
}

async function copyStaticMetadataFiles(
  config: Awaited<ReturnType<typeof loadConfig>>,
  staticFiles: Record<string, StaticFileMetadata>,
  metadataFiles = discoverStaticMetadataFiles(config.appPath),
) {
  for (const metadataFile of metadataFiles) {
    const target = staticMetadataOutputFile(config.outPath, metadataFile)
    const collision = staticOutputCollision(config.outPath, target)
    if (collision) {
      warnSkippedStatic(`/${metadataFile.outputPath}`, collision)
      continue
    }
    await mkdir(path.dirname(target), { recursive: true })
    await copyFile(metadataFile.file, target)
    staticFiles[metadataFile.outputPath] = {
      status: 200,
      headers: [
        ['content-type', metadataFile.contentType],
        ['cache-control', staticMetadataCacheControl],
      ],
    }
  }
}

export function staticHtmlPath(outPath: string, routePath: string, flatLayout = false) {
  if (routePath === '/') return path.join(outPath, 'public', 'index.html')
  const normalized = routePath.replace(/^\/|\/$/g, '')
  // output:'export' with trailingSlash:false lays pages out flat (`/a.html`);
  // otherwise (and always for trailingSlash:true) each page gets its own dir
  // (`/a/index.html`).
  if (flatLayout) return safePublicPath(outPath, `${normalized}.html`)
  return safePublicPath(outPath, normalized, 'index.html')
}

// Percent-encode generateStaticParams values the way Next encodes them into
// prerender URLs: params reach the page render as URL segments (`%20`, `%26`),
// one encoded element per catch-all entry.
function encodeStaticRouteParams(
  params: Record<string, RouteParamValue>,
): Record<string, RouteParamValue> {
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.map(encodeURIComponent) : encodeURIComponent(value),
    ]),
  )
}

function fillRoutePath(
  route: string,
  params: Record<string, RouteParamValue>,
  generatedParam?: string,
) {
  let value = route
  for (const [key, param] of Object.entries(params)) {
    const segment = Array.isArray(param) ? param.join('/') : param
    value = value.replace(`:${key}*`, segment).replace(`:${key}`, segment)
  }
  if (generatedParam && params[generatedParam] !== undefined) {
    const param = params[generatedParam]
    const segment = Array.isArray(param) ? param.join('/') : param
    value = value.replace(':id', segment)
  }
  return value
}

async function runWithNextBuildPhase<T>(task: () => Promise<T>): Promise<T> {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const previous = process.env.NEXT_PHASE
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  process.env.NEXT_PHASE = 'phase-production-build'
  try {
    return await task()
  } finally {
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    if (previous === undefined) delete process.env.NEXT_PHASE
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    else process.env.NEXT_PHASE = previous
  }
}

/**
 * The `use cache` SWR response headers for a stashed cacheLife, mirroring the register/use-cache.ts
 * finalizer. Baked into the manifest so a pure static HIT can re-emit them from start.ts - the
 * finalizer only fires on a live render. Returns [] when no cacheLife applies.
 */
function cacheLifeResponseHeaders(life: CacheLifeStash | undefined): [string, string][] {
  if (!life) return []
  const headers: [string, string][] = []
  const { revalidateSeconds, expireSeconds, staleSeconds } = life
  if (revalidateSeconds !== undefined && expireSeconds !== undefined) {
    const swr = Math.max(0, expireSeconds - revalidateSeconds)
    headers.push(['cache-control', `s-maxage=${revalidateSeconds}, stale-while-revalidate=${swr}`])
  }
  if (staleSeconds !== undefined) {
    headers.push(['x-nextjs-stale-time', String(staleSeconds)])
  }
  return headers
}

/** Effective ISR TTL: the lowest of the segment `revalidate` export and any data-cache revalidate used during the render. */
function combineRevalidate(
  segmentRevalidate: number | false | undefined,
  collected: number | undefined,
): number | undefined {
  const candidates = [
    ...(typeof segmentRevalidate === 'number' && segmentRevalidate > 0 ? [segmentRevalidate] : []),
    ...(collected !== undefined && collected > 0 ? [collected] : []),
  ]
  if (candidates.length === 0) return undefined
  return Math.min(...candidates)
}

function staticRouteHandlerPath(outPath: string, routePath: string) {
  return safePublicPath(outPath, routePath.replace(/^\/+/, '') || 'index')
}

/**
 * A handler route '/api' wants the FILE public/api while any static output under '/api/...' needs
 * public/api to be a DIRECTORY. Whichever lands second cannot be written, so detect that instead of
 * letting writeFile/mkdir hard-fail the build. Callers skip the static copy with a warning and the
 * route serves dynamically (start's static lookup only matches real files, then falls through).
 */
function staticOutputCollision(outPath: string, file: string): string | null {
  const publicPath = path.join(outPath, 'public')
  if (existsSync(file) && statSync(file).isDirectory()) {
    return `${toPosixPath(path.relative(publicPath, file))} already exists as a directory`
  }
  let dir = path.dirname(file)
  while (dir !== publicPath && dir !== path.dirname(dir)) {
    if (existsSync(dir)) {
      if (!statSync(dir).isDirectory()) {
        return `${toPosixPath(path.relative(publicPath, dir))} already exists as a file`
      }
      break
    }
    dir = path.dirname(dir)
  }
  return null
}

/**
 * The prerender skip-and-warn path is for RENDER-TIME failures - a user component throwing while
 * generating static output. A `ReferenceError`/`TypeError`/`SyntaxError` originating in the build
 * pipeline itself is a programming bug: swallowing it into `warnSkippedStatic` misattributes the
 * message and hides the real stack. Rethrow those with their original stack so the build fails
 * loudly; keep skip-and-warn for everything else.
 */
function rethrowIfProgrammingError(error: unknown): void {
  if (
    error instanceof ReferenceError ||
    error instanceof SyntaxError ||
    (error instanceof TypeError && isBuildInternalStack(error))
  ) {
    throw error
  }
}

// A TypeError is ambiguous — user render code throws them legitimately. Only
// rethrow when the top of the stack points at pnext's own build/routing/render
// internals rather than app code, so a genuine render-time `TypeError` still
// degrades to skip-and-warn.
function isBuildInternalStack(error: Error): boolean {
  const stack = error.stack ?? ''
  const firstFrame = stack.split('\n').find(line => /^\s*at\s/.test(line)) ?? ''
  return /packages[/\\]pnext[/\\]src[/\\]/.test(firstFrame)
}

// Next's NEXT_DEBUG_BUILD static-bailout diagnostic, grepped verbatim by the
// e2e suites ("should output debug info for static bailouts").
function logStaticBailout(routePath: string, reason: string) {
  console.log(`Static generation failed due to dynamic usage on ${routePath}, reason: ${reason}`)
}

// Best-effort label for WHICH request API kept the route dynamic (Next names
// the first dynamic API hit during its build attempt, e.g. "headers").
async function requestApiBailoutReason(route: RouteManifestEntry): Promise<string> {
  for (const file of ownSourceFiles(route)) {
    let source: string
    try {
      source = await readText(file)
    } catch {
      continue
    }
    const match = /\b(headers|cookies|draftMode|connection)\s*\(/.exec(source)
    if (match?.[1]) return match[1]
  }
  return 'dynamic usage'
}

// The route's own source files (the closure also carries framework/compat
// modules, whose bodies mention every request API and every scheduler).
function ownSourceFiles(route: RouteManifestEntry): string[] {
  const frameworkRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..')
  return route.sourceFiles.filter(file => {
    const resolved = path.resolve(file)
    return (
      !resolved.includes(`${path.sep}node_modules${path.sep}`) &&
      !resolved.startsWith(frameworkRoot + path.sep)
    )
  })
}

/**
 * Does the route schedule work that outlives its render? Only then can a request
 * API call escape the render pass, so only then is the deferred-usage probe
 * worth a build-time render.
 */
async function schedulesDeferredWork(route: RouteManifestEntry): Promise<boolean> {
  for (const file of ownSourceFiles(route)) {
    let source: string
    try {
      source = await readText(file)
    } catch {
      continue
    }
    if (/\b(?:setTimeout|setImmediate|queueMicrotask)\s*\(/.test(source)) return true
  }
  return false
}

/**
 * Wrap the deferred-work schedulers so a callback that throws after the render has finished is
 * reported instead of taking the build process down with it. The callbacks still run for real, so
 * what surfaces is the genuine error - this only decides who catches it.
 */
function captureDeferredFailures(record: (error: unknown) => void) {
  const globals = globalThis as unknown as Record<string, (...args: unknown[]) => unknown>
  const originals = new Map<string, (...args: unknown[]) => unknown>()
  for (const name of ['setTimeout', 'setImmediate', 'queueMicrotask']) {
    const original = globals[name]
    if (typeof original !== 'function') continue
    originals.set(name, original)
    globals[name] = function patched(this: unknown, callback: unknown, ...rest: unknown[]) {
      if (typeof callback !== 'function') return original.call(this, callback, ...rest)
      const guarded = function guardedCallback(this: unknown, ...args: unknown[]) {
        try {
          const value = (callback as (...inner: unknown[]) => unknown).apply(this, args)
          if (isThenable(value)) void value.then(undefined, record)
          return value
        } catch (error) {
          record(error)
        }
      }
      return original.call(this, guarded, ...rest)
    }
  }
  return () => {
    for (const [name, original] of originals) globals[name] = original
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === 'function'
}

/**
 * Render the route once with no request so a request API called from deferred
 * work throws, and report it the way Next reports a prerender that leaked a
 * dynamic API. A throw DURING the render is the ordinary static bailout (Next
 * catches it and serves the route dynamically), so that stays silent.
 */
async function probeDeferredDynamicUsage(
  config: Awaited<ReturnType<typeof loadConfig>>,
  route: RouteManifestEntry,
  staticMetadataFiles: StaticMetadataFile[],
  staticModuleMetadata: Record<string, StaticModuleMetadata>,
): Promise<void> {
  const routePath = toNextRoutePattern(route.route || '/')
  const failures: unknown[] = []
  const restore = captureDeferredFailures(error => failures.push(error))
  beginDynamicBailoutProbe(routePath)
  try {
    await runWithWorkUnit('render', () =>
      getRenderExtensions().collectRenderMeta(
        () =>
          runWithNextBuildPhase(() =>
            withRouteRuntime(route.segmentConfig?.runtime, () =>
              renderPageWithStatus({
                config,
                route,
                params: {},
                url: new URL(`http://pnext.local${route.route || '/'}`),
                staticMetadataFiles,
                staticModuleMetadata,
              }),
            ),
          ),
        { route: route.route || '/', prerender: true },
      ),
    )
    // Give a 0ms timer scheduled during the render its turn before we stop
    // listening; anything slower keeps the route dynamic without a report.
    await new Promise(resolve => setTimeout(resolve, 0))
  } catch {
    // Ordinary bailout (or an unrelated prerender failure): the route just
    // stays dynamic, exactly as it already did without the probe.
    return
  } finally {
    endDynamicBailoutProbe()
    restore()
  }
  for (const failure of failures) {
    if (!(failure instanceof Error) || failure.name !== 'DynamicServerError') continue
    console.error(
      `Error occurred prerendering page "${routePath}". Read more: https://nextjs.org/docs/messages/prerender-error`,
    )
    console.error(`${failure.name}: ${failure.message}`)
  }
}

function warnSkippedStatic(routePath: string, reason: string) {
  console.warn(
    `pnext build: skipping static output for ${routePath} (${reason}); the route will be served dynamically`,
  )
}

// pnext routes carry Express-style `:param` / `:...catchAll` segments; Next's
// build diagnostics name routes in `[param]` / `[...catchAll]` form.
function toNextRoutePattern(route: string): string {
  return route.replace(/:\.\.\.([^/]+)/g, '[...$1]').replace(/:([^/]+)/g, '[$1]')
}

// A throwing after() during a prerender is tagged by the compat after() runtime
// (Symbol.for keeps this file decoupled from the compat layer). Unlike a plain
// render throw — which degrades the route to dynamic — it must fail the build.
function isAfterPrerenderError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as Record<symbol, unknown>)[Symbol.for('pnext.afterPrerenderError')] === true
  )
}

/** Symlink-resolved path, for comparing two spellings of one file. Missing files keep their path. */
function realFilePath(file: string): string {
  try {
    return realpathSync.native(file)
  } catch {
    return path.resolve(file)
  }
}

function safePublicPath(outPath: string, ...segments: string[]) {
  const publicPath = path.join(outPath, 'public')
  const file = path.join(publicPath, ...segments)
  const relative = path.relative(publicPath, file)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Static output path escapes public directory: ${segments.join('/')}`)
  }
  return file
}

/**
 * Copy the Partytown vendored library into public/_next/static/~partytown/ when
 * experimental.nextScriptWorkers is enabled. Resolves the package `lib/` dir from the app root
 * (current or legacy scope); a missing package is tolerated - the injected loader snippet still
 * points here, and the 404 is the user's to resolve by installing partytown.
 */
async function copyPartytownLib(config: Awaited<ReturnType<typeof loadConfig>>) {
  if (!nextCompatEnabled(config)) return
  if (!buildCompat().nextScriptWorkersEnabled()) return

  const libDir = resolvePartytownLibDir(config.root)
  if (!libDir) {
    console.warn(
      'pnext build: experimental.nextScriptWorkers is enabled but no Partytown package was found ' +
        '(@qwik.dev/partytown or @builder.io/partytown); worker scripts will 404 the library until it is installed',
    )
    return
  }
  const target = path.join(config.outPath, 'public', '_next', 'static', '~partytown')
  await mkdir(target, { recursive: true })
  await copyPublicDir(libDir, target)
}

// Locate the Partytown package `lib/` dir from the app root, preferring the
// current `@qwik.dev/partytown` over the legacy `@builder.io/partytown`. Returns
// null when neither resolves.
function resolvePartytownLibDir(root: string): string | null {
  const requireFromRoot = createRequire(path.join(root, 'package.json'))
  for (const pkg of ['@qwik.dev/partytown', '@builder.io/partytown']) {
    try {
      const pkgJson = requireFromRoot.resolve(`${pkg}/package.json`)
      const libDir = path.join(path.dirname(pkgJson), 'lib')
      if (existsSync(libDir) && statSync(libDir).isDirectory()) return libDir
    } catch {
      // Package not installed; try the next candidate.
    }
  }
  return null
}

async function copyPublicDir(from: string, to: string) {
  const files = await listFiles(from)
  for (const file of files) {
    const relative = toPosixPath(path.relative(from, file))
    const target = path.join(to, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await copyFile(file, target)
  }
}
