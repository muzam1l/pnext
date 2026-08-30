// Persisted client cache keys - the restart half of runtime/module-cache.ts. A route's client bundle
// already lives in a content-keyed out-dir, so a restart never has to rebuild it; deriving that key
// did, by walking every source the route's client graph reaches and hashing the bytes. The bytes
// cannot have moved while nothing was watching them *unless* the file did, so this persists the
// walk's result next to the artifacts it named and re-validates it with one stat per source.
//
// The same three-step ladder module-cache uses:
//   stat matches      -> reuse (the common case, and the only O(1) one)
//   stat moved        -> read + hash; equal content still reuses the key
//   content differs   -> full walk, new key, new out-dir
// so an edit made while the server was not running invalidates, and a touch that changed nothing
// does not.
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  clientCacheKeyParts,
  clientCacheStaticHash,
  clientSourceHash,
  type ClientCacheSource,
} from '../../client/build'
import type { ResolvedConfig } from '../../config'
import type { RouteManifestEntry } from '../../types'
import { writeFileAtomic } from '../../utils/fs'
import { restartCacheEnabled } from './enabled'

/** `[file, mtimeMs, size, contentHash]` — the same record shape the module index uses. */
type SourceEntry = [string, number, number, string]

interface RouteEntry {
  /** Hash of everything in the key that is not a walked source. */
  static: string
  key: string
  files: SourceEntry[]
}

interface IndexFile {
  version: number
  routes: Record<string, RouteEntry>
}

/** Bumped whenever a record's shape changes; an older index is simply ignored. */
const INDEX_VERSION = 1

interface KeyCache {
  file: string
  routes: Map<string, RouteEntry>
  dirty: boolean
  flush?: Timer
  retries: number
}

const caches = new Map<string, KeyCache>()

function keyCache(config: ResolvedConfig): KeyCache {
  const file = path.join(config.outPath, 'cache', 'client', 'keys.json')
  const existing = caches.get(file)
  if (existing) return existing
  const created: KeyCache = { file, routes: readIndex(file), dirty: false, retries: 0 }
  caches.set(file, created)
  // A short-lived process can exit before the debounce fires; without this its
  // walk would not survive to the next boot.
  process.on('exit', () => {
    if (!created.dirty) return
    created.dirty = false
    try {
      writeFileSync(created.file, serializeIndex(created.routes))
    } catch {
      // Best effort: a missing index only costs the next boot a walk.
    }
  })
  return created
}

/**
 * This route's client cache key, from the persisted walk when every source it
 * named still has the content it was named for, and from a fresh walk otherwise.
 */
export async function devClientCacheKey(
  config: ResolvedConfig,
  route: RouteManifestEntry,
  nextCompat: boolean,
): Promise<string> {
  if (!restartCacheEnabled()) return (await clientCacheKeyParts(route, nextCompat, config)).key
  const cache = keyCache(config)
  const staticHash = clientCacheStaticHash(route, nextCompat, config)
  const entry = cache.routes.get(route.id)
  if (entry?.static === staticHash) {
    const revalidated = await revalidate(entry.files)
    if (revalidated) {
      // Only the stats moved (a touch, a checkout): keep the key, record the
      // new stats so the next boot takes the O(1) path again.
      if (revalidated !== entry.files) {
        cache.routes.set(route.id, { ...entry, files: revalidated })
        persist(cache)
      }
      return entry.key
    }
  }

  const parts = await clientCacheKeyParts(route, nextCompat, config, staticHash)
  cache.routes.set(route.id, {
    static: parts.staticHash,
    key: parts.key,
    files: parts.sources.map(sourceEntry),
  })
  persist(cache)
  return parts.key
}

function sourceEntry(source: ClientCacheSource): SourceEntry {
  return [source.file, source.mtimeMs, source.size, source.hash]
}

/**
 * The recorded sources, re-stated: `files` itself when nothing moved, a fresh list when only stats moved,
 * `undefined` when any content actually differs - or a source is gone, which is the same thing, since the
 * walk has to run again.
 */
async function revalidate(files: SourceEntry[]): Promise<SourceEntry[] | undefined> {
  let moved = false
  const checked = await Promise.all(
    files.map(async (entry): Promise<SourceEntry | undefined> => {
      const [file, mtimeMs, size, hash] = entry
      const stats = await stat(file).catch(() => undefined)
      if (!stats) return undefined
      if (stats.mtimeMs === mtimeMs && stats.size === size) return entry
      const source = await readFile(file, 'utf8').catch(() => undefined)
      if (source === undefined || clientSourceHash(source) !== hash) return undefined
      moved = true
      return [file, stats.mtimeMs, stats.size, hash]
    }),
  )
  if (checked.some(entry => entry === undefined)) return undefined
  return moved ? (checked as SourceEntry[]) : files
}

function persist(cache: KeyCache) {
  cache.dirty = true
  if (cache.flush) return
  cache.flush = setTimeout(async () => {
    cache.flush = undefined
    if (!cache.dirty) return
    const contents = serializeIndex(cache.routes)
    try {
      await mkdir(path.dirname(cache.file), { recursive: true })
      await writeFileAtomic(cache.file, contents)
      cache.dirty = false
    } catch {
      // A write that lost a race with a cache wipe must not look persisted.
      if (++cache.retries < 3) persist(cache)
    }
  }, 50)
  // The index is a pure optimization; never hold the process open for it.
  cache.flush.unref?.()
}

function readIndex(file: string) {
  const routes = new Map<string, RouteEntry>()
  let parsed: IndexFile | undefined
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as IndexFile
  } catch {
    return routes
  }
  if (parsed?.version !== INDEX_VERSION) return routes
  for (const [id, entry] of Object.entries(parsed.routes ?? {})) {
    if (entry?.key && entry.static && Array.isArray(entry.files)) routes.set(id, entry)
  }
  return routes
}

function serializeIndex(routes: Map<string, RouteEntry>) {
  return JSON.stringify({
    version: INDEX_VERSION,
    routes: Object.fromEntries(routes),
  } satisfies IndexFile)
}
