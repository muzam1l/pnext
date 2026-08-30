// Persisted global-CSS source list - the restart half of css/build.ts' walk.
// `globalCssSourcesForPaths` answers "which stylesheets does the ROOT LAYOUT's import graph pull
// in", and it answers by reading and resolving that whole graph synchronously, twice over on the
// first page: the warm tier builds global.css and the render asks `globalCssHref` whether there is
// any.
//
// The same three-step ladder restart/route-facts.ts uses:
//   stat matches      -> reuse (the common case, and the only O(1) one)
//   stat moved        -> read + hash; equal content still reuses the answer
//   content differs   -> discard, walk again, record the new answer
// Paths the walk found ABSENT are re-checked too: a stylesheet restored while the server was not
// running adds an edge that no importer's bytes record.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ResolvedConfig } from '../../config'
import { setGlobalCssSourceStore, type GlobalCssSourceStore } from '../../css/build'
import { traceEnabled } from '../../utils/trace-flags'
import { restartCacheEnabled } from './enabled'
import { hash, lazyRecordCacheKey, revalidate, sourceEntries, type SourceEntry } from './record'

interface RecordFile {
  version: number
  /** Everything the answer depends on that is not a walked source (see restart/record.ts). */
  key: string
  files: SourceEntry[]
  missing: string[]
  sources: string[]
}

/** Bumped whenever a record's shape changes; an older record is simply ignored. */
const RECORD_VERSION = 1

export function installGlobalCssCache(config: ResolvedConfig) {
  if (!restartCacheEnabled()) return
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  if (process.env.PNEXT_DEV_GLOBAL_CSS_CACHE === '0') return
  const dir = path.join(config.outPath, 'cache', 'global-css')
  setGlobalCssSourceStore(createStore(dir, lazyRecordCacheKey(config, RECORD_VERSION)))
}

function createStore(dir: string, cacheKey: () => string | undefined): GlobalCssSourceStore {
  // Last payload written per walk, so a save that re-runs the walk with an
  // unchanged answer costs no write, and one with a changed answer does.
  const written = new Map<string, string>()
  const recordFile = (walkKey: string) => path.join(dir, `${hash(walkKey)}.json`)

  return {
    load(walkKey) {
      // A config that will not serialize has no key, so it simply always walks.
      const key = cacheKey()
      const record = key ? readRecord(recordFile(walkKey), key) : undefined
      if (!key || !record) {
        stats.misses += 1
        return undefined
      }
      if (record.missing.some(file => existsSync(file))) {
        stats.misses += 1
        return undefined
      }
      const revalidated = revalidate(record.files)
      if (!revalidated) {
        stats.misses += 1
        return undefined
      }
      stats.hits += 1
      // Only the stats moved (a touch, a checkout): keep the answer, record the
      // new stats so the next boot takes the O(1) path again.
      if (revalidated !== record.files) {
        write(
          recordFile(walkKey),
          key,
          written,
          walkKey,
          revalidated,
          record.missing,
          record.sources,
        )
      }
      return record.sources
    },
    save(walkKey, sources, visited, missing) {
      const key = cacheKey()
      if (!key) return
      const files = sourceEntries(visited)
      if (!files) return
      write(recordFile(walkKey), key, written, walkKey, files, missing, sources)
    },
  }
}

function readRecord(file: string, key: string): RecordFile | undefined {
  let parsed: RecordFile | undefined
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as RecordFile
  } catch {
    return undefined
  }
  if (parsed?.version !== RECORD_VERSION || parsed.key !== key) return undefined
  if (!Array.isArray(parsed.files) || !Array.isArray(parsed.sources)) return undefined
  if (!Array.isArray(parsed.missing)) return undefined
  return parsed
}

/**
 * Written from a synchronous getter, so the write is synchronous too - a debounce would have to
 * survive an exit the walk's caller never awaits. One small file, written once per process.
 */
function write(
  file: string,
  key: string,
  written: Map<string, string>,
  walkKey: string,
  files: SourceEntry[],
  missing: string[],
  sources: string[],
) {
  const contents = JSON.stringify({
    version: RECORD_VERSION,
    key,
    files,
    missing,
    sources,
  } satisfies RecordFile)
  if (written.get(walkKey) === contents) return
  written.set(walkKey, contents)
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, contents)
  } catch {
    // Best effort: a missing record only costs the next boot a walk.
  }
}

/** Bisect seam: `PNEXT_TRACE=server` prints the hit/miss split at exit. */
const stats = { hits: 0, misses: 0 }
if (traceEnabled('server')) {
  process.on('exit', () => console.log(`global-css hits=${stats.hits} misses=${stats.misses}`))
}
