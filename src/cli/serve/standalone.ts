/**
 * `<out>/standalone`: the one folder a production server needs. The release's compiled modules move
 * from the build cache into `server/`, every file they import lands in `node_modules/` (APFS clones,
 * never whole package trees), and `server/entry.js` serves it from wherever the folder is copied.
 * Like Next's `.next/standalone`, minus the hand copy of `public/` and `static/`: they are `static/`.
 */
import { createHash } from 'node:crypto'
import { constants, existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { frameworkRuntimeSpecifiers, type ResolvedConfig } from '../../config'
import { frameworkFingerprint } from '../../runtime/fingerprint'
import { cacheRoot, compiledSourceGraph, flushDevModuleCaches } from '../../runtime/module-cache'
import { PREBUNDLE_STAMP, prebundledFile, readPrebundleStamp } from '../../runtime/prebundle'
import {
  buildIndexFile,
  type BuildIndex,
  buildManifestFile,
  readBuildIndex,
  releaseSourceFile,
  standaloneOriginsFile,
} from '../../runtime/production'
import { toPosixPath } from '../../utils/fs'
import { splitResourceQuery } from '../../utils/resource-query'
import { importMetaRefs, moduleSpecifierEdges } from '../../resolve/scan-facts'
import { spliceSource } from '../../runtime/module-transform'
import type { BuildManifest } from '../../types'

const frameworkRoot = realpathSync(path.resolve(import.meta.dirname, '..', '..', '..'))
const frameworkPackage = JSON.parse(
  readFileSync(path.join(frameworkRoot, 'package.json'), 'utf8'),
) as { name: string; dependencies?: Record<string, string> }
// The framework loads only what it depends on; feature packages (its optional dependencies, the
// app's typescript) ship when the app's compiled code imports them.
const runtimeDependencies = new Set(Object.keys(frameworkPackage.dependencies ?? {}))
// Compiler-side modules a release never loads, by module (or prebundle chunk) name.
const buildOnlyModule = /^(?:build|modules|loader|compile|esbuild|dev|run|typegen|analyze|create)$/
const builtins = new Set(builtinModules)
const scriptFile = /\.(?:[cm]?[jt]sx?)$/

/** The framework module a release serves from: its prebundle when one matches this source. */
function frameworkStartEntry() {
  return readPrebundleStamp(frameworkRoot, frameworkFingerprint())
    ? path.join(frameworkRoot, 'dist', 'server', 'cli', 'start.js')
    : path.join(frameworkRoot, 'src', 'cli', 'start.ts')
}

/** A trace pass's state, passed from the worker that traces the framework (structured-clone safe). */
export interface TraceSnapshot {
  files: [string, string][]
  rewritten: [string, string][]
  seen: string[]
  claims: [string, string][]
  standalones: string[]
}

/** The config fields a trace reads; the worker receives only these. */
type TraceConfig = Pick<ResolvedConfig, 'outPath' | 'root' | 'workspaceRoot'>

interface Trace {
  /** Standalone-relative destination -> source file. */
  files: Map<string, string>
  /** Destinations added since the last flush; final once the file that added them is scanned. */
  fresh: string[]
  /** Standalone-relative destination -> rewritten contents. */
  rewritten: Map<string, string>
}

/**
 * Trace the framework's runtime closure now, on a worker thread: it needs no build output, so it runs
 * beside the build without taking its main thread, and `writeStandalone` only adds the app's modules.
 */
export function startStandalone(config: ResolvedConfig) {
  const input: TraceConfig = {
    outPath: config.outPath,
    root: config.root,
    workspaceRoot: config.workspaceRoot,
  }
  // The closure depends only on the framework and the packages it resolves: reuse it across builds.
  const modules = path.join(config.workspaceRoot, 'node_modules')
  const cacheFile =
    existsSync(modules) &&
    path.join(modules, '.cache', 'pnext', `standalone-${frameworkTraceKey()}.json`)
  if (cacheFile && existsSync(cacheFile)) {
    try {
      return Promise.resolve(JSON.parse(readFileSync(cacheFile, 'utf8')) as TraceSnapshot)
    } catch {
      // A torn or foreign cache file: trace again.
    }
  }
  const framework = new Promise<TraceSnapshot>((resolve, reject) => {
    const worker = new Worker(new URL('./standalone-worker.ts', import.meta.url))
    // Bun's worker: never keeps a failed build's process alive.
    ;(worker as Worker & { unref?: () => void }).unref?.()
    worker.onmessage = event => {
      resolve(event.data as TraceSnapshot)
      worker.terminate()
    }
    worker.onerror = event => {
      reject(new Error(event.message))
      worker.terminate()
    }
    worker.postMessage(input)
  })
    // A worker that cannot start or fails leaves the trace to the main thread.
    .catch(() => traceFramework(input))
  if (cacheFile)
    void framework
      .then(async snapshot => {
        await mkdir(path.dirname(cacheFile), { recursive: true })
        const temporary = `${cacheFile}.${process.pid}.tmp`
        await writeFile(temporary, JSON.stringify(snapshot))
        await rename(temporary, cacheFile)
      })
      .catch(() => undefined)
  return framework
}

/** The framework's source plus every runtime package it resolves, by real path and manifest mtime. */
function frameworkTraceKey() {
  const startEntry = frameworkStartEntry()
  const packages = [...runtimeDependencies, ...frameworkRuntimeSpecifiers()].map(specifier => {
    const file = resolveEdge(specifier, startEntry)
    return file ? `${file}\0${statSync(file).mtimeMs}` : specifier
  })
  return createHash('sha256')
    .update(JSON.stringify([frameworkFingerprint(), startEntry, packages]))
    .digest('hex')
    .slice(0, 16)
}

/** The framework's runtime closure, from its server entry and runtime specifiers. */
export async function traceFramework(config: TraceConfig) {
  const tracer = createTracer(config)
  const startEntry = frameworkStartEntry()
  await tracer.add([
    { file: startEntry, app: false },
    ...frameworkRuntimeSpecifiers().flatMap(specifier => {
      const file = resolveEdge(specifier, startEntry)
      return file ? [{ file, app: false }] : []
    }),
  ])
  return tracer.snapshot()
}

/** Assemble `config.outPath` (the standalone dir) once the build index is written. */
export async function writeStandalone(
  config: ResolvedConfig,
  framework: Promise<TraceSnapshot> = startStandalone(config),
) {
  const outPath = config.outPath
  const cache = cacheRoot(outPath)
  const index = readBuildIndex(outPath)
  const manifestFile = buildManifestFile(outPath)
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as BuildManifest
  const startEntry = frameworkStartEntry()
  const snapshot = await framework
  // Copies overlap the trace: the framework's files start now, the app's as each scan completes.
  const copier = createCopier(outPath)
  const rewrittenFramework = new Map(snapshot.rewritten)
  for (const [dest, source] of snapshot.files)
    copier.copy(dest, source, rewrittenFramework.get(dest))
  const tracer = createTracer(config, snapshot, dest =>
    copier.copy(dest, tracer.trace.files.get(dest)!, tracer.trace.rewritten.get(dest)),
  )
  const { trace, place } = tracer
  await tracer.add(
    [
      ...Object.values(index.modules),
      ...(index.dependencies ?? []),
      index.nextConfig,
      index.instrumentation?.file,
      index.instrumentation?.edge,
      ...Object.values(index.compat?.cacheHandlers ?? {}),
      ...Object.values(index.fonts ?? {}).flatMap(font => font.files),
      manifest.proxyModule,
      ...(manifest.actions ?? []).map(action => action.modulePath),
    ].flatMap(artifact => (artifact ? [{ file: path.resolve(outPath, artifact), app: true }] : [])),
  )

  addAppFiles(config, index, trace)
  tracer.flush()
  await copier.settle()
  // The release names its artifacts out-relative; the compiled ones now live in `server/`.
  const cachePrefix = `${toPosixPath(path.relative(outPath, cache))}/`
  const relocate = (value: unknown): unknown => {
    if (typeof value === 'string')
      return value.startsWith(cachePrefix) ? `server/${value.slice(cachePrefix.length)}` : value
    if (Array.isArray(value)) return value.map(relocate)
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocate(item)]))
    return value
  }
  const indexFile = buildIndexFile(outPath)
  await writeFile(
    indexFile,
    JSON.stringify(relocate(JSON.parse(await readFile(indexFile, 'utf8')))),
  )
  const shippedManifest = relocate(
    JSON.parse(await readFile(manifestFile, 'utf8')),
  ) as BuildManifest
  // Route source lists outside the app name build-machine paths the server never reads.
  for (const route of shippedManifest.routes) {
    if (route.sourceFiles)
      route.sourceFiles = route.sourceFiles.filter(file => !file.startsWith('../'))
  }
  await writeFile(manifestFile, `${JSON.stringify(shippedManifest, null, 2)}\n`)
  await writeFile(
    path.join(outPath, 'server', 'entry.js'),
    `export * from ${JSON.stringify(relativeSpecifier('server', place(startEntry)))}\n`,
  )
  await writeFile(path.join(outPath, 'package.json'), '{ "type": "module" }\n')
  // Build-machine only: lets a framework copy that is not the shipped one serve this release in place.
  const origins = Object.fromEntries(
    [...trace.files].filter(([dest]) => dest.startsWith('node_modules/')),
  )
  const originsFile = standaloneOriginsFile(outPath)
  await mkdir(path.dirname(originsFile), { recursive: true })
  await writeFile(originsFile, JSON.stringify({ release: outPath, origins }))
}

function setFile(trace: Trace, dest: string, source: string) {
  if (!trace.files.has(dest)) trace.fresh.push(dest)
  trace.files.set(dest, source)
}

/** The standalone trace: files to ship, rewritten sources, and package placement, filled in passes. */
function createTracer(config: TraceConfig, from?: TraceSnapshot, onReady?: (dest: string) => void) {
  const outPath = config.outPath
  const cache = cacheRoot(outPath)
  const trace: Trace = {
    files: new Map(from?.files),
    fresh: [],
    rewritten: new Map(from?.rewritten),
  }
  const claims = new Map(from?.claims)
  const place = createPlacer(outPath, cache, claims)
  const standalones = new Set(from?.standalones)
  // Framework and installed package files ship; app sources never do.
  const shipped = (file: string) =>
    installed(file) || (isInside(frameworkRoot, file) && !isInside(config.root, file))
  const seen = new Set(from?.seen)
  // Reads start as files are discovered, so I/O overlaps the scan instead of serializing it.
  const reads = new Map<string, Promise<string | undefined>>()
  const prefetch = (file: string) => {
    if (scriptFile.test(file) && !reads.has(file))
      reads.set(
        file,
        readFile(file, 'utf8').catch(() => undefined),
      )
  }
  const queue: { file: string; app: boolean }[] = []
  const enqueue = (file: string, app: boolean) => {
    if (seen.has(`${app}\0${file}`)) return
    queue.push({ file, app })
    prefetch(file)
  }
  // Files whose scan has finished are final: hand them to the copier while the trace goes on.
  const flush = () => {
    for (const dest of trace.fresh.splice(0)) onReady?.(dest)
  }
  const run = async (items: { file: string; app: boolean }[]) => {
    for (const item of items) enqueue(item.file, item.app)
    for (let item = queue.shift(); item; item = queue.shift(), flush()) {
      const { file, app } = item
      if (seen.has(`${app}\0${file}`)) continue
      seen.add(`${app}\0${file}`)
      // Another app's standalone (a dependency serving its own pnext build) ships whole, as built.
      const nested = enclosingStandalone(file, outPath)
      if (nested) {
        if (!standalones.has(nested)) {
          standalones.add(nested)
          addTree(
            nested,
            path.posix.dirname(path.posix.dirname(place(path.join(nested, 'server', 'entry.js')))),
            trace,
          )
        }
        continue
      }
      const dest = place(file)
      setFile(trace, dest, file)
      if (!isInside(outPath, file) && !isInside(cache, file)) addPackageFiles(file, trace, place)
      if (!scriptFile.test(file)) continue
      const release = isInside(outPath, file) || isInside(cache, file)
      const framework =
        !release && isInside(frameworkRoot, file) && !installedIn(frameworkRoot, file)
      prefetch(file)
      const source = await reads.get(file)
      if (source === undefined) continue
      const edits = new Map<string, string>()
      for (const edge of scanEdges(file, source)) {
        if (edge.url) {
          const target = urlTarget(edge.specifier, file)
          if (!target) continue
          const appFile =
            release && !isInside(outPath, target) && !isInside(cache, target) && !shipped(target)
          // An app source named by URL is its identity: it resolves to the app root, never read.
          if (appFile && scriptFile.test(target)) continue
          const stat = statSync(target, { throwIfNoEntry: false })
          // A package directory it reads by URL (migrations, data) ships whole.
          if (stat?.isDirectory() && !release && packageDataDir(target, file))
            for (const asset of dataFiles(target)) setFile(trace, place(asset), asset)
          if (!stat?.isFile()) continue
          // A file it reads by URL (a font, data) ships, under the app's own path.
          const at = appFile
            ? toPosixPath(
                path.join('server', 'assets', path.relative(config.workspaceRoot, target)),
              )
            : place(target)
          if (appFile) setFile(trace, at, target)
          else enqueue(target, release)
          if (release) {
            const relative = relativeSpecifier(path.dirname(dest), at)
            if (relative !== edge.specifier) edits.set(edge.specifier, relative)
          }
          continue
        }
        const bare = isPackageSpecifier(edge.specifier)
        const name = bare ? packageName(edge.specifier) : undefined
        if (bare && !name && !edge.specifier.startsWith('#')) continue
        // Its lazy requires are the compiler facades (esbuild, oxc), which only build and dev reach.
        if (name && framework && !app && (edge.require || !runtimeDependencies.has(name))) continue
        const target = resolveEdge(edge.specifier, file, edge.require)
        if (!target) continue
        if (edge.dynamic && framework && buildOnlyModule.test(moduleName(target))) continue
        // An app import reaches one framework module deep: the one it names may load a feature package.
        enqueue(target, release)
        for (const counterpart of frameworkCounterparts(target)) enqueue(counterpart, release)
        // A package placed off its natural `node_modules/<name>` (another version holds it) is named by path.
        if (release || (name && !place(target).startsWith(`node_modules/${name}/`))) {
          const relative = relativeSpecifier(path.dirname(dest), place(target))
          if (relative !== edge.specifier) edits.set(edge.specifier, relative)
        }
      }
      if (edits.size > 0) trace.rewritten.set(dest, rewriteSpecifiers(file, source, edits))
    }
    flush()
  }
  const snapshot = (): TraceSnapshot => ({
    files: [...trace.files],
    rewritten: [...trace.rewritten],
    seen: [...seen],
    claims: [...claims],
    standalones: [...standalones],
  })
  return { trace, place, add: run, snapshot, flush }
}

// Build debris and files nothing reads at request time, pruned at any depth of the app tree.
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
// The standalone dir's own entries, which an app file never overwrites.
const standaloneEntries = new Set(['server', 'static', 'node_modules', 'package.json'])

/**
 * App files ship only when `adapter.keep` names them (a file, a directory, or a `.suffix`), as Next
 * ships only traced files plus `outputFileTracingIncludes`; `.env*` files need their exact name.
 * `adapter.exclude` prunes traced package files.
 */
function addAppFiles(config: ResolvedConfig, index: BuildIndex, trace: Trace) {
  const { keep = [], exclude = [] } = config.adapter ?? {}
  const named = (entries: string[], name: string) =>
    entries.some(entry => name === entry || (entry.startsWith('.') && name.endsWith(entry)))
  for (const dest of trace.files.keys()) {
    const segments = dest.split('/')
    if (dest.startsWith('node_modules/') && segments.some(name => named(exclude, name)))
      trace.files.delete(dest)
  }
  if (keep.length === 0) return
  const compiled = compiledSources(config, index)
  const outTop = path.relative(config.root, config.outRootPath).split(path.sep)[0]
  const visit = (dir: string, kept: boolean) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        const pruned = prunedDirNames.includes(entry.name) && !named(keep, entry.name)
        if (pruned || (dir === config.root && entry.name === outTop)) continue
        visit(file, kept || named(keep, entry.name))
        continue
      }
      if (!entry.isFile() || (compiled.has(file) && !named(keep, entry.name))) continue
      const env = entry.name.startsWith('.env')
      if (env ? !keep.includes(entry.name) : !kept && !named(keep, entry.name)) continue
      const relative = toPosixPath(path.relative(config.root, file))
      if (!standaloneEntries.has(relative.split('/')[0]!)) setFile(trace, relative, file)
    }
  }
  visit(config.root, false)
}

/** App sources the release compiled: its modules' closure over the compile graph, plus the configs. */
function compiledSources(config: ResolvedConfig, index: BuildIndex) {
  flushDevModuleCaches()
  const graph = compiledSourceGraph(config.outPath, config.workspaceRoot)
  const queue = Object.keys(index.modules).map(key =>
    releaseSourceFile(
      key.slice(key.indexOf(':', key.indexOf(':') + 1) + 1),
      config.root,
      config.workspaceRoot,
    ),
  )
  if (index.proxy) queue.push(path.resolve(config.root, index.proxy.file))
  for (const name of readdirSync(config.root))
    if (
      /^(?:pnext|next|instrumentation)\.config\.|^instrumentation\./.test(name) &&
      scriptFile.test(name)
    )
      queue.push(path.join(config.root, name))
  const compiled = new Set<string>()
  for (const file of queue) {
    if (compiled.has(file)) continue
    compiled.add(file)
    queue.push(...(graph.get(file) ?? []))
  }
  // Global stylesheets compile into `static/` too.
  for (const css of index.globalCss) compiled.add(path.resolve(config.root, css))
  return compiled
}

/**
 * Where files live in the standalone dir, relative to it. Installed packages land flat at
 * `node_modules/<name>` as real files, so the folder survives `npm pack`; a second version of a
 * name nests under `node_modules/.pnext/` and its importers name it by path.
 */
function createPlacer(outPath: string, cache: string, claims = new Map<string, string>()) {
  const packageDir = (root: string, name: string) => {
    const owner = claims.get(name)
    if (owner === undefined) claims.set(name, root)
    if (owner === undefined || owner === root) return `node_modules/${name}`
    const key = createHash('sha256').update(root).digest('hex').slice(0, 12)
    return `node_modules/.pnext/${key}/node_modules/${name}`
  }
  return (file: string) => {
    if (isInside(cache, file)) return toPosixPath(path.join('server', path.relative(cache, file)))
    if (isInside(outPath, file)) return toPosixPath(path.relative(outPath, file))
    const framework =
      !installed(frameworkRoot) &&
      isInside(frameworkRoot, file) &&
      !installedIn(frameworkRoot, file)
    if (framework) {
      const dir = packageDir(frameworkRoot, frameworkPackage.name)
      return `${dir}/${toPosixPath(path.relative(frameworkRoot, file))}`
    }
    const owner = installedPackage(file)
    if (owner) return [packageDir(owner.root, owner.name), ...owner.rest].join('/')
    // Workspace source reached through a link: it ships under its package name.
    const root = packageRoot(path.dirname(file))
    const name = root && readPackageName(root)
    if (!root || !name)
      throw new Error(`pnext build: cannot place ${file} in the standalone output`)
    return `${packageDir(root, name)}/${toPosixPath(path.relative(root, file))}`
  }
}

/** The pnext standalone dir enclosing `file`, other than the one being written. */
const standaloneDirs = new Map<string, string | undefined>()
function enclosingStandalone(file: string, outPath: string): string | undefined {
  const dir = path.dirname(file)
  if (dir === path.dirname(dir)) return undefined
  if (standaloneDirs.has(dir)) return standaloneDirs.get(dir)
  const own =
    dir !== outPath &&
    existsSync(path.join(dir, 'server', 'build-index.json')) &&
    existsSync(path.join(dir, 'server', 'entry.js'))
  const found = own ? dir : enclosingStandalone(dir, outPath)
  standaloneDirs.set(dir, found)
  return found
}

/** Every file under `root`, symlinks dereferenced, at `dest/<relative>`. */
function addTree(root: string, dest: string, trace: Trace) {
  const visit = (dir: string, seen: Set<string>) => {
    const real = realpathSync(dir)
    if (seen.has(real)) return
    seen.add(real)
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name)
      const stat = statSync(file, { throwIfNoEntry: false })
      if (stat?.isDirectory()) visit(file, seen)
      else if (stat?.isFile())
        setFile(trace, `${dest}/${toPosixPath(path.relative(root, file))}`, realpathSync(file))
    }
  }
  visit(root, new Set())
}

/** The installed package holding `file`: its `node_modules/<name>` dir, name, and path inside. */
function installedPackage(file: string) {
  const posix = toPosixPath(file)
  const at = posix.lastIndexOf('/node_modules/')
  if (at === -1) return undefined
  const rest = posix.slice(at + '/node_modules/'.length).split('/')
  const length = rest[0]!.startsWith('@') ? 2 : 1
  const name = rest.slice(0, length).join('/')
  return { root: `${posix.slice(0, at)}/node_modules/${name}`, name, rest: rest.slice(length) }
}

function installed(file: string) {
  return toPosixPath(file).includes('/node_modules/')
}

/** Whether `file` lies in a package nested under `root`'s own node_modules. */
function installedIn(root: string, file: string) {
  return path.relative(root, file).split(path.sep).includes('node_modules')
}

interface Edge {
  specifier: string
  dynamic: boolean
  require?: boolean
  url?: boolean
}

const transpilers = new Map<string, Bun.Transpiler>()

function scanEdges(file: string, source: string): Edge[] {
  const ext = path.extname(file)
  const loader = ext === '.tsx' || ext === '.jsx' ? 'tsx' : /\.[cm]?ts$/.test(ext) ? 'ts' : 'js'
  let transpiler = transpilers.get(loader)
  if (!transpiler) {
    transpiler = new Bun.Transpiler({
      loader,
      tsconfig: { compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'preact' } },
    })
    transpilers.set(loader, transpiler)
  }
  let imports: ReturnType<Bun.Transpiler['scanImports']>
  try {
    imports = transpiler.scanImports(source)
  } catch {
    return []
  }
  const edges: Edge[] = imports.map(entry => ({
    specifier: entry.path,
    dynamic: entry.kind === 'dynamic-import',
    require: entry.kind === 'require-call',
  }))
  // A module names files beside itself by `new URL(…, import.meta.url)` and `import.meta.resolve`.
  const refs = importMetaRefs(file, source)
  for (const url of refs.urls) edges.push({ specifier: url.specifier, dynamic: false, url: true })
  for (const ref of refs.resolves) edges.push({ specifier: ref.specifier, dynamic: false })
  if (loader === 'tsx')
    edges.push(
      { specifier: 'preact/jsx-runtime', dynamic: false },
      { specifier: 'preact/jsx-dev-runtime', dynamic: false },
    )
  return edges
}

const resolved = new Map<string, string | undefined>()

function resolveEdge(specifier: string, from: string, require = false) {
  if (/^(?:node:|bun:|data:|https?:)/.test(specifier) || specifier === 'bun') return undefined
  // A CommonJS `#` is a filename character; an ESM `?query#hash` takes no part in the lookup.
  const bare = require ? specifier : splitResourceQuery(specifier).path
  if (builtins.has(bare)) return undefined
  const dir = path.dirname(from)
  const key = `${dir}\0${bare}`
  if (resolved.has(key)) return resolved.get(key)
  let target: string | undefined
  try {
    const request = bare.startsWith('file:') ? fileURLToPath(bare) : bare
    target = realpathSync(Bun.resolveSync(request, dir))
    if (!statSync(target).isFile()) target = undefined
  } catch {
    target = undefined
  }
  resolved.set(key, target)
  return target
}

/** The prebundled module a framework source file is served by, when it has one. */
function frameworkCounterparts(file: string) {
  const counterpart = prebundledFile(file)
  if (counterpart === file) return []
  return [counterpart, path.join(frameworkRoot, PREBUNDLE_STAMP)]
}

/** `_chunks/name-<hash>.js` chunk or `name.ts` module -> `name`. */
function moduleName(file: string) {
  const base = path.basename(file, path.extname(file))
  const chunk = path.basename(path.dirname(file)) === '_chunks'
  return chunk && isInside(path.join(frameworkRoot, 'dist'), file)
    ? base.replace(/-[a-z0-9]{8}$/, '')
    : base
}

function packageName(specifier: string) {
  if (specifier.startsWith('#')) return undefined
  const parts = specifier.split('/')
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  return name && !builtins.has(name) ? name : undefined
}

/** Every package.json between `file` and its package root: they steer resolution. */
function addPackageFiles(file: string, trace: Trace, place: (file: string) => string) {
  const inStore = installed(file)
  for (let dir = path.dirname(file); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const manifest = path.join(dir, 'package.json')
    const found = existsSync(manifest)
    if (found) setFile(trace, place(manifest), manifest)
    if (found && dir === frameworkRoot) {
      for (const name of ['tsconfig.json', path.join('config', 'ts', 'react.json')]) {
        const extra = path.join(dir, name)
        if (existsSync(extra)) setFile(trace, place(extra), extra)
      }
    }
    const parent = path.basename(path.dirname(dir))
    const packageTop =
      parent === 'node_modules' ||
      (parent.startsWith('@') && path.basename(path.dirname(path.dirname(dir))) === 'node_modules')
    if (inStore ? packageTop : found && readPackageName(dir)) return
  }
}

/** Whether `dir` is data of `from`'s package: inside it, not the module's own dir or above. */
function packageDataDir(dir: string, from: string) {
  const root = installedPackage(from)?.root ?? packageRoot(path.dirname(from))
  if (!root || !isInside(root, dir) || isInside(dir, path.dirname(from))) return false
  return !path.relative(root, dir).split(path.sep).includes('node_modules')
}

/** Every file under `dir`, nested packages aside. */
function dataFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : dataFiles(file)
    return entry.isFile() ? [file] : []
  })
}

function packageRoot(dir: string): string | undefined {
  for (; dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, 'package.json'))) return dir
  }
  return undefined
}

function readPackageName(dir: string) {
  try {
    return (JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string })
      .name
  } catch {
    return undefined
  }
}

function relativeSpecifier(fromDir: string, to: string) {
  const relative = toPosixPath(path.relative(fromDir, to))
  return relative.startsWith('.') ? relative : `./${relative}`
}

/** Swap specifier literals for their standalone locations, by parsed span: never inside a string. */
function rewriteSpecifiers(file: string, source: string, edits: Map<string, string>) {
  const refs = importMetaRefs(file, source)
  const spans = [...moduleSpecifierEdges(source, file), ...refs.urls, ...refs.resolves]
  const changes = spans.flatMap(span => {
    const value = edits.get(span.specifier)
    return value === undefined
      ? []
      : [{ start: span.start, end: span.end, value: JSON.stringify(value) }]
  })
  changes.sort((a, b) => a.start - b.start)
  return changes.length > 0 ? spliceSource(source, changes) : source
}

/** A `new URL(specifier, import.meta.url)` target: relative to the module, as the URL resolves. */
function urlTarget(specifier: string, from: string) {
  try {
    const url = new URL(specifier, pathToFileURL(from))
    return url.protocol === 'file:' ? path.resolve(fileURLToPath(url)) : undefined
  } catch {
    return undefined
  }
}

/** A bare package specifier, not a path (`.`, `..`, `./x`, `/x`, `file:`). */
function isPackageSpecifier(specifier: string) {
  if (specifier === '.' || specifier === '..') return false
  if (specifier.startsWith('./') || specifier.startsWith('../')) return false
  return !path.isAbsolute(specifier) && !specifier.startsWith('file:')
}

/** Copies into the standalone dir as files are handed over: clones, or rewritten contents. */
function createCopier(outPath: string) {
  const dirs = new Map<string, Promise<unknown>>()
  const copied = new Set<string>()
  const pending: Promise<unknown>[] = []
  const ensureDir = (dir: string) => {
    let made = dirs.get(dir)
    if (!made) {
      made = mkdir(dir, { recursive: true })
      dirs.set(dir, made)
    }
    return made
  }
  const copy = (dest: string, source: string, contents?: string) => {
    if (copied.has(dest)) return
    copied.add(dest)
    const target = path.join(outPath, dest)
    pending.push(
      ensureDir(path.dirname(target)).then(async () => {
        if (contents !== undefined) {
          if (target !== source) await rm(target, { force: true })
          return writeFile(target, contents)
        }
        if (target !== source) await copyFile(source, target, constants.COPYFILE_FICLONE)
      }),
    )
  }
  return { copy, settle: () => Promise.all(pending) }
}

function isInside(root: string, file: string) {
  return file === root || file.startsWith(`${root}${path.sep}`)
}
