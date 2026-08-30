/**
 * The ESM loader: Bun module-resolve/load plugin registration for the app's own source (and its
 * node_modules-relative requires), plus the on-demand transform pipeline (source rewrites, CJS
 * sidecar generation) that feeds compiled code to those plugins. The alias-resolution and
 * asset-stub helpers here are shared with vendor package bundling in `./vendor-build`, which
 * imports them; this module never imports from `./vendor-build`.
 */

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Loader, Plugin } from 'esbuild'
import { build, transform } from '../utils/esbuild'
import {
  applyBundledSourceTransforms,
  applyServerSourcePreTransforms,
  applyServerSourceTransforms,
  extraLoadableExtensions,
  getAssetExtensions,
  getBundlerExtensions,
  getCssExtensions,
  getImportAliasExtensions,
  onLoadableExtensionsChanged,
  serverDefineOptions,
  sourceNeedsServerTransforms,
} from '../extensions'
import {
  frameworkRuntimeAliasEntries,
  pathToFileHref,
  pnextAliases,
  type CompatAliasTarget,
  type ResolvedConfig,
} from '../config'
import {
  rewriteDynamicCallTargets,
  rewriteLiteralDynamicCalls,
  sourceHasDynamicImport,
} from '../resolve/dynamic'
import { cacheRoot } from './module-cache'
import { frameworkFingerprint } from './fingerprint'
import { readNodeModuleBundle, writeNodeModuleBundle } from '../dev/restart/node-modules'
import { setBasePathPrefix, setDefaultPrefetchMode, setTrailingSlashUrls } from '../routing/href'
import { resolveExternalLoadTarget, resolveImport, workspacePackageRoots } from '../resolve/imports'
import { escapeRegex } from '../utils/code'
import { traceEnabled } from '../utils/trace-flags'
import { writeFileAtomic } from '../utils/fs'

const require = createRequire(import.meta.url)

// B4/B5: extra esbuild resolve conditions layered onto the server (RSC) vendor
// bundle. Core always applies `react-server` (the server graph IS the RSC
// layer). Compat can add `next-js` (only when cacheComponents is on) via the
// setter. Kept as a module-level seam so core carries no static edge into
// compat's config reader.
export type ServerBundleTarget =
  CompatAliasTarget | 'edge' | 'pages-api' | 'pages-api-edge' | 'pages' | 'pages-edge'

let extraServerBundleConditions: (target: ServerBundleTarget) => string[] = () => []

/** Install compat-driven extra vendor-bundle conditions (B5 `next-js`). */
export function setServerBundleConditions(
  factory: ((target: ServerBundleTarget) => string[]) | undefined,
): void {
  extraServerBundleConditions = factory ?? (() => [])
}

export function serverBundleTargetForRuntime(runtime: string | undefined): ServerBundleTarget {
  return runtime === 'edge' || runtime === 'experimental-edge' ? 'edge' : 'server'
}

export function pagesApiBundleTargetForRuntime(runtime: string | undefined): ServerBundleTarget {
  return runtime === 'edge' || runtime === 'experimental-edge' ? 'pages-api-edge' : 'pages-api'
}

/**
 * Pages-router PAGE SSR layer: Next compiles it in the server bundle with `node` (or
 * `edge-light`/`browser` for edge) export conditions but WITHOUT `react-server` - a pages page is
 * not part of the RSC layer, so `library/react`-style react-server splits must resolve to `default`.
 */
export function pagesBundleTargetForRuntime(runtime: string | undefined): ServerBundleTarget {
  return runtime === 'edge' || runtime === 'experimental-edge' ? 'pages-edge' : 'pages'
}

export function serverBundleConditions(target: ServerBundleTarget): string[] {
  // Preserve the original client-target conditions (module/import) to avoid
  // regressing the browser SSR vendor bundle; only the RSC/server layer gains
  // `react-server`. Compat-added conditions (next-js) prepend for either target.
  const base =
    target === 'client'
      ? ['module', 'import']
      : target === 'edge'
        ? ['react-server', 'edge-light', 'browser', 'module', 'import']
        : target === 'pages-api-edge'
          ? ['edge-light', 'browser', 'module', 'import']
          : target === 'pages-api'
            ? ['node', 'require', 'import']
            : target === 'pages-edge'
              ? ['edge-light', 'browser', 'module', 'import']
              : target === 'pages'
                ? ['node', 'module', 'import']
                : ['react-server', 'node', 'module', 'import']
  return [...new Set([...extraServerBundleConditions(target), ...base])]
}

export function serverBundleRequireConditions(target: ServerBundleTarget): string[] {
  const base =
    target === 'client'
      ? ['module', 'require']
      : target === 'edge'
        ? ['react-server', 'edge-light', 'browser', 'module', 'require']
        : target === 'pages-api-edge'
          ? ['edge-light', 'browser', 'module', 'require']
          : target === 'pages-api'
            ? ['node', 'require']
            : target === 'pages-edge'
              ? ['edge-light', 'browser', 'module', 'require']
              : target === 'pages'
                ? ['node', 'module', 'require']
                : ['react-server', 'node', 'module', 'require']
  return [...new Set([...extraServerBundleConditions(target), ...base])]
}

const runtimeConfigs = new Map<string, RuntimeConfig>()
const aliasCache = new WeakMap<ResolvedConfig, Map<string, string>>()
const packageRootCache = new WeakMap<ResolvedConfig, string[]>()
const registeredSignatures = new WeakMap<ResolvedConfig, Set<string>>()
const rootPathCache = new Map<string, string[]>()
const runtimeConfigLookupCache = new Map<string, RuntimeConfig | null>()
const firstAliasCache = new Map<string, string | null>()
const transformCache = new Map<string, TransformCacheEntry>()
const pendingTransforms = new Map<string, Promise<string>>()
const nodeModuleTransformCache = new Map<string, TransformCacheEntry>()
// Freshness of generated `.pnext-require.cjs` sidecars (see inlineModuleScopeRequires).
const requireSidecarCache = new Map<string, { mtimeMs: number; size: number }>()
const registeredLoadRoots = new Set<string>()
let resolveRegistered = false
let nodeModulesLoadRegistered = false
// A live Bun.plugin forces every later import through the plugin pipeline (and
// pnext's own src through transformSource), so importing the compat graph with
// the plugins already up costs ~5x. build/start load compat before they ever
// register a runtime; dev arms the plugins on the first request instead.
let pluginsDeferred = false
const deferredPluginRoots = new Set<string>()

export const packageJsxLoaders = {
  '.js': 'jsx',
  '.mjs': 'jsx',
  '.cjs': 'jsx',
} satisfies Record<string, Loader>

interface RuntimeConfig {
  root: string
  roots: Set<string>
  aliases: Map<string, string>
  /** Full resolved config, so compile sites can invoke config-aware extensions. */
  resolved: ResolvedConfig
  missingImportError: (specifier: string) => string | undefined
}

interface TransformCacheEntry {
  mtimeMs: number
  size: number
  code: string
}

export function registerServerRuntime(config: ResolvedConfig, sourceFiles: string[] = []) {
  // Server-rendered Links emit canonical (slashed) hrefs under trailingSlash.
  setTrailingSlashUrls(Boolean(config.trailingSlash))
  // File-convention metadata asset hrefs (og-image, manifest) carry the
  // basePath prefix; core render reads it through the href seam.
  setBasePathPrefix(typeof config.basePath === 'string' ? config.basePath : '')
  // Server-rendered Links bake the configured default into `data-prefetch`.
  setDefaultPrefetchMode(config.prefetch)
  if (typeof Bun === 'undefined') return
  const sourceRoots = [...new Set(sourceFiles.map(file => sourceRootForFile(config, file)))].sort()
  const signature = sourceRoots.join('\0')
  let registered = registeredSignatures.get(config)
  if (!registered) {
    registered = new Set()
    registeredSignatures.set(config, registered)
  }
  if (registered.has(signature)) return
  registered.add(signature)

  const aliases = aliasesForConfig(config)
  const roots = [
    ...rootPaths(config.appPath),
    ...rootPaths(path.join(config.outPath, 'cache', 'server')),
    // The pnext src root, so the framework's own source transforms too.
    ...rootPaths(path.join(import.meta.dirname, '..')),
    ...sourceRoots.flatMap(rootPaths),
  ]
  const key = rootPaths(config.appPath).join('\0')
  const missingImportError = (specifier: string) =>
    getImportAliasExtensions().missingImportError(config, specifier)
  const existing = runtimeConfigs.get(key)
  if (existing) {
    for (const root of roots) existing.roots.add(root)
    for (const [specifier, target] of aliases) existing.aliases.set(specifier, target)
    existing.resolved = config
    existing.missingImportError = missingImportError
  } else {
    runtimeConfigs.set(key, {
      root: config.root,
      roots: new Set(roots),
      aliases: new Map(aliases),
      resolved: config,
      missingImportError,
    })
  }
  runtimeConfigLookupCache.clear()
  firstAliasCache.clear()
  if (pluginsDeferred) {
    for (const root of roots) deferredPluginRoots.add(root)
    return
  }
  registerResolvePlugin()
  registerNodeModulesLoadPlugin()
  for (const root of roots) registerLoadPlugin(root)
}

/**
 * Hold the Bun module plugins back until installServerRuntimePlugins() runs, so
 * whatever the process still has to import of its own code loads natively.
 */
export function deferServerRuntimePlugins(): void {
  pluginsDeferred = true
}

/** Arm the plugins deferServerRuntimePlugins() held back. Idempotent, cheap. */
export function installServerRuntimePlugins(): void {
  if (!pluginsDeferred) return
  pluginsDeferred = false
  registerResolvePlugin()
  registerNodeModulesLoadPlugin()
  for (const root of deferredPluginRoots) registerLoadPlugin(root)
  deferredPluginRoots.clear()
}

function resolveRuntimeTarget(target: string) {
  return path.isAbsolute(target) ? target : require.resolve(target)
}

function aliasesForConfig(config: ResolvedConfig) {
  let aliases = aliasCache.get(config)
  if (!aliases) {
    aliases = new Map<string, string>()
    for (const [specifier, target] of Object.entries(coreAliases(config, 'server'))) {
      aliases.set(specifier, resolveRuntimeTarget(target))
    }
    aliasCache.set(config, aliases)
  }
  return aliases
}

export function coreAliases(
  config: ResolvedConfig,
  target: CompatAliasTarget,
): Record<string, string> {
  return {
    ...frameworkRuntimeAliasEntries(),
    ...pnextAliases(target),
    ...getImportAliasExtensions().aliases(config, target),
  }
}

export const aliasSpecifierFilter =
  /^(?:@wular\/pnext\/cache|preact(?:\/|$)|react(?:-dom)?(?:\/|$)|react-compiler-runtime$|next(?:\/|$)|server-only$|client-only$|@vercel\/og$)/

function registerResolvePlugin() {
  if (resolveRegistered) return
  resolveRegistered = true
  Bun.plugin({
    name: 'pnext-server-runtime-resolve',
    setup(plugin) {
      plugin.onResolve({ filter: aliasSpecifierFilter }, args => {
        const runtime = runtimeConfigForFile(args.importer)
        const resolved = runtime?.aliases.get(args.path) ?? firstAliasForSpecifier(args.path)
        const target = resolved ? serverRequireAlias(args.path, resolved, args.kind) : undefined
        if (target) return { path: target }
        const message = (runtime ?? firstRuntimeConfig())?.missingImportError(args.path)
        if (message) throw new Error(message)
        return undefined
      })
      plugin.onResolve({ filter: /^[^./].*/ }, ({ path: specifier, importer }) => {
        const runtime = runtimeConfigForFile(importer)
        const target =
          runtime &&
          resolveExternalLoadTarget({
            root: runtime.root,
            fromFile: importer,
            specifier,
            target: 'server',
          })
        if (!target) return undefined
        return { path: target }
      })
    },
  })
}

function registerLoadPlugin(root: string) {
  if (registeredLoadRoots.has(root)) return
  registeredLoadRoots.add(root)
  if (traceEnabled('server')) {
    console.error(`[loadplugin] register root=${root} extras=${currentLoadExtras().join(',')}`)
  }
  loadPluginExtras.set(root, currentLoadExtras())
  Bun.plugin({
    name: `pnext-server-runtime-load-${hashRoot(root)}`,
    setup(plugin) {
      plugin.onLoad({ filter: rootFilter(root) }, async ({ path: file }) => ({
        contents: await transformSource(file),
        loader: 'js',
      }))
    },
  })
}

// The load plugin's filter regex latches the page extensions known at registration time. A root registered
// BEFORE compat adds `mdx`/`md` (boot order shifts under load) would let those modules fall through to Bun's
// file loader, whose default export is the file path and renders as a bogus JSX tag - so a late registration
// extends every latched root with an extras-only plugin.
const loadPluginExtras = new Map<string, string[]>()

function currentLoadExtras(): string[] {
  return extraLoadableExtensions().filter(ext => /^[a-z0-9]+$/i.test(ext))
}

onLoadableExtensionsChanged(() => {
  for (const [root, seen] of loadPluginExtras) {
    const fresh = currentLoadExtras().filter(ext => !seen.includes(ext))
    if (fresh.length === 0) continue
    loadPluginExtras.set(root, [...seen, ...fresh])
    const exts = fresh.map(escapeRegex).join('|')
    const filter = new RegExp(
      `^${escapeRegex(root)}(?!.*\\/node_modules\\/)(?:/.*)?\\.(?:${exts})$`,
    )
    Bun.plugin({
      name: `pnext-server-runtime-load-extras-${hashRoot(root)}-${fresh.join('-')}`,
      setup(plugin) {
        plugin.onLoad({ filter }, async ({ path: file }) => ({
          contents: await transformSource(file),
          loader: 'js',
        }))
      },
    })
  }
})

function registerNodeModulesLoadPlugin() {
  if (nodeModulesLoadRegistered) return
  nodeModulesLoadRegistered = true
  Bun.plugin({
    name: 'pnext-server-node-modules-load',
    setup(plugin) {
      plugin.onLoad(
        {
          filter:
            /\/node_modules\/.*(?:\.mjs|\.esm\.js|\/(?:es|esm|dist\/esm|build\/modern)\/.*\.js)$/,
        },
        async ({ path: file }) => {
          const code = await transformNodeModuleSource(file)
          return { contents: code, loader: 'js' }
        },
      )
    },
  })
}

function runtimeConfigForFile(file: string | undefined) {
  if (!file) return undefined
  const key = path.resolve(file)
  if (runtimeConfigLookupCache.has(key)) {
    return runtimeConfigLookupCache.get(key) ?? undefined
  }
  for (const config of runtimeConfigs.values()) {
    for (const root of config.roots) {
      if (isInside(root, file)) {
        runtimeConfigLookupCache.set(key, config)
        return config
      }
    }
  }
  runtimeConfigLookupCache.set(key, null)
  return undefined
}

function sourceRootForFile(config: ResolvedConfig, file: string) {
  const dir = path.dirname(file)
  if (isInside(config.appPath, dir)) return config.appPath
  return packageRootsForConfig(config).find(root => isInside(root, dir)) ?? dir
}

function packageRootsForConfig(config: ResolvedConfig) {
  let roots = packageRootCache.get(config)
  if (!roots) {
    roots = workspacePackageRoots(config.workspaceRoot)
    packageRootCache.set(config, roots)
  }
  return roots
}

function firstRuntimeConfig() {
  for (const config of runtimeConfigs.values()) return config
  return undefined
}

export function firstAliasForSpecifier(specifier: string) {
  if (firstAliasCache.has(specifier)) return firstAliasCache.get(specifier) ?? undefined
  for (const config of runtimeConfigs.values()) {
    const target = config.aliases.get(specifier)
    if (target) {
      firstAliasCache.set(specifier, target)
      return target
    }
  }
  firstAliasCache.set(specifier, null)
  return undefined
}

async function transformSource(file: string) {
  const fileStat = await stat(file)
  const cached = transformCache.get(file)
  if (cached?.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
    return cached.code
  }
  const pendingKey = `${file}\0${fileStat.mtimeMs}\0${fileStat.size}`
  const pending = pendingTransforms.get(pendingKey)
  if (pending) return pending
  const started = transformSourceUncached(file, fileStat)
  pendingTransforms.set(pendingKey, started)
  try {
    return await started
  } finally {
    if (pendingTransforms.get(pendingKey) === started) pendingTransforms.delete(pendingKey)
  }
}

async function transformSourceUncached(file: string, fileStat: { mtimeMs: number; size: number }) {
  // The in-memory cache is empty on every restart, so a restarted server
  // re-transforms the whole materialized module set on the request path.
  const diskCache = transformCacheFile(file, fileStat)
  if (diskCache) {
    const code = await readFile(diskCache, 'utf8').catch(() => undefined)
    if (code !== undefined) {
      transformCache.set(file, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, code })
      return code
    }
  }

  const runtime = runtimeConfigForFile(file)
  let raw = await readFile(file, 'utf8')
  // Raw markdown compiles through the MDX pipeline first; materialized
  // cache/server copies were already compiled in place (runtime/modules) and would
  // be corrupted by a second pass.
  if (/\.mdx?$/.test(file) && !file.includes(`${path.sep}cache${path.sep}server${path.sep}`)) {
    const { compileMdx } = await import('../compat/mdx/compile')
    raw = (await compileMdx(raw, file, runtime?.root ?? path.dirname(file))).code
  }
  const source = await inlineModuleScopeRequires(
    rewriteServerSource(raw, file, {
      root: runtime?.root,
    }),
    file,
    runtime?.root,
  )
  const result = await transform(source, {
    loader: esbuildLoader(file),
    jsx: 'automatic',
    jsxImportSource: 'preact',
    sourcefile: file,
    target: 'es2022',
    ...serverDefineOptions(),
  })
  transformCache.set(file, {
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
    code: result.code,
  })
  if (diskCache) {
    await mkdir(path.dirname(diskCache), { recursive: true }).catch(() => undefined)
    // Off the caller's path: a render never waits on the cache it is filling.
    // Tracked so a process whose whole job IS filling it can await them.
    const write = writeFileAtomic(diskCache, result.code).catch(() => undefined)
    transformWrites.add(write)
    void write.finally(() => transformWrites.delete(write))
  }
  return result.code
}

// Transform writes in flight; see prewarmServerTransforms.
const transformWrites = new Set<Promise<unknown>>()

/**
 * Fill the on-disk transform cache for compiled artifacts a build just wrote.
 *
 * Importing a materialized module transforms it first, and that transform is the last piece of the
 * compile pipeline a built app would otherwise reach on its first served request - esbuild service
 * child included. Running it here is pure build work on build output: no app module is evaluated,
 * unlike the import pass the vercel adapter needs for its vendor bundles.
 */
export async function prewarmServerTransforms(root: string, files: Iterable<string>) {
  // The load hook's own filter, so this warms exactly the files an import would
  // route through it — never a `.css` shim or the natively-loaded vendor tree.
  const loadable = rootFilter(root)
  await Promise.all(
    [...files].map(async file => {
      if (!loadable.test(file)) return
      const stats = await stat(file).catch(() => undefined)
      if (!stats || !transformCacheFile(file, stats)) return
      await transformSource(file).catch(() => undefined)
    }),
  )
  // Settle the writes above, or this process exits with entries in flight and
  // the next boot recompiles exactly what this pass was for.
  while (transformWrites.size > 0) await Promise.all([...transformWrites])
}

// eslint-disable-next-line turbo/no-undeclared-env-vars
const transformDiskCacheDisabled = process.env.PNEXT_TRANSFORM_DISK_CACHE === '0'
const materializedSegment = `${path.sep}cache${path.sep}server${path.sep}`

/**
 * Where a transform of `file` is remembered across restarts. Only for the
 * materialized `cache/server` modules: they are hash-named build output under
 * our own cache root, so the key (path + mtime + size + the define/extension
 * inputs of the transform, and pnext's generation, which shapes the rewrite) is
 * complete, and the whole tree is discarded when a build or a config change
 * rewrites it.
 */
export function transformCacheFile(file: string, fileStat: { mtimeMs: number; size: number }) {
  if (transformDiskCacheDisabled) return undefined
  const at = file.lastIndexOf(materializedSegment)
  if (at === -1) return undefined
  const cacheRoot = file.slice(0, at + materializedSegment.length)
  const key = `${file}\0${fileStat.mtimeMs}\0${fileStat.size}\0${currentLoadExtras().join(',')}\0${JSON.stringify(serverDefineOptions())}\0${frameworkFingerprint()}`
  return path.join(cacheRoot, 'transform', `${hashBundleSpecifier(key)}.js`)
}

// A synchronous `require('./x')` of an app source module fails at runtime with `require() async
// module ... is unsupported`: the load plugin's onLoad hook makes every app `[jt]sx?` module an
// ASYNC Bun module, and Bun cannot `require` one. Bun does not route relative `require-call`s
// through onResolve plugins (only bare specifiers reach them), so the alias trick cannot intercept
// them at resolve time. Instead each such require is rewritten to a sibling
// `<x>.pnext-require.cjs` compiled to CommonJS: a real `.cjs` on disk is deliberately excluded by
// rootFilter, so Bun loads it natively and synchronously.
//
// Only requires that resolve to a rootFilter-matched app module are rewritten (a
// `.cjs`/`.json`/node_modules require already loads synchronously). The sidecar is a distinct module
// instance from the module's ESM copy - acceptable here, since the require path was an outright
// crash before and such modules are typically leaf value modules.
//
// Both the source form and the BUILT form are matched: the server bundle keeps such a require
// unbundled and emits esbuild's `__require("file:///abs/path/...")` shim call, which loads the very
// same async app module at runtime.
const REQUIRE_CALL = /\b(?:__)?require\(\s*(['"])((?:\.\.?\/|\/|file:\/\/)[^'"]+)\1\s*\)/g

async function inlineModuleScopeRequires(
  source: string,
  file: string,
  root: string | undefined,
): Promise<string> {
  if (!root || !source.includes('require(')) return source
  const filter = rootFilter(root)
  const sidecars = new Map<string, string>()
  const pending: Promise<void>[] = []
  const seen = new Set<string>()
  for (const match of source.matchAll(REQUIRE_CALL)) {
    const specifier = match[2]!
    if (seen.has(specifier)) continue
    seen.add(specifier)
    const target = requireCallTarget(root, file, specifier)
    if (!target || !filter.test(target)) continue
    pending.push(
      requireCjsSidecar(target).then(sidecar => {
        if (sidecar) sidecars.set(specifier, sidecar)
      }),
    )
  }
  if (pending.length === 0) return source
  await Promise.all(pending)
  if (sidecars.size === 0) return source
  return source.replace(REQUIRE_CALL, (whole, quote: string, specifier: string) => {
    const sidecar = sidecars.get(specifier)
    return sidecar ? `require(${quote}${sidecar}${quote})` : whole
  })
}

/** The module a rewritable `require(...)` call resolves to, if any. */
function requireCallTarget(root: string, file: string, specifier: string): string | undefined {
  if (specifier.startsWith('file://')) {
    try {
      return resolveImport(root, file, fileURLToPath(specifier))
    } catch {
      return undefined
    }
  }
  return resolveImport(root, file, specifier)
}

// Compile an app module to a sibling `.pnext-require.cjs` (CommonJS), reusing a
// mtime/size-cached copy. Returns the sidecar path, or undefined on any failure
// (the original require is then left as-is). The module runs through the same
// server source pipeline as a normal load so the CJS copy behaves like the ESM
// one; nested module-scope requires inside it are NOT recursively inlined.
async function requireCjsSidecar(target: string): Promise<string | undefined> {
  try {
    const sidecar = requireCjsSidecarPath(target)
    const fileStat = await stat(target)
    const cached = requireSidecarCache.get(target)
    if (cached?.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) return sidecar
    const runtime = runtimeConfigForFile(target)
    const source = rewriteServerSource(await readFile(target, 'utf8'), target, {
      root: runtime?.root,
    })
    const result = await transform(source, {
      loader: esbuildLoader(target),
      jsx: 'automatic',
      jsxImportSource: 'preact',
      sourcefile: target,
      target: 'es2022',
      format: 'cjs',
      ...serverDefineOptions(),
    })
    await writeFile(sidecar, result.code)
    requireSidecarCache.set(target, { mtimeMs: fileStat.mtimeMs, size: fileStat.size })
    return sidecar
  } catch {
    return undefined
  }
}

function requireCjsSidecarPath(target: string): string {
  return `${target.replace(/\.[^./\\]+$/, '')}.pnext-require.cjs`
}

async function transformNodeModuleSource(file: string) {
  const fileStat = await stat(file)
  const cached = nodeModuleTransformCache.get(file)
  if (cached?.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
    return cached.code
  }
  // The in-memory cache is empty on every restart, so a restarted server
  // re-BUNDLES each of these packages on the request path.
  const record = nodeModuleBundleRecordFile(file, fileStat)
  const reused = record ? await readNodeModuleBundle(record) : undefined
  if (reused !== undefined) {
    nodeModuleTransformCache.set(file, {
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size,
      code: reused,
    })
    return reused
  }

  const { code, inputs } = await bundleNodeModuleSource(file)
  nodeModuleTransformCache.set(file, {
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
    code,
  })
  if (record) void writeNodeModuleBundle(record, inputs, code)
  return code
}

/**
 * Where a bundle of `file` is remembered across restarts. The entry's own stat is in the name, but
 * the build inlines the package's relative graph too, so the record carries every esbuild input and
 * is only reused while all of them still stat the same. A record that cannot be validated is a miss.
 */
function nodeModuleBundleRecordFile(file: string, fileStat: { mtimeMs: number; size: number }) {
  if (transformDiskCacheDisabled) return undefined
  const outPath = (runtimeConfigForFile(file) ?? firstRuntimeConfig())?.resolved.outPath
  if (!outPath) return undefined
  const key = `${file}\0${fileStat.mtimeMs}\0${fileStat.size}\0${currentLoadExtras().join(',')}\0${JSON.stringify(serverDefineOptions())}\0${frameworkFingerprint()}`
  return path.join(cacheRoot(outPath), 'node-module-bundle', `${hashBundleSpecifier(key)}.json`)
}

async function bundleNodeModuleSource(file: string) {
  const resolved = runtimeConfigForFile(file)?.resolved
  const extensionPlugins = resolved ? getBundlerExtensions().serverEsbuildPlugins(resolved) : []
  const result = await build({
    // The marker entry only resolves when the extension chain is present.
    entryPoints: [
      (resolved
        ? getBundlerExtensions().serverBundleEntry(file, path.dirname(file), file)
        : undefined) ?? file,
    ],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    loader: packageJsxLoaders,
    jsx: 'automatic',
    jsxImportSource: 'preact',
    packages: 'external',
    logLevel: 'silent',
    metafile: true,
    ...serverDefineOptions(),
    plugins: [
      serverAssetPlugin(),
      ...extensionPlugins,
      runtimeAliasBuildPlugin(undefined, 'server', { bundleRequireAliases: true }),
    ],
  })
  const output = result.outputFiles[0]
  if (!output) throw new Error(`Failed to bundle ${file}`)
  // Packages can ship 'use cache' functions too (Next allows it); everything
  // else in the source chain was already settled by the bundle above (imports
  // resolved by the plugins, constants inlined by esbuild `define`).
  return {
    code: applyBundledSourceTransforms(output.text, file),
    inputs: Object.keys(result.metafile.inputs).map(input => path.resolve(input)),
  }
}

/**
 * The one vendor-compile entry point. Every demand - a module compile's import scan, an esbuild
 * resolve callback, a transitive dependency of another vendor bundle - arrives here and is scheduled
 * by the pipeline in `./vendor`. `nested` marks demands raised from inside a running vendor build;
 * see `withVendorSlot` for why they must not queue.
 */

// ---------------------------------------------------------------------------
// Shared with vendor bundling (./vendor-build): alias resolution, asset
// stubbing, source-rewrite, and root/hash helpers used by both the loader's
// own plugins and the vendor esbuild passes.
// ---------------------------------------------------------------------------

/**
 * Whether `rewriteServerSource` can possibly change `source`. One regex scan
 * over the union of the core dynamic tokens and every registered transform's
 * own sniff tokens (see `withSniff`); most modules trigger nothing and skip the
 * whole chain.
 */
export function needsServerSourceRewrite(source: string) {
  return sourceHasDynamicImport(source) || sourceNeedsServerTransforms(source)
}

export function rewriteServerSource(
  source: string,
  file: string,
  options: { nextFonts?: boolean; root?: string } = {},
) {
  const root = options.root ?? path.dirname(file)
  const rewritten = sourceHasDynamicImport(source)
    ? rewriteDynamicCallTargets(
        rewriteLiteralDynamicCalls(source, file),
        specifier => resolveImport(root, file, specifier),
        file,
      )
    : source
  // Compat pre-transforms (next/font/root-params) run before generic server
  // transforms (use-cache/action tags). Pure-core apps register no transforms.
  if (options.nextFonts === false) return rewritten
  if (!sourceNeedsServerTransforms(rewritten)) return rewritten
  return applyServerSourceTransforms(
    applyServerSourcePreTransforms(rewritten, file, options.root),
    file,
    options.root,
  )
}

export function serverRequireAlias(
  specifier: string,
  target: string,
  kind: string | undefined,
): string {
  if (kind !== 'require-call') return target
  if (specifier === 'next/navigation' && target.endsWith(`${path.sep}navigation.ts`)) {
    return path.join(path.dirname(target), 'navigation.cjs')
  }
  if (specifier === 'next/router' && target.endsWith(`${path.sep}router.ts`)) {
    return path.join(path.dirname(target), 'router.cjs')
  }
  return target
}

export function runtimeAliasBuildPlugin(
  config?: ResolvedConfig,
  target: CompatAliasTarget = 'server',
  options: { bundleRequireAliases?: boolean; reactServerLayer?: boolean } = {},
): Plugin {
  const aliases = config ? coreAliases(config, target) : undefined
  // A node_modules package bundled into the RSC (react-server) layer that requires 'react' must observe the
  // react-server subset - no client-hook dispatcher - exactly like the framework's own react-server modules,
  // so a package's `'useState' in require('react')` probe reads false on the server. ESM named imports stay
  // external and resolve at runtime against the full-hooks server shim (kept for pages/api back-compat), so
  // this narrow require-call override never breaks them.
  const reactServerLayerAliases =
    config && options.reactServerLayer
      ? getImportAliasExtensions().reactServerLayerAliases(config)
      : undefined
  return {
    name: 'pnext-runtime-build-alias',
    setup(build) {
      build.onResolve({ filter: /^\.\/preact$/ }, args => {
        // `./preact` is the compat react shim's private import. It also appears in MIRRORED copies of the
        // shim (build-cache outputs under node_modules paths) where no sibling preact file exists - those
        // must resolve to the single compat instance too. Only a REAL sibling ./preact.* opts out.
        const hasRealSibling = ['.ts', '.tsx', '.js', '.mjs', '.jsx'].some(ext =>
          existsSync(path.join(args.resolveDir, `preact${ext}`)),
        )
        const compatPreact = path.resolve(import.meta.dirname, '..', 'compat', 'react', 'preact.ts')
        if (hasRealSibling && path.resolve(args.resolveDir, 'preact.ts') !== compatPreact)
          return undefined
        return { path: compatPreact }
      })
      build.onResolve({ filter: /^\.\.\/client\/errors\/primitive-throw$/ }, args => {
        const compatPreact = path.resolve(import.meta.dirname, '..', 'compat', 'react', 'preact.ts')
        if (path.resolve(args.importer) !== compatPreact) return undefined
        return {
          path: path.resolve(
            import.meta.dirname,
            '..',
            'compat',
            'client',
            'errors',
            'primitive-throw.ts',
          ),
        }
      })
      build.onResolve({ filter: aliasSpecifierFilter }, args => {
        const resolved = aliases?.[args.path] ?? firstAliasForSpecifier(args.path)
        if (!resolved) return undefined
        const requireTarget = serverRequireAlias(args.path, resolved, args.kind)
        if (requireTarget !== resolved) return { path: requireTarget }
        if (options.bundleRequireAliases && args.kind === 'require-call') {
          const layerTarget = serverRequireAlias(
            args.path,
            reactServerLayerAliases?.[args.path] ?? resolved,
            args.kind,
          )
          return { path: path.isAbsolute(layerTarget) ? layerTarget : require.resolve(layerTarget) }
        }
        return {
          path: path.isAbsolute(resolved) ? pathToFileHref(resolved) : resolved,
          external: true,
        }
      })
    },
  }
}

function isInside(root: string, file: string) {
  const relative = path.relative(root, file)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function rootPaths(root: string) {
  const key = path.resolve(root)
  const cached = rootPathCache.get(key)
  if (cached) return cached
  const paths = new Set([path.resolve(root)])
  try {
    paths.add(realpathSync.native(root))
  } catch {
    // The dev cache root is registered before it exists.
  }
  const resolved = [...paths]
  rootPathCache.set(key, resolved)
  return resolved
}

function rootFilter(root: string) {
  // Base source extensions plus any extra loadable extensions registered by
  // compat (e.g. mdx/md via pageExtensions). Without these, `.mdx` modules skip
  // the transform load hook and resolve as raw assets (default export = path).
  const extras = currentLoadExtras().map(escapeRegex)
  const exts = ['[jt]sx?', ...extras].join('|')
  // Exclude `next.config.{js,cjs,mjs,ts}`: it is loaded for its exported value (often CommonJS
  // `module.exports = ...`), not as part of the app's server module graph. Routing it through the
  // ES-module source transform drops the CJS exports, silently disabling next.config
  // rewrites/redirects.
  // Exclude the vendor tree under the cache root: the `*.dist/` copies copyBrowserReadyEsmDist
  // publishes are verbatim third-party ESM the copy predicate has already proved needs no server
  // rewrite, but they are `.js`, so each was read and re-transformed on every boot. Bun loads them
  // natively instead. Two clauses because the vendor tree is reachable from two registered roots.
  const vendorGuard = vendorLoadsNatively()
    ? `${root.endsWith(`${path.sep}cache${path.sep}server`) ? '(?!\\/vendor\\/)' : ''}(?!.*\\/cache\\/server\\/vendor\\/)`
    : ''
  return new RegExp(
    `^${escapeRegex(root)}${vendorGuard}(?!.*\\/node_modules\\/)(?!\\/next\\.config\\.(?:js|cjs|mjs|ts)$)(?:/.*)?\\.(?:${exts})$`,
  )
}

function esbuildLoader(file: string) {
  if (file.endsWith('.tsx')) return 'tsx'
  if (file.endsWith('.ts')) return 'ts'
  // Workspace .js/.jsx may contain JSX (Next allows it); jsx is a js superset.
  return 'jsx'
}

function hashRoot(value: string) {
  let hash = 5381
  for (const char of value) hash = ((hash << 5) + hash) ^ char.charCodeAt(0)
  return (hash >>> 0).toString(36)
}

export function hashBundleSpecifier(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

/**
 * Bisect switch for the vendor-tree load-plugin exclusion. Deliberately NOT `PNEXT_VENDOR_NATIVE` -
 * that name already gates the plugin-free bundler, and sharing it would arm that opt-in path by
 * accident whenever this one was bisected.
 */
export function vendorLoadsNatively() {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  return process.env.PNEXT_VENDOR_DIST_NATIVE !== '0'
}

// --------------------------------------------------------------------------
// pre-planned vendor policy (PNEXT_VENDOR_PREPLAN=1 opt-in, server layer only)
// --------------------------------------------------------------------------

export const serverIgnoredAssetFilter =
  /\.(?:css|scss|sass|woff2?|ttf|otf|eot|png|jpe?g|gif|webp|avif|svg|ico|bmp)(?:$|[?#])/

function isCssFile(file: string) {
  return file.endsWith('.css')
}

function isStaticImageFile(file: string) {
  return /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp)(?:$|[?#])/.test(file)
}

function resolveAssetPath(specifier: string, resolveDir: string) {
  const [sourcePath = '', hash = ''] = specifier.split('#', 2)
  const resolved = path.isAbsolute(sourcePath) ? sourcePath : path.resolve(resolveDir, sourcePath)
  return hash ? `${resolved}#${hash}` : resolved
}

async function staticImageModuleSource(config: ResolvedConfig | undefined, file: string) {
  const [sourcePath = ''] = file.split('#', 1)
  const bytes = new Uint8Array(await readFile(sourcePath))
  const emitted: { relative: string; bytes: Uint8Array }[] = []
  const emit = (relative: string, data: Uint8Array) => {
    emitted.push({ relative, bytes: data })
    return `/${relative}`
  }
  const compat = await getAssetExtensions().staticAssetModule({ sourcePath, bytes, emit })
  const source = compat ?? coreStaticAssetModule(sourcePath, bytes, emit)
  if (config) {
    for (const asset of emitted) {
      const target = path.join(config.outPath, 'public', ...asset.relative.split('/'))
      await mkdir(path.dirname(target), { recursive: true })
      if (!existsSync(target)) await Bun.write(target, asset.bytes)
    }
  }
  return source
}

// Core's generic static-asset module: emit the file under a hashed media URL
// and export it as the default (a plain URL string) when no compat override is
// registered. next/image compat replaces this with a full StaticImageData shape.
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

export function serverAssetPlugin(config?: ResolvedConfig): Plugin {
  return {
    name: 'pnext-empty-server-assets',
    setup(build) {
      build.onResolve({ filter: serverIgnoredAssetFilter }, args => {
        const resolved = resolveAssetPath(args.path, args.resolveDir)
        // A configured `turbopack.rules` loader chain for this extension (e.g.
        // `*.svg`) preempts the generic asset pipeline: defer so the compat
        // loader-rule plugin's onLoad runs the chain against the real file.
        if (getAssetExtensions().hasLoaderRuleFor(resolved)) {
          return undefined
        }
        return { path: resolved, namespace: 'pnext-empty-server-asset' }
      })
      build.onLoad({ filter: /.*/, namespace: 'pnext-empty-server-asset' }, async args => ({
        contents:
          getCssExtensions().loadCssModuleForClient(args.path) ??
          (isCssFile(args.path)
            ? ''
            : isStaticImageFile(args.path)
              ? await staticImageModuleSource(config, args.path)
              : 'export default "";'),
        loader: 'js',
      }))
    },
  }
}
