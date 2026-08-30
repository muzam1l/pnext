import { builtinModules } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { existsSync, readFileSync, type Dirent } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { copyFile, mkdir, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import type { OnResolveResult, Plugin } from 'esbuild'
import { build } from '../utils/esbuild'
import { drainPreplanBuilds, vendorTraceEnabled, vendorTraceRow } from '../runtime/vendor'
import {
  clientReferenceExportNames,
  clientReferenceModuleSource,
  hasUseClientDirective,
} from '../client/reference-stub'
import { noteCompiledClientReference, ssrClientReference } from '../client/reference'
import { getClientActionBundler } from '../dev/client-actions'
import { deferredDynamicImportSpecifiers, devDynamicSplitEnabled } from '../resolve/dynamic'
import { noteModuleGeneration, noteModuleImported } from './module-generations'
import {
  rewriteServerSource,
  serverBundleTargetForRuntime,
  serverBundleConditions,
  serverBundleRequireConditions,
  type ServerBundleTarget,
} from './loader'
import { externalServerPackageHref, runtimeServerImportTarget } from '../runtime/vendor-build'
import { writeFileAtomic } from '../utils/fs'
import { traceEnabled, traceValue } from '../utils/trace-flags'
import { createHash } from 'node:crypto'
import {
  extraLoadableExtensions,
  getAssetExtensions,
  getBundlerExtensions,
  getCssExtensions,
  getImportAliasExtensions,
  serverDefineOptions,
} from '../extensions'
import {
  frameworkRuntimeAliasEntries,
  pathToFileHref,
  pnextAliases,
  type CompatAliasTarget,
  type ResolvedConfig,
} from '../config'
import { readText, toPosixPath, writeText } from '../utils/fs'
import {
  type ExternalLoadTarget,
  externalPackageImportTarget,
  getExternalPackagePolicy,
  isCommonJsModuleSource,
  isEsmModuleFile,
  packageNameOfSpecifier,
  resolveImport,
  resolveExternalLoadTarget,
  resolvePackageSpecifier,
} from '../resolve/imports'
import {
  importSpecifiers,
  moduleSpecifierEdges,
  rewriteSpecifierLiterals,
} from '../resolve/scan-facts'
import {
  cacheRoot,
  devArtifactUsable,
  devHeadTrimEnabled,
  devModuleCache,
  devSourceIdentity,
  noteDevArtifactWritten,
  type DevModuleCache,
} from './module-cache'
import { cachedRouteBundlePath, saveRouteBundlePath } from '../dev/restart/route-bundle-key'
import {
  outputSpecifiers,
  spliceSource,
  transformBailReason,
  transformServerModule,
  type SpecifierKind,
} from './module-transform'
import { findShakeableDynamicImports } from '../resolve/tree-shake'
import type { RouteManifestEntry } from '../types'
import { uniqueIdentifier } from '../utils/code'
import { formatDuration } from '../utils/verbose'

type AliasMap = Record<string, string>

function nextCompatEnabled(config: ResolvedConfig) {
  return Boolean(config.compat?.next)
}

function reactCompatEnabled(config: ResolvedConfig) {
  return Boolean(config.compat?.next || config.compat?.react || config.compat?.reactCompiler)
}

function coreAliases(config: ResolvedConfig, target: CompatAliasTarget): AliasMap {
  return {
    ...frameworkRuntimeAliasEntries(),
    ...pnextAliases(target),
    ...getImportAliasExtensions().aliases(config, target),
  }
}

// Cap concurrent esbuild builds: the recursive module graph can otherwise fire
// hundreds of builds at once and saturate the host.
const BUILD_CONCURRENCY = Math.max(2, (os.availableParallelism?.() ?? os.cpus().length) - 1)
let buildActive = 0
const buildQueue: (() => void)[] = []
const moduleBuilds = new Map<string, Promise<string>>()
const routeBundleBuilds = new Map<string, Promise<string>>()
// A cache hit from THIS process is safe after its entry drain, but a production
// build also has a warm child filling the same content-addressed directory.
// That other process can atomically publish an importer before its slower
// dependency. Cache each artifact's parsed static edges, but re-check those
// members on every acceptance: a later phase may remove a dependency that was
// present during an earlier check. This avoids repeated reads/parses without
// turning one observation into a permanent claim that the closure still exists.
const completeArtifactClosures = new Map<string, readonly string[]>()
let moduleGraphFailure: Error | undefined

/** Reset build-only graph state before starting another build in this process. */
export function resetModuleGraphFailure(): void {
  moduleGraphFailure = undefined
  completeArtifactClosures.clear()
}

/**
 * Fail a build even when its renderer converted a module-resolution exception
 * into a 500 response. Rendering may recover from user-code errors, but a
 * missing content-addressed artifact means the build output itself is broken.
 */
export function throwIfModuleGraphFailed(): void {
  if (moduleGraphFailure !== undefined) throw moduleGraphFailure
}

function noteModuleGraphFailure(error: unknown): void {
  moduleGraphFailure ??= error instanceof Error ? error : new Error(String(error))
}

function isCompiledModuleResolutionError(error: unknown, href: string): boolean {
  const message = error instanceof Error ? error.message : String(error)
  if (!message.includes('Cannot find module')) return false
  return (
    href.includes('/cache/server/') ||
    /[/\\]cache[/\\]server[/\\]/.test(message) ||
    message.includes('/cache/server/')
  )
}

// PNEXT_TRACE=server: attribute every per-module compile to its profile,
// so cross-profile duplicate work is countable rather than inferred. Counts are
// load-insensitive, which is what makes them usable on a contended box.
interface ModuleStat {
  profile: string
  ms: number
  esbuild: boolean
}
// `${profile}:${file}` of modules that fell off the oxc fast path onto esbuild.
const esbuildFallbacks = new Set<string>()
const moduleStats: Map<string, ModuleStat[]> | undefined = traceEnabled('server')
  ? new Map()
  : undefined
let moduleStatsFlush: Timer | undefined

function noteModuleCompile(file: string, profile: string, ms: number, esbuild: boolean) {
  if (!moduleStats) return
  const entries = moduleStats.get(file) ?? []
  entries.push({ profile, ms, esbuild })
  moduleStats.set(file, entries)
  // Debounced: stages settle after the response, so a fixed point in the
  // request would miss the preloads this is meant to attribute.
  clearTimeout(moduleStatsFlush)
  moduleStatsFlush = setTimeout(reportModuleStats, 500)
  moduleStatsFlush.unref?.()
}

function reportModuleStats() {
  if (!moduleStats) return
  const byProfile = new Map<string, { files: number; ms: number; esbuild: number }>()
  let total = 0
  let duplicated = 0
  let duplicateCompiles = 0
  let duplicateMs = 0
  for (const entries of moduleStats.values()) {
    total += entries.length
    const profiles = new Set(entries.map(entry => entry.profile))
    if (profiles.size > 1) {
      duplicated += 1
      duplicateCompiles += entries.length - 1
      duplicateMs += entries.slice(1).reduce((sum, entry) => sum + entry.ms, 0)
    }
    for (const entry of entries) {
      const bucket = byProfile.get(entry.profile) ?? { files: 0, ms: 0, esbuild: 0 }
      bucket.files += 1
      bucket.ms += entry.ms
      bucket.esbuild += entry.esbuild ? 1 : 0
      byProfile.set(entry.profile, bucket)
    }
  }
  const rows = [...byProfile.entries()]
    .sort((a, b) => b[1].ms - a[1].ms)
    .map(
      ([profile, b]) =>
        `  ${profile}: ${b.files} modules, ${b.ms.toFixed(0)} ms nested-wall, ${b.esbuild} via esbuild`,
    )
  console.error(
    [
      `dev-module-stats ${moduleStats.size} distinct files, ${total} compiles`,
      ...rows,
      `  cross-profile: ${duplicated} files compiled in >1 profile, ` +
        `${duplicateCompiles} redundant compiles, ${duplicateMs.toFixed(0)} ms nested-wall`,
    ].join('\n'),
  )
  // PNEXT_TRACE=server=<path>: also dump the per-file list, so a floor bench can
  // replay the exact module set a route compiles in each profile. A `.jsonl` path
  // belongs to the heavy-package profile instead (see vendor.ts).
  const out = traceValue('server')
  if (out?.endsWith('.jsonl')) return
  if (!out) return
  const files = [...moduleStats.entries()].flatMap(([file, entries]) =>
    entries.map(entry => ({ file, profile: entry.profile, ms: entry.ms, esbuild: entry.esbuild })),
  )
  void writeFile(out, JSON.stringify(files, null, 0)).catch(() => undefined)
}
const routeModuleLoaders = new Map<string, Promise<DevRouteModuleLoaders>>()

// A module that throws while evaluating stays failed in Bun's registry for the process lifetime, and
// re-importing it surfaces downstream symptoms (a missing bundle entry, TDZ on an export) instead of
// the original error. Record the first failure per compiled href and re-throw THAT on every later
// request. Compiled hrefs are content-addressed, so a save that fixes the module yields a new href
// and the entry is never consulted again.
const moduleEvalErrors = new Map<string, unknown>()
const warmRetryHrefs = new Map<string, Promise<string>>()
const warmImports = new Map<string, Promise<void>>()
let warmRetryGeneration = 0

/**
 * Import a compiled module, re-throwing its first evaluation error on later imports.
 *
 * Production needs this as much as dev: a re-import resolves with a half-evaluated namespace whose
 * `export const` bindings are still in TDZ, so the render's next read (`module.metadata`) throws
 * `Cannot access 'metadata' before initialization` and that replaces the real error in the response.
 * Prod hrefs are content-addressed too, so the entry keys the same way dev's does.
 */
export async function importModuleOnce<T>(href: string): Promise<T> {
  if (moduleEvalErrors.has(href)) throw moduleEvalErrors.get(href)
  try {
    return (await import(href)) as T
  } catch (error) {
    if (isCompiledModuleResolutionError(error, href)) noteModuleGraphFailure(error)
    moduleEvalErrors.set(href, error)
    throw error
  }
}

interface ImportDevModuleOptions {
  /** A speculative import whose evaluation failure must not become render state. */
  warm?: boolean
}

async function nextWarmRetryHref(href: string) {
  const url = new URL(href)
  const generation = ++warmRetryGeneration
  if (url.protocol !== 'file:') {
    url.searchParams.set('pnext-warm-retry', String(generation))
    return url.href
  }
  // Bun keys failed file imports by their underlying path even when the URL query changes. Copy the
  // immutable content-addressed artifact beside itself: the distinct path retries its top-level
  // evaluation, while the shared directory keeps all relative imports resolving identically.
  const source = fileURLToPath(url)
  const extension = path.extname(source)
  const stem = extension ? source.slice(0, -extension.length) : source
  const retry = `${stem}.pnext-warm-retry-${generation}${extension}`
  await copyFile(source, retry)
  return pathToFileHref(retry)
}

/** `importModuleOnce` plus dev's registry-generation accounting. */
export async function importDevModule<T>(
  href: string,
  options: ImportDevModuleOptions = {},
): Promise<T> {
  const warming = warmImports.get(href)
  if (warming) {
    await warming
    return importDevModule<T>(href)
  }

  let finishWarm: (() => void) | undefined
  let warmSettled: Promise<void> | undefined
  if (options.warm) {
    warmSettled = new Promise(resolve => {
      finishWarm = resolve
    })
    warmImports.set(href, warmSettled)
  }

  let importHref = href
  let attemptedEvaluation = false
  try {
    importHref = (await warmRetryHrefs.get(href)) ?? href
    if (moduleEvalErrors.has(importHref)) throw moduleEvalErrors.get(importHref)
    // Pre-planned vendor builds are enqueued without an awaiter; nothing
    // evaluates until they all settle (no-op when the pipeline is empty).
    await drainPreplanBuilds()
    attemptedEvaluation = true
    const module = await importModuleOnce<T>(importHref)
    noteModuleImported(href)
    return module
  } catch (error) {
    if (options.warm && attemptedEvaluation) {
      // Bun retains a failed ESM evaluation in its registry. Drop our first-error record and give
      // the real render a fresh module identity, so speculative work can never poison the request.
      const retryHref = nextWarmRetryHref(href)
      warmRetryHrefs.set(href, retryHref)
      if (moduleEvalErrors.get(importHref) === error) moduleEvalErrors.delete(importHref)
      await retryHref
    }
    throw error
  } finally {
    finishWarm?.()
    if (warmSettled && warmImports.get(href) === warmSettled) warmImports.delete(href)
  }
}
const extensionlessDynamicImportExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'])
const externalLoadNamespaces = {
  server: 'pnext-route-external-server',
  client: 'pnext-route-external-client',
  module: 'pnext-module-external',
} as const

const moduleCaches = new WeakMap<ResolvedConfig, DevModuleCache>()

/**
 * The content-addressing cache behind every compiled path (runtime/module-cache.ts).
 * Artifacts are named by a hash of their whole source graph, so this is also the
 * thing that decides what a save invalidates.
 */
export function devModuleGraph(config: ResolvedConfig): DevModuleCache {
  const existing = moduleCaches.get(config)
  if (existing) return existing
  const cache = devModuleCache(config, {
    compileKey: devCompileKey(config),
    edges: (file, source) => graphEdges(config, file, source),
  })
  moduleCaches.set(config, cache)
  return cache
}

/**
 * Pay the compile pipeline's FIXED first-use costs - esbuild's service child, the oxc native
 * bindings, the cache marker and persisted graph index - without compiling anything. Nothing here is
 * route-specific, so a fresh checkout still compiles zero routes. Every step is idempotent and shares
 * the memo the request path uses, so racing a real first request costs nothing.
 *
 * Call only after `bootstrapCompat`: the graph's compile key hashes the alias extensions compat
 * registers, and it is memoized from the first read.
 */
export async function warmDevModulePipeline(config: ResolvedConfig) {
  const source = 'import "./pnext-warm-import";\nexport const warm: number = 1;\n'
  const file = path.join(config.root, 'pnext-warm.ts')
  await Promise.allSettled([
    // esbuild spawns its Go service child and handshakes on the first build.
    build({
      stdin: { contents: '0', loader: 'ts', resolveDir: config.root },
      write: false,
      logLevel: 'silent',
    }),
    Promise.resolve().then(() => {
      importSpecifiers(source, file) // oxc-parser
      transformServerModule(source, file, serverDefineOptions().define) // oxc-transform
      resolveLocalImport(config, file, './pnext-warm-import') // oxc-resolver factory
      devModuleGraph(config) // cache marker + graph.json + framework fingerprint
    }),
  ])
}

/** Compile inputs that are not sources: a change to any of them renames everything. */
function devCompileKey(config: ResolvedConfig) {
  return JSON.stringify({
    // Relative, never absolute: the key names every artifact, and a deployed
    // build runs the same workspace from a different root (see module-cache).
    root: toPosixPath(path.relative(config.workspaceRoot, config.root)),
    compat: config.compat ?? null,
    nextConfig: nextConfigFingerprint(config),
    define: serverDefineOptions().define ?? null,
    aliases: [...devAliasKeys(config)].sort(),
  })
}

// next.config knobs (modularizeImports, resolve aliases, compiler options) shape compiled output, and only
// some of them reach the alias/define maps above - so the config's own bytes are part of the key. Content,
// never mtime: a rewritten-but-identical config must not rename every artifact. Files the config imports
// are not covered.
const NEXT_CONFIG_BASENAMES = [
  'next.config.ts',
  'next.config.mts',
  'next.config.cts',
  'next.config.js',
  'next.config.mjs',
  'next.config.cjs',
]

function nextConfigFingerprint(config: ResolvedConfig) {
  if (!config.compat?.next) return ''
  for (const name of NEXT_CONFIG_BASENAMES) {
    const candidate = path.join(config.root, name)
    if (!existsSync(candidate)) continue
    try {
      return `${name}:${Bun.hash(readFileSync(candidate)).toString(36)}`
    } catch {
      return name
    }
  }
  return ''
}

const aliasKeys = new WeakMap<ResolvedConfig, Set<string>>()

/** Specifiers every profile rewrites at build time — never source edges. */
function devAliasKeys(config: ResolvedConfig) {
  const existing = aliasKeys.get(config)
  if (existing) return existing
  const keys = new Set([
    ...Object.keys(coreAliases(config, 'server')),
    ...Object.keys(getImportAliasExtensions().reactServerLayerAliases(config)),
    ...Object.keys(clientSsrAliases(config)),
  ])
  aliasKeys.set(config, keys)
  return keys
}

/**
 * Source edges the graph hash follows. A superset of the compiled graph is safe - it only widens what
 * a save invalidates - but a subset would leave a dependent holding a name that no longer describes
 * its content, so assets and client components are edges here even where the compile walk skips them.
 */
function graphEdges(config: ResolvedConfig, file: string, source: string) {
  const aliases = devAliasKeys(config)
  const imports: string[] = []
  const packages: string[] = []
  for (const specifier of importSpecifiers(source, file)) {
    const { sourcePath } = splitHash(specifier)
    if (aliases.has(specifier) || aliases.has(sourcePath)) continue
    const resolved = resolveLocalImport(config, file, sourcePath.replace(/\?.*$/, ''))
    const isLocalSource = sourcePath.startsWith('.') || path.isAbsolute(sourcePath)
    // Compiled output is never a source of the graph that produced it.
    if (resolved && isInside(config.outPath, resolved)) continue
    if (resolved && (isLocalSource || isInside(config.workspaceRoot, resolved))) {
      imports.push(path.resolve(resolved))
      continue
    }
    // Registry package demand: recorded here so a route's vendor bundles can be
    // started as their own stage instead of blocking the module pass at first
    // use.
    if (!isLocalSource && isPackageSpecifier(sourcePath)) packages.push(sourcePath)
  }
  return { imports, packages, client: hasUseClientDirective(source) }
}

/**
 * No build ever waits for another build. Compiling a module needs its imports' artifact PATHS, which
 * are a pure function of the source graph - never their bytes - so a compile registers what it
 * reaches and moves on. That removes the deadlock class outright: real app graphs are cyclic, and any
 * scheme where one build awaits another lets two of them each hold what the other needs, which stalls
 * the request with no error until the socket idles out.
 *
 * The one real requirement is temporal and belongs at the boundary: no href may reach `import()`
 * before everything reachable from it is on disk. An entry therefore waits for quiescence, not for a
 * closure it can compute: with parents no longer written after their children, an artifact already on
 * disk says nothing about its imports, so "what this entry reached" is not a set anyone can name.
 *
 * The wait runs off an append-only log rather than the in-flight map, so a build that starts AND
 * settles between two looks is still waited on - and its failure still reaches the caller instead of
 * disappearing with the map entry.
 *
 * Waiting is global; FAILING is not. An entry only rethrows for builds its own walk started or
 * joined, so one request's broken module cannot 500 an unrelated request that merely overlapped it.
 */
const buildLog: Promise<string>[] = []
const walkBuilds = new WeakMap<Set<string>, Set<Promise<string>>>()
let drainsActive = 0

/** The builds this walk owns - keyed on the walk's own `visited` set, which already identifies it. */
function ownedBuilds(visited: Set<string>) {
  let owned = walkBuilds.get(visited)
  if (!owned) {
    owned = new Set()
    walkBuilds.set(visited, owned)
  }
  return owned
}

function registerBuild(build: Promise<string>) {
  buildLog.push(build)
}

async function drainModuleBuilds(visited: Set<string>) {
  drainsActive += 1
  try {
    for (let index = 0; index < buildLog.length;) {
      const pending = buildLog.slice(index)
      index = buildLog.length
      await Promise.allSettled(pending)
    }
    await Promise.all([...(walkBuilds.get(visited) ?? [])])
  } finally {
    drainsActive -= 1
    // Nothing in flight and nobody mid-drain: the log has served its purpose and can go.
    if (drainsActive === 0 && moduleBuilds.size === 0) buildLog.length = 0
  }
}

function withBuildSlot<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      buildActive += 1
      task()
        .then(resolve, reject)
        .finally(() => {
          buildActive -= 1
          buildQueue.shift()?.()
        })
    }
    if (buildActive < BUILD_CONCURRENCY) run()
    else buildQueue.push(run)
  })
}

export interface DevServerModuleOptions {
  conditionTarget?: ServerBundleTarget
  externalLoadTarget?: ExternalLoadTarget
  /**
   * True for modules compiled under the true `react-server` layer (App RSC,
   * route handlers, proxy/middleware): layers stricter React alias overrides
   * with no client hook exports on top of the base server aliases.
   * Pages/api and other server modules keep the base aliases (full-hooks
   * `react`, kept for backward compatibility).
   */
  reactServerLayer?: boolean
}

export async function devServerModuleHref(
  config: ResolvedConfig,
  file: string,
  // Compiled paths are content-addressed; the caller's dev import version no
  // longer names them (it still keys compat's own caches).
  _version?: string,
  moduleOptions: DevServerModuleOptions = {},
) {
  const conditionTarget = pagesLayerConditionTarget(
    config,
    file,
    moduleOptions.conditionTarget ?? 'server',
  )
  const reactServerLayer =
    moduleOptions.reactServerLayer ?? (conditionTarget === 'server' || conditionTarget === 'edge')
  const release = devModuleGraph(config).hold()
  const visited = new Set<string>()
  try {
    const compiled = await writeDevModule(config, file, visited, {
      aliases: {
        ...coreAliases(config, 'server'),
        ...(reactServerLayer ? getImportAliasExtensions().reactServerLayerAliases(config) : {}),
      },
      profile: reactCompatEnabled(config) ? 'compat' : 'server',
      conditionTarget,
      reactServerLayer,
      externalLoadTarget:
        moduleOptions.externalLoadTarget ?? externalLoadTargetForConditionTarget(conditionTarget),
      stubClientImports: reactCompatEnabled(config),
      rewriteExternalServerImports: true,
      bundleExternalPackages: reactCompatEnabled(config),
    })
    await drainModuleBuilds(visited)
    assertCompiledArtifactClosure(compiled)
    return pathToFileHref(compiled)
  } finally {
    release()
  }
}

export async function devClientModuleHref(
  config: ResolvedConfig,
  file: string,
  _version?: string,
  serverTarget?: ServerBundleTarget,
) {
  const conditionTarget = clientLayerConditionTarget(config, file, serverTarget ?? 'server')
  const throughPackage = await packageClientModuleHref(config, file, conditionTarget)
  if (throughPackage) return throughPackage
  const release = devModuleGraph(config).hold()
  const visited = new Set<string>()
  try {
    const compiled = await writeDevModule(
      config,
      file,
      visited,
      clientLayerOptions(config, conditionTarget),
    )
    await drainModuleBuilds(visited)
    assertCompiledArtifactClosure(compiled)
    return pathToFileHref(compiled)
  } finally {
    release()
  }
}

/**
 * The client-layer module a `'use client'` file inside node_modules SSRs from: its package's own
 * client vendor bundle, the same artifact the app's client code reaches that package through.
 *
 * Compiling the file a SECOND time as a standalone module would hand the SSR pass its own copy of
 * everything the file shares with the rest of the package - a `createContext` call, a registry, a
 * singleton - and a provider rendered from one copy is invisible to a consumer rendered from the
 * other. The browser build is unaffected: it compiles the whole client graph at once.
 *
 * Undefined means "compile it as a module", which is the answer whenever the package cannot be shown
 * to publish the file's exports.
 */
async function packageClientModuleHref(
  config: ResolvedConfig,
  file: string,
  conditionTarget: ServerBundleTarget,
) {
  if (!reactCompatEnabled(config)) return undefined
  const packageDir = nodeModulesPackageDir(file)
  if (!packageDir) return undefined
  const specifier = await packageSpecifierPublishing(config, packageDir, file)
  if (!specifier) return undefined
  return externalServerPackageHref(
    config,
    specifier,
    'client',
    path.dirname(file),
    conditionTarget,
  ).catch(() => undefined)
}

/**
 * The specifier an importer would use to get `file`'s exports out of its
 * package: the `exports` subpath that resolves to it, or the package itself
 * when its entry re-exports every name the file has.
 */
async function packageSpecifierPublishing(
  config: ResolvedConfig,
  packageDir: string,
  file: string,
) {
  const packageName = packageNameOfDirectory(packageDir)
  if (!packageName) return undefined
  for (const subpath of packageExportSubpaths(packageDir)) {
    const specifier = subpath === '.' ? packageName : `${packageName}/${subpath.slice(2)}`
    if (resolvePackageFile(config, file, specifier) === file) return specifier
  }
  const entry = resolvePackageFile(config, file, packageName)
  if (!entry || entry === file) return entry ? packageName : undefined
  const published = new Set(await clientReferenceExportNames(config, entry))
  const names = await clientReferenceExportNames(config, file)
  return names.length > 0 && names.every(name => published.has(name)) ? packageName : undefined
}

/** The client layer's own conditions, so the file matches the bundle's entry. */
function resolvePackageFile(config: ResolvedConfig, fromFile: string, specifier: string) {
  return resolvePackageSpecifier(config.root, fromFile, specifier, ['module', 'import'])
}

/** Every `exports` key of a package manifest; `{}` and sugar forms included. */
function packageExportSubpaths(packageDir: string) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as {
      exports?: unknown
    }
    if (typeof manifest.exports !== 'object' || manifest.exports === null) return ['.']
    const keys = Object.keys(manifest.exports).filter(key => key.startsWith('.'))
    // A conditions-only map (`{ import: ... }`) has no subpath keys at all.
    return keys.length > 0 ? keys.filter(key => !key.includes('*')) : ['.']
  } catch {
    return ['.']
  }
}

/** `…/node_modules/@scope/name` -> `@scope/name`. */
function packageNameOfDirectory(packageDir: string) {
  const parts = packageDir.split(path.sep)
  const index = parts.lastIndexOf('node_modules')
  if (index === -1) return undefined
  return parts.slice(index + 1).join('/')
}

/** `…/node_modules/@scope/name/build/x.js` -> `…/node_modules/@scope/name`. */
function nodeModulesPackageDir(file: string) {
  const parts = file.split(path.sep)
  const index = parts.lastIndexOf('node_modules')
  if (index === -1) return undefined
  const end = index + (parts[index + 1]?.startsWith('@') ? 3 : 2)
  return end <= parts.length ? parts.slice(0, end).join(path.sep) : undefined
}

export interface DevRouteModuleLoaders {
  moduleLoader: (file: string) => Promise<Record<string, unknown>>
  clientModuleLoader: (file: string) => Promise<Record<string, unknown>>
}

interface DevModuleOptions {
  aliases: AliasMap
  profile: 'server' | 'compat' | 'client'
  conditionTarget: ServerBundleTarget
  reactServerLayer?: boolean
  externalLoadTarget: ExternalLoadTarget
  stubClientImports: boolean
  rewriteExternalServerImports: boolean
  bundleExternalPackages: boolean
}

/**
 * Start this route's vendor bundles as an independent stage. The graph walk
 * that names the artifacts already knows every package the route reaches, so
 * the builds run alongside the module pass rather than serially in front of the
 * first module that imports one. Every build is deduped by the vendor cache, so
 * the module pass coalesces onto these instead of starting its own.
 */
function startRouteVendorStage(config: ResolvedConfig, route: RouteManifestEntry, files: string[]) {
  // Kill switch for bisecting a suspected stage-overlap difference.
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  if (process.env.PNEXT_DISABLE_VENDOR_STAGE) return
  if (!reactCompatEnabled(config)) return
  const conditionTarget = serverBundleTargetForRuntime(route.segmentConfig?.runtime)
  const seedT0 = performance.now()
  void (async () => {
    const { demand, dropped, layered } = await devVendorSeedSplit(config, route, files)
    if (traceEnabled('server')) {
      console.log(
        `dev-import vendor seed walk ${route.route} in ${formatDuration(performance.now() - seedT0)} (kept ${demand.length}, dropped ${dropped.length})`,
      )
    }
    if (vendorTraceEnabled()) {
      vendorTraceRow({
        kind: 'seed',
        route: route.route,
        layered,
        kept: [...demand].sort(),
        dropped: [...dropped].sort(),
        atMs: performance.now(),
      })
    }
    const warm = (specifiers: Iterable<string>) =>
      Promise.all(
        [...specifiers].map(specifier =>
          externalServerPackageHref(
            config,
            specifier,
            'server',
            config.root,
            conditionTarget,
          ).catch(() => undefined),
        ),
      )
    await warm(demand)
  })().catch(() => undefined)
}

/**
 * The seed's split of a route's package demand: what the SERVER layer will ask for, and what only a
 * client subtree reaches (which the client-SSR pass demands at its own target, so a server build of
 * it is work nothing consumes).
 *
 * Only the SERVER vendor layer is seeded: the client-reference pass fans the client-SSR demand out
 * itself, so seeding that layer too only competes for the JS thread.
 *
 * @internal Exported as a test seam - the split is otherwise only visible as timing.
 */
export async function devVendorSeedSplit(
  config: ResolvedConfig,
  route: RouteManifestEntry,
  files: string[],
) {
  const conditionTarget = serverBundleTargetForRuntime(route.segmentConfig?.runtime)
  const options: DevModuleOptions = {
    aliases: coreAliases(config, 'server'),
    profile: 'compat',
    conditionTarget,
    externalLoadTarget: externalLoadTargetForConditionTarget(conditionTarget),
    stubClientImports: true,
    rewriteExternalServerImports: true,
    bundleExternalPackages: true,
  }
  // Layered seeding: a separate walk pruned at 'use client' boundaries, so client-only packages get
  // no server-target builds. On-demand fallback covers anything needed sooner.
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const layered = process.env.PNEXT_VENDOR_SEED_LAYERED !== '0'
  const graph = devModuleGraph(config)
  const demand = new Set<string>()
  const dropped = new Set<string>()
  // The layer of a source is part of the record the naming walk just scanned,
  // so the seed reads it instead of re-reading the whole route graph.
  const clientSource = (file: string) =>
    (devHeadTrimEnabled() ? graph.isClientSource(file) : fileHasUseClientDirective(file)).catch(
      () => false,
    )
  // A file the route bundle names as a SERVER entry is never a boundary: `writeDevRouteBundle` loads
  // every layout (and a server page) through the server namespace whatever its directive, so pruning
  // one would drop exactly the packages the bundle then demands - serially, mid-request, in front of
  // the response.
  const serverEntries = new Set(files.map(file => path.resolve(file)))
  if (route.client) serverEntries.delete(path.resolve(route.file))
  const prune = (file: string) => (serverEntries.has(file) ? false : clientSource(file))
  for (const file of files) {
    const full = await graph.packageDemand(file)
    const serverReachable = layered ? new Set(await graph.packageDemand(file, prune)) : undefined
    for (const specifier of full) {
      if (!shouldBundleExternalPackage(specifier, config, file, options)) continue
      if (serverReachable && !serverReachable.has(specifier)) dropped.add(specifier)
      else demand.add(specifier)
    }
  }
  for (const specifier of demand) dropped.delete(specifier)
  return { demand: [...demand], dropped: [...dropped], layered }
}

export async function devRouteModuleLoaders(
  config: ResolvedConfig,
  route: RouteManifestEntry,
  layoutFiles: string[],
  _version?: string,
): Promise<DevRouteModuleLoaders> {
  // The bundle's own content-addressed path is the cache key: a save that
  // changes nothing this route imports keeps it, one that does gives a new
  // path — no version bump, no wholesale eviction.
  const release = devModuleGraph(config).hold()
  const key = await profileDevImport(`route bundle key ${route.route}`, () =>
    devRouteBundlePath(config, route, layoutFiles),
  ).catch(error => {
    release()
    throw error
  })
  noteModuleGeneration(`bundle:${route.route}`, key)
  const existing = routeModuleLoaders.get(key)
  if (existing) {
    release()
    return existing
  }
  // A bundle already on disk was built against vendor artifacts the previous process left next to it, so
  // seeding the stage would walk the whole graph again to demand what is already there - and it would do it
  // on the JS thread the restart's first response is waiting on. Anything genuinely missing is still built
  // on demand by the resolve path.
  if (!devArtifactUsable(key)) {
    startRouteVendorStage(config, route, uniqueFiles([route.file, ...layoutFiles]))
  }

  const next = createDevRouteModuleLoaders(config, route, layoutFiles, key)
    .catch(error => {
      routeModuleLoaders.delete(key)
      throw error
    })
    .finally(release)
  routeModuleLoaders.set(key, next)
  return next
}

async function createDevRouteModuleLoaders(
  config: ResolvedConfig,
  route: RouteManifestEntry,
  layoutFiles: string[],
  outFile: string,
): Promise<DevRouteModuleLoaders> {
  const bundleFile = await writeDevRouteBundle(config, route, layoutFiles, outFile)
  const bundle = await profileDevImport(`import route ${route.route}`, () =>
    importDevModule<DevRouteBundle>(pathToFileHref(bundleFile)),
  )
  const moduleLoader = async (file: string) => {
    const module = bundle.modules[file]
    if (module) return module
    return importDevModule<Record<string, unknown>>(
      await devServerModuleHref(config, file, undefined, {
        conditionTarget: serverBundleTargetForRuntime(route.segmentConfig?.runtime),
      }),
    )
  }
  const batched = new Set(devClientReferenceGroups(config, route).batched)
  const clientModuleLoader = async (file: string) => {
    const module = bundle.clientModules[file]
    if (module) return module
    // The batched client-reference pass owns this file: join its one compile
    // instead of starting a per-module walk over the same graph.
    if (batched.has(path.resolve(file))) {
      const modules = await devClientReferenceModules(config, route).catch(() => undefined)
      const batchedModule = modules?.[path.resolve(file)]
      if (batchedModule) return batchedModule
    }
    return importDevModule<Record<string, unknown>>(
      await devClientModuleHref(
        config,
        file,
        undefined,
        serverBundleTargetForRuntime(route.segmentConfig?.runtime),
      ),
    )
  }
  return { moduleLoader, clientModuleLoader }
}

/**
 * The route's SSR-able client references, split by who compiles them. `batched` is one esbuild pass
 * over the whole set (the client-SSR layer's own bundle, below); `perModule` is what the pass cannot
 * own and the per-file walk still names:
 *
 * - a reference inside node_modules SSRs through its package's client vendor bundle
 *   (`packageClientModuleHref`), so bundling a second copy here would split the package's singletons;
 * - a pages-router source SSRs under a different condition target than the bundle's client layer.
 */
export function devClientReferenceGroups(config: ResolvedConfig, route: RouteManifestEntry) {
  const batched: string[] = []
  const perModule: string[] = []
  const seen = new Set<string>()
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const bundling = reactCompatEnabled(config) && process.env.PNEXT_DEV_CLIENT_REF_BUNDLE !== '0'
  const target = serverBundleTargetForRuntime(route.segmentConfig?.runtime)
  for (const reference of route.clientReferences) {
    if (!ssrClientReference(reference) || seen.has(reference.file)) continue
    seen.add(reference.file)
    const file = path.resolve(reference.file)
    const batchable =
      bundling &&
      existsSync(file) &&
      !isCssFile(file) &&
      !nodeModulesPackageDir(file) &&
      clientLayerConditionTarget(config, file, target) === 'client'
    // The pass names its entries by resolved path (that is the key a module out
    // of it carries); everything else keeps the reference's own name, which is
    // what the per-file walk has always been handed.
    if (batchable) batched.push(file)
    else perModule.push(reference.file)
  }
  return { batched, perModule }
}

// Keyed on the bundle's own content-addressed path, so a save that renames it
// never hands back the previous graph's modules.
const clientReferenceModules = new Map<string, Promise<Record<string, Record<string, unknown>>>>()
const clientReferenceBundleBuilds = new Map<string, Promise<string>>()
// Bundle names memoized per reference set; a save may rename any of them, so
// `clearDevRouteBundleKeys` drops these with the route bundle's own names.
const clientReferenceBundleKeys = new Map<string, Promise<string>>()

/**
 * Every batchable client reference of the route, compiled in ONE esbuild pass and evaluated once.
 * The per-module walk it replaces re-entered the compile pipeline for each reference and each of its
 * imports, which is the dev first page's long pole; the pass names the same client-SSR layer
 * (`clientSsrAliases`, client conditions, packages through their vendor bundles), so a module out of
 * it is the same artifact the walk would have produced - and the render joins this promise through
 * `clientModuleLoader` rather than compiling its own.
 */
export async function devClientReferenceModules(
  config: ResolvedConfig,
  route: RouteManifestEntry,
  options: { evaluate?: boolean } = {},
) {
  const { batched } = devClientReferenceGroups(config, route)
  if (batched.length === 0) return undefined
  const release = devModuleGraph(config).hold()
  const outFile = await devClientReferenceBundlePath(config, route, batched).catch(error => {
    release()
    throw error
  })
  if (options.evaluate === false) {
    await writeDevClientReferenceBundle(config, route, batched, outFile).finally(release)
    return undefined
  }
  const existing = clientReferenceModules.get(outFile)
  if (existing) {
    release()
    return existing
  }
  const next = loadDevClientReferenceModules(config, route, batched, outFile)
    .catch(error => {
      clientReferenceModules.delete(outFile)
      throw error
    })
    .finally(release)
  clientReferenceModules.set(outFile, next)
  return next
}

async function loadDevClientReferenceModules(
  config: ResolvedConfig,
  route: RouteManifestEntry,
  files: string[],
  outFile: string,
) {
  const bundleFile = await writeDevClientReferenceBundle(config, route, files, outFile)
  const bundle = await profileDevImport(`import client references ${route.route}`, () =>
    // Warm import: a reference that throws while evaluating speculatively must not leave Bun's
    // registry holding the failure for the render that asks for it next.
    importDevModule<DevRouteBundle>(pathToFileHref(bundleFile), { warm: true }),
  )
  return bundle.clientModules
}

/**
 * Named by the whole source graph of every reference in it, exactly like the route bundle. Memoized
 * on the reference set so concurrent demands (boot warm, request preload, the render itself) await
 * ONE name and therefore meet each other in the load memo below instead of each starting a pass.
 */
function devClientReferenceBundlePath(
  config: ResolvedConfig,
  route: RouteManifestEntry,
  files: string[],
) {
  const memoKey = `${route.id}\0${files.join('\0')}`
  const memoized = clientReferenceBundleKeys.get(memoKey)
  if (memoized) return memoized
  const next = computeDevClientReferenceBundlePath(config, route, files).catch(error => {
    clientReferenceBundleKeys.delete(memoKey)
    throw error
  })
  clientReferenceBundleKeys.set(memoKey, next)
  return next
}

async function computeDevClientReferenceBundlePath(
  config: ResolvedConfig,
  route: RouteManifestEntry,
  files: string[],
) {
  const graph = devModuleGraph(config)
  const hashes = await Promise.all(files.map(file => graph.graphHash(file)))
  const hash = createHash('sha256').update(hashes.join('\0')).digest('hex').slice(0, 16)
  const bundle = path.join(
    cacheRoot(config.outPath),
    'client-refs',
    `${route.id}.${hash}.client-refs.mjs`,
  )
  noteModuleGeneration(`client-refs:${route.route}`, bundle)
  return bundle
}

async function writeDevClientReferenceBundle(
  config: ResolvedConfig,
  route: RouteManifestEntry,
  files: string[],
  outFile: string,
) {
  if (devArtifactUsable(outFile)) return outFile

  const existing = clientReferenceBundleBuilds.get(outFile)
  if (existing) return existing

  const next = profileDevImport(`build client references ${route.route}`, async () => {
    await mkdir(path.dirname(outFile), { recursive: true })
    const result = await withBuildSlot(() =>
      build({
        stdin: {
          contents: routeBundleEntrySource([], files),
          loader: 'ts',
          resolveDir: config.root,
          sourcefile: `${route.id}.client-references.ts`,
        },
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'neutral',
        target: 'es2022',
        loader: { '.js': 'jsx', '.mjs': 'jsx' },
        jsx: 'automatic',
        jsxImportSource: 'preact',
        packages: 'external',
        logLevel: 'silent',
        ...serverDefineOptions(),
        plugins: [
          serverAssetPlugin(config),
          devRouteBundlePlugin(config, route),
          ...getBundlerExtensions().serverEsbuildPlugins(config),
        ],
      }),
    )
    const output = result.outputFiles[0]
    if (!output) throw new Error(`Failed to build dev client references for ${route.route}`)
    await writeCompiledFile(outFile, output.text)
    return outFile
  }).catch(error => {
    clientReferenceBundleBuilds.delete(outFile)
    throw error
  })

  clientReferenceBundleBuilds.set(outFile, next)
  return next
}

interface DevRouteBundle {
  modules: Record<string, Record<string, unknown>>
  clientModules: Record<string, Record<string, unknown>>
}

async function writeDevRouteBundle(
  config: ResolvedConfig,
  route: RouteManifestEntry,
  layoutFiles: string[],
  outFile: string,
) {
  if (devArtifactUsable(outFile)) return outFile

  const existing = routeBundleBuilds.get(outFile)
  if (existing) return existing

  const next = profileDevImport(`build route ${route.route}`, async () => {
    await mkdir(path.dirname(outFile), { recursive: true })
    const serverFiles = uniqueFiles([...(route.client ? [] : [route.file]), ...layoutFiles])
    const result = await withBuildSlot(() =>
      build({
        stdin: {
          contents: routeBundleEntrySource(serverFiles, []),
          loader: 'ts',
          resolveDir: config.root,
          sourcefile: `${route.id}.route-bundle.ts`,
        },
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'neutral',
        target: 'es2022',
        // Workspace .js/.mjs app modules may contain JSX (packages stay
        // external, so node_modules never reach these loaders).
        loader: { '.js': 'jsx', '.mjs': 'jsx' },
        jsx: 'automatic',
        jsxImportSource: 'preact',
        packages: 'external',
        logLevel: 'silent',
        ...serverDefineOptions(),
        plugins: [
          serverAssetPlugin(config),
          // Ahead of the extension plugins: they resolve without a namespace, so a tsconfig-`paths`
          // import from a route-bundle module would land in esbuild's default namespace and take its
          // whole subtree with it - out of this build's hooks, resolving bare specifiers like
          // `next/dynamic` against real node_modules instead of the compat aliases.
          devRouteBundlePlugin(config, route),
          ...getBundlerExtensions().serverEsbuildPlugins(config),
        ],
      }),
    )
    const output = result.outputFiles[0]
    if (!output) throw new Error(`Failed to build dev route bundle for ${route.route}`)
    await writeCompiledFile(outFile, output.text)
    return outFile
  }).catch(error => {
    routeBundleBuilds.delete(outFile)
    throw error
  })

  routeBundleBuilds.set(outFile, next)
  return next
}

function routeBundleEntrySource(serverFiles: string[], clientFiles: string[]) {
  const serverImports = serverFiles.map(
    (file, index) => `import * as server${index} from ${JSON.stringify(`pnext-server:${file}`)};`,
  )
  const clientImports = clientFiles.map(
    (file, index) => `import * as client${index} from ${JSON.stringify(`pnext-client:${file}`)};`,
  )
  const serverEntries = serverFiles.map((file, index) => `${JSON.stringify(file)}: server${index},`)
  const clientEntries = clientFiles.map((file, index) => `${JSON.stringify(file)}: client${index},`)

  return [
    ...serverImports,
    ...clientImports,
    `export const modules = {${serverEntries.join('')}};`,
    `export const clientModules = {${clientEntries.join('')}};`,
  ].join('\n')
}

function devRouteBundlePlugin(config: ResolvedConfig, route: RouteManifestEntry): Plugin {
  const conditionTarget = serverBundleTargetForRuntime(route.segmentConfig?.runtime)
  const serverOptions: DevModuleOptions = {
    aliases: {
      ...coreAliases(config, 'server'),
      ...getImportAliasExtensions().reactServerLayerAliases(config),
    },
    profile: reactCompatEnabled(config) ? 'compat' : 'server',
    conditionTarget,
    reactServerLayer: true,
    externalLoadTarget: externalLoadTargetForConditionTarget(conditionTarget),
    // Always stub 'use client' files, compat or not: a client module reached transitively through a
    // server module would otherwise inline as an untagged bundle-local copy - markClientReferences then
    // tags a different instance and the component never gets its hydration island.
    stubClientImports: true,
    rewriteExternalServerImports: true,
    bundleExternalPackages: reactCompatEnabled(config),
  }
  const clientOptions: DevModuleOptions = {
    aliases: clientSsrAliases(config),
    profile: 'client',
    conditionTarget: 'client',
    externalLoadTarget: 'client-ssr',
    stubClientImports: false,
    rewriteExternalServerImports: false,
    bundleExternalPackages: reactCompatEnabled(config),
  }

  return {
    name: 'pnext-dev-route-bundle',
    async setup(build) {
      // Ensure the compat client-action module set is discovered for the active
      // dev version before any route-client module loads (dev startup/reload used
      // to run this inline). No-op for pure-core / non-next apps.
      if (nextCompatEnabled(config)) await getClientActionBundler()?.ensureArmed()
      build.onResolve({ filter: /^file:\/\// }, args => ({ path: args.path, external: true }))
      build.onResolve({ filter: /^pnext-server:/ }, args => ({
        path: args.path.slice('pnext-server:'.length),
        namespace: 'pnext-route-server',
      }))
      build.onResolve({ filter: /^pnext-client:/ }, args => ({
        path: args.path.slice('pnext-client:'.length),
        namespace: 'pnext-route-client',
      }))

      build.onResolve({ filter: /.*/, namespace: 'pnext-route-server' }, args =>
        resolveRouteBundleSpecifier(
          config,
          args.path,
          args.importer,
          'pnext-route-server',
          serverOptions,
        ),
      )
      build.onResolve({ filter: /.*/, namespace: 'pnext-route-client' }, args =>
        resolveRouteBundleSpecifier(
          config,
          args.path,
          args.importer,
          'pnext-route-client',
          clientOptions,
        ),
      )
      registerExternalLoadHandlers(build, config, serverOptions, externalLoadNamespaces.server)
      registerExternalLoadHandlers(build, config, clientOptions, externalLoadNamespaces.client)

      // `resolveDir` is what an unclaimed specifier resolves against: the asset and loader-rule
      // plugins fall back to esbuild's own resolution, and a module in a plugin namespace has no
      // directory of its own - without this a `./x.module.css` next to its importer is looked for at
      // the process cwd, exactly as if the per-module path had compiled it from the wrong folder.
      build.onLoad({ filter: /.*/, namespace: 'pnext-route-server' }, async args => ({
        contents: rewriteServerSource(await readText(args.path), args.path, {
          nextFonts: nextCompatEnabled(config),
          root: config.root,
        }),
        loader: esbuildLoader(args.path),
        resolveDir: path.dirname(args.path),
      }))
      build.onLoad({ filter: /.*/, namespace: 'pnext-route-client' }, async args => {
        // A client-side import of a 'use server' module becomes the RPC stub.
        const clientActions = nextCompatEnabled(config) ? getClientActionBundler() : undefined
        if (clientActions?.isClientActionModule(args.path)) {
          return {
            contents: await clientActions.stubSource(args.path),
            loader: 'js',
            resolveDir: path.dirname(args.path),
          }
        }
        return {
          contents: rewriteServerSource(await readText(args.path), args.path, {
            nextFonts: nextCompatEnabled(config),
            root: config.root,
          }),
          loader: esbuildLoader(args.path),
          resolveDir: path.dirname(args.path),
        }
      })
      build.onLoad({ filter: /.*/, namespace: 'pnext-client-reference' }, async args => ({
        contents: clientReferenceModuleSource(
          args.path,
          await clientReferenceExportNames(config, args.path),
        ),
        loader: 'js',
        resolveDir: path.dirname(args.path),
      }))
    },
  }
}

/**
 * Pages-router source modules are never react-server modules: they may import client hooks at top
 * level while only their data functions (`getStaticProps`/`getServerSideProps`) run on the server -
 * the component half renders through the 'use client' facade. Under the react-server layer alias
 * (hook-free react entry) evaluating such a module throws at import binding, so resolve
 * react/react-dom for those importers to the base full-hooks server shims instead.
 */
function pagesCompatSourceAlias(
  config: ResolvedConfig,
  specifier: string,
  importer: string | undefined,
  options: DevModuleOptions,
): string | undefined {
  if (!options.reactServerLayer) return undefined
  if (specifier !== 'react' && specifier !== 'react-dom') return undefined
  if (!importer) return undefined
  const posix = importer.replace(/\\/g, '/')
  if (!posix.includes('/pnext-pages-compat/') || !posix.includes('/source-pages/')) return undefined
  return coreAliases(config, 'server')[specifier]
}

async function resolveRouteBundleSpecifier(
  config: ResolvedConfig,
  specifier: string,
  importer: string,
  namespace: 'pnext-route-server' | 'pnext-route-client',
  options: DevModuleOptions,
): Promise<OnResolveResult | undefined> {
  const compatAlias =
    pagesCompatSourceAlias(config, specifier, importer, options) ?? options.aliases[specifier]
  if (compatAlias) {
    return {
      path: path.isAbsolute(compatAlias) ? pathToFileHref(compatAlias) : compatAlias,
      external: true,
    }
  }

  // A `turbopack.rules` loader chain owns this specifier (see the same check in
  // resolveDevModuleSpecifier): import its materialized output.
  const pendingRuleModule = getAssetExtensions().loaderRuleModule(specifier, importer)
  const ruleModule = pendingRuleModule === undefined ? undefined : await pendingRuleModule
  if (ruleModule) return { path: pathToFileHref(ruleModule), external: true }

  if (isServerIgnoredAssetSpecifier(specifier)) return undefined

  const { sourcePath, hash } = splitHash(specifier)
  const resolved = resolveLocalImport(config, importer, sourcePath)
  // `resolveExtensions` can land an extensionless specifier on an asset
  // (`import img from './image'` -> image.png), which the specifier-keyed check
  // above and serverAssetPlugin's own filter both miss. Hand it to the asset
  // namespace, or the loader below parses the image bytes as source.
  if (
    resolved &&
    isServerIgnoredAssetSpecifier(resolved) &&
    !getAssetExtensions().hasLoaderRuleFor(resolved)
  ) {
    return { path: resolved, namespace: serverAssetNamespace }
  }
  if (resolved && isInside(config.workspaceRoot, resolved)) {
    if (
      options.stubClientImports &&
      !isCssFile(resolved) &&
      (await fileHasUseClientDirective(resolved))
    ) {
      return { path: resolved, namespace: 'pnext-client-reference' }
    }
    return { path: resolved, namespace }
  }
  // An absolute path that lands outside the workspace is framework runtime a rewrite injected by path
  // rather than by alias - pnext's own source is not part of the app's module graph, so it loads
  // externally exactly like the alias branch above. Without this the bundle cannot resolve it at all:
  // esbuild does not fall back to the filesystem for an import raised from a plugin namespace, so the
  // whole route bundle fails and the route silently drops to per-module loading.
  if (resolved && path.isAbsolute(sourcePath)) {
    return { path: `${pathToFileHref(resolved)}${hash}`, external: true }
  }

  if (
    options.bundleExternalPackages &&
    shouldBundleExternalPackage(sourcePath, config, importer, options)
  ) {
    return {
      path: await externalServerPackageHref(
        config,
        sourcePath,
        options.profile === 'client' ? 'client' : 'server',
        path.dirname(importer),
        options.conditionTarget,
      ),
      external: true,
    }
  }

  if (isPackageSpecifier(sourcePath) || isBuiltinSpecifier(sourcePath)) {
    const resolvedExternalLoad = resolveExternalLoadTarget({
      root: config.root,
      fromFile: importer,
      specifier: sourcePath,
      target: options.externalLoadTarget,
    })
    if (resolvedExternalLoad && (await externalLoadNeedsFacade(resolvedExternalLoad))) {
      return {
        path: resolvedExternalLoad,
        namespace:
          options.profile === 'client'
            ? externalLoadNamespaces.client
            : externalLoadNamespaces.server,
      }
    }
    const externalTarget =
      resolvedExternalLoad ?? externalPackageImportTarget(config.root, importer, sourcePath)
    return {
      path: externalTarget
        ? `${pathToFileHref(externalTarget)}${hash}`
        : options.rewriteExternalServerImports
          ? runtimeServerImportTarget(specifier)
          : specifier,
      external: true,
    }
  }

  return undefined
}

// Sidecar of each artifact's raw import specifiers so the vercel trace reads
// them back instead of re-parsing artifacts. Off outside vercel prod builds.
let emitCompiledSpecifiersManifest = false

/** @internal Test-only. Returns a restore function. */
export function setEmitCompiledSpecifiersManifest(enabled: boolean) {
  const previous = emitCompiledSpecifiersManifest
  emitCompiledSpecifiersManifest = enabled
  return () => {
    emitCompiledSpecifiersManifest = previous
  }
}

/** Sidecar suffix for a compiled artifact's recorded specifiers. */
export const compiledSpecifiersManifestSuffix = '.pnext-specifiers.json'

const compiledScriptFilePattern = /\.(?:m?js|cjs|jsx|tsx?)$/

async function writeCompiledFile(file: string, contents: string) {
  await writeFileAtomic(file, contents)
  noteDevArtifactWritten(file)
  if (emitCompiledSpecifiersManifest && compiledScriptFilePattern.test(file)) {
    await writeFileAtomic(
      `${file}${compiledSpecifiersManifestSuffix}`,
      JSON.stringify(importSpecifiers(contents, file)),
    )
  }
}

/**
 * Whether every file URL reachable from a compiled artifact is already on
 * disk. Individual files publish atomically, but the graph is a set of files:
 * the build's warm child can expose an importer to the parent before it has
 * exposed that importer's slower sibling. A mere existsSync(importer) is
 * therefore not a complete-cache invariant across processes.
 */
function missingCompiledArtifact(entry: string): string | undefined {
  const root = compiledArtifactProfileRoot(entry)
  if (!root) return existsSync(entry) ? undefined : entry

  const visiting = new Set<string>()
  const visit = (file: string): string | undefined => {
    if (visiting.has(file)) return undefined
    if (!existsSync(file)) return file
    // Raw framework/package file URLs are ordinary immutable dependencies, not
    // members of the materialized graph whose publication order we own.
    if (!isInside(root, file) || !compiledScriptFilePattern.test(file)) return undefined

    visiting.add(file)
    const cachedTargets = completeArtifactClosures.get(file)
    if (cachedTargets) {
      for (const target of cachedTargets) {
        const missing = visit(target)
        if (missing) return missing
      }
      visiting.delete(file)
      return undefined
    }

    let source: string
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      return file
    }
    const targets: string[] = []
    for (const { specifier, kind } of moduleSpecifierEdges(source, file)) {
      // A dynamic import is an on-demand publication boundary: its target may
      // belong to a later client-chunk phase even when both artifacts share a
      // profile directory. Static imports must be complete before evaluation.
      if (kind === 'dynamic') continue
      const { sourcePath } = splitHash(specifier)
      if (!sourcePath.startsWith('file://')) continue
      let target: string
      try {
        target = fileURLToPath(sourcePath)
      } catch {
        return sourcePath
      }
      if (!isInside(root, target)) {
        if (existsSync(target)) continue
        const emittedRoot = compiledArtifactProfileRoot(target)
        // A different profile is produced by a separate build phase. Only a
        // dead reference to this same profile can be a relocated cache member.
        if (!emittedRoot || path.basename(emittedRoot) !== path.basename(root)) continue
        target = path.resolve(root, path.relative(emittedRoot, target))
      }
      const missing = visit(target)
      if (missing) return missing
      targets.push(target)
    }
    completeArtifactClosures.set(file, targets)
    visiting.delete(file)
    return undefined
  }

  return visit(entry)
}

/** Accept a complete hit, or join the exact missing member already being published locally. */
function compiledArtifactReadyOrCompleting(entry: string, visited: Set<string>): boolean {
  if (!devArtifactUsable(entry)) return false
  const missing = missingCompiledArtifact(entry)
  if (!missing) return true
  const completing = moduleBuilds.get(missing)
  if (!completing) return false
  ownedBuilds(visited).add(completing)
  return true
}

function assertCompiledArtifactClosure(entry: string): void {
  const missing = missingCompiledArtifact(entry)
  if (!missing) return
  const error = new Error(`incomplete server module graph ${entry}: ${missing}`)
  noteModuleGraphFailure(error)
  throw error
}

function compiledArtifactProfileRoot(file: string): string | undefined {
  const marker = `${path.sep}cache${path.sep}server${path.sep}`
  const index = file.lastIndexOf(marker)
  if (index < 0) return undefined
  const profileStart = index + marker.length
  const profileEnd = file.indexOf(path.sep, profileStart)
  if (profileEnd < 0) return undefined
  const profile = file.slice(profileStart, profileEnd)
  return profile === 'modules' || profile.startsWith('modules-')
    ? file.slice(0, profileEnd)
    : undefined
}

/** Where `file` compiles to under `profile`, named by its current source graph. */
async function devModulePathFor(config: ResolvedConfig, file: string, profile: string) {
  return devServerPath(config, file, profile, await devModuleGraph(config).graphHash(file))
}

function devModulePath(config: ResolvedConfig, file: string, options: DevModuleOptions) {
  return devModulePathFor(config, file, devModuleProfile(options))
}

async function writeDevModule(
  config: ResolvedConfig,
  file: string,
  visited: Set<string>,
  options: DevModuleOptions,
) {
  const profile = devModuleProfile(options)
  const outFile = await devModulePath(config, file, options)
  const visitedKey = `${profile}:${file}`
  noteModuleGeneration(visitedKey, outFile)
  if (visited.has(visitedKey)) return outFile

  // The name carries the hash of this module's whole source graph, so an existing artifact is current.
  // It is reusable only when its emitted closure is present too: another process may have published the
  // importer first. An unusable artifact falls through to recompile and is overwritten in place - never
  // delete first, since Bun caches a failed resolution for the life of the process.
  if (compiledArtifactReadyOrCompleting(outFile, visited)) return outFile

  // Already being built: its artifact path is all this caller needs, and the entry's drain is what
  // waits for the bytes. Awaiting it here is what used to deadlock two walks meeting a cycle. The
  // walk still OWNS it - its graph names that artifact, so its failure is this entry's failure.
  const inFlight = moduleBuilds.get(outFile)
  if (inFlight) {
    ownedBuilds(visited).add(inFlight)
    return outFile
  }

  visited.add(visitedKey)
  const started = moduleStats ? performance.now() : 0
  const next = writeDevModuleUncached(config, file, visited, options, outFile)
    .then(result => {
      if (moduleStats) {
        noteModuleCompile(
          file,
          profile,
          performance.now() - started,
          esbuildFallbacks.delete(visitedKey),
        )
      }
      return result
    })
    .finally(() => {
      // Identity-guarded: a rebuild may already have claimed this path.
      if (moduleBuilds.get(outFile) === next) moduleBuilds.delete(outFile)
    })
  // Only a drain consumes the rejection; this keeps it from surfacing as an unhandled one meanwhile.
  next.catch(() => undefined)
  registerBuild(next)
  ownedBuilds(visited).add(next)
  moduleBuilds.set(outFile, next)
  return outFile
}

async function writeDevModuleUncached(
  config: ResolvedConfig,
  file: string,
  visited: Set<string>,
  options: DevModuleOptions,
  outFile: string,
) {
  await mkdir(path.dirname(outFile), { recursive: true })
  if (isCssFile(file)) {
    await copyFile(file, outFile)
    return outFile
  }

  let source: string | undefined
  // A client-profile compile of a 'use server' module emits the RPC stub, so
  // the browser bundle POSTs to the endpoint instead of shipping server code.
  if (options.profile === 'client' && nextCompatEnabled(config)) {
    const clientActions = getClientActionBundler()
    if (clientActions) {
      await clientActions.ensureArmed()
      if (clientActions.isClientActionModule(file)) {
        await writeCompiledFile(outFile, await clientActions.stubSource(file))
        return outFile
      }
      const loaded = await clientActions.loadClientSource(file, config.root)
      source = loaded.source
      if (loaded.stubSource !== undefined) {
        await writeCompiledFile(outFile, loaded.stubSource)
        return outFile
      }
    }
  }

  source ??= await readText(file)
  if (/\.mdx?$/.test(file) && nextCompatEnabled(config)) {
    // Markdown modules must be compiled to JS before import analysis and the
    // stdin-based bundle pass (which bypasses file-resolved onLoad plugins).
    const { compileMdx } = await import('../compat/mdx/compile')
    source = (await compileMdx(source, file, config.root)).code
  }
  const transformedSource = rewriteServerSource(source, file, {
    nextFonts: nextCompatEnabled(config),
    root: config.root,
  })
  const effectiveOptions =
    reactCompatEnabled(config) &&
    options.profile !== 'client' &&
    hasUseClientDirective(transformedSource)
      ? clientLayerOptions(
          config,
          clientLayerConditionTarget(config, file, options.conditionTarget),
        )
      : options
  // The asset-context link walk is pure I/O against directories nothing below
  // reads, so it overlaps the shaking/scan/child-compile work and is only
  // awaited before the write.
  const assetContext = linkAssetContext(config, file, devModuleProfile(effectiveOptions))
  // Rewrite destructured dynamic imports (`const { used } = await import('x')`)
  // to point at a tree-shaken facade so the target's unused exports are dropped
  // (compat: mirrors webpack's dynamic-import export usage analysis). Done
  // before the import scans below so the plain (all-exports) target is never
  // compiled when it's only reached through shakeable dynamic imports.
  // dynamic(ssr:false) split points: the SSR layer never runs those import()s,
  // so their subtrees (and the vendor demand they fan out) compile on browser
  // demand instead of on the cold critical path.
  const deferredDynamic =
    effectiveOptions.profile === 'client' && devDynamicSplitEnabled()
      ? deferredDynamicTargetFiles(transformedSource, config, file)
      : undefined
  const shakenSource = await applyDynamicImportTreeShaking(
    transformedSource,
    config,
    file,
    visited,
    effectiveOptions,
    deferredDynamic,
  )
  const clientReferences =
    reactCompatEnabled(config) &&
    effectiveOptions.stubClientImports &&
    !hasUseClientDirective(shakenSource)
      ? await writeClientReferenceModules(shakenSource, config, file, effectiveOptions.aliases)
      : { specifiers: new Map<string, string>(), files: new Set<string>() }
  // Compiling this module only needs its imports' *paths*, so it runs while the targets themselves
  // compile. Registering the edges is all this awaits; drainModuleBuilds is what holds an href back
  // until they are on disk.
  const compiled = buildDevModuleSource(
    shakenSource,
    config,
    file,
    clientReferences.specifiers,
    effectiveOptions,
    visited,
  )
  // The real rejection is reported below; this only keeps it from surfacing as
  // an unhandled rejection while the imports compile.
  compiled.catch(() => undefined)
  await Promise.all([
    assetContext,
    ...localImportTargets(shakenSource, config, file, effectiveOptions.aliases)
      // Relative and absolute imports always name first-party source next to its importer (compat's
      // own out-of-workspace runtime files import each other this way), so compile it regardless of
      // workspaceRoot. A bare specifier that happens to resolve locally only compiles when it is
      // inside the workspace; outside that it is meant to stay an untouched external package.
      .filter(
        ({ target, isLocalSource }) =>
          (isLocalSource || isInside(config.workspaceRoot, target)) &&
          !clientReferences.files.has(path.resolve(target)) &&
          !deferredDynamic?.has(path.resolve(target)),
      )
      .map(({ target }) => writeDevModule(config, target, visited, effectiveOptions)),
  ])

  const compiledSource = await compiled
  if (skipModuleWriteForTest(file)) return outFile
  await delayWarmModuleWriteForTest(file)
  await writeCompiledFile(outFile, compiledSource)
  return outFile
}

/** Test-only seam for proving an irreparable incomplete graph fails the build. */
function skipModuleWriteForTest(file: string) {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const suffix = process.env.PNEXT_TEST_SKIP_MODULE_WRITE
  return Boolean(suffix && file.endsWith(suffix))
}

/** Test-only seam for forcing the build/warm-child partial-graph publication window. */
async function delayWarmModuleWriteForTest(file: string) {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const setting = process.env.PNEXT_TEST_DELAY_WARM_MODULE_WRITE
  if (!setting || !process.argv.some(argument => argument.endsWith('vercel-warm.ts'))) return
  const separator = setting.lastIndexOf(':')
  if (separator < 1 || !file.endsWith(setting.slice(0, separator))) return
  const delay = Number(setting.slice(separator + 1))
  if (Number.isFinite(delay) && delay > 0) await Bun.sleep(delay)
}

const shakeEntrySpecifier = 'pnext-shake-entry'
const shakeEntryNamespace = 'pnext-shake-entry'

// Rewrite each shakeable destructured dynamic import in `source` so its
// specifier points at a tree-shaken facade module (see resolve/tree-shake.ts).
// Only local workspace modules are shaken; 'use client' targets keep their
// client-reference stubbing path. Returns the source unchanged when nothing
// qualifies.
async function applyDynamicImportTreeShaking(
  source: string,
  config: ResolvedConfig,
  file: string,
  visited: Set<string>,
  options: DevModuleOptions,
  deferredDynamic?: Set<string>,
): Promise<string> {
  if (!nextCompatEnabled(config)) return source
  const candidates = findShakeableDynamicImports(source)
  if (candidates.length === 0) return source

  const edits: { start: number; end: number; value: string }[] = []
  for (const candidate of candidates) {
    const { sourcePath } = splitHash(candidate.specifier)
    if (isServerIgnoredAssetSpecifier(sourcePath) && !isCssFile(sourcePath)) continue
    const resolved = resolveLocalImport(config, file, sourcePath)
    if (!resolved || !isInside(config.workspaceRoot, resolved) || isCssFile(resolved)) continue
    // A deferred dynamic() target must not compile eagerly through the facade.
    if (deferredDynamic?.has(path.resolve(resolved))) continue
    if (options.stubClientImports && (await fileHasUseClientDirective(resolved))) continue
    const facade = await writeShakenDynamicModule(
      config,
      resolved,
      candidate.usedExports,
      visited,
      options,
    )
    edits.push({
      start: candidate.literalStart,
      end: candidate.literalEnd,
      value: JSON.stringify(pathToFileHref(facade)),
    })
  }

  if (edits.length === 0) return source
  let next = source
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    next = `${next.slice(0, edit.start)}${edit.value}${next.slice(edit.end)}`
  }
  return next
}

function shakeExportsKey(usedExports: string[]): string {
  const sorted = [...new Set(usedExports)].sort()
  if (sorted.length === 0) return 'none'
  return createHash('sha256').update(sorted.join(',')).digest('hex').slice(0, 8)
}

async function shakenModulePath(
  config: ResolvedConfig,
  targetFile: string,
  profile: string,
  key: string,
): Promise<string> {
  const base = await devModulePathFor(config, targetFile, profile)
  const ext = path.extname(base) || '.js'
  return `${base.slice(0, base.length - ext.length)}.pnext-shake-${key}${ext}`
}

// Facade entry that re-exports only the destructured names from the target
// (loaded inline via the shake-entry namespace), so esbuild tree-shakes the
// rest. An empty set keeps side effects only.
function shakenEntrySource(usedExports: string[]): string {
  const names = [...new Set(usedExports)]
  if (names.length === 0) return `import ${JSON.stringify(shakeEntrySpecifier)};\n`
  const named = names.filter(name => name !== 'default')
  const lines: string[] = []
  if (named.length > 0) {
    lines.push(`export { ${named.join(', ')} } from ${JSON.stringify(shakeEntrySpecifier)};`)
  }
  if (names.includes('default')) {
    lines.push(`export { default } from ${JSON.stringify(shakeEntrySpecifier)};`)
  }
  return `${lines.join('\n')}\n`
}

async function writeShakenDynamicModule(
  config: ResolvedConfig,
  targetFile: string,
  usedExports: string[],
  visited: Set<string>,
  options: DevModuleOptions,
): Promise<string> {
  const profile = devModuleProfile(options)
  const outFile = await shakenModulePath(config, targetFile, profile, shakeExportsKey(usedExports))
  if (compiledArtifactReadyOrCompleting(outFile, visited)) return outFile

  const key = `shake\0${outFile}`
  if (moduleBuilds.has(key)) return outFile

  const next = writeShakenDynamicModuleUncached(
    config,
    targetFile,
    usedExports,
    visited,
    options,
    outFile,
  ).finally(() => {
    if (moduleBuilds.get(key) === next) moduleBuilds.delete(key)
  })
  next.catch(() => undefined)
  registerBuild(next)
  moduleBuilds.set(key, next)
  return outFile
}

async function writeShakenDynamicModuleUncached(
  config: ResolvedConfig,
  targetFile: string,
  usedExports: string[],
  visited: Set<string>,
  options: DevModuleOptions,
  outFile: string,
): Promise<string> {
  await mkdir(path.dirname(outFile), { recursive: true })
  const targetSource = rewriteServerSource(await readText(targetFile), targetFile, {
    nextFonts: nextCompatEnabled(config),
    root: config.root,
  })
  // The target is inlined into the facade, but its own transitive imports stay
  // external file:// modules — compile them the same way the normal graph walk
  // would so those hrefs resolve on disk.
  await Promise.all(
    localImportTargets(targetSource, config, targetFile, options.aliases)
      .filter(
        ({ target, isLocalSource }) => isLocalSource || isInside(config.workspaceRoot, target),
      )
      .map(({ target }) => writeDevModule(config, target, visited, options)),
  )
  const externalBundles = await externalBundleSpecifiers(targetSource, config, targetFile, options)
  const shake = () =>
    withBuildSlot(() =>
      build({
        stdin: {
          contents: shakenEntrySource(usedExports),
          loader: 'js',
          resolveDir: path.dirname(targetFile),
          sourcefile: `${targetFile}.pnext-shake`,
        },
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'neutral',
        target: 'es2022',
        jsx: 'automatic',
        jsxImportSource: 'preact',
        packages: 'external',
        logLevel: 'silent',
        ...serverDefineOptions(),
        plugins: [
          shakeEntryPlugin(targetFile, targetSource),
          serverAssetPlugin(config),
          ...getBundlerExtensions().serverEsbuildPlugins(config),
          devModuleResolvePlugin(config, targetFile, new Map(), externalBundles, options, visited),
        ],
      }),
    )
  // The facade inlines the target outright, so its package imports are always late ones. Same shape
  // as buildDevModuleSource: vendor off the slot, then shake again, to a fixpoint.
  let result = await shake()
  while (await vendorLateExternalPackages(config, options, externalBundles)) result = await shake()
  const output = result.outputFiles[0]
  if (!output) throw new Error(`Failed to tree-shake ${targetFile}`)
  await writeCompiledFile(outFile, addExtensionlessDynamicImportGlobAliases(output.text))
  return outFile
}

// Resolve the facade's re-export entry to the target's already-transformed
// source, loaded inline (non-external) so esbuild bundles and tree-shakes it.
function shakeEntryPlugin(targetFile: string, targetSource: string): Plugin {
  return {
    name: 'pnext-shake-entry',
    setup(build) {
      build.onResolve({ filter: new RegExp(`^${shakeEntrySpecifier}$`) }, () => ({
        path: targetFile,
        namespace: shakeEntryNamespace,
      }))
      build.onLoad({ filter: /.*/, namespace: shakeEntryNamespace }, () => ({
        contents: targetSource,
        loader: esbuildLoader(targetFile),
        resolveDir: path.dirname(targetFile),
      }))
    },
  }
}

function externalLoadTargetForConditionTarget(target: ServerBundleTarget): ExternalLoadTarget {
  return target === 'edge' ? 'edge' : 'server'
}

function clientLayerOptions(
  config: ResolvedConfig,
  conditionTarget: ServerBundleTarget = 'client',
): DevModuleOptions {
  return {
    aliases: clientSsrAliases(config),
    profile: 'client',
    conditionTarget,
    externalLoadTarget: 'client-ssr',
    stubClientImports: false,
    rewriteExternalServerImports: false,
    bundleExternalPackages: reactCompatEnabled(config),
  }
}

/**
 * The SSR condition target for a `use client` module. App-router client components keep the
 * browser-flavored `client` conditions. Pages-router PAGE sources instead SSR with Next's pages
 * server-bundle conditions - `node` (or `edge-light`/`browser` under an edge runtime), never
 * `react-server` - so packages with per-condition `exports` resolve like Next.
 */
/**
 * SERVER-layer condition target for a pages-router source file. A pages page is not part of the RSC
 * layer - Next compiles it under `node`/`edge-light` conditions WITHOUT `react-server` - but its
 * callers only know the route's generic server target, so the demotion happens here. Without it a
 * dual-published dependency is vendored from its `react-server` entry, which may export no `default`
 * and 500 on every render of the page.
 */
function pagesLayerConditionTarget(
  config: ResolvedConfig,
  file: string,
  incoming: ServerBundleTarget,
): ServerBundleTarget {
  if (incoming === 'server') return isPagesRouterSourceFile(config, file) ? 'pages' : 'server'
  if (incoming === 'edge') return isPagesRouterSourceFile(config, file) ? 'pages-edge' : 'edge'
  return incoming
}

function clientLayerConditionTarget(
  config: ResolvedConfig,
  file: string,
  incoming: ServerBundleTarget,
): ServerBundleTarget {
  if (!isPagesRouterSourceFile(config, file)) return 'client'
  return incoming === 'edge' || incoming === 'pages-edge' ? 'pages-edge' : 'pages'
}

function isPagesRouterSourceFile(config: ResolvedConfig, file: string): boolean {
  const posix = file.split(path.sep).join('/')
  if (posix.includes('/source-pages/')) return true
  // Materialized hybrid wrappers live under pnext-pages-compat/<hash>/app/ for
  // BOTH routers; only pages wrappers re-export from source-pages/, so sniff
  // the (tiny, generated) wrapper body to tell them apart.
  if (posix.includes('pnext-pages-compat/')) {
    try {
      return readFileSync(file, 'utf8').includes('source-pages/')
    } catch {
      return false
    }
  }
  return isInside(path.join(config.root, 'pages'), file)
}

async function buildDevModuleSource(
  source: string,
  config: ResolvedConfig,
  file: string,
  clientReferenceSpecifiers: Map<string, string>,
  options: DevModuleOptions,
  visited: Set<string>,
) {
  const externalBundles = await externalBundleSpecifiers(source, config, file, options)
  let compiled = await compileDevModuleSource(
    source,
    config,
    file,
    clientReferenceSpecifiers,
    externalBundles,
    options,
    visited,
  )
  // Vendoring for a specifier only an INLINED module asked for happens here - between compiles, with
  // no build slot held - and the module is compiled again with the map filled in. Doing it from the
  // resolve callback instead would hold a slot for the length of a vendor build.
  //
  // To a FIXPOINT, not once: vendoring a specifier changes what the next compile inlines, so round N
  // can expose a package round N-1 never saw. It terminates because every round records at least one
  // new key in `externalBundles` and a recorded specifier is never noted again.
  while (await vendorLateExternalPackages(config, options, externalBundles)) {
    compiled = await compileDevModuleSource(
      source,
      config,
      file,
      clientReferenceSpecifiers,
      externalBundles,
      options,
      visited,
    )
  }
  return compiled
}

async function compileDevModuleSource(
  source: string,
  config: ResolvedConfig,
  file: string,
  clientReferenceSpecifiers: Map<string, string>,
  externalBundles: Map<string, string>,
  options: DevModuleOptions,
  visited: Set<string>,
) {
  const transformed = await transformDevModuleSource(
    source,
    config,
    file,
    clientReferenceSpecifiers,
    externalBundles,
    options,
    visited,
  )
  if (transformed !== undefined) return transformed
  if (moduleStats) esbuildFallbacks.add(`${devModuleProfile(options)}:${file}`)
  const result = await withBuildSlot(() =>
    build({
      stdin: {
        contents: source,
        loader: esbuildLoader(file),
        resolveDir: path.dirname(file),
        sourcefile: file,
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      // Workspace .js/.mjs app modules may contain JSX (packages stay external,
      // so node_modules never reach these loaders).
      loader: { '.js': 'jsx', '.mjs': 'jsx' },
      jsx: 'automatic',
      jsxImportSource: 'preact',
      packages: 'external',
      logLevel: 'silent',
      ...serverDefineOptions(),
      plugins: [
        serverAssetPlugin(config),
        ...getBundlerExtensions().serverEsbuildPlugins(config),
        serverClientReferencePlugin(config, options),
        devModuleResolvePlugin(
          config,
          file,
          clientReferenceSpecifiers,
          externalBundles,
          options,
          visited,
        ),
      ],
    }),
  )
  const output = result.outputFiles[0]
  if (!output) throw new Error(`Failed to build ${file}`)
  const compiled = addExtensionlessDynamicImportGlobAliases(output.text)
  return options.profile === 'client' && isCommonJsModuleSource(source, file)
    ? unwrapCommonJsDefaultExport(compiled)
    : compiled
}

/**
 * The batched-pipeline fast path: oxc-transform plus our own specifier rewriting, for the great
 * majority of server modules that are plain ESM. Returns undefined when this module needs esbuild's
 * bundler - either its source has an esbuild-only shape, or one of its specifiers only resolves by
 * inlining something (asset loader rules, `#subpath` facades, require-aliases).
 */
async function transformDevModuleSource(
  source: string,
  config: ResolvedConfig,
  file: string,
  clientReferenceSpecifiers: Map<string, string>,
  externalBundles: Map<string, string>,
  options: DevModuleOptions,
  visited: Set<string>,
): Promise<string | undefined> {
  // Kill switch: puts every module back on the esbuild build below, for
  // bisecting a suspected transform-path difference.
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  if (process.env.PNEXT_DISABLE_BATCHED_TRANSFORM) return undefined
  if (transformBailReason(source, file)) return undefined
  const transformed = transformServerModule(source, file, serverDefineOptions().define)
  if ('bail' in transformed) return undefined

  const { code } = transformed
  const edits: { start: number; end: number; value: string }[] = []
  for (const found of outputSpecifiers(code)) {
    const target = await devModuleSpecifierTarget(
      found.value,
      found.kind,
      config,
      file,
      clientReferenceSpecifiers,
      externalBundles,
      options,
      visited,
    )
    if (target === undefined) return undefined
    if (target !== found.value)
      edits.push({ start: found.start, end: found.end, value: JSON.stringify(target) })
  }
  return spliceSource(code, edits)
}

/**
 * One specifier's rewrite target, or undefined when only the bundler can serve
 * it. Assets take the same stub content the bundler inlines, written out as a
 * real module instead.
 */
async function devModuleSpecifierTarget(
  specifier: string,
  kind: SpecifierKind,
  config: ResolvedConfig,
  file: string,
  clientReferenceSpecifiers: Map<string, string>,
  externalBundles: Map<string, string>,
  options: DevModuleOptions,
  visited: Set<string>,
): Promise<string | undefined> {
  // Same claim `serverAssetPlugin` makes, and in the same order: it is the first
  // onResolve in the build below.
  if (isServerIgnoredAssetSpecifier(specifier)) {
    const resolved = resolveAssetPath(specifier, path.dirname(file))
    // A configured loader-rule chain (turbopack.rules) preempts the generic
    // asset stub — fall through to the rule-aware resolver below.
    if (!getAssetExtensions().hasLoaderRuleFor(resolved)) {
      return pathToFileHref(await assetStubModule(config, resolved, devModuleProfile(options)))
    }
  }
  const resolved = await resolveDevModuleSpecifier(
    specifier,
    config,
    file,
    clientReferenceSpecifiers,
    externalBundles,
    options,
    kind,
    file,
    visited,
  )
  // A non-external result names a namespace the bundler loads inline
  // (`pnext-module-external` facades) or a bare require-alias path.
  return resolved.external && typeof resolved.path === 'string' ? resolved.path : undefined
}

const assetStubs = new Map<string, Promise<string>>()

/** The empty/static-asset/css-module stub the bundler used to inline, as a file. */
async function assetStubModule(config: ResolvedConfig, resolved: string, profile: string) {
  const base = splitHash(resolved).sourcePath.replace(/\?.*$/, '')
  const outFile = `${await devModulePathFor(config, base, profile)}.pnext-asset.js`
  const existing = assetStubs.get(outFile)
  if (existing) return existing
  const next = (async () => {
    const contents =
      getCssExtensions().loadCssModuleForClient(resolved) ??
      (isCssFile(base)
        ? ''
        : isStaticImageFile(base)
          ? await staticImageModuleSource(config, resolved)
          : 'export default "";')
    await mkdir(path.dirname(outFile), { recursive: true })
    await writeCompiledFile(outFile, contents)
    return outFile
  })().catch(error => {
    assetStubs.delete(outFile)
    throw error
  })
  assetStubs.set(outFile, next)
  return next
}

function unwrapCommonJsDefaultExport(code: string) {
  const match = /(^|\n)export default ([^;\n]+);/.exec(code)
  if (!match?.[2]) return code
  const moduleName = uniqueIdentifier(code, '__pnext_cjs_module')
  const defaultName = uniqueIdentifier(code, '__pnext_cjs_default', moduleName)
  return code.replace(
    match[0],
    `${match[1]}var ${moduleName} = ${match[2]};\nvar ${defaultName} = ${moduleName} != null && "default" in Object(${moduleName}) ? ${moduleName}.default : ${moduleName};\nexport { ${defaultName} as default };`,
  )
}

function devModuleResolvePlugin(
  config: ResolvedConfig,
  file: string,
  clientReferenceSpecifiers: Map<string, string>,
  externalBundles: Map<string, string>,
  options: DevModuleOptions,
  visited: Set<string>,
): Plugin {
  return {
    name: 'pnext-dev-module-resolve',
    setup(build) {
      registerExternalLoadHandlers(build, config, options, externalLoadNamespaces.module)
      build.onResolve({ filter: /.*/ }, args =>
        resolveDevModuleSpecifier(
          args.path,
          config,
          file,
          clientReferenceSpecifiers,
          externalBundles,
          options,
          args.kind,
          args.importer,
          visited,
        ),
      )
    },
  }
}

function serverClientReferencePlugin(config: ResolvedConfig, options: DevModuleOptions): Plugin {
  return {
    name: 'pnext-server-client-references',
    setup(build) {
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/, namespace: 'file' }, async args => {
        if (!options.stubClientImports) return undefined
        const source = await readText(args.path)
        if (!hasUseClientDirective(source)) return undefined
        return {
          contents: clientReferenceModuleSource(
            args.path,
            await clientReferenceExportNames(config, args.path),
          ),
          loader: 'js',
          resolveDir: path.dirname(args.path),
        }
      })
    },
  }
}

const serverAssetNamespace = 'pnext-empty-server-asset'

function serverAssetPlugin(config: ResolvedConfig): Plugin {
  return {
    name: 'pnext-empty-server-assets',
    setup(build) {
      build.onResolve({ filter: serverIgnoredAssetFilter }, args => {
        const resolved = resolveAssetPath(args.path, args.resolveDir)
        // A configured `turbopack.rules` loader chain for this extension (e.g.
        // `*.svg`) preempts the generic asset pipeline: defer so the compat
        // loader-rule plugin's onLoad runs the chain against the real file.
        // This is the plugin that builds app-page SERVER bundles, so without
        // this escape hatch a configured `*.svg` rule never runs here.
        if (getAssetExtensions().hasLoaderRuleFor(resolved)) return undefined
        return { path: resolved, namespace: serverAssetNamespace }
      })
      build.onLoad({ filter: /.*/, namespace: serverAssetNamespace }, async args => {
        // Registry-provided CSS modules (e.g. *.module.scss) export their class
        // map on the server instead of the empty-asset stub.
        const cssModule = getCssExtensions().loadCssModuleForClient(args.path)
        return {
          contents:
            cssModule ??
            (isCssFile(args.path)
              ? ''
              : isStaticImageFile(args.path)
                ? await staticImageModuleSource(config, args.path)
                : 'export default "";'),
          loader: 'js',
        }
      })
    },
  }
}

async function resolveDevModuleSpecifier(
  specifier: string,
  config: ResolvedConfig,
  file: string,
  clientReferenceSpecifiers: Map<string, string>,
  externalBundles: Map<string, string>,
  options: DevModuleOptions,
  kind: string,
  importer: string,
  visited: Set<string>,
): Promise<OnResolveResult> {
  // An already-resolved `file://` href is a compiled module on disk; pass it straight through as
  // external instead of re-resolving it. But a file:// href naming a RAW 'use client' source
  // (rewriteStaticCompatImports resolves compat aliases textually) still needs the same
  // client-reference stubbing as a bare specifier - importing the raw file yields an untagged third
  // module instance the render walk never recognizes as a client boundary.
  if (specifier.startsWith('file://')) {
    const { sourcePath: hrefPath, hash: hrefHash } = splitHash(specifier)
    const target = fileURLToPath(hrefPath)
    if (
      options.stubClientImports &&
      !isCssFile(target) &&
      !isInside(config.outPath, target) &&
      existsSync(target) &&
      (await fileHasUseClientDirective(target))
    ) {
      const stub = await clientReferencePath(config, target)
      await writeClientReferenceModule(
        stub,
        target,
        await clientReferenceExportNames(config, target),
      )
      return { path: `${pathToFileHref(stub)}${hrefHash}`, external: true }
    }
    return { path: specifier, external: true }
  }

  // A `turbopack.rules` loader chain owns this specifier (`?query` and all):
  // import the module its output was materialized to. The seam answers a bare
  // `undefined` when nothing is configured, so the common path stays sync.
  const pendingRuleModule = getAssetExtensions().loaderRuleModule(
    specifier,
    importer && !importer.startsWith('<') ? importer : file,
  )
  const ruleModule = pendingRuleModule === undefined ? undefined : await pendingRuleModule
  if (ruleModule) return { path: pathToFileHref(ruleModule), external: true }

  const { sourcePath, hash } = splitHash(specifier)

  const compatAlias =
    pagesCompatSourceAlias(config, specifier, importer, options) ?? options.aliases[specifier]
  if (compatAlias) {
    if (kind === 'require-call' && path.isAbsolute(compatAlias)) {
      return { path: serverRequireAlias(specifier, compatAlias, options) }
    }
    // A compat alias pointing at a 'use client' file needs the SAME stub-and-match treatment as any
    // other local client component: the render tree walk recognizes a client boundary by a
    // `[clientReferenceSymbol]` tag on the component object it actually rendered, matched by id
    // against `markClientReferences`' own load of the file. Returning the raw file directly imports a
    // THIRD, untagged instance, so the component never gets its hydration island.
    if (
      path.isAbsolute(compatAlias) &&
      options.stubClientImports &&
      !isCssFile(compatAlias) &&
      (await fileHasUseClientDirective(compatAlias))
    ) {
      const stub = await clientReferencePath(config, compatAlias)
      await writeClientReferenceModule(
        stub,
        compatAlias,
        await clientReferenceExportNames(config, compatAlias),
      )
      return { path: pathToFileHref(stub), external: true }
    }
    return {
      path: path.isAbsolute(compatAlias) ? pathToFileHref(compatAlias) : compatAlias,
      external: true,
    }
  }

  const externalBundle = externalBundles.get(sourcePath)
  // A miss here is a specifier the pre-compile scan could not have seen (its importer was inlined).
  // Note it and fall through to the bare-specifier path for THIS compile; the caller vendors it off
  // the build slot and compiles once more with the map filled in.
  if (externalBundle === undefined) {
    noteLateExternalPackage(sourcePath, config, file, importer, options, externalBundles)
  }
  if (externalBundle && kind === 'require-call') {
    const required = resolvePackageSpecifier(
      config.root,
      file,
      sourcePath,
      serverBundleRequireConditions(options.conditionTarget),
    )
    if (required) return { path: `${required}${hash}`, external: true }
  }
  if (externalBundle) return { path: `${externalBundle}${hash}`, external: true }

  const clientReferenceStubPath = clientReferenceSpecifiers.get(sourcePath)
  if (clientReferenceStubPath)
    return { path: `${pathToFileHref(clientReferenceStubPath)}${hash}`, external: true }

  if (
    sourcePath === './preact' &&
    path.resolve(importer) === new URL('../compat/react/client.ts', import.meta.url).pathname
  ) {
    return {
      path: pathToFileHref(new URL('../compat/react/preact.ts', import.meta.url).pathname),
      external: true,
    }
  }

  if (
    sourcePath === '../client/errors/primitive-throw' &&
    path.resolve(importer) === new URL('../compat/react/preact.ts', import.meta.url).pathname
  ) {
    return {
      path: pathToFileHref(
        new URL('../compat/client/errors/primitive-throw.ts', import.meta.url).pathname,
      ),
      external: true,
    }
  }

  const resolved = resolveImport(
    config.root,
    importer && !importer.startsWith('<') ? importer : file,
    sourcePath,
  )
  // A relative specifier that resolved names first-party source next to its importer, so compile it
  // through the normal pipeline even outside workspaceRoot (compat's own runtime files live inside
  // pnext's package, not the app's workspace). A bare specifier resolving outside workspaceRoot is a
  // package meant to stay external, untouched.
  const isLocalSourceSpecifier = sourcePath.startsWith('.') || path.isAbsolute(sourcePath)
  if (!resolved || (!isLocalSourceSpecifier && !isInside(config.workspaceRoot, resolved))) {
    const resolvedExternalLoad = resolveExternalLoadTarget({
      root: config.root,
      fromFile: file,
      specifier: sourcePath,
      target: options.externalLoadTarget,
    })
    if (resolvedExternalLoad && (await externalLoadNeedsFacade(resolvedExternalLoad))) {
      return {
        path: resolvedExternalLoad,
        namespace: externalLoadNamespaces.module,
      }
    }
    const externalTarget =
      resolvedExternalLoad ?? externalPackageImportTarget(config.root, file, sourcePath)
    if (externalTarget) return { path: `${pathToFileHref(externalTarget)}${hash}`, external: true }
    if (options.rewriteExternalServerImports) {
      return { path: runtimeServerImportTarget(specifier), external: true }
    }
    return {
      path: `${offLayerPackageTarget(config, file, sourcePath, kind, options)}${hash}`,
      external: true,
    }
  }
  // A configured `resolveExtensions` order can make an EXTENSIONLESS specifier
  // land on an asset (`import img from './image'` -> image.png). The asset
  // claims above (and serverAssetPlugin's) key on the SPECIFIER, so they miss
  // those; re-check the resolved path or the compile pass hands a .png to
  // esbuild. A loader rule for the extension still wins, as everywhere else.
  if (
    isServerIgnoredAssetSpecifier(resolved) &&
    !isServerIgnoredAssetSpecifier(sourcePath) &&
    // Css keeps its copy-through compile, exactly as the specifier-keyed path does.
    !isCssFile(resolved) &&
    !getAssetExtensions().hasLoaderRuleFor(resolved)
  ) {
    const stub = await assetStubModule(config, resolved, devModuleProfile(options))
    return { path: pathToFileHref(stub), external: true }
  }
  if (
    options.stubClientImports &&
    !isCssFile(resolved) &&
    (await fileHasUseClientDirective(resolved))
  ) {
    const stub = await clientReferencePath(config, resolved)
    await writeClientReferenceModule(
      stub,
      resolved,
      await clientReferenceExportNames(config, resolved),
    )
    return { path: `${pathToFileHref(stub)}${hash}`, external: true }
  }
  // A `require()` of an ES module cannot take the compiled-path rewrite: the artifact is ESM, and
  // requiring one throws the moment it is not synchronously evaluable. Let esbuild bundle it and do
  // the interop, exactly as the alias branch above already does for a require-call. Under an
  // npm-layout install this is the common case - node_modules is INSIDE workspaceRoot, so a
  // package's own ESM file counts as first-party source here.
  if (kind === 'require-call' && isEsmModuleFile(resolved)) return { path: resolved }
  const importerFile = importer && !importer.startsWith('<') ? path.resolve(importer) : ''
  // `importerFile !== file` keeps this to imports the write pass misses: the entry's OWN local
  // imports are already walked by writeDevModuleUncached, so another importer means esbuild INLINED
  // that module here and nobody compiles its relative siblings. It can never also key on the importer
  // being out-of-workspace - under an npm-layout install pnext's runtime files live in the app's
  // node_modules, and the sibling was then silently never written. Recompiling is not a risk:
  // writeDevModule returns an already-written output as-is, so island identity survives navigation.
  const bundledCompatImporter =
    isLocalSourceSpecifier && importerFile !== '' && importerFile !== path.resolve(file)
  if (bundledCompatImporter) {
    // Compile it here, keeping the same compiled-path rewrite so the module stays a single instance -
    // pointing at the raw source instead would load a SECOND copy of the compat runtime graph and split its
    // module state. writeDevModule dedupes in-flight builds per artifact path, so a module reached from
    // several bundled importers is compiled once.
    await writeDevModule(config, resolved, visited, options)
  }
  return {
    path: `${pathToFileHref(await devModulePath(config, resolved, options))}${hash}`,
    external: true,
  }
}

/**
 * THE LAYER RULE. An artifact whose imports the dev PROCESS resolves - anything not rewritten to a
 * runtime server target - must not carry a bare package specifier, because the process runs under
 * `--conditions=react-server` and the client-SSR (and pages-SSR) layers are not that layer: `react`
 * resolves to React 18's `react.shared-subset`, which throws on import, and a package with a
 * `react-server` export condition hands back its RSC entry.
 *
 * Vendoring is the primary answer and has already run for everything eligible (it also rewrites the
 * package's OWN `react` to this layer's shim). This is the floor beneath it, for the specifiers
 * vendoring declines - a `serverExternalPackages` opt-out, a core app with react compat off: resolve
 * the specifier HERE, under this layer's own conditions, and emit that absolute path. Costs nothing
 * at run time and adds no bytes - it is the same file, named instead of re-resolved.
 *
 * A specifier that resolves under NO condition set is left bare: it is unresolvable from this
 * importer, so the run time reports a resolve error rather than the wrong layer's module.
 */
function offLayerPackageTarget(
  config: ResolvedConfig,
  file: string,
  specifier: string,
  kind: string,
  options: DevModuleOptions,
) {
  if (!isPackageSpecifier(specifier)) return specifier
  const isRequire = kind === 'require-call'
  const resolved =
    resolvePackageSpecifier(
      config.root,
      file,
      specifier,
      isRequire
        ? serverBundleRequireConditions(options.conditionTarget)
        : serverBundleConditions(options.conditionTarget),
    ) ??
    resolvePackageSpecifier(
      config.root,
      file,
      specifier,
      isRequire
        ? serverBundleConditions(options.conditionTarget)
        : serverBundleRequireConditions(options.conditionTarget),
    )
  if (!resolved) return specifier
  // `require()` takes a path; only an ESM import takes a file href.
  return isRequire ? resolved : pathToFileHref(resolved)
}

function serverRequireAlias(specifier: string, alias: string, options: DevModuleOptions) {
  if (options.conditionTarget === 'client') return alias
  if (specifier === 'next/navigation' && alias.endsWith(`${path.sep}navigation.ts`)) {
    return path.join(path.dirname(alias), 'navigation.cjs')
  }
  if (specifier === 'next/router' && alias.endsWith(`${path.sep}router.ts`)) {
    return path.join(path.dirname(alias), 'router.cjs')
  }
  return alias
}

function registerExternalLoadHandlers(
  build: import('esbuild').PluginBuild,
  config: ResolvedConfig,
  options: DevModuleOptions,
  namespace: string,
) {
  build.onResolve({ filter: /.*/, namespace }, args => {
    const { sourcePath } = splitHash(args.path)
    const importer = args.importer.startsWith(`${namespace}:`)
      ? args.importer.slice(namespace.length + 1)
      : args.importer
    const compatAlias = options.aliases[sourcePath]
    if (compatAlias) {
      return {
        path: path.isAbsolute(compatAlias) ? pathToFileHref(compatAlias) : compatAlias,
        external: true,
      }
    }
    const target = resolveExternalLoadTarget({
      root: config.root,
      fromFile: importer,
      specifier: sourcePath,
      target: options.externalLoadTarget,
    })
    if (target) return { path: target, namespace }
    if (sourcePath.startsWith('.') || path.isAbsolute(sourcePath)) {
      return { path: path.resolve(path.dirname(importer), sourcePath), namespace }
    }
    return { path: args.path, external: true }
  })
  build.onLoad({ filter: /.*/, namespace }, async args => ({
    contents: rewriteExternalLoadSpecifiers(await readText(args.path), args.path, config, options),
    loader: esbuildLoader(args.path),
    resolveDir: path.dirname(args.path),
  }))
}

function rewriteExternalLoadSpecifiers(
  source: string,
  file: string,
  config: ResolvedConfig,
  options: DevModuleOptions,
) {
  // Folded onto the module record (PERF-REWRITES #28); side-effect imports keep
  // resolving through the host, as under the `from`-anchored regex.
  return rewriteSpecifierLiterals(source, file, (specifier, kind) => {
    if (kind === 'side-effect' || !specifier.startsWith('#')) return undefined
    const target = resolveExternalLoadTarget({
      root: config.root,
      fromFile: file,
      specifier,
      target: options.externalLoadTarget,
    })
    return target ? JSON.stringify(target) : undefined
  })
}

async function externalLoadNeedsFacade(file: string) {
  const source = await readText(file).catch(() => '')
  return /\bfrom\s*['"]#|\b(?:import|require)\s*\(\s*['"]#/.test(source)
}

function addExtensionlessDynamicImportGlobAliases(source: string) {
  if (!source.includes('__glob({')) return source
  const lines = source.split('\n')
  const next: string[] = []
  let inGlob = false
  const keys = new Set<string>()

  for (const line of lines) {
    if (line.includes('__glob({')) {
      inGlob = true
      keys.clear()
    }
    if (inGlob) {
      const key = globKey(line)
      if (key) keys.add(key)
    }
    next.push(line)
    if (inGlob) {
      const aliases = globAliases(line, keys)
      if (aliases.length > 0) {
        if (!line.endsWith(',')) next[next.length - 1] = `${line},`
        const value = line.replace(/^(\s*)"[^"]+":\s*/, '')
        const normalizedValue = value.endsWith(',') ? value.slice(0, -1) : value
        for (const alias of aliases) {
          keys.add(alias)
          next.push(`${line.match(/^\s*/)?.[0] ?? ''}${JSON.stringify(alias)}: ${normalizedValue},`)
        }
      }
    }
    if (inGlob && line.trim() === '});') {
      const previous = next[next.length - 2]
      if (previous?.endsWith(',')) next[next.length - 2] = previous.slice(0, -1)
      inGlob = false
    }
  }

  return next.join('\n')
}

function globKey(line: string) {
  return /^\s*"([^"]+)":\s*/.exec(line)?.[1]
}

function globAliases(line: string, existing: Set<string>) {
  const key = globKey(line)
  if (!key) return []
  const extension = path.extname(key)
  if (!extensionlessDynamicImportExtensions.has(extension)) return []
  const aliases = [key.slice(0, -extension.length)]
  const indexSuffix = `/index${extension}`
  if (key.endsWith(indexSuffix)) aliases.push(key.slice(0, -indexSuffix.length))
  return aliases.filter(alias => alias && !existing.has(alias))
}

async function externalBundleSpecifiers(
  source: string,
  config: ResolvedConfig,
  file: string,
  options: DevModuleOptions,
) {
  const bundles = new Map<string, string>()
  if (!options.bundleExternalPackages) return bundles

  const candidates = [
    ...new Set(importSpecifiers(source, file).map(specifier => splitHash(specifier).sourcePath)),
  ]
    .filter(specifier => !isServerIgnoredAssetSpecifier(specifier))
    .filter(specifier => shouldBundleExternalPackage(specifier, config, file, options))
  await Promise.all(
    candidates.map(async specifier => {
      bundles.set(
        specifier,
        await externalServerPackageHref(
          config,
          specifier,
          options.profile === 'client' ? 'client' : 'server',
          path.dirname(file),
          options.conditionTarget,
        ),
      )
    }),
  )
  return bundles
}

// Specifiers one compile asked for and the pre-compile scan had not vendored, keyed on that compile's
// own `externalBundles` map - already threaded everywhere they are recorded and drained, so nothing
// new rides through the resolve chain. Value is the importer the specifier resolves from.
const lateExternalPackages = new WeakMap<Map<string, string>, Map<string, string>>()

/**
 * Record a package specifier `externalBundleSpecifiers` never saw. That scan reads the compiled
 * module's OWN source, so a specifier reaching this build from a module esbuild INLINED instead (a
 * require()d ESM sibling, a bundled compat importer) is missing from the map, and left alone it
 * survives verbatim into the artifact - where Bun resolves it from the real node_modules under the
 * server process's own `react-server` condition, and a client-only subtree (MUI -> emotion -> react)
 * reaches React 18's shared-subset entry and throws.
 *
 * Synchronous, and deliberately so. This runs inside esbuild's onResolve, which holds a build slot:
 * awaiting a vendor bundle here parks one of the few slots for however long that build takes and
 * heads off every queued module compile behind it. Nothing on this path may await a vendor build, a
 * module href, or a drain - `vendorLateExternalPackages` does the waiting, between compiles, with no
 * slot held.
 */
function noteLateExternalPackage(
  specifier: string,
  config: ResolvedConfig,
  file: string,
  importer: string,
  options: DevModuleOptions,
  externalBundles: Map<string, string>,
) {
  if (!options.bundleExternalPackages) return
  if (isServerIgnoredAssetSpecifier(specifier)) return
  const fromFile =
    importer && !importer.startsWith('<') && path.isAbsolute(importer) ? importer : file
  if (!shouldBundleExternalPackage(specifier, config, fromFile, options)) return
  let pending = lateExternalPackages.get(externalBundles)
  if (!pending) {
    pending = new Map<string, string>()
    lateExternalPackages.set(externalBundles, pending)
  }
  pending.set(specifier, fromFile)
}

/**
 * Vendor what the compile just recorded and fold it into its map, so recompiling rewrites those
 * specifiers. False when there was nothing to do, which is the overwhelming majority of modules.
 *
 * Failures propagate, exactly as they do from the pre-compile scan: the only other outcome is
 * emitting the bare specifier, which is the runtime `react-server` resolution this seam exists to
 * prevent - so a swallowed vendor error would silently reproduce the bug it is fixing.
 */
async function vendorLateExternalPackages(
  config: ResolvedConfig,
  options: DevModuleOptions,
  externalBundles: Map<string, string>,
) {
  const pending = lateExternalPackages.get(externalBundles)
  if (!pending || pending.size === 0) return false
  lateExternalPackages.delete(externalBundles)
  await Promise.all(
    [...pending].map(async ([specifier, fromFile]) => {
      externalBundles.set(
        specifier,
        await externalServerPackageHref(
          config,
          specifier,
          options.profile === 'client' ? 'client' : 'server',
          path.dirname(fromFile),
          options.conditionTarget,
        ),
      )
    }),
  )
  return true
}

function shouldBundleExternalPackage(
  specifier: string,
  config: ResolvedConfig,
  file: string,
  options: DevModuleOptions,
) {
  if (options.aliases[specifier]) return false
  if (specifier === 'server-only') return false
  if (!isPackageSpecifier(specifier)) return false
  const resolved = resolveImport(config.root, file, specifier)
  const inWorkspace = resolved !== undefined && isInside(config.workspaceRoot, resolved)
  // transpilePackages force-bundle; serverExternalPackages force-external (never bundled). A
  // transpiled package that resolves INSIDE the workspace is first-party source, not a registry
  // copy: it belongs to the batched module pipeline, which compiles it per file instead of
  // re-bundling its whole graph once per demanded subpath. Named imports survive that boundary
  // because CommonJS deps are now externalized or faceted rather than inlined. "Vendor" is registry
  // node_modules only.
  const packageName = packageNameOfSpecifier(specifier)
  if (packageName) {
    const policy = getExternalPackagePolicy()
    if (policy.transpile(packageName)) return !inWorkspace
    if (policy.external(packageName)) return false
  }
  return !inWorkspace
}

function clientSsrAliases(config: ResolvedConfig) {
  return {
    ...coreAliases(config, 'client'),
    ...getImportAliasExtensions().clientSsrAliases(config),
  }
}

/** Absolute files of this module's dynamic(ssr:false) targets — the dev split points. */
function deferredDynamicTargetFiles(source: string, config: ResolvedConfig, file: string) {
  const specifiers = deferredDynamicImportSpecifiers(source, file)
  if (specifiers.size === 0) return undefined
  const files = new Set<string>()
  for (const specifier of specifiers) {
    const resolved = resolveLocalImport(config, file, specifier)
    if (resolved) files.add(path.resolve(resolved))
  }
  return files.size > 0 ? files : undefined
}

function localImportTargets(
  source: string,
  config: ResolvedConfig,
  file: string,
  aliases: AliasMap,
) {
  const targets: { target: string; isLocalSource: boolean }[] = []
  for (const specifier of importSpecifiers(source, file)) {
    // Compat-aliased specifiers (next/server etc.) are rewritten at build
    // time; never resolve them locally — inside a workspace that ships a real
    // `next` package they would drag its whole module graph into the recursion.
    const { sourcePath } = splitHash(specifier)
    if (aliases[specifier] || aliases[sourcePath]) continue
    // Non-css ignored assets (scss, fonts, images) are stubbed at build time;
    // compiling them as modules would fail the import scan. Css keeps its
    // copy-through so compiled css module paths stay importable.
    if (isServerIgnoredAssetSpecifier(sourcePath) && !isCssFile(sourcePath)) continue
    const resolved = resolveImport(config.root, file, sourcePath)
    // `resolveExtensions` can land an extensionless specifier on an asset
    // (`import img from './image'` -> image.png), which the specifier check
    // above misses — compiling the image bytes as a module fails the build.
    if (resolved && isServerIgnoredAssetSpecifier(resolved) && !isCssFile(resolved)) continue
    // A loader-rule source is not a module either: its chain output is
    // materialized by the resolvers, so compiling the raw file would only fail
    // the parse (`*.txt`, `*.test-file.ts`, …).
    if (resolved && getAssetExtensions().hasLoaderRuleFor(resolved)) continue
    // Our own emitted artifacts (a tree-shake facade the source above was just rewritten to point at, a
    // vendor bundle) are already compiled modules Bun imports directly. Feeding one back through the
    // pipeline compiles it a SECOND time, splitting module identity and pulling artifact names into the
    // source graph, where every boot's fresh names look like edits.
    if (resolved && !isInside(config.outPath, resolved)) {
      targets.push({
        target: resolved,
        isLocalSource: sourcePath.startsWith('.') || path.isAbsolute(sourcePath),
      })
    }
  }

  return targets
}

async function writeClientReferenceModules(
  source: string,
  config: ResolvedConfig,
  file: string,
  aliases: AliasMap,
) {
  const references = new Map<string, { file: string; exports: Set<string> }>()

  for (const specifier of importSpecifiers(source, file)) {
    const { sourcePath } = splitHash(specifier)
    if (aliases[specifier] || aliases[sourcePath]) continue
    const resolved = resolveImport(config.root, file, sourcePath)
    if (!resolved || !isInside(config.workspaceRoot, resolved) || isCssFile(resolved)) continue
    if (!(await fileHasUseClientDirective(resolved))) continue

    const entry = references.get(sourcePath) ?? { file: resolved, exports: new Set<string>() }
    for (const exportName of await clientReferenceExportNames(config, resolved)) {
      entry.exports.add(exportName)
    }
    references.set(sourcePath, entry)
  }

  const specifiers = new Map<string, string>()
  const files = new Set<string>()
  await Promise.all(
    [...references.entries()].map(async ([specifier, reference]) => {
      const stub = await clientReferencePath(config, reference.file)
      await writeClientReferenceModule(stub, reference.file, [...reference.exports].sort())
      specifiers.set(specifier, stub)
      files.add(path.resolve(reference.file))
      noteCompiledClientReference(reference.file)
    }),
  )

  return { specifiers, files }
}

async function writeClientReferenceModule(file: string, sourceFile: string, exportNames: string[]) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeCompiledFile(file, clientReferenceModuleSource(sourceFile, exportNames))
}

async function fileHasUseClientDirective(file: string) {
  return hasUseClientDirective(await readText(file))
}

function splitHash(specifier: string) {
  // A leading '#' is a subpath-import/tsconfig-paths specifier (e.g. '#/lib/x'),
  // not a fragment separator.
  const index = specifier.startsWith('#') ? specifier.indexOf('#', 1) : specifier.indexOf('#')
  return index === -1
    ? { sourcePath: specifier, hash: '' }
    : { sourcePath: specifier.slice(0, index), hash: specifier.slice(index) }
}

function isInside(root: string, file: string) {
  const relative = path.relative(root, file)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function devModuleProfile(options: DevModuleOptions) {
  if (options.profile === 'client') {
    // Pages-router SSR layers ('pages'/'pages-edge') resolve package exports
    // with different conditions than the app client layer — keep their
    // compiled modules (and baked-in vendor hrefs) in separate cache dirs.
    return options.conditionTarget === 'client'
      ? options.profile
      : `client-${options.conditionTarget}`
  }
  const externalTarget =
    options.externalLoadTarget === externalLoadTargetForConditionTarget(options.conditionTarget)
      ? ''
      : `-external-${options.externalLoadTarget}`
  return `${options.profile}-${options.conditionTarget}${externalTarget}${options.reactServerLayer ? '-react-server' : ''}`
}

// Compiled artifacts are named `<source name>.<graph hash>.<ext>` under a per-profile directory that
// mirrors the source tree. The hash covers the module's whole source graph, so an edit renames the edited
// file and its dependents and nothing else - a stale artifact is simply never asked for.
function devServerPath(config: ResolvedConfig, file: string, profile: string, hash: string) {
  const key = devServerCacheKey(config, file)
  const ext = path.extname(key) || '.js'
  // A compiled `.json` module is JS (esbuild's json loader wraps it in exports),
  // so it must not keep the `.json` name — the runtime would parse the artifact
  // as JSON. Keeping the source name in front of `.js` keeps it collision-free.
  const outExt = ext === '.json' ? '.json.js' : ext
  return path.join(
    cacheRoot(config.outPath),
    profile === 'server' ? 'modules' : `modules-${profile}`,
    `${key.slice(0, key.length - ext.length)}.${hash}${outExt}`,
  )
}

/** The staged directory mirroring `dir` for `profile` (asset links live there). */
function devServerDir(config: ResolvedConfig, dir: string, profile: string) {
  return path.dirname(devServerPath(config, path.join(dir, '__pnext_context__.js'), profile, 'dir'))
}

// A module compiled standalone (not merely as a transitive import of an
// in-workspace file) can live OUTSIDE config.workspaceRoot: a compat runtime
// file (e.g. `next/form` -> src/compat/next/form.tsx, shipped inside pnext's
// own package) reached directly as a route's client-reference entry, not
// through any in-workspace importer. `path.relative(workspaceRoot, file)` for
// such a file is riddled with `..` segments walking up past unrelated
// ancestors; joining that under outPath silently produces a bogus path (and
// the file's own untouched relative imports then resolve from the wrong
// location once written there). Key those out-of-workspace files by a stable
// hash of their absolute path instead of a relative path.
function devServerCacheKey(config: ResolvedConfig, file: string) {
  if (isInside(config.workspaceRoot, file)) return path.relative(config.workspaceRoot, file)
  // Hash the portable identity, not the absolute path: a deployed build runs
  // these same files from a different root and must find the same artifact.
  const hash = createHash('sha256')
    .update(devSourceIdentity(file, config.workspaceRoot))
    .digest('hex')
    .slice(0, 16)
  return path.join('external', `${hash}${path.extname(file) || '.js'}`)
}

// Bundle names memoized per (route, entries) so a warm request re-derives
// nothing; any save clears the whole map (see clearDevRouteBundleKeys).
const routeBundleKeys = new Map<string, Promise<string>>()

/** A save may rename any route bundle: drop every memoized name. */
export function clearDevRouteBundleKeys() {
  routeBundleKeys.clear()
  clientReferenceBundleKeys.clear()
}

// The route bundle inlines the route file and its layouts, so its name carries
// every source graph it bundles.
function devRouteBundlePath(
  config: ResolvedConfig,
  route: RouteManifestEntry,
  layoutFiles: string[],
) {
  const entries = uniqueFiles([route.file, ...layoutFiles])
  const memoKey = `${route.id}\0${entries.join('\0')}`
  const memoized = routeBundleKeys.get(memoKey)
  if (memoized) return memoized
  const next = computeDevRouteBundlePath(config, route, entries).catch(error => {
    routeBundleKeys.delete(memoKey)
    throw error
  })
  routeBundleKeys.set(memoKey, next)
  return next
}

async function computeDevRouteBundlePath(
  config: ResolvedConfig,
  route: RouteManifestEntry,
  entries: string[],
) {
  const graph = devModuleGraph(config)
  const cached = await cachedRouteBundlePath(config, route.id, graph.graphKey, entries)
  if (cached) return cached
  const hashes = await Promise.all(entries.map(file => graph.graphHash(file)))
  const hash = createHash('sha256').update(hashes.join('\0')).digest('hex').slice(0, 16)
  const bundle = path.join(cacheRoot(config.outPath), 'routes', `${route.id}.${hash}.mjs`)
  saveRouteBundlePath(
    config,
    route.id,
    graph.graphKey,
    entries,
    bundle,
    await graph.graphSources(entries),
  )
  return bundle
}

async function clientReferencePath(config: ResolvedConfig, file: string) {
  return `${await devModulePathFor(config, file, 'compat')}.client-reference.ts`
}

function isCssFile(file: string) {
  return file.endsWith('.css')
}

function isStaticImageFile(file: string) {
  return /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp)(?:$|[?#])/.test(file)
}

const serverIgnoredAssetFilter =
  /\.(?:css|scss|sass|woff2?|ttf|otf|eot|png|jpe?g|gif|webp|avif|svg|ico|bmp)(?:$|[?#])/

function isServerIgnoredAssetSpecifier(specifier: string) {
  return serverIgnoredAssetFilter.test(specifier)
}

function esbuildLoader(file: string) {
  if (file.endsWith('.tsx')) return 'tsx'
  if (file.endsWith('.ts')) return 'ts'
  // `import data from './x.json'` is an ordinary module edge, so the walk
  // reaches the data file itself; parsing it as JS fails on the first key.
  if (file.endsWith('.json')) return 'json'
  // App-convention .js/.jsx/.mjs modules may contain JSX (jsxImportSource is
  // preact via the build config), so parse them with the jsx loader. .tsx/.ts
  // keep their dedicated loaders above for the fast path.
  return 'jsx'
}

function isPackageSpecifier(specifier: string) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:'))
    return false
  if (specifier.startsWith('#')) return false
  if (specifier.startsWith('node:')) return false
  if (specifier.includes(':')) return false
  const packageName = packageNameFromSpecifier(specifier)
  return Boolean(packageName && !builtinModules.includes(packageName))
}

function isBuiltinSpecifier(specifier: string) {
  if (specifier.startsWith('node:')) return true
  const packageName = packageNameFromSpecifier(specifier)
  return Boolean(packageName && builtinModules.includes(packageName))
}

function packageNameFromSpecifier(specifier: string) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function resolveLocalImport(config: ResolvedConfig, fromFile: string, specifier: string) {
  if (path.isAbsolute(specifier)) return existsSync(specifier) ? specifier : undefined
  return resolveImport(config.root, fromFile, specifier)
}

async function linkAssetContext(config: ResolvedConfig, file: string, profile: string) {
  if (!isInside(config.root, file)) return
  const sourceDirs = ancestorDirs(config.root, path.dirname(file))
  await Promise.all(
    sourceDirs.map(sourceDir => linkDirectoryAssetContext(config, sourceDir, profile)),
  )
}

function ancestorDirs(root: string, dir: string) {
  const dirs = [root]
  const relative = path.relative(root, dir)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return dirs
  let current = root
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    dirs.push(current)
  }
  return dirs
}

async function linkDirectoryAssetContext(
  config: ResolvedConfig,
  sourceDir: string,
  profile: string,
) {
  let entries: Dirent<string>[]
  try {
    entries = await readdir(sourceDir, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return
  }
  const targetDir = devServerDir(config, sourceDir, profile)
  await Promise.all(
    entries.map(async entry => {
      if (!assetContextEntry(config, sourceDir, entry.name, entry.isDirectory())) return
      const source = path.join(sourceDir, entry.name)
      const target = path.join(targetDir, entry.name)
      // Root-level sibling asset directories are mirrored, not symlinked wholesale: a `dir` symlink
      // would make every path beneath it - including code modules that must be compiled through the
      // alias transform - resolve straight back to raw source, shadowing the staged compile.
      // Mirroring links only non-code leaf files.
      if (entry.isDirectory()) {
        await mirrorAssetDirectory(source, target)
        return
      }
      if (existsSync(target)) return
      await mkdir(path.dirname(target), { recursive: true })
      // A package manifest linked whole makes the staged mirror a RESOLVABLE package: a bare
      // `pkg/sub` import from a compiled artifact finds this copy first and fails on an `exports`
      // subpath that only exists in the real tree. Stage the one field the mirror needs (`type`,
      // which decides how a compiled `.js` sibling parses) and none of the resolution map.
      if (entry.name === 'package.json') {
        await writeText(target, await stagedManifestSource(source))
        return
      }
      await linkOrCopyAsset(source, target)
    }),
  )
}

async function stagedManifestSource(file: string) {
  try {
    const manifest = JSON.parse(await readText(file)) as { type?: unknown }
    return JSON.stringify(typeof manifest.type === 'string' ? { type: manifest.type } : {})
  } catch {
    return '{}'
  }
}

// Recursively stage an asset directory: link non-code leaf files and recurse
// into subdirectories, but never link code files — those compile through the
// module graph into their own staged output and must not be shadowed by a raw
// symlink.
/** Stage an asset, repairing a dangling link left by cache relocation. */
async function linkOrCopyAsset(source: string, target: string) {
  const resolvedSource = path.resolve(source)
  // Concurrent walkers keep a repaired link and remove only the stale target.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await symlink(source, target, 'file')
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') break
    }
    try {
      const linked = await readlink(target)
      if (path.resolve(path.dirname(target), linked) === resolvedSource) return
      await rm(target, { force: true })
    } catch {
      // It disappeared between EEXIST and inspection; retry the link.
      if (existsSync(target)) return
    }
  }
  if (!existsSync(target)) await copyFile(source, target)
}

async function mirrorAssetDirectory(sourceDir: string, targetDir: string) {
  let entries: Dirent<string>[]
  try {
    entries = await readdir(sourceDir, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return
  }
  await Promise.all(
    entries.map(async entry => {
      if (entry.name.startsWith('.')) return
      const source = path.join(sourceDir, entry.name)
      const target = path.join(targetDir, entry.name)
      if (entry.isDirectory()) {
        await mirrorAssetDirectory(source, target)
        return
      }
      if (isCodeFile(entry.name)) return
      if (existsSync(target)) return
      await mkdir(path.dirname(target), { recursive: true })
      await linkOrCopyAsset(source, target)
    }),
  )
}

function assetContextEntry(
  config: ResolvedConfig,
  sourceDir: string,
  name: string,
  directory: boolean,
) {
  if (name.startsWith('.')) return false
  if (!directory) return !isCodeFile(name)
  if (sourceDir !== config.root) return false
  return !new Set([
    'app',
    'src',
    'pages',
    'public',
    'node_modules',
    path.basename(config.outRootPath),
  ]).has(name)
}

function isCodeFile(file: string) {
  if (/\.(?:tsx?|jsx?|mjs|cjs)$/.test(file)) return true
  // Extra loadable source extensions registered by compat (e.g. mdx/md) compile
  // through the module graph, so they must not be symlinked raw as asset
  // context — otherwise the raw markdown shadows the compiled staged module.
  const dot = file.lastIndexOf('.')
  if (dot < 0) return false
  return extraLoadableExtensions().includes(file.slice(dot + 1))
}

function resolveAssetPath(specifier: string, resolveDir: string) {
  const { sourcePath, hash } = splitHash(specifier)
  return `${path.isAbsolute(sourcePath) ? sourcePath : path.resolve(resolveDir, sourcePath)}${hash}`
}

async function staticImageModuleSource(config: ResolvedConfig, file: string) {
  const { sourcePath } = splitHash(file)
  const bytes = new Uint8Array(await Bun.file(sourcePath).arrayBuffer())
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
// media URL and export the URL string as default.
function coreStaticAssetModule(
  sourcePath: string,
  bytes: Uint8Array,
  emit: (relative: string, bytes: Uint8Array) => string,
): string {
  const ext = path.extname(sourcePath).toLowerCase() || '.bin'
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 8)
  const base = path.basename(sourcePath, path.extname(sourcePath)).replace(/[^A-Za-z0-9_-]+/g, '-')
  const relative = getAssetExtensions().staticAssetRelativePath({ sourcePath, hash, base, ext })
  const src = emit(relative, bytes)
  return `const src = ${JSON.stringify(src)};\nexport default src;\nexport { src };\n`
}

function uniqueFiles(files: string[]) {
  return [...new Set(files.map(file => path.resolve(file)).filter(file => existsSync(file)))]
}

async function profileDevImport<T>(label: string, task: () => Promise<T>) {
  if (!traceEnabled('server')) return task()
  const start = performance.now()
  try {
    return await task()
  } finally {
    console.log(`dev-import ${label} in ${formatDuration(performance.now() - start)}`)
  }
}
