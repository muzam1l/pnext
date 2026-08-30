// pnext's own sources shape every artifact it emits, so a framework edit must invalidate an app's
// compiled caches exactly the way an app edit does. ONE fingerprint over pnext's whole shipped `src`
// tree does that - never a hand-picked directory list, which is how a compat-shim edit came to leave
// a stale vendor bundle serving a bug that had already been fixed.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Exactly what the package publishes and the vercel adapter ships: source extensions only, never
 * declarations (both drop them) and never machine-local files like `.DS_Store`. The same tree must
 * fingerprint identically in a workspace, in an npm install and inside a deployed function, or the
 * function distrusts the cache its own build wrote and re-vendors onto a read-only filesystem.
 */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs'])
const DECLARATION = /\.d\.[cm]?ts$/

const frameworkSrc = fileURLToPath(new URL('..', import.meta.url))

/** Every shipped source under `dir`, sorted, so the fold order is stable. */
function sourceFiles(dir: string, found: string[] = []) {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, found)
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !DECLARATION.test(entry.name))
      found.push(full)
  }
  return found
}

function contentFingerprint(files: string[], dir: string) {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(path.relative(dir, file))
    try {
      hash.update(Bun.hash(readFileSync(file)).toString(36))
    } catch {
      // A file that vanished mid-walk simply contributes its name.
    }
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 16)
}

/** Content identity of a framework source tree. Pure — no memo, no record. */
export function computeFrameworkFingerprint(dir = frameworkSrc) {
  return contentFingerprint(sourceFiles(dir), dir)
}

// Reading 4.4 MB of source costs ~13 ms; one stat per file costs ~3 ms. So the same three-step
// ladder the module index and the client key use: the record maps a stat signature to the content
// fingerprint it produced, a matching signature reuses it, and anything else re-reads. A touch that
// changed nothing (a reinstall, a checkout, a staged copy) re-reads once and records the same
// fingerprint, so it never costs a rebuild - only fingerprinting mtimes directly would.
const RECORD_VERSION = 1

interface Record {
  version: number
  stats: string
  fingerprint: string
}

function statSignature(files: string[], dir: string) {
  const hash = createHash('sha256')
  for (const file of files) {
    const stats = statSync(file, { throwIfNoEntry: false })
    hash.update(`${path.relative(dir, file)}:${stats?.size ?? -1}:${stats?.mtimeMs ?? -1}\0`)
  }
  return hash.digest('hex').slice(0, 16)
}

function recordFile(dir: string) {
  return path.join(dir, 'framework.json')
}

function readRecord(dir: string) {
  try {
    const parsed = JSON.parse(readFileSync(recordFile(dir), 'utf8')) as Record
    return parsed.version === RECORD_VERSION && parsed.stats && parsed.fingerprint
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

function writeRecord(dir: string, record: Record) {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(recordFile(dir), JSON.stringify(record))
  } catch {
    // Non-fatal: an unwritable record only costs the next boot a re-read.
  }
}

let fingerprint: string | undefined
const recorded = new Set<string>()

/**
 * This pnext's generation. Mixed into every compiled-artifact cache key, so an artifact built by one
 * framework generation is never handed to another.
 *
 * `recordDir` (a cache root) buys the O(1) stat path across restarts; without it the tree is read.
 * `PNEXT_FRAMEWORK_FINGERPRINT` pins the value outright — the bisect seam, and how a deployment can
 * replay its build's generation without walking the tree at all.
 */
export function frameworkFingerprint(recordDir?: string) {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const pinned = process.env.PNEXT_FRAMEWORK_FINGERPRINT
  if (pinned) return pinned
  // Memoized, but a second app in the same process still gets its own record - without one its next
  // boot pays the full read for a fingerprint this process already knows.
  if (fingerprint !== undefined && (!recordDir || recorded.has(recordDir))) return fingerprint
  const files = sourceFiles(frameworkSrc)
  const stats = statSignature(files, frameworkSrc)
  const previous = recordDir ? readRecord(recordDir) : undefined
  fingerprint =
    previous?.stats === stats ? previous.fingerprint : contentFingerprint(files, frameworkSrc)
  if (recordDir) {
    recorded.add(recordDir)
    if (previous?.stats !== stats)
      writeRecord(recordDir, { version: RECORD_VERSION, stats, fingerprint })
  }
  return fingerprint
}
