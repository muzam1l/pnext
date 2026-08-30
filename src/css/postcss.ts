// The app's postcss/Tailwind pipeline. Lives in its own module because it runs
// on the CSS worker thread (./worker.ts) rather than the event loop:
// Tailwind v4's postcss plugin is synchronous CPU work — its oxide scan and
// compile starved every concurrent request while it ran in-process.
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readText } from '../utils/fs'

export interface PostcssOptions {
  dev?: boolean
  /** pnext's output directory — kept out of Tailwind's content scan. */
  outDir?: string
}

// One long-lived processor per root+mode. Keeping it alive is what makes dev fast: Tailwind v4's postcss
// plugin holds a compiler and an oxide scanner per input file, so rebuilds are incremental candidate scans
// instead of a CLI spawn plus a full project re-scan. It also means other plugins in the config actually
// execute - the old CLI path treated postcss.config purely as a Tailwind trigger. Config-file edits need a
// dev-server restart; Tailwind tracks its own dependencies and refreshes them itself.
const postcssProcessors = new Map<string, Promise<LoadedPostcss | undefined>>()

interface PostcssProcessor {
  process(css: string, options: { from: string; to: string }): PromiseLike<{ css: string }>
}

/** A processor plus the `@source not` directives to append for it (if any). */
interface LoadedPostcss {
  processor: PostcssProcessor
  sources: string
  partitionedTailwindScan: boolean
}

type PostcssPluginFactory = (options?: unknown) => unknown

interface TailwindSource {
  base: string
  pattern: string
  negated: boolean
}

interface TailwindScanner {
  scan(): string[]
  scanFiles(input: TailwindChangedContent[]): string[]
  getCandidatesWithPositions(input: TailwindChangedContent): TailwindCandidatePosition[]
  files: string[]
  scannedFiles: string[]
  globs: TailwindGlob[]
  normalizedSources: TailwindGlob[]
}

interface TailwindChangedContent {
  file?: string
  content?: string
  extension: string
}

interface TailwindCandidatePosition {
  candidate: string
  position: number
}

interface TailwindGlob {
  base: string
  pattern: string
}

type TailwindScannerConstructor = new (options: { sources?: TailwindSource[] }) => TailwindScanner

interface TailwindScanRegistration {
  root: string
  cacheDir: string
  versions: string
}

const tailwindScannerPatch = Symbol.for('pnext.tailwind-scanner-v1')
const tailwindCandidateSchema = 1

interface TailwindOxideModule {
  Scanner: TailwindScannerConstructor
  [tailwindScannerPatch]?: {
    registrations: TailwindScanRegistration[]
    Scanner: TailwindScannerConstructor
  }
}

const warnedTailwindScannerVersions = new Set<string>()

interface PostcssConfig {
  plugins?: Record<string, unknown> | unknown[]
}

export function postcssConfigFile(root: string) {
  for (const file of ['postcss.config.cjs', 'postcss.config.js', 'postcss.config.mjs']) {
    const full = path.join(root, file)
    if (existsSync(full)) return full
  }
  return undefined
}

/** Build (or reuse) the processor for this root+mode without processing a file. */
export function loadPostcss(root: string, options: PostcssOptions) {
  const key = `${root}\0${options.dev ? 'dev' : 'build'}\0${options.outDir ?? ''}`
  let processor = postcssProcessors.get(key)
  if (!processor) {
    processor = createPostcssProcessor(root, options).catch((error: unknown) => {
      // Drop failed setups so a fixed config or install is retried.
      postcssProcessors.delete(key)
      throw error
    })
    postcssProcessors.set(key, processor)
  }
  return processor
}

export async function runPostcss(
  root: string,
  cssFile: string,
  options: PostcssOptions,
  fromSource?: string,
) {
  const loaded = await loadPostcss(root, options)
  if (!loaded) return
  // `from` labels the input for postcss plugins' diagnostics/source maps. Point
  // it at the original CSS source (not the synthesized bundle outfile) so
  // plugins like `@tailwindcss/postcss` report the real path (e.g. its
  // `DEBUG=tailwindcss` marker keys off `result.opts.from`). We still write the
  // processed output back to the bundle outfile via `to`.
  const from = fromSource ?? cssFile
  const css = await readText(cssFile)
  // The scan directives go last so they don't shift the line numbers plugins
  // report against the real source; `@source` is order-independent to Tailwind.
  const result = await loaded.processor.process(
    css + keptExclusions(loaded.sources, css, from, loaded.partitionedTailwindScan),
    { from, to: cssFile },
  )
  await writeFile(cssFile, result.css)
}

async function createPostcssProcessor(root: string, options: PostcssOptions) {
  const configFile = postcssConfigFile(root)
  if (!configFile) return undefined
  const loaded = (await import(pathToFileURL(configFile).href)) as
    PostcssConfig | { default: PostcssConfig }
  const config = 'default' in loaded && loaded.default ? loaded.default : loaded
  const { plugins, partitionedTailwindScan } = postcssPlugins(
    root,
    config as PostcssConfig,
    options,
  )
  if (plugins.length === 0) return undefined
  const appRequire = createRequire(path.join(root, 'package.json'))
  const postcss = interopDefault(resolvePostcss(appRequire)) as (
    plugins: unknown[],
  ) => PostcssProcessor
  const tailwind = pluginEntries(config as PostcssConfig).some(
    ([specifier, pluginOptions]) => specifier === '@tailwindcss/postcss' && pluginOptions !== false,
  )
  return {
    processor: postcss(plugins),
    sources: tailwind ? scanExclusions(root, appRequire, options) : '',
    partitionedTailwindScan,
  }
}

/**
 * Tailwind's automatic content detection only skips dependencies and build output when it can read
 * the project's git ignore rules. Off a git checkout - Docker build contexts, staged copies,
 * tarball deploys - oxide walks them instead and mints utilities from stale build artifacts.
 * Excluding these three by name restores that behaviour without narrowing what a correctly-ignored
 * checkout already scans. Apps that really do keep Tailwind-classed sources in one of them set
 * `PNEXT_TAILWIND_SCAN_ALL`.
 *
 * A pure function of (root, outDir) — deliberately NOT of what is on disk. The processor is built
 * once and cached, and `warmCssPipeline` builds it before the build has written its output, so an
 * `existsSync` here made the exclusion set depend on which of the two got there first: the same
 * stylesheet compiled with or without utilities minted out of pnext's own emitted JS.
 */
/**
 * The patched scanner partitions explicit dependency sources before applying broad exclusions, so
 * it needs the complete exclusion set. The native fallback cannot do that: remove any broad
 * exclusion that would otherwise override an explicit `@source` and silently drop its utilities.
 */
export function keptExclusions(
  exclusions: string,
  css: string,
  fromFile: string,
  partitionedTailwindScan = false,
): string {
  if (!exclusions || partitionedTailwindScan) return exclusions
  const dir = path.dirname(fromFile)
  const globs = [...css.matchAll(/@source\s+(?!not\s)['"]([^'"]+)['"]/g)].map(match =>
    path.resolve(dir, match[1]!.replace(/[*{[].*$/, '')),
  )
  if (globs.length === 0) return exclusions
  const kept = exclusions
    .split('\n')
    .filter(line => {
      const match = /@source not "([^"]+)"/.exec(line)
      return !match || !globs.some(glob => glob === match[1] || glob.startsWith(match[1] + '/'))
    })
    .join('\n')
  return kept.includes('@source not') ? kept : ''
}

function scanExclusions(root: string, appRequire: NodeJS.Require, options: PostcssOptions) {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  if (process.env.PNEXT_TAILWIND_SCAN_ALL) return ''
  // `@source not` landed in Tailwind 4.1; older versions error on the at-rule.
  const [major, minor] = packageVersion(appRequire, '@tailwindcss/postcss')
  if (major < 4 || (major === 4 && minor < 1)) return ''
  const dirs = ['node_modules', '.next', options.outDir ?? '.pnext']
  const excluded = [...new Set(dirs.map(dir => path.resolve(root, dir)))].filter(dir =>
    dir.startsWith(root + path.sep),
  )
  if (excluded.length === 0) return ''
  // Leading and trailing newlines keep the stylesheet's own first and last
  // lines exactly as they were, so the emitted CSS stays byte-identical.
  return `\n${excluded
    .map(dir => `@source not ${JSON.stringify(dir.split(path.sep).join('/'))};`)
    .join('\n')}\n`
}

/** `[major, minor]` of a resolvable package, or `[0, 0]` when unknown. */
function packageVersion(req: NodeJS.Require, name: string): [number, number] {
  try {
    const pkg = JSON.parse(readFileSync(req.resolve(`${name}/package.json`), 'utf8')) as {
      version?: string
    }
    const [major, minor] = (pkg.version ?? '').split('.')
    return [Number.parseInt(major ?? '', 10) || 0, Number.parseInt(minor ?? '', 10) || 0]
  } catch {
    return [0, 0]
  }
}

function pluginEntries(config: PostcssConfig): [unknown, unknown][] {
  return Array.isArray(config.plugins)
    ? config.plugins.map(entry =>
        Array.isArray(entry)
          ? ([entry[0], entry[1]] as [unknown, unknown])
          : ([entry, undefined] as [unknown, unknown]),
      )
    : Object.entries(config.plugins ?? {})
}

function postcssPlugins(root: string, config: PostcssConfig, options: PostcssOptions) {
  const appRequire = createRequire(path.join(root, 'package.json'))
  const entries = pluginEntries(config)

  const plugins: unknown[] = []
  let partitionedTailwindScan = false
  for (const [specifier, pluginOptions] of entries) {
    if (pluginOptions === false) continue
    if (typeof specifier !== 'string') {
      // Already-instantiated plugin object or factory in an array config.
      if (specifier) plugins.push(specifier)
      continue
    }
    const patchedScanner =
      specifier === '@tailwindcss/postcss'
        ? configureTailwindScanner(appRequire, root, options)
        : undefined
    const factory = interopDefault(appRequire(specifier) as unknown)
    if (patchedScanner) {
      assertTailwindScannerPatch(appRequire, patchedScanner)
      partitionedTailwindScan = true
    }
    const resolvedOptions = pluginOptionsFor(root, specifier, pluginOptions, options)
    plugins.push(
      typeof factory === 'function' ? (factory as PostcssPluginFactory)(resolvedOptions) : factory,
    )
  }
  return { plugins, partitionedTailwindScan }
}

function configureTailwindScanner(
  appRequire: NodeJS.Require,
  root: string,
  options: PostcssOptions,
) {
  const pluginPackage = appRequire.resolve('@tailwindcss/postcss/package.json')
  const pluginRequire = createRequire(pluginPackage)
  const oxide = pluginRequire('@tailwindcss/oxide') as TailwindOxideModule
  const versions = ['@tailwindcss/postcss', 'tailwindcss', '@tailwindcss/oxide'].map(name => ({
    name,
    version: packageVersionText(pluginRequire, name),
    tuple: packageVersion(pluginRequire, name),
  }))
  // The monkey-patch and source partitioning contract are covered against Tailwind 4.3.x.
  if (!versions.every(({ tuple: [major, minor] }) => major === 4 && minor === 3)) {
    const label = versions.map(({ name, version }) => `${name}@${version}`).join(', ')
    if (!warnedTailwindScannerVersions.has(label)) {
      warnedTailwindScannerVersions.add(label)
      console.warn(`PNext: unsupported Tailwind scanner versions (${label}); using native Scanner.`)
    }
    return undefined
  }
  const registration = {
    root: path.resolve(root),
    cacheDir: path.join(
      path.resolve(root, options.outDir ?? '.pnext'),
      'cache/tailwind/candidates/v1',
    ),
    versions: ['@tailwindcss/postcss', 'tailwindcss', '@tailwindcss/oxide', 'postcss']
      .map(name => `${name}@${packageVersionText(pluginRequire, name)}`)
      .join('\0'),
  }
  const installed = oxide[tailwindScannerPatch]
  if (installed) {
    if (oxide.Scanner !== installed.Scanner) throw tailwindScannerPatchError()
    const index = installed.registrations.findIndex(item => item.root === registration.root)
    if (index === -1) installed.registrations.push(registration)
    else installed.registrations[index] = registration
    return installed.Scanner
  }

  const NativeScanner = oxide.Scanner
  const registrations = [registration]
  class PnextTailwindScanner implements TailwindScanner {
    private readonly scanners: {
      scanner: TailwindScanner
      inventory: TailwindScanner
      sources: TailwindSource[]
    }[]
    private readonly registration?: TailwindScanRegistration

    constructor({ sources = [] }: { sources?: TailwindSource[] }) {
      this.registration = tailwindRegistration(registrations, sources)
      this.scanners = partitionTailwindSources(sources).map(partition => ({
        scanner: new NativeScanner({ sources: partition }),
        inventory: new NativeScanner({ sources: partition }),
        sources: partition,
      }))
    }

    scan() {
      return sortedUnique(
        this.scanners.flatMap(({ scanner, inventory, sources }) =>
          this.registration
            ? cachedTailwindCandidates(inventory, sources, this.registration, () =>
                new NativeScanner({ sources }).scan(),
              )
            : scanner.scan(),
        ),
      )
    }

    scanFiles(input: TailwindChangedContent[]) {
      return sortedUnique(this.scanners.flatMap(({ scanner }) => scanner.scanFiles(input)))
    }

    getCandidatesWithPositions(input: TailwindChangedContent) {
      return this.scanners.flatMap(({ scanner }) => scanner.getCandidatesWithPositions(input))
    }

    get files() {
      return sortedUnique(this.scanners.flatMap(({ inventory }) => inventory.files))
    }

    get scannedFiles() {
      return sortedUnique(this.scanners.flatMap(({ scanner }) => scanner.scannedFiles))
    }

    get globs() {
      return uniqueTailwindGlobs(this.scanners.flatMap(({ scanner }) => scanner.globs))
    }

    get normalizedSources() {
      return uniqueTailwindGlobs(this.scanners.flatMap(({ scanner }) => scanner.normalizedSources))
    }
  }

  oxide.Scanner = PnextTailwindScanner
  oxide[tailwindScannerPatch] = { registrations, Scanner: PnextTailwindScanner }
  return PnextTailwindScanner
}

function assertTailwindScannerPatch(
  appRequire: NodeJS.Require,
  expected: TailwindScannerConstructor,
) {
  const pluginPackage = appRequire.resolve('@tailwindcss/postcss/package.json')
  const oxide = createRequire(pluginPackage)('@tailwindcss/oxide') as TailwindOxideModule
  if (oxide.Scanner !== expected || oxide[tailwindScannerPatch]?.Scanner !== expected) {
    throw tailwindScannerPatchError()
  }
}

function tailwindScannerPatchError() {
  return new Error(
    'PNext could not install its Tailwind Scanner integration. The loaded @tailwindcss/postcss module does not observe the patched @tailwindcss/oxide Scanner; refusing to drop explicit @source utilities.',
  )
}

function partitionTailwindSources(sources: TailwindSource[]): TailwindSource[][] {
  const broadExclusions = sources.filter(source => source.negated && !/[*?{[]/.test(source.pattern))
  const dependencySources = sources.filter(
    source =>
      !source.negated &&
      broadExclusions.some(exclusion => isInside(sourcePrefix(exclusion), sourcePrefix(source))),
  )
  if (dependencySources.length === 0) return [sources]
  const dependencySet = new Set(dependencySources)
  const appSources = sources.filter(source => !dependencySet.has(source))
  return [appSources].concat(
    dependencySources.map(source =>
      [
        source,
        ...sources.filter(
          exclusion =>
            exclusion.negated &&
            !broadExclusions.includes(exclusion) &&
            pathsOverlap(sourcePrefix(source), sourcePrefix(exclusion)),
        ),
      ].map(resolveTailwindSource),
    ),
  )
}

function resolveTailwindSource(source: TailwindSource): TailwindSource {
  const globAt = source.pattern.search(/[*?{[]/)
  const literal = (globAt === -1 ? source.pattern : source.pattern.slice(0, globAt)).replace(
    /[\\/]$/,
    '',
  )
  const absolutePattern = path.resolve(source.base, source.pattern)
  let absolute = path.resolve(source.base, literal || '.')
  while (!existsSync(absolute)) {
    const parent = path.dirname(absolute)
    if (parent === absolute) return source
    absolute = parent
  }
  try {
    const stat = statSync(absolute)
    if (globAt === -1 && stat.isFile()) {
      return {
        ...source,
        base: realpathSync.native(path.dirname(absolute)),
        pattern: path.basename(absolute),
      }
    }
    return {
      ...source,
      base: realpathSync.native(absolute),
      pattern:
        globAt === -1 ? '**/*' : path.relative(absolute, absolutePattern).split(path.sep).join('/'),
    }
  } catch {
    return source
  }
}

function sourcePrefix(source: TailwindSource) {
  const prefix = source.pattern.replace(/[*?{[].*$/, '').replace(/[\\/]$/, '') || '.'
  return path.resolve(source.base, prefix)
}

function pathsOverlap(left: string, right: string) {
  return isInside(left, right) || isInside(right, left)
}

function isInside(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

function tailwindRegistration(
  registrations: TailwindScanRegistration[],
  sources: TailwindSource[],
) {
  return [...registrations]
    .sort((left, right) => right.root.length - left.root.length)
    .find(item => sources.some(source => isInside(item.root, path.resolve(source.base))))
}

function cachedTailwindCandidates(
  inventory: TailwindScanner,
  sources: TailwindSource[],
  registration: TailwindScanRegistration,
  scan: () => string[],
) {
  let cache: { file: string; fingerprint: string; files: number }
  try {
    cache = tailwindCacheIdentity(inventory, sources, registration)
  } catch {
    return scan()
  }
  const stored = readJson<{
    schema?: number
    fingerprint?: string
    candidates?: unknown
  }>(cache.file)
  if (
    stored?.schema === tailwindCandidateSchema &&
    stored.fingerprint === cache.fingerprint &&
    Array.isArray(stored.candidates) &&
    stored.candidates.every(candidate => typeof candidate === 'string')
  ) {
    return stored.candidates
  }

  const candidates = scan()
  try {
    mkdirSync(registration.cacheDir, { recursive: true })
    atomicJsonWrite(cache.file, {
      schema: tailwindCandidateSchema,
      fingerprint: cache.fingerprint,
      candidates,
      files: cache.files,
    })
  } catch {
    // Cache writes are optional; the fresh Oxide result remains correct.
  }
  return candidates
}

function tailwindCacheIdentity(
  scanner: TailwindScanner,
  sources: TailwindSource[],
  registration: TailwindScanRegistration,
) {
  const identities = sources.map(tailwindSourceIdentity)
  const sourceKey = createHash('sha256')
    .update(String(tailwindCandidateSchema))
    .update('\0')
    .update(registration.versions)
    .update('\0')
    .update(JSON.stringify(identities))
    .digest('hex')
  const files = scanner.files.map(file => path.resolve(file)).sort()
  const fingerprint = createHash('sha256').update(sourceKey)
  for (const file of files) {
    fingerprint.update('\0').update(file).update('\0').update(readFileSync(file))
  }
  return {
    file: path.join(registration.cacheDir, `${sourceKey}.json`),
    fingerprint: fingerprint.digest('hex'),
    files: files.length,
  }
}

function tailwindSourceIdentity(source: TailwindSource) {
  const prefix = sourcePrefix(source)
  const real = realExistingPath(prefix)
  const packageFile = nearestPackageJson(real)
  let packageIdentity: { name?: string; version?: string } | undefined
  if (packageFile) {
    const pkg = readJson<{ name?: string; version?: string }>(packageFile)
    if (pkg) {
      packageIdentity = { name: pkg.name, version: pkg.version }
    }
  }
  return { ...source, base: path.resolve(source.base), real, package: packageIdentity }
}

function realExistingPath(input: string) {
  let current = input
  while (!existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) return input
    current = parent
  }
  try {
    const stat = statSync(current)
    return realpathSync.native(stat.isFile() ? path.dirname(current) : current)
  } catch {
    return current
  }
}

function nearestPackageJson(input: string) {
  let current = input
  while (true) {
    const file = path.join(current, 'package.json')
    if (existsSync(file)) return file
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

function atomicJsonWrite(file: string, value: unknown) {
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(temporary, JSON.stringify(value))
  renameSync(temporary, file)
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

function sortedUnique(values: string[]) {
  return [...new Set(values)].sort()
}

function uniqueTailwindGlobs(globs: TailwindGlob[]) {
  const seen = new Set<string>()
  return globs.filter(glob => {
    const key = `${glob.base}\0${glob.pattern}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function packageVersionText(req: NodeJS.Require, name: string) {
  try {
    return (
      (
        JSON.parse(readFileSync(req.resolve(`${name}/package.json`), 'utf8')) as {
          version?: string
        }
      ).version ?? 'unknown'
    )
  } catch {
    return 'unknown'
  }
}

function pluginOptionsFor(
  root: string,
  specifier: string,
  userOptions: unknown,
  options: PostcssOptions,
) {
  if (specifier !== '@tailwindcss/postcss') return userOptions
  // Scan candidates from the app root — the bundled css Tailwind reads lives
  // under .pnext, where a default input-relative scan would find nothing.
  return {
    base: root,
    optimize: options.dev ? false : { minify: true },
    ...(typeof userOptions === 'object' && userOptions !== null ? userOptions : {}),
  }
}

function resolvePostcss(appRequire: NodeJS.Require): unknown {
  // Next runs the PostCSS pipeline through its OWN bundled PostCSS 8, never the app's copy. That matters
  // when a legacy plugin dep pins an old major: `postcss-nested@4` declares `postcss@^7` as a regular
  // dependency, which the package manager hoists to the app's top-level node_modules, so requiring
  // 'postcss' from the app would return PostCSS 7 and a modern app plugin using the v8 API throws. Prefer
  // the app's postcss only when it is already v8+, otherwise fall back to pnext's own.
  let appPostcss: unknown
  try {
    appPostcss = appRequire('postcss')
    if (packageVersion(appRequire, 'postcss')[0] >= 8) return appPostcss
  } catch {
    // App has no resolvable postcss; fall through to pnext's own / plugin copy.
  }
  const ownPostcss = resolveOwnPostcss()
  if (ownPostcss) return ownPostcss
  try {
    // A Tailwind-based app ships a v8 postcss under its plugin package.
    const pluginPackage = appRequire.resolve('@tailwindcss/postcss/package.json')
    return createRequire(pluginPackage)('postcss')
  } catch {
    // Last resort: whatever the app resolved (even if <8) — better than nothing.
    if (appPostcss) return appPostcss
    throw new Error('Could not resolve a PostCSS installation for the CSS pipeline.')
  }
}

/** pnext's own PostCSS 8 (mirrors Next's bundled copy), or undefined. */
function resolveOwnPostcss(): unknown {
  try {
    const ownRequire = createRequire(import.meta.url)
    if (packageVersion(ownRequire, 'postcss')[0] >= 8) return ownRequire('postcss')
  } catch {
    // pnext's install carries no resolvable postcss; caller falls back.
  }
  return undefined
}

function interopDefault(mod: unknown): unknown {
  if (typeof mod === 'function') return mod
  if (mod && typeof mod === 'object' && 'default' in mod && mod.default) return mod.default
  return mod
}
