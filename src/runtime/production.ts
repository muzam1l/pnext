/**
 * The release a production server runs from: compiled server artifacts plus the source facts the
 * build froze. A served request never reads, stats or hashes app source or config, and never
 * compiles; everything it imports is named here. Dev and the build itself keep their own loaders.
 */
import { type Dirent, existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ResolvedConfig } from '../config'
import type { ReleasedFont } from '../render/hooks'
import type { StaticMetadataFile } from '../routing/metadata-files'
import { prebundledFile, registerResolvePlugin } from './prebundle'
import { splitResourceQuery } from '../utils/resource-query'

export const BUILD_INDEX_VERSION = 1

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

export function buildManifestFile(outPath: string) {
  return path.join(outPath, 'server', 'manifest.json')
}

/** The framework copy a standalone dir ships: its compiled modules name framework files there. */
export function releaseFrameworkRoot(outPath: string) {
  try {
    const { name } = JSON.parse(readFileSync(path.join(frameworkRoot, 'package.json'), 'utf8')) as {
      name: string
    }
    return realpathSync(path.join(outPath, 'node_modules', name))
  } catch {
    return frameworkRoot
  }
}

/**
 * Where a release's app sources are, as its compiled modules name them: the app root the build recorded
 * relative to its output. In place that is the real root; a copied standalone keeps the same relation.
 */
export function releaseSourceRoot(outPath: string, serializedOutPath: string) {
  return path.resolve(outPath, path.relative(serializedOutPath, '.'))
}

/** Build-machine facts about a standalone dir, kept in the build cache beside it. */
export function standaloneOriginsFile(outPath: string) {
  return path.join(path.dirname(outPath), 'cache', 'standalone.json')
}

let shippedRelease: string | null | undefined

/** The standalone dir this framework copy ships in (`<dir>/node_modules/…/<name>`), if it is one. */
export function servingReleaseDir(): string | undefined {
  if (shippedRelease === undefined) {
    shippedRelease = null
    // Isolated installs nest the copy deeper: `node_modules/.bun/<pkg>/node_modules/<name>`.
    for (
      let dir = path.dirname(frameworkRoot);
      dir !== path.dirname(dir);
      dir = path.dirname(dir)
    ) {
      if (path.basename(dir) === 'node_modules' && existsSync(buildIndexFile(path.dirname(dir)))) {
        shippedRelease = path.dirname(dir)
        break
      }
    }
  }
  return shippedRelease ?? undefined
}

const linkedReleases = new Map<string, boolean>()

/**
 * Serve `release` from this framework copy without loading the standalone one beside it: its imports
 * of its `node_modules` copies resolve back to the files they were cloned from, so the process keeps
 * one instance of the framework and of every package. False when this copy cannot serve it in
 * place: the build cache naming the origins is gone, or the release moved since.
 */
export function linkStandaloneOrigins(release: string): boolean {
  if (servingReleaseDir() === release) return true
  const known = linkedReleases.get(release)
  if (known !== undefined) return known
  let origins: Record<string, string> | undefined
  try {
    const parsed = JSON.parse(readFileSync(standaloneOriginsFile(release), 'utf8')) as {
      release: string
      origins: Record<string, string>
    }
    if (parsed.release === release) origins = parsed.origins
  } catch {
    origins = undefined
  }
  linkedReleases.set(release, origins !== undefined)
  if (!origins) return false
  const files = origins
  const modules = `${path.join(release, 'node_modules')}${path.sep}`
  registerResolvePlugin({
    name: 'pnext-standalone-origins',
    setup(build) {
      build.onResolve({ filter: /node_modules\// }, args => {
        const file = path.resolve(path.dirname(args.importer), splitResourceQuery(args.path).path)
        if (!file.startsWith(modules)) return undefined
        const origin = files[path.relative(release, file).split(path.sep).join('/')]
        return origin && existsSync(origin) ? { path: prebundledFile(origin) } : undefined
      })
    },
  })
  return true
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
  const framework = releaseFrameworkRoot(config.outPath)
  const modules = new Map<string, string>()
  for (const [key, artifact] of Object.entries(index.modules)) {
    const second = key.indexOf(':', key.indexOf(':') + 1)
    modules.set(
      `${key.slice(0, second + 1)}${releaseSourceFile(key.slice(second + 1), config.root, config.workspaceRoot, framework)}`,
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

export function releaseSourceFile(
  key: string,
  root: string,
  workspaceRoot: string,
  framework = frameworkRoot,
) {
  const value = key.slice(2)
  if (key.startsWith('r:')) return path.join(root, value)
  if (key.startsWith('w:')) return path.resolve(workspaceRoot, value)
  if (key.startsWith('f:')) return path.resolve(framework, value)
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

/** Publish the build index last, atomically. */
export async function writeBuildIndex(config: ResolvedConfig, index: BuildIndex) {
  const file = buildIndexFile(config.outPath)
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(index))
  await rename(temporary, file)
}
