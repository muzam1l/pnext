// Content-addressed store for dev client build output. Generation dirs under
// cache/client/<key>/ repeat the same chunk bytes across saves (~42% of
// cache/client measured byte-duplicate on a zero-edit warm-up).
// Hardlinking each file into a shared store keyed by its own hash collapses
// duplicates to one inode while every generation dir keeps a normal-looking
// path; eviction of one generation just drops its link, leaving the others
// (and the store's own link) intact.
import { createHash } from 'node:crypto'
import { link, mkdir, readFile, readdir, rm, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { listFiles } from '../utils/fs'

export function clientChunkStoreDir(outPath: string) {
  return path.join(outPath, 'cache', 'client-store')
}

function contentHash(data: Buffer) {
  return createHash('sha1').update(data).digest('hex')
}

/**
 * Replace every file under `dir` with a hardlink into the shared store, deduping
 * identical content written by unrelated generations. Falls back to a plain
 * copy when linking fails (e.g. store and outDir on different devices) so the
 * file always ends up in place either way.
 */
export async function contentAddressDir(dir: string, storeDir: string) {
  await mkdir(storeDir, { recursive: true })
  const files = await listFiles(dir)
  await Promise.all(files.map(file => contentAddressFile(file, storeDir)))
}

async function contentAddressFile(file: string, storeDir: string) {
  const data = await readFile(file)
  const storePath = path.join(storeDir, `${contentHash(data)}${path.extname(file)}`)
  if (!(await pathExists(storePath))) {
    // Claim the store slot from this file's own bytes: link first (cheap, same
    // device), and only fall back to a copy if that's impossible. Either way the
    // original file stays at `file` — nothing below needs to re-link it there.
    try {
      await link(file, storePath)
      return
    } catch {
      await copyFileFallback(file, storePath)
      return
    }
  }
  // Store already holds this content: swap the freshly-written file for a link
  // to the shared inode so duplicate bytes stop being duplicate on disk.
  try {
    await unlink(file)
    await link(storePath, file)
  } catch {
    // Cross-device or racing unlink: leave the original file in place, it is
    // already correct content, just not deduped this time.
  }
}

async function copyFileFallback(file: string, storePath: string) {
  try {
    const data = await readFile(file)
    await Bun.write(storePath, data)
  } catch {
    // Best-effort: dedup is an optimization, not a correctness requirement.
  }
}

async function pathExists(target: string) {
  return stat(target)
    .then(() => true)
    .catch(() => false)
}

/**
 * Sweep store entries no generation dir links to anymore. A store file's link count is 1 exactly when the
 * store's own hardlink is the only one left - every generation that once pointed at it has been evicted.
 */
export async function sweepClientChunkStore(storeDir: string) {
  let entries: string[]
  try {
    entries = await readdir(storeDir)
  } catch {
    return
  }
  await Promise.allSettled(
    entries.map(async entry => {
      const full = path.join(storeDir, entry)
      const info = await stat(full).catch(() => null)
      if (info && info.nlink <= 1) await rm(full, { force: true })
    }),
  )
}
