import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
