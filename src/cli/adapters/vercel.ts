import { copyFile, link, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_OUT_DIR, pathToFileHref } from '../../config'
import type { ResolvedConfig } from '../../config'
import { globalCssSources } from '../../css/build'
import { getImportAliasExtensions } from '../../extensions'
import { nextCompatEnabled } from '../../render/hooks'
import { importSpecifiers } from '../../resolve/scan-facts'
import { compiledSpecifiersManifestSuffix } from '../../runtime/modules'
import { resolveImport, workspacePackageRoots } from '../../resolve/imports'
import { findProxyFile, proxyRoutePatterns, type ProxyModule } from '../../routing/proxy'
import { cacheRoot } from '../boot/named-bin'
import { startWarmChild, type WarmChild } from './vercel-warm'
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
  /** Absolute sources exempt from the prune list — the app's own build output. */
  keepPaths: Set<string>
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
  if (!packPruningEnabled) {
    return {
      // The two the function could never resolve through stay pruned even
      // here: a nested store or object database is not a packing choice.
      prunedDirs: new Set(['node_modules', '.git']),
      droppedSuffixes: [],
      keepPaths: new Set([path.resolve(config.outPath)]),
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
    // The app's outDir shares its name with the prune list; it holds the
    // compiled module cache the function serves from and must survive. The
    // default out root goes with it: a `distDir` app moved its output away, but
    // the next.config bundle the function imports at boot still lives there.
    keepPaths: new Set([path.resolve(config.outPath), path.resolve(config.root, DEFAULT_OUT_DIR)]),
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
  if (!pack.prunedDirs.has(name)) return true
  return !isLink && withinKeepPath(pack, source)
}

function shipsFile(pack: PackRules, name: string) {
  return !pack.droppedSuffixes.some(suffix => name.endsWith(suffix))
}

interface VercelConfig {
  version: 3
  routes?: (
    | { src: string; dest?: string; headers?: Record<string, string>; continue?: boolean }
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
  const warmSettled = warm.finish(log, modules => resolveWarmedModules(modules))
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
    // Chunk and font filenames are content-hashed; serve them immutable.
    {
      src: '^/assets/(chunks|fonts)/.*',
      headers: { 'cache-control': 'public, max-age=31536000, immutable' },
      continue: true,
    },
    // Proxy-matched paths go to the server function before the CDN filesystem
    // check — `pnext start` runs the proxy ahead of static files too.
    ...(await proxyRoutes(config)),
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
  return proxyRoutePatterns(proxyModule.config).map(src => ({
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
  const closure = await traceNodeModulesClosure(
    config,
    manifest,
    functionPath,
    framework,
    warmedModules,
    pack,
    log,
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
  // The renderer re-resolves the root layout's global css imports from source
  // at request time; the packages holding those css files must be present.
  for (const file of globalCssSources(config)) {
    const root = packageRoots.find(candidate => isInsideDir(candidate, file))
    if (root) neededRoots.add(root)
  }
  // Tracing sees what the *server* loaded, which is not everything the shipped source can still ask
  // for: the app's own sources travel with the function and a compat compile at request time resolves
  // their imports for real. A workspace package one of them names but no traced module reached would
  // not be here, so close over the declared workspace dependencies too.
  addWorkspaceDependencies(neededRoots, packageRoots, [path.resolve(config.root), ...neededRoots])
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
      // `public` is served by the CDN, never from the function; the rest are
      // named again because the app root is the one tree whose build output
      // ships, so it cannot rely on the depth-wise prune alone.
      copyTree(config.root, path.join(functionPath, appRel), pack, [
        'public',
        '.vercel',
        '.next',
        '.turbo',
      ]),
      copyPackageTree(pnextRoot, path.join(functionPath, pnextTargetRel), pack),
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

  const startEntry = toPosixPath(path.join(pnextTargetRel, 'src/cli/start.ts'))
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
        return shipsFile(pack, entry.name) ? linkOrCopyFile(link.path, target) : undefined
      }
      // One syscall for the whole subtree beats one per file — the excluded
      // names are stripped from the copy afterwards.
      if (entry.isDirectory() && clone?.(source, target)) {
        return normalizeClone(target, source, pack, visited)
      }
      if (entry.isDirectory()) return copyTree(source, target, pack, [], visited)
      if (entry.isFile() && shipsFile(pack, entry.name)) return linkOrCopyFile(source, target)
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
        const link = resolveLinkTarget(full)
        rmSync(full, { force: true })
        if (!link) continue
        if (link.isDirectory) {
          if (visited.has(link.path)) continue
          visited.add(link.path)
          pending.push(copyTree(link.path, full, pack, [], visited))
        } else if (shipsFile(pack, entry.name)) {
          pending.push(linkOrCopyFile(link.path, full))
        }
      } else if (entry.isDirectory()) {
        stack.push([full, source])
      } else if (!shipsFile(pack, entry.name)) {
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
 */
async function copyPackageTree(from: string, to: string, pack: PackRules) {
  const packageJson = await readPackageJson(from)
  const files = packageJson?.files
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
      if (!shipsFile(pack, name)) return
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
) {
  const workspaceRoot = config.workspaceRoot
  const specifiers = new Set<string>()
  const tracedFiles = new Set<string>()
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
    // compiled cache, whose externals are vendored, so their dependencies never load raw.
    const queue: string[] = []
    const seen = tracedFiles
    const enqueue = (file: string | undefined) => {
      if (!file) return
      const resolved = path.resolve(file)
      if (seen.has(resolved) || !existsSync(resolved)) return
      seen.add(resolved)
      queue.push(resolved)
    }

    for (const route of manifest.routes) {
      if (route.kind === 'handler') enqueue(route.file)
    }
    enqueue(findProxyFile(config) ?? undefined)
    enqueue(path.join(config.root, 'pnext.config.ts'))
    enqueue(path.join(config.root, 'next.config.js'))
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
        if (absolute) {
          const name = packageNameFromPath(absolute)
          if (name) specifiers.add(name)
          else if (isInsideDir(config.outPath, absolute)) enqueue(absolute)
          continue
        }
        if (/^(?:node:|bun$|bun:|data:)/.test(specifier)) continue
        // resolveImport covers relative paths, tsconfig aliases, package imports and workspace
        // packages - workspace source gets traced further. Bare package specifiers are also recorded
        // so the closure ships (or workspace-links) their node_modules entries; workspace packages
        // need the link even when their source is traced.
        const resolved = resolveImport(config.root, file, specifier)
        if (
          resolved &&
          isInsideDir(workspaceRoot, resolved) &&
          !resolved.includes('node_modules')
        ) {
          enqueue(resolved)
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
  const workspaceLinks = new Map<string, string>()
  // Native bindings resolved here are built for the build host; the function
  // needs the ones for its own platform, fetched below.
  const hostNatives = new Map<string, { dir: string; owner?: PackageVersion }>()
  // The framework ships whole, so what it can load at runtime is exactly what it declares as a
  // runtime dependency - resolved from its own root, which is not the app's when it comes from a
  // registry. Its optional deps back compat features that only load when the app uses them, so they
  // ship only where the app declares them too.
  const appDependencies = await declaredDependencies(config.root)
  const queue: { name: string; from: string; owner?: PackageVersion }[] = [
    ...framework.dependencies.map(name => ({ name, from: framework.root })),
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
    const self = { name, version: packageJson.version ?? '' }
    // Peer dependencies are deliberately not expanded — they fan out to whole
    // ecosystems (react, next, ...) that are only shipped when something
    // actually imports them.
    for (const dependency of [
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.optionalDependencies ?? {}),
    ]) {
      queue.push({ name: dependency, from: dir, owner: self })
    }
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

function canServeStaticOnVercel(metadata: StaticFileMetadata) {
  return (
    metadata.status === 200 &&
    metadata.headers.every(([name]) => name.toLowerCase() === 'content-type')
  )
}
