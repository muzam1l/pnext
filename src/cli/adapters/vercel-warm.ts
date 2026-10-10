import { resolveManifest } from '../../utils/fs'
/**
 * Module warm-up for a production build - run in its own process.
 *
 * Every build compiles the modules its production server can need (`compile` mode): a built app that
 * still compiles on its first request pays a whole cold pipeline - esbuild service included - inside
 * the response, which is neither a build output nor something a served request should do.
 *
 * The vercel adapter needs strictly more (`full` mode). Request time on Vercel is read-only, so
 * everything a production start would compile or *vendor* lazily has to be on disk already: that
 * mode also imports the app's route handlers and page modules once, so their on-demand vendor
 * bundles get written now.
 *
 * Importing handlers runs the app's own server code, which can crash the runtime rather than throw,
 * so the whole pass runs in a child that writes into the same on-disk build cache the parent reads
 * back. Because that cache is on disk, a crash costs one file and not the pass: the child reports
 * each file as it lands, and the parent restarts it with those files skipped until an attempt stops
 * making progress.
 *
 * Ordering is load-bearing, not incidental. Compiles come first and handlers last: handler code
 * running *concurrently* with the compile pass takes the runtime down, while the same compiles with
 * handlers skipped, and the same handlers against a populated cache, both run clean.
 *
 * The child starts when the build starts, so its boot overlaps the build. It then compiles the page
 * routes' server modules as soon as the route scan hands them over, and blocks on stdin for the
 * go-ahead to finish the rest once the manifest is written.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_OUT_DIR,
  loadConfig,
  pathToFileHref,
  standaloneOutSegment,
  type ResolvedConfig,
} from '../../config'
import { bootstrapCompat } from '../../compat-bootstrap'
import { compiledClientReferenceFiles, ssrClientReference } from '../../client/reference'
import { hasUseClientDirective } from '../../client/reference-stub'
import { moduleExportNames } from '../../resolve/scan-facts'
import { globalCssSources } from '../../css/build'
import {
  devClientModuleHref,
  devModuleGraph,
  devServerModuleHref,
  setEmitCompiledSpecifiersManifest,
  setReleaseCompile,
} from '../../runtime/modules'
import { getCompatModeExtensions } from '../../extensions'
import { getFontExtensions, type ReleasedFont } from '../../render/hooks'
import { beginSourceScope, readSourceSync } from '../../resolve/source-text'
import { releasedProxy } from '../../routing/proxy-config'
import { findConventionFiles, findLayouts } from '../../routing/routes'
import {
  pagesApiBundleTargetForRuntime,
  registerServerRuntime,
  serverBundleTargetForRuntime,
  type ServerBundleTarget,
} from '../../runtime/loader'
import {
  BUILD_INDEX_VERSION,
  type CompatRelease,
  type ReleaseLayer,
  captureConventions,
  releaseModuleKey,
  releaseSourceKey,
  serializeReleaseConfig,
  writeBuildIndex,
  buildManifestFile,
  buildIndexFile,
} from '../../runtime/production'
import { frameworkFingerprint } from '../../runtime/fingerprint'
import { releaseDependencyLog } from '../../runtime/vendor-build'
import { linkReleaseLayer, pruneReleaseVendor } from '../../runtime/release-graph'
import { namedBunBinary } from '../boot/named-bin'
import type { VerboseLogger } from '../../utils/verbose'
import type { BuildManifest } from '../../types'

// The child reports one line per file it finishes — `<source>` for an imported
// route handler, `<source>\t<compiled>` for a compiled module. Everything else
// it prints is app output the parent passes through.
const DONE_MARKER = 'pnext-warm-done:'

// Printed once compiles finish and before the handler loop starts: the
// compiled artifact set is already final at that boundary, so the parent can
// start tracing the node_modules closure while this process runs handlers.
const COMPILED_MARKER = 'pnext-warm-compiled'

/**
 * What the parent sends over stdin, one JSON object per line. A `prewarm`
 * message names page sources the child may start compiling right away; the
 * `skip` message is the go-ahead for the full pass and always comes last.
 */
interface WarmRequest {
  /** Files a previous attempt already finished — or died on. */
  skip: string[]
  /** Release modules a previous attempt compiled, so the release this attempt writes is whole. */
  compiled: Record<string, string>
  /** Facts the parent already holds: the root layout's stylesheet closure and its own compiled client references. */
  globalCss?: string[]
  clientReferences: string[]
}
interface PrewarmRequest {
  /** Page route sources, known from the route scan long before the manifest. */
  prewarm: string[]
}

// An attempt still running after this long is not going to finish: something in
// the app's own code is holding the process. Bounded so the build completes
// instead of hanging forever.
const ATTEMPT_TIMEOUT_MS = 10 * 60_000

// One clean pass, plus enough restarts to step over a couple of poisoned files
// before concluding the app cannot be warmed.
const MAX_ATTEMPTS = 3

/**
 * `compile` writes every artifact the production server would otherwise build inside a request;
 * `full` additionally imports the app's own modules so their vendor bundles land too (see above).
 */
export type WarmMode = 'compile' | 'full'

/** argv flag rather than a stdin message: the child picks its mode before the first prewarm batch. */
const FULL_MODE_FLAG = '--full'

export interface WarmChild {
  /**
   * Hand the child the page sources from the route scan so it compiles them
   * under the rest of the build. Optional and fire-and-forget: whatever it does
   * not get to, `finish` compiles.
   */
  prewarm(files: string[]): void
  /**
   * Release the child to warm, and collect the module paths it compiled. `onCompiled`, if given,
   * fires once - as soon as the child reaches its handler phase - with the modules compiled so far,
   * which is already the final set: the caller can start tracing the node_modules closure while the
   * child runs handlers concurrently.
   */
  finish(
    log: VerboseLogger,
    onCompiled?: (modules: string[]) => void,
    facts?: Pick<WarmRequest, 'globalCss' | 'clientReferences'>,
  ): Promise<string[]>
  /** Stop every attempt owned by this build. Safe to call after `finish` or more than once. */
  kill(): void
}

type WarmProcess = Bun.Subprocess<'pipe', 'pipe', 'pipe'>

/**
 * Spawn the warm child. Call as early in the build as possible: it boots while the build runs and
 * does no work until `finish`, which must be called only after the build manifest is on disk. Never
 * throws - a warm-up that cannot start degrades to "no warmed modules", which `finish` reports.
 */
export function startWarmChild(config: ResolvedConfig, mode: WarmMode = 'full'): WarmChild {
  const children = new Set<WarmProcess>()
  let disposed = false
  const spawn = () => {
    if (disposed) return undefined
    const child = spawnWarmProcess(config, mode)
    if (!child) return undefined
    children.add(child)
    void child.exited.finally(() => children.delete(child))
    void forwardWarmStderr(child)
    return child
  }
  const killOnExit = () => kill()
  const kill = () => {
    if (disposed) return
    disposed = true
    process.off('exit', killOnExit)
    for (const child of children) child.kill()
    children.clear()
  }
  process.once('exit', killOnExit)
  const first = spawn()
  return {
    prewarm(files) {
      if (!first || files.length === 0) return
      try {
        void first.stdin.write(`${JSON.stringify({ prewarm: files } satisfies PrewarmRequest)}\n`)
        void first.stdin.flush()
      } catch {
        // broken pipe: the child is gone; `finish` reports why
      }
    },
    finish: (log, onCompiled, facts = { clientReferences: [] }) =>
      warmWithRestarts(first, spawn, mode, log, facts, onCompiled).finally(kill),
    kill,
  }
}

/** Forward diagnostics without giving the warm child the caller's stderr descriptor. */
async function forwardWarmStderr(child: WarmProcess) {
  try {
    const reader = child.stderr.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      process.stderr.write(value)
    }
  } catch {
    // The build shutting the child down also closes this pipe.
  }
}

function spawnWarmProcess(config: ResolvedConfig, mode: WarmMode): WarmProcess | undefined {
  const entry = fileURLToPath(new URL(import.meta.url))
  const argv = mode === 'full' ? [config.root, FULL_MODE_FLAG] : [config.root]
  try {
    return Bun.spawn([namedBunBinary('pnext-warm'), '--conditions=react-server', entry, ...argv], {
      cwd: config.root,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    })
  } catch {
    return undefined // no child (fork limit, unsupported platform)
  }
}

async function warmWithRestarts(
  first: WarmProcess | undefined,
  spawn: () => WarmProcess | undefined,
  mode: WarmMode,
  log: VerboseLogger,
  facts: Pick<WarmRequest, 'globalCss' | 'clientReferences'>,
  onCompiled?: (modules: string[]) => void,
) {
  // Release module key (or a handler's source file) -> compiled artifact. Handlers map to nothing
  // but still count as finished, so a restart does not import them a second time.
  const finished = new Map<string, string | undefined>()
  const compiled = () => [...finished.values()].filter((file): file is string => Boolean(file))
  // The marker can only mean "compiled set final" the first time it fires —
  // whichever attempt reaches its own handler phase first.
  let fired = false
  const fireOnCompiled = onCompiled
    ? () => {
        if (fired) return
        fired = true
        onCompiled(compiled())
      }
    : undefined
  let child = first
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && child; attempt++) {
    const before = finished.size
    const failure = await runAttempt(
      child,
      {
        skip: [...finished.keys()],
        compiled: Object.fromEntries(
          [...finished].filter((entry): entry is [string, string] => Boolean(entry[1])),
        ),
        ...facts,
      },
      finished,
      fireOnCompiled,
    )
    if (!failure) {
      log.log(`warmed ${compiled().length} modules`)
      return compiled()
    }
    // A restart only helps if the last one got somewhere; otherwise the first
    // thing it would redo is what killed it.
    child = finished.size > before && attempt < MAX_ATTEMPTS ? spawn() : undefined
    if (child) log.log(`warm-up ${failure} after ${finished.size} files; restarting past them`)
    else warmIncomplete(failure, finished.size, mode)
  }
  fireOnCompiled?.()
  return compiled()
}

/** Runs one attempt to completion. Returns undefined on success, else why it died. */
async function runAttempt(
  child: WarmProcess,
  request: WarmRequest,
  finished: Map<string, string | undefined>,
  onCompiled?: () => void,
) {
  try {
    // Writing the request and closing stdin is the go-ahead; until then the
    // child sits parked after its boot (or busy on a prewarm batch).
    void child.stdin.write(`${JSON.stringify(request)}\n`)
    void child.stdin.end()
  } catch {
    // broken pipe: the child is already gone, and its exit below says why
  }
  const timeout = setTimeout(() => child.kill('SIGKILL'), ATTEMPT_TIMEOUT_MS)
  timeout.unref?.()

  // Streamed rather than buffered to completion: the compiled-phase marker
  // has to reach the caller while this attempt is still running (the child's
  // handler phase), not after the process exits.
  const processLine = (line: string) => {
    if (!line) return
    if (line === COMPILED_MARKER) {
      onCompiled?.()
      return
    }
    if (!line.startsWith(DONE_MARKER)) {
      console.log(line) // app output
      return
    }
    const [source, artifact] = line.slice(DONE_MARKER.length).split('\t')
    if (source) finished.set(source, artifact || undefined)
  }
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      processLine(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
    }
  }
  if (buffer) processLine(buffer)

  const code = await child.exited.finally(() => clearTimeout(timeout))
  if (code === 0) return undefined
  return child.signalCode ? `was killed by ${child.signalCode}` : `exited with code ${code}`
}

function warmIncomplete(failure: string, done: number, mode: WarmMode) {
  console.warn(
    `pnext build: module warm-up ${failure} after warming ${done} file(s). ` +
      (mode === 'full'
        ? 'The function ships without the rest of its module cache and may fail to render those ' +
          "routes at request time, where Vercel's filesystem is read-only."
        : 'The production server compiles the rest on the first request that needs them.'),
  )
}

const report = (file: string, artifact?: string) => {
  console.log(`${DONE_MARKER}${file}${artifact ? `\t${artifact}` : ''}`)
}

/** Every server module a page route pulls in: the page, its layouts, its conventions. */
function pageServerFiles(config: ResolvedConfig, routeFiles: Iterable<string>) {
  const files = new Set<string>()
  const globalNotFound = path.join(config.appPath, 'not-found.tsx')
  if (existsSync(globalNotFound)) files.add(globalNotFound)
  for (const routeFile of routeFiles) {
    for (const file of [
      routeFile,
      ...findLayouts(config.appPath, routeFile),
      ...['loading.tsx', 'error.tsx', 'not-found.tsx'].flatMap(name =>
        findConventionFiles(config.appPath, routeFile, name),
      ),
    ]) {
      if (existsSync(file)) files.add(file)
    }
  }
  return files
}

interface ReleaseEntry {
  layer: ReleaseLayer
  target: ServerBundleTarget
  file: string
}

/** Compile one release module, reporting it under its release key. */
async function compileEntry(
  config: ResolvedConfig,
  entry: ReleaseEntry,
  compiled: Map<string, string>,
) {
  const href =
    entry.layer === 'client'
      ? await devClientModuleHref(config, entry.file, 'build', entry.target)
      : await devServerModuleHref(config, entry.file, 'build', { conditionTarget: entry.target })
  const key = releaseModuleKey(entry.layer, entry.target, entry.file)
  compiled.set(key, fileURLToPath(href))
  report(key, fileURLToPath(href))
}

/**
 * Every module a production server can import, by layer and target: each convention file of the app
 * tree, each handler, and each client reference the render marks or SSRs.
 */
function releaseEntries(
  config: ResolvedConfig,
  routes: BuildManifest['routes'],
  conventionFiles: string[],
  clientReferences: Iterable<string>,
) {
  const compat = getCompatModeExtensions().reactEnabled(config)
  const entries = new Map<string, ReleaseEntry>()
  const add = (layer: ReleaseLayer, target: ServerBundleTarget, file: string) =>
    entries.set(releaseModuleKey(layer, target, file), { layer, target, file })
  const addConvention = (target: ServerBundleTarget, file: string) => {
    add('server', target, file)
    if (compat && hasUseClientDirective(readSourceSync(file))) add('client', target, file)
  }
  const pageFiles = conventionFiles.filter(file => !path.basename(file).startsWith('route.'))
  for (const file of pageFiles) addConvention('server', file)
  const targets = new Set<ServerBundleTarget>(['server'])
  for (const route of routes) {
    const target = serverBundleTargetForRuntime(route.segmentConfig?.runtime)
    targets.add(target)
    if (route.kind === 'handler') {
      add('server', target, route.file)
      continue
    }
    if (target !== 'server') {
      const dirs = [path.dirname(route.file), ...(route.slotDirs ?? [])]
      for (const file of pageFiles) {
        const dir = path.dirname(file)
        if (dirs.some(owner => isInsideDir(dir, owner) || isInsideDir(owner, dir))) {
          addConvention(target, file)
        }
      }
    }
    if (compat && route.client && existsSync(route.file)) add('client', target, route.file)
    // Inline actions recover cold by importing their owning module by source key, helpers included.
    if (compat) {
      for (const file of route.sourceFiles) {
        if (/\.[cm]?[jt]sx?$/.test(file) && readSourceSync(file).includes('use server')) {
          add('server', 'server', file)
          add('server', target, file)
        }
      }
    }
    for (const reference of route.clientReferences) {
      if (ssrClientReference(reference)) add(compat ? 'client' : 'server', target, reference.file)
    }
  }
  if (compat) {
    for (const file of clientReferences) for (const target of targets) add('client', target, file)
  }
  return [...entries.values()]
}

function isInsideDir(dir: string, file: string) {
  return file === dir || file.startsWith(`${dir}${path.sep}`)
}

/**
 * Compile the page routes' server modules from the build's route scan, long before the manifest
 * exists. Artifacts are content-keyed on disk, so whatever lands here is a straight cache hit for the
 * pass below - the point is to spend this CPU under the build's client stage. Nothing here runs app
 * code, so it is safe to overlap (see the handler note below).
 */
export async function prewarmPageModules(
  config: ResolvedConfig,
  routeFiles: string[],
  compiled = new Map<string, string>(),
) {
  const { files } = captureConventions(config.root, config.appPath)
  const entries = [
    ...new Set([...files.filter(file => !path.basename(file).startsWith('route.')), ...routeFiles]),
  ].filter(file => existsSync(file))
  const compile = (layer: ReleaseLayer, file: string) =>
    compileEntry(config, { layer, target: 'server', file }, compiled).catch(() => undefined)
  await Promise.all(entries.map(file => compile('server', file)))
  // The client components those entries reach are core's client references: publish them now, under
  // the build, rather than after the manifest. Compat's client layer stays after the build's own
  // prerender, whose vendor plan it must share.
  if (getCompatModeExtensions().reactEnabled(config)) return
  const graph = devModuleGraph(config)
  const sources = await graph.graphSources(entries).catch(() => [])
  await Promise.all(
    sources.map(async ([file]) => {
      if (/\.[cm]?[jt]sx?$/.test(file) && (await graph.isClientSource(file))) {
        await compile('server', file)
      }
    }),
  )
}

/**
 * The warm pass itself, in the child. Compiles every release module, reporting each as it lands so a
 * parent restart can step over one that takes the process down, then publishes the build index.
 */
export async function warmRouteModules(
  config: ResolvedConfig,
  manifest: BuildManifest,
  request: Pick<WarmRequest, 'skip' | 'compiled' | 'globalCss' | 'clientReferences'>,
  mode: WarmMode = 'full',
  compiled = new Map<string, string>(),
) {
  const skip = new Set(request.skip)
  for (const [key, artifact] of Object.entries(request.compiled)) compiled.set(key, artifact)
  const clientFiles = new Set<string>()
  const handlers: BuildManifest['routes'] = []
  const pages: BuildManifest['routes'] = []

  for (const route of manifest.routes) {
    if (route.kind === 'handler') {
      if (!skip.has(route.file)) handlers.push(route)
      continue
    }
    pages.push(route)
    for (const reference of route.clientReferences) {
      if (ssrClientReference(reference) && existsSync(reference.file)) {
        clientFiles.add(reference.file)
      }
    }
  }

  const { conventions, files } = captureConventions(config.root, config.appPath)
  const serverDir = path.join(config.outPath, 'server')
  await mkdir(serverDir, { recursive: true })
  // Compat's release facts (compiled config, handlers, instrumentation) build beside the module compile.
  const compat = config.compat?.next
    ? import('../../compat/release').then(release => release.compatReleaseFacts(config, serverDir))
    : Promise.resolve(undefined)
  compat.catch(() => undefined)
  const compileAll = (entries: ReleaseEntry[]) =>
    Promise.all(
      entries
        .filter(entry => !compiled.has(releaseModuleKey(entry.layer, entry.target, entry.file)))
        .map(entry => compileEntry(config, entry, compiled)),
    )
  await compileAll(releaseEntries(config, manifest.routes, files, request.clientReferences))
  // Client references only a server compile discovers (a 'use client' module inside a package).
  await compileAll(releaseEntries(config, manifest.routes, files, compiledClientReferenceFiles()))
  const compatFacts = await compat
  await compileAll(
    Object.entries(compatFacts?.compat?.pagesApi ?? {}).map(([file, runtime]) => ({
      layer: 'server',
      target: pagesApiBundleTargetForRuntime(runtime),
      file: path.resolve(config.root, file),
    })),
  )
  const fonts = await releaseFonts(config, manifest.routes, compiled)
  // One graph per App Router layer for the server dependencies the release imports.
  const layerSources = new Map<string, string>()
  const rsc = await linkReleaseLayer(config, 'server:server', [...compiled.values()], layerSources)
  // The server graph can reach a package's 'use client' file no compile saw.
  await compileAll(releaseEntries(config, manifest.routes, files, compiledClientReferenceFiles()))
  const ssr = await linkReleaseLayer(config, 'client:client', [...compiled.values()], layerSources)
  for (const [key, artifact] of compiled) {
    const layer = key.startsWith('server:server:')
      ? rsc
      : key.startsWith('client:server:')
        ? ssr
        : undefined
    const moved = layer?.moved.get(artifact)
    if (moved) compiled.set(key, moved)
  }
  if (rsc || ssr) await pruneReleaseVendor(config, layerSources)
  await rm(releaseDependencyLog(config), { force: true })
  await writeRelease(
    config,
    compiled,
    conventions,
    files,
    compatFacts ?? {},
    fonts,
    [...(rsc?.files ?? []), ...(ssr?.files ?? [])],
    request.globalCss,
  )
  console.log(COMPILED_MARKER)
  if (mode === 'compile') return
  // Everything below runs the app's own code to capture what only an import
  // writes (vendor bundles, next/font bytes). A normal build serves from a
  // writable disk and creates those on demand; only a read-only deployment
  // target needs them now.

  // Handlers come last, and only once nothing else is in flight. Importing them runs the app's own
  // server code (auth, db pools, telemetry), and that code running *concurrently* with the compile
  // pass is what takes the runtime down - the same pass with handlers skipped never crashes, and
  // handlers alone against a populated cache never crash. Doing them after the compiles also means a
  // crash here costs only the remaining handlers, not the whole module pass.
  for (const route of handlers) {
    registerServerRuntime(config, route.sourceFiles)
    // Reported before the import, not after: handlers are imported one at a
    // time, so a handler that takes the process down is unambiguous and a
    // restart must not run it again (Bun caches a failed import for the
    // process' lifetime anyway, so a retry could not succeed either).
    report(route.file)
    try {
      await import(await handlerModuleHref(config, route))
    } catch (error) {
      console.warn(`vercel adapter: importing ${route.file} failed during warmup:`, error)
    }
  }

  // Pages last, one at a time: a module's vendor bundles are written when it is IMPORTED, not when
  // it compiles, and a bundle this pass misses is one the read-only function cannot create later.
  await importPageModules(config, pages, skip)

  // Client modules for the same reason, plus the references only the compile saw - a 'use client'
  // module inside a dependency is reached from a server component, so no route owns it. Vendoring
  // one late is worse than failing: it is a second copy, whose React context the render never holds.
  await importClientModules(
    config,
    new Set([...clientFiles, ...compiledClientReferenceFiles()]),
    skip,
  )

  // Fonts resolve during a render, so a fully dynamic app emits none at build. The imports above ran
  // the module-scope loader calls that declare them; flush to disk while it is still writable.
  try {
    await getFontExtensions().prewarmFontAssets(config, {})
  } catch (error) {
    console.warn('vercel adapter: emitting next/font assets failed during warmup:', error)
  }
}

/** Import each SSR-eligible client module through its compiled href, the way the render does. */
async function importClientModules(
  config: ResolvedConfig,
  clientFiles: ReadonlySet<string>,
  skip: ReadonlySet<string>,
) {
  if (!getCompatModeExtensions().reactEnabled(config)) return
  for (const file of clientFiles) {
    if (skip.has(file)) continue
    const href = await devClientModuleHref(config, file, 'build')
    report(file, fileURLToPath(href))
    try {
      await import(href)
    } catch (error) {
      console.warn(`vercel adapter: importing ${file} failed during warmup:`, error)
    }
  }
}

/**
 * Where the serve pipeline imports a route handler's module from — mirrors `moduleHrefForRoute` in
 * cli/serve/pipeline.ts, guard included. Warming through the raw source instead leaves the compiled
 * artifact unwritten, and the function then tries to compile it on the first request, against a
 * read-only filesystem.
 */
function handlerModuleHref(config: ResolvedConfig, route: BuildManifest['routes'][number]) {
  return config.compat?.next || config.compat?.react || config.compat?.reactCompiler
    ? devServerModuleHref(config, route.file, 'build', {
        conditionTarget: serverBundleTargetForRuntime(route.segmentConfig?.runtime),
      })
    : Promise.resolve(pathToFileHref(route.file))
}

/**
 * Import every server module the page routes reach, deduped across routes so a shared layout is
 * evaluated once. Reported with its artifact before the import, exactly like the handler loop: one
 * that takes the process down is unambiguous and must not run again on the restart.
 */
async function importPageModules(
  config: ResolvedConfig,
  pages: BuildManifest['routes'],
  skip: ReadonlySet<string>,
) {
  if (!getCompatModeExtensions().reactEnabled(config)) return
  const imported = new Set<string>()
  for (const route of pages) {
    registerServerRuntime(config, route.sourceFiles)
    for (const file of pageServerFiles(config, [route.file])) {
      if (skip.has(file) || imported.has(file)) continue
      imported.add(file)
      const href = await devServerModuleHref(config, file, 'build')
      report(file, fileURLToPath(href))
      try {
        await import(href)
      } catch (error) {
        console.warn(`vercel adapter: importing ${file} failed during warmup:`, error)
      }
    }
  }
}

/**
 * Resolve the app's next/font declarations for the release. A declaration only exists once its module
 * evaluates, so the modules that call a font loader are imported here, as `next build` does.
 */
async function releaseFonts(
  config: ResolvedConfig,
  routes: BuildManifest['routes'],
  compiled: Map<string, string>,
) {
  if (!config.compat?.next) return undefined
  const files = new Set(
    routes
      .flatMap(route => route.sourceFiles)
      .filter(file => /\.(?:[cm]?[jt]sx?|mdx?)$/.test(file))
      .filter(file => readSourceSync(file).includes('next/font/')),
  )
  if (files.size === 0) return undefined
  for (const file of files) {
    const entry = { layer: 'server', target: 'server', file } as const
    await compileEntry(config, entry, compiled)
    try {
      await import(pathToFileHref(compiled.get(releaseModuleKey('server', 'server', file))!))
    } catch (error) {
      console.warn(`pnext build: importing ${file} for its fonts failed:`, error)
    }
  }
  const fonts = await getFontExtensions().releaseFonts(config)
  return Object.fromEntries(
    Object.entries(fonts).map(([key, font]) => [
      key,
      { ...font, files: font.files.map(file => path.relative(config.outPath, file)) },
    ]),
  )
}

/** Publish the build index: every compiled module plus the source facts production reads instead of source. */
async function writeRelease(
  config: ResolvedConfig,
  compiled: ReadonlyMap<string, string>,
  conventions: Record<string, string[]>,
  conventionFiles: string[],
  compat: CompatRelease,
  fonts: Record<string, ReleasedFont> | undefined,
  dependencies: string[],
  globalCss = globalCssSources(config),
) {
  const toPosix = (file: string) => file.split(path.sep).join('/')
  const fromRoot = (file: string) => toPosix(path.relative(config.root, file))
  const modules: Record<string, string> = {}
  // Sorted: compiles land in completion order, and an unchanged build must publish identical bytes.
  for (const [key, artifact] of [...compiled].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const match = /^((?:server|client):[^:]+:)(.*)$/s.exec(key)
    if (!match) continue
    modules[`${match[1]}${releaseSourceKey(match[2]!, config.root, config.workspaceRoot)}`] =
      toPosix(path.relative(config.outPath, artifact))
  }
  const source = (file: string) => readSourceSync(file)
  const proxy = releasedProxy(config)
  await writeBuildIndex(config, {
    version: BUILD_INDEX_VERSION,
    framework: frameworkFingerprint(),
    config: serializeReleaseConfig(config),
    ...compat,
    modules,
    conventions,
    clientConventions: conventionFiles
      .filter(file => hasUseClientDirective(source(file)))
      .map(fromRoot),
    documentLayouts: conventionFiles
      .filter(
        file =>
          path.basename(file).startsWith('layout.') &&
          moduleExportNames(source(file), file).includes('default'),
      )
      .map(fromRoot),
    globalCss: globalCss.map(fromRoot),
    ...(proxy ? { proxy: { ...proxy, file: fromRoot(proxy.file) } } : {}),
    ...(fonts ? { fonts } : {}),
    ...(dependencies.length > 0
      ? { dependencies: dependencies.map(file => toPosix(path.relative(config.outPath, file))) }
      : {}),
  })
  // A build that moved outDir leaves no default-dir release behind for `pnext start` to serve.
  const defaultRelease = path.join(config.root, DEFAULT_OUT_DIR, standaloneOutSegment)
  if (path.resolve(config.outPath) !== defaultRelease) {
    await rm(buildIndexFile(defaultRelease), { force: true })
  }
}

/**
 * Read the parent's line-delimited requests until the `skip` message, running
 * each prewarm batch as it arrives. Returns the final request.
 */
async function readWarmRequests(
  config: ResolvedConfig,
  prewarmed: Map<string, string>,
): Promise<Partial<WarmRequest>> {
  let buffer = ''
  const decoder = new TextDecoder()
  const reader = Bun.stdin.stream().getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      const message = JSON.parse(line) as Partial<WarmRequest & PrewarmRequest>
      if (message.skip) return message
      if (message.prewarm) await prewarmPageModules(config, message.prewarm, prewarmed)
    }
  }
  const rest = buffer.trim()
  return rest ? (JSON.parse(rest) as Partial<WarmRequest>) : {}
}

if (import.meta.main) {
  const root = process.argv[2]
  const mode: WarmMode = process.argv.includes(FULL_MODE_FLAG) ? 'full' : 'compile'
  // This helper's stderr is forwarded to the user-facing build. The parent
  // already validated and printed next.config warnings, so avoid duplicates.
  const config = await loadConfig(root, { warnings: false })
  await bootstrapCompat(config)
  // Only the vercel adapter reads the specifier manifests back (its trace step);
  // a plain build would write them for nothing.
  setEmitCompiledSpecifiersManifest(mode === 'full')
  setReleaseCompile(true)
  // Idle until the route scan arrives: read the framework generation every compile keys on now.
  frameworkFingerprint()
  // One read per source for the child's life: its release facts re-read what the compile read.
  beginSourceScope()
  // Blocks until the parent sends the go-ahead, i.e. until the manifest is
  // written; a prewarm batch may arrive and run before that.
  const prewarmed = new Map<string, string>()
  const request = await readWarmRequests(config, prewarmed)
  // A build that fails closes stdin without a go-ahead and never writes the manifest. There is
  // nothing to warm and nothing to report: exiting quietly keeps the failed build's own error the
  // only thing on stderr.
  const manifestFile = buildManifestFile(config.outPath)
  if (!request.skip || !existsSync(manifestFile)) process.exit(0)
  const manifest = resolveManifest(
    JSON.parse(await readFile(manifestFile, 'utf8')) as BuildManifest,
    config.outPath,
    config.root,
  )
  await warmRouteModules(
    config,
    manifest,
    { skip: [], compiled: {}, clientReferences: [], ...request },
    mode,
    prewarmed,
  )
  // App code reached through a route handler can leave the loop alive (a db
  // pool, a stray interval); the warm pass is done either way.
  process.exit(0)
}
