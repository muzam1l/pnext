// One read per first-party source per build. A build has three consumers of the same app sources -
// the route-fact walk (sync), action discovery (async) and the client loader (async) - and each used
// to read the file itself. Whoever asks first pays; everyone after gets the same string. This buys
// reads, not parses: `scanFacts`' memo is keyed on content, so the three already shared one parse
// per source.
//
// Scoped, not global: `beginSourceScope`/`endSourceScope` bracket a single build, so the map is
// released when it ends and nothing outside a build is cached at all. That is what keeps the dev
// watcher out of it - dev reads go straight to the filesystem, so a save is never served a stale
// string, and content-keyed invalidation downstream is untouched.
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

// eslint-disable-next-line turbo/no-undeclared-env-vars
const disabled = process.env.PNEXT_SRC_CACHE === '0'

const contents = new Map<string, string>()
// Reads still in flight: two async consumers asking at once share one read
// rather than racing two. Resolved entries move to `contents`.
const inflight = new Map<string, Promise<string>>()
let scoped = false
let reads = 0
let hits = 0

/**
 * Start caching source reads. Two builds in one process (the test runner) share the map - keyed by absolute
 * path, so a shared entry is the same file - and whichever ends first drops it; the other keeps building,
 * uncached.
 */
export function beginSourceScope() {
  if (disabled) return
  scoped = true
}

/** End the scope and drop everything it held. */
export function endSourceScope() {
  scoped = false
  contents.clear()
  inflight.clear()
}

export function readSourceSync(file: string): string {
  if (!scoped) return readFileSync(file, 'utf8')
  const cached = contents.get(file)
  if (cached !== undefined) {
    hits += 1
    return cached
  }
  reads += 1
  const source = readFileSync(file, 'utf8')
  contents.set(file, source)
  return source
}

export async function readSourceText(file: string): Promise<string> {
  if (!scoped) return readFile(file, 'utf8')
  const cached = contents.get(file)
  if (cached !== undefined) {
    hits += 1
    return cached
  }
  const pending = inflight.get(file)
  if (pending) {
    hits += 1
    return pending
  }
  reads += 1
  // A read that fails is dropped from `inflight` too: the next asker retries and
  // sees the error at its own call site, as it would without the cache.
  const read = (async () => {
    try {
      const source = await readFile(file, 'utf8')
      contents.set(file, source)
      return source
    } finally {
      inflight.delete(file)
    }
  })()
  inflight.set(file, read)
  return read
}

/** Read effectiveness, for the build benches. */
export function sourceCacheStats() {
  return { reads, hits, files: contents.size }
}
