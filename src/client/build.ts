import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  build,
  type BuildOptions,
  type Metafile,
  type OnResolveArgs,
  type OnResolveOptions,
  type OnResolveResult,
  type Plugin,
  type PluginBuild,
  type ResolveResult,
} from 'esbuild'
import { foldInitialChunks } from './chunk-fold'
import { clientEntryName } from './chunk-name'
import { assetContentHash } from '../utils/asset-hash'
import { clientProfile } from './profile'
import { frameworkRuntimeAliasEntries, publicEnvDefines, type ResolvedConfig } from '../config'
import { cssModuleClientPlugin } from '../css/build'
import { withAssetPrefix } from '../css/build'
import {
  devDynamicSplitEnabled,
  rewriteDeferredDynamicImports,
  rewriteLiteralDynamicCalls,
} from '../resolve/dynamic'
import { scanFacts } from '../resolve/scan-facts'
import { readSourceText } from '../resolve/source-text'
import { ensureDir, listFiles, readText, writeText } from '../utils/fs'
import { escapeRegex } from '../utils/code'
import {
  getExternalPackagePolicy,
  resolveImport,
  resolveLinkedPackageSpecifier,
} from '../resolve/imports'
import {
  CLIENT_RUNTIME_MODULE,
  clientEntrySource,
  clientRuntimeFacts,
  clientRuntimeSource,
  type ClientRuntimeFacts,
} from './entry'
import { clientSuspenseFree } from './react-tier'
import {
  ensurePrebuiltRuntime,
  prebuiltAssets,
  prebuiltExternalPlugin,
  prebuiltModuleUrl,
  prebuiltRuntimeKey,
  prebuiltSpecifierFilter,
  settlePrebuiltRuntime,
  type PrebuiltRuntime,
} from './prebuilt'
import { findLayouts } from '../routing/routes'
import { clientReferenceId, ssrClientReference, type ClientReference } from './reference'
import { shouldReactCompile, transformReactCompiler } from './react-compiler'
import { createVerboseLogger, formatDuration } from '../utils/verbose'
import { dim as dimText } from '../utils/ansi'
import { traceEnabled } from '../utils/trace-flags'
import { frameworkFingerprint } from '../runtime/fingerprint'
import type { RouteManifestEntry } from '../types'
import {
  applyClientSourceAsyncPreTransforms,
  applyClientSourceTransforms,
  getAssetExtensions,
  getBundlerExtensions,
  getCompatModeExtensions,
  getImportAliasExtensions,
  hasClientSourceAsyncPreTransforms,
  type CompatModeExtensions,
} from '../extensions'

/**
 * Write the standalone static chunks a bundler extension supplies (compat: the
 * no-module polyfills chunk) verbatim into the client `chunks/` dir. These sit
 * outside esbuild's entry graph, so they are emitted here rather than through a
 * build. No-op for pure-core apps (the seam returns none).
 */
export async function emitStaticClientChunks(config: ResolvedConfig, outDir: string) {
  const chunks = getBundlerExtensions().staticClientChunks(config)
  if (chunks.length === 0) return
  const chunksDir = path.join(outDir, 'chunks')
  await ensureDir(chunksDir)
  for (const chunk of chunks) {
    await writeText(path.join(chunksDir, chunk.name), chunk.contents)
  }
}

interface ClientBuildOptions {
  config: ResolvedConfig
  route: RouteManifestEntry
  outDir: string
  dev?: boolean
}

interface ClientBatchBuildOptions {
  config: ResolvedConfig
  routes: RouteManifestEntry[]
  outDir: string
  verbose?: boolean
  /**
   * Dev-server batch build: one esbuild graph over every client route, exactly like prod.
   * Per-route dev builds gave each route its own module graph, so shared libraries existed
   * as per-route copies — context identity broke across navigations and every soft nav
   * remounted the app shell (user-visible splash). Module identity must hold by construction.
   */
  dev?: boolean
  /**
   * The app defines at least one server action (the build's action manifest). Unset means "unknown" -
   * dev, where the manifest is discovered per request - and the action runtime is emitted, since only
   * prod bundles are budgeted.
   */
  hasServerActions?: boolean
  /**
   * A pipeline already warmed by the caller (the build starts one under the
   * route-fact scan). Omitted — dev, tests — the stage opens its own.
   */
  pipeline?: ClientSourcePipeline
}

const virtualEntryNamespace = 'pnext-client-entry'

function nextCompatEnabled(config: ResolvedConfig) {
  return getCompatModeExtensions().nextEnabled(config)
}

/**
 * Convention-file lookups (error / not-found / global-error / layout) are directory walks with four
 * `existsSync` probes per level, and the entry builder asks the same questions of the same
 * directories once per route. Memoized for the duration of one build and cleared at each entry
 * point, so a dev rebuild re-stats after a file is added or removed.
 */
const conventionCache = new Map<string, unknown>()

function memoConvention<T>(key: string, compute: () => T): T {
  if (conventionCache.has(key)) return conventionCache.get(key) as T
  const value = compute()
  conventionCache.set(key, value)
  return value
}

/**
 * Whether the action client runtime is emitted at all. Two app facts feed it:
 * the build's own action manifest, and the scan's `actions`/`form` client-entry
 * reasons (a `<form action={fn}>` or next/form the manifest cannot see). Either
 * one unset (dev) keeps the runtime, so only a provably action-free prod app
 * drops it.
 */
function appUsesActions(routes: RouteManifestEntry[], hasServerActions?: boolean) {
  if (hasServerActions !== false) return true
  return routes.some(route =>
    route.clientEntryReasons?.some(reason => reason === 'actions' || reason === 'form'),
  )
}

/**
 * Per-route half of the same question: the scan stamps `actions`/`form` reasons on every page whose
 * closure can dispatch one, so a route carrying neither ships no action runtime even in an app with
 * actions elsewhere.
 */
function routeUsesActions(route: RouteManifestEntry, appActions: boolean) {
  if (!appActions) return false
  return (
    route.clientEntryReasons?.some(reason => reason === 'actions' || reason === 'form') === true
  )
}

/**
 * A `'use client'` module in the route graph calls notFound()/forbidden()/unauthorized(). The throw
 * happens during hydration, so the boundary - which renders its built-in 404 with no not-found.*
 * file - has to be in the tree to catch it.
 */
function routeThrowsClientControlFlow(route: RouteManifestEntry): boolean {
  return route.clientEntryReasons?.includes('control-flow') === true
}

function routeErrorFile(config: ResolvedConfig, route: RouteManifestEntry): string | undefined {
  return routeConventionFile(config, route, 'error')
}

function routeNotFoundFile(config: ResolvedConfig, route: RouteManifestEntry): string | undefined {
  return routeConventionFile(config, route, 'not-found')
}

// Nearest segment convention file for a route: walked from the page's own
// segment up to the app root.
function routeConventionFile(
  config: ResolvedConfig,
  route: RouteManifestEntry,
  name: string,
): string | undefined {
  if (!nextCompatEnabled(config)) return undefined
  const appPath = path.resolve(config.appPath)
  const start = path.dirname(path.resolve(route.file))
  const relative = path.relative(appPath, start)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined
  // Memoized per directory, not per route: sibling routes walk the same chain,
  // and a parent's answer is the tail of every child's walk.
  return memoConvention(`${name}\0${start}`, () => {
    let dir = start
    for (;;) {
      for (const ext of ['tsx', 'ts', 'jsx', 'js']) {
        const candidate = path.join(dir, `${name}.${ext}`)
        if (existsSync(candidate)) return candidate
      }
      if (dir === appPath) return undefined
      const parent = path.dirname(dir)
      if (parent === dir) return undefined
      dir = parent
    }
  })
}

// The app-root global-error.* convention file (single per app, unlike error.*
// which is per-segment): threaded into the client entry so installClientErrors
// can mount a user global-error component for client throws that escape every
// route error boundary. Absent → the built-in fallback document is used.
function globalErrorFile(config: ResolvedConfig): string | undefined {
  if (!nextCompatEnabled(config)) return undefined
  const appPath = path.resolve(config.appPath)
  return memoConvention(`global-error\0${appPath}`, () => {
    for (const ext of ['tsx', 'ts', 'jsx', 'js']) {
      const candidate = path.join(appPath, `global-error.${ext}`)
      if (existsSync(candidate)) return candidate
    }
    return undefined
  })
}

/**
 * Whether the route's ROOT layout is itself a `'use client'` component. Only
 * then does the client entry re-render the whole document body through that
 * layout at hydration (the client-shell path). Mirrors the renderer's
 * `rootIsClient` check (render/renderer.ts) so the two stay in lock-step: the
 * renderer marks the root layout's slots with `data-pnext-slot` exactly when
 * this is true, and the shell path depends on those markers.
 */
function hasClientRootLayout(config: ResolvedConfig, route: RouteManifestEntry): boolean {
  if (route.client) return false
  const rootLayout = shellLayoutOrder(config, route)[0]
  if (!rootLayout) return false
  return route.clientReferences.some(reference => reference.file === rootLayout)
}

/**
 * Layout files outermost-first, from the layout hierarchy - NOT from `route.clientReferences`, whose
 * path-hash sort can put a non-layout reference ahead of the root layout and make the shell drop its
 * subtree.
 */
function shellLayoutOrder(config: ResolvedConfig, route: RouteManifestEntry): string[] {
  // Asked three times per route (shell order, client-root check, runtime facts).
  return memoConvention(`layouts\0${config.appPath}\0${route.file}`, () =>
    findLayouts(config.appPath, route.file),
  )
}

/**
 * Where the artifact lives. In dev it must sit OUTSIDE `config.outPath`: a cold
 * page is defined by that directory being wiped, and an artifact wiped with it
 * would be rebuilt on exactly the request it exists to make cheap. In prod it
 * ships beside the entries, and entries reach it by a RELATIVE url so any
 * basePath/assetPrefix applies to it for free.
 */
function prebuiltLocation(config: ResolvedConfig, outDir: string, key: string, dev: boolean) {
  if (dev) {
    return {
      dir: prebuiltRuntimeDir(config, key),
      publicPath: `/__pnext/runtime/${key}`,
      assetPath: `__pnext/runtime/${key}`,
    }
  }
  // The SERVED url, not a relative one: chunks sit a directory below the
  // entries, so no single relative path is correct from both — and esbuild
  // writes an external path through verbatim, the same string everywhere.
  const served = nextCompatEnabled(config) ? `/_next/static/rt/${key}` : `/assets/rt/${key}`
  return {
    dir: path.join(outDir, 'rt', key),
    publicPath: withAssetPrefix(config, served),
    assetPath: `assets/rt/${key}`,
  }
}

/** Where the dev server reads the artifact back from. */
export function prebuiltRuntimeDir(config: ResolvedConfig, key: string) {
  return path.join(config.root, 'node_modules', '.cache', 'pnext', 'client-runtime', key)
}

/**
 * Opt-in, not default: the prebuild halves a cold page's client preload stage but costs bytes, and
 * per-surface keying (`surfaceGroups`) does not recover them - the artifact's re-export boundary
 * adds gz per page and pushes the core "all features used" ceiling over its cell. Keying only pays
 * when routes demand genuinely different surfaces.
 * `=1` to enable, `PNEXT_PREBUILT_GROUPS=0` for the shared-artifact arm.
 */
function prebuiltEnabled() {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  return process.env.PNEXT_PREBUILT_RUNTIME === '1'
}

/**
 * The framework surface one route's generated entry demands, as a string. A pure function of the
 * compat facts `routerImportSource` emits its imports from and of the route's own
 * `ClientRuntimeFacts` - the two records that decide every framework import an entry makes. Error /
 * not-found files enter as booleans, not paths: two routes with different `error.tsx` files import
 * the same framework names.
 */
function surfaceSignature(config: ResolvedConfig, route: RouteManifestEntry, actions: boolean) {
  const nextCompat = nextCompatEnabled(config)
  const facts = clientRuntimeFacts(
    [
      {
        route,
        shell: hasClientRootLayout(config, route),
      },
    ],
    nextCompat,
    !routeSuspenseFree(config, route),
  )
  return JSON.stringify([
    nextCompat,
    actions,
    Boolean(routeErrorFile(config, route)),
    Boolean(globalErrorFile(config)),
    Boolean(routeNotFoundFile(config, route)),
    routeThrowsClientControlFlow(route) === true,
    Boolean(route.needsRouterEntry),
    facts,
  ])
}

interface PreparedPrebuilt {
  runtime: PrebuiltRuntime
  plugin: Plugin
  /** Fold what the build demanded into the artifact. */
  settle(): Promise<void>
}

/**
 * Open the prebuilt artifact for a client build, or return undefined when the
 * prebuild is off. The returned plugin routes every framework specifier at the
 * artifact; `settle()` afterwards covers whatever the build turned out to need.
 */
async function preparePrebuilt(
  config: ResolvedConfig,
  outDir: string,
  dev: boolean,
  sourceOf: (importer: string) => string | undefined,
  signature = '',
  reactLite = false,
): Promise<PreparedPrebuilt | undefined> {
  if (!prebuiltEnabled()) return undefined
  const buildOptions = baseClientBuildOptions(config, dev)
  const key = prebuiltRuntimeKey(config, buildOptions, signature)
  const { dir, publicPath, assetPath } = prebuiltLocation(config, outDir, key, dev)
  // The artifact build gets the same plugin chain — and therefore the same
  // aliases, transforms and asset seam — as the route build it stands in for.
  // Not the prebuilt plugin itself: inside the artifact, framework imports are
  // exactly what is being bundled.
  const options = {
    aliases: Object.keys(getImportAliasExtensions().aliases(config, 'client')),
    key,
    dir,
    publicPath,
    assetPath,
    buildOptions,
    plugins: () => clientBuildPlugins(config, createClientSourcePipeline(config), [], reactLite),
  }
  const runtime = await ensurePrebuiltRuntime(options)
  const unprobed = new Set<string>()
  return {
    runtime,
    plugin: prebuiltExternalPlugin(runtime, prebuiltSpecifierFilter(config), unprobed, sourceOf),
    async settle() {
      await settlePrebuiltRuntime(runtime, options, outDir, unprobed)
    },
  }
}

/**
 * The served URL of a deferred dynamic reference's on-demand output (dev split).
 * `r` names the route whose build emitted it: two routes reaching the same island
 * each bundle their own, and one route's copy chunk-splits against its own entry.
 */
export function deferredDynamicChunkHref(reference: Pick<ClientReference, 'id'>, routeId?: string) {
  const query = routeId ? `?r=${encodeURIComponent(routeId)}` : ''
  return `/__pnext/client-dyn/${reference.id}.js${query}`
}

/** Where the dev server serves this build's chunks from (see publicPath). */
export const devClientPublicPath = '/__pnext/client'

export interface DeferredDynamicEntry {
  id: string
  file: string
}

/**
 * Every deferred reference this route's build must emit an output for: the ones
 * the route scan named, plus the ones its own pipeline rewrite registered.
 */
function deferredDynamicEntries(route: RouteManifestEntry): DeferredDynamicEntry[] {
  const entries = new Map<string, string>()
  for (const reference of route.clientReferences) {
    if (reference.dynamic && !ssrClientReference(reference)) {
      entries.set(reference.id, reference.file)
    }
  }
  for (const [id, ref] of deferredDynamicRouteRefs.get(route.id) ?? []) entries.set(id, ref.file)
  return [...entries].map(([id, file]) => ({ id, file }))
}

export interface DeferredDynamicRef {
  file: string
  exportName: string
  /** Entry that rewrote this reference: the build its output is emitted by. */
  routeId?: string
}

// Process-level registry the dev chunk endpoint resolves ids through. Entries
// come from the pipeline rewrite below and from each out-dir's sidecar (a
// restart serving a cached entry never re-ran the rewrite).
const deferredDynamicRefs = new Map<string, DeferredDynamicRef>()
// Indexed by route as well: a route's build needs every reference it reached as
// an entry point, and a rewrite only names them once the build has run.
const deferredDynamicRouteRefs = new Map<string, Map<string, DeferredDynamicRef>>()

export function registerDeferredDynamicRef(id: string, ref: DeferredDynamicRef) {
  deferredDynamicRefs.set(id, ref)
  if (!ref.routeId) return
  const refs = deferredDynamicRouteRefs.get(ref.routeId) ?? new Map<string, DeferredDynamicRef>()
  deferredDynamicRouteRefs.set(ref.routeId, refs)
  refs.set(id, ref)
}

export function deferredDynamicRefById(id: string) {
  return deferredDynamicRefs.get(id)
}

/** Sidecar name persisted next to a dev entry naming its deferred dynamic refs. */
export const DEFERRED_DYNAMIC_SIDECAR = 'dyn-refs.json'

/** Dev-only: deferred dynamic references load from the on-demand chunk endpoint. */
function devDeferredDynamicHref(dev: boolean | undefined, routeId?: string) {
  if (!dev || !devDynamicSplitEnabled()) return undefined
  return (reference: ClientReference) =>
    reference.dynamic && !ssrClientReference(reference)
      ? deferredDynamicChunkHref(reference, routeId)
      : undefined
}

/** Deferred chunk URLs resolve at runtime, never inside the entry build. */
function deferredDynamicExternalPlugin(): Plugin {
  return {
    name: 'pnext-dyn-split-external',
    setup(build) {
      build.onResolve({ filter: /^\/__pnext\/client-dyn\// }, args => ({
        path: args.path,
        external: true,
      }))
    },
  }
}

export async function buildClientEntry({ config, route, outDir, dev }: ClientBuildOptions) {
  conventionCache.clear()
  await ensureDir(outDir)
  const suspense = routeSuspenseFree(config, route) === false
  const source = clientEntrySource({
    deferredDynamicHref: devDeferredDynamicHref(dev, route.id),
    pageFile: route.client ? route.file : undefined,
    clientReferences: route.clientReferences,
    nextCompat: nextCompatEnabled(config),
    suspense,
    // Single-route (dev / batch fallback) build: no app-wide action manifest here.
    actions: true,
    errorFile: routeErrorFile(config, route),
    globalErrorFile: globalErrorFile(config),
    notFoundFile: routeNotFoundFile(config, route),
    controlFlow: routeThrowsClientControlFlow(route),
    router: Boolean(route.needsRouterEntry),
    clientRootLayout: hasClientRootLayout(config, route),
    shellLayoutOrder: shellLayoutOrder(config, route),
  })
  const entryName = clientEntryName(route)
  const outfile = path.join(outDir, `${entryName}.js`)
  const pipeline = createClientSourcePipeline(config, dev === true, route.id)
  pipeline.warmRoutes([route])
  const runtimeFacts: ClientRuntimeFacts = {
    ...clientRuntimeFacts(
      [
        {
          route,
          shell: hasClientRootLayout(config, route),
        },
      ],
      nextCompatEnabled(config),
      suspense,
    ),
    dev: dev === true,
  }
  const prebuilt = await clientProfile.timeAsync('prebuilt', () =>
    preparePrebuilt(
      config,
      outDir,
      dev === true,
      importer =>
        importer === CLIENT_RUNTIME_MODULE
          ? clientRuntimeSource(runtimeFacts)
          : (pipeline.sourceOf(importer) ?? readTextSyncSafe(importer)),
      // One route is its own surface group, so the key is the same one the batch
      // build would give this route's group — dev and prod derive it identically.
      surfaceSignature(config, route, true),
      !suspense,
    ),
  )

  const split = Boolean(devDeferredDynamicHref(dev))
  const runEntryBuild = (dynEntries: DeferredDynamicEntry[]) =>
    build({
      ...baseClientBuildOptions(config, dev),
      // Every deferred reference is an entry point of THIS build, so esbuild
      // hoists what it shares with the route entry into a shared chunk. Module
      // identity — contexts, singletons, the preact instance — then holds by
      // construction, and esbuild owns the interop it always did.
      entryPoints: [
        { in: virtualEntryPath(route.id), out: entryName },
        ...dynEntries.map(entry => ({ in: entry.file, out: entry.id })),
      ],
      // Chunk imports as absolute URLs: an on-demand output is served from a
      // different directory than the entry, and a relative specifier would make
      // the browser fetch the same chunk under two URLs — two module instances.
      ...(split ? { publicPath: devClientPublicPath } : {}),
      outdir: outDir,
      metafile: true,
      plugins: clientBuildPlugins(
        config,
        pipeline,
        [
          ...(prebuilt ? [prebuilt.plugin] : []),
          virtualEntryPlugin([{ route, source }]),
          ...(split ? [deferredDynamicExternalPlugin()] : []),
          clientRuntimePlugin(runtimeFacts),
        ],
        !suspense,
      ),
    })

  let metafile: Metafile | undefined
  let dynEntries = split ? deferredDynamicEntries(route) : []
  try {
    const result = await profileClientBuild(route, dev, () =>
      clientProfile.timeAsync('esbuild', () => runEntryBuild(dynEntries)),
    )
    metafile = result.metafile
  } catch (error) {
    throw withClientImportTrace(error, config, route, source)
  }
  // A dynamic() inside a 'use client' module is only named by the pipeline's
  // rewrite, which runs mid-build: those references become entry points on the
  // rebuild here, and stay ones from then on (the registry outlives the build).
  if (split) {
    const discovered = deferredDynamicEntries(route)
    if (discovered.length !== dynEntries.length) {
      dynEntries = discovered
      metafile = (
        await clientProfile.timeAsync('esbuildDynEntries', () => runEntryBuild(dynEntries))
      ).metafile
    }
  }
  await clientProfile.timeAsync('prebuiltSettle', () => prebuilt?.settle() ?? Promise.resolve())

  if (metafile) {
    metafile = await clientProfile.timeAsync('fold', () =>
      foldInitialChunks({
        outDir,
        metafile: metafile!,
        buildOptions: baseClientBuildOptions(config, dev),
      }),
    )
  }
  await clientProfile.timeAsync('write', () => nameSharedClientChunks(outDir, metafile))
  if (dev && devDynamicSplitEnabled() && pipeline.deferredRefs().size > 0) {
    await writeText(
      path.join(outDir, DEFERRED_DYNAMIC_SIDECAR),
      JSON.stringify(Object.fromEntries(pipeline.deferredRefs())),
    )
  }
  clientProfile.report(`client entry ${route.id}`)

  return outfile
}

/**
 * Bundle every route's client entry in a single esbuild build. With `splitting`
 * enabled, esbuild emits the shared dependency graph (preact runtime, ui kit,
 * trpc/auth clients) into shared chunks once, instead of re-bundling it from
 * scratch for each route. This turns N independent multi-second builds into one.
 */
export async function buildClientEntries({
  config,
  routes,
  outDir,
  verbose,
  hasServerActions,
  pipeline: warmed,
  dev,
}: ClientBatchBuildOptions) {
  if (!warmed) conventionCache.clear()
  const actions = appUsesActions(routes, hasServerActions)
  const entries = clientProfile.time('entrySources', () =>
    routes
      .filter(route => route.client || route.clientReferences.length > 0 || route.needsRouterEntry)
      .map(route => ({
        route,
        entryName: clientEntryName(route),
        source: clientEntrySource({
          deferredDynamicHref: devDeferredDynamicHref(dev, route.id),
          pageFile: route.client ? route.file : undefined,
          clientReferences: route.clientReferences,
          nextCompat: nextCompatEnabled(config),
          suspense: !routeSuspenseFree(config, route),
          actions: routeUsesActions(route, actions),
          errorFile: routeErrorFile(config, route),
          globalErrorFile: globalErrorFile(config),
          notFoundFile: routeNotFoundFile(config, route),
          controlFlow: routeThrowsClientControlFlow(route),
          router: Boolean(route.needsRouterEntry),
          clientRootLayout: hasClientRootLayout(config, route),
          shellLayoutOrder: shellLayoutOrder(config, route),
        }),
      })),
  )
  if (entries.length === 0) return
  // Every route's client sources start their transform and React Compiler pass here, in one batch on
  // oxc's threadpool, while esbuild is still booting and walking the graph. A caller-warmed pipeline
  // has them in flight already; warming twice is a Map hit, so the same call covers both.
  const pipeline = warmed ?? createClientSourcePipeline(config, dev === true)
  pipeline.warmRoutes(entries.map(entry => entry.route))
  await ensureDir(outDir)
  const groups = surfaceGroups(config, entries, actions)
  clientProfile.count('group#', groups.length)
  const built: BuiltEntryGroup[] = []
  for (const group of groups) {
    built.push(await buildEntryGroup({ config, outDir, entries, group, pipeline, verbose, dev }))
  }

  // Fold and rename once over the finished output, never per group. Chunk names
  // are content hashes, so two groups emit the same file for the same chunk —
  // and the fold DELETES the members it merges, so a per-group fold would
  // unlink a chunk another group's manifest still points at.
  let merged: Metafile = { inputs: {}, outputs: {} }
  for (const item of built) {
    if (!item.metafile) continue
    Object.assign(merged.inputs, item.metafile.inputs)
    Object.assign(merged.outputs, item.metafile.outputs)
  }
  merged = await clientProfile.timeAsync('fold', () =>
    // `dev` is load-bearing, not cosmetic: the fold rides the minify flag and must stay a no-op in
    // dev. Dev emits absolute publicPath specifiers, which the fold's rewriter cannot express — it
    // would unlink the merged members and leave every entry importing a deleted chunk.
    foldInitialChunks({
      outDir,
      metafile: merged,
      buildOptions: baseClientBuildOptions(config, dev),
    }),
  )
  const renames = await clientProfile.timeAsync('write', () =>
    nameSharedClientChunks(outDir, merged),
  )
  // Entry-import lists become modulepreload links with prod /_next/static URLs; dev serves
  // chunks under /__pnext/client and re-derives everything per request, so baking prod URLs
  // onto the routes would emit preloads that 404 in the dev document.
  if (!dev) {
    clientProfile.time('entryImports', () => {
      for (const item of built) {
        if (item.metafile) {
          assignClientEntryImports(item.group.entries, merged, outDir, renames, item.prebuilt)
        }
      }
    })
  }
  // Dev serves entries by their stable route-derived names (/__pnext/client/<id>.js) and
  // re-resolves them per request; the immutable-content rename is prod-deploy machinery and
  // would also mutate route.clientEntry under the dev renderer's feet.
  if (!dev) {
    await clientProfile.timeAsync('fingerprint', () => fingerprintClientEntries(outDir, entries))
  }
  if (dev && devDynamicSplitEnabled() && pipeline.deferredRefs().size > 0) {
    await writeText(
      path.join(outDir, DEFERRED_DYNAMIC_SIDECAR),
      JSON.stringify(Object.fromEntries(pipeline.deferredRefs())),
    )
  }
  clientProfile.report('client stage')
}

/**
 * Give every route entry a CONTENT-hashed name, replacing the route-identity hash
 * clientEntryName picks for the build. These are served from /_next/static, which
 * is immutable: a name that outlives its bytes pins a stale runtime in every
 * browser that saw the previous deploy. Two routes whose entries are byte
 * identical collapse onto one file — a URL they can honestly share.
 */
async function fingerprintClientEntries(outDir: string, entries: ClientEntry[]) {
  await Promise.all(
    entries.map(async entry => {
      const from = path.join(outDir, `${entry.entryName}.js`)
      const bytes = await readFile(from).catch(() => undefined)
      if (!bytes) return
      const name = `pnext-client-${assetContentHash(bytes)}.js`
      entry.route.clientEntry = `assets/${name}`
      const to = path.join(outDir, name)
      if (to === from) return
      const sourceMap = `${from}.map`
      if (existsSync(sourceMap)) {
        // The linked map moves with the entry, so the comment has to move too.
        const source = bytes.toString('utf8').replaceAll(`${entry.entryName}.js.map`, `${name}.map`)
        await writeFile(to, source)
        await rm(from, { force: true })
        await rename(sourceMap, `${to}.map`)
        return
      }
      await rename(from, to)
    }),
  )
}

interface ClientEntry {
  route: RouteManifestEntry
  entryName: string
  source: string
}

interface SurfaceGroup {
  signature: string
  facts: ClientRuntimeFacts
  entries: ClientEntry[]
}

interface BuiltEntryGroup {
  group: SurfaceGroup
  metafile: Metafile | undefined
  prebuilt: PreparedPrebuilt | undefined
}

/**
 * Split the app's entries into the sets that share a framework surface - one esbuild build each,
 * because a shared module graph cannot resolve one specifier to two artifacts. With the prebuild
 * off there is exactly one group and this is the single batched build it has always been. The
 * split is what makes the artifact pay off on a multi-route app: shared, its initial tier is the
 * UNION of every route's demand, so a light route downloads a heavy one's closure. The cost is
 * that user code shared across two groups is bundled into both.
 */
function surfaceGroups(
  config: ResolvedConfig,
  entries: ClientEntry[],
  actions: boolean,
): SurfaceGroup[] {
  const facts = (members: ClientEntry[]) =>
    clientRuntimeFacts(
      members.map(entry => ({
        route: entry.route,
        shell: hasClientRootLayout(config, entry.route),
      })),
      nextCompatEnabled(config),
      !members.every(entry => routeSuspenseFree(config, entry.route)),
    )
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  if (!prebuiltEnabled() || process.env.PNEXT_PREBUILT_GROUPS === '0')
    return [{ signature: '', facts: facts(entries), entries }]
  const bySignature = new Map<string, ClientEntry[]>()
  for (const entry of entries) {
    const signature = surfaceSignature(config, entry.route, routeUsesActions(entry.route, actions))
    const members = bySignature.get(signature) ?? []
    bySignature.set(signature, members)
    members.push(entry)
  }
  return [...bySignature].map(([signature, members]) => ({
    signature,
    // Every member shares the signature, so the group's runtime facts ARE each
    // member's own — the shared runtime module stops carrying glue for shapes
    // no route in this group has.
    facts: facts(members),
    entries: members,
  }))
}

async function buildEntryGroup({
  config,
  outDir,
  entries,
  group,
  pipeline,
  verbose,
  dev,
}: {
  config: ResolvedConfig
  outDir: string
  /** Every entry in the app: the batch fallback and `sourceOf` span groups. */
  entries: ClientEntry[]
  group: SurfaceGroup
  pipeline: ClientSourcePipeline
  verbose?: boolean
  dev?: boolean
}): Promise<BuiltEntryGroup> {
  const facts: ClientRuntimeFacts = dev ? { ...group.facts, dev: true } : group.facts
  const reactLite = facts.suspense === false
  const prebuilt = await clientProfile.timeAsync('prebuilt', () =>
    preparePrebuilt(
      config,
      outDir,
      dev === true,
      importer => {
        if (importer === CLIENT_RUNTIME_MODULE) return clientRuntimeSource(facts)
        const entry = entries.find(item => item.route.id === importer)
        return entry?.source ?? pipeline.sourceOf(importer) ?? readTextSyncSafe(importer)
      },
      group.signature,
      reactLite,
    ),
  )

  let metafile: Metafile | undefined
  const split = Boolean(dev) && devDynamicSplitEnabled()
  const groupDynEntries = () => {
    const byId = new Map<string, DeferredDynamicEntry>()
    if (!split) return []
    for (const entry of group.entries) {
      for (const dynEntry of deferredDynamicEntries(entry.route)) byId.set(dynEntry.id, dynEntry)
    }
    return [...byId.values()]
  }
  let dynEntries = groupDynEntries()
  const runGroupBuild = () =>
    build({
      ...baseClientBuildOptions(config, dev),
      entryPoints: [
        ...group.entries.map(entry => ({
          in: virtualEntryPath(entry.route.id),
          out: entry.entryName,
        })),
        ...dynEntries.map(entry => ({ in: entry.file, out: entry.id })),
      ],
      // Absolute chunk URLs: an on-demand dyn output is served from a different path than
      // the entry, and a relative specifier would fetch one chunk under two URLs — two
      // module instances (see buildClientEntry).
      ...(split ? { publicPath: devClientPublicPath } : {}),
      outdir: outDir,
      metafile: true,
      plugins: clientBuildPlugins(
        config,
        pipeline,
        [
          ...(prebuilt ? [prebuilt.plugin] : []),
          virtualEntryPlugin(group.entries),
          ...(split ? [deferredDynamicExternalPlugin()] : []),
          clientRuntimePlugin(facts),
        ],
        reactLite,
      ),
    })
  try {
    const result = await clientProfile.timeAsync('esbuild', () => runGroupBuild())
    metafile = result.metafile
    // NOTE deliberately no discovered-refs second pass here (unlike buildClientEntry): a
    // rebuild re-emits raw chunk-*.js after the prebuilt runtime settled against the first
    // pass's names, and the merged rename map then orphans them. Mid-build-discovered
    // dynamic refs fall back to the shared graph until the next generation.
  } catch (error) {
    // A batched build cannot attribute a "Could not resolve" error to a single route, so fall back to
    // per-route builds - the offending route then throws with its precise client import trace. Other
    // diagnostics already carry a clear message from the batch build; re-throw rather than let a
    // per-route build surface a more confusing downstream error.
    if (!hasUnresolvedImportError(error)) throw error
    for (const { route } of group.entries) {
      await buildClientEntry({ config, route, outDir, dev })
    }
    throw error
  }
  await clientProfile.timeAsync('prebuiltSettle', () => prebuilt?.settle() ?? Promise.resolve())

  if (verbose && metafile) reportClientBundleSizes(group.entries, metafile, outDir)
  return { group, metafile, prebuilt }
}

/**
 * The client sources the route table already names - every `'use client'` reference plus a client
 * page's own file. Deliberately NOT a module walk: this set is free (the scan produced it), it is
 * the bulk of any app's first-party client graph, and whatever it misses esbuild still discovers.
 */
/**
 * Whether this route's client graph provably never suspends (see clientSuspenseFree): its entry
 * then drops the Suspense island wrapper and its `react` alias points at the compat-free lite shim.
 * Memoized per build; a group of routes qualifies iff every member does.
 */
function routeSuspenseFree(config: ResolvedConfig, route: RouteManifestEntry): boolean {
  if (!nextCompatEnabled(config)) return false
  return memoConvention(`suspenseFree:${route.id}`, () => {
    const seeds: string[] = []
    if (route.client) seeds.push(route.file)
    for (const reference of route.clientReferences) seeds.push(reference.file)
    for (const file of [
      routeErrorFile(config, route),
      globalErrorFile(config),
      routeNotFoundFile(config, route),
      // Shell layouts hydrate client-side only when the root layout is 'use client'.
      ...(hasClientRootLayout(config, route) ? shellLayoutOrder(config, route) : []),
    ]) {
      if (file) seeds.push(file)
    }
    return clientSuspenseFree(seeds)
  })
}

function routeClientSources(routes: RouteManifestEntry[]) {
  const files = new Set<string>()
  for (const route of routes) {
    if (route.client) files.add(route.file)
    for (const reference of route.clientReferences) files.add(reference.file)
  }
  return files
}

// Record each entry's static chunk closure on the route so rendered pages can
// modulepreload it — without this the browser discovers the chunk list only
// after the entry itself downloads, serializing the two round trips.
function assignClientEntryImports(
  entries: { route: RouteManifestEntry; entryName: string }[],
  metafile: Metafile,
  outDir: string,
  renames: Map<string, string>,
  prebuilt: PreparedPrebuilt | undefined,
) {
  const outputs = metafile.outputs
  // One basename index for the whole entry set: the linear scan this replaces
  // was O(entries × outputs), which on a route-per-page app is the entire
  // output list walked once per route.
  const byBasename = new Map<string, string>()
  for (const item of Object.keys(outputs)) {
    // First match wins, as the linear scan did.
    const basename = path.basename(item)
    if (!byBasename.has(basename)) byBasename.set(basename, item)
  }
  for (const { route, entryName } of entries) {
    const entryOutput = byBasename.get(`${entryName}.js`)
    if (!entryOutput) continue
    const staticImports = new Set<string>()
    const dynamicImports = new Set<string>()
    const visited = new Set([`${entryOutput}:static`])
    const queue = [{ output: entryOutput, dynamic: false }]
    // eslint-disable-next-line @typescript-eslint/prefer-for-of
    for (let head = 0; head < queue.length; head += 1) {
      const current = queue[head]
      if (!current) continue
      for (const imported of outputs[current.output]?.imports ?? []) {
        if (imported.kind !== 'import-statement' && imported.kind !== 'dynamic-import') continue
        const dynamic = current.dynamic || imported.kind === 'dynamic-import'
        const visitKey = `${imported.path}:${dynamic ? 'dynamic' : 'static'}`
        if (visited.has(visitKey)) continue
        visited.add(visitKey)
        // Prebuilt-runtime shims are external: already a url relative to the
        // assets root, and with no output in THIS metafile to walk into. Their
        // own chunk closure comes from the artifact's manifest instead, so the
        // page preloads the whole set rather than discovering chunks one
        // round trip after the shim lands.
        if (imported.external) {
          if (!prebuilt || imported.path !== prebuiltModuleUrl(prebuilt.runtime)) continue
          const assets = prebuiltAssets(prebuilt.runtime)
          for (const asset of assets.static) (dynamic ? dynamicImports : staticImports).add(asset)
          for (const asset of assets.dynamic) dynamicImports.add(asset)
          continue
        }
        queue.push({ output: imported.path, dynamic })
        const basename = path.basename(imported.path)
        const relative = path.relative(outDir, path.resolve(imported.path))
        const publicRelative = path
          .join('assets', path.dirname(relative), renames.get(basename) ?? basename)
          .split(path.sep)
          .join('/')
        ;(dynamic ? dynamicImports : staticImports).add(publicRelative)
      }
    }
    if (staticImports.size > 0) route.clientEntryImports = [...staticImports]
    for (const asset of staticImports) dynamicImports.delete(asset)
    if (dynamicImports.size > 0) route.clientDynamicImports = [...dynamicImports]
  }
}

/**
 * A single batched build can't report per-route *time* (esbuild shares and
 * parallelizes the work), but the metafile gives per-route *size*: the entry
 * plus every chunk reachable from it. Shared chunks are counted for each route
 * that pulls them in, so this reflects real download weight, not disk footprint.
 */
function reportClientBundleSizes(
  entries: { route: RouteManifestEntry; entryName: string }[],
  metafile: Metafile,
  outDir: string,
) {
  const log = createVerboseLogger(true, 'client')
  const outputs = metafile.outputs
  const rows = entries
    .map(({ route, entryName }) => {
      const key = `${path.relative(process.cwd(), path.join(outDir, `${entryName}.js`))}`
      const output = outputs[key]
        ? key
        : Object.keys(outputs).find(item => path.basename(item) === `${entryName}.js`)
      const bytes = output ? reachableOutputBytes(output, outputs) : 0
      return { route: route.route, bytes }
    })
    .sort((a, b) => b.bytes - a.bytes)

  for (const row of rows) {
    log.log(`${row.route} ${dimText(`→ ${formatBytes(row.bytes)}`)}`)
  }
}

function reachableOutputBytes(entry: string, outputs: Metafile['outputs']) {
  const visited = new Set<string>()
  const queue = [entry]
  let bytes = 0

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || visited.has(current)) continue
    visited.add(current)
    const output = outputs[current]
    if (!output) continue
    bytes += output.bytes
    for (const imported of output.imports) {
      if (imported.kind === 'import-statement' || imported.kind === 'dynamic-import') {
        queue.push(imported.path)
      }
    }
  }

  return bytes
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB'] as const
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unitIndex]}`
}

function baseClientBuildOptions(config: ResolvedConfig, dev = false): BuildOptions {
  const extensions = getBundlerExtensions()
  const pure = extensions.clientPureFunctions(config)
  const inject = extensions.clientInjects()
  return {
    ...(inject.length > 0 ? { inject } : {}),
    chunkNames: 'chunks/[name]-[hash]',
    bundle: true,
    format: 'esm',
    splitting: true,
    target: 'es2022',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    // Minification is dead weight in dev: nobody reads the bundle and it roughly
    // doubles esbuild time. Ship minified only for production builds.
    minify: !dev,
    ...(pure.length > 0 ? { pure } : {}),
    // Browser sourcemaps are opt-in (`productionBrowserSourceMaps`, matching Next's default of
    // off): shipping them publishes first-party source to every visitor. Opted in, prod emits
    // external `.js.map` linked by a `//# sourceMappingURL=` comment - never inline, which would
    // bloat the served JS with source text. Dev never emits: the un-minified output is readable.
    sourcemap: !dev && config.productionBrowserSourceMaps === true ? 'linked' : false,
    conditions: ['browser', 'style'],
    define: {
      ...publicEnvDefines(),
      // compiler.define / defineServer (compat); defineServer keys fold to
      // `undefined` client-side so fallback branches stay reachable.
      ...extensions.clientDefines(),
      'process.browser': 'true',
      // Next inlines the deployment id into every graph (main thread included),
      // so a client component reading `process.env.NEXT_DEPLOYMENT_ID` during
      // render doesn't hit an undefined `process` in the browser.
      ...deploymentIdDefine(),
    },
    logOverride: { 'suspicious-logical-operator': 'silent' },
    // Static image imports (.png/.jpg/.svg/…) are handled by
    // clientStaticAssetPlugin, which emits the Next static-image metadata object
    // — NOT a bare `file` loader URL string. Only the font formats keep the file
    // loader here.
    loader: {
      '.woff': 'file',
      '.woff2': 'file',
      '.ttf': 'file',
      '.otf': 'file',
      '.eot': 'file',
    },
  }
}

function deploymentIdDefine(): Record<string, string> {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const deploymentId = process.env.NEXT_DEPLOYMENT_ID
  return deploymentId === undefined
    ? {}
    : { 'process.env.NEXT_DEPLOYMENT_ID': JSON.stringify(deploymentId) }
}

/**
 * Wrap every plugin's onResolve/onLoad so the profile reports, per plugin, how
 * many callbacks esbuild made and how long they held the JS thread. Each call
 * is an IPC round trip, so the counts are what distinguishes "our transforms are
 * slow" from "we are answering 40k questions". Off unless PNEXT_TRACE=client.
 */
function instrumentedPlugins(plugins: Plugin[]): Plugin[] {
  if (!clientProfile.enabled) return plugins
  return plugins.map(plugin => ({
    name: plugin.name,
    setup(build) {
      const wrap =
        (kind: 'resolve' | 'load', register: (options: any, cb: any) => void) =>
        (options: any, callback: any) =>
          register(options, async (args: any) => {
            clientProfile.count(`${plugin.name}:${kind}#`)
            const start = performance.now()
            try {
              return await (callback as (a: unknown) => unknown)(args)
            } finally {
              clientProfile.count(`${plugin.name}:${kind}ms`, performance.now() - start)
            }
          })
      return plugin.setup({
        ...build,
        onResolve: wrap('resolve', build.onResolve.bind(build)),
        onLoad: wrap('load', build.onLoad.bind(build)),
      })
    },
  }))
}

/**
 * One esbuild onResolve hook for the whole chain instead of one per plugin. esbuild offers an
 * import path to every plugin whose filter matches, in order, until one answers - and each offer is
 * an IPC round trip against the single JS thread that serves every concurrent build. The client
 * chain's filters overlap almost completely, so dispatching in-process collapses that to one round
 * trip per import path: same order, same first-answer-wins rule, same plugin credited for each
 * diagnostic (`pluginName` is stamped back on).
 *
 * `PNEXT_CLIENT_COALESCE=0` restores a hook per plugin, to bisect it.
 */
export function coalesceResolveHooks(plugins: Plugin[], name: string): Plugin[] {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  if (process.env.PNEXT_CLIENT_COALESCE === '0') return plugins
  interface Registration {
    plugin: string
    filter: RegExp
    namespace?: string
    callback: (args: OnResolveArgs) => unknown
  }
  return [
    {
      name,
      async setup(build) {
        const registered: Registration[] = []
        // Registrations made after setup (rare, and esbuild allows it) keep
        // their own hook: the chain's order is already fixed by then.
        let sealed = false
        /** The chain, minus one plugin's own hooks — see `resolve` below. */
        const dispatch = async (args: OnResolveArgs, skip?: string) => {
          for (const entry of registered) {
            if (entry.plugin === skip) continue
            if (entry.namespace !== undefined && entry.namespace !== args.namespace) continue
            if (!entry.filter.test(args.path)) continue
            const result = (await entry.callback(args)) as OnResolveResult | null | undefined
            if (result == null) continue
            for (const message of [...(result.errors ?? []), ...(result.warnings ?? [])]) {
              message.pluginName ??= entry.plugin
            }
            return result
          }
          return undefined
        }
        for (const plugin of plugins) {
          const proxy: PluginBuild = {
            ...build,
            onResolve(options: OnResolveOptions, callback: (args: OnResolveArgs) => unknown) {
              if (sealed) return build.onResolve(options, callback as never)
              registered.push({
                plugin: plugin.name,
                // Drop /g and /y: a sticky or global regex carries lastIndex
                // between tests, which would make dispatch order-dependent.
                filter: new RegExp(
                  options.filter.source,
                  options.filter.flags.replace(/[gy]/g, ''),
                ),
                namespace: options.namespace,
                callback,
              })
            },
            // esbuild's own `resolve` re-runs every plugin EXCEPT the caller's (its recursion guard,
            // keyed on plugin name). Sharing one name would make it skip the whole chain and fall
            // straight to native resolution, so run the chain here minus this plugin and only hand
            // esbuild what nobody claimed.
            resolve: (specifier, options = {}) =>
              dispatch(
                {
                  path: specifier,
                  importer: options.importer ?? '',
                  namespace: options.namespace ?? '',
                  resolveDir: options.resolveDir ?? '',
                  kind: options.kind ?? 'import-statement',
                  pluginData: options.pluginData as unknown,
                  with: options.with ?? {},
                },
                plugin.name,
              ).then(result =>
                result && resolveHookSettled(result)
                  ? resolvedFromHook(specifier, result)
                  : build.resolve(specifier, { ...options, pluginName: name }),
              ),
          }
          await plugin.setup(proxy)
        }
        sealed = true
        if (registered.length === 0) return
        const filter = new RegExp(registered.map(entry => `(?:${entry.filter.source})`).join('|'))
        build.onResolve({ filter }, args => dispatch(args))
      },
    },
  ]
}

/**
 * A chain answer in the shape `resolve()` promises its callers. `external` without a path means "keep
 * this specifier, do not bundle it" - esbuild's own rule, verified against the binary.
 */
function resolvedFromHook(specifier: string, result: OnResolveResult): ResolveResult {
  const resolved = result.path ?? (result.external ? specifier : '')
  return {
    errors: (result.errors ?? []) as ResolveResult['errors'],
    warnings: (result.warnings ?? []) as ResolveResult['warnings'],
    path: resolved,
    external: result.external ?? false,
    sideEffects: result.sideEffects ?? true,
    namespace: result.namespace ?? (result.path ? 'file' : ''),
    suffix: result.suffix ?? '',
    pluginData: result.pluginData as unknown,
  }
}

/**
 * Whether a chain answer settles the resolve on its own. Verified against the esbuild binary:
 * `null`/`undefined` defers to the next callback, and ANY other object ends the chain - an empty one
 * included, which then falls through to esbuild's native resolution rather than to the next plugin.
 */
function resolveHookSettled(result: OnResolveResult) {
  return (
    result.path !== undefined ||
    result.external !== undefined ||
    (result.errors?.length ?? 0) > 0 ||
    (result.warnings?.length ?? 0) > 0
  )
}

function clientBuildPlugins(
  config: ResolvedConfig,
  pipeline: ClientSourcePipeline,
  extra: Plugin[] = [],
  reactLite = false,
): Plugin[] {
  return coalesceResolveHooks(
    instrumentedPlugins([
      serverOnlyClientImportPlugin(),
      // The virtual-module plugins (`extra`: generated entries + the shared route
      // runtime) go first so they claim their own synthetic specifiers before the
      // resolve-chain plugins are asked about them — one entry point per route is
      // otherwise offered to every plugin in the chain that only ever declines it.
      ...extra,
      ...getBundlerExtensions().clientEsbuildPlugins(config),
      linkedPackageClientResolvePlugin(config),
      clientStaticAssetPlugin(config),
      pipeline.plugin(),
      importAliasPlugin(config, reactLite),
      cssModuleClientPlugin(),
    ]),
    'pnext-client-resolve-chain',
  )
}

function importAliasPlugin(config: ResolvedConfig, reactLite = false): Plugin {
  // preact core/hooks/jsx-runtime are single-instance, compat or not: an app with its
  // own `preact` in node_modules otherwise bundles a second physical copy next to the
  // framework's, and hooks called from framework components (Link) read a null current
  // component off options the app's copy never installed. The server runtime pins the
  // same set unconditionally (loader's coreAliases); the client build must match.
  const aliases: Record<string, string> = {
    ...frameworkRuntimeAliasEntries(),
    ...getImportAliasExtensions().aliases(config, 'client'),
  }
  // Suspense-free tier: the app's `react` imports resolve to the compat-free lite shim, so the
  // bundle ships preact core + hooks without preact/compat (see clientSuspenseFree).
  if (reactLite && aliases.react) {
    aliases.react = path.resolve(import.meta.dirname, '..', 'compat', 'react', 'client-lite.ts')
  }
  const specifiers = Object.keys(aliases)
  return {
    name: 'pnext-import-alias',
    setup(build) {
      build.onResolve({ filter: /^(?:react(?:-dom)?|next)(?:\/|$)/ }, args => {
        if (aliases[args.path]) return undefined
        const message = getImportAliasExtensions().missingImportError(config, args.path)
        return message ? { errors: [{ text: message }] } : undefined
      })
      if (specifiers.length === 0) return
      build.onResolve(
        { filter: new RegExp(`^(${specifiers.map(escapeRegex).join('|')})$`) },
        async args => {
          const target = aliases[args.path]
          if (!target) return undefined
          if (path.isAbsolute(target)) return { path: target }
          return build.resolve(target, {
            kind: args.kind,
            importer: args.importer,
            namespace: args.namespace,
            resolveDir: args.resolveDir,
          })
        },
      )
    },
  }
}

// preact core + preact/compat + react/react-dom/next are single-instance: they must ALWAYS resolve
// through the framework/compat alias, which pins one canonical absolute file per specifier. The
// linked-package resolver runs BEFORE that alias and matches bare specifiers, so without this guard
// a workspace declaring `preact` (or react/react-dom) as a `file:`/`link:` dependency resolves bare
// `preact` to the linked copy while pnext-internal compat code keeps resolving to the alias -
// shipping TWO physical preact cores. That breaks single-instance option hooks, context identity and
// error interception. Never let the linked-package resolver shadow these; the alias owns them.
const frameworkAliasedSpecifier = /^(?:preact|react|react-dom|next)(?:\/|$)/

function linkedPackageClientResolvePlugin(config: ResolvedConfig): Plugin {
  const compatPreact = path.resolve(import.meta.dirname, '..', 'compat', 'react', 'preact.ts')
  const compatReactClient = path.resolve(import.meta.dirname, '..', 'compat', 'react', 'client.ts')
  return {
    name: 'pnext-linked-package-client-resolve',
    setup(build) {
      build.onResolve({ filter: /^\.\/preact$/ }, args => {
        // Also matches MIRRORED copies of the compat react shim (build-cache
        // outputs under node_modules paths, e.g. @next/third-parties client
        // components) where no sibling ./preact exists; only a real sibling
        // file (an app's own ./preact.*) opts out.
        if (path.resolve(args.importer) === compatReactClient) return { path: compatPreact }
        const hasRealSibling = ['.ts', '.tsx', '.js', '.mjs', '.jsx'].some(ext =>
          existsSync(path.join(args.resolveDir, `preact${ext}`)),
        )
        if (hasRealSibling) return undefined
        return { path: compatPreact }
      })
      // One build's worth of memo, keyed on exactly what esbuild hands us: the resolver walks
      // node_modules and probes package targets per call, and a directory of components importing
      // the same few packages asks the same question repeatedly. Per-BUILD, so a linked package's
      // layout changing between builds is still seen - esbuild already assumes it is fixed within one.
      const linked = new Map<string, string | undefined>()
      build.onResolve({ filter: /^[^./#][^:]*$/ }, args => {
        if (frameworkAliasedSpecifier.test(args.path)) return undefined
        const dir = args.resolveDir || config.root
        const key = `${dir}\0${args.path}`
        let resolved = linked.get(key)
        if (resolved === undefined && !linked.has(key)) {
          resolved = resolveLinkedPackageSpecifier(
            config.root,
            path.join(dir, 'pnext-resolve.ts'),
            args.path,
            ['browser', 'style', 'import', 'default'],
          )
          linked.set(key, resolved)
        }
        return resolved ? { path: resolved } : undefined
      })
    },
  }
}

// Mirror of the server build's static-asset seam for the CLIENT bundle. A static image import from a
// 'use client' component resolves to a generated ESM module exporting the Next static-image metadata
// object - with the asset emitted under `/_next/static/media/...` - rather than a bare `file` loader
// URL string. Uses core's `staticAssetModule` extension seam so compat (next/image) supplies the
// descriptor and pure-core apps fall back to the generic URL module.
const staticImageAssetFilter = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp)(?:$|[?#])/

function clientStaticAssetPlugin(config: ResolvedConfig): Plugin {
  return {
    name: 'pnext-client-static-assets',
    setup(build) {
      build.onResolve({ filter: staticImageAssetFilter }, args => {
        // A configured `turbopack.rules` loader chain for this extension (e.g.
        // `*.svg`) preempts the generic static-image resolver: defer so the
        // compat loader-rule plugin runs the chain instead.
        if (getAssetExtensions().hasLoaderRuleFor(args.path)) {
          return undefined
        }
        return {
          path: resolveAssetPath(args.path, args.resolveDir),
          namespace: 'pnext-client-static-asset',
        }
      })
      build.onLoad({ filter: /.*/, namespace: 'pnext-client-static-asset' }, async args => ({
        contents: await staticImageModuleSource(config, args.path),
        loader: 'js',
      }))
    },
  }
}

function resolveAssetPath(specifier: string, resolveDir: string) {
  const { sourcePath, hash } = splitAssetHash(specifier)
  const resolved = path.isAbsolute(sourcePath) ? sourcePath : path.resolve(resolveDir, sourcePath)
  return `${resolved}${hash}`
}

function splitAssetHash(specifier: string) {
  const index = specifier.search(/[?#]/)
  return index === -1
    ? { sourcePath: specifier, hash: '' }
    : { sourcePath: specifier.slice(0, index), hash: specifier.slice(index) }
}

async function staticImageModuleSource(config: ResolvedConfig, file: string) {
  const { sourcePath } = splitAssetHash(file)
  const bytes = new Uint8Array(await readFile(sourcePath))
  const emitted: string[] = []
  const emit = (relative: string) => {
    emitted.push(relative)
    return `/${relative}`
  }
  const compat = await getAssetExtensions().staticAssetModule({ sourcePath, bytes, emit })
  const source = compat ?? coreStaticAssetModule(sourcePath, bytes, emit)
  for (const relative of emitted) {
    const target = path.join(config.outPath, 'public', ...relative.split('/'))
    await mkdir(path.dirname(target), { recursive: true })
    if (!existsSync(target)) await copyFile(sourcePath, target)
  }
  return source
}

// Core's generic static-asset module (no compat override): emit under a hashed
// `/_next/static/media` URL and export the URL string as default. Mirrors the
// identically named helper in runtime/loader.ts + runtime/modules.ts.
function coreStaticAssetModule(
  sourcePath: string,
  bytes: Uint8Array,
  emit: (relative: string) => string,
): string {
  const ext = path.extname(sourcePath).toLowerCase() || '.bin'
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 8)
  const base = path.basename(sourcePath, path.extname(sourcePath)).replace(/[^A-Za-z0-9_-]+/g, '-')
  const relative = path.posix.join('_next', 'static', 'media', `${base}.${hash}${ext}`)
  const src = emit(relative)
  return `const src = ${JSON.stringify(src)};\nexport default src;\nexport { src };\n`
}

/**
 * The single onLoad owner of first-party client source: it reads each file ONCE and runs every
 * rewrite that file needs - compat's registered transform chain, core's literal `dynamic()` rewrite
 * and the React Compiler pass - then hands esbuild the result with the right loader.
 *
 * Merging matters for correctness as much as for cost: esbuild gives a file to the FIRST plugin
 * whose onLoad filter matches, so a chain of independent loaders means whichever registers first
 * silently shadows the rest. That is what switched the React Compiler off for next-compat apps.
 *
 * App-convention .js/.mjs may contain JSX (jsxImportSource is preact), so those parse with the jsx
 * loader; scoped to the source roots, so third-party node_modules .js keeps esbuild's default loader.
 */
function createClientSourcePipeline(config: ResolvedConfig, dev = false, routeId?: string) {
  const sourceRewrite = nextCompatEnabled(config)
  const compiler = getCompatModeExtensions().reactCompilerOptions(config)
  const asyncPre = hasClientSourceAsyncPreTransforms()
  // Under a source root, and under a root only first-party source plus transpiled packages - said in
  // the FILTER, not the callback: a dependency's files are the bulk of a real graph, so a callback
  // would decline most of them one at a time.
  const roots = clientSourceRoots(config)
    .map(root => escapeRegex(root))
    .join('|')
  const sep = escapeRegex(path.sep)
  const filter = new RegExp(
    `^(?:${roots})(?:${sep}${nonSegmentPattern('node_modules', sep)})*${sep}[^${sep}]*\\.(?:[cm]?[jt]sx?)$`,
  )
  const transpiled = sourceRewrite ? transpiledPackageFilter(roots) : undefined
  // One in-flight pipeline per file for the whole build: `warm()` and the
  // onLoad hook share it, so a warmed file is already done (or in flight on
  // oxc's threadpool) by the time esbuild asks for it, and a component shared
  // by twenty routes is prepared once.
  const prepared = new Map<string, Promise<OnLoadOutput>>()
  // Deferred dynamic refs THIS pipeline rewrote — persisted as the out-dir sidecar.
  const deferredRefs = new Map<string, DeferredDynamicRef>()
  // The text esbuild actually parsed, kept so the prebuilt seam can read a
  // file's framework imports off the POST-transform source — a compat rewrite
  // can add or rename one, and the seam must offer exactly what is there.
  const loaded = new Map<string, string>()

  function prepare(resolved: string): Promise<OnLoadOutput> {
    const existing = prepared.get(resolved)
    if (existing) return existing
    const pending = runPipeline(resolved)
    prepared.set(resolved, pending)
    return pending
  }

  async function runPipeline(resolved: string): Promise<OnLoadOutput> {
    const inNodeModules = resolved.split(path.sep).includes('node_modules')
    // A nested node_modules under a source root is a dependency, not app
    // source: only an explicitly transpiled package opts into the rewrites,
    // and none of them are ever React-Compiled.
    if (inNodeModules && (!sourceRewrite || !isTranspiledPackageFile(resolved))) return undefined
    clientProfile.count('loadFiles')
    // Build-scoped cache: the route-fact walk has already read most of these,
    // so this is a map lookup rather than a second read of the same file.
    const original = await clientProfile.timeAsync('read', () => readSourceText(resolved))
    let contents = original
    // Worker bundling runs first and awaits: it consumes `import.meta.url`,
    // which the sync chain inlines.
    if (asyncPre) {
      contents = await applyClientSourceAsyncPreTransforms(contents, resolved, config.root)
    }
    contents = clientProfile.time('chain', () =>
      applyClientSourceTransforms(contents, resolved, config.root),
    )
    contents = clientProfile.time('dynamic', () => rewriteLiteralDynamicCalls(contents, resolved))
    if (dev && devDynamicSplitEnabled()) {
      contents = rewriteDeferredDynamicImports(
        contents,
        resolved,
        specifier => resolveImport(rootFromFile(resolved), resolved, specifier),
        target => {
          const id = clientReferenceId(target.file, target.exportName)
          const ref = { ...target, routeId }
          registerDeferredDynamicRef(id, ref)
          deferredRefs.set(id, ref)
          return deferredDynamicChunkHref({ id }, routeId)
        },
      )
    }
    if (compiler && !inNodeModules && shouldReactCompile(contents, resolved)) {
      contents = await clientProfile.timeAsync('reactCompiler', () =>
        reactCompiled(resolved, contents, compiler),
      )
    }
    // Unchanged sources go back to esbuild's native loader; only .js/.mjs
    // must be claimed to force the jsx parse.
    loaded.set(resolved, contents)
    if (contents === original && !/\.m?js$/.test(resolved)) return undefined
    return { contents, loader: clientSourceLoader(resolved) }
  }

  return {
    /** The parsed text of a file this build has loaded, if it has. */
    sourceOf(file: string) {
      return loaded.get(file)
    },
    /** Deferred dynamic refs rewritten during this build (dev split). */
    deferredRefs() {
      return deferredRefs
    },
    /**
     * Start the pipeline for sources the route table already names, before esbuild runs. Without it
     * every file waits to be discovered by the bundler's graph walk and its React Compiler pass
     * queues behind that walk.
     */
    /** `warm` for whole routes - every client source the route table names. */
    warmRoutes(routes: RouteManifestEntry[]) {
      this.warm(routeClientSources(routes))
    },
    warm(files: Iterable<string>) {
      for (const file of files) {
        const resolved = path.resolve(file)
        if (!filter.test(resolved) && !transpiled?.test(resolved)) continue
        // Errors surface at the onLoad await, where esbuild attributes them to
        // the importing module; nothing must reject on the warm path.
        prepare(resolved).catch(() => undefined)
      }
    },
    /**
     * The single onLoad owner of first-party client source: it reads each file ONCE and runs every
     * rewrite that file needs, then hands esbuild the result with the right loader. Merging matters
     * for correctness as much as for cost: esbuild gives a file to the FIRST plugin whose onLoad
     * filter matches, so independent loaders mean whichever registers first silently shadows the rest.
     */
    plugin(): Plugin {
      return {
        name: 'pnext-client-source',
        setup(build) {
          // namespace: 'file' — an onLoad without a namespace matches EVERY
          // namespace, which would hijack virtual modules (e.g. the server-action
          // client stub) whose paths end in .js and feed back the original source.
          build.onLoad({ filter, namespace: 'file' }, args => prepare(path.resolve(args.path)))
          // Second hook, not a wider first one: `transpilePackages` opts a
          // dependency's own files into the same pipeline, and they are the only
          // node_modules paths that ever produce contents.
          if (transpiled) {
            build.onLoad({ filter: transpiled, namespace: 'file' }, args =>
              prepare(path.resolve(args.path)),
            )
          }
        },
      }
    },
  }
}

type OnLoadOutput = { contents: string; loader: 'js' | 'ts' | 'tsx' | 'jsx' } | undefined

export type ClientSourcePipeline = ReturnType<typeof createClientSourcePipeline>

/**
 * Open the client-source pipeline early so the build can feed it routes as the fact scan resolves
 * them - the transforms and the React Compiler then run on oxc's threadpool underneath the rest of
 * the build. Hand the result to `buildClientEntries`; it is the same object the stage would
 * otherwise create for itself.
 */
export function startClientSources(config: ResolvedConfig): ClientSourcePipeline {
  conventionCache.clear()
  return createClientSourcePipeline(config)
}

// The compiled-source cache is keyed on the file and a hash of its post-rewrite
// input, so a rebuild of an unchanged file skips the oxc pass. It holds the
// PROMISE, so two concurrent loads of the same source (two routes sharing a
// component) share one compile instead of racing two.
const reactCompiledCache = new Map<string, { hash: bigint; code: Promise<string> }>()

function reactCompiled(
  file: string,
  source: string,
  options: NonNullable<ReturnType<CompatModeExtensions['reactCompilerOptions']>>,
) {
  const hash = Bun.hash.wyhash(`${options.target}\0${source}`)
  const cached = reactCompiledCache.get(file)
  if (cached?.hash === hash) return cached.code
  const code = transformReactCompiler(source, file, options)
  reactCompiledCache.set(file, { hash, code })
  return code
}

// config.root can sit outside the workspace root (and vice versa), so both
// anchor the filter — as does each one's realpath, since esbuild reports
// resolved paths through the OS realpath.
function clientSourceRoots(config: ResolvedConfig) {
  const roots = new Set<string>()
  for (const root of [config.root, config.workspaceRoot]) {
    const resolved = path.resolve(root)
    roots.add(resolved)
    try {
      roots.add(realpathSync.native(resolved))
    } catch {
      // A root that cannot be realpath'd is already covered by its literal form.
    }
  }
  return [...roots]
}

// `.cjs` keeps the plain js loader: CommonJS never carries JSX, and parsing a
// `a < b` comparison as JSX would fail the build.
function clientSourceLoader(file: string): 'js' | 'ts' | 'tsx' | 'jsx' {
  if (file.endsWith('.tsx')) return 'tsx'
  if (/\.[cm]?ts$/.test(file)) return 'ts'
  return file.endsWith('.cjs') ? 'js' : 'jsx'
}

// A path segment that is NOT `word`, spelled positively: esbuild's Go regexp has
// no lookahead, so the negation enumerates "differs at some position / ends
// early / runs longer".
function nonSegmentPattern(word: string, sep: string) {
  const parts = [`${word}[^${sep}]+`]
  for (let index = 0; index < word.length; index += 1) {
    const prefix = word.slice(0, index)
    parts.push(prefix, `${prefix}[^${sep}${word[index]}][^${sep}]*`)
  }
  return `(?:${parts.join('|')})`
}

/**
 * Filter for the node_modules files the pipeline still owns - the packages `transpilePackages` names.
 * A policy that publishes no list cannot be narrowed safely, so that case keeps every node_modules
 * path on the hook.
 */
function transpiledPackageFilter(roots: string): RegExp | undefined {
  const sep = escapeRegex(path.sep)
  const names = getExternalPackagePolicy().transpiled?.()
  if (names?.length === 0) return undefined
  const packages = names
    ? `(?:${names.map(name => escapeRegex(name).split('/').join(sep)).join('|')})${sep}`
    : ''
  return new RegExp(`^(?:${roots}).*${sep}node_modules${sep}${packages}.*\\.(?:[cm]?[jt]sx?)$`)
}

function isTranspiledPackageFile(file: string) {
  const parts = file.split(path.sep)
  const nodeModules = parts.lastIndexOf('node_modules')
  if (nodeModules === -1) return false
  const first = parts[nodeModules + 1]
  if (!first) return false
  const name = first.startsWith('@') ? `${first}/${parts[nodeModules + 2] ?? ''}` : first
  return getExternalPackagePolicy().transpile(name)
}

function virtualEntryPath(routeId: string) {
  return `${virtualEntryNamespace}:${routeId}`
}

function virtualEntryPlugin(entries: { route: RouteManifestEntry; source: string }[]): Plugin {
  const sources = new Map(entries.map(entry => [entry.route.id, entry.source]))
  return {
    name: 'pnext-virtual-client-entry',
    setup(build) {
      build.onResolve({ filter: new RegExp(`^${escapeRegex(virtualEntryNamespace)}:`) }, args => ({
        path: args.path.slice(virtualEntryNamespace.length + 1),
        namespace: virtualEntryNamespace,
      }))
      build.onLoad({ filter: /.*/, namespace: virtualEntryNamespace }, args => {
        const contents = sources.get(args.path)
        if (contents === undefined) return undefined
        return { contents, loader: 'ts', resolveDir: process.cwd() }
      })
    },
  }
}

// The shared route runtime: one virtual module per build, imported by every
// generated entry stub. With `splitting` on, esbuild hoists it into a single
// chunk instead of inlining ~19 KB of identical glue in each route entry.
function clientRuntimePlugin(facts: ClientRuntimeFacts): Plugin {
  return {
    name: 'pnext-client-runtime',
    setup(build) {
      build.onResolve({ filter: new RegExp(`^${escapeRegex(CLIENT_RUNTIME_MODULE)}$`) }, () => ({
        path: CLIENT_RUNTIME_MODULE,
        namespace: CLIENT_RUNTIME_MODULE,
      }))
      build.onLoad({ filter: /.*/, namespace: CLIENT_RUNTIME_MODULE }, () => ({
        contents: clientRuntimeSource(facts),
        loader: 'ts',
        resolveDir: process.cwd(),
      }))
    },
  }
}

async function profileClientBuild<T>(
  route: RouteManifestEntry,
  dev: boolean | undefined,
  task: () => Promise<T>,
) {
  if (!traceEnabled('server')) return task()
  const start = performance.now()
  try {
    return await task()
  } finally {
    const mode = dev ? 'dev' : 'prod'
    console.log(
      `dev-profile client build ${mode} ${route.route} in ${formatDuration(performance.now() - start)}`,
    )
  }
}

function serverOnlyClientImportPlugin(): Plugin {
  return {
    name: 'pnext-server-only-client-import',
    setup(build) {
      build.onResolve(
        { filter: /^(next|next\/headers|next\/font|next\/font\/google|next\/font\/local)$/ },
        args => ({
          errors: [
            {
              text: `${args.path} is server-only and cannot be imported from Client Components.`,
            },
          ],
        }),
      )
    },
  }
}

interface EsbuildLikeError extends Error {
  errors?: {
    text?: string
    location?: {
      file?: string
    }
  }[]
}

interface TraceParent {
  file: string
  specifier: string
}

const traceSourceExtensions = ['.tsx', '.ts', '.jsx', '.js', '.mts', '.cts', '.module.css', '.css']

function withClientImportTrace(
  error: unknown,
  config: ResolvedConfig,
  route: RouteManifestEntry,
  entrySource: string,
) {
  const message = error instanceof Error ? error.message : String(error)
  const trace = clientImportTrace(config, route, entrySource, error)
  if (!trace) return error
  const next = new Error(`${message}\n\n${trace}`)
  if (error instanceof Error) {
    next.name = error.name
    next.stack = error.stack ? `${error.stack}\n\n${trace}` : next.stack
    Object.assign(next, error)
  }
  return next
}

function clientImportTrace(
  config: ResolvedConfig,
  route: RouteManifestEntry,
  entrySource: string,
  error: unknown,
) {
  const unresolved = unresolvedImportFromError(error)
  if (!unresolved) return undefined

  const entryFile = `${route.id}.ts`
  const failedFile = unresolved.file ? resolveTraceFile(unresolved.file) : undefined
  const parents = new Map<string, TraceParent>()
  const visited = new Set<string>()
  const queue: { file: string; source: string }[] = [{ file: entryFile, source: entrySource }]
  let unresolvedImporter: string | undefined

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || visited.has(current.file)) continue
    visited.add(current.file)
    if (visited.size > 2000) break

    for (const specifier of localImports(current.file, current.source)) {
      const resolved = resolveTraceImport(config.root, current.file, specifier)
      if (!resolved) {
        if (
          specifier === unresolved.specifier &&
          (!failedFile || sameFile(current.file, failedFile))
        ) {
          unresolvedImporter = current.file
          queue.length = 0
          break
        }
        continue
      }

      if (!parents.has(resolved)) parents.set(resolved, { file: current.file, specifier })
      if (failedFile && sameFile(resolved, failedFile)) {
        unresolvedImporter = resolved
        queue.length = 0
        break
      }
      if (!visited.has(resolved) && !isAssetLike(resolved)) {
        queue.push({ file: resolved, source: readTextSyncSafe(resolved) })
      }
    }
  }

  if (!unresolvedImporter) return undefined
  const trace = tracePath(entryFile, unresolvedImporter, parents)
  if (trace.length === 0) return undefined

  return [
    `pnext client import trace for route ${route.route}:`,
    ...trace.map(
      (file, index) => `${index === 0 ? '  ' : '  -> '}${displayTraceFile(config, file)}`,
    ),
    `  -> ${unresolved.specifier} (unresolved in browser client bundle)`,
  ].join('\n')
}

/** True when the build failed because an import could not be resolved. */
function hasUnresolvedImportError(error: unknown): boolean {
  const errors = (error as EsbuildLikeError).errors
  if (Array.isArray(errors)) {
    return errors.some(item => item.text?.startsWith('Could not resolve '))
  }
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('Could not resolve ')
}

function unresolvedImportFromError(error: unknown) {
  const buildError = error as EsbuildLikeError
  const diagnostic = buildError.errors?.find(item => item.text?.startsWith('Could not resolve '))
  const message = error instanceof Error ? error.message : String(error)
  const text = diagnostic?.text ?? message
  const specifier = /Could not resolve "([^"]+)"/.exec(text)?.[1]
  if (!specifier) return undefined
  return {
    specifier,
    file: diagnostic?.location?.file ?? errorFileFromMessage(message),
  }
}

function errorFileFromMessage(message: string) {
  const match = /\n\s+([^:\n]+):\d+:\d+:\s+ERROR:\s+Could not resolve /.exec(message)
  return match?.[1]
}

function resolveTraceImport(root: string, fromFile: string, specifier: string) {
  if (path.isAbsolute(specifier)) return resolveTraceCandidate(specifier)
  return resolveImport(root, fromFile, specifier)
}

function resolveTraceFile(file: string) {
  return canonicalTraceFile(
    path.isAbsolute(file) ? path.resolve(file) : path.resolve(process.cwd(), file),
  )
}

function resolveTraceCandidate(base: string) {
  const ext = path.extname(base)
  const candidates = ext
    ? [base]
    : [
        ...traceSourceExtensions.map(extension => `${base}${extension}`),
        ...traceSourceExtensions.map(extension => path.join(base, `index${extension}`)),
        base,
      ]
  const resolved = candidates.find(isTraceFile)
  return resolved ? canonicalTraceFile(resolved) : undefined
}

function isTraceFile(file: string) {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function readTextSyncSafe(file: string) {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : ''
  } catch {
    return ''
  }
}

function tracePath(entryFile: string, targetFile: string, parents: Map<string, TraceParent>) {
  const pathItems = [targetFile]
  let current = targetFile

  while (current !== entryFile) {
    const parent = parents.get(current)
    if (!parent) return []
    current = parent.file
    pathItems.push(current)
  }

  return pathItems.reverse()
}

function sameFile(a: string, b: string) {
  return canonicalTraceFile(a) === canonicalTraceFile(b)
}

function displayTraceFile(config: ResolvedConfig, file: string) {
  if (!path.isAbsolute(file)) return `${file} (generated client entry)`
  const root = canonicalTraceFile(config.root)
  const workspaceRoot = canonicalTraceFile(config.workspaceRoot)
  const resolvedFile = canonicalTraceFile(file)
  const rootRelative = path.relative(root, resolvedFile)
  if (!rootRelative.startsWith('..') && !path.isAbsolute(rootRelative)) return rootRelative
  const workspaceRelative = path.relative(workspaceRoot, resolvedFile)
  if (!workspaceRelative.startsWith('..') && !path.isAbsolute(workspaceRelative))
    return workspaceRelative
  return resolvedFile
}

function canonicalTraceFile(file: string) {
  try {
    return realpathSync.native(file)
  } catch {
    return path.resolve(file)
  }
}

/** One walked client source, with the stat that lets a later boot skip reading it. */
export interface ClientCacheSource {
  file: string
  mtimeMs: number
  size: number
  hash: string
}

export interface ClientCacheKeyParts {
  key: string
  staticHash: string
  sources: ClientCacheSource[]
}

/**
 * The half of the key that is not a walked source: pnext's own generation, the generated entry, and
 * the route's reference list. Cheap to recompute on every lookup - which is what lets the expensive
 * source walk be validated from a persisted index instead (see dev/restart/client-key.ts).
 *
 * The generation, not a list of the pipeline's own files: that list named seven of them and missed
 * the router runtime the entry pulls in, so editing it left every route's out-dir named for the
 * bundle it no longer builds.
 */
export function clientCacheStaticHash(
  route: RouteManifestEntry,
  nextCompat?: boolean,
  config?: ResolvedConfig,
) {
  // The key must observe convention files added since the last build, so it
  // never reads a memo an earlier call left behind.
  conventionCache.clear()
  const hash = createHash('sha256')
  hash.update(frameworkFingerprint())
  hash.update('\0')

  hash.update(
    clientEntrySource({
      // Dev-only callers (restart/client-key): the key must move with the split
      // flag or a toggled PNEXT_DYNAMIC_SPLIT would serve the other arm's entry.
      deferredDynamicHref: devDeferredDynamicHref(true),
      pageFile: route.client ? route.file : undefined,
      clientReferences: route.clientReferences,
      nextCompat,
      errorFile: nextCompat && config ? routeErrorFile(config, route) : undefined,
      globalErrorFile: nextCompat && config ? globalErrorFile(config) : undefined,
      notFoundFile: nextCompat && config ? routeNotFoundFile(config, route) : undefined,
      controlFlow: nextCompat ? routeThrowsClientControlFlow(route) : false,
      router: Boolean(route.needsRouterEntry),
      clientRootLayout: config ? hasClientRootLayout(config, route) : false,
      shellLayoutOrder: config ? shellLayoutOrder(config, route) : [],
    }),
  )
  hash.update('\0')
  // The build is scoped to the route id (virtual entry, source pipeline, surface signature, deferred
  // dynamic href), so it belongs in the key: without it two routes with the same client closure share
  // an out-dir, and their entries either overwrite each other or serve one another's bytes.
  hash.update(route.id)
  hash.update('\0')
  hash.update(route.client ? route.file : '')
  hash.update(JSON.stringify(route.clientReferences))
  return hash.digest('hex')
}

/** The out-dir name: the static half plus every walked source's content hash. */
export function clientCacheKeyFrom(
  staticHash: string,
  sources: readonly { file: string; hash: string }[],
) {
  const hash = createHash('sha256').update(staticHash).update('\0')
  for (const source of sources) {
    hash.update(source.file)
    hash.update('\0')
    hash.update(source.hash)
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 16)
}

export function clientSourceHash(source: string) {
  return Bun.hash(source).toString(36)
}

/**
 * Read one walked source. Stat first: a file that changes between the two
 * records the older stat, so the next boot re-hashes it rather than trusting a
 * hash that stat never described.
 */
export async function readClientCacheSource(file: string): Promise<ClientCacheSource> {
  const stats = await stat(file).catch(() => undefined)
  return {
    file,
    mtimeMs: stats?.mtimeMs ?? 0,
    size: stats?.size ?? 0,
    hash: clientSourceHash(await readText(file)),
  }
}

export async function clientCacheKeyParts(
  route: RouteManifestEntry,
  nextCompat?: boolean,
  config?: ResolvedConfig,
  staticHash?: string,
): Promise<ClientCacheKeyParts> {
  const staticDigest = staticHash ?? clientCacheStaticHash(route, nextCompat, config)
  const sources = await Promise.all(
    (await clientSourceFiles(route)).map(file => readClientCacheSource(file)),
  )
  return { key: clientCacheKeyFrom(staticDigest, sources), staticHash: staticDigest, sources }
}

export async function clientCacheKey(
  route: RouteManifestEntry,
  nextCompat?: boolean,
  config?: ResolvedConfig,
) {
  return (await clientCacheKeyParts(route, nextCompat, config)).key
}

async function clientSourceFiles(route: RouteManifestEntry) {
  const entryFiles = [
    ...(route.client ? [route.file] : []),
    ...route.clientReferences.map(reference => reference.file),
  ]
  const files = new Set<string>()

  await Promise.all(entryFiles.map(file => collectClientSourceFile(file, files)))

  return [...files].sort()
}

// The walk fans out: every file joins `files` before its own read starts, so
// concurrent branches still visit each file once. Serially this was the whole
// cost of a route's client cache key (~1.8 s on a 300-module route).
async function collectClientSourceFile(file: string, files: Set<string>) {
  if (files.has(file) || !existsSync(file)) return
  files.add(file)
  if (isAssetLike(file)) return

  const source = rewriteLiteralDynamicCalls(await readText(file), file)
  await Promise.all(
    [...localImports(file, source)].map(specifier => {
      const resolved = resolveImport(rootFromFile(file), file, specifier)
      return resolved ? collectClientSourceFile(resolved, files) : Promise.resolve()
    }),
  )
}

// Value imports, re-exports and literal `import()` of one module, off the
// memoized parse (PERF-REWRITES #21) — type-only imports bind nothing and are
// already excluded there.
export function localImports(file: string, source: string) {
  const facts = scanFacts(file, source)
  const imports = new Set<string>()
  for (const edge of facts.imports) imports.add(edge.specifier)
  for (const edge of facts.dynamicImports) imports.add(edge.specifier)
  return imports
}

function isAssetLike(file: string) {
  return /\.(css|svg|png|jpe?g|gif|webp|ico|woff2?)$/.test(file)
}

function rootFromFile(file: string) {
  const parts = file.split(path.sep)
  const srcApp = parts.lastIndexOf('src')
  if (srcApp !== -1 && parts[srcApp + 1] === 'app')
    return parts.slice(0, srcApp).join(path.sep) || path.sep
  const app = parts.lastIndexOf('app')
  if (app !== -1) return parts.slice(0, app).join(path.sep) || path.sep
  return path.dirname(file)
}

// Give every split output a payload-addressed name after its import specifiers
// have their final values. Equal final bytes therefore collapse to one URL.
export async function nameSharedClientChunks(outDir: string, metafile?: Metafile) {
  if (metafile && traceEnabled('client')) {
    await writeText(path.join(outDir, 'metafile.json'), JSON.stringify(metafile))
  }
  const chunksDir = path.join(outDir, 'chunks')
  const chunkFiles = await listFiles(chunksDir)
  const files = chunkFiles.filter(file => file.endsWith('.js'))
  const labels = metafile ? chunkLabelsFromMetafile(metafile) : new Map<string, string>()
  const renames = new Map<string, string>()
  const mapRenames = new Map<string, string>()
  await Promise.all(
    chunkFiles
      .filter(file => file.endsWith('.js.map'))
      .map(async file => {
        const basename = path.basename(file)
        const next = `chunk-map-${assetContentHash(await readFile(file))}.js.map`
        mapRenames.set(basename, next)
        if (basename !== next) await rename(file, path.join(chunksDir, next))
      }),
  )
  const sources = new Map(
    await Promise.all(
      files.map(async file => [file, replaceChunkNames(await readText(file), mapRenames)] as const),
    ),
  )
  const sourceByName = new Map(
    [...sources].map(([file, source]) => [path.basename(file), source] as const),
  )
  const names = [...sourceByName.keys()].sort()
  const dependencies = new Map(
    names.map(name => [
      name,
      new Set(names.filter(candidate => sourceByName.get(name)!.includes(candidate))),
    ]),
  )

  // A chunk's final bytes include its dependencies' final names. Collapse
  // cycles, then process the component DAG dependency-first so the hash put in
  // every acyclic filename is computed from exactly the bytes we write.
  const groups = chunkDependencyGroups(names, dependencies)
  const groupByName = new Map(groups.flatMap((group, index) => group.map(name => [name, index])))
  const pending = new Set(groups.map((_, index) => index))
  const finalSources = new Map<string, string>()
  while (pending.size > 0) {
    let progressed = false
    for (const groupIndex of pending) {
      const group = groups[groupIndex]!
      const waitsFor = group.some(name =>
        [...(dependencies.get(name) ?? [])].some(dependency => {
          const dependencyGroup = groupByName.get(dependency)
          return dependencyGroup !== groupIndex && pending.has(dependencyGroup!)
        }),
      )
      if (waitsFor) continue

      const rewritten = new Map(
        group.map(name => [name, replaceChunkNames(sourceByName.get(name)!, renames)]),
      )
      const cyclic = group.length > 1 || (dependencies.get(group[0]!)?.has(group[0]!) ?? false)
      if (cyclic) {
        // A cryptographic self-reference has no practical fixed point. Hash a
        // canonical form whose intra-cycle names are stable placeholders, and
        // put that group hash in every member name. Any member change therefore
        // renames the whole strongly-connected component together.
        const placeholders = new Map(
          group.map((name, index) => [name, `__pnext_cycle_${index}.js`]),
        )
        const canonical = group
          .map(name => replaceChunkNames(rewritten.get(name)!, placeholders))
          .join('\0')
        const groupHash = assetContentHash(canonical)
        for (const [index, name] of group.entries()) {
          renames.set(name, `${clientChunkLabel(name, labels)}-${groupHash}-${index}.js`)
        }
      } else {
        const name = group[0]!
        renames.set(
          name,
          `${clientChunkLabel(name, labels)}-${assetContentHash(rewritten.get(name)!)}.js`,
        )
      }
      for (const name of group) {
        finalSources.set(name, replaceChunkNames(rewritten.get(name)!, renames))
      }
      pending.delete(groupIndex)
      progressed = true
    }
    if (!progressed) throw new Error('Unable to order client chunk dependency groups')
  }

  if (renames.size === 0) return renames

  await Promise.all(
    [...renames].map(async ([from, to]) => {
      const fromPath = path.join(chunksDir, from)
      const toPath = path.join(chunksDir, to)
      if (from === to || !existsSync(fromPath)) return
      try {
        await rename(fromPath, toPath)
      } catch (error) {
        // Tolerate a concurrent build having already moved this chunk (ENOENT);
        // the reference rewrite below still points at the renamed file.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await writeText(toPath, finalSources.get(from)!)
    }),
  )

  // One read+rewrite per output file. An app with a route per page has hundreds
  // of them, so they go out concurrently rather than one await at a time.
  const outputs = (await listFiles(outDir)).filter(item => item.endsWith('.js'))
  await Promise.all(
    outputs.map(async file => {
      const originalName = path.basename(file)
      const source = sources.get(file) ?? (await readText(file))
      const next = finalSources.get(originalName) ?? replaceChunkNames(source, renames)
      if (next !== source) await writeText(file, next)
    }),
  )

  return renames
}

function clientChunkLabel(file: string, labels: Map<string, string>) {
  if (file.startsWith('chunk-')) return labels.get(file) ?? 'shared'
  return path.basename(file, '.js').replace(/-(?:[A-Z0-9]{8}|[0-9a-f]{16})$/, '')
}

function chunkLabelsFromMetafile(metafile: Metafile) {
  const labels = new Map<string, string>()
  for (const [outputPath, output] of Object.entries(metafile.outputs)) {
    const basename = path.basename(outputPath)
    if (!basename.startsWith('chunk-') || !basename.endsWith('.js')) continue
    const weights = new Map<string, number>()
    for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
      const label = chunkInputLabel(input)
      if (!label) continue
      weights.set(label, (weights.get(label) ?? 0) + bytesInOutput)
    }
    const top = [...weights.entries()].sort((a, b) => b[1] - a[1])[0]
    if (top) labels.set(basename, top[0])
  }
  return labels
}

function chunkInputLabel(input: string) {
  const posix = input.split(path.sep).join('/')
  const packageIndex = posix.lastIndexOf('node_modules/')
  if (packageIndex !== -1) {
    const parts = posix.slice(packageIndex + 'node_modules/'.length).split('/')
    const name = parts[0]?.startsWith('@') ? `${parts[0]}-${parts[1] ?? ''}` : parts[0]
    return sanitizeChunkLabel(name ?? '')
  }
  return sanitizeChunkLabel(
    posix
      .split('/')
      .at(-1)
      ?.replace(/\.[^.]+$/, '') ?? '',
  )
}

function sanitizeChunkLabel(label: string) {
  const clean = label
    .replace(/^@/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40)
  return clean || undefined
}

function chunkDependencyGroups(names: string[], dependencies: Map<string, Set<string>>) {
  let nextIndex = 0
  const indices = new Map<string, number>()
  const lowLinks = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const groups: string[][] = []

  const visit = (name: string) => {
    const index = nextIndex++
    indices.set(name, index)
    lowLinks.set(name, index)
    stack.push(name)
    onStack.add(name)
    for (const dependency of dependencies.get(name) ?? []) {
      if (!indices.has(dependency)) {
        visit(dependency)
        lowLinks.set(name, Math.min(lowLinks.get(name)!, lowLinks.get(dependency)!))
      } else if (onStack.has(dependency)) {
        lowLinks.set(name, Math.min(lowLinks.get(name)!, indices.get(dependency)!))
      }
    }
    if (lowLinks.get(name) !== indices.get(name)) return
    const group: string[] = []
    for (;;) {
      const member = stack.pop()!
      onStack.delete(member)
      group.push(member)
      if (member === name) break
    }
    groups.push(group.sort())
  }

  for (const name of names) if (!indices.has(name)) visit(name)
  return groups
}

function replaceChunkNames(source: string, renames: Map<string, string>) {
  const pattern = new RegExp([...renames.keys()].map(escapeRegex).join('|'), 'g')
  return source.replace(pattern, match => renames.get(match) ?? match)
}
