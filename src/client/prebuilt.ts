import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, type Dirent } from 'node:fs'
import path from 'node:path'
import { build, type BuildOptions, type Metafile, type Plugin } from 'esbuild'
import type { ResolvedConfig } from '../config'
import { getImportAliasExtensions } from '../extensions'
import { scanFacts } from '../resolve/scan-facts'
import { ensureDir, writeText } from '../utils/fs'
import { escapeRegex } from '../utils/code'
import { CLIENT_RUNTIME_MODULE } from './entry'

/**
 * The route-independent half of every client bundle - pnext's own client runtime, the compat
 * surface and preact - built ONCE into a content-addressed artifact that route entries import
 * instead of re-bundling, so a route entry carries only user code.
 *
 * Two things keep it byte-neutral. The artifact is ONE module aggregating every demanded
 * (specifier, export name) pair under a mangled name, not one esbuild entry point per framework
 * module: entry points keep every export of every module live, and one file per specifier also pays
 * gzip's per-stream dictionary reset. And the aggregate is keyed on the DEMANDED export surface, so
 * esbuild shakes it to the same closure the route build would have.
 */
export interface PrebuiltRuntime {
  /** Content address of (framework source × alias set × build options). */
  key: string
  /** Directory holding the artifact. */
  dir: string
  /** URL prefix route entries import the artifact from — the SERVED url. */
  publicPath: string
  /**
   * The same directory as an `assets/…` path, for the preload bookkeeping that
   * speaks in app-relative asset names rather than urls.
   */
  assetPath: string
  /** specifier → every export name that module has (learned by a probe build). */
  exports: Map<string, string[]>
  /** specifier → the export names route entries actually bind. What ships. */
  surface: Map<string, Set<string>>
  /** Artifact files statically reachable from the aggregate, relative to it. */
  closure: { static: string[]; dynamic: string[] }
}

/** The aggregate's file name inside the artifact dir. */
export const PREBUILT_MODULE = 'pnext-runtime.js'

/** Framework source root — anything resolving inside it is route-independent. */
const frameworkSrc = path.resolve(import.meta.dirname, '..')

/**
 * The vendor half of the surface. Single-instance modules (context identity,
 * option hooks, error interception), so they must come from the artifact from
 * the very first route build, never bundled per route beside it.
 */
const vendorSpecifiers = [
  'preact',
  'preact/hooks',
  'preact/compat',
  'preact/compat/client',
  'preact/jsx-runtime',
  'preact/jsx-dev-runtime',
]

/**
 * The react-compat aliases seed the artifact alongside the vendors: their targets are `export *`
 * facades over preact/compat, so a route build that bundles one instead of prebuilding it demands
 * preact/compat's WHOLE surface. Everything else is discovered lazily - a leaf compat module
 * bundled once costs only what its importer named.
 */
const reactAliasSpecifier = /^react(?:-dom)?(?:\/|$)/

/**
 * The React Compiler's runtime is resolved per build (and asserted on in the
 * route bundle), so it stays out of the artifact.
 */
const isCompilerRuntime = (specifier: string) => specifier.endsWith('compiler-runtime')

const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** (specifier, export name) → one collision-free identifier in the aggregate. */
export function mangledName(specifier: string, name: string) {
  return `__p_${shortHash(specifier)}_${name}`
}

function shortHash(value: string) {
  return createHash('sha1').update(value).digest('hex').slice(0, 8)
}

function seedSpecifiers(aliases: string[]) {
  const react = aliases.filter(
    alias => reactAliasSpecifier.test(alias) && !isCompilerRuntime(alias),
  )
  return [...new Set([...vendorSpecifiers, ...react])]
}

/** Every framework specifier this app could demand: aliases + preact + pnext src. */
export function prebuiltSpecifierFilter(config: ResolvedConfig): RegExp {
  const aliases = Object.keys(getImportAliasExtensions().aliases(config, 'client'))
  const bare = [...new Set([...aliases, ...vendorSpecifiers])]
  return new RegExp(`^(?:${bare.map(escapeRegex).join('|')}|${escapeRegex(frameworkSrc)}/)`)
}

/**
 * Does this specifier name route-independent framework code? The generated runtime module is
 * deliberately NOT one: its source is a function of the ClientRuntimeFacts booleans, so prebuilding it
 * would put the facts in the artifact key and give dev one artifact per route shape. It is generated
 * glue whose weight - router, compat, preact - is external through it anyway.
 */
export function isFrameworkSpecifier(specifier: string, filter: RegExp) {
  if (specifier === CLIENT_RUNTIME_MODULE) return false
  if (isCompilerRuntime(specifier)) return false
  if (specifier.startsWith(frameworkSrc)) return true
  return filter.test(specifier) && !specifier.startsWith('.')
}

/**
 * Content address of the artifact. Not keyed on the *discovered* surface - a route build learns that
 * while it runs, so a surface-dependent url could only be known after the entries that must import it
 * were emitted. It IS keyed on the surface *signature*, which is known before any build: the compat
 * facts the generated entry emits its framework imports from plus the runtime record. Routes sharing
 * that signature share an artifact; routes that do not get their own.
 */
export function prebuiltRuntimeKey(
  config: ResolvedConfig,
  buildOptions: BuildOptions,
  signature = '',
) {
  const hash = createHash('sha1')
  hash.update(frameworkSourceHash())
  hash.update('\0')
  hash.update(JSON.stringify(Object.keys(getImportAliasExtensions().aliases(config, 'client'))))
  hash.update('\0')
  hash.update(
    JSON.stringify([
      buildOptions.define,
      buildOptions.minify,
      buildOptions.target,
      buildOptions.pure,
    ]),
  )
  hash.update('\0')
  hash.update(signature)
  return hash.digest('hex').slice(0, 16)
}

let cachedSourceHash: string | undefined

/**
 * Hash of pnext's own source. Cheap on the cold path: mtime+size per file, not contents - the tree is
 * pnext's own install, so a same-mtime file is the same file.
 */
function frameworkSourceHash() {
  if (cachedSourceHash) return cachedSourceHash
  const hash = createHash('sha1')
  const walk = (dir: string) => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (/\.(?:tsx?|jsx?|mjs|cjs)$/.test(entry.name)) {
        const stats = statSync(file, { throwIfNoEntry: false })
        if (stats) hash.update(`${file}:${stats.size}:${stats.mtimeMs}\n`)
      }
    }
  }
  walk(frameworkSrc)
  cachedSourceHash = hash.digest('hex').slice(0, 16)
  return cachedSourceHash
}

export interface ArtifactOptions {
  /** The client import aliases in force, part of the key and of the seed. */
  aliases: string[]
  dir: string
  publicPath: string
  assetPath: string
  key: string
  buildOptions: BuildOptions
  /** Fresh plugin chain per build — esbuild plugins carry per-build state. */
  plugins: () => Plugin[]
}

/**
 * Learn every export name of each specifier by building throwaway `export *`
 * shims for their metafile alone. This is what lets a route build offer a
 * framework module's whole surface and let esbuild pick the names it needs: an
 * `export *` cannot be enumerated from source text, because the compat modules
 * re-export through several levels of their own stars.
 */
async function probeExports(specifiers: string[], options: ArtifactOptions) {
  const found = new Map<string, string[]>()
  if (specifiers.length === 0) return found
  const probeDir = path.join(options.dir, '.probe')
  await ensureDir(probeDir)
  const entryPoints: { in: string; out: string }[] = []
  for (const specifier of specifiers) {
    const file = path.join(probeDir, `${shortHash(specifier)}.ts`)
    await writeText(file, `export * from ${JSON.stringify(specifier)};\n`)
    entryPoints.push({ in: file, out: shortHash(specifier) })
  }
  const result = await build({
    ...options.buildOptions,
    entryPoints,
    outdir: probeDir,
    entryNames: '[name]',
    splitting: true,
    write: false,
    metafile: true,
    plugins: options.plugins(),
  })
  for (const specifier of specifiers) {
    const output = Object.entries(result.metafile.outputs).find(
      ([name]) => path.basename(name) === `${shortHash(specifier)}.js`,
    )
    // `export *` never carries `default`; probeSurface asks for it separately.
    found.set(
      specifier,
      (output?.[1].exports ?? []).filter(name => identifier.test(name)),
    )
  }
  return found
}

/**
 * The export names of each specifier, VERIFIED against a real aggregate build. Two things need
 * checking: `export *` never carries `default`, so a default has to be asked for separately; and
 * esbuild ACCEPTS `export { default } from "x"` on a module that has none - CJS interop makes it
 * undecidable at parse time - then silently emits nothing, which would leave a route entry importing
 * a name the artifact never provides and kill the page on load. So the candidate surface is built
 * once, unwritten, and every name that did not materialize is dropped.
 */
async function probeSurface(specifiers: string[], options: ArtifactOptions) {
  const probed = await probeExports(specifiers, options)
  if (probed.size === 0) return probed
  const candidate = new Map(
    [...probed].map(([specifier, names]) => [specifier, new Set([...names, 'default'])]),
  )
  const { text } = await buildAggregate(options, candidate, false)
  return new Map(
    [...candidate].map(([specifier, names]) => [
      specifier,
      [...names].filter(name => text.includes(mangledName(specifier, name))),
    ]),
  )
}

/**
 * Build the aggregate module for a surface. `write` off keeps it in memory, for
 * the verification pass that must not clobber the artifact on disk.
 */
async function buildAggregate(
  options: ArtifactOptions,
  surface: Map<string, Set<string>>,
  write: boolean,
) {
  const lines: string[] = []
  for (const specifier of [...surface.keys()].sort()) {
    const names = [...surface.get(specifier)!].filter(name => identifier.test(name)).sort()
    const spec = JSON.stringify(specifier)
    if (names.length === 0) lines.push(`import ${spec};`)
    else {
      const clause = names.map(name => `${name} as ${mangledName(specifier, name)}`).join(', ')
      lines.push(`export { ${clause} } from ${spec};`)
    }
  }
  const aggregateDir = path.join(options.dir, '.aggregate')
  await ensureDir(aggregateDir)
  const entry = path.join(aggregateDir, 'runtime.ts')
  await writeText(entry, `${lines.join('\n')}\n`)

  const result = await build({
    ...options.buildOptions,
    entryPoints: [{ in: entry, out: PREBUILT_MODULE.replace(/\.js$/, '') }],
    outdir: options.dir,
    entryNames: '[name]',
    splitting: true,
    write,
    metafile: true,
    plugins: options.plugins(),
  })
  const emitted = result.outputFiles?.find(file => path.basename(file.path) === PREBUILT_MODULE)
  const text = emitted?.text ?? readFileSafe(path.join(options.dir, PREBUILT_MODULE))
  return { text, metafile: result.metafile }
}

function readFileSafe(file: string) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Build and record the artifact: one module re-exporting exactly the demanded
 * (specifier, name) pairs under mangled names, plus whatever chunks its own
 * dynamic imports split into.
 */
export async function buildPrebuiltRuntime(
  options: ArtifactOptions,
  exportsBySpecifier: Map<string, string[]>,
  surface: Map<string, Set<string>>,
): Promise<PrebuiltRuntime> {
  const { metafile } = await buildAggregate(options, surface, true)
  return {
    key: options.key,
    dir: options.dir,
    publicPath: options.publicPath,
    assetPath: options.assetPath,
    exports: exportsBySpecifier,
    surface,
    closure: aggregateClosure(metafile),
  }
}

function aggregateClosure(metafile: Metafile) {
  const entry = Object.keys(metafile.outputs).find(name => path.basename(name) === PREBUILT_MODULE)
  const statics = new Set<string>()
  const dynamics = new Set<string>()
  if (!entry) return { static: [], dynamic: [] }
  const seen = new Set([`${entry}:static`])
  const queue = [{ output: entry, dynamic: false }]
  // eslint-disable-next-line @typescript-eslint/prefer-for-of
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head]!
    for (const imported of metafile.outputs[current.output]?.imports ?? []) {
      if (imported.kind !== 'import-statement' && imported.kind !== 'dynamic-import') continue
      const dynamic = current.dynamic || imported.kind === 'dynamic-import'
      const visitKey = `${imported.path}:${dynamic ? 'dynamic' : 'static'}`
      if (seen.has(visitKey)) continue
      seen.add(visitKey)
      queue.push({ output: imported.path, dynamic })
      const relative = path.relative(path.dirname(entry), imported.path).split(path.sep).join('/')
      ;(dynamic ? dynamics : statics).add(relative)
    }
  }
  for (const name of statics) dynamics.delete(name)
  return { static: [...statics], dynamic: [...dynamics] }
}
/**
 * Route-build seam. A framework specifier resolves to a virtual module that re-exports the target's
 * whole surface from the artifact url under mangled names; esbuild shakes that down to the names the
 * importer actually uses, so the emitted entry names its own demand and `demandedFromOutputs` reads it
 * straight back off the output. A specifier the artifact has not probed yet is declined and recorded -
 * bundled correctly this once, prebuilt from the next build on.
 */
export function prebuiltExternalPlugin(
  runtime: PrebuiltRuntime,
  filter: RegExp,
  unprobed: Set<string>,
  sourceOf: (importer: string) => string | undefined,
): Plugin {
  const namespace = 'pnext-prebuilt'
  const moduleUrl = prebuiltModuleUrl(runtime)
  return {
    name: 'pnext-prebuilt-runtime',
    setup(build) {
      build.onResolve({ filter: new RegExp(`^${escapeRegex(moduleUrl)}$`) }, () => ({
        path: moduleUrl,
        external: true,
      }))
      build.onResolve({ filter }, args => {
        if (args.namespace === namespace) return undefined
        if (!isFrameworkSpecifier(args.path, filter)) return undefined
        if (!runtime.exports.has(args.path)) {
          unprobed.add(args.path)
          return undefined
        }
        // A dynamic import takes the module as a NAMESPACE - every export is live - so routing one
        // through the artifact would drag the whole surface into the initial tier that the dynamic
        // import exists to stay out of. Leave it deferred, unless the artifact already ships that
        // module, in which case serving it from there keeps the single instance.
        if (args.kind === 'dynamic-import' && !runtime.surface.has(args.path)) return undefined
        // The importer travels in the path because onLoad is not told it, and
        // the demanded names are a property of the IMPORTER, not the specifier:
        // esbuild cannot shake named imports out of an external module, so
        // whatever the virtual module offers is what ships.
        return { path: `${args.path}\0${args.importer}`, namespace }
      })
      build.onLoad({ filter: /.*/, namespace }, args => {
        const separator = args.path.lastIndexOf('\0')
        const specifier = args.path.slice(0, separator)
        const importer = args.path.slice(separator + 1)
        const available = runtime.exports.get(specifier) ?? []
        const demanded = demandedNames(importer, specifier, sourceOf(importer), available)
        const clause = demanded.map(name => `${mangledName(specifier, name)} as ${name}`).join(', ')
        const contents =
          clause.length > 0
            ? `export { ${clause} } from ${JSON.stringify(moduleUrl)};\n`
            : `import ${JSON.stringify(moduleUrl)};\n`
        return { contents, loader: 'js', resolveDir: path.dirname(specifier) }
      })
    },
  }
}
/**
 * The names one importer binds off one specifier. A namespace import, an `export * from`, or an import
 * no source text names (esbuild synthesizes the automatic JSX runtime one) demands the module's whole
 * surface.
 */
function demandedNames(
  importer: string,
  specifier: string,
  source: string | undefined,
  available: string[],
) {
  if (source === undefined) return available
  // The generated entries are virtual and their importer id carries no extension; scanFacts picks
  // the parser off the name, so an id like `index` would parse as plain JS, leaving the entry's
  // TypeScript unreadable - which reads as "demands everything".
  const sourceFile = /\.[cm]?[jt]sx?$/i.test(importer) ? importer : `${importer}.tsx`
  let edges
  try {
    edges = scanFacts(sourceFile, source).imports
  } catch {
    return available
  }
  const names = new Set<string>()
  let named = false
  for (const edge of edges) {
    if (edge.specifier !== specifier) continue
    named = true
    if (edge.star || edge.exports.includes('*')) return available
    for (const name of edge.exports) names.add(name)
  }
  if (!named) return available
  const offered = available.filter(name => names.has(name))
  // A name the target does not export is the build's error to report, not
  // something to silently drop — offer it and let esbuild say so.
  for (const name of names) if (!available.includes(name)) offered.push(name)
  return offered
}

export function prebuiltModuleUrl(runtime: Pick<PrebuiltRuntime, 'publicPath'>) {
  return `${runtime.publicPath}/${PREBUILT_MODULE}`
}
/**
 * Read the surface the build actually demanded back off its own output: every mangled name imported
 * from the artifact url. Exact by construction - it is the same list the browser will ask for.
 */
export function demandedFromOutputs(runtime: PrebuiltRuntime, outDir: string) {
  const moduleUrl = prebuiltModuleUrl(runtime)
  const byMangled = new Map<string, { specifier: string; name: string }>()
  for (const [specifier, names] of runtime.exports) {
    for (const name of names) byMangled.set(mangledName(specifier, name), { specifier, name })
  }
  const demanded = new Map<string, Set<string>>()
  const walk = (dir: string) => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name)
      // The artifact itself lives under the out dir in prod; it is where these
      // names come from, not a consumer of them.
      if (entry.isDirectory()) {
        if (file !== runtime.dir) walk(file)
        continue
      }
      if (!entry.name.endsWith('.js')) continue
      let source: string
      try {
        source = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      if (!source.includes(moduleUrl)) continue
      for (const edge of scanFacts(file, source).imports) {
        if (edge.specifier !== moduleUrl) continue
        for (const bound of edge.exports) {
          const origin = byMangled.get(bound)
          if (!origin) continue
          const names = demanded.get(origin.specifier) ?? new Set<string>()
          demanded.set(origin.specifier, names)
          names.add(origin.name)
        }
      }
    }
  }
  walk(outDir)
  return demanded
}

/** Is every demanded name already in the artifact on disk? */
export function surfaceCovered(runtime: PrebuiltRuntime, demanded: Map<string, Set<string>>) {
  for (const [specifier, names] of demanded) {
    const have = runtime.surface.get(specifier)
    if (!have) return false
    for (const name of names) if (!have.has(name)) return false
  }
  return true
}

const manifestName = 'pnext-runtime.json'

/**
 * One artifact address is shared by every route build in the process, and in
 * dev several routes compile at once. Serialize per address so two esbuild runs
 * never write the same directory concurrently.
 */
const artifactLocks = new Map<string, Promise<unknown>>()

function underLock<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const previous = artifactLocks.get(dir) ?? Promise.resolve()
  const next = previous.then(run, run)
  artifactLocks.set(
    dir,
    next.catch(() => undefined),
  )
  return next
}

/**
 * Open the artifact at this address, building a seed one if there is none. The
 * seed probes the vendor specifiers: those are the single-instance modules, so
 * they must be prebuilt from the very first route build. Everything else is
 * probed and folded in by the build that first demands it.
 */
export function ensurePrebuiltRuntime(options: ArtifactOptions) {
  return underLock(options.dir, () => openPrebuiltRuntime(options))
}

async function openPrebuiltRuntime(options: ArtifactOptions) {
  const manifest = readManifest(options.dir)
  if (manifest) {
    return {
      key: options.key,
      dir: options.dir,
      publicPath: options.publicPath,
      assetPath: options.assetPath,
      ...manifest,
    } satisfies PrebuiltRuntime
  }
  const exportsBySpecifier = await probeSurface(seedSpecifiers(options.aliases), options)
  // Seed surface: nothing is demanded yet, so the aggregate starts empty and
  // the first route build's own output says what belongs in it.
  const runtime = await buildPrebuiltRuntime(options, exportsBySpecifier, new Map())
  await writeManifest(runtime)
  return runtime
}
/**
 * Fold what the build demanded - and any specifier it met for the first time - into the artifact. A
 * no-op in the steady state, which is every build after an app's client imports stop changing.
 */
export function settlePrebuiltRuntime(
  runtime: PrebuiltRuntime,
  options: ArtifactOptions,
  outDir: string,
  unprobed: Set<string>,
) {
  return underLock(options.dir, () => growPrebuiltRuntime(runtime, options, outDir, unprobed))
}

async function growPrebuiltRuntime(
  runtime: PrebuiltRuntime,
  options: ArtifactOptions,
  outDir: string,
  unprobed: Set<string>,
) {
  // Another build may have grown the artifact while this one ran; merge onto
  // what is on disk now, not onto the snapshot this build opened.
  const current = readManifest(options.dir)
  if (current) runtime = { ...runtime, ...current }
  const demanded = demandedFromOutputs(runtime, outDir)
  if (unprobed.size === 0 && surfaceCovered(runtime, demanded)) return runtime
  const exportsBySpecifier = new Map(runtime.exports)
  for (const [specifier, names] of await probeSurface([...unprobed], options)) {
    exportsBySpecifier.set(specifier, names)
  }
  const surface = new Map(runtime.surface)
  for (const [specifier, names] of demanded) {
    const target = surface.get(specifier) ?? new Set<string>()
    surface.set(specifier, target)
    for (const name of names) target.add(name)
  }
  const grown = await buildPrebuiltRuntime(options, exportsBySpecifier, surface)
  await writeManifest(grown)
  return grown
}

interface Manifest {
  key: string
  exports: Record<string, string[]>
  surface: Record<string, string[]>
  closure: { static: string[]; dynamic: string[] }
}

function readManifest(dir: string) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, manifestName), 'utf8')) as Manifest
    if (!parsed.exports) return undefined
    return {
      exports: new Map(Object.entries(parsed.exports)),
      surface: new Map(Object.entries(parsed.surface).map(([spec, n]) => [spec, new Set(n)])),
      closure: parsed.closure,
    }
  } catch {
    return undefined
  }
}

async function writeManifest(runtime: PrebuiltRuntime) {
  const manifest: Manifest = {
    key: runtime.key,
    exports: Object.fromEntries(runtime.exports),
    surface: Object.fromEntries([...runtime.surface].map(([s, n]) => [s, [...n].sort()])),
    closure: runtime.closure,
  }
  await writeText(path.join(runtime.dir, manifestName), JSON.stringify(manifest))
}

/**
 * The artifact files a route entry importing the aggregate must preload, as
 * `assets/…` names — what the rendered page's modulepreload list is written in.
 */
export function prebuiltAssets(runtime: PrebuiltRuntime) {
  const join = (name: string) => `${runtime.assetPath}/${name}`
  return {
    static: [join(PREBUILT_MODULE), ...runtime.closure.static.map(join)],
    dynamic: runtime.closure.dynamic.map(join),
  }
}
