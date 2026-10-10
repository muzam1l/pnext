/**
 * The release a production server runs from: compiled server artifacts plus the source facts the
 * build froze. A served request never reads, stats or hashes app source or config, and never
 * compiles; everything it imports is named here. Dev and the build itself keep their own loaders.
 */
import { type Dirent, existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ResolvedConfig } from '../config'
import type { ReleasedFont } from '../render/hooks'
import type { StaticMetadataFile } from '../routing/metadata-files'

export const BUILD_INDEX_VERSION = 1
const LOCATOR_FILE = 'release-locator.json'

/** `server` is the RSC/server layer, `client` the SSR copy of client components. */
export type ReleaseLayer = 'server' | 'client'

/** What the build writes. Paths are relative (to the root, or to the out dir for artifacts). */
export interface BuildIndex {
  version: number
  /** The framework fingerprint the build compiled with. */
  framework?: string
  config: Record<string, unknown>
  /** The compiled next.config, out-relative. */
  nextConfig?: string
  /** `<layer>:<target>:<releaseSourceKey>` -> artifact. */
  modules: Record<string, string>
  /** App directory -> the convention files and `@slot`/group directories it holds. */
  conventions: Record<string, string[]>
  /** Convention files carrying `'use client'`. */
  clientConventions: string[]
  /** Root layouts that export a default component. */
  documentLayouts: string[]
  /** The root layout's global stylesheet closure, in order. */
  globalCss: string[]
  /** The proxy source and its literal `config` export, when the app has one. */
  proxy?: { file: string; config?: unknown }
  /** Font resolutions by declaration key, files out-relative. */
  fonts?: Record<string, ReleasedFont>
  /** Prebuilt instrumentation instances, out-relative. */
  instrumentation?: { file: string; edge?: string }
  /** App facts compat reads at boot: root param names, pages revalidate windows. */
  compat?: CompatReleaseFacts
  /** The App Router layers' linked server dependency graphs, out-relative. */
  dependencies?: string[]
}

/** What compat contributes to a release. */
export type CompatRelease = Pick<BuildIndex, 'nextConfig' | 'instrumentation' | 'compat'>

export interface CompatReleaseFacts {
  rootParams: string[]
  pagesRevalidate: [string, number][]
  /** Pages API sources (root-relative) and their runtime. */
  pagesApi: Record<string, string>
  /** Compiled cache handlers by role, out-relative. */
  cacheHandlers: Record<string, string>
  /** Materialized pages-router route wrappers, root-relative. */
  pagesRoutes: string[]
}

/** The loaded release, resolved against where it is served from. */
export interface Release {
  /** `<layer>:<target>:<absolute source>` -> file href. */
  modules: Map<string, string>
  conventions: ConventionFacts
  globalCss: string[]
  proxy: { file?: string; config?: unknown }
  instrumentation?: { file: string; edge?: string }
  compat?: CompatReleaseFacts
  /** Font resolutions by declaration key, files absolute. */
  fonts?: Record<string, ReleasedFont>
  /** The build's static metadata files; the serving pipeline publishes them from its manifest. */
  staticMetadataFiles?: StaticMetadataFile[]
}

export interface ConventionFacts {
  appPath: string
  /** Absolute app directory -> its convention files and child directories. */
  dirs: Map<string, { files: Set<string>; dirs: string[] }>
  client: ReadonlySet<string>
  documentLayouts: ReadonlySet<string>
}

const releases = new WeakMap<object, Release>()
const WORK_UNIT_STORAGE = Symbol.for('pnext.workUnitStorage')

export function buildIndexFile(outPath: string) {
  return path.join(outPath, 'server', 'build-index.json')
}

export function releaseModuleKey(layer: ReleaseLayer, target: string, file: string) {
  return `${layer}:${target}:${file}`
}

/** The release `config` serves from; undefined for dev and for the build itself. */
export function productionRelease(config: object): Release | undefined {
  return releases.get(config)
}

/** The release the current request's work unit serves, if any (request/context owns the store). */
export function servedRelease(): Release | undefined {
  const units = (globalThis as Record<PropertyKey, unknown>)[WORK_UNIT_STORAGE] as
    { getStore(): { release?: Release } | undefined } | undefined
  return units?.getStore()?.release
}

/** The frozen app-directory facts of the release this work serves, if any. */
export function servedConventions(): ConventionFacts | undefined {
  return servedRelease()?.conventions
}

/** A frozen listing for `dir` when it lies in the served app; undefined defers to the disk. */
export function frozenDirListing(dir: string) {
  const facts = servedConventions()
  if (!facts || !isInsideDir(facts.appPath, dir)) return undefined
  return facts.dirs.get(dir) ?? { files: new Set<string>(), dirs: [] }
}

/** Whether a convention file exists: the frozen fact in production, the disk otherwise. */
export function conventionFileExists(file: string) {
  return frozenDirListing(path.dirname(file))?.files.has(path.basename(file)) ?? existsSync(file)
}

/** The compiled artifact for `file`; a module the build did not compile is a build bug, never a compile. */
export function releaseModuleHref(
  release: Release,
  layer: ReleaseLayer,
  target: string,
  file: string,
) {
  const href = release.modules.get(releaseModuleKey(layer, target, path.resolve(file)))
  if (!href) {
    throw new Error(
      `pnext: ${file} (${layer}, ${target}) is not in this build's release. Run 'pnext build' again.`,
    )
  }
  return href
}

/** Read `<outPath>/server/build-index.json` and attach it to `config`. */
export function attachRelease(config: ResolvedConfig, index = readBuildIndex(config.outPath)) {
  const existing = releases.get(config)
  if (existing) return existing
  const fromRoot = (file: string) => path.resolve(config.root, file)
  const modules = new Map<string, string>()
  for (const [key, artifact] of Object.entries(index.modules)) {
    const second = key.indexOf(':', key.indexOf(':') + 1)
    modules.set(
      `${key.slice(0, second + 1)}${releaseSourceFile(key.slice(second + 1), config.root, config.workspaceRoot)}`,
      pathToFileURL(path.resolve(config.outPath, artifact)).href,
    )
  }
  const dirs = new Map<string, { files: Set<string>; dirs: string[] }>()
  for (const [dir, names] of Object.entries(index.conventions)) {
    dirs.set(fromRoot(dir), {
      files: new Set(names.filter(name => !name.endsWith('/'))),
      dirs: names.filter(name => name.endsWith('/')).map(name => name.slice(0, -1)),
    })
  }
  const release: Release = {
    modules,
    conventions: {
      appPath: config.appPath,
      dirs,
      client: new Set(index.clientConventions.map(fromRoot)),
      documentLayouts: new Set(index.documentLayouts.map(fromRoot)),
    },
    globalCss: index.globalCss.map(fromRoot),
    proxy: index.proxy ? { ...index.proxy, file: fromRoot(index.proxy.file) } : {},
    ...(index.compat ? { compat: index.compat } : {}),
    ...(index.instrumentation
      ? {
          instrumentation: {
            file: path.resolve(config.outPath, index.instrumentation.file),
            ...(index.instrumentation.edge
              ? { edge: path.resolve(config.outPath, index.instrumentation.edge) }
              : {}),
          },
        }
      : {}),
    ...(index.fonts
      ? {
          fonts: Object.fromEntries(
            Object.entries(index.fonts).map(([key, font]) => [
              key,
              { ...font, files: font.files.map(file => path.resolve(config.outPath, file)) },
            ]),
          ),
        }
      : {}),
  }
  releases.set(config, release)
  return release
}

const conventionBases = new Set([
  'page',
  'route',
  'layout',
  'template',
  'loading',
  'error',
  'not-found',
  'default',
  'forbidden',
  'unauthorized',
  'global-error',
  'global-not-found',
])

const metadataBase =
  /^(?:robots|sitemap|manifest|favicon|(?:apple-)?icon\d*|opengraph-image\d*|twitter-image\d*)$/
const codeFile = /\.(?:[cm]?[jt]sx?|mdx?)$/

function capturedFile(name: string) {
  const base = /^[^.]+/.exec(name)?.[0] ?? name
  return conventionBases.has(base) || metadataBase.test(base)
}

/** Every file of the served app's frozen tree: its convention and metadata files. */
export function servedAppFiles(facts: ConventionFacts) {
  return [...facts.dirs].flatMap(([dir, listing]) =>
    [...listing.files].map(name => path.join(dir, name)),
  )
}

/** Every app directory with its convention/metadata files and child directories; `files` are the code ones. */
export function captureConventions(root: string, appPath: string) {
  const conventions: Record<string, string[]> = {}
  const files: string[] = []
  const visit = (dir: string) => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const names: string[] = []
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        names.push(`${entry.name}/`)
        visit(path.join(dir, entry.name))
      } else if (capturedFile(entry.name)) {
        names.push(entry.name)
        if (codeFile.test(entry.name)) files.push(path.join(dir, entry.name))
      }
    }
    conventions[toPosix(path.relative(root, dir)) || '.'] = names.sort()
  }
  visit(appPath)
  return { conventions, files }
}

// The framework's own package root: compat runtime modules compile like app sources but live here.
const frameworkRoot = path.resolve(import.meta.dirname, '..', '..')

/** A source's identity in the release: root-, workspace- or framework-relative, so a moved build still finds it. */
export function releaseSourceKey(file: string, root: string, workspaceRoot: string) {
  const inRoot = path.relative(root, file)
  if (!inRoot.startsWith('..') && !path.isAbsolute(inRoot)) return `r:${toPosix(inRoot)}`
  const inWorkspace = path.relative(workspaceRoot, file)
  if (!inWorkspace.startsWith('..') && !path.isAbsolute(inWorkspace))
    return `w:${toPosix(inWorkspace)}`
  const inFramework = path.relative(frameworkRoot, file)
  if (!inFramework.startsWith('..') && !path.isAbsolute(inFramework))
    return `f:${toPosix(inFramework)}`
  // Outside every root (a pages app materialized in tmpdir): root-relative, resolved like the manifest.
  return `r:${toPosix(inRoot)}`
}

export function releaseSourceFile(key: string, root: string, workspaceRoot: string) {
  const value = key.slice(2)
  if (key.startsWith('r:')) return path.join(root, value)
  if (key.startsWith('w:')) return path.resolve(workspaceRoot, value)
  if (key.startsWith('f:')) return path.resolve(frameworkRoot, value)
  return path.join(root, value)
}

function toPosix(file: string) {
  return file.split(path.sep).join('/')
}

function isInsideDir(root: string, file: string) {
  return file === root || file.startsWith(`${root}${path.sep}`)
}

export function readBuildIndex(outPath: string): BuildIndex {
  const file = buildIndexFile(outPath)
  let index: BuildIndex
  try {
    index = JSON.parse(readFileSync(file, 'utf8')) as BuildIndex
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    throw new Error("No production build found. Run 'pnext build' first.")
  }
  if (index.version !== BUILD_INDEX_VERSION) {
    throw new Error(`pnext: ${file} is from another pnext version. Run 'pnext build' again.`)
  }
  return index
}

/**
 * Where a built root keeps its release: the dir its locator names when the latest build wrote outside
 * the default out dir (a build into the default empties it, locator included), else the default.
 * Undefined when the root holds no build.
 */
export function locateRelease(root: string, defaultOutDir: string): string | undefined {
  const outPath = path.join(root, defaultOutDir)
  try {
    const { outDir } = JSON.parse(readFileSync(path.join(outPath, LOCATOR_FILE), 'utf8')) as {
      outDir: string
    }
    return path.resolve(root, outDir)
  } catch {
    return existsSync(buildIndexFile(outPath)) ? outPath : undefined
  }
}

/** The resolved config as the build saw it, with paths made relative to the root. */
export function serializeReleaseConfig(config: ResolvedConfig): Record<string, unknown> {
  const relative = (file: string) => path.relative(config.root, file) || '.'
  return JSON.parse(
    JSON.stringify(
      {
        ...config,
        root: '.',
        workspaceRoot: relative(config.workspaceRoot),
        appPath: relative(config.appPath),
        publicPath: relative(config.publicPath),
        outPath: relative(config.outPath),
        outRootPath: relative(config.outRootPath),
        typesPath: relative(config.typesPath),
        checksPath: relative(config.checksPath),
      },
      (_key, value: unknown) =>
        value instanceof RegExp ? { $regexp: [value.source, value.flags] } : value,
    ),
  ) as Record<string, unknown>
}

/** The inverse of `serializeReleaseConfig`, for a release served from `root` out of `outPath`. */
export function releaseConfig(
  serialized: Record<string, unknown>,
  root: string,
  outPath: string,
): ResolvedConfig {
  const config = JSON.parse(JSON.stringify(serialized), (_key, value: unknown) => {
    const pattern = (value as { $regexp?: [string, string] } | null)?.$regexp
    return pattern ? new RegExp(pattern[0], pattern[1]) : value
  }) as ResolvedConfig
  const fromRoot = (file: string) => path.resolve(root, file)
  const fromOut = (file: string) => path.resolve(outPath, path.relative(config.outPath, file))
  return {
    ...config,
    root,
    workspaceRoot: fromRoot(config.workspaceRoot),
    appPath: fromRoot(config.appPath),
    publicPath: fromRoot(config.publicPath),
    outPath,
    outRootPath: fromOut(config.outRootPath),
    typesPath: fromOut(config.typesPath),
    checksPath: fromOut(config.checksPath),
  }
}

/** Publish the build index last, atomically, plus a locator when the out dir is not the default. */
export async function writeBuildIndex(
  config: ResolvedConfig,
  index: BuildIndex,
  defaultOutDir: string,
) {
  const file = buildIndexFile(config.outPath)
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(index))
  await rename(temporary, file)
  const defaultOut = path.join(config.root, defaultOutDir)
  if (path.resolve(config.outPath) === path.resolve(defaultOut)) return
  await mkdir(defaultOut, { recursive: true })
  const locator = path.join(defaultOut, LOCATOR_FILE)
  await writeFile(
    `${locator}.${process.pid}.tmp`,
    JSON.stringify({ outDir: path.relative(config.root, config.outPath) }),
  )
  await rename(`${locator}.${process.pid}.tmp`, locator)
  // A default-out release left by an earlier build is now stale: the locator already outranks it.
  await rm(buildIndexFile(defaultOut), { force: true })
}
