// Content-addressed naming and O(1) validity for dev's compiled server modules.
//
// An artifact's name carries a hash of its own source AND of every source reachable from it, so an edit
// renames exactly the edited file and the modules that import it transitively - everything else keeps its
// name, stays on disk, and is neither recompiled nor re-imported. Staleness is therefore a cache miss,
// never a stale hit, which is what lets the cache survive both restarts and saves.
//
// The graph the hash walks is read from a persisted index keyed by (mtime, size, content hash), so a
// restart re-derives it with one stat per source instead of re-scanning and re-resolving every import.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { cachedExistsSync } from '../utils/fs-cache'
import { frameworkFingerprint } from './fingerprint'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ResolvedConfig } from '../config'
import { writeFileAtomic } from '../utils/fs'
import { traceEnabled } from '../utils/trace-flags'

/**
 * Kill switch for the request-head trims: the naming walk's synchronous source
 * reads and the layer recorded alongside a source's edges.
 */
export function devHeadTrimEnabled(): boolean {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  return process.env.PNEXT_HEAD_TRIM !== '0'
}

// While a recursive fs watcher is reporting every save, the memoized graph is
// authoritative and a warm request needs no per-module re-stat; the dev server
// marks its outPath once its watch roots are up and clears it if any root
// fails. Per cache root, so other processes' caches (tests, one-off renders)
// keep the stat-based freshness they rely on.
// Bisect seam: PNEXT_DEV_WATCH_FRESHNESS=0 restores the per-request re-stat.
const watcherFreshRoots = new Set<string>()

export function setDevWatcherFreshness(outPath: string, trusted: boolean) {
  if (trusted) watcherFreshRoots.add(cacheRoot(outPath))
  else watcherFreshRoots.delete(cacheRoot(outPath))
}

function watcherFreshnessTrusted(root: string) {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  return watcherFreshRoots.has(root) && process.env.PNEXT_DEV_WATCH_FRESHNESS !== '0'
}

/** Files whose bytes are not source: hashed from stat, never read or scanned. */
const BINARY_SOURCE = /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp[34]|webm|pdf)$/i

const MISSING = 'missing'

// The framework's own package root. Compat runtime modules (next/form and
// friends) are compiled like app sources but live outside the workspace, so
// they need their own relocation anchor.
const frameworkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * A source's identity for hashing and for the persisted index - relative to the workspace (or the
 * framework) rather than absolute. Absolute paths made every artifact name a function of *where the
 * project sat* on disk: invisible in dev, and fatal for a deployed build, where the vercel adapter
 * ships the compiled cache and the function replays it from the serverless runtime root, so every
 * recomputed name differed, the whole cache missed, and the runtime recompiled the app on the first
 * request against a read-only filesystem.
 */
// Two `path.relative` calls per source per lookup, and every graph hash asks for its whole closure.
// The answer is a pure function of the pair and the set of sources is bounded by the app, so it is
// simply remembered.
const portablePaths = new Map<string, string>()
// Same bisect seam as the naming walk it serves (PNEXT_DEV_GRAPH_FAST=0).
// eslint-disable-next-line turbo/no-undeclared-env-vars
const memoPortablePaths = process.env.PNEXT_DEV_GRAPH_FAST !== '0'

function portableSourcePath(file: string, workspaceRoot: string) {
  if (!memoPortablePaths) return computePortableSourcePath(file, workspaceRoot)
  const memoKey = `${workspaceRoot}\0${file}`
  const memoized = portablePaths.get(memoKey)
  if (memoized !== undefined) return memoized
  const computed = computePortableSourcePath(file, workspaceRoot)
  portablePaths.set(memoKey, computed)
  return computed
}

function computePortableSourcePath(file: string, workspaceRoot: string) {
  const inWorkspace = path.relative(workspaceRoot, file)
  if (inWorkspace && !inWorkspace.startsWith('..') && !path.isAbsolute(inWorkspace)) {
    return `w:${toPosix(inWorkspace)}`
  }
  const inFramework = path.relative(frameworkRoot, file)
  if (inFramework && !inFramework.startsWith('..') && !path.isAbsolute(inFramework)) {
    return `f:${toPosix(inFramework)}`
  }
  return `a:${toPosix(file)}`
}

/** Inverse of `portableSourcePath` for the roots this process is running under. */
function absoluteSourcePath(key: string, workspaceRoot: string) {
  const value = key.slice(2).split('/').join(path.sep)
  if (key.startsWith('w:')) return path.resolve(workspaceRoot, value)
  if (key.startsWith('f:')) return path.resolve(frameworkRoot, value)
  return value
}

const toPosix = (file: string) => (path.sep === '/' ? file : file.split(path.sep).join('/'))

/** Stable identity for a source outside the dev cache — see `portableSourcePath`. */
export function devSourceIdentity(file: string, workspaceRoot: string) {
  return portableSourcePath(file, workspaceRoot)
}

interface SourceRecord {
  mtimeMs: number
  size: number
  /** Content hash (stat hash for binaries, `missing` when the file is gone). */
  srcHash: string
  /** Resolved local import targets — the same edges the compile walk follows. */
  imports: string[]
  /** Bare package specifiers, so a route's vendor demand is known before it compiles. */
  packages: string[]
  /** Whether the source opens with `'use client'` — the layer boundary, recorded by the scan. */
  client: boolean
}

export interface DevModuleCacheOptions {
  /** Local import targets, package specifiers and layer of `source`, as the compile walk sees them. */
  edges: (
    file: string,
    source: string,
  ) => { imports: string[]; packages: string[]; client: boolean }
  /** Everything outside the sources that changes output: aliases, defines, compat. */
  compileKey: string
}

/** `[file, mtimeMs, size, srcHash]` — one indexed source, as callers revalidate it. */
export type DevGraphSource = [string, number, number, string]

/** `srcHash` for a source outside the index — `missing` when it cannot be read. */
export const DEV_SOURCE_MISSING = MISSING

/** Files whose `srcHash` comes from stat rather than content (see BINARY_SOURCE). */
export function isBinaryDevSource(file: string): boolean {
  return BINARY_SOURCE.test(file)
}

/** The `srcHash` rule for a text source, for caches revalidating indexed records. */
export function devTextSourceHash(source: string): string {
  return Bun.hash(source).toString(36)
}

export interface DevModuleCache {
  /** Hash naming `file`'s artifact: its own source plus its whole source graph. */
  graphHash(file: string): Promise<string>
  /** Everything the last `graphHash` of these files walked, as indexed records. */
  graphSources(files: string[]): Promise<DevGraphSource[]>
  /** Everything outside the sources that names an artifact — compat, aliases, pnext itself. */
  readonly graphKey: string
  /** Forget the given sources and every module that reaches them (its dependents). */
  invalidate(files: Iterable<string>): void
  /** Whether this source is already part of the compiled graph. */
  knows(file: string): boolean
  /**
   * Whether this source opens with `'use client'`, from the record the walk already scanned - the
   * layer-aware seed used to re-read and re-scan every source of the route to learn the same thing, on the
   * request the response is blocked on.
   */
  isClientSource(file: string): Promise<boolean>
  /**
   * Every package specifier reachable from `file` - the route's vendor demand. With `prune`, a SEPARATE
   * non-memoized walk that skips pruned files and their subtrees (layer-aware seeding); `closure()` keeps
   * its superset for invalidation.
   */
  packageDemand(
    file: string,
    prune?: (file: string) => boolean | Promise<boolean>,
  ): Promise<string[]>
  /**
   * Freeze names for the duration of one compile pass: each source is re-checked once when the pass first
   * touches it, never again while it runs. A hash that moved mid-pass would let a module bake an import
   * href its target is then never written to - a dangling import Bun caches for the life of the process.
   */
  hold(): () => void
  /** Directory the compiled artifacts live in. */
  readonly root: string
}

const caches = new Map<string, DevModuleCache>()
const persistFlushes = new Set<() => void>()

/** Write every cache's pending graph.json now. A finished build must leave no unref'd timer renaming temp files under .pnext. */
export function flushDevModuleCaches() {
  for (const flushNow of persistFlushes) flushNow()
}

/** The cache for `config.outPath`, created once per process. */
export function devModuleCache(
  config: ResolvedConfig,
  options: DevModuleCacheOptions,
): DevModuleCache {
  const root = cacheRoot(config.outPath)
  const existing = caches.get(root)
  if (existing) return existing
  const created = createDevModuleCache(root, config.workspaceRoot, options)
  caches.set(root, created)
  return created
}

export function cacheRoot(outPath: string) {
  return path.join(outPath, 'cache', 'server')
}

function createDevModuleCache(
  root: string,
  workspaceRoot: string,
  options: DevModuleCacheOptions,
): DevModuleCache {
  const indexFile = path.join(root, 'graph.json')
  // Compiler-generated sources — pnext's own output tree and the materialized
  // pages-compat app — are rewritten from scratch on every boot and can land at
  // a fresh path each time; they are hashed by content alone (below).
  const outRoot = `${path.dirname(path.dirname(root))}${path.sep}`
  const generated = (file: string) =>
    file.startsWith(outRoot) || file.includes(`${path.sep}pnext-pages-compat${path.sep}`)
  const key = createHash('sha256')
    .update(`${options.compileKey}\0${frameworkFingerprint(root)}`)
    .digest('hex')
    .slice(0, 16)
  establishCacheTrust(root)
  const records = indexRecords(readIndexFile(indexFile), key, workspaceRoot)
  // PNEXT_TRACE=server names every source whose hash differs from the one
  // the last boot persisted — i.e. exactly why an artifact was renamed and
  // recompiled instead of reused.
  const booted =
    traceEnabled('server') && records.size > 0
      ? new Map([...records].map(([file, record]) => [file, record.srcHash] as const))
      : undefined
  const pending = new Map<string, Promise<SourceRecord>>()
  // Records already re-checked in the current pass - what `hold()` promises ("re-checked once when
  // the pass first touches it, never again while it runs") and what `pending` alone does not
  // deliver: it drops each entry the moment the stat settles, so naming a route re-stat'ed its whole
  // closure once for the reachable-set walk and again for the hash.
  // Bisect seam: `PNEXT_DEV_GRAPH_FAST=0` restores the previous cost model - re-stat every touch,
  // one module per turn, no path memo.
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const graphFast = process.env.PNEXT_DEV_GRAPH_FAST !== '0'
  const settledThisPass = new Map<string, Promise<SourceRecord>>()
  const refreshedThisPass = new Set<string>()
  let passes = 0
  const closures = new Map<string, Set<string>>()
  const hashes = new Map<string, Promise<string>>()
  let dirty = false
  let flush: Timer | undefined
  let retries = 0

  function persist() {
    if (flush) return
    flush = setTimeout(async () => {
      flush = undefined
      if (!dirty) return
      const contents = serializeIndex(key, records, workspaceRoot)
      try {
        await mkdir(root, { recursive: true })
        await writeFileAtomic(indexFile, contents)
        dirty = false
      } catch {
        // A write that lost a race with a cache wipe must not look like a
        // persisted index: keep `dirty` and try again a couple of times.
        if (++retries < 3) persist()
      }
    }, 50)
    // The index is a pure optimization; never hold the process open for it.
    flush.unref?.()
  }

  // A short-lived process (a one-off compile, a build) can exit before the
  // debounce fires; without this its work would not survive to the next boot.
  // Also runnable on demand: a build must not leave the unref'd timer racing
  // whoever copies or walks .pnext right after it returns (see flushDevModuleCaches).
  function flushPersistNow() {
    if (flush) {
      clearTimeout(flush)
      flush = undefined
    }
    if (!dirty) return
    dirty = false
    try {
      writeFileSync(indexFile, serializeIndex(key, records, workspaceRoot))
    } catch {
      // Best effort: a missing index only costs the next boot a rescan.
    }
  }
  persistFlushes.add(flushPersistNow)
  process.on('exit', flushPersistNow)

  async function sourceRecord(file: string): Promise<SourceRecord> {
    const inflight =
      pending.get(file) ?? (graphFast && passes > 0 ? settledThisPass.get(file) : undefined)
    if (inflight) return inflight
    const previous = records.get(file)
    const next = readSourceRecord(file, previous, options.edges).then(record => {
      pending.delete(file)
      if (record === previous) return record
      records.set(file, record)
      dirty = true
      persist()
      return record
    })
    pending.set(file, next)
    if (graphFast && passes > 0) settledThisPass.set(file, next)
    return next
  }

  /**
   * Re-stat a memoized closure before trusting it. The watcher normally reports
   * a save first, but it is best-effort (recursive watch is not available
   * everywhere), and the disk is the only authority on what a module contains.
   */
  async function refresh(file: string) {
    if (watcherFreshnessTrusted(root)) return
    const reachable = closures.get(file)
    if (!reachable) return
    if (passes > 0 && refreshedThisPass.has(file)) return
    refreshedThisPass.add(file)
    const changed: string[] = []
    await Promise.all(
      [...reachable].map(async source => {
        const previous = records.get(source)
        const record = await sourceRecord(source)
        if (previous?.srcHash !== record.srcHash) changed.push(source)
      }),
    )
    if (changed.length > 0) forget(changed)
  }

  /** Drop the memoized graph of every module that reaches one of `changed`. */
  function forget(changed: string[]) {
    for (const [source, reachable] of closures) {
      if (!changed.some(target => reachable.has(target))) continue
      closures.delete(source)
      hashes.delete(source)
    }
  }

  /** The pre-batching walk and hash gather, kept behind PNEXT_DEV_GRAPH_FAST=0. */
  async function serialFrontier(frontier: string[], file: string) {
    const reached: { expand: boolean; targets: Iterable<string> }[] = []
    for (const current of frontier) {
      const known = current === file ? undefined : closures.get(current)
      reached.push(
        known
          ? { expand: false, targets: known as Iterable<string> }
          : { expand: true, targets: (await sourceRecord(current)).imports },
      )
    }
    return reached
  }

  async function serialRecords(reachable: string[]) {
    const records: SourceRecord[] = []
    for (const source of reachable) records.push(await sourceRecord(source))
    return records
  }

  /** Every source reachable from `file`, itself included. Cycle-safe by construction. */
  async function closure(file: string): Promise<Set<string>> {
    const cached = closures.get(file)
    if (cached) return cached
    const seen = new Set<string>([file])
    // A whole frontier per turn, not one module per turn: the walk is pure I/O latency (one stat per
    // module), so taking it in series turns a route graph into that many sequential round trips, on
    // the request the response is blocked on.
    let frontier = [file]
    while (frontier.length > 0) {
      const reached = graphFast
        ? await Promise.all(
            frontier.map(async current => {
              // A complete reachable set stays complete however it was reached, so a
              // memoized child is merged instead of re-expanded.
              const known = current === file ? undefined : closures.get(current)
              return known
                ? { expand: false, targets: known as Iterable<string> }
                : { expand: true, targets: (await sourceRecord(current)).imports }
            }),
          )
        : await serialFrontier(frontier, file)
      const next: string[] = []
      for (const { expand, targets } of reached) {
        for (const target of targets) {
          if (seen.has(target)) continue
          seen.add(target)
          if (expand) next.push(target)
        }
      }
      frontier = next
    }
    closures.set(file, seen)
    return seen
  }

  async function computeGraphHash(file: string) {
    const reachable = [...(await closure(file))].sort()
    // Same reason as the walk above: gather every record first, then fold them
    // in sorted order, instead of one awaited stat between each hash update.
    const records: SourceRecord[] = graphFast
      ? await Promise.all(reachable.map(source => sourceRecord(source)))
      : await serialRecords(reachable)
    const hash = createHash('sha256').update(key).update('\0')
    const moved: string[] = []
    for (const [index, source] of reachable.entries()) {
      const record = records[index]!
      // A generated module (materialized pages wrapper, bundled config) can
      // live at a path that changes between boots while its content does not;
      // naming it by content alone keeps its dependents' names stable.
      hash.update(generated(source) ? '' : portableSourcePath(source, workspaceRoot))
      hash.update('\0')
      hash.update(record.srcHash)
      hash.update('\0')
      if (booted && booted.get(source) !== record.srcHash) moved.push(source)
    }
    if (booted && moved.length > 0) {
      console.log(
        `dev-cache ${path.basename(file)} renamed: ${moved.length} source(s) differ from the persisted graph\n  ${moved
          .slice(0, 10)
          .join('\n  ')}`,
      )
    }
    return hash.digest('hex').slice(0, 16)
  }

  return {
    root,
    graphKey: key,
    async graphSources(files) {
      const reachable = new Set<string>()
      for (const file of files)
        for (const source of await closure(path.resolve(file))) reachable.add(source)
      return Promise.all(
        [...reachable].sort().map(async (source): Promise<DevGraphSource> => {
          const record = await sourceRecord(source)
          return [source, record.mtimeMs, record.size, record.srcHash]
        }),
      )
    },
    async graphHash(file) {
      const resolved = path.resolve(file)
      await refresh(resolved)
      const existing = hashes.get(resolved)
      if (existing) return existing
      const next = computeGraphHash(resolved).catch(error => {
        hashes.delete(resolved)
        throw error
      })
      hashes.set(resolved, next)
      return next
    },
    knows(file) {
      return records.has(path.resolve(file))
    },
    async isClientSource(file) {
      return (await sourceRecord(path.resolve(file))).client
    },
    async packageDemand(file, prune) {
      const resolved = path.resolve(file)
      const demand = new Set<string>()
      if (!prune) {
        for (const source of await closure(resolved)) {
          for (const name of (await sourceRecord(source)).packages) demand.add(name)
        }
        return [...demand]
      }
      const seen = new Set<string>([resolved])
      let frontier = [resolved]
      while (frontier.length > 0) {
        const kept = (
          await Promise.all(
            frontier.map(async source => ((await prune(source)) ? undefined : source)),
          )
        ).filter((source): source is string => source !== undefined)
        const reached = await Promise.all(kept.map(source => sourceRecord(source)))
        const next: string[] = []
        for (const record of reached) {
          for (const name of record.packages) demand.add(name)
          for (const target of record.imports) {
            if (seen.has(target)) continue
            seen.add(target)
            next.push(target)
          }
        }
        frontier = next
      }
      return [...demand]
    },
    hold() {
      if (passes++ === 0) {
        refreshedThisPass.clear()
        settledThisPass.clear()
      }
      let released = false
      return () => {
        if (released) return
        released = true
        // Outside a pass the disk is the only authority again, so nothing may
        // survive the last release.
        if (--passes === 0) settledThisPass.clear()
      }
    },
    invalidate(files) {
      const changed = new Set([...files].map(file => path.resolve(file)))
      if (changed.size === 0) return
      for (const file of changed) {
        records.delete(file)
        pending.delete(file)
        // A save lands mid-pass often enough to matter: the pass must not go on
        // reusing the record the watcher just invalidated.
        settledThisPass.delete(file)
        dirty = true
      }
      // Dependents are exactly the modules whose reachable set holds a changed
      // file: drop their memoized graph, keep every unrelated module's.
      forget([...changed])
      persist()
    },
  }
}

const missingRecord = (): SourceRecord => ({
  mtimeMs: 0,
  size: 0,
  srcHash: MISSING,
  imports: [],
  packages: [],
  client: false,
})

// Sync reads skip the fs thread-pool queue the vendor preloads own - the walk is cheap standing
// alone but slow once queued behind them.
async function readSourceRecord(
  file: string,
  previous: SourceRecord | undefined,
  edges: DevModuleCacheOptions['edges'],
): Promise<SourceRecord> {
  const sync = devHeadTrimEnabled()
  const stats = sync
    ? (() => {
        try {
          return statSync(file)
        } catch {
          return undefined
        }
      })()
    : await stat(file).catch(() => undefined)
  if (!stats) return missingRecord()
  // Fast path: an untouched file keeps the indexed hash and edge list, so a
  // restart pays one stat per source instead of a read + scan + resolve.
  if (previous?.mtimeMs === stats.mtimeMs && previous.size === stats.size) {
    return previous
  }
  if (isBinaryDevSource(file)) {
    return {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      srcHash: `b${stats.size.toString(36)}.${Math.round(stats.mtimeMs).toString(36)}`,
      imports: [],
      packages: [],
      client: false,
    }
  }
  const source = sync
    ? (() => {
        try {
          return readFileSync(file, 'utf8')
        } catch {
          return undefined
        }
      })()
    : await readFile(file, 'utf8').catch(() => undefined)
  if (source === undefined) return missingRecord()
  const srcHash = devTextSourceHash(source)
  // Content decides: a touched-but-unchanged file keeps its edges (and so its
  // dependents keep their names) even though its mtime moved.
  const scanned = previous?.srcHash === srcHash ? previous : edges(file, source)
  return {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    srcHash,
    imports: scanned.imports,
    packages: scanned.packages,
    client: scanned.client,
  }
}

// --------------------------------------------------------------------------
// cache marker — the O(1) "was this folder wiped?" check
// --------------------------------------------------------------------------

// A build empties `.pnext` under running dev servers, which can leave an artifact on disk whose
// `cache/server/` imports were deleted; Bun caches a failed import for the life of the process, so a
// dangling edge must never reach the runtime. Instead of reading back every compiled module and walking its
// edges, the folder carries a uuid marker: while it still reads back as the value this process adopted at
// boot, the folder was never wiped and every artifact still in it still has its edges. Once it does not -
// or once there is no marker at all - nothing on disk is trusted until this process rewrites it.
const markers = new Map<string, string>()
const wiped = new Set<string>()
const written = new Set<string>()
const markerChecks = new Map<string, number>()

function markerFile(root: string) {
  return path.join(root, '.cache-id')
}

/**
 * Adopt the folder's marker. Its presence is the claim that no `pnext build`
 * has emptied the folder since a server last compiled into it, so what is in
 * there still has its edges; a folder without one starts untrusted.
 */
function establishCacheTrust(root: string) {
  const current = readMarker(root)
  // Generation-qualified: artifacts embed paths shaped by pnext's own compile/vendor source (vendor
  // keys, emitted import shapes), so a cache written by a different pnext generation must not be
  // reused - 0.0.9-era modules kept importing vendor artifacts 0.0.10 keyed differently, and every
  // request through one 500'd until a manual wipe. A mismatched or legacy marker distrusts the
  // folder; everything recompiles in place.
  const generation = `${frameworkFingerprint()}:`
  const trusted = current?.startsWith(generation) ? current : undefined
  const value = trusted ?? `${generation}${randomUUID()}`
  if (!trusted) {
    writeMarker(root, value)
    wiped.add(root)
  }
  markers.set(root, value)
  return value
}

function readMarker(root: string) {
  try {
    return readFileSync(markerFile(root), 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

function writeMarker(root: string, value: string) {
  try {
    mkdirSync(root, { recursive: true })
    writeFileSync(markerFile(root), value)
  } catch {
    // Non-fatal: an unwritable marker only costs a recompile.
  }
}

/**
 * True while the folder still carries this process's marker. Re-reads at most every 100 ms - the
 * window it leaves is a wipe racing an in-flight compile, which recompiles into place anyway.
 */
function cacheMarkerIntact(root: string) {
  const recorded = markers.get(root)
  if (recorded === undefined || wiped.has(root)) return false
  const now = performance.now()
  if (now - (markerChecks.get(root) ?? -Infinity) < 100) return true
  markerChecks.set(root, now)
  const current = readMarker(root)
  if (current === recorded) return true
  // Wiped under us: re-establish the marker so the rebuilt cache is reusable
  // next boot, but distrust everything still on disk for the rest of this run.
  if (!current) writeMarker(root, recorded)
  else markers.set(root, current)
  wiped.add(root)
  return false
}

/** Record an artifact this process just wrote — trusted even after a wipe. */
export function noteDevArtifactWritten(file: string) {
  const root = artifactCacheRoot(file)
  if (root && wiped.has(root)) written.add(file)
}

/**
 * Can this compiled artifact be imported as-is? One `existsSync` (a hand-deleted file) plus the folder
 * marker (a build wipe) - the whole-graph read walk this replaces cost one read and one stat per edge, per
 * module, per boot.
 */
export function devArtifactUsable(file: string) {
  if (!cachedExistsSync(file)) return false
  const root = artifactCacheRoot(file)
  // No dev module cache for this folder — a prod build writes compiled output
  // here too, and it owns the directory it just emptied.
  if (!root || !markers.has(root)) return true
  return cacheMarkerIntact(root) || written.has(file)
}

function artifactCacheRoot(file: string) {
  const marker = `${path.sep}cache${path.sep}server${path.sep}`
  const index = file.lastIndexOf(marker)
  return index === -1 ? undefined : file.slice(0, index + marker.length - 1)
}

// --------------------------------------------------------------------------
// persisted graph index
// --------------------------------------------------------------------------

interface IndexFile {
  version: number
  key: string
  files: Record<string, [number, number, string, string[], string[], 0 | 1]>
}

/** Bumped whenever a record's shape changes; an older index is simply ignored. */
const INDEX_VERSION = 4

function readIndexFile(file: string): IndexFile | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as IndexFile
  } catch {
    return undefined
  }
}

// Source hashes and edges stay usable even when the artifacts they named are
// gone — only a different compile key makes them describe another cache.
// Paths are stored portably (see `portableSourcePath`) so an index written on
// the build machine still describes the same sources under the deployment root.
function indexRecords(parsed: IndexFile | undefined, key: string, workspaceRoot: string) {
  const records = new Map<string, SourceRecord>()
  if (parsed?.key !== key || parsed.version !== INDEX_VERSION) return records
  for (const [source, entry] of Object.entries(parsed.files ?? {})) {
    records.set(absoluteSourcePath(source, workspaceRoot), {
      mtimeMs: entry[0],
      size: entry[1],
      srcHash: entry[2],
      imports: entry[3].map(file => absoluteSourcePath(file, workspaceRoot)),
      packages: entry[4] ?? [],
      client: entry[5] === 1,
    })
  }
  return records
}

function serializeIndex(key: string, records: Map<string, SourceRecord>, workspaceRoot: string) {
  const files: IndexFile['files'] = {}
  for (const [source, record] of records) {
    files[portableSourcePath(source, workspaceRoot)] = [
      record.mtimeMs,
      record.size,
      record.srcHash,
      record.imports.map(file => portableSourcePath(file, workspaceRoot)),
      record.packages,
      record.client ? 1 : 0,
    ]
  }
  return JSON.stringify({ version: INDEX_VERSION, key, files } satisfies IndexFile)
}
