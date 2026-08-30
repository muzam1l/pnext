// Persisted route-bundle names - the restart half of runtime/modules.ts' devRouteBundlePath. A route's
// bundle already lives at a content-addressed path, so a restart never has to rebuild it; deriving
// that path did, by walking the whole source graph of the route and its layouts breadth-first, with
// a stat round trip per level, on the first page of every restart. The sources cannot have moved
// while nothing was watching them *unless* the file did, so this persists the walk's answer and
// re-validates it with one flat stat per source.
//
// The same three-step ladder dev/restart/client-key.ts and dev/restart/route-facts.ts use:
//   stat matches      -> reuse (the common case, and the only O(1) one)
//   stat moved        -> read + hash; equal content still reuses the path
//   content differs   -> discard, walk again, record the new answer
// A missing source is a miss too, which is what keeps a deleted file from naming an artifact whose
// edges are gone.
//
// One file PER ROUTE, not one index, for the reason restart/route-facts.ts records: the source lists are
// large across the whole table and the first page only ever asks about the route it is serving.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { ResolvedConfig } from '../../config'
import {
  DEV_SOURCE_MISSING,
  devTextSourceHash,
  isBinaryDevSource,
  type DevGraphSource,
} from '../../runtime/module-cache'
import { restartCacheEnabled } from './enabled'

interface RecordFile {
  version: number
  /** Hash of everything in the name that is not a walked source (see recordKey). */
  key: string
  /** The named bundle path itself — the whole point of the record. */
  bundle: string
  files: DevGraphSource[]
}

/** Bumped whenever a record's shape changes; an older record is simply ignored. */
const RECORD_VERSION = 1

const hash = (value: string) => Bun.hash(value).toString(36)

/** Records written this process (by record file), so a repeat naming does not re-serialize. */
const written = new Map<string, string>()

function enabled() {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  return restartCacheEnabled() && process.env.PNEXT_DEV_BUNDLE_KEY_CACHE !== '0'
}

function recordFile(config: ResolvedConfig, routeId: string) {
  return path.join(config.outPath, 'cache', 'route-bundles', `${hash(routeId)}.json`)
}

/**
 * The entry files and the graph's own key (compat, aliases, the pnext build
 * itself) decide the name as much as the sources do, so either one moving makes
 * the record read as a miss instead of half-validating it.
 */
function recordKey(graphKey: string, files: string[]) {
  return hash(`${RECORD_VERSION}\n${graphKey}\n${files.join('\0')}`)
}

/** The persisted bundle path when every source it was named for is unchanged. */
export async function cachedRouteBundlePath(
  config: ResolvedConfig,
  routeId: string,
  graphKey: string,
  files: string[],
): Promise<string | undefined> {
  if (!enabled()) return undefined
  const key = recordKey(graphKey, files)
  let record: RecordFile | undefined
  try {
    record = JSON.parse(readFileSync(recordFile(config, routeId), 'utf8')) as RecordFile
  } catch {
    return undefined
  }
  if (record?.version !== RECORD_VERSION || record.key !== key) return undefined
  if (typeof record.bundle !== 'string' || !Array.isArray(record.files)) return undefined
  const revalidated = await revalidate(record.files)
  if (!revalidated) return undefined
  // Only the stats moved (a touch, a checkout): keep the name, record the new
  // stats so the next boot takes the O(1) path again.
  if (revalidated !== record.files) {
    written.delete(recordFile(config, routeId))
    write(config, routeId, key, record.bundle, revalidated)
  }
  return record.bundle
}

export function saveRouteBundlePath(
  config: ResolvedConfig,
  routeId: string,
  graphKey: string,
  files: string[],
  bundle: string,
  sources: DevGraphSource[],
): void {
  if (!enabled()) return
  // A source the walk could not read describes a tree that no longer exists;
  // the next boot walking again is the safe answer.
  if (sources.some(([, , , srcHash]) => srcHash === DEV_SOURCE_MISSING)) return
  write(config, routeId, recordKey(graphKey, files), bundle, sources)
}

function write(
  config: ResolvedConfig,
  routeId: string,
  key: string,
  bundle: string,
  files: DevGraphSource[],
) {
  const file = recordFile(config, routeId)
  if (written.get(file) === bundle) return
  written.set(file, bundle)
  const contents = JSON.stringify({
    version: RECORD_VERSION,
    key,
    bundle,
    files,
  } satisfies RecordFile)
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, contents)
  } catch {
    // Best effort: a missing record only costs the next boot a walk.
  }
}

/**
 * The recorded sources, re-stated: `files` itself when nothing moved, a fresh list when only stats moved,
 * `undefined` when any content actually differs - or a source is gone, which is the same thing, since the
 * walk has to run again.
 */
async function revalidate(files: DevGraphSource[]): Promise<DevGraphSource[] | undefined> {
  let moved = false
  const checked = await Promise.all(
    files.map(async (entry): Promise<DevGraphSource | undefined> => {
      const [file, mtimeMs, size, srcHash] = entry
      const stats = await stat(file).catch(() => undefined)
      if (!stats) return undefined
      if (stats.mtimeMs === mtimeMs && stats.size === size) return entry
      // A binary source is hashed from its stat, so a moved stat IS a new hash.
      if (isBinaryDevSource(file)) return undefined
      const source = await readFile(file, 'utf8').catch(() => undefined)
      if (source === undefined || devTextSourceHash(source) !== srcHash) return undefined
      moved = true
      return [file, stats.mtimeMs, stats.size, srcHash]
    }),
  )
  if (checked.some(entry => entry === undefined)) return undefined
  return moved ? (checked as DevGraphSource[]) : files
}
