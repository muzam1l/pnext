/**
 * Vendor package bundling: compiling a server module's node_modules externals into artifacts
 * loadable at request/build time. Covers the vendor artifact plan and cache-key scheme, the
 * content/link/share layers used to reuse compiled bytes across the RSC and client-compat
 * targets, preplan and native-Bun-loadable fast paths for packages that need no rewriting, the
 * plugin-driven esbuild bundling of a vendor group (and its CommonJS-export-recovery/native
 * fallback rounds), and the resolve-time plugins (external dependency, package-shape) that feed
 * those builds. The demand-scheduling pipeline itself lives in `./vendor`; the ESM loader - and
 * the alias/asset helpers this module reuses from it - lives in `./server`.
 */

import { builtinModules, createRequire } from 'node:module'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { copyFile, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Loader, Metafile, OnLoadResult, OnResolveResult, Plugin } from 'esbuild'
import { build } from '../utils/esbuild'
import {
  applyBundledSourceTransforms,
  getAssetExtensions,
  getBundlerExtensions,
  getCssExtensions,
  getImportAliasExtensions,
  serverDefineOptions,
  type ServerEsbuildPluginOptions,
} from '../extensions'
import { pathToFileHref, type CompatAliasTarget, type ResolvedConfig } from '../config'
import {
  cacheRoot,
  devArtifactUsable,
  devSourceIdentity,
  noteDevArtifactWritten,
} from './module-cache'
import { frameworkFingerprint } from './fingerprint'
import {
  getExternalPackagePolicy,
  isEsmModuleEntry,
  isEsmModuleFile,
  isPackageSubpathUnexported,
  resolveLinkedPackageSpecifier,
  resolveNestedPackageFromImporter,
  resolveVendorPackageSpecifier,
  clearVendorPackageResolutions,
  clearProvidedEntryResolutions,
  provideEntryResolution,
} from '../resolve/imports'
import { clearNodeModulesResolutionCache } from '../resolve/engine'
import { cachedExistsSync, clearNodeModulesFsCache } from '../utils/fs-cache'
import { traceEnabled } from '../utils/trace-flags'
import {
  clientReferenceExportNames,
  clientReferenceModuleSource,
  hasUseClientDirective,
} from '../client/reference-stub'
import { noteCompiledClientReference } from '../client/reference'
import { reactCompatEnabled } from '../render/hooks'
import { writeFileAtomic } from '../utils/fs'
import { formatDuration } from '../utils/verbose'
import {
  addCommonJsNamedExports,
  canonicalVendorCode,
  noteVendorContentId,
  vendorContentId,
  cjsEntryMayHaveNamedExports,
  cjsNamedExportFacade,
  heavyProfRow,
  clearVendorPipeline,
  copyBrowserReadyEsmDist,
  dropVendorBundle,
  dropVendorGroup,
  nextVendorTraceSeq,
  outsideVendorSlot,
  trackPreplanBuild,
  rewriteEmittedRefs,
  vendorBundle,
  vendorBundleMemHit,
  vendorTraceEnabled,
  vendorTraceRow,
  verifyVendorArtifact,
  type VendorBuildPlan,
  type VendorGroupMember,
  type VendorGroupPlan,
} from './vendor'
import {
  aliasSpecifierFilter,
  coreAliases,
  firstAliasForSpecifier,
  hashBundleSpecifier,
  packageJsxLoaders,
  runtimeAliasBuildPlugin,
  serverAssetPlugin,
  serverBundleConditions,
  serverBundleRequireConditions,
  serverIgnoredAssetFilter,
  serverRequireAlias,
  vendorLoadsNatively,
  type ServerBundleTarget,
} from './loader'

const require = createRequire(import.meta.url)

export function clearServerRuntimeCaches() {
  clearVendorPipeline()
  clearVendorNativeCaches()
  vendorEntryResolutions.clear()
  canonicalVendorEntries.clear()
  nearestManifestDirs.clear()
  clearVendorPackageResolutions()
  vendorLayerRecords.clear()
  vendorSharedEntries.clear()
  vendorSharedLoaded.clear()
  vendorReuseVerdicts.clear()
  vendorReuseLoaded.clear()
  vendorReuseProbes.clear()
  vendorLayerProbeMemo.clear()
  // The marker memo tracks files under `.pnext`; a wipe takes them with it.
  esmDistPackages.clear()
  clearProvidedEntryResolutions()
  clearNodeModulesResolutionCache()
  clearNodeModulesFsCache()
}

export async function externalServerPackageHref(
  config: ResolvedConfig,
  specifier: string,
  target: CompatAliasTarget,
  resolveDir = config.root,
  conditionTarget: ServerBundleTarget = target,
  nested = false,
) {
  let plan = vendorBuildPlan(config, specifier, target, resolveDir, conditionTarget)
  const aliased = await crossLayerReusePlan(
    config,
    specifier,
    resolveDir,
    target,
    conditionTarget,
    plan,
  )
  if (aliased) plan = aliased
  if (vendorTraceEnabled()) {
    vendorTraceRow({
      kind: 'request',
      specifier,
      resolveDir,
      target,
      conditionTarget,
      memHit: vendorBundleMemHit(plan.key),
      atMs: performance.now(),
    })
  }
  let file = await vendorBundle(plan, nested)
  // A `pnext build` wiping the output directory under a running server
  // deletes vendor bundles; re-write instead of handing out a dead path.
  if (!cachedExistsSync(file) || !(await compiledModuleUsable(file))) {
    dropVendorBundle(plan.key, file)
    if (plan.group) dropVendorGroup(plan.group.key)
    file = await vendorBundle(plan, nested)
  }
  return pathToFileHref(file)
}

/**
 * Artifact identity: what the bundle is compiled FROM, never who asked. Keying on the importer's
 * directory (what `require.resolve` fell back to when a package publishes no `require` condition)
 * split one package into one build per importing directory.
 *
 * Every path in it is workspace-relative, never absolute — for the same reason the module graph
 * names artifacts that way (see `portableSourcePath`). This key names the file, and a deployed
 * function replays the same workspace from a different root: an absolute key misses the whole
 * shipped vendor cache and re-vendors onto a read-only filesystem.
 */
function vendorArtifactKey(
  config: ResolvedConfig,
  target: CompatAliasTarget,
  conditionTarget: ServerBundleTarget,
  source: string,
) {
  return `${vendorGeneration(config)}\0${vendorPortablePath(config, config.outPath)}\0${target}\0${conditionTarget}\0${source}`
}

/**
 * pnext's generation, in every name the vendor cache derives. A vendor bundle is pnext's OWN output
 * - its CJS interop, its aliases, its defines - so one generation's bundle must never be handed to
 * the next, exactly as the module cache already refuses one. The same holds for the verdict stores
 * below, which decide that a demand needs no build at all: a verdict is framework logic, and a
 * stale one routes today's demand onto yesterday's bytes.
 *
 * The fingerprint is content over pnext's shipped tree, memoized per process and recorded next to
 * the module cache, so an app whose framework did not move keeps every warm hit for free.
 */
const vendorGeneration = (config: ResolvedConfig) => frameworkFingerprint(cacheRoot(config.outPath))

const vendorPortablePath = (config: ResolvedConfig, file: string) =>
  devSourceIdentity(file, config.workspaceRoot)

function vendorArtifactFile(config: ResolvedConfig, key: string) {
  return path.join(config.outPath, 'cache', 'server', 'vendor', `${hashBundleSpecifier(key)}.mjs`)
}

/**
 * The file this specifier names - the artifact's identity. Resolved with `import` on top of the
 * layer's conditions because that is what esbuild adds for an ESM entry point: without it a package
 * publishing only an `import` condition resolves to nothing, and the key falls back to the
 * importer's directory - the duplicate-build shape this path exists to remove.
 */
function resolveVendorEntry(
  config: ResolvedConfig,
  specifier: string,
  resolveDir: string,
  conditionTarget: ServerBundleTarget,
) {
  // Every demand builds a plan before dedup can see it, so this resolve runs
  // once per DEMAND, not once per artifact — and the same specifier arrives
  // from hundreds of importers. The answer is pure in its inputs.
  const key = `${config.root}\0${conditionTarget}\0${resolveDir}\0${specifier}`
  if (vendorEntryResolutions.has(key)) return vendorEntryResolutions.get(key)
  const entry = canonicalVendorEntry(
    path.isAbsolute(specifier)
      ? path.resolve(specifier)
      : resolveVendorPackageSpecifier(
          config.root,
          path.join(resolveDir, 'pnext-resolve.ts'),
          specifier,
          [...serverBundleConditions(conditionTarget), 'import'],
        ),
  )
  vendorEntryResolutions.set(key, entry)
  return entry
}

function canonicalVendorEntry(entry: string | undefined) {
  if (!entry) return entry
  if (canonicalVendorEntries.has(entry)) return canonicalVendorEntries.get(entry)!
  let canonical = entry
  try {
    canonical = realpathSync.native(entry)
  } catch {
    // Keep the unresolved path when the file disappeared between resolution and canonicalization.
  }
  canonicalVendorEntries.set(entry, canonical)
  return canonical
}

const vendorEntryResolutions = new Map<string, string | undefined>()
const canonicalVendorEntries = new Map<string, string>()

function vendorBuildPlan(
  config: ResolvedConfig,
  specifier: string,
  target: CompatAliasTarget,
  resolveDir: string,
  conditionTarget: ServerBundleTarget,
): VendorBuildPlan {
  const entry = resolveVendorEntry(config, specifier, resolveDir, conditionTarget)
  // An unresolvable specifier has no artifact identity to key on; keep the old
  // importer-scoped key so the demand still compiles (and still dedups per dir).
  const key = vendorArtifactKey(
    config,
    target,
    conditionTarget,
    entry
      ? vendorPortablePath(config, entry)
      : `${vendorPortablePath(config, path.resolve(resolveDir))}\0${specifier}`,
  )
  const file = vendorArtifactFile(config, key)
  return {
    key,
    file,
    prepare: () =>
      prepareVendorArtifact(config, specifier, resolveDir, conditionTarget, file, target, entry),
    buildOne: nested =>
      writeExternalServerPackageBundle(
        config,
        specifier,
        target,
        resolveDir,
        file,
        conditionTarget,
        nested,
      ),
    group: entry
      ? vendorGroupPlan(config, { specifier, entry, file }, target, resolveDir, conditionTarget)
      : undefined,
  }
}

/**
 * A vendor artifact this process just wrote is trusted for the rest of the run.
 * Without the note, a cache folder that started without a marker (every cold
 * boot) distrusts what was just written, and `externalServerPackageHref`'s
 * liveness check rebuilds every bundle a second time.
 */
async function writeVendorArtifact(file: string, code: string) {
  const id = await publishVendorContent(file, code)
  if (id === undefined) {
    await writeFileAtomic(file, code)
    noteDevArtifactWritten(file)
  }
  return id
}

// --------------------------------------------------------------------------
// content-addressed artifacts and the cross-layer verdict
// --------------------------------------------------------------------------

// eslint-disable-next-line turbo/no-undeclared-env-vars
const vendorContentDisabled = () => process.env.PNEXT_VENDOR_CONTENT === '0'

function vendorContentFile(vendorDir: string, id: string) {
  return path.join(vendorDir, `${id}.content.mjs`)
}

/** Entries only: a chunk reaches its entry by relative path, so it stays put. */
async function publishVendorContent(file: string, code: string) {
  const vendorDir = path.dirname(file)
  if (vendorContentDisabled() || path.basename(vendorDir) !== 'vendor') return undefined
  const id = hashBundleSpecifier(canonicalVendorCode(code))
  const content = vendorContentFile(vendorDir, id)
  if (!cachedExistsSync(content)) await writeFileAtomic(content, code)
  noteDevArtifactWritten(content)
  await linkVendorArtifact(file, content)
  noteVendorContentId(file, id)
  noteDevArtifactWritten(file)
  return id
}

/** The layer-keyed path becomes an alias to the shared bytes. */
async function linkVendorArtifact(file: string, content: string) {
  await rm(file, { force: true }).catch(() => undefined)
  try {
    await symlink(path.basename(content), file)
  } catch {
    await copyFile(content, file)
  }
}

/** What one layer's build of an entry saw, for the cross-layer comparison. */
interface VendorLayerRecord {
  inputs: string
  externals: string
  blocked: boolean
  id: string
}

// Keyed by output path exactly as `vendorArtifactKey` is: a verdict holds for
// ONE app's conditions, aliases and defines, and several run in one process.
const vendorLayerRecords = new Map<string, Map<string, VendorLayerRecord>>()
/** Entries proven layer-independent -> the content id both layers resolve to. */
const vendorSharedEntries = new Map<string, Map<string, string>>()
const vendorSharedLoaded = new Set<string>()

function vendorSharedFor(config: ResolvedConfig) {
  let shared = vendorSharedEntries.get(config.outPath)
  if (!shared) {
    shared = new Map()
    vendorSharedEntries.set(config.outPath, shared)
  }
  return shared
}

/** Only these two layers were ever the duplicated half. */
function vendorLayerKey(target: CompatAliasTarget, conditionTarget: ServerBundleTarget) {
  if (target === 'server' && conditionTarget === 'server') return 'server'
  if (target === 'client' && conditionTarget === 'client') return 'client'
  return undefined
}

function vendorSharedFile(config: ResolvedConfig) {
  return vendorStoreFile(config, 'layer-shared')
}

/** A vendor verdict store, named for the generation whose logic produced it. */
function vendorStoreFile(config: ResolvedConfig, name: string) {
  return path.join(
    config.outPath,
    'cache',
    'server',
    'vendor',
    `${name}.${vendorGeneration(config)}.json`,
  )
}

/** Verdicts from earlier runs, so reuse lands on the first demand of this one. */
function loadVendorSharedEntries(config: ResolvedConfig) {
  if (vendorSharedLoaded.has(config.outPath)) return
  vendorSharedLoaded.add(config.outPath)
  try {
    const stored = JSON.parse(readFileSync(vendorSharedFile(config), 'utf8')) as Record<
      string,
      string
    >
    const shared = vendorSharedFor(config)
    for (const [entry, id] of Object.entries(stored)) shared.set(entry, id)
  } catch {
    // No verdicts yet; they are written as builds settle.
  }
}

function persistVendorSharedEntries(config: ResolvedConfig) {
  void writeFileAtomic(
    vendorSharedFile(config),
    JSON.stringify(Object.fromEntries(vendorSharedFor(config))),
  ).catch(() => undefined)
}

/** Offline verdict: externals compare as content ids, so this is a fixpoint. */
function recordVendorLayerBuild(
  config: ResolvedConfig,
  entry: string | undefined,
  target: CompatAliasTarget,
  conditionTarget: ServerBundleTarget,
  metafile: Metafile | undefined,
  code: string,
  id: string | undefined,
) {
  const layer = entry && id && metafile && vendorLayerKey(target, conditionTarget)
  if (!layer || !entry || !id || !metafile) return
  loadVendorSharedEntries(config)
  const externals = new Set<string>()
  let blocked = /['"]use (?:client|server|cache)['"]/.test(code)
  for (const meta of Object.values(metafile.inputs)) {
    for (const reference of meta.imports) {
      if (!reference.external) continue
      const target_ = reference.path.startsWith('file:') ? fileURLToPath(reference.path) : undefined
      // A shim outside the vendor tree is this layer's own alias target: the
      // artifact is layer-specific whatever else matches.
      if (target_ && path.basename(path.dirname(target_)) !== 'vendor') blocked = true
      externals.add(target_ ? (vendorContentId(target_) ?? target_) : reference.path)
    }
  }
  const record: VendorLayerRecord = {
    inputs: Object.keys(metafile.inputs).sort().join('\n'),
    externals: [...externals].sort().join('\n'),
    blocked,
    id,
  }
  const recordKey = `${config.outPath}\0${entry}`
  let byLayer = vendorLayerRecords.get(recordKey)
  if (!byLayer) {
    byLayer = new Map()
    vendorLayerRecords.set(recordKey, byLayer)
  }
  byLayer.set(layer, record)
  const server = byLayer.get('server')
  const client = byLayer.get('client')
  if (!server || !client || server.blocked || client.blocked) return
  if (server.inputs !== client.inputs || server.externals !== client.externals) return
  vendorSharedFor(config).set(entry, server.id)
  persistVendorSharedEntries(config)
}

/** A proven-shared entry's content file, or undefined to compile as usual. */
function reusableVendorContent(
  config: ResolvedConfig,
  entry: string | undefined,
  target: CompatAliasTarget,
  conditionTarget: ServerBundleTarget,
) {
  if (vendorContentDisabled() || !entry || !vendorLayerKey(target, conditionTarget))
    return undefined
  loadVendorSharedEntries(config)
  const id = vendorSharedFor(config).get(entry)
  if (!id) return undefined
  const content = vendorContentFile(path.join(config.outPath, 'cache', 'server', 'vendor'), id)
  return existsSync(content) ? content : undefined
}

// --------------------------------------------------------------------------
// pre-build cross-layer reuse verdict (PNEXT_VENDOR_REUSE=0 to disable)
// --------------------------------------------------------------------------

// eslint-disable-next-line turbo/no-undeclared-env-vars
const vendorReuseEnabled = () => process.env.PNEXT_VENDOR_REUSE !== '0'
// eslint-disable-next-line turbo/no-undeclared-env-vars
const vendorReuseExtEnabled = () => process.env.PNEXT_VENDOR_REUSE_EXT !== '0'

/** Alias targets that differ by layer (compat/aliases.ts); prefix-matches subpaths. */
const VENDOR_LAYER_ALIASES = new Set([
  'react',
  'react-dom',
  'next/cache',
  'next/navigation',
  'next/script',
  'next/server',
  'server-only',
  'client-only',
])

function isVendorLayerAlias(external: string) {
  return (
    VENDOR_LAYER_ALIASES.has(external) ||
    VENDOR_LAYER_ALIASES.has(external.split('/').slice(0, 2).join('/'))
  )
}

interface VendorReuseVerdict {
  stat: string
  conds: string
  reusable: boolean
  reason?: string
}

const vendorReuseVerdicts = new Map<string, Map<string, VendorReuseVerdict>>()
const vendorReuseLoaded = new Set<string>()
const vendorReuseProbes = new Map<string, Promise<boolean>>()

function vendorReuseFile(config: ResolvedConfig) {
  return vendorStoreFile(config, 'reuse-verdicts')
}

function vendorReuseFor(config: ResolvedConfig) {
  let verdicts = vendorReuseVerdicts.get(config.outPath)
  if (!verdicts) {
    verdicts = new Map()
    vendorReuseVerdicts.set(config.outPath, verdicts)
  }
  return verdicts
}

/** Verdicts persist per checkout: probes are paid once, restarts read the store. */
function loadVendorReuseVerdicts(config: ResolvedConfig) {
  if (vendorReuseLoaded.has(config.outPath)) return
  vendorReuseLoaded.add(config.outPath)
  try {
    const stored = JSON.parse(readFileSync(vendorReuseFile(config), 'utf8')) as Record<
      string,
      VendorReuseVerdict
    >
    const verdicts = vendorReuseFor(config)
    for (const [key, verdict] of Object.entries(stored)) verdicts.set(key, verdict)
  } catch {
    // No store yet; verdicts are written as probes settle.
  }
}

function persistVendorReuseVerdicts(config: ResolvedConfig) {
  void writeFileAtomic(
    vendorReuseFile(config),
    JSON.stringify(Object.fromEntries(vendorReuseFor(config))),
  ).catch(() => undefined)
}

/** Probe results shared across verdict pairs — node_modules bytes are immutable per process. */
const vendorLayerProbeMemo = new Map<string, Promise<VendorLayerProbe>>()

type VendorLayerProbe = Awaited<ReturnType<typeof probeVendorLayer>>

function probeVendorLayerMemo(config: ResolvedConfig, entry: string, conditions: string[]) {
  if (!vendorReuseExtEnabled()) return probeVendorLayer(config, entry, conditions)
  const key = `${config.outPath}\0${entry}\0${conditions.join(',')}`
  let probe = vendorLayerProbeMemo.get(key)
  if (!probe) {
    probe = probeVendorLayer(config, entry, conditions)
    probe.catch(() => vendorLayerProbeMemo.delete(key))
    vendorLayerProbeMemo.set(key, probe)
  }
  return probe
}

/** Metafile-only probe of one layer's view of an entry (never writes, no slots). */
async function probeVendorLayer(config: ResolvedConfig, entry: string, conditions: string[]) {
  const result = await build({
    entryPoints: [entry],
    absWorkingDir: config.root,
    bundle: true,
    write: false,
    metafile: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    conditions,
    mainFields: ['module', 'main'],
    loader: { '.js': 'jsx', '.mjs': 'jsx', '.cjs': 'jsx', '.css': 'empty' },
    jsx: 'automatic',
    jsxImportSource: 'preact',
    logLevel: 'silent',
    packages: 'external',
  })
  const externals = new Set<string>()
  for (const meta of Object.values(result.metafile.inputs)) {
    for (const reference of meta.imports) if (reference.external) externals.add(reference.path)
  }
  return {
    inputs: Object.keys(result.metafile.inputs).sort().join('\n'),
    externals: [...externals].sort(),
    directive: /['"]use (?:client|server|cache)['"]/.test(
      result.outputFiles.map(file => file.text).join(''),
    ),
  }
}

async function computeVendorReuseVerdict(
  config: ResolvedConfig,
  serverEntry: string,
  clientEntry: string,
  otherTarget: ServerBundleTarget = 'client',
): Promise<{ reusable: boolean; reason?: string }> {
  const tp = performance.now()
  const done = (v: { reusable: boolean; reason?: string }) => {
    heavyProfRow({
      k: 'reuse-probe',
      entry: serverEntry,
      other: otherTarget,
      ms: performance.now() - tp,
      ...v,
    })
    return v
  }
  // A finished server build already proved itself layer-specific: skip both probes.
  if (vendorReuseExtEnabled()) {
    const recorded = vendorLayerRecords.get(`${config.outPath}\0${serverEntry}`)?.get('server')
    if (recorded?.blocked) return done({ reusable: false, reason: 'recorded-blocked' })
  }
  const [server, client] = await Promise.all([
    probeVendorLayerMemo(config, serverEntry, serverBundleConditions('server')),
    probeVendorLayerMemo(config, clientEntry, serverBundleConditions(otherTarget)),
  ])
  if (server.inputs !== client.inputs) return done({ reusable: false, reason: 'inputs-differ' })
  if (server.externals.join('\n') !== client.externals.join('\n')) {
    return done({ reusable: false, reason: 'externals-differ' })
  }
  const aliasHit = server.externals.filter(isVendorLayerAlias)
  if (aliasHit.length > 0)
    return done({ reusable: false, reason: `layer-alias: ${aliasHit.join(',')}` })
  if (server.directive || client.directive) return done({ reusable: false, reason: 'directive' })
  return done({ reusable: true })
}

/** Whether the client demand may resolve to the server-layer artifact. */
function crossLayerReuseVerdict(
  config: ResolvedConfig,
  serverEntry: string,
  clientEntry: string,
  otherTarget: ServerBundleTarget = 'client',
): Promise<boolean> {
  loadVendorReuseVerdicts(config)
  const key =
    otherTarget === 'client'
      ? `${serverEntry}\0${clientEntry}`
      : `${otherTarget}:${serverEntry}\0${clientEntry}`
  const stats = [
    statSync(serverEntry, { throwIfNoEntry: false }),
    statSync(clientEntry, { throwIfNoEntry: false }),
  ]
  if (stats.some(entryStat => !entryStat)) return Promise.resolve(false)
  const stat_ = stats.map(entryStat => `${entryStat!.mtimeMs}:${entryStat!.size}`).join('|')
  const conds = JSON.stringify([
    serverBundleConditions('server'),
    serverBundleConditions(otherTarget),
  ])
  const stored = vendorReuseFor(config).get(key)
  if (stored?.stat === stat_ && stored.conds === conds) {
    return Promise.resolve(stored.reusable)
  }
  const probeKey = `${config.outPath}\0${key}`
  let probe = vendorReuseProbes.get(probeKey)
  if (!probe) {
    probe = computeVendorReuseVerdict(config, serverEntry, clientEntry, otherTarget)
      .catch(error => ({
        reusable: false,
        reason: `probe-failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`,
      }))
      .then(verdict => {
        vendorReuseFor(config).set(key, { stat: stat_, conds, ...verdict })
        persistVendorReuseVerdicts(config)
        return verdict.reusable
      })
      .finally(() => vendorReuseProbes.delete(probeKey))
    vendorReuseProbes.set(probeKey, probe)
  }
  return probe
}

/**
 * Alias a client-layer vendor demand onto the server-layer plan when the two builds are proven
 * byte-equivalent. The swap happens BEFORE enqueue, so the demand lands on the server build's
 * `pendingBundles` slot through ordinary dedup - no new cross-layer wait edges enter the scheduler.
 * A server build that is neither on disk nor pending is never waited for.
 */
async function crossLayerReusePlan(
  config: ResolvedConfig,
  specifier: string,
  resolveDir: string,
  target: CompatAliasTarget,
  conditionTarget: ServerBundleTarget,
  clientPlan: VendorBuildPlan,
): Promise<VendorBuildPlan | undefined> {
  if (!vendorReuseEnabled() || vendorContentDisabled()) return undefined
  // An edge demand proven condition-independent lands on the server plan —
  // one build serves both, and the server artifact keeps client reuse alive.
  if (target === 'server' && conditionTarget === 'edge' && vendorReuseExtEnabled()) {
    if (vendorBundleMemHit(clientPlan.key) || existsSync(clientPlan.file)) return undefined
    const edgeEntry = resolveVendorEntry(config, specifier, resolveDir, 'edge')
    const serverEntry = resolveVendorEntry(config, specifier, resolveDir, 'server')
    if (!edgeEntry || !serverEntry || edgeEntry !== serverEntry) return undefined
    const reusable = await crossLayerReuseVerdict(config, serverEntry, edgeEntry, 'edge').catch(
      () => false,
    )
    return reusable ? vendorBuildPlan(config, specifier, 'server', resolveDir, 'server') : undefined
  }
  if (vendorLayerKey(target, conditionTarget) !== 'client') return undefined
  // An in-flight or on-disk client artifact already settles cheaper than a probe.
  if (vendorBundleMemHit(clientPlan.key) || existsSync(clientPlan.file)) return undefined
  const clientEntry = resolveVendorEntry(config, specifier, resolveDir, conditionTarget)
  const serverEntry = resolveVendorEntry(config, specifier, resolveDir, 'server')
  if (!clientEntry || !serverEntry) return undefined
  const serverPlan = vendorBuildPlan(config, specifier, 'server', resolveDir, 'server')
  if (!vendorBundleMemHit(serverPlan.key) && !existsSync(serverPlan.file)) return undefined
  const reusable = await crossLayerReuseVerdict(config, serverEntry, clientEntry).catch(() => false)
  return reusable ? serverPlan : undefined
}

/** Cache hit and no-compile fast paths, in front of every build. */
async function prepareVendorArtifact(
  config: ResolvedConfig,
  specifier: string,
  resolveDir: string,
  conditionTarget: ServerBundleTarget,
  file: string,
  target: CompatAliasTarget,
  entry: string | undefined,
) {
  // Vendor bundles are keyed by resolved package path (version-specific under
  // pnpm), so an existing file is already current. Reuse it across dev restarts
  // instead of re-bundling the whole dependency graph.
  if (existsSync(file) && (await compiledModuleUsable(file))) return file
  await mkdir(path.dirname(file), { recursive: true })
  // An earlier build proved this entry layer-independent: the other layer's
  // content IS this layer's artifact, so the demand settles without compiling.
  const shared = reusableVendorContent(config, entry, target, conditionTarget)
  if (shared && (await compiledModuleUsable(shared))) {
    await linkVendorArtifact(file, shared)
    noteDevArtifactWritten(file)
    return shared
  }
  // A package that already ships a browser-ready ESM dist is copied, not compiled - the bundler would
  // only reproduce it. Sits in FRONT of the pass, never replaces it: anything the predicate rejects
  // falls through unchanged, and the copy is resolved exactly as the bundler would have. The copies
  // load natively now (rootFilter skips the vendor tree), so an app that configures `compiler.define`
  // must take the bundling path instead - that is where the defines are applied.
  if (vendorLoadsNatively() && serverDefineOptions().define) return undefined
  const distDir = `${file.replace(/\.mjs$/, '')}.dist`
  const distEntry = await copyBrowserReadyEsmDist(
    resolveVendorPackageSpecifier(
      config.root,
      path.join(resolveDir, 'pnext-resolve.ts'),
      specifier,
      serverBundleConditions(conditionTarget),
    ) ?? '',
    distDir,
  )
  if (distEntry) {
    // Native loading means the `.js` copies need their own type marker: an app
    // without `"type": "module"` would otherwise have Bun read them as
    // CommonJS and choke on their `export` syntax.
    await markEsmDistPackage(distDir)
    noteDevArtifactWritten(distEntry)
  }
  return distEntry
}

// eslint-disable-next-line turbo/no-undeclared-env-vars
const vendorPreplanEnabled = () => process.env.PNEXT_VENDOR_PREPLAN === '1'

interface VendorPreplanVerdict {
  stat: string
  conds: string
  safe: boolean
  reason?: string
}

const vendorPreplanVerdicts = new Map<string, Map<string, VendorPreplanVerdict>>()
const vendorPreplanLoaded = new Set<string>()
const vendorPreplanProbes = new Map<string, Promise<VendorPreplanVerdict>>()

const vendorPreplanStats = {
  preplanRefs: 0,
  fallbackRefs: 0,
  enqueued: 0,
  composedBuilds: 0,
  packagesRouted: 0,
  packagesRejected: 0,
  reasons: [] as string[],
}

export function vendorPreplanReport() {
  return { ...vendorPreplanStats, reasons: vendorPreplanStats.reasons.slice(0, 60) }
}

const vendorPreplanDebug = () => traceEnabled('vendor')
let preplanReportFlush: ReturnType<typeof setTimeout> | undefined
function schedulePreplanReport() {
  if (!vendorPreplanDebug()) return
  if (preplanReportFlush) clearTimeout(preplanReportFlush)
  preplanReportFlush = setTimeout(() => {
    console.error(`pnext vendor preplan ${JSON.stringify(vendorPreplanReport())}`)
    console.error(`pnext vendor native ${JSON.stringify(vendorNativeReport())}`)
  }, 3000)
  preplanReportFlush.unref?.()
}

function vendorPreplanFile(config: ResolvedConfig) {
  return vendorStoreFile(config, 'preplan-verdicts')
}

function vendorPreplanFor(config: ResolvedConfig) {
  let verdicts = vendorPreplanVerdicts.get(config.outPath)
  if (!verdicts) {
    verdicts = new Map()
    vendorPreplanVerdicts.set(config.outPath, verdicts)
  }
  return verdicts
}

/** Probe verdicts persist per checkout, reuse-verdict style. */
function loadVendorPreplanVerdicts(config: ResolvedConfig) {
  if (vendorPreplanLoaded.has(config.outPath)) return
  vendorPreplanLoaded.add(config.outPath)
  try {
    const stored = JSON.parse(readFileSync(vendorPreplanFile(config), 'utf8')) as Record<
      string,
      VendorPreplanVerdict
    >
    const verdicts = vendorPreplanFor(config)
    for (const [key, verdict] of Object.entries(stored)) verdicts.set(key, verdict)
  } catch {
    // No store yet; verdicts are written as probes settle.
  }
}

function persistVendorPreplanVerdicts(config: ResolvedConfig) {
  void writeFileAtomic(
    vendorPreplanFile(config),
    JSON.stringify(Object.fromEntries(vendorPreplanFor(config))),
  ).catch(() => undefined)
}

/** Does this entry's graph change shape under `react-server` (or carry directives)? */
function vendorPreplanEntryVerdict(
  config: ResolvedConfig,
  entry: string,
  conditions: string[],
): Promise<VendorPreplanVerdict> | VendorPreplanVerdict {
  loadVendorPreplanVerdicts(config)
  const entryStat = statSync(entry, { throwIfNoEntry: false })
  if (!entryStat) return { stat: '', conds: '', safe: false, reason: 'entry missing' }
  const stat_ = `${entryStat.mtimeMs}:${entryStat.size}`
  const conds = JSON.stringify(conditions)
  const stored = vendorPreplanFor(config).get(entry)
  if (stored?.stat === stat_ && stored.conds === conds) return stored
  const probeKey = `${config.outPath}\0${entry}\0${conds}`
  let probe = vendorPreplanProbes.get(probeKey)
  if (!probe) {
    probe = computeVendorPreplanVerdict(config, entry, conditions, stat_, conds)
      .catch(error => ({
        stat: stat_,
        conds,
        safe: false,
        reason: `probe-failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`,
      }))
      .then(verdict => {
        vendorPreplanFor(config).set(entry, verdict)
        persistVendorPreplanVerdicts(config)
        return verdict
      })
      .finally(() => vendorPreplanProbes.delete(probeKey))
    vendorPreplanProbes.set(probeKey, probe)
  }
  return probe
}

async function computeVendorPreplanVerdict(
  config: ResolvedConfig,
  entry: string,
  conditions: string[],
  stat_: string,
  conds: string,
): Promise<VendorPreplanVerdict> {
  const [rsc, plain] = await Promise.all([
    probeVendorLayer(config, entry, conditions),
    probeVendorLayer(
      config,
      entry,
      conditions.filter(condition => condition !== 'react-server'),
    ),
  ])
  if (rsc.inputs !== plain.inputs) {
    return { stat: stat_, conds, safe: false, reason: 'react-server inputs differ' }
  }
  if (rsc.externals.join('\n') !== plain.externals.join('\n')) {
    return { stat: stat_, conds, safe: false, reason: 'react-server externals differ' }
  }
  if (rsc.directive || plain.directive) {
    return { stat: stat_, conds, safe: false, reason: 'directive' }
  }
  return { stat: stat_, conds, safe: true }
}

/**
 * May THIS package's build emit pre-planned refs? Any rejection routes the whole build to the awaited
 * plugin decisions - always available, always correct. ESM-only keeps the exec surface off the
 * fire-and-forget path: a CJS parent's artifact is imported (facade exec) the moment its build
 * returns, before any drain could cover its children.
 */
async function vendorPreplanPackageSafe(
  config: ResolvedConfig,
  packageName: string | undefined,
  entry: string | undefined,
  target: CompatAliasTarget,
  conditionTarget: ServerBundleTarget,
): Promise<boolean> {
  if (!vendorPreplanEnabled() || target !== 'server' || conditionTarget !== 'server') return false
  const reject = (reason: string) => {
    vendorPreplanStats.packagesRejected += 1
    vendorPreplanStats.reasons.push(`${packageName ?? '?'}: ${reason}`)
    schedulePreplanReport()
    return false
  }
  if (!packageName || !entry || !path.isAbsolute(entry)) return reject('unresolved entry')
  if (/\.[cm]?tsx?$/.test(entry)) return reject('ts entry')
  if (!isEsmModuleEntry(entry)) return reject('cjs entry')
  if (getExternalPackagePolicy().transpile(packageName)) return reject('transpilePackages')
  const verdict = await vendorPreplanEntryVerdict(config, entry, serverBundleConditions('server'))
  if (!verdict.safe) return reject(verdict.reason ?? 'react-server divergence')
  vendorPreplanStats.packagesRouted += 1
  schedulePreplanReport()
  return true
}

/** Mirror of `externalServerPackageHref`'s liveness recheck, minus the await(er). */
function enqueuePreplanBuild(plan: VendorBuildPlan) {
  vendorPreplanStats.enqueued += 1
  trackPreplanBuild(
    (async () => {
      let file = await vendorBundle(plan, false)
      if (!cachedExistsSync(file) || !(await compiledModuleUsable(file))) {
        dropVendorBundle(plan.key, file)
        if (plan.group) dropVendorGroup(plan.group.key)
        file = await vendorBundle(plan, false)
      }
    })(),
  )
}

/**
 * The deterministic-href emit: classify the dep once from pure inputs, hand
 * back its artifact path pre-build, and enqueue the build without awaiting it.
 * `undefined` routes the reference to the awaited plugin decision unchanged.
 * Every emitted href is exactly what `externalServerPackageHref` would have
 * returned for this demand, so flag-on artifacts stay byte-identical.
 */
async function preplanDependencyDecision(
  config: ResolvedConfig,
  target: CompatAliasTarget,
  conditionTarget: ServerBundleTarget,
  specifier: string,
  resolveDir: string,
): Promise<OnResolveResult | undefined> {
  const depName = packageNameFromSpecifier(specifier)
  if (!isVendorModuleSpecifier(specifier)) return undefined
  if (depName && (builtinModules.includes(depName) || isBunBuiltin(depName))) return undefined
  if (depName && getExternalPackagePolicy().external(depName)) return undefined
  if (depName && getExternalPackagePolicy().transpile(depName)) return undefined
  const entry = resolveVendorEntry(config, specifier, resolveDir, conditionTarget)
  if (!entry || /\.[cm]?tsx?$/.test(entry) || !isEsmModuleEntry(entry)) return undefined
  const plan = vendorBuildPlan(config, specifier, target, resolveDir, conditionTarget)
  if (cachedExistsSync(plan.file)) {
    if (!(await compiledModuleUsable(plan.file))) return undefined
  } else {
    // Both prepare fast paths settle on a DIFFERENT file than `plan.file`, so
    // their demands keep the awaited path (which is nearly free for them).
    if (reusableVendorContent(config, entry, target, conditionTarget)) return undefined
    if (!(vendorLoadsNatively() && serverDefineOptions().define)) {
      const distEntry = await copyBrowserReadyEsmDist(
        resolveVendorPackageSpecifier(
          config.root,
          path.join(resolveDir, 'pnext-resolve.ts'),
          specifier,
          serverBundleConditions(conditionTarget),
        ) ?? '',
        `${plan.file.replace(/\.mjs$/, '')}.dist`,
      )
      if (distEntry) return undefined
    }
  }
  enqueuePreplanBuild(plan)
  return { path: pathToFileHref(plan.file), external: true }
}

const esmDistPackages = new Set<string>()

async function markEsmDistPackage(distDir: string) {
  if (esmDistPackages.has(distDir)) return
  esmDistPackages.add(distDir)
  const marker = path.join(distDir, 'package.json')
  if (existsSync(marker)) return
  await writeFile(marker, '{"type":"module"}').catch(() => undefined)
}

/**
 * Can this compiled artifact be imported as-is? Two O(1) checks - the file itself, and the cache
 * folder's marker - replace the whole-graph walk that read back every compiled module and checked
 * each of its `cache/server/` edges. Both guard the same hazard: a `pnext build` wiping `.pnext`
 * under a running server can strand a dangling import, and Bun caches a failed load for the life of
 * the process.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function compiledModuleUsable(file: string): Promise<boolean> {
  return devArtifactUsable(file)
}

/**
 * The group this subpath belongs to. Same-package imports are inlined (externalizing would lose a
 * CommonJS entry's named exports), so a build per subpath re-parses the package's whole graph per
 * subpath; the subpaths demanded together become entries of one `splitting: true` build instead.
 *
 * Restricted to ESM entries: an entry esbuild has to convert from CommonJS goes through
 * `addCommonJsNamedExports`, whose export recovery reads the shape of a single-file bundle and does
 * not survive being split into chunks.
 */
function vendorGroupPlan(
  config: ResolvedConfig,
  member: VendorGroupMember,
  target: CompatAliasTarget,
  resolveDir: string,
  conditionTarget: ServerBundleTarget,
): VendorGroupPlan | undefined {
  const packageName = packageNameFromSpecifier(member.specifier)
  const packageRoot = packageName && vendorPackageRoot(member.entry, packageName)
  if (!packageName || !packageRoot || !isEsmModuleEntry(member.entry)) return undefined
  return {
    key: `${config.outPath}\0${target}\0${conditionTarget}\0${packageRoot}`,
    member,
    build: (members, external, nested) =>
      buildVendorGroup(
        config,
        packageName,
        members,
        external,
        target,
        resolveDir,
        conditionTarget,
        nested,
      ),
  }
}

/**
 * The installed package directory an entry belongs to — the grouping identity,
 * so a nested (non-hoisted) copy never shares a group with the hoisted one.
 */
function vendorPackageRoot(entry: string, packageName: string) {
  const marker = `${path.sep}node_modules${path.sep}`
  const index = entry.lastIndexOf(marker)
  if (index < 0) return undefined
  return path.join(entry.slice(0, index + marker.length), packageName)
}

/**
 * One esbuild pass for the subpaths demanded together, with the shared graph split into chunks so it
 * is parsed once instead of once per subpath. Siblings already on disk are externalized rather than
 * re-parsed, which keeps artifacts handed out earlier valid across a growth round.
 */
async function buildVendorGroup(
  config: ResolvedConfig,
  packageName: string,
  members: readonly VendorGroupMember[],
  external: readonly VendorGroupMember[],
  target: CompatAliasTarget,
  resolveDir: string,
  conditionTarget: ServerBundleTarget,
  nested: boolean,
) {
  const built = members.filter(member => !existsSync(member.file))
  if (built.length === 0) return
  // Only a sibling whose artifact is ON DISK can be externalized — one still
  // compiling (a solo build this round did not wait for) must be inlined, or
  // this bundle would import a file that is not there yet.
  const siblings = new Map(
    [...external, ...members]
      .filter(member => !built.includes(member) && existsSync(member.file))
      .map(member => [member.specifier, pathToFileHref(member.file)] as const),
  )
  const outdir = path.dirname(built[0]!.file)
  const context = { nestedExternalFiles: [] as string[] }
  const entryFiles = new Set(built.map(member => member.file))
  // The plugin-chain fallback builds from bare specifiers; hand the interop
  // plugin each member's already-resolved entry.
  for (const member of built) provideEntryResolution(member.specifier, resolveDir, member.entry)
  const entryPoints = built.map(member => ({
    in:
      getBundlerExtensions().serverBundleEntry(member.specifier, resolveDir, member.entry) ??
      member.specifier,
    out: path.basename(member.file, '.mjs'),
  }))
  const trace: VendorBuildTrace | undefined = vendorTraceEnabled()
    ? { plugins: [], entry: built[0]!.entry }
    : undefined
  const traceSeq = trace ? nextVendorTraceSeq() : 0
  const traceStart = performance.now()
  const traceRow = (outputs: { text: string }[] | undefined, error?: unknown) => {
    if (!trace) return
    traceVendorBuild({
      seq: traceSeq,
      specifier: packageName,
      resolveDir,
      target,
      conditionTarget,
      conditions: serverBundleConditions(conditionTarget),
      startMs: traceStart,
      outBytes: (outputs ?? []).reduce((sum, output) => sum + output.text.length, 0),
      trace,
      ok: !error,
      ...(error
        ? // eslint-disable-next-line @typescript-eslint/no-base-to-string
          { error: (error instanceof Error ? error.message : String(error)).slice(0, 300) }
        : {}),
    })
  }
  const preplan =
    vendorPreplanEnabled() &&
    (
      await Promise.all(
        built.map(member =>
          vendorPreplanPackageSafe(config, packageName, member.entry, target, conditionTarget),
        ),
      )
    ).every(Boolean)
  let outputFiles
  try {
    outputFiles = await profileRuntimeStep(
      `vendor bundle ${packageName} [${target}/${conditionTarget}] (${built.length} entries)`,
      async () =>
        (await buildVendorNative({
          preplan,
          config,
          target,
          conditionTarget,
          resolveDir,
          bailKey: `${packageName}\0${target}\0${conditionTarget}\0${outdir}`,
          packageName,
          // Resolved entries, not the bare specifiers the plugin build uses:
          // `packages: 'external'` refuses to bundle a bare entry point.
          entryPoints: built.map(member => ({
            in: member.entry,
            out: path.basename(member.file, '.mjs'),
          })),
          outdir,
          splitting: true,
          siblings,
          ownEntries: new Map(built.map(member => [member.entry, member.file])),
          isEntry: output => entryFiles.has(output),
          nested,
          context,
          trace,
        })) ??
        (await buildVendorGroupWithPlugins(
          config,
          packageName,
          siblings,
          target,
          resolveDir,
          conditionTarget,
          outdir,
          entryPoints,
          context,
          trace,
          preplan,
        )),
    )
  } catch (error) {
    traceRow(undefined, error)
    throw error
  }
  traceRow(outputFiles)
  await mkdir(path.join(outdir, 'chunks'), { recursive: true })
  // Chunks first: an entry must never be readable before what it imports is.
  for (const output of [...outputFiles].sort(
    (a, b) => Number(entryFiles.has(a.path)) - Number(entryFiles.has(b.path)),
  )) {
    const bundled = entryFiles.has(output.path) ? addCommonJsNamedExports(output.text) : output.text
    // Packages can ship 'use cache' functions too (Next allows it); client
    // bundles keep the source untouched.
    const code = target === 'server' ? applyBundledSourceTransforms(bundled, output.path) : bundled
    await writeVendorArtifact(output.path, code)
  }
  await emitNestedExternalTraceCopies(built[0]!.file, context.nestedExternalFiles)
}

// vendor plugin-callback attribution (PNEXT_TRACE=vendor, dormant otherwise). Every
// onResolve/onLoad is an IPC round trip esbuild's bundler blocks on, against the one JS thread that
// answers them; counts separate "our callbacks are slow" from "we answer many questions".

const vendorProfileEnabled = traceEnabled('vendor')
const vendorProfileTotals = new Map<string, number>()

function vendorProfileCount(key: string, by = 1) {
  vendorProfileTotals.set(key, (vendorProfileTotals.get(key) ?? 0) + by)
}

export function vendorProfileReport() {
  return Object.fromEntries(
    [...vendorProfileTotals].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(v)]),
  )
}

// Printed once the callbacks go quiet, so one page's whole plugin chain lands
// in a single line instead of interleaving with the build it is measuring.
let vendorProfileFlush: ReturnType<typeof setTimeout> | undefined
function scheduleVendorProfileReport() {
  if (vendorProfileFlush) clearTimeout(vendorProfileFlush)
  vendorProfileFlush = setTimeout(() => {
    console.log(`pnext vendor profile ${JSON.stringify(vendorProfileReport())}`)
  }, 3000)
  vendorProfileFlush.unref?.()
}

function profiledVendorPlugins(plugins: Plugin[]): Plugin[] {
  if (!vendorProfileEnabled) return plugins
  return plugins.map(plugin => ({
    name: plugin.name,
    setup(build) {
      const wrap =
        (kind: 'resolve' | 'load', register: (options: any, cb: any) => void) =>
        (options: any, callback: any) =>
          register(options, async (args: any) => {
            vendorProfileCount(`${plugin.name}:${kind}#`)
            const start = performance.now()
            try {
              return await (callback as (a: unknown) => unknown)(args)
            } finally {
              vendorProfileCount(`${plugin.name}:${kind}ms`, performance.now() - start)
              scheduleVendorProfileReport()
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

/** The plugin chain, for whatever the plugin-free build could not express. */
async function buildVendorGroupWithPlugins(
  config: ResolvedConfig,
  packageName: string,
  siblings: ReadonlyMap<string, string>,
  target: CompatAliasTarget,
  resolveDir: string,
  conditionTarget: ServerBundleTarget,
  outdir: string,
  entryPoints: { in: string; out: string }[],
  context: { nestedExternalFiles: string[] },
  trace?: VendorBuildTrace,
  preplan = false,
) {
  const pluginStart = performance.now()
  const groupPlugins = profiledVendorPlugins([
    serverAssetPlugin(config),
    ...getBundlerExtensions().serverEsbuildPlugins(
      config,
      vendorPluginOptions(config, target, conditionTarget),
    ),
    runtimeAliasBuildPlugin(config, target, {
      bundleRequireAliases: true,
      reactServerLayer: target === 'server',
    }),
    vendorGroupSiblingPlugin(siblings),
    externalPackageDependencyPlugin(
      config,
      packageName,
      target,
      conditionTarget,
      resolveDir,
      entryPoints.map(entry => entry.in),
      context,
      preplan,
    ),
    externalBuiltinBuildPlugin(),
  ])
  if (trace) trace.plugins = groupPlugins.map(plugin => plugin.name)
  const result = await build({
    entryPoints,
    absWorkingDir: resolveDir,
    bundle: true,
    splitting: true,
    write: false,
    outdir,
    outExtension: { '.js': '.mjs' },
    chunkNames: 'chunks/[name]-[hash]',
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    conditions: serverBundleConditions(conditionTarget),
    mainFields: ['module', 'main'],
    loader: packageJsxLoaders,
    jsx: 'automatic',
    jsxImportSource: 'preact',
    logLevel: 'silent',
    // Trace-only: the analyzer's per-build input set comes from the metafile.
    ...(trace ? { metafile: true as const } : {}),
    ...serverDefineOptions(),
    plugins: groupPlugins,
  })
  vendorNativeStats.pluginBuilds += 1
  vendorNativeStats.pluginBuildMs += performance.now() - pluginStart
  if (trace) trace.metafile = result.metafile
  return result.outputFiles.map(output => ({ path: output.path, text: output.text }))
}

/** Siblings already compiled stay out of the graph, as plain externals. */
function vendorGroupSiblingPlugin(siblings: ReadonlyMap<string, string>): Plugin {
  return {
    name: 'pnext-vendor-group-siblings',
    setup(build) {
      if (siblings.size === 0) return
      build.onResolve({ filter: /^[^./].*/ }, args => {
        if (args.kind === 'entry-point') return undefined
        const sibling = siblings.get(args.path)
        return sibling ? { path: sibling, external: true } : undefined
      })
    },
  }
}

// per-file client boundaries inside a package.
//
// A package ships its client half as ordinary files carrying a `'use client'` directive next to a
// directive-less index that re-exports them. From the react-server graph such a file is a client
// REFERENCE - never code the RSC pass runs - and the module pass already stubs the ones it resolves
// itself. A vendor bundle reaches them mid-graph instead, where no resolve of ours ever sees the
// specifier, so the directive was lost inside the bundle: the RSC pass then executed a client
// component and the app got a SECOND copy of every module the client profile also bundles - two
// `createContext` calls, so a provider rendered from the client graph is invisible to a consumer
// rendered from this one.
//
// The scan is off wherever it cannot matter: client-target bundles (the SSR pass must run the real
// component) and non-react apps. On the ones that remain it costs a read per input file, which
// esbuild was going to make anyway. `PNEXT_VENDOR_CLIENT_BOUNDARY=0` removes the plugin, to bisect.

// No longer a plugin of its own: the scan is composed into the server chain's
// single claiming onLoad (ServerEsbuildPluginOptions.vendorClientBoundary), so
// it adds zero plugin-callback round trips. Reads are memoized per config —
// the same node_modules bytes used to be re-read and re-decoded per build.
const vendorClientBoundaryLoads = new WeakMap<
  ResolvedConfig,
  (file: string) => Promise<OnLoadResult | undefined>
>()

function vendorClientBoundaryLoad(config: ResolvedConfig) {
  let load = vendorClientBoundaryLoads.get(config)
  if (load) return load
  const memo = new Map<string, Promise<OnLoadResult | undefined>>()
  const scan = async (file: string): Promise<OnLoadResult | undefined> => {
    const source = await readFile(file, 'utf8').catch(() => undefined)
    if (source === undefined || !hasUseClientDirective(source)) return undefined
    // A 'use client' file the vendor pass found inside a package — the render will import it as a
    // client module, and nothing else records it (the server-source scan only sees the package
    // entry, which carries no directive). The vercel warm pass reads this to compile it at build.
    noteCompiledClientReference(file)
    return {
      contents: clientReferenceModuleSource(
        file,
        await clientReferenceExportNames(config, file, source),
        { inlineSymbol: true },
      ),
      loader: 'js',
      resolveDir: path.dirname(file),
    }
  }
  // Only node_modules answers are cached: immutable for the process life, the
  // same assumption the vendor artifact cache makes. First-party files re-read.
  load = file => {
    if (!file.includes(`${path.sep}node_modules${path.sep}`)) return scan(file)
    let pending = memo.get(file)
    if (!pending) {
      pending = scan(file)
      memo.set(file, pending)
    }
    return pending
  }
  vendorClientBoundaryLoads.set(config, load)
  return load
}

/**
 * Whether the react-server vendor pass scans this build's inputs at all. `target === 'server'` alone
 * is not the react-server graph: the PAGES router compiles under it too, and there `'use client'` is
 * inert - Next never runs an RSC pass for a pages route, so the file must be EXECUTED, not stubbed.
 * Stubbing it there turns a plain exported value into a truthy reference object, which crashes SSR.
 */
function vendorPluginOptions(
  config: ResolvedConfig,
  target: CompatAliasTarget,
  conditionTarget: ServerBundleTarget,
): ServerEsbuildPluginOptions {
  const boundary =
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    process.env.PNEXT_VENDOR_CLIENT_BOUNDARY !== '0' &&
    target === 'server' &&
    !isPagesBundleTarget(conditionTarget) &&
    reactCompatEnabled(config)
      ? vendorClientBoundaryLoad(config)
      : undefined
  return { vendorClientBoundary: boundary, realPathEntries: true }
}

function isPagesBundleTarget(target: ServerBundleTarget) {
  return target === 'pages' || target === 'pages-api' || target === 'pages-api-edge'
}

// plugin-free vendor builds.
//
// The four core plugins above resolve by callback, and a callback is a JS bridge hop the bundler
// waits on. Each behaviour leaves the callback in one of two ways - an esbuild-native option where
// it is expressible, or a post-pass over the emitted chunks, where the metafile hands us the same
// (importer, specifier, kind) triples the resolve callback used to see:
//
//   builtins            -> `packages: 'external'` covers them, nothing to do
//   asset stubs         -> native `loader: empty`; an extension the map does not cover has no
//                          loader, so the build fails and falls back - the safe direction
//   framework aliases   -> external by default, post-pass repoints each one at its alias target
//                          (require-kind separately, against the react-server layer map)
//   external packages   -> external by default, post-pass runs the policy: nested-version pinning,
//                          transitive vendor recursion, CommonJS facades
//
// What must be BUNDLED rather than externalized - a package's own subpaths, a default-only
// CommonJS dependency, a cross-package asset - is named in `alias`, which overrides
// `packages: 'external'` for exactly those specifiers and nothing else. That set is a property of
// the package, so it is discovered once (`vendorPackageShape`) and every later build starts with it.
// Anything still unexpressible bails to the plugin build; bailing is always available and always
// correct, so this path never has to be complete - it has to be RIGHT, which is what the re-bundle
// gate proves.
//
// Off by default: this pipeline is not spending its time in plugin callbacks, and two next-compat
// behaviours still diverge - see `vendorNativeEnabled`.

/**
 * OFF by default: it is measurably slower AND not yet equivalent. `app-external` loses four
 * assertions with it on - `transpilePackages`, the react-server export condition, CJS tree-shaking
 * and an async external module all 500 - which the re-bundle gate cannot catch, because those
 * artifacts are structurally sound and semantically wrong.
 */
function vendorNativeEnabled() {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  return process.env.PNEXT_VENDOR_NATIVE === '1'
}

/**
 * Artifacts whose plugin-free build did not work out. One bail is enough: the
 * cause is a property of the package (a require-kind alias to a CommonJS shim,
 * an asset needing real contents), not of the demand, so a retry pays for the
 * discarded build again and lands in the same place.
 */
const vendorNativeBailed = new Set<string>()

/** How the vendor builds of this process split between the two paths. */
const vendorNativeStats = {
  attempts: 0,
  native: 0,
  bailed: 0,
  rounds: 0,
  buildMs: 0,
  pluginBuilds: 0,
  pluginBuildMs: 0,
  planMs: 0,
  verifyMs: 0,
  reasons: [] as string[],
}

export function vendorNativeReport() {
  return { ...vendorNativeStats, reasons: vendorNativeStats.reasons.slice(0, 40) }
}

/**
 * What the asset plugin stubs, minus the extensions whose stub has CONTENT
 * (images, CSS modules). Those have no loader here on purpose: esbuild fails
 * the build, and failing is how they reach the plugin path.
 */
const vendorEmptyLoaders = {
  '.css': 'empty',
  '.scss': 'empty',
  '.sass': 'empty',
  '.less': 'empty',
} satisfies Record<string, Loader>

/** Discovery is a fixpoint; past this a package is not worth another try. */
const MAX_VENDOR_NATIVE_ROUNDS = 2

interface VendorNativeRequest {
  config: ResolvedConfig
  target: CompatAliasTarget
  conditionTarget: ServerBundleTarget
  resolveDir: string
  /** Cache key for the bail set — the artifact this build is producing. */
  bailKey: string
  /** The package the entries belong to; its own subpaths are inlined. */
  packageName: string | undefined
  entryPoints: { in: string; out: string }[] | string[]
  outdir?: string
  splitting: boolean
  /** Demanded siblings already on disk (group builds only). */
  siblings?: ReadonlyMap<string, string>
  /** Entries THIS build emits, by resolved entry file: artifacts-to-be. */
  ownEntries?: ReadonlyMap<string, string>
  /** Raised from inside another build: it may never wait on anything shared. */
  nested: boolean
  /** Preplan-safe package: native build with pure ref decisions, no verify. */
  preplan?: boolean
  /** Entry outputs, by emitted path; everything else is a shared chunk. */
  isEntry: (outputPath: string) => boolean
  /** Where a solo build's single output lands, for the verification gate. */
  soloFile?: string
  context: { nestedExternalFiles: string[] }
  /** Trace-only: filled with the producing pass's plugins/metafile. */
  trace?: VendorBuildTrace
}

/** A repointed reference: the specifier to emit, and the file it must exist at. */
interface VendorRefTarget {
  specifier: string
  file: string
}

/**
 * Run the plugin-free build, or return undefined to say "use the plugins". Every return path other than the
 * verified one is a bail, so a caller can treat undefined as "nothing happened" - no artifact is written here.
 */
async function buildVendorNative(request: VendorNativeRequest) {
  vendorNativeStats.attempts += 1
  if ((!vendorNativeEnabled() && !request.preplan) || vendorNativeBailed.has(request.bailKey)) {
    return undefined
  }
  // A bail is remembered so the next demand does not pay for the same
  // discarded build — unless the cause was the fixpoint running out of rounds,
  // which the package shape this build just recorded has already moved on from.
  const bail = (why: string, permanent = true) => {
    if (permanent) vendorNativeBailed.add(request.bailKey)
    vendorNativeStats.bailed += 1
    vendorNativeStats.reasons.push(`${request.packageName ?? '?'}: ${why}`)
    return undefined
  }

  const conditions = serverBundleConditions(request.conditionTarget)
  // What a package has to keep INSIDE its bundle is a property of the package,
  // not of one subpath's build, so it is discovered once and reused by every
  // later build of it — the fixpoint the §4e prototype ran app-wide, amortized
  // per package here.
  const shape = vendorPackageShape(request)
  // Only the FIRST build of a package discovers its shape; the rest wait for that answer instead of racing to
  // the same rounds. Off the slot, because a waiter that keeps its worker is exactly the inversion this is
  // here to fix. A nested build never waits - its own parent is holding a slot for it, and a cycle through two
  // packages would otherwise have nowhere to go.
  if (!request.nested && shape.discovery) {
    await outsideVendorSlot(() => shape.discovery!)
  }
  const pioneer = !shape.discovery
  let settleDiscovery: (() => void) | undefined
  if (pioneer) shape.discovery = new Promise<void>(resolve => (settleDiscovery = resolve))
  try {
    return await runVendorNativeRounds(request, shape, conditions, bail)
  } finally {
    if (pioneer) {
      shape.discovery = undefined
      settleDiscovery?.()
    }
  }
}

async function runVendorNativeRounds(
  request: VendorNativeRequest,
  shape: VendorPackageShape,
  conditions: string[],
  bail: (why: string, permanent?: boolean) => undefined,
) {
  const { config, resolveDir } = request

  for (let round = 1; round <= MAX_VENDOR_NATIVE_ROUNDS; round += 1) {
    let result
    vendorNativeStats.rounds += 1
    const buildStart = performance.now()
    const nativePlugins = getBundlerExtensions().serverEsbuildPlugins(
      config,
      vendorPluginOptions(config, request.target, request.conditionTarget),
    )
    if (request.trace) request.trace.plugins = nativePlugins.map(plugin => plugin.name)
    try {
      result = await build({
        entryPoints: (request.entryPoints as (string | { in: string; out: string })[]).map(entry =>
          typeof entry === 'string'
            ? (getBundlerExtensions().serverBundleEntry(entry, resolveDir, entry) ?? entry)
            : {
                ...entry,
                in:
                  getBundlerExtensions().serverBundleEntry(entry.in, resolveDir, entry.in) ??
                  entry.in,
              },
        ) as string[],
        absWorkingDir: resolveDir,
        bundle: true,
        ...(request.splitting ? { splitting: true, chunkNames: 'chunks/[name]-[hash]' } : {}),
        write: false,
        ...(request.outdir ? { outdir: request.outdir, outExtension: { '.js': '.mjs' } } : {}),
        format: 'esm',
        platform: 'neutral',
        target: 'es2022',
        conditions,
        mainFields: ['module', 'main'],
        loader: { ...packageJsxLoaders, ...vendorEmptyLoaders },
        jsx: 'automatic',
        jsxImportSource: 'preact',
        logLevel: 'silent',
        metafile: true,
        ...serverDefineOptions(),
        // Every bare specifier out — the cheapest possible graph — except the
        // handful `alias` names, which is how a same-package subpath or a
        // default-only CommonJS dependency stays INSIDE without giving up
        // externalization for everything else.
        packages: 'external',
        ...(shape.inline.size > 0 ? { alias: Object.fromEntries(shape.inline) } : {}),
        plugins: nativePlugins,
      })
    } catch (error) {
      vendorNativeStats.buildMs += performance.now() - buildStart
      return bail((error instanceof Error ? error.message : String(error)).slice(0, 200))
    }
    vendorNativeStats.buildMs += performance.now() - buildStart

    const inputs = Object.keys(result.metafile.inputs)
    // An asset whose stub carries content, or one a configured loader rule
    // claims, is not what `loader: empty` produced. Hand it to the plugins.
    for (const input of inputs) {
      const file = path.resolve(resolveDir, input)
      if (!serverIgnoredAssetFilter.test(file)) continue
      if (getAssetExtensions().hasLoaderRuleFor(file)) return bail(`loader rule for ${input}`)
      if (getCssExtensions().loadCssModuleForClient(file) !== undefined) {
        return bail(`css module ${input}`)
      }
    }
    // Preplan class is ESM-only across the GRAPH, not just the entry.
    if (request.preplan) {
      for (const input of inputs) {
        const file = path.resolve(resolveDir, input)
        if (serverIgnoredAssetFilter.test(file) || !cachedExistsSync(file)) continue
        if (/\.[cm]?tsx?$/.test(file)) return bail(`ts input ${input}`)
        if (file.endsWith('.cjs') || (/\.jsx?$/.test(file) && !isEsmModuleEntry(file))) {
          return bail(`cjs input ${input}`)
        }
      }
    }

    // Off the slot: everything below is discovery, and the bundler that needed
    // the worker has already handed its output over. Nothing else in the
    // pipeline can do this — the plugin chain's discovery runs inside a resolve
    // callback, with the bundler still open behind it.
    const planStart = performance.now()
    const plan = await outsideVendorSlot(() =>
      planVendorNativeRefs(request, result.metafile, conditions),
    )
    vendorNativeStats.planMs += performance.now() - planStart
    if (!plan) return bail('unrepresentable reference')
    if (plan.inline.size > 0) {
      // Record before deciding: even a bail teaches the package's shape, so the
      // next build of it starts where this one gave up.
      let grew = false
      for (const [specifier, file] of plan.inline) {
        if (shape.inline.has(specifier)) continue
        shape.inline.set(specifier, file)
        grew = true
      }
      if (!grew) return bail('inline set stopped converging')
      if (round === MAX_VENDOR_NATIVE_ROUNDS) return bail('inlining unsettled', false)
      continue
    }

    const outputs = result.outputFiles.map(output => ({
      path: request.soloFile ?? output.path,
      text: rewriteEmittedRefs(
        output.text,
        ref => (ref.require ? plan.requires : plan.imports).get(ref.specifier)?.specifier,
      ),
    }))
    const repointed = new Map(
      [...plan.imports.values(), ...plan.requires.values()].map(t => [t.specifier, t.file]),
    )
    // Preplan mode: the drain barrier + byte-eq gates stand in for the
    // re-bundle verification loop — its cost is one of the two this composes out.
    if (!request.preplan) {
      const verifyStart = performance.now()
      const chunks = new Map(
        outputs.filter(output => !request.isEntry(output.path)).map(o => [o.path, o.text]),
      )
      for (const output of outputs) {
        if (!request.isEntry(output.path)) continue
        const failure = await verifyVendorArtifact(output.path, output.text, repointed, chunks)
        if (failure) {
          vendorNativeStats.verifyMs += performance.now() - verifyStart
          return bail(`verification: ${failure}`)
        }
      }
      vendorNativeStats.verifyMs += performance.now() - verifyStart
    } else {
      vendorPreplanStats.composedBuilds += 1
      schedulePreplanReport()
    }
    vendorNativeStats.native += 1
    if (request.trace) request.trace.metafile = result.metafile
    return outputs
  }
  return undefined
}

/**
 * What one package externalizes and what it keeps inside - discovered once and then reused, so the
 * rounds a package costs are paid by its FIRST build and no other. Seeded from the manifest: a
 * declared dependency is external before any build proves it, which keeps a package's own subpaths
 * (the ones `packages: 'external'` cannot tell apart from dependencies) bundled from the start.
 */
interface VendorPackageShape {
  /** Specifier -> file it must be bundled from, as an esbuild `alias` entry. */
  inline: Map<string, string>
  /** Set while one build is discovering it; every other build awaits this. */
  discovery?: Promise<void>
}

const vendorPackageShapes = new Map<string, VendorPackageShape>()

function vendorPackageShape(request: VendorNativeRequest): VendorPackageShape {
  const entry = (request.entryPoints as { in?: string }[])[0]
  const first = typeof entry === 'string' ? entry : entry?.in
  // A workspace package resolves to its real source path, which has no
  // `node_modules` segment to key on — walk up to its manifest instead.
  const root =
    (first && request.packageName && vendorPackageRoot(first, request.packageName)) ??
    (first && nearestManifestDir(path.dirname(first)))
  if (!root) return { inline: new Map() }
  const key = `${root}\0${request.target}\0${request.conditionTarget}`
  let shape = vendorPackageShapes.get(key)
  if (!shape) {
    shape = { inline: new Map() }
    vendorPackageShapes.set(key, shape)
  }
  return shape
}

function nearestManifestDir(from: string) {
  if (nearestManifestDirs.has(from)) return nearestManifestDirs.get(from)
  let dir = from
  while (true) {
    const manifest = path.join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }
        if (typeof parsed.name === 'string') {
          nearestManifestDirs.set(from, dir)
          return dir
        }
      } catch {
        // Malformed manifests cannot establish a package root; continue walking.
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) {
      nearestManifestDirs.set(from, undefined)
      return undefined
    }
    dir = parent
  }
}

const nearestManifestDirs = new Map<string, string | undefined>()

/**
 * Decide what each external reference in the emitted code means - the work the resolve callbacks used
 * to do, off the bundler's critical path. Undefined when a reference cannot be expressed as a rewrite
 * (the caller then bails), or the set of specifiers that must be pulled back INSIDE the bundle.
 */
async function planVendorNativeRefs(
  request: VendorNativeRequest,
  metafile: Metafile,
  conditions: string[],
) {
  const imports = new Map<string, VendorRefTarget>()
  const requires = new Map<string, VendorRefTarget>()
  const inline = new Map<string, string>()
  const settled = new Set<string>()

  for (const [input, meta] of Object.entries(metafile.inputs)) {
    // Decisions are a property of the DIRECTORY an import sits in, never of the
    // file — so a package's several hundred modules all asking for `react`
    // decide once, and the answer is reused across builds.
    const importerFile = path.resolve(request.resolveDir, input)
    const importerDir = path.dirname(importerFile)
    for (const reference of meta.imports) {
      if (!reference.external) continue
      const specifier = reference.path
      const isRequire = reference.kind === 'require-call'
      const key = `${isRequire ? 'r' : 'i'}\0${specifier}\0${importerDir}`
      if (settled.has(key)) continue
      settled.add(key)

      // Same package. A subpath THIS build already emits is repointed at that artifact; a sibling on disk at
      // its own. Everything else becomes its own vendor demand rather than being inlined here - inlining is
      // what makes a package's shared graph get re-parsed once per subpath, the cost this whole pipeline
      // exists to remove. Request-scoped, so it sits in front of the shared decision cache.
      if (packageNameFromSpecifier(specifier) === request.packageName) {
        const sibling = request.siblings?.get(specifier)
        if (sibling) {
          if (!record(imports, specifier, { specifier: sibling, file: fileURLToPath(sibling) })) {
            return undefined
          }
          continue
        }
        const own = ownEntryArtifact(request, specifier, importerDir, conditions)
        if (own) {
          if (!record(imports, specifier, own)) return undefined
          continue
        }
        // A subpath nothing demanded: it comes back inside, as the plugin build
        // would have had it. Demanding it instead can close a cycle back onto
        // the artifact being built right now, which no scheduler can settle.
        const resolved = resolveVendorPackageSpecifier(
          request.config.root,
          path.join(importerDir, 'pnext-resolve.ts'),
          specifier,
          conditions,
        )
        if (!resolved) return undefined
        inline.set(specifier, resolved)
        continue
      }

      const decision = await (request.preplan
        ? preplanVendorRef(request, specifier, importerFile, isRequire, conditions)
        : decideVendorRef(request, specifier, importerFile, isRequire, conditions))
      if (!decision) return undefined
      if (decision.kind === 'keep') continue
      if (decision.kind === 'inline') {
        inline.set(specifier, decision.file)
        continue
      }
      if (decision.nested) request.context.nestedExternalFiles.push(decision.nested)
      if (!record(isRequire ? requires : imports, specifier, decision.target)) return undefined
    }
  }
  return { imports, requires, inline }
}

/**
 * The artifact THIS build is already emitting for a same-package specifier, if it is one of its entries. It
 * is not on disk yet - it is written the moment this build returns - so it is repointed without an existence
 * check.
 */
function ownEntryArtifact(
  request: VendorNativeRequest,
  specifier: string,
  importerDir: string,
  conditions: string[],
): VendorRefTarget | undefined {
  if (!request.ownEntries?.size) return undefined
  const entry = resolveVendorPackageSpecifier(
    request.config.root,
    path.join(importerDir, 'pnext-resolve.ts'),
    specifier,
    conditions,
  )
  const artifact = entry && request.ownEntries.get(entry)
  return artifact ? { specifier: pathToFileHref(artifact), file: artifact } : undefined
}

type VendorRefDecision =
  | { kind: 'keep' }
  /** Must be bundled: `file` is what an alias entry points the specifier at. */
  | { kind: 'inline'; file: string }
  | { kind: 'repoint'; target: VendorRefTarget; nested?: string }

/**
 * Decisions are pure in (layer, specifier, importing directory), and the same
 * handful of packages are imported from everywhere, so one answer serves every
 * build that meets the reference again. Without this the post-pass re-runs the
 * resolver work the plugin chain at least only did once per bundle.
 */
const vendorRefDecisions = new Map<string, Promise<VendorRefDecision | undefined>>()

/** Everything the plugin-free path learned about packages, forgotten. */
function clearVendorNativeCaches() {
  vendorRefDecisions.clear()
  vendorNativeBailed.clear()
  vendorPackageShapes.clear()
}

/**
 * Preplan replacement for `decideVendorRef`: the same classification from pure inputs only - no awaited child
 * builds, no facade exec. Anything it cannot settle purely returns undefined, bailing the whole package to
 * the plugin path. Cached beside the plugin-era decisions under a distinct key prefix.
 */
function preplanVendorRef(
  request: VendorNativeRequest,
  specifier: string,
  importerFile: string,
  isRequire: boolean,
  conditions: string[],
) {
  const importerDir = path.dirname(importerFile)
  const key = `p\0${request.target}\0${request.conditionTarget}\0${isRequire ? 'r' : 'i'}\0${specifier}\0${importerDir}`
  let decision = vendorRefDecisions.get(key)
  if (!decision) {
    decision = preplanVendorRefUncached(request, specifier, importerFile, isRequire, conditions)
    vendorRefDecisions.set(key, decision)
  }
  return decision
}

async function preplanVendorRefUncached(
  request: VendorNativeRequest,
  specifier: string,
  importerFile: string,
  isRequire: boolean,
  conditions: string[],
): Promise<VendorRefDecision | undefined> {
  const { config, target } = request
  const importerDir = path.dirname(importerFile)
  const keep = { kind: 'keep' } as const
  const depName = packageNameFromSpecifier(specifier)
  if (depName && (builtinModules.includes(depName) || isBunBuiltin(depName))) return keep
  // Require-of-external is the async-interop shape that 500ed; not this class.
  if (isRequire) return undefined
  if (aliasSpecifierFilter.test(specifier)) {
    const resolved = coreAliases(config, target)[specifier] ?? firstAliasForSpecifier(specifier)
    if (!resolved) return undefined
    if (!path.isAbsolute(resolved)) return keep
    return { kind: 'repoint', target: { specifier: pathToFileHref(resolved), file: resolved } }
  }
  if (serverIgnoredAssetFilter.test(specifier)) {
    const asset = resolveVendorPackageSpecifier(
      config.root,
      path.join(importerDir, 'pnext-resolve.ts'),
      specifier,
      conditions,
    )
    return asset ? { kind: 'inline', file: asset } : undefined
  }
  if (sameVendorPackageFile(specifier, importerFile)) {
    return { kind: 'inline', file: canonicalVendorEntry(specifier)! }
  }
  if (!isVendorModuleSpecifier(specifier)) return undefined
  if (depName && getExternalPackagePolicy().external(depName)) {
    const fromImporter = resolveNestedPackageFromImporter(importerFile, specifier, conditions)
    const fromRoot = resolveVendorPackageSpecifier(
      config.root,
      path.join(config.root, 'pnext-resolve.ts'),
      specifier,
      conditions,
    )
    if (!fromImporter || fromImporter === fromRoot) return keep
    return {
      kind: 'repoint',
      target: { specifier: fromImporter, file: fromImporter },
      nested: fromImporter,
    }
  }
  const planned = await preplanDependencyDecision(
    config,
    target,
    request.conditionTarget,
    specifier,
    importerDir,
  )
  if (!planned?.path) return undefined
  return {
    kind: 'repoint',
    target: { specifier: planned.path, file: fileURLToPath(planned.path) },
  }
}

function decideVendorRef(
  request: VendorNativeRequest,
  specifier: string,
  importerFile: string,
  isRequire: boolean,
  conditions: string[],
) {
  const importerDir = path.dirname(importerFile)
  const key = `${request.target}\0${request.conditionTarget}\0${isRequire ? 'r' : 'i'}\0${specifier}\0${importerDir}`
  let decision = vendorRefDecisions.get(key)
  if (!decision) {
    decision = decideVendorRefUncached(request, specifier, importerFile, isRequire, conditions)
    vendorRefDecisions.set(key, decision)
  }
  return decision
}

async function decideVendorRefUncached(
  request: VendorNativeRequest,
  specifier: string,
  importerFile: string,
  isRequire: boolean,
  conditions: string[],
): Promise<VendorRefDecision | undefined> {
  const { config, target, conditionTarget } = request
  const importerDir = path.dirname(importerFile)
  const keep = { kind: 'keep' } as const
  const depName = packageNameFromSpecifier(specifier)
  if (depName && (builtinModules.includes(depName) || isBunBuiltin(depName))) return keep

  // Framework aliases. A require-call reads the react-server layer — a package
  // probing `'useState' in require('react')` must see false — so the two kinds
  // of reference to one specifier are repointed separately.
  if (aliasSpecifierFilter.test(specifier)) {
    const resolved = coreAliases(config, target)[specifier] ?? firstAliasForSpecifier(specifier)
    if (!resolved) return undefined
    if (isRequire) {
      // A CommonJS shim swap (`next/navigation` -> navigation.cjs) is the one
      // alias the plugin BUNDLES; leave that build to the plugin.
      if (serverRequireAlias(specifier, resolved, 'require-call') !== resolved) return undefined
      const layerAliases =
        target === 'server' ? getImportAliasExtensions().reactServerLayerAliases(config) : undefined
      const layer = layerAliases?.[specifier] ?? resolved
      const file = path.isAbsolute(layer) ? layer : require.resolve(layer)
      return { kind: 'repoint', target: { specifier: file, file } }
    }
    if (!path.isAbsolute(resolved)) return keep
    return { kind: 'repoint', target: { specifier: pathToFileHref(resolved), file: resolved } }
  }

  // An asset the bundler externalized (a cross-package CSS import) has to come
  // back inside, where `loader: empty` stubs it.
  if (serverIgnoredAssetFilter.test(specifier)) {
    const asset = resolveVendorPackageSpecifier(
      config.root,
      path.join(importerDir, 'pnext-resolve.ts'),
      specifier,
      conditions,
    )
    return asset ? { kind: 'inline', file: asset } : undefined
  }
  if (sameVendorPackageFile(specifier, importerFile)) {
    return { kind: 'inline', file: canonicalVendorEntry(specifier)! }
  }
  if (!isVendorModuleSpecifier(specifier)) return undefined

  // B7: a serverExternalPackage stays external, pinned to the importing
  // package's own copy when that differs from the hoisted root version.
  if (depName && getExternalPackagePolicy().external(depName)) {
    const fromImporter = resolveNestedPackageFromImporter(importerFile, specifier, conditions)
    const fromRoot = resolveVendorPackageSpecifier(
      config.root,
      path.join(config.root, 'pnext-resolve.ts'),
      specifier,
      conditions,
    )
    if (!fromImporter || fromImporter === fromRoot) return keep
    return {
      kind: 'repoint',
      target: { specifier: fromImporter, file: fromImporter },
      nested: fromImporter,
    }
  }

  const resolvedEntry = resolveVendorPackageSpecifier(
    config.root,
    path.join(importerDir, 'pnext-resolve.ts'),
    specifier,
    conditions,
  )
  // A CommonJS dependency loses its named exports when externalized, so it is
  // inlined unless a verified facade can republish them.
  const commonJs = Boolean(resolvedEntry) && !isEsmModuleEntry(resolvedEntry!)
  if (commonJs && !(await cjsEntryMayHaveNamedExports(resolvedEntry!))) {
    return { kind: 'inline', file: resolvedEntry! }
  }
  let vendored: string
  const tv = performance.now()
  try {
    vendored = await externalServerPackageHref(
      config,
      specifier,
      target,
      importerDir,
      conditionTarget,
      // Raised from inside a running build: must not queue behind it.
      true,
    )
  } catch (error) {
    if (isResolveFailure(error)) return keep
    return undefined
  }
  if (vendorTraceEnabled()) {
    vendorTraceRow({
      kind: 'edge',
      from: request.packageName ?? '?',
      fromTarget: target,
      fromCondition: conditionTarget,
      to: specifier,
      toResolveDir: importerDir,
    })
  }
  if (commonJs) {
    heavyProfRow({ k: 'dep-build-wait', site: 'ref', spec: specifier, ms: performance.now() - tv })
    const tf = performance.now()
    const facade = await cjsNamedExportFacade(fileURLToPath(vendored), vendored)
    heavyProfRow({ k: 'facade-wait', site: 'ref', spec: specifier, ms: performance.now() - tf })
    if (!facade) return { kind: 'inline', file: resolvedEntry! }
    return {
      kind: 'repoint',
      target: { specifier: pathToFileHref(facade), file: facade },
    }
  }
  return {
    kind: 'repoint',
    target: { specifier: vendored, file: fileURLToPath(vendored) },
  }
}

/**
 * Record one specifier's target. A chunk mixes importers, so a specifier that two importers resolve
 * DIFFERENTLY (a pinned nested version for one of them) cannot be rewritten in place - that is a bail, not a
 * choice.
 */
function record(targets: Map<string, VendorRefTarget>, specifier: string, target: VendorRefTarget) {
  const existing = targets.get(specifier)
  if (existing) return existing.specifier === target.specifier
  targets.set(specifier, target)
  return true
}

async function writeExternalServerPackageBundle(
  config: ResolvedConfig,
  specifier: string,
  target: CompatAliasTarget,
  resolveDir: string,
  file: string,
  conditionTarget: ServerBundleTarget,
  nested: boolean,
) {
  const context = { nestedExternalFiles: [] as string[] }
  // The layer is part of the label: the same specifier legitimately compiles
  // once per target, and a profile that cannot tell those apart reads as
  // duplication that is not there.
  const bundled = await profileRuntimeStep(
    `vendor bundle ${specifier} [${target}/${conditionTarget}]`,
    () =>
      bundleExternalPackage(
        config,
        specifier,
        target,
        resolveDir,
        conditionTarget,
        context,
        file,
        nested,
      ),
  )
  // Packages can ship 'use cache' functions too (Next allows it); client
  // bundles keep the source untouched.
  const code =
    target === 'server' ? applyBundledSourceTransforms(bundled.code, specifier) : bundled.code
  const id = await writeVendorArtifact(file, code)
  recordVendorLayerBuild(
    config,
    resolveVendorEntry(config, specifier, resolveDir, conditionTarget),
    target,
    conditionTarget,
    bundled.metafile,
    code,
    id,
  )
  // When this vendor bundle pins a transitive external to a nested version distinct from the hoisted root
  // copy, Node/webpack file tracing surfaces that dependency's source as a `.js` artifact in the server
  // output. Emit a `.js` trace copy of each such source so build tooling that scans `**/*.js` - never `.mjs` -
  // observes the bundled transitive too. These are trace artifacts only; nothing imports them.
  await emitNestedExternalTraceCopies(file, context.nestedExternalFiles)
  return file
}

/** Trace-only side channel: what the esbuild pass that produced the code did. */
interface VendorBuildTrace {
  plugins: string[]
  entry?: string
  metafile?: Metafile
}

/** Emit one JSONL build row from a finished (or failed) vendor esbuild pass. */
function traceVendorBuild(row: {
  seq: number
  specifier: string
  resolveDir: string
  target: string
  conditionTarget: ServerBundleTarget
  conditions: string[]
  startMs: number
  outBytes: number
  trace: VendorBuildTrace
  ok: boolean
  error?: string
}) {
  const inputs = row.trace.metafile?.inputs ?? {}
  const inputFiles = Object.keys(inputs)
  const endMs = performance.now()
  vendorTraceRow({
    seq: row.seq,
    specifier: row.specifier,
    resolveDir: row.resolveDir,
    target: row.target,
    conditionTarget: row.conditionTarget,
    entry: row.trace.entry,
    conditions: row.conditions,
    startMs: row.startMs,
    endMs,
    ms: endMs - row.startMs,
    inputCount: inputFiles.length,
    inputBytes: inputFiles.reduce((sum, input) => sum + (inputs[input]?.bytes ?? 0), 0),
    inputFiles,
    outBytes: row.outBytes,
    plugins: row.trace.plugins,
    ok: row.ok,
    ...(row.error ? { error: row.error } : {}),
  })
}

async function bundleExternalPackage(
  config: ResolvedConfig,
  specifier: string,
  target: CompatAliasTarget,
  resolveDir: string,
  conditionTarget: ServerBundleTarget,
  context?: { nestedExternalFiles: string[] },
  /** The artifact this bundle becomes — the plugin-free path's identity. */
  file?: string,
  nested = false,
) {
  if (!vendorTraceEnabled()) {
    return bundleExternalPackageImpl(
      config,
      specifier,
      target,
      resolveDir,
      conditionTarget,
      context,
      file,
      nested,
    )
  }
  const trace: VendorBuildTrace = { plugins: [] }
  const seq = nextVendorTraceSeq()
  const startMs = performance.now()
  const common = {
    seq,
    specifier,
    resolveDir,
    target,
    conditionTarget,
    conditions: serverBundleConditions(conditionTarget),
    startMs,
    trace,
  }
  try {
    const result = await bundleExternalPackageImpl(
      config,
      specifier,
      target,
      resolveDir,
      conditionTarget,
      context,
      file,
      nested,
      trace,
    )
    traceVendorBuild({ ...common, outBytes: result.code.length, ok: true })
    return result
  } catch (error) {
    traceVendorBuild({
      ...common,
      outBytes: 0,
      ok: false,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
    })
    throw error
  }
}

async function bundleExternalPackageImpl(
  config: ResolvedConfig,
  specifier: string,
  target: CompatAliasTarget,
  resolveDir: string,
  conditionTarget: ServerBundleTarget,
  context?: { nestedExternalFiles: string[] },
  /** The artifact this bundle becomes — the plugin-free path's identity. */
  file?: string,
  nested = false,
  trace?: VendorBuildTrace,
) {
  const packageName = packageNameFromSpecifier(specifier)
  const resolvedEntry = resolveVendorPackageSpecifier(
    config.root,
    path.join(resolveDir, 'pnext-resolve.ts'),
    specifier,
    serverBundleConditions(conditionTarget),
  )
  const requiredEntry =
    resolvedEntry &&
    !isEsmModuleFile(resolvedEntry) &&
    getExternalPackagePolicy().esmExternals() === true
      ? resolveVendorPackageSpecifier(
          config.root,
          path.join(resolveDir, 'pnext-resolve.ts'),
          specifier,
          serverBundleRequireConditions(conditionTarget),
        )
      : undefined
  if (
    packageName &&
    resolvedEntry?.match(/\.[cm]?tsx?$/) &&
    !getExternalPackagePolicy().transpile(packageName)
  ) {
    const parseFailure = `${path.relative(config.root, resolvedEntry)}\nModule parse failed: Unexpected token`
    // Printed directly as well: the digest log path inspects the error's stack,
    // which some runtimes emit without the message - the CLI output must always
    // carry the parse failure (Next's transpilePackages error contract).
    console.error(`⨯ Error: ${parseFailure}`)
    throw new Error(parseFailure)
  }
  const entry =
    requiredEntry ??
    resolveLinkedPackageSpecifier(
      config.root,
      path.join(resolveDir, 'pnext-resolve.ts'),
      specifier,
      serverBundleConditions(conditionTarget),
    ) ??
    specifier
  // `packages: 'external'` refuses to bundle a BARE entry point, so the
  // plugin-free path needs the resolved file — which is the same file esbuild
  // would have resolved the specifier to.
  const nativeEntry = path.isAbsolute(entry) ? entry : resolvedEntry
  if (trace) trace.entry = nativeEntry ?? resolvedEntry
  const preplan =
    vendorPreplanEnabled() &&
    (await vendorPreplanPackageSafe(
      config,
      packageName,
      nativeEntry ?? resolvedEntry,
      target,
      conditionTarget,
    ))
  const native =
    file && nativeEntry
      ? await buildVendorNative({
          preplan,
          config,
          target,
          conditionTarget,
          resolveDir,
          bailKey: file,
          packageName,
          entryPoints: [nativeEntry],
          splitting: false,
          ownEntries: new Map([[nativeEntry, file]]),
          isEntry: () => true,
          soloFile: file,
          nested,
          context: context ?? { nestedExternalFiles: [] },
          trace,
        })
      : undefined
  if (native?.[0]) return { code: addCommonJsNamedExports(native[0].text), metafile: undefined }

  let bundled: string
  let metafile: Metafile | undefined
  const pluginStart = performance.now()
  const vendorPlugins = profiledVendorPlugins([
    serverAssetPlugin(config),
    ...getBundlerExtensions().serverEsbuildPlugins(
      config,
      vendorPluginOptions(config, target, conditionTarget),
    ),
    runtimeAliasBuildPlugin(config, target, {
      bundleRequireAliases: true,
      // The server vendor bundle IS the react-server layer (client-target
      // bundles are the SSR pass and keep the full-hooks shim).
      reactServerLayer: target === 'server',
    }),
    externalPackageDependencyPlugin(
      config,
      specifier,
      target,
      conditionTarget,
      resolveDir,
      nativeEntry ? [nativeEntry] : [],
      context,
      preplan,
    ),
    externalBuiltinBuildPlugin(),
  ])
  if (trace) trace.plugins = vendorPlugins.map(plugin => plugin.name)
  // Bare entry: hand the interop plugin the resolution already computed above.
  if (!path.isAbsolute(entry) && resolvedEntry) {
    provideEntryResolution(entry, resolveDir, resolvedEntry)
  }
  try {
    const result = await build({
      entryPoints: [
        getBundlerExtensions().serverBundleEntry(
          entry,
          resolveDir,
          path.isAbsolute(entry) ? entry : resolvedEntry,
        ) ?? entry,
      ],
      absWorkingDir: resolveDir,
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      conditions: serverBundleConditions(conditionTarget),
      mainFields: ['module', 'main'],
      loader: packageJsxLoaders,
      jsx: 'automatic',
      jsxImportSource: 'preact',
      logLevel: 'silent',
      // The verdict is computed offline from this, after the build settles.
      metafile: true,
      ...serverDefineOptions(),
      plugins: vendorPlugins,
    })
    const output = result.outputFiles[0]
    if (!output) throw new Error(`Failed to bundle ${specifier}`)
    vendorNativeStats.pluginBuilds += 1
    vendorNativeStats.pluginBuildMs += performance.now() - pluginStart
    bundled = output.text
    metafile = result.metafile
    if (trace) trace.metafile = result.metafile
  } catch (error) {
    // A subpath the package deliberately withholds from this layer
    // (`"node": null`) is not a broken dependency: browser-only code reaches it
    // behind a `typeof window` guard that never runs on the server, and Next's
    // server compilers drop that branch before their resolver ever sees it.
    // Vending a module that throws Node's own error keeps the guarded import
    // out of the build while still failing loudly if anything evaluates it.
    if (
      !isPackageSubpathUnexported(
        config.root,
        path.join(resolveDir, 'pnext-resolve.ts'),
        specifier,
        serverBundleConditions(conditionTarget),
      )
    ) {
      throw error
    }
    return { code: unexportedSubpathModule(specifier), metafile: undefined }
  }
  return { code: addCommonJsNamedExports(bundled), metafile }
}

function unexportedSubpathModule(specifier: string) {
  const packageName = packageNameFromSpecifier(specifier)
  const subpath =
    packageName && specifier !== packageName ? `.${specifier.slice(packageName.length)}` : '.'
  const message = `Package subpath '${subpath}' is not defined by "exports" in ${packageName ?? specifier}`
  return `throw Object.assign(new Error(${JSON.stringify(message)}), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });\n`
}

function externalPackageDependencyPlugin(
  config: ResolvedConfig,
  entrySpecifier: string,
  target: CompatAliasTarget,
  conditionTarget: ServerBundleTarget,
  resolveDir: string,
  ownEntries: string[],
  context?: { nestedExternalFiles: string[] },
  preplan = false,
): Plugin {
  const entryPackageName = packageNameFromSpecifier(entrySpecifier)
  const ownPackageRoots = new Set(
    [...ownEntries, resolveVendorEntry(config, entrySpecifier, resolveDir, conditionTarget)]
      .filter((entry): entry is string => entry !== undefined)
      .map(entry => nearestManifestDir(path.dirname(canonicalVendorEntry(entry)!)))
      .filter((root): root is string => root !== undefined),
  )
  return {
    name: 'pnext-external-package-dependencies',
    setup(build) {
      build.onResolve({ filter: /^(?:\/|[^./]).*/ }, async args => {
        if (!isVendorModuleSpecifier(args.path)) return undefined
        if (args.kind === 'entry-point') return undefined
        const ownRoot = path.isAbsolute(args.path)
          ? nearestManifestDir(path.dirname(canonicalVendorEntry(args.path)!))
          : undefined
        if (ownRoot && ownPackageRoots.has(ownRoot)) return undefined
        if (sameVendorPackageFile(args.path, args.importer)) return undefined
        if (entryPackageName && packageNameFromSpecifier(args.path) === entryPackageName) {
          return undefined
        }
        if (preplan && args.kind !== 'require-call') {
          const planned = await preplanDependencyDecision(
            config,
            target,
            conditionTarget,
            args.path,
            args.resolveDir,
          )
          if (planned) {
            vendorPreplanStats.preplanRefs += 1
            return planned
          }
          vendorPreplanStats.fallbackRefs += 1
        }
        // Off the slot for the whole decision: it ends in a nested vendor
        // build, and holding a worker across that is what caps real
        // parallelism at dependency depth (`PNEXT_VENDOR_YIELD=0` pins the old
        // behaviour for bisecting). The resolver work in front of it is cheap
        // and off-slot too, exactly as the plugin-free path's post-pass runs it.
        const decision = await yieldVendorSlotWhile(() =>
          externalDependencyDecision(
            config,
            target,
            conditionTarget,
            args.path,
            args.resolveDir,
            args.importer,
          ),
        )
        if (decision?.vendored && vendorTraceEnabled()) {
          vendorTraceRow({
            kind: 'edge',
            from: entrySpecifier,
            fromTarget: target,
            fromCondition: conditionTarget,
            to: args.path,
            toResolveDir: args.resolveDir,
          })
        }
        if (decision?.nested && context) context.nestedExternalFiles.push(decision.nested)
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        if (decision?.error) throw decision.error
        return decision?.result
      })
    },
  }
}

/** What one external reference resolves to, plus the effects the caller replays. */
interface ExternalDependencyDecision {
  result: OnResolveResult | undefined
  /** A transitive dep pinned to a nested copy, for the trace-copy pass. */
  nested?: string
  /** A build failure, re-thrown per caller rather than cached as a value. */
  error?: unknown
  /** Trace-only: the dep was deferred to a vendor bundle of its own. */
  vendored?: boolean
}

/**
 * NOT memoized on (layer, specifier, importing directory), though it looks pure in them: the answer
 * also depends on what is on disk when it is asked - `externalServerPackageHref` re-checks its
 * artifact's liveness per demand, and the facade gate re-executes a bundle that may have been
 * replaced. Caching it lost `app-external` outright, so the seam stays as the plugin chain had it.
 */
async function externalDependencyDecision(
  config: ResolvedConfig,
  target: CompatAliasTarget,
  conditionTarget: ServerBundleTarget,
  specifier: string,
  resolveDir: string,
  importer: string | undefined,
): Promise<ExternalDependencyDecision> {
  // B7: a serverExternalPackage transitive dep stays external (Node resolves it
  // from node_modules at runtime) instead of being bundled.
  const depName = packageNameFromSpecifier(specifier)
  if (depName && getExternalPackagePolicy().external(depName)) {
    // Transitive-version correctness: the runtime resolves a bare external from the VENDOR bundle's own
    // location, which walks up to the hoisted root copy - wrong when the importing package pulls a distinct
    // nested version (pnpm virtual store, npm nesting). Resolve the dep from the IMPORTING package's real
    // path here, at build time, and when that is a copy distinct from the hoisted root version, pin the
    // external to that exact resolved file so the correct version loads at runtime. A hoisted dep stays a
    // portable bare external. Bundling the nested copy inline instead regresses to a resolve ERROR for the
    // bundle's other bare externals, so keep it external and only pin the path.
    const conditions = serverBundleConditions(conditionTarget)
    const fromImporter = importer
      ? resolveNestedPackageFromImporter(importer, specifier, conditions)
      : undefined
    const fromRoot = resolveVendorPackageSpecifier(
      config.root,
      path.join(config.root, 'pnext-resolve.ts'),
      specifier,
      conditions,
    )
    if (fromImporter && fromImporter !== fromRoot) {
      return { result: { path: fromImporter, external: true }, nested: fromImporter }
    }
    return { result: { path: specifier, external: true } }
  }
  const resolvedEntry = resolveVendorPackageSpecifier(
    config.root,
    path.join(resolveDir, 'pnext-resolve.ts'),
    specifier,
    serverBundleConditions(conditionTarget),
  )
  // A CommonJS dependency loses its named exports when externalized (esbuild emits only `default` for a CJS
  // entry), so it is inlined here instead. `isEsmModuleEntry` first checks CONTENT, not just extension and
  // `package.json#type` - most "CJS" entries are plain-.js ESM and inline for no reason. What is left gets a
  // verified named-export facade when it publishes names, and is inlined only when it does not.
  const commonJs = Boolean(resolvedEntry) && !isEsmModuleEntry(resolvedEntry!)
  if (commonJs && !(await cjsEntryMayHaveNamedExports(resolvedEntry!))) return { result: undefined }
  let resolvedPackage: string
  const tv = performance.now()
  try {
    resolvedPackage = await externalServerPackageHref(
      config,
      specifier,
      target,
      resolveDir,
      conditionTarget,
      // Raised from inside a running build: must not queue behind it.
      true,
    )
  } catch (error) {
    if (isResolveFailure(error)) return { result: { path: specifier, external: true } }
    return { result: undefined, error }
  }
  if (commonJs) {
    heavyProfRow({
      k: 'dep-build-wait',
      site: 'plugin',
      spec: specifier,
      ms: performance.now() - tv,
    })
    const tf = performance.now()
    const facade = await cjsNamedExportFacade(fileURLToPath(resolvedPackage), resolvedPackage)
    heavyProfRow({ k: 'facade-wait', site: 'plugin', spec: specifier, ms: performance.now() - tf })
    if (!facade) return { result: undefined }
    return { result: { path: pathToFileHref(facade), external: true }, vendored: true }
  }
  return { result: { path: resolvedPackage, external: true }, vendored: true }
}

/** `PNEXT_VENDOR_YIELD=0` keeps the slot across a nested dependency's build. */
function yieldVendorSlotWhile<T>(task: () => Promise<T>) {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  return process.env.PNEXT_VENDOR_YIELD === '0' ? task() : outsideVendorSlot(task)
}

function isResolveFailure(error: unknown) {
  const details = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  return details.includes('Could not resolve')
}

async function profileRuntimeStep<T>(label: string, task: () => Promise<T>) {
  if (!traceEnabled('server')) return task()
  const start = performance.now()
  try {
    return await task()
  } finally {
    console.log(`dev-profile compat ${label} in ${formatDuration(performance.now() - start)}`)
  }
}

function externalBuiltinBuildPlugin(): Plugin {
  return {
    name: 'pnext-external-builtins',
    setup(build) {
      build.onResolve({ filter: /^[^./].*/ }, args => {
        const packageName = packageNameFromSpecifier(args.path)
        if (!packageName || (!builtinModules.includes(packageName) && !isBunBuiltin(packageName))) {
          return undefined
        }
        return { path: args.path, external: true }
      })
    },
  }
}

function isBunBuiltin(specifier: string) {
  return specifier === 'bun' || specifier.startsWith('bun:')
}

export function runtimeImportTarget(specifier: string, format: 'esm' | 'cjs' = 'esm') {
  if (isRelativeOrAbsoluteSpecifier(specifier)) return specifier
  const target = firstAliasForSpecifier(specifier)
  if (!target) return specifier
  return format === 'esm' ? pathToFileHref(target) : target
}

export function runtimeServerImportTarget(specifier: string) {
  return runtimeImportTarget(specifier, 'esm')
}

function isRelativeOrAbsoluteSpecifier(specifier: string) {
  return specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:')
}

function isPackageSpecifier(specifier: string) {
  if (isRelativeOrAbsoluteSpecifier(specifier)) return false
  if (specifier.startsWith('#')) return false
  if (specifier.startsWith('node:')) return false
  if (specifier.includes(':')) return false
  const packageName = packageNameFromSpecifier(specifier)
  return Boolean(packageName && !builtinModules.includes(packageName))
}

function isVendorModuleSpecifier(specifier: string) {
  return path.isAbsolute(specifier) || isPackageSpecifier(specifier)
}

function sameVendorPackageFile(specifier: string, importer: string) {
  if (!path.isAbsolute(specifier) || !path.isAbsolute(importer)) return false
  const entryRoot = nearestManifestDir(path.dirname(canonicalVendorEntry(specifier)!))
  const importerRoot = nearestManifestDir(path.dirname(canonicalVendorEntry(importer)!))
  return entryRoot !== undefined && entryRoot === importerRoot
}

// Trace copies of nested transitive externals (a version distinct from the
// hoisted root copy) written alongside the vendor bundle as `.js`, so file
// tracing / server-bundle scans observe the bundled dependency the way
// webpack's bundled transitive would appear. Trace-only: never imported.
async function emitNestedExternalTraceCopies(vendorFile: string, sources: readonly string[]) {
  const dir = path.dirname(vendorFile)
  for (const source of new Set(sources)) {
    try {
      const content = await readFile(source, 'utf8')
      const out = path.join(dir, `${hashBundleSpecifier(source)}.trace.js`)
      if (!existsSync(out)) await writeFileAtomic(out, content)
    } catch {
      // A source that cannot be read is simply not traced.
    }
  }
}

function packageNameFromSpecifier(specifier: string) {
  const normalized = specifier.startsWith('node:') ? specifier.slice(5) : specifier
  const parts = normalized.split('/')
  return normalized.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}
