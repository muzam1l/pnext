// Persisted route facts - the restart half of routing/routes.ts' deferred scan. A route's facts
// (mode, segment config, client references, css imports, the source list) are derived by reading
// and sniffing every source the route's graph reaches, and that lands on the first page of every
// restart - the otel root interceptor alone forces it to decide one span attribute. The sources
// cannot have moved while nothing was watching them *unless* the file did, so this persists the
// walk's result next to the compiled cache and re-validates it with one stat per source.
//
// The same three-step ladder dev/restart/client-key.ts uses:
//   stat matches      -> reuse (the common case, and the only O(1) one)
//   stat moved        -> read + hash; equal content still reuses the facts
//   content differs   -> discard, walk again, record the new facts
//
// One file PER ROUTE, not one index: the whole table is large and the first page only ever asks
// about the route it is serving, so as a single index its JSON.parse landed, in full, on that
// request and gave most of the walk back.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ResolvedConfig } from '../../config'
import { setRouteFactsStore, type RouteFacts, type RouteFactsStore } from '../../routing/routes'
import { traceEnabled } from '../../utils/trace-flags'
import { restartCacheEnabled } from './enabled'
import { hash, lazyRecordCacheKey, revalidate, sourceEntry, type SourceEntry } from './record'

interface RecordFile {
  version: number
  /** Everything the facts depend on that is not a walked source (see restart/record.ts). */
  key: string
  files: SourceEntry[]
  facts: RouteFacts
}

/** Bumped whenever a record's shape changes; an older record is simply ignored. */
const RECORD_VERSION = 1

interface FactsCache {
  dir: string
  /** Resolved on first use, not at install; see restart/record.ts. */
  key: () => string | undefined
  /** Records written this process, so a repeat save does not re-serialize. */
  written: Set<string>
}

export function installRouteFactsCache(config: ResolvedConfig) {
  if (!restartCacheEnabled()) return
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  if (process.env.PNEXT_DEV_FACTS_CACHE === '0') return
  const cache: FactsCache = {
    dir: path.join(config.outPath, 'cache', 'route-facts'),
    key: lazyRecordCacheKey(config, RECORD_VERSION),
    written: new Set(),
  }
  setRouteFactsStore(createStore(cache))
}

function recordFile(cache: FactsCache, routeId: string) {
  return path.join(cache.dir, `${hash(routeId)}.json`)
}

function createStore(cache: FactsCache): RouteFactsStore {
  return {
    load(routeId) {
      const record = readRecord(cache, routeId)
      if (!record) {
        stats.misses += 1
        return undefined
      }
      const revalidated = revalidate(record.files)
      if (!revalidated) {
        stats.misses += 1
        return undefined
      }
      stats.hits += 1
      // Only the stats moved (a touch, a checkout): keep the facts, record the
      // new stats so the next boot takes the O(1) path again.
      if (revalidated !== record.files) {
        cache.written.delete(routeId)
        write(cache, routeId, revalidated, record.facts)
      }
      return record.facts
    },
    save(routeId, facts) {
      const files = factsSources(facts)
      if (!files) return
      write(cache, routeId, files, facts)
    },
  }
}

function readRecord(cache: FactsCache, routeId: string): RecordFile | undefined {
  let parsed: RecordFile | undefined
  try {
    parsed = JSON.parse(readFileSync(recordFile(cache, routeId), 'utf8')) as RecordFile
  } catch {
    return undefined
  }
  if (parsed?.version !== RECORD_VERSION || parsed.key !== cache.key()) return undefined
  if (!parsed.facts || !Array.isArray(parsed.files)) return undefined
  return parsed
}

/**
 * Records are written from a synchronous getter, so the write is synchronous too - a debounce would
 * have to survive an exit that the walk's caller never awaits. Each is a single small file, written
 * once per process per route.
 */
function write(cache: FactsCache, routeId: string, files: SourceEntry[], facts: RouteFacts) {
  const key = cache.key()
  // A config that will not serialize has no key, so nothing is recorded for it.
  if (!key || cache.written.has(routeId)) return
  cache.written.add(routeId)
  const contents = JSON.stringify({
    version: RECORD_VERSION,
    key,
    files,
    facts,
  } satisfies RecordFile)
  try {
    mkdirSync(cache.dir, { recursive: true })
    writeFileSync(recordFile(cache, routeId), contents)
  } catch {
    // Best effort: a missing record only costs the next boot a walk.
  }
}

/**
 * Stat and hash every source the walk read. A file that cannot be read at all means the record would
 * describe a tree that no longer exists, so nothing is written - the next boot walks, which is the safe
 * answer.
 */
function factsSources(facts: RouteFacts): SourceEntry[] | undefined {
  const entries: SourceEntry[] = []
  for (const file of facts.sourceFiles) {
    const entry = sourceEntry(file)
    if (!entry) return undefined
    entries.push(entry)
  }
  return entries
}

/** Bisect seam: `PNEXT_TRACE=server` prints the hit/miss split at exit. */
const stats = { hits: 0, misses: 0 }
if (traceEnabled('server')) {
  process.on('exit', () => console.log(`route-facts hits=${stats.hits} misses=${stats.misses}`))
}
