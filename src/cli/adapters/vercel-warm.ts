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
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, pathToFileHref, type ResolvedConfig } from '../../config'
import { bootstrapCompat } from '../../compat-bootstrap'
import { compiledClientReferenceFiles, ssrClientReference } from '../../client/reference'
import {
  devClientModuleHref,
  devServerModuleHref,
  setEmitCompiledSpecifiersManifest,
} from '../../runtime/modules'
import { getCompatModeExtensions } from '../../extensions'
import { getFontExtensions } from '../../render/hooks'
import { findConventionFiles, findLayouts } from '../../routing/routes'
import {
  prewarmServerTransforms,
  registerServerRuntime,
  serverBundleTargetForRuntime,
} from '../../runtime/loader'
import { cacheRoot } from '../../runtime/module-cache'
import { listFiles } from '../../utils/fs'
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
  finish(log: VerboseLogger, onCompiled?: (modules: string[]) => void): Promise<string[]>
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
    finish: (log, onCompiled) =>
      warmWithRestarts(first, spawn, mode, log, onCompiled).finally(kill),
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
  onCompiled?: (modules: string[]) => void,
) {
  // Source file -> compiled artifact. Handlers map to nothing but still count as
  // finished, so a restart does not import them a second time.
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
      { skip: [...finished.keys()] },
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

const compileServer = (config: ResolvedConfig, file: string) =>
  devServerModuleHref(config, file, 'build').then(href => report(file, fileURLToPath(href)))

/**
 * Compile the page routes' server modules from the build's route scan, long before the manifest
 * exists. Artifacts are content-keyed on disk, so whatever lands here is a straight cache hit for the
 * pass below - the point is to spend this CPU under the build's client stage. Nothing here runs app
 * code, so it is safe to overlap (see the handler note below).
 */
export async function prewarmPageModules(config: ResolvedConfig, routeFiles: string[]) {
  if (!getCompatModeExtensions().reactEnabled(config)) return
  await Promise.all(
    [...pageServerFiles(config, routeFiles)].map(file =>
      compileServer(config, file).catch(() => undefined),
    ),
  )
}

/**
 * The warm pass itself, in the child. Reports every file it finishes as it
 * lands, so a parent restart can step over one that takes the process down.
 */
export async function warmRouteModules(
  config: ResolvedConfig,
  manifest: BuildManifest,
  skip: ReadonlySet<string> = new Set(),
  mode: WarmMode = 'full',
) {
  const clientFiles = new Set<string>()
  const handlers: BuildManifest['routes'] = []
  const pages: BuildManifest['routes'] = []
  const pageRoutes: string[] = []

  for (const route of manifest.routes) {
    if (route.kind === 'handler') {
      if (!skip.has(route.file)) handlers.push(route)
      continue
    }
    pages.push(route)
    pageRoutes.push(route.file)
    for (const reference of route.clientReferences) {
      if (ssrClientReference(reference) && existsSync(reference.file)) {
        clientFiles.add(reference.file)
      }
    }
  }

  // Without react compat the runtime imports page sources directly (Bun
  // transforms in memory); the compiled build cache is only used with compat.
  if (getCompatModeExtensions().reactEnabled(config)) {
    await Promise.all([
      ...[...pageServerFiles(config, pageRoutes)]
        .filter(file => !skip.has(file))
        .map(file => compileServer(config, file)),
      ...[...clientFiles]
        .filter(file => !skip.has(file))
        .map(file =>
          devClientModuleHref(config, file, 'build').then(href =>
            report(file, fileURLToPath(href)),
          ),
        ),
      // Handler artifacts are otherwise only written by the import below, which
      // `compile` mode does not run: compiling them here is what keeps a handler
      // route's first served request off the compile pipeline too.
      ...(mode === 'compile'
        ? handlers.map(async route => {
            registerServerRuntime(config, route.sourceFiles)
            report(route.file, fileURLToPath(await handlerModuleHref(config, route)))
          })
        : []),
    ])
  }
  console.log(COMPILED_MARKER)
  if (mode === 'compile') {
    // Transform is the tail of the compile pipeline: an artifact is transformed when it is first
    // imported, so a server that skipped every compile would still start esbuild for this alone.
    // The import pass below covers it in `full` mode; here it runs standalone, without app code.
    for (const route of [...pages, ...handlers]) registerServerRuntime(config, route.sourceFiles)
    const modules = cacheRoot(config.outPath)
    await prewarmServerTransforms(modules, await listFiles(modules))
    return
  }
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
 * Read the parent's line-delimited requests until the `skip` message, running
 * each prewarm batch as it arrives. Returns the final request.
 */
async function readWarmRequests(config: ResolvedConfig): Promise<Partial<WarmRequest>> {
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
      if (message.prewarm) await prewarmPageModules(config, message.prewarm)
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
  // Blocks until the parent sends the go-ahead, i.e. until the manifest is
  // written; a prewarm batch may arrive and run before that.
  const request = await readWarmRequests(config)
  // A build that fails closes stdin without a go-ahead and never writes the manifest. There is
  // nothing to warm and nothing to report: exiting quietly keeps the failed build's own error the
  // only thing on stderr.
  const manifestFile = path.join(config.outPath, 'manifest.json')
  if (!request.skip || !existsSync(manifestFile)) process.exit(0)
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as BuildManifest
  await warmRouteModules(config, manifest, new Set(request.skip ?? []), mode)
  // App code reached through a route handler can leave the loop alive (a db
  // pool, a stray interval); the warm pass is done either way.
  process.exit(0)
}
