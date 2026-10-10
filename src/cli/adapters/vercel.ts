import { copyFile, link, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_OUT_DIR, devOutSegment, pathToFileHref } from '../../config'
import type { ResolvedConfig } from '../../config'
import { compiledClientReferenceFiles } from '../../client/reference'
import { globalCssSources } from '../../css/build'
import { getImportAliasExtensions } from '../../extensions'
import { nextCompatEnabled } from '../../render/hooks'
import { importSpecifiers } from '../../resolve/scan-facts'
import { compiledSpecifiersManifestSuffix } from '../../runtime/modules'
import { resolveImport, workspacePackageRoots } from '../../resolve/imports'
import { findProxyFile, proxyRoutePatterns, type ProxyModule } from '../../routing/proxy'
import { cacheRoot } from '../boot/named-bin'
import { startWarmChild, type WarmChild } from './vercel-warm'
import {
  immutableAssetPath,
  immutableAssetPrefixes,
  immutableCacheControl,
} from '../serve/immutable'
import { frameworkFingerprint } from '../../runtime/fingerprint'
import { readPrebundleStamp, runtimeEntryDirs, runtimeEntryFiles } from '../../runtime/prebundle'
import { buildIndexFile, readBuildIndex, releaseSourceFile } from '../../runtime/production'
import { compiledSourceGraph, flushDevModuleCaches } from '../../runtime/module-cache'
import { escapeRegex } from '../../utils/code'
import { listFiles, toPosixPath, writeText } from '../../utils/fs'
import { createVerboseLogger, type VerboseLogger } from '../../utils/verbose'
import type { BuildManifest, StaticFileMetadata } from '../../types'

// Vercel unpacks a function's `.func` directory here at runtime. Baked
// absolute paths in the build output are rewritten to this root.
const RUNTIME_ROOT = '/var/task'

// The single catch-all server function: the same `pnext start` pipeline,
// running on Vercel's Bun runtime (`"bunVersion": "1.x"` in vercel.json).
const SERVER_FUNCTION = '_pnext'

// The platform the function actually runs on, declared once: `architecture`
// goes into .vc-config.json and the same target selects the native packages
// shipped inside it, so the two can never drift. Vercel's default instruction
// set is x86_64 and its function runtime is glibc-based.
const FUNCTION_PLATFORM = {
  architecture: 'x86_64',
  os: 'linux',
  cpu: 'x64',
  libc: 'glibc',
} as const

// Directories that only ever hold build-tool output, pruned at *any* depth. Depth matters: pruning
// only a package's top level ships every nested one. node_modules and .git are here for the same
// reason - the function resolves through its own traced node_modules, never a nested store.
const prunedDirNames = [
  'node_modules',
  '.git',
  '.next',
  '.pnext',
  '.turbo',
  '.cache',
  '.vercel',
  '.tmp',
]

// Files nothing reads at request time. Sourcemaps only decorate stack traces,
// and Bun strips types rather than resolving declarations — neither can change
// what the function serves, and together they are a fifth of a typical closure.
// Markdown is deliberately absent: an mdx app imports it as a module.
const droppedFileSuffixes = [
  '.map',
  '.d.ts',
  '.d.mts',
  '.d.cts',
  '.DS_Store',
  // The compile-time specifier sidecars (see traceNodeModulesClosure below):
  // build-time metadata the trace consumes, never read at request time.
  compiledSpecifiersManifestSuffix,
]

/** What the function tree ships, resolved once from config. */
interface PackRules {
  prunedDirs: Set<string>
  droppedSuffixes: string[]
  /** Absolute app sources the release compiled: dropped unless `adapter.keep` names them. */
  compiled: Set<string>
  /** `adapter.keep` entries: names and `.suffix`es that always ship. */
  keep: Set<string>
  /** Absolute sources exempt from the prune list — the app's own build output. */
  keepPaths: Set<string>
  /** Absolute sources never shipped: the dev server's `<outRoot>/dev`, which a build leaves in place. */
  devPaths: Set<string>
}

// Test seam: the packing suite builds one app both ways and diffs the trees,
// so it needs the unpruned closure on demand. Never off for a real deployment.
let packPruningEnabled = true

/** @internal Test-only. Returns a restore function. */
export function setPackPruningEnabled(enabled: boolean) {
  const previous = packPruningEnabled
  packPruningEnabled = enabled
  return () => {
    packPruningEnabled = previous
  }
}

function packRules(config: ResolvedConfig): PackRules {
  // An out dir inside a dev path (`outDir: '.pnext/dev'`) is the production output and must ship.
  const devPaths = new Set(
    [config.outRootPath, path.resolve(config.root, DEFAULT_OUT_DIR)]
      .map(root => path.resolve(root, devOutSegment))
      .filter(dev => !isInsideDir(dev, config.outPath)),
  )
  // Materialized pages sources: the release serves their compiled artifacts.
  devPaths.add(path.join(config.outRootPath, 'pnext-pages-compat'))
  if (!packPruningEnabled) {
    return {
      // The two the function could never resolve through stay pruned even
      // here: a nested store or object database is not a packing choice.
      prunedDirs: new Set(['node_modules', '.git']),
      droppedSuffixes: [],
      compiled: new Set(),
      keep: new Set(),
      keepPaths: new Set([path.resolve(config.outPath)]),
      devPaths,
    }
  }
  const keep = new Set(config.adapter?.keep ?? [])
  const extra = config.adapter?.exclude ?? []
  const isSuffix = (entry: string) => entry.startsWith('.') && !prunedDirNames.includes(entry)
  return {
    prunedDirs: new Set(
      [...prunedDirNames, ...extra.filter(entry => !isSuffix(entry))].filter(
        name => !keep.has(name),
      ),
    ),
    droppedSuffixes: [...droppedFileSuffixes, ...extra.filter(isSuffix)].filter(
      suffix => !keep.has(suffix),
    ),
    compiled: new Set(),
    keep,
    // The app's outDir shares its name with the prune list; it holds the
    // compiled module cache the function serves from and must survive. The
    // default out root goes with it: a `distDir` app moved its output away, but
    // the next.config bundle the function imports at boot still lives there.
    keepPaths: new Set([path.resolve(config.outPath), path.resolve(config.root, DEFAULT_OUT_DIR)]),
    devPaths,
  }
}

/**
 * A keep path and everything under it. Prefix, not equality: the compiled module cache mirrors the
 * source layout, so a dependency's artifacts land in `<outDir>/cache/server/<profile>/node_modules/
 * ...`. That segment names a source tree, not a package store, and pruning it by name ships the
 * importer without the module it imports — the function then 500s on the first request that reaches
 * it. Only the app's own build output is exempt; a real `node_modules` beside it still prunes.
 */
function withinKeepPath(pack: PackRules, source: string) {
  const resolved = path.resolve(source)
  for (const keep of pack.keepPaths) {
    if (resolved === keep || resolved.startsWith(`${keep}${path.sep}`)) return true
  }
  return false
}

/**
 * `isLink` is load-bearing, not a detail: the exemption covers real directories the build output
 * owns, never a link out of it. The proxy shim links `node_modules` into `.pnext`, and following
 * that would pull the whole store into the function.
 */
function shipsDir(pack: PackRules, name: string, source: string, isLink = false) {
  if (pack.devPaths.has(path.resolve(source))) return false
  if (!pack.prunedDirs.has(name)) return true
  return !isLink && withinKeepPath(pack, source)
}

function shipsFile(pack: PackRules, name: string, source: string) {
  if (pack.droppedSuffixes.some(suffix => name.endsWith(suffix))) return false
  if (!pack.compiled.has(path.resolve(source)) || withinKeepPath(pack, source)) return true
  return [...pack.keep].some(
    entry => name === entry || (entry.startsWith('.') && name.endsWith(entry)),
  )
}

/**
 * App sources a release compiled into its output: the closure of `build-index.json`'s modules over the
 * compile graph, plus the proxy, instrumentation and config it froze. Anything else may be read at
 * request time and ships.
 */
function releaseCompiledSources(config: ResolvedConfig) {
  flushDevModuleCaches()
  const index = readBuildIndex(config.outPath)
  const graph = compiledSourceGraph(config.outPath, config.workspaceRoot)
  const queue = Object.keys(index.modules).map(key =>
    releaseSourceFile(
      key.slice(key.indexOf(':', key.indexOf(':') + 1) + 1),
      config.root,
      config.workspaceRoot,
    ),
  )
  if (index.proxy) queue.push(path.resolve(config.root, index.proxy.file))
  const script = /\.(?:[cm]?[jt]s|[jt]sx)$/
  const frozen = (dir: string, pattern: RegExp) =>
    (readDirEntries(dir) ?? [])
      .filter(entry => pattern.test(entry.name) && script.test(entry.name))
      .forEach(entry => queue.push(path.join(dir, entry.name)))
  frozen(config.root, /^(?:pnext|next)\.config\./)
  if (index.instrumentation) {
    for (const dir of [config.root, path.join(config.root, 'src')])
      frozen(dir, /^instrumentation\./)
  }
  const compiled = new Set<string>()
  for (const file of queue) {
    if (compiled.has(file)) continue
    compiled.add(file)
    let real = file
    try {
      real = realpathSync(file)
    } catch {
      continue
    }
    compiled.add(real)
    queue.push(...(graph.get(file) ?? []), ...(graph.get(real) ?? []))
  }
  return compiled
}

interface VercelConfig {
  version: 3
  routes?: (
    | {
        src: string
        dest?: string
        methods?: string[]
        headers?: Record<string, string>
        continue?: boolean
        important?: boolean
      }
    | { handle: 'filesystem' }
  )[]
  overrides?: Record<string, { path?: string; contentType?: string }>
}

export async function writeVercelOutput(
  config: ResolvedConfig,
  manifest: BuildManifest,
  options: { verbose?: boolean; warm?: WarmChild } = {},
) {
  const log = createVerboseLogger(options.verbose ?? false, 'vercel')
  const outputPath = path.join(config.root, '.vercel', 'output')
  const staticFiles = manifest.staticFiles ?? {}
  // Warming runs in its own process (see ./vercel-warm) and normally started
  // with the build; a caller that skipped that only loses the overlap.
  const warm = options.warm ?? startWarmChild(config)
  await log.step('prepare output directory', () => emptyDir(outputPath))

  // The compiled set is already final once the child reaches its handler
  // phase, so `onCompiled` resolves this ahead of full completion and
  // writeServerFunction starts tracing while the child's handler imports
  // still run. `finish` itself always fires `onCompiled` before it resolves,
  // so this promise never hangs on it.
  let resolveWarmedModules: (modules: string[]) => void
  const warmedModulesEarly = new Promise<string[]>(resolve => {
    resolveWarmedModules = resolve
  })
  const warmSettled = warm.finish(log, modules => resolveWarmedModules(modules), {
    globalCss: globalCssSources(config),
    clientReferences: [...compiledClientReferenceFiles()],
  })
  // Nothing awaits it until writeServerFunction's copy step; park the
  // rejection so it never surfaces as unhandled in between (it never actually
  // rejects — warmWithRestarts catches everything itself — but the gap
  // between here and that await is otherwise unguarded).
  warmSettled.catch(() => undefined)
  const warmedModules = await log.step('warm module cache (compiled)', () => warmedModulesEarly)

  const functionPath = path.join(outputPath, 'functions', `${SERVER_FUNCTION}.func`)
  await writeServerFunction(config, manifest, functionPath, warmedModules, warmSettled, log)

  // After the warm pass, never before: it is what emits next/font bytes under public/, and a fully
  // dynamic app renders nothing at build, so copying earlier ships a CDN with no fonts.
  await log.step('copy static files', () =>
    copyStaticFiles(
      path.join(config.outPath, 'public'),
      path.join(outputPath, 'static'),
      relative => !staticFiles[relative] || canServeStaticOnVercel(staticFiles[relative]),
    ),
  )
  const overrides = await staticOverrides(path.join(config.outPath, 'public'), staticFiles)

  const routes: NonNullable<VercelConfig['routes']> = [
    // next-compat documents reference the build output under Next's static path (assetPathname),
    // but it is copied to the CDN at `static/assets/*`. Rewrite before `handle: filesystem` so the
    // CDN serves those bytes itself - without it every stylesheet and chunk fell through to the
    // server function: served, but at function cost with no edge cache.
    ...compatStaticRewrite(config, outputPath),
    // Every content-hashed build asset, exactly the set `pnext start` serves immutable.
    ...(await immutableAssetRoutes(path.join(config.outPath, 'public'), manifest.publicAssets)),
    // Proxy-matched paths go to the server function before the CDN filesystem
    // check — `pnext start` runs the proxy ahead of static files too.
    ...(await proxyRoutes(config)),
    ...staticHeaderRoutes(staticFiles),
    { handle: 'filesystem' },
    { src: '^/.*$', dest: `/${SERVER_FUNCTION}` },
  ]

  const vercelConfig: VercelConfig = {
    version: 3,
    routes,
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
  }
  await writeText(
    path.join(outputPath, 'config.json'),
    `${JSON.stringify(vercelConfig, null, 2)}\n`,
  )
}

// Unlinking the previous run's output (tens of thousands of hardlinks) must not block the build:
// rename it aside - which is what actually makes it invisible - and let a detached child do the
// unlinking. Nothing downstream depends on the bytes being gone, and anything an interrupted run
// leaves behind is swept on the next build.
async function emptyDir(dir: string) {
  const parent = path.dirname(dir)
  await mkdir(parent, { recursive: true })
  const staleMarker = `${path.basename(dir)}.stale-`
  if (existsSync(dir)) {
    await rename(
      dir,
      path.join(parent, `${staleMarker}${process.pid.toString(36)}-${Date.now().toString(36)}`),
    )
  }
  const stale = readdirSync(parent)
    .filter(entry => entry.startsWith(staleMarker))
    .map(entry => path.join(parent, entry))
  await mkdir(dir, { recursive: true })
  if (stale.length > 0) {
    Bun.spawn(['rm', '-rf', ...stale], { stdout: 'ignore', stderr: 'ignore' })
  }
}

/**
 * The `/_next/static/*` -> `/assets/*` CDN rewrite for a next-compat build, restricted to the names
 * actually copied under `assets/`. It has to be a NARROW alternation, not `(.*)`: `_next/static` is
 * also a REAL output path (`media/*` from the static-media mirror, `pnext/_buildManifest.js`), and
 * a blanket rewrite would point those at an `assets/` twin that does not exist.
 */
function compatStaticRewrite(config: ResolvedConfig, outputPath: string) {
  if (!nextCompatEnabled(config)) return []
  const staticDir = path.join(outputPath, 'static')
  const names = readdirSyncSafe(path.join(staticDir, 'assets'))
    // A name that is ALSO a real `_next/static/<name>` must keep resolving to itself.
    .filter(name => !existsSync(path.join(staticDir, '_next', 'static', name)))
  if (names.length === 0) return []
  const alternation = names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  return [{ src: `^/_next/static/(${alternation})(/.*)?$`, dest: '/assets/$1$2', continue: true }]
}

function readdirSyncSafe(dir: string) {
  return existsSync(dir) ? readdirSync(dir) : []
}

async function proxyRoutes(config: ResolvedConfig) {
  const proxyFile = findProxyFile(config)
  if (!proxyFile) return []
  const proxyModule = (await import(pathToFileHref(proxyFile))) as ProxyModule
  // Percent-encoded paths and repeated slashes go to the function, which decodes or 308s them.
  return [...proxyRoutePatterns(proxyModule.config), '^.*(?:%|//).*$'].map(src => ({
    src,
    dest: `/${SERVER_FUNCTION}`,
  }))
}

async function writeServerFunction(
  config: ResolvedConfig,
  manifest: BuildManifest,
  functionPath: string,
  warmedModules: string[],
  // Resolves once the warm child fully exits (handlers included). The trace below only needs the
  // compiled set `warmedModules` already carries - it reasons from static specifiers, never from
  // handler execution - so it starts immediately; only the tree copy further down, which must ship
  // whatever handler imports wrote to the build cache, waits on this.
  warmSettled: Promise<unknown>,
  log: VerboseLogger,
) {
  const workspaceRoot = config.workspaceRoot
  await mkdir(functionPath, { recursive: true })

  const pack = packRules(config)
  const framework = await resolveFrameworkPackage(workspaceRoot)
  const { root: pnextRoot, inWorkspace: pnextInWorkspace, targetRel: pnextTargetRel } = framework
  const release = releaseEntries(config, manifest)
  // A release served by the framework's prebundle needs none of its other source.
  const prebundle = release ? readPrebundleStamp(pnextRoot, frameworkFingerprint()) : undefined
  const closure = await traceNodeModulesClosure(
    config,
    manifest,
    functionPath,
    framework,
    [...warmedModules, ...(release ?? [])],
    pack,
    log,
    Boolean(release),
  )

  const replicaPathFor = (file: string) => {
    if (isInsideDir(pnextRoot, file)) {
      return path.join(functionPath, pnextTargetRel, path.relative(pnextRoot, file))
    }
    if (isInsideDir(workspaceRoot, file)) {
      return path.join(functionPath, path.relative(workspaceRoot, file))
    }
    return undefined
  }

  // Replicate the workspace layout the build ran in: app source (the renderer reads convention files
  // and global css imports from it at request time), the build output, and the workspace packages the
  // server can actually reach. Unrelated workspace trees never ship.
  const appRel = path.relative(workspaceRoot, config.root)
  const packageRoots = workspacePackageRoots(workspaceRoot).map(root => path.resolve(root))
  const neededRoots = new Set<string>()
  for (const file of closure.tracedFiles) {
    const root = packageRoots.find(candidate => isInsideDir(candidate, file))
    if (root) neededRoots.add(root)
  }
  for (const relative of closure.workspacePackages) {
    neededRoots.add(path.resolve(workspaceRoot, relative))
  }
  // Without a release the server compiles app source at request time: the renderer re-resolves the
  // root layout's global css imports, and a compat compile resolves the shipped sources' imports for
  // real, so the packages behind them and the declared workspace dependencies must be present.
  if (!release) {
    for (const file of globalCssSources(config)) {
      const root = packageRoots.find(candidate => isInsideDir(candidate, file))
      if (root) neededRoots.add(root)
    }
    addWorkspaceDependencies(neededRoots, packageRoots, [path.resolve(config.root), ...neededRoots])
  }
  neededRoots.delete(path.resolve(config.root))
  neededRoots.delete(pnextRoot)

  // The trace above never needed the handler phase, but the copy below ships
  // config.outPath verbatim — handler imports can still be writing vendor
  // bundles into it. Most of this wait is already gone by the time the trace
  // and the roots above finish; whatever remains is genuine handler-phase work.
  await log.step('await handler warm-up', () => warmSettled)

  // Every tree lands in its own subdirectory and the copies are io-bound, so
  // the whole replica goes out as one concurrent step instead of tree by tree.
  const roots = neededRoots.size + 2
  await log.step(`copy function tree (${closure.packageCount} packages, ${roots} roots)`, () =>
    Promise.all([
      closure.copy(),
      // A release ships the app tree minus what it compiled: request code may read files beside
      // its source. `public` is served by the CDN, never from the function; the rest are named
      // again because the app root is the one tree whose build output ships, so it
      // cannot rely on the depth-wise prune alone.
      copyTree(
        config.root,
        path.join(functionPath, appRel),
        release ? { ...pack, compiled: releaseCompiledSources(config) } : pack,
        ['public', '.vercel', '.next', '.turbo'],
      ),
      copyPackageTree(
        pnextRoot,
        path.join(functionPath, pnextTargetRel),
        pack,
        prebundle && ['config', 'dist', ...prebundle.source],
      ),
      ...[...neededRoots].map(packageRoot =>
        copyPackageTree(
          packageRoot,
          path.join(functionPath, path.relative(workspaceRoot, packageRoot)),
          pack,
        ),
      ),
      ...['package.json', 'tsconfig.json', 'bunfig.toml']
        .map(name => path.join(workspaceRoot, name))
        .filter(file => existsSync(file))
        .map(file => copyFile(file, path.join(functionPath, path.basename(file)))),
    ]),
  )

  // Baked absolute paths (compiled cache imports, manifest file paths) point
  // at the build machine's workspace; rewrite them to the runtime root.
  await log.step('rewrite baked paths', () =>
    rewriteBakedPaths(path.join(functionPath, appRel, path.relative(config.root, config.outPath)), [
      ...(pnextInWorkspace
        ? []
        : [[pnextRoot, toPosixPath(path.join(RUNTIME_ROOT, pnextTargetRel))] as const]),
      [workspaceRoot, RUNTIME_ROOT] as const,
    ]),
  )

  // Bun's runtime onResolve plugins never see bare specifiers, so the compat aliases the dev pipeline
  // applies during compilation cannot be applied at runtime for raw-loaded sources (proxy, handlers).
  // Bun does honor tsconfig paths for bare imports, so map the aliased specifiers to their shims in
  // every shipped tsconfig.
  await log.step('inject compat tsconfig paths', () =>
    injectCompatPaths(config, functionPath, pnextRoot, replicaPathFor),
  )

  const startEntry = toPosixPath(
    path.join(pnextTargetRel, prebundle ? 'dist/server/cli/start.js' : 'src/cli/start.ts'),
  )
  await writeText(
    path.join(functionPath, 'index.mjs'),
    `import path from 'node:path';
import { createRequestHandler } from ${JSON.stringify(`./${startEntry}`)};

const handlerPromise = createRequestHandler({
  root: path.join(import.meta.dirname, ${JSON.stringify(appRel)}),
});

async function handler(request) {
  return (await handlerPromise)(request);
}

// Callable for the Node-style launcher, \`fetch\` for the Bun runtime.
export default Object.assign(handler, { fetch: handler });
`,
  )

  const maxDuration = manifest.routes.reduce<number | undefined>(
    (max, route) => (route.maxDuration ? Math.max(max ?? 0, route.maxDuration) : max),
    undefined,
  )
  await writeText(
    path.join(functionPath, '.vc-config.json'),
    `${JSON.stringify(
      {
        // The Bun function runtime (project-level `bunVersion` does not apply
        // to prebuilt Build Output API functions, so the version is pinned
        // here). Not `bun1.x`: that resolves to Bun 1.3.14, which segfaults a
        // second into serving and takes the whole function down with SIGABRT.
        // Note: bun functions have a 150 MiB uncompressed size limit vs 250
        // MiB for nodejs.
        runtime: 'bun1.4.x',
        handler: 'index.mjs',
        launcherType: 'Nodejs',
        architecture: FUNCTION_PLATFORM.architecture,
        // The default export takes a web `Request` and returns a `Response`.
        useWebApi: true,
        supportsResponseStreaming: true,
        ...(maxDuration ? { maxDuration } : {}),
      },
      null,
      2,
    )}\n`,
  )
}

/**
 * Grow `roots` with every workspace package transitively depended on by one of `from`. A workspace
 * dependency is one whose name maps to a package root in this workspace - the workspace: protocol is
 * the usual spelling, but a pinned version resolved through the workspace counts the same.
 */
function addWorkspaceDependencies(roots: Set<string>, packageRoots: string[], from: string[]) {
  const byName = new Map<string, string>()
  for (const root of packageRoots) {
    const name = packageManifest(root)?.name
    if (name && !byName.has(name)) byName.set(name, root)
  }
  const queue = [...from]
  const seen = new Set(queue)
  while (queue.length > 0) {
    const manifest = packageManifest(queue.pop()!)
    if (!manifest) continue
    for (const field of ['dependencies', 'optionalDependencies'] as const) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        const root = byName.get(name)
        if (!root || seen.has(root)) continue
        seen.add(root)
        roots.add(root)
        queue.push(root)
      }
    }
  }
}

interface PackageManifest {
  name?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

const manifests = new Map<string, PackageManifest | undefined>()

function packageManifest(root: string): PackageManifest | undefined {
  const cached = manifests.get(root)
  if (cached !== undefined || manifests.has(root)) return cached
  let parsed: PackageManifest | undefined
  try {
    parsed = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as PackageManifest
  } catch {
    parsed = undefined // not a package, or unreadable
  }
  manifests.set(root, parsed)
  return parsed
}

// Clones a tree with hardlinks instead of byte copies - the output is packaging-only, so sharing
// inodes is safe as long as nothing writes in place (rewriteBakedPaths unlinks before writing).
// Exclusions apply to direct children only; node_modules and .git are pruned at any depth. Symlinks
// are dereferenced so the replica is self-contained; the visited set breaks symlink cycles.
async function copyTree(
  from: string,
  to: string,
  pack: PackRules,
  excludeNames: string[] = [],
  visited = new Set<string>([realDir(from) ?? path.resolve(from)]),
) {
  const exclude = new Set(excludeNames)
  const clone = directoryCloneEnabled ? await directoryCloner() : null
  // Nothing to skip at this level: the whole tree clones in one syscall.
  if (exclude.size === 0 && !existsSync(to)) {
    await mkdir(path.dirname(to), { recursive: true })
    if (clone?.(from, to)) return normalizeClone(to, from, pack, visited)
  }
  // The build output is still live while the walk runs — typegen rewrites
  // `.pnext/types` under it — so a directory can vanish between the parent's
  // readdir and this one. It was never part of the shipped closure; skip it.
  const entries = readDirEntries(from)
  if (!entries) return
  await mkdir(to, { recursive: true })
  await Promise.all(
    entries.map(async entry => {
      const source = path.join(from, entry.name)
      const target = path.join(to, entry.name)
      // Matched by name before type: a symlinked `node_modules` must be pruned
      // as the directory it points at, not followed.
      if (exclude.has(entry.name) || !shipsDir(pack, entry.name, source, entry.isSymbolicLink()))
        return
      if (entry.isSymbolicLink()) {
        const link = resolveLinkTarget(source)
        if (!link) return
        if (link.isDirectory) {
          if (visited.has(link.path)) return
          visited.add(link.path)
          return copyTree(link.path, target, pack, [], visited)
        }
        return shipsFile(pack, entry.name, source) ? linkOrCopyFile(link.path, target) : undefined
      }
      // One syscall for the whole subtree beats one per file — the excluded
      // names are stripped from the copy afterwards.
      if (entry.isDirectory() && clone?.(source, target)) {
        return normalizeClone(target, source, pack, visited)
      }
      if (entry.isDirectory()) return copyTree(source, target, pack, [], visited)
      if (entry.isFile() && shipsFile(pack, entry.name, source))
        return linkOrCopyFile(source, target)
    }),
  )
}

/** Directory entries, or undefined if the directory vanished under the walk. */
function readDirEntries(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Directory-level copy-on-write clone, when the platform has one: macOS `clonefile` copies a whole
 * hierarchy in a single call and, like a hardlink, shares the underlying blocks. Resolved once and
 * never retried - no cloner just means the hardlink walk below does the work.
 */
// Test seam: the equivalence suite builds the same app both ways and diffs the trees.
let directoryCloneEnabled = true

/** @internal Test-only. Returns a restore function. */
export function setDirectoryCloneEnabled(enabled: boolean) {
  const previous = directoryCloneEnabled
  directoryCloneEnabled = enabled
  return () => {
    directoryCloneEnabled = previous
  }
}

let cloner: ((from: string, to: string) => boolean) | null | undefined
async function directoryCloner() {
  if (cloner !== undefined) return cloner
  cloner = null
  if (process.platform === 'darwin') {
    try {
      const { dlopen } = await import('bun:ffi')
      const { symbols } = dlopen('libSystem.B.dylib', {
        clonefile: { args: ['cstring', 'cstring', 'i32'], returns: 'i32' },
      })
      cloner = (from, to) =>
        symbols.clonefile(Buffer.from(`${from}\0`), Buffer.from(`${to}\0`), 0) === 0
    } catch {
      // no clonefile here; the per-file walk stays correct, just slower
    }
  }
  return cloner
}

/**
 * A clone is verbatim, so it still holds what the walk would have skipped:
 * drop the pruned entries and dereference inner symlinks, which would otherwise
 * point outside the function at runtime. Mirrors the walk's rules exactly, so
 * both paths emit the same tree. Reading directory entries costs nothing next
 * to the per-file copies this replaces.
 */
async function normalizeClone(
  dir: string,
  // Where `dir` was cloned from. Carried so the keep-path exemption reads the same here as in the
  // walk: the clone's own paths are inside the function and would never match a source keep path.
  from: string,
  pack: PackRules,
  visited: Set<string>,
) {
  const stack: [string, string][] = [[dir, from]]
  const pending: Promise<unknown>[] = []
  while (stack.length > 0) {
    const [current, currentFrom] = stack.pop()!
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      const source = path.join(currentFrom, entry.name)
      // Matched by name before type, as the walk does: the pages-compat shim
      // links `node_modules` at the app root, and following it would pull the
      // whole store into the function.
      if (!shipsDir(pack, entry.name, source, entry.isSymbolicLink())) {
        rmSync(full, { recursive: true, force: true })
      } else if (entry.isSymbolicLink()) {
        // From the source: a relative link in the clone would resolve against the function tree.
        const link = resolveLinkTarget(source)
        rmSync(full, { force: true })
        if (!link) continue
        if (link.isDirectory) {
          if (visited.has(link.path)) continue
          visited.add(link.path)
          pending.push(copyTree(link.path, full, pack, [], visited))
        } else if (shipsFile(pack, entry.name, source)) {
          pending.push(linkOrCopyFile(link.path, full))
        }
      } else if (entry.isDirectory()) {
        stack.push([full, source])
      } else if (!shipsFile(pack, entry.name, source)) {
        rmSync(full, { force: true })
      }
    }
  }
  await Promise.all(pending)
}

interface FrameworkPackage {
  root: string
  packageName: string
  /** Declared runtime dependencies — the only packages it can load eagerly. */
  dependencies: string[]
  /** Lazily loaded feature deps (og, mdx, sass, image optimization). */
  optionalDependencies: string[]
  inWorkspace: boolean
  /** Where the framework ships inside the function, relative to its root. */
  targetRel: string
}

// The framework itself ships with the function. Inside a workspace it keeps its
// workspace-relative location so baked paths line up; when consumed from
// outside the workspace (e.g. installed from a registry) it lands in the
// function's node_modules under its package name.
async function resolveFrameworkPackage(workspaceRoot: string): Promise<FrameworkPackage> {
  const root = path.resolve(import.meta.dirname, '../../..')
  const packageJson = await readPackageJson(root)
  const packageName = packageJson?.name ?? 'pnext'
  const inWorkspace = isInsideDir(workspaceRoot, root) && !root.includes('node_modules')
  return {
    root,
    packageName,
    // Never devDependencies: their tooling (typescript, eslint, …) is
    // reachable from build-time sources only and must not enter the function.
    dependencies: Object.keys(packageJson?.dependencies ?? {}),
    optionalDependencies: Object.keys(packageJson?.optionalDependencies ?? {}),
    inWorkspace,
    targetRel: inWorkspace
      ? path.relative(workspaceRoot, root)
      : path.join('node_modules', packageName),
  }
}

// Build-time directories a package that publishes its whole tree still keeps.
const packageCopyExcludes = [
  'node_modules',
  '.cache',
  '.vercel',
  '.next',
  '.pnext',
  '.turbo',
  'test',
  'tests',
  '__tests__',
]

/**
 * Copies a workspace package the way npm would publish it: a `files` list is the package's own
 * statement of what it ships, so it beats guessing at build-time directory names. Glob entries fall
 * back to the exclude list - matching npm's glob semantics is not worth it for a packaging copy.
 * `only` names a narrower list.
 */
async function copyPackageTree(from: string, to: string, pack: PackRules, only?: string[]) {
  const files = only ?? (await readPackageJson(from))?.files
  if (!files?.length || files.some(entry => /[*?[\]{}!]/.test(entry))) {
    return copyTree(from, to, pack, packageCopyExcludes)
  }
  await mkdir(to, { recursive: true })
  // npm always publishes these two regardless of `files`; the runtime resolves
  // through both (tsconfig for Bun's `paths`/jsx settings). Listed entries need
  // no exclude list — `files` already said what ships — which also lets each
  // directory clone whole.
  await Promise.all(
    [...files, 'package.json', 'tsconfig.json'].map(async name => {
      const source = path.join(from, name)
      const stats = statSync(source, { throwIfNoEntry: false })
      if (!stats) return
      if (stats.isDirectory()) return copyTree(source, path.join(to, name), pack)
      if (!shipsFile(pack, name, source)) return
      await mkdir(path.dirname(path.join(to, name)), { recursive: true })
      return linkOrCopyFile(source, path.join(to, name))
    }),
  )
}

async function readPackageJson(dir: string) {
  const file = path.join(dir, 'package.json')
  if (!existsSync(file)) return undefined
  return JSON.parse(await readFile(file, 'utf8')) as {
    name?: string
    version?: string
    files?: string[]
    os?: string[]
    cpu?: string[]
    libc?: string[]
    dependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
  }
}

// The closure hardlinks ~13k files: ~2.9s of a ~3.1s build. Test seam so suites
// asserting only config shape can skip it. Never off for a real deployment.
let dependencyClosureEnabled = true

/** @internal Test-only. Returns a restore function. */
export function setDependencyClosureEnabled(enabled: boolean) {
  const previous = dependencyClosureEnabled
  dependencyClosureEnabled = enabled
  return () => {
    dependencyClosureEnabled = previous
  }
}

function skipDependencyClosure() {
  return !dependencyClosureEnabled
}

async function linkOrCopyFile(from: string, to: string) {
  try {
    await link(from, to)
  } catch {
    // Same race as the walk above: a source that vanished mid-copy was never
    // part of the closure, and nothing else here is worth failing the build for.
    await copyFile(from, to).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }
}

// Where a symlink really points, and whether that is a directory. Dangling
// links are ordinary in a real node_modules (removed package, unmet optional
// dep, interrupted install), so an unreadable target is skipped rather than
// failing the build.
function resolveLinkTarget(link: string) {
  const resolved = realDir(link) ?? realFile(link)
  if (!resolved) return undefined
  try {
    return { path: resolved, isDirectory: statSync(resolved).isDirectory() }
  } catch {
    return undefined
  }
}

function realFile(file: string) {
  try {
    return realpathSync(file)
  } catch {
    return undefined
  }
}

function isInsideDir(root: string, file: string) {
  const relative = path.relative(root, file)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * Whether a compat alias resolves to framework source (react, next/*) rather than to a real package.
 * Containment, not a `node_modules` substring: an installed framework lives under node_modules
 * itself, and a substring test there classifies every next/* shim as a package to ship.
 * @internal Exported for tests.
 */
export function isFrameworkOwnedAliasTarget(frameworkRoot: string, target: string) {
  if (!path.isAbsolute(target) || !isInsideDir(frameworkRoot, target)) return false
  // A nested store under the framework root is still a real package.
  return !path.relative(frameworkRoot, target).split(path.sep).includes('node_modules')
}

function frameworkOwnedAliases(config: ResolvedConfig, frameworkRoot: string) {
  return Object.entries(getImportAliasExtensions().aliases(config, 'server')).filter(([, target]) =>
    isFrameworkOwnedAliasTarget(frameworkRoot, target),
  )
}

async function injectCompatPaths(
  config: ResolvedConfig,
  functionPath: string,
  frameworkRoot: string,
  replicaPathFor: (file: string) => string | undefined,
) {
  const aliasTargets = frameworkOwnedAliases(config, frameworkRoot)
    .map(([specifier, target]) => [specifier, replicaPathFor(target)] as const)
    .filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
  if (aliasTargets.length === 0) return

  for (const file of walkTsconfigFiles(functionPath)) {
    let parsed: { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } }
    try {
      const source = stripJsonComments(await readFile(file, 'utf8')).replace(/,\s*([}\]])/g, '$1')
      parsed = JSON.parse(source) as typeof parsed
    } catch (error) {
      console.warn(`vercel adapter: could not update ${file}:`, error)
      continue
    }
    const dir = path.dirname(file)
    const compilerOptions = (parsed.compilerOptions ??= {})
    const paths = (compilerOptions.paths ??= {})
    for (const [specifier, target] of aliasTargets) {
      if (paths[specifier]) continue
      const relative = toPosixPath(path.relative(dir, target))
      paths[specifier] = [relative.startsWith('.') ? relative : `./${relative}`]
    }
    compilerOptions.baseUrl ??= '.'
    // The replica shares inodes with the original tsconfig; never write
    // through the hardlink.
    await rm(file)
    await writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`)
  }
}

// Minimal JSONC support for tsconfig files: strips // and /* */ comments
// outside strings (a "$schema": "https://..." value must survive).
function stripJsonComments(source: string) {
  let result = ''
  let inString = false
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!
    if (inString) {
      result += char
      if (char === '\\') {
        result += source[++index] ?? ''
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      result += char
      continue
    }
    if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index++
      result += '\n'
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index++
      index++
      continue
    }
    result += char
  }
  return result
}

const bakedPathFileFilter = /\.(?:m?js|cjs|jsx|tsx?|json|html|css)$/

// The build output is thousands of small files and only a few hundred carry a
// baked path, so the pass is io-latency-bound: run it in bounded-concurrency
// batches instead of one file at a time.
const BAKED_PATH_CONCURRENCY = 64

async function rewriteBakedPaths(
  dir: string,
  replacements: readonly (readonly [string, string])[],
) {
  if (!existsSync(dir)) return
  const files = (await listFiles(dir)).filter(file => bakedPathFileFilter.test(file))
  for (let i = 0; i < files.length; i += BAKED_PATH_CONCURRENCY) {
    await Promise.all(
      files.slice(i, i + BAKED_PATH_CONCURRENCY).map(async file => {
        const source = await readFile(file, 'utf8')
        let rewritten = source
        for (const [from, to] of replacements) {
          if (rewritten.includes(from)) rewritten = rewritten.replaceAll(from, to)
        }
        if (rewritten === source) return
        // The replica is hardlinked to the real build output; unlink before
        // writing so the rewrite never reaches the original through a shared
        // inode.
        await rm(file)
        await writeFile(file, rewritten)
      }),
    )
  }
}

/**
 * An artifact's import specifiers, preferring the sidecar the compile step recorded over re-reading
 * and re-parsing the file. Falls back to the parse whenever the sidecar is missing or unreadable - a
 * stale cache hit from a prior dev build never wrote one - so the traced closure is identical either
 * way, just cheaper when it is there.
 */
async function artifactSpecifiers(file: string): Promise<string[] | null> {
  const sidecar = await readFile(`${file}${compiledSpecifiersManifestSuffix}`, 'utf8').catch(
    () => null,
  )
  if (sidecar !== null) {
    try {
      const parsed: unknown = JSON.parse(sidecar)
      if (Array.isArray(parsed) && parsed.every(entry => typeof entry === 'string')) {
        return parsed
      }
    } catch {
      // malformed sidecar (partial write, foreign tool) — fall through to parse
    }
  }
  const source = await readFile(file, 'utf8').catch(() => null)
  return source === null ? null : importSpecifiers(source, file)
}

// Ship only the node_modules packages the server can actually reach at request time: bare imports
// traced from the modules the runtime loads, plus the framework's declared runtime dependencies,
// expanded through their dependency closures. Nothing reachable only from build-time code enters the
// function - the full monorepo node_modules does not fit Vercel's size limit. Returns the closure
// plus the deferred copy so the caller can order the io.
async function traceNodeModulesClosure(
  config: ResolvedConfig,
  manifest: BuildManifest,
  functionPath: string,
  framework: FrameworkPackage,
  warmedModules: string[],
  pack: PackRules,
  log: VerboseLogger,
  // A release imports only build output, so its closure is traced from that alone.
  release = false,
) {
  const workspaceRoot = config.workspaceRoot
  const specifiers = new Set<string>()
  const tracedFiles = new Set<string>()
  // Package directories compiled modules import by absolute href (natively loaded server
  // dependencies, externals). One outside the top-level node_modules ships where it is.
  const hrefPackageDirs = new Set<string>()
  // Compat-aliased specifiers whose target lives in the framework source
  // (react, next/*) never resolve from node_modules at runtime — shipping
  // them would drag in the full next/react trees. Aliases that point into
  // node_modules (the pinned preact family) still need their packages.
  const frameworkAliasedSpecifiers = new Set(
    frameworkOwnedAliases(config, path.resolve(framework.root)).map(([specifier]) => specifier),
  )
  await log.step('trace runtime imports', async () => {
    // Only code Bun imports raw at request time needs real node_modules: route handlers, the proxy,
    // the config chain, and the compiled modules the warm step just wrote. Pages resolve through that
    // compiled cache; what it does not vendor (server dependencies Bun loads natively, externals) it
    // imports by absolute href, and those packages ship with their dependency closure below.
    const queue: string[] = []
    const seen = tracedFiles
    const enqueue = (file: string | undefined) => {
      if (!file) return
      const resolved = path.resolve(file)
      if (seen.has(resolved) || !existsSync(resolved)) return
      seen.add(resolved)
      queue.push(resolved)
    }

    if (!release) {
      for (const route of manifest.routes) {
        if (route.kind === 'handler') enqueue(route.file)
      }
      enqueue(findProxyFile(config) ?? undefined)
      enqueue(path.join(config.root, 'pnext.config.ts'))
      enqueue(path.join(config.root, 'next.config.js'))
    }
    for (const file of warmedModules) enqueue(file)

    const visit = async (file: string) => {
      if (!scriptFilePattern.test(file)) return
      const found = await artifactSpecifiers(file)
      if (found === null) return
      for (const specifier of found) {
        if (frameworkAliasedSpecifiers.has(specifier)) continue
        // Compiled modules import each other — and whatever the compiler left
        // external — by absolute href. Follow the ones inside the build output
        // and ship the packages the rest point into.
        const absolute = absolutePathFromSpecifier(specifier)
        // The framework ships whole at its own location, where baked paths are rewritten to.
        if (absolute && isInsideDir(framework.root, absolute)) continue
        if (absolute) {
          const name = packageNameFromPath(absolute)
          if (name) {
            specifiers.add(name)
            hrefPackageDirs.add(packageDirFromPath(absolute, name))
          } else if (isInsideDir(config.outPath, absolute)) enqueue(absolute)
          continue
        }
        if (/^(?:node:|bun$|bun:|data:)/.test(specifier)) continue
        // resolveImport covers relative paths, tsconfig aliases, package imports and workspace
        // packages - workspace source gets traced further. Bare package specifiers are also recorded
        // so the closure ships (or workspace-links) their node_modules entries; workspace packages
        // need the link even when their source is traced.
        const resolved = resolveImport(config.root, file, specifier, config.workspaceRoot)
        if (
          resolved &&
          isInsideDir(workspaceRoot, resolved) &&
          !resolved.includes('node_modules')
        ) {
          enqueue(resolved)
        }
        // A release reaches an installed package it cannot name bare by a relative path.
        const installed = specifier.startsWith('.') && resolved && packageNameFromPath(resolved)
        if (installed) {
          specifiers.add(installed)
          hrefPackageDirs.add(packageDirFromPath(resolved, installed))
        }
        const name = packageNameFromSpecifier(specifier)
        if (name) specifiers.add(name)
      }
    }

    // A level's reads are independent, so the walk advances a level at a time, bounded so a wide
    // graph cannot exhaust the fd table.
    const READ_BATCH = 64
    for (let frontier = queue.splice(0); frontier.length > 0; frontier = queue.splice(0)) {
      for (let index = 0; index < frontier.length; index += READ_BATCH) {
        await Promise.all(frontier.slice(index, index + READ_BATCH).map(visit))
      }
    }
    log.log(`traced ${seen.size} runtime modules`)
  })

  const packageDirs = new Map<string, string>()
  // A dependency version nested under the package that needs it (a version conflict): it ships
  // under that package's copy, where Bun resolves it from at runtime, not over the hoisted one.
  const nestedCopies = new Map<string, string>()
  const workspaceLinks = new Map<string, string>()
  // Native bindings resolved here are built for the build host; the function
  // needs the ones for its own platform, fetched below.
  const hostNatives = new Map<string, { dir: string; owner?: PackageVersion }>()
  // The framework ships whole, so what it can load at runtime is exactly what it declares as a
  // runtime dependency - resolved from its own root, which is not the app's when it comes from a
  // registry. Its optional deps back compat features that only load when the app uses them, so they
  // ship only where the app declares them too.
  const appDependencies = await declaredDependencies(config.root)
  // A release never compiles, so only the dependencies its runtime entries import ship - not the
  // compilers the framework also depends on for build and dev.
  const runtimeDependencies = release ? await frameworkRuntimePackages(framework.root) : undefined
  const queue: { name: string; from: string; owner?: PackageVersion }[] = [
    ...framework.dependencies
      .filter(name => !runtimeDependencies || runtimeDependencies.has(name))
      .map(name => ({ name, from: framework.root })),
    ...framework.optionalDependencies
      .filter(name => appDependencies.has(name))
      .map(name => ({ name, from: framework.root })),
    ...[...specifiers].map(name => ({ name, from: workspaceRoot })),
  ]
  const seen = new Set<string>()

  while (queue.length > 0) {
    const { name, from, owner } = queue.shift()!
    if (seen.has(name)) continue
    seen.add(name)
    // The framework is copied to its own location by the caller; copying it
    // again under its package name collides with that (and with the workspace
    // link it needs when it lives in the workspace).
    if (name === framework.packageName) {
      if (framework.inWorkspace) workspaceLinks.set(name, framework.targetRel)
      continue
    }
    const dir = resolvePackageDir(name, [from, workspaceRoot, config.root])
    if (!dir) continue

    // Workspace packages ship at their workspace-relative path; link them so
    // bare imports resolve to the same real path the compiled cache uses.
    const workspaceRelative = path.relative(workspaceRoot, dir)
    if (!workspaceRelative.startsWith('..') && !workspaceRelative.startsWith('node_modules')) {
      workspaceLinks.set(name, workspaceRelative)
      continue
    }

    const packageJson = await readPackageJson(dir)
    // `os`/`cpu` are npm's own declaration that a package is platform-bound;
    // one that already fits the function's platform ships as-is.
    const platformBound = Boolean(packageJson?.os ?? packageJson?.cpu)
    if (packageJson && platformBound && !matchesFunctionPlatform(packageJson)) {
      hostNatives.set(name, { dir, owner })
      continue
    }
    packageDirs.set(name, dir)
    if (!packageJson) continue
    // Peer dependencies are deliberately not expanded — they fan out to whole
    // ecosystems (react, next, ...) that are only shipped when something
    // actually imports them.
    const expand = async (
      packageDir: string,
      packageJson: Awaited<ReturnType<typeof readPackageJson>>,
      target: string,
    ) => {
      const self = { name: packageJson?.name ?? name, version: packageJson?.version ?? '' }
      for (const dependency of [
        ...Object.keys(packageJson?.dependencies ?? {}),
        ...Object.keys(packageJson?.optionalDependencies ?? {}),
      ]) {
        const nested = path.join(packageDir, 'node_modules', dependency)
        const nestedJson = existsSync(path.join(nested, 'package.json'))
          ? await readPackageJson(nested)
          : undefined
        if (!nestedJson || nestedJson.os || nestedJson.cpu) {
          queue.push({ name: dependency, from: packageDir, owner: self })
          continue
        }
        const nestedTarget = path.join(target, 'node_modules', dependency)
        if (nestedCopies.has(nestedTarget)) continue
        nestedCopies.set(nestedTarget, nested)
        await expand(nested, nestedJson, nestedTarget)
      }
    }
    await expand(dir, packageJson, path.join('node_modules', name))
  }

  if (hostNatives.size > 0 && !skipDependencyClosure()) {
    const targets = await log.step(
      `resolve ${FUNCTION_PLATFORM.os}-${FUNCTION_PLATFORM.cpu} natives (${hostNatives.size} packages)`,
      () => platformNativePackages(hostNatives, log),
    )
    for (const [name, dir] of targets) packageDirs.set(name, dir)
  }

  const copy = async () => {
    const entries = skipDependencyClosure() ? [] : [...packageDirs]
    const batchSize = 16
    for (let index = 0; index < entries.length; index += batchSize) {
      await Promise.all(
        entries.slice(index, index + batchSize).map(async ([name, dir]) => {
          const target = path.join(functionPath, 'node_modules', name)
          await mkdir(path.dirname(target), { recursive: true })
          await copyTree(dir, target, pack)
        }),
      )
    }
    for (const [target, dir] of skipDependencyClosure() ? [] : nestedCopies) {
      await mkdir(path.dirname(path.join(functionPath, target)), { recursive: true })
      await copyTree(dir, path.join(functionPath, target), pack)
    }
    // Baked paths map the workspace root onto the function root, so an href into a nested or
    // app-level node_modules needs that exact directory there.
    for (const dir of skipDependencyClosure() ? [] : hrefPackageDirs) {
      const relative = path.relative(workspaceRoot, dir)
      const target = path.join(functionPath, relative)
      if (relative.startsWith('..') || existsSync(target)) continue
      await mkdir(path.dirname(target), { recursive: true })
      await copyTree(dir, target, pack)
    }
    for (const [name, workspaceRelative] of workspaceLinks) {
      const linkPath = path.join(functionPath, 'node_modules', name)
      await mkdir(path.dirname(linkPath), { recursive: true })
      const target = path.relative(
        path.dirname(linkPath),
        path.join(functionPath, workspaceRelative),
      )
      if (!existsSync(linkPath)) await symlink(target, linkPath, 'dir')
    }
  }

  return {
    tracedFiles,
    workspacePackages: [...workspaceLinks.values()],
    packageCount: packageDirs.size,
    copy,
  }
}

interface PackageVersion {
  name: string
  version: string
}

/** Every compiled entry `<out>/server/build-index.json` names, when the build emitted one. */
function releaseEntries(config: ResolvedConfig, manifest: BuildManifest): string[] | undefined {
  if (!existsSync(buildIndexFile(config.outPath))) return undefined
  const index = readBuildIndex(config.outPath)
  return [
    ...Object.values(index.modules),
    index.nextConfig,
    index.instrumentation?.file,
    index.instrumentation?.edge,
    ...Object.values(index.compat?.cacheHandlers ?? {}),
    manifest.proxyModule,
  ]
    .filter(artifact => artifact !== undefined)
    .map(artifact => path.resolve(config.outPath, artifact))
}

/**
 * Packages the framework's production entries import, statically or dynamically. Lazy `require`s
 * are the compiler facades (esbuild, oxc), which only build and dev reach.
 */
async function frameworkRuntimePackages(frameworkRoot: string) {
  const src = path.join(frameworkRoot, 'src')
  const scanners = {
    ts: new Bun.Transpiler({ loader: 'ts' }),
    tsx: new Bun.Transpiler({ loader: 'tsx' }),
  }
  const queue = [
    ...runtimeEntryFiles.map(file => path.join(src, file)),
    ...runtimeEntryDirs.flatMap(dir =>
      listSourceFiles(path.join(src, dir)).filter(file => /(?<!\.d)\.tsx?$/.test(file)),
    ),
  ]
  const seen = new Set(queue)
  const packages = new Set<string>()
  for (const file of queue) {
    const scanner = file.endsWith('.tsx') || file.endsWith('.jsx') ? scanners.tsx : scanners.ts
    for (const edge of scanner.scanImports(await readFile(file, 'utf8'))) {
      if (edge.kind !== 'import-statement' && edge.kind !== 'dynamic-import') continue
      if (!edge.path.startsWith('.')) {
        const name = packageNameFromSpecifier(edge.path)
        if (name) packages.add(name)
        continue
      }
      const target = resolveFrom(edge.path, path.dirname(file))
      if (
        target &&
        !seen.has(target) &&
        isInsideDir(src, target) &&
        scriptFilePattern.test(target)
      ) {
        seen.add(target)
        queue.push(target)
      }
    }
  }
  return packages
}

function resolveFrom(specifier: string, dir: string) {
  try {
    return Bun.resolveSync(specifier, dir)
  } catch {
    return undefined
  }
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory()
      ? listSourceFiles(path.join(dir, entry.name))
      : [path.join(dir, entry.name)],
  )
}

/**
 * Native bindings for the function's platform, not the build host's. The host install only ever
 * carries its own platform's optional deps, so the right builds have to come from the registry: one
 * cross-platform install per distinct set of owning packages, cached by content in the user cache dir
 * (the build output is wiped every build). Falls back to the host copies when the install is
 * unavailable (offline CI, private registry), so packaging never hard-fails on a network hiccup.
 */
async function platformNativePackages(
  hostNatives: Map<string, { dir: string; owner?: PackageVersion }>,
  log: VerboseLogger,
) {
  // Install the package that *owns* the binding: only it lists every
  // platform's build in its optional deps.
  const owners = new Map<string, string>()
  for (const [name, { dir, owner }] of hostNatives) {
    const spec = owner ?? { name, version: (await readPackageJson(dir))?.version ?? '' }
    if (spec.version) owners.set(spec.name, spec.version)
  }
  const specs = [...owners].map(([name, version]) => `${name}@${version}`).sort()
  const fallback = () => new Map([...hostNatives].map(([name, { dir }]) => [name, dir]))
  if (specs.length === 0) return fallback()

  try {
    const installed = await crossPlatformInstall(specs)
    const matches = new Map<string, string>()
    for (const [name, dir] of installed) {
      const packageJson = await readPackageJson(dir)
      if (packageJson && matchesFunctionPlatform(packageJson)) matches.set(name, dir)
    }
    if (matches.size === 0) {
      throw new Error(`no ${FUNCTION_PLATFORM.os} builds in ${specs.join(' ')}`)
    }
    return matches
  } catch (error) {
    console.warn(
      `vercel adapter: could not fetch ${FUNCTION_PLATFORM.os}-${FUNCTION_PLATFORM.cpu} native packages; ` +
        `the function will carry this machine's builds and fail at runtime:`,
      error,
    )
    log.log('falling back to host native packages')
    return fallback()
  }
}

function matchesFunctionPlatform(packageJson: { os?: string[]; cpu?: string[]; libc?: string[] }) {
  // npm's field semantics: an all-negated list excludes, anything else is an
  // allow-list (`os: ["!win32"]` still fits linux).
  const matches = (declared: string[] | undefined, value: string) => {
    if (!declared?.length) return true
    if (declared.every(entry => entry.startsWith('!'))) return !declared.includes(`!${value}`)
    return declared.includes(value)
  }
  return (
    matches(packageJson.os, FUNCTION_PLATFORM.os) &&
    matches(packageJson.cpu, FUNCTION_PLATFORM.cpu) &&
    // Both a glibc and a musl build exist for the same os/cpu; Vercel's
    // function runtime is glibc.
    matches(packageJson.libc, FUNCTION_PLATFORM.libc)
  )
}

/**
 * Installs `specs` for the function's platform into a content-addressed cache
 * directory and returns every package that landed. Bun's `--os`/`--cpu` pick
 * the target's optional deps instead of this machine's; its own download cache
 * makes a repeat install ~0.1s, and the directory cache makes it free.
 */
async function crossPlatformInstall(specs: string[]) {
  const key = Bun.hash
    .xxHash3(`${FUNCTION_PLATFORM.os}-${FUNCTION_PLATFORM.cpu}\0${specs.join('\0')}`)
    .toString(16)
  const dir = path.join(cacheRoot(), 'vercel-natives', key)
  const modules = path.join(dir, 'node_modules')
  if (!existsSync(modules)) {
    // Land under a temp name and rename: a concurrent build must never read a
    // half-installed tree.
    const staging = `${dir}.${process.pid.toString(36)}`
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    await writeText(path.join(staging, 'package.json'), '{"name":"pnext-natives"}\n')
    const install = Bun.spawn(
      [
        'bun',
        'add',
        '--no-save',
        '--ignore-scripts',
        '--silent',
        `--os=${FUNCTION_PLATFORM.os}`,
        `--cpu=${FUNCTION_PLATFORM.cpu}`,
        ...specs,
      ],
      { cwd: staging, stdout: 'ignore', stderr: 'pipe' },
    )
    if ((await install.exited) !== 0) {
      const stderr = await new Response(install.stderr).text()
      await rm(staging, { recursive: true, force: true })
      throw new Error(stderr.trim() || 'bun add failed')
    }
    await rm(dir, { recursive: true, force: true })
    await rename(staging, dir)
  }

  const installed = new Map<string, string>()
  for (const entry of readdirSync(modules)) {
    if (entry.startsWith('.')) continue
    if (!entry.startsWith('@')) {
      installed.set(entry, path.join(modules, entry))
      continue
    }
    for (const scoped of readdirSync(path.join(modules, entry))) {
      installed.set(`${entry}/${scoped}`, path.join(modules, entry, scoped))
    }
  }
  return installed
}

const scriptFilePattern = /\.(?:m?js|cjs|jsx|tsx?)$/

// Directories the shipped tsconfigs can never live in; pruned during the walk —
// a naive recursive listing would crawl the function's own node_modules.
const skippedScanDirs = new Set(['node_modules', '.git', '.next', '.pnext', '.turbo', '.vercel'])

function* walkTsconfigFiles(root: string): Generator<string> {
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!skippedScanDirs.has(entry.name)) stack.push(full)
      } else if (entry.isFile() && entry.name === 'tsconfig.json') {
        yield full
      }
    }
  }
}

/** Every dependency name an app's own package.json declares. */
async function declaredDependencies(root: string) {
  const packageJson = (await readPackageJson(root)) as
    Record<string, Record<string, string> | undefined> | undefined
  return new Set(
    ['dependencies', 'optionalDependencies', 'devDependencies'].flatMap(field =>
      Object.keys(packageJson?.[field] ?? {}),
    ),
  )
}

/** Absolute path behind an `import`, whether written as a path or a file URL. */
function absolutePathFromSpecifier(specifier: string) {
  if (specifier.startsWith('file://')) return fileURLToPath(specifier)
  return path.isAbsolute(specifier) ? specifier : undefined
}

/** The `<...>/node_modules/<name>` directory holding `file`. */
function packageDirFromPath(file: string, name: string) {
  const posix = toPosixPath(file)
  const marker = `/node_modules/${name}/`
  return posix.slice(0, posix.lastIndexOf(marker) + marker.length - 1)
}

/** The package an absolute path belongs to, if it points inside node_modules. */
function packageNameFromPath(file: string) {
  const parts = toPosixPath(file).split('/node_modules/')
  const tail = parts.at(-1)
  if (parts.length < 2 || !tail) return undefined
  const segments = tail.split('/')
  return segments[0]?.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
}

function packageNameFromSpecifier(specifier: string) {
  if (/^[./#]|^file:|^node:|^data:/.test(specifier)) return undefined
  if (specifier === 'bun' || specifier.startsWith('bun:')) return undefined
  if (specifier.includes(':')) return undefined
  // Scoped names need a real scope — `@/env`-style tsconfig aliases are not
  // packages.
  if (specifier.startsWith('@') && !/^@[^/]+\/[^/]+/.test(specifier)) return undefined
  const parts = specifier.split('/')
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  if (!name || builtinModules.includes(name)) return undefined
  return name
}

function resolvePackageDir(name: string, fromDirs: string[]) {
  for (const from of fromDirs) {
    let dir = path.resolve(from)
    while (true) {
      const candidate = path.join(dir, 'node_modules', name)
      if (existsSync(path.join(candidate, 'package.json'))) return realDir(candidate)
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return undefined
}

function realDir(dir: string) {
  try {
    return statSync(dir).isDirectory() ? realpathSync(dir) : undefined
  } catch {
    return undefined
  }
}

async function copyStaticFiles(
  from: string,
  to: string,
  shouldCopy: (relative: string) => boolean = () => true,
) {
  const files = (await listFiles(from)).filter(file =>
    shouldCopy(toPosixPath(path.relative(from, file))),
  )
  // One mkdir per directory, not per file, then link them all at once.
  const directories = new Set(
    files.map(file => path.dirname(path.join(to, path.relative(from, file)))),
  )
  await Promise.all([...directories].map(dir => mkdir(dir, { recursive: true })))
  await Promise.all(
    files.map(file => linkOrCopyFile(file, path.join(to, path.relative(from, file)))),
  )
}

async function staticOverrides(
  publicPath: string,
  staticFiles: Record<string, StaticFileMetadata>,
) {
  const overrides: NonNullable<VercelConfig['overrides']> = {}
  for (const file of await listFiles(publicPath)) {
    const relative = toPosixPath(path.relative(publicPath, file))
    if (!relative.endsWith('/index.html')) continue
    overrides[relative] = { path: relative.replace(/\/index\.html$/, '') }
  }
  for (const [relative, metadata] of Object.entries(staticFiles)) {
    if (!canServeStaticOnVercel(metadata)) continue
    const contentType = metadata.headers.find(
      ([name]) => name.toLowerCase() === 'content-type',
    )?.[1]
    if (contentType) overrides[relative] = { ...overrides[relative], contentType }
  }
  return overrides
}

// `important` lets route headers win over the CDN's own static-file cache-control, as Next's builder does.
async function immutableAssetRoutes(publicDir: string, publicAssets: string[] = []) {
  const app = new Set(publicAssets)
  const built =
    publicAssets.length > 0
      ? (await listFiles(publicDir))
          .map(file => toPosixPath(path.relative(publicDir, file)))
          .filter(relative => !app.has(relative) && immutableAssetPath(relative))
      : []
  const patterns = immutableAssetPatterns(built, publicAssets)
  return routeSources(patterns, source => `^/(?:${source})`).map(src => ({
    src,
    headers: { 'cache-control': immutableCacheControl },
    continue: true,
    important: true,
  }))
}

/**
 * Whole immutable prefixes that hold no app public file; under the others, each build file collapsed
 * to its topmost folder below the prefix that holds no app public file, else its exact name.
 */
function immutableAssetPatterns(built: string[], publicAssets: string[]) {
  const appDirs = new Set(publicAssets.flatMap(ancestorDirs))
  const prefixes = [...new Set(immutableAssetPrefixes())]
  const patterns = prefixes.filter(prefix => !appDirs.has(prefix)).map(escapeRegex)
  for (const relative of built) {
    const prefix = prefixes.find(prefix => relative.startsWith(prefix))
    if (!prefix || !appDirs.has(prefix)) continue
    const dir = ancestorDirs(relative).find(dir => dir.length > prefix.length && !appDirs.has(dir))
    patterns.push(dir ? escapeRegex(requestPath(dir)) : `${escapeRegex(requestPath(relative))}$`)
  }
  return [...new Set(patterns)]
}

/** A public-relative path as browsers request it (the WHATWG path percent-encode set). */
function requestPath(relative: string) {
  return relative.replace(/[\0-\x20"#<>?`{}\x7f-\u{10ffff}]/gu, char => encodeURIComponent(char))
}

/** `a/b/c.js` -> `['a/', 'a/b/']`. */
function ancestorDirs(relative: string) {
  const parts = relative.split('/').slice(0, -1)
  return parts.map((_, index) => `${parts.slice(0, index + 1).join('/')}/`)
}

// Headers a CDN route cannot replay; a file that sets one stays on the server function.
const functionOnlyHeaders = new Set([
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'set-cookie',
])

function canServeStaticOnVercel(metadata: StaticFileMetadata) {
  if (metadata.status !== 200) return false
  const headers = routeHeaders(metadata)
  if (headers.length === 0) return true
  // ISR state needs the function to revalidate.
  return (
    metadata.revalidateSeconds === undefined &&
    metadata.expireSeconds === undefined &&
    !metadata.tags?.length &&
    headers.every(([name]) => !functionOnlyHeaders.has(name.toLowerCase()))
  )
}

/** Headers beyond content-type, which an override carries instead. */
function routeHeaders(metadata: StaticFileMetadata) {
  return metadata.headers.filter(([name]) => name.toLowerCase() !== 'content-type')
}

// Keeps each route pattern well inside Vercel's route size limits.
const maxRouteSourceLength = 2000

/**
 * Route headers for the CDN-served static files whose headers an override cannot carry, so the CDN
 * answers with what `pnext start` sends. Files sharing a header set share a route.
 */
function staticHeaderRoutes(staticFiles: Record<string, StaticFileMetadata>) {
  const groups = new Map<string, { headers: Record<string, string>; patterns: string[] }>()
  for (const [relative, metadata] of Object.entries(staticFiles)) {
    const extra = routeHeaders(metadata)
    if (extra.length === 0 || !canServeStaticOnVercel(metadata)) continue
    const headers = Object.fromEntries(new Headers(extra))
    const key = JSON.stringify(headers)
    const group = groups.get(key) ?? { headers, patterns: [] }
    groups.set(key, group)
    group.patterns.push(servedPathPattern(relative))
  }
  return [...groups.values()].flatMap(({ headers, patterns }) =>
    routeSources(patterns, source => `^/(?:${source})$`).map(src => ({
      src,
      methods: ['GET', 'HEAD'],
      headers,
      continue: true,
      important: true,
    })),
  )
}

/** Joins patterns into as few `wrap`ped route sources as fit `maxRouteSourceLength`. */
function routeSources(patterns: string[], wrap: (alternation: string) => string) {
  const sources: string[] = []
  for (const pattern of patterns) {
    const last = sources.length - 1
    if (last >= 0 && wrap(`${sources[last]}|${pattern}`).length <= maxRouteSourceLength) {
      sources[last] += `|${pattern}`
    } else {
      sources.push(pattern)
    }
  }
  return sources.map(wrap)
}

/** A static file's request paths: `a/index.html` also answers `/a` and `/a/`. */
function servedPathPattern(relative: string) {
  if (relative === 'index.html') return '(?:index\\.html)?'
  if (!relative.endsWith('/index.html')) return escapeRegex(relative)
  return `${escapeRegex(relative.slice(0, -'/index.html'.length))}(?:/|/index\\.html)?`
}
