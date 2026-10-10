import { type Dirent, existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { frozenDirListing } from '../runtime/production'
import type { BuildManifest } from '../types'

// Write-then-rename so a concurrent import never observes a truncated file; Bun caches a failed load for the
// life of the process. The temp name must be unique per CALL, not per process: two writers of the same output
// (two routes demanding one vendor bundle, a re-write after a cache eviction) otherwise share a name and the
// second rename hits ENOENT once the first moved it away. Losing that race is harmless - both wrote the same
// content-keyed bytes - so a rename whose temp is gone only fails if the destination is missing too.
let atomicWriteSequence = 0
export async function writeFileAtomic(file: string, contents: string, tempDirectory?: string) {
  const suffix = `${process.pid.toString(36)}.${(++atomicWriteSequence).toString(36)}.tmp`
  let temp = tempDirectory
    ? path.join(
        tempDirectory,
        `.${path.basename(path.dirname(file))}-${path.basename(file)}.${suffix}`,
      )
    : `${file}.${suffix}`
  try {
    await writeFile(temp, contents)
  } catch (error) {
    // An unwritable tempDirectory (read-only parent of a containerized app root)
    // must not fail the write: fall back to staging beside the destination.
    if (!tempDirectory) throw error
    temp = `${file}.${suffix}`
    await writeFile(temp, contents)
  }
  try {
    await rename(temp, file)
  } catch (error) {
    if (!existsSync(file)) throw error
  }
}

export async function listFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return []
  const entries = await readdir(root, { withFileTypes: true })
  // Subdirectories are walked concurrently — a depth-first await chain spends
  // the whole walk waiting on one readdir at a time (0.6 s on a ~1k-file app).
  // Results stay in readdir order so callers keep a stable file order.
  const branches = await Promise.all(
    entries.map(entry => {
      const entryPath = path.join(root, entry.name)
      if (entry.isDirectory()) return listFiles(entryPath)
      return Promise.resolve(entry.isFile() ? [entryPath] : [])
    }),
  )
  return branches.flat()
}

interface DirListing {
  files: Set<string>
  dirs: string[]
}

let dirListings: Map<string, DirListing> | undefined

/**
 * Memoize directory listings for the duration of `run`. A route scan asks the
 * same handful of directories for every convention file of every route, and the
 * answers cannot change mid-scan. Outside a `withDirCache` scope every lookup
 * reads the directory fresh, so request-time callers never see a stale tree.
 */
export function withDirCache<T>(run: () => T): T {
  if (dirListings) return run()
  dirListings = new Map()
  try {
    return run()
  } finally {
    dirListings = undefined
  }
}

/** File and subdirectory names of `dir` (both empty when it does not exist). */
export function readDirListing(dir: string): DirListing {
  const frozen = frozenDirListing(dir)
  if (frozen) return frozen
  const cached = dirListings?.get(dir)
  if (cached) return cached
  let listing: DirListing
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    listing = {
      files: new Set(entries.filter(entry => !entry.isDirectory()).map(entry => entry.name)),
      dirs: entries
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort(),
    }
  } catch {
    listing = { files: new Set(), dirs: [] }
  }
  dirListings?.set(dir, listing)
  return listing
}

/** On-disk names per directory and recent wrong-case misses, kept by one server; undefined on a case-sensitive filesystem. */
export type ExactNames = { dirs: Map<string, Set<string>>; misses: Set<string> } | undefined

const maxExactNameMisses = 1024

/** Only a case-insensitive filesystem (macOS, Windows) needs `hasExactName`; one probe per server, on `dir`'s own mount. */
export function exactNameIndex(dir: string): ExactNames {
  let entries: Dirent[] = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    // Probe `dir` itself under its parent.
  }
  // A symlink's flipped name answers for its target, and a dangling one never exists.
  const entry = entries.find(item => !item.isSymbolicLink() && hasCase(item.name))
  const probe = entry ? path.join(dir, entry.name) : dir
  const name = path.basename(probe)
  if (!hasCase(name)) return undefined
  return existsSync(path.join(path.dirname(probe), flipCase(name)))
    ? { dirs: new Map(), misses: new Set() }
    : undefined
}

function flipCase(name: string) {
  return name === name.toUpperCase() ? name.toLowerCase() : name.toUpperCase()
}

function hasCase(name: string) {
  return flipCase(name) !== name
}

/** Whether `relative` under `root` is spelled exactly as on disk (Next serves static files by exact name). */
export function hasExactName(names: NonNullable<ExactNames>, root: string, relative: string) {
  let dir = root
  for (const name of relative.split(path.sep)) {
    const file = `${dir}${path.sep}${name}`
    const listing = dirNames(names, dir)
    // An unreadable directory fails this request only; nothing about it is remembered.
    if (!listing) return false
    if (!listing.has(name)) {
      if (names.misses.has(file)) return false
      // A miss re-reads the directory once: the server may have written the file since.
      const fresh = dirNames(names, dir, true)
      if (!fresh?.has(name)) {
        if (fresh) {
          if (names.misses.size >= maxExactNameMisses) names.misses.clear()
          names.misses.add(file)
        }
        return false
      }
    }
    dir = file
  }
  return true
}

function dirNames(names: NonNullable<ExactNames>, dir: string, refresh = false) {
  let entries = refresh ? undefined : names.dirs.get(dir)
  if (!entries) {
    try {
      entries = new Set(readdirSync(dir))
    } catch {
      return undefined
    }
    names.dirs.set(dir, entries)
  }
  return entries
}

/** listFiles for callers already running synchronously (route fact scans). */
export function listFilesSync(root: string): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name)
    if (entry.isDirectory()) out.push(...listFilesSync(entryPath))
    else if (entry.isFile()) out.push(entryPath)
  }

  return out
}

/** Empty `dir`, leaving the named top-level entries (and their contents) in place. */
export async function ensureEmptyDir(dir: string, keep: readonly string[] = []) {
  if (keep.length === 0) {
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    return
  }
  await mkdir(dir, { recursive: true })
  const preserved = new Set(keep)
  const entries = await readdir(dir).catch(() => [] as string[])
  await Promise.all(
    entries
      .filter(entry => !preserved.has(entry))
      .map(entry => rm(path.join(dir, entry), { recursive: true, force: true })),
  )
}

export async function ensureDir(dir: string) {
  await mkdir(dir, { recursive: true })
}

export async function writeText(file: string, value: string) {
  await ensureDir(path.dirname(file))
  await writeFile(file, value)
}

export async function readText(file: string) {
  return readFile(file, 'utf8')
}

export async function fileMtime(file: string) {
  return (await stat(file)).mtimeMs
}

export function toPosixPath(value: string) {
  return value.split(path.sep).join('/')
}

export function cssModuleScopePath(file: string) {
  const normalized = toPosixPath(file)
  const appIndex = normalized.lastIndexOf('/app/')
  if (appIndex !== -1) return normalized.slice(appIndex + 1)
  let dir = path.dirname(file)
  let fallback: string | undefined
  while (true) {
    const packageFile = path.join(dir, 'package.json')
    if (
      existsSync(packageFile) ||
      existsSync(path.join(dir, 'pnext.config.ts')) ||
      existsSync(path.join(dir, 'node_modules'))
    ) {
      const relative = toPosixPath(path.relative(dir, file))
      try {
        const { name } = JSON.parse(readFileSync(packageFile, 'utf8')) as { name?: unknown }
        if (typeof name === 'string') return `${name}/${relative}`
      } catch {
        // Unnamed projects still have a root-relative identity.
      }
      fallback ??= relative
    }
    const parent = path.dirname(dir)
    if (parent === dir) return fallback ?? path.basename(file)
    dir = parent
  }
}

/** '^' + pnext's own running version, read from its package.json (this module lives at src/utils/). */
export function pnextVersionRange() {
  const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url))
  const { version } = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }
  return `^${version}`
}

/**
 * The range pnext declares for one of its optional dependencies. An app that uses the feature has to
 * declare the package itself — the vercel adapter ships pnext's optional deps only where the app
 * depends on them too — so the range has to come from here rather than being written down twice.
 */
export function pnextOptionalDependencyRange(name: string) {
  const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url))
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    optionalDependencies?: Record<string, string>
  }
  return pkg.optionalDependencies?.[name]
}

export function includeTypes(config: { include?: unknown }, files: string[], defaults: string[]) {
  if (!('include' in config)) {
    config.include = [...files, ...defaults]
    return files
  }
  const include = config.include
  if (!Array.isArray(include)) return []
  const added = files.filter(file => !include.includes(file))
  include.push(...added)
  return added
}

// pnext's own files outside the app (a linked or store install) are named from the framework root,
// so a build moved to another machine finds them wherever pnext is installed there.
const frameworkRoot = path.resolve(import.meta.dirname, '..', '..')
const frameworkPrefix = 'pnext:'

/** Relativize only source-path fields while writing; build hooks keep absolute paths. */
export function serializeBuildManifest(data: BuildManifest): string {
  const { root, appDir, outDir } = data
  const relative = (file: string) => {
    const inRoot = toPosixPath(path.relative(root, file))
    if (!inRoot.startsWith('..')) return inRoot
    const inFramework = toPosixPath(path.relative(frameworkRoot, file))
    return inFramework.startsWith('..') ? inRoot : `${frameworkPrefix}${inFramework}`
  }
  const stored = {
    ...mapSourcePaths(data, relative),
    root: toPosixPath(path.relative(outDir, root)) || '.',
    appDir: toPosixPath(path.relative(root, appDir)),
    outDir: '.',
  }
  return `${JSON.stringify(stored, null, 2)}\n`
}

export function resolveManifest(data: BuildManifest, outPath: string, root: string): BuildManifest {
  if (path.isAbsolute(data.root)) return data
  const absolute = (file: string) =>
    file.startsWith(frameworkPrefix)
      ? path.join(frameworkRoot, file.slice(frameworkPrefix.length))
      : path.join(root, file)
  return {
    ...mapSourcePaths(data, absolute),
    root,
    appDir: absolute(data.appDir),
    outDir: outPath,
  }
}

const sourcePathFields = [
  'file',
  'sourceFiles',
  'cssImports',
  'templateFiles',
  'forbiddenFiles',
  'unauthorizedFiles',
  'slotDirs',
  'slotDir',
  'syntheticSlotDir',
  'childrenDefault',
  'serverActionFile',
  'globalErrorFile',
] as const

type SourcePathFields = Partial<Record<(typeof sourcePathFields)[number], string | string[]>>

function mapSourcePaths(data: BuildManifest, map: (file: string) => string): BuildManifest {
  // Only schema path owners are visited; params and user metadata remain data.
  function owner<T extends SourcePathFields | undefined>(value: T): T {
    if (!value) return value
    const mapped = { ...value }
    for (const key of sourcePathFields) {
      const field = value[key]
      if (field !== undefined) mapped[key] = Array.isArray(field) ? field.map(map) : map(field)
    }
    return mapped
  }
  const mapped = owner(data)
  mapped.routes = data.routes.map(route => ({
    ...owner(route),
    clientReferences: route.clientReferences.map(owner),
    ...(route.interception && { interception: owner(route.interception) }),
  }))
  if (data.staticMetadataFiles) mapped.staticMetadataFiles = data.staticMetadataFiles.map(owner)
  if (data.staticRouteMetadata) {
    mapped.staticRouteMetadata = Object.fromEntries(
      Object.entries(data.staticRouteMetadata).map(([route, entry]) => [
        route,
        {
          ...entry,
          favicon: owner(entry.favicon),
          manifest: owner(entry.manifest),
          icons: entry.icons.map(owner),
          appleIcons: entry.appleIcons.map(owner),
          rootIcons: entry.rootIcons.map(owner),
        },
      ]),
    )
  }
  if (data.staticModuleMetadata) {
    mapped.staticModuleMetadata = Object.fromEntries(
      Object.entries(data.staticModuleMetadata).map(([file, metadata]) => [map(file), metadata]),
    )
  }
  return mapped
}
