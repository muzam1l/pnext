// ---------------------------------------------------------------------------
// /_next/image disk cache (COMPAT).
//
// Next's exact on-disk layout: <distDir>/cache/images/<cacheKey>/ holding one
// file named `${maxAge}.${expireAt}.${etag}.${upstreamEtag}.${extension}`.
// The e2e suites read this directory directly (file names must embed the etag,
// rewrites must change mtimes on stale-while-revalidate refreshes), so the
// layout is contract, not implementation detail. A byte-budget sweep enforces
// images.maximumDiskCacheSize (0 disables writes entirely).
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export const IMAGE_CACHE_VERSION = 4

export function getHash(items: (string | number | Buffer)[]): string {
  const hash = createHash('sha256')
  for (const item of items) {
    hash.update(typeof item === 'number' ? String(item) : item)
  }
  return hash.digest('base64url')
}

export interface ImageCacheEntry {
  buffer: Buffer
  etag: string
  upstreamEtag: string
  extension: string
  maxAge: number
  expireAt: number
}

export function imageCacheDir(root: string): string {
  return path.join(root, '.next', 'cache', 'images')
}

export async function readCacheEntry(
  cacheDir: string,
  cacheKey: string,
): Promise<ImageCacheEntry | undefined> {
  try {
    const dir = path.join(cacheDir, cacheKey)
    const files = await fs.readdir(dir)
    const file = files[0]
    if (!file) return undefined
    const [maxAgeSt, expireAtSt, etag, upstreamEtag, extension] = file.split('.', 5)
    if (!etag || !upstreamEtag || !extension) return undefined
    const buffer = await fs.readFile(path.join(dir, file))
    return {
      buffer,
      etag,
      upstreamEtag,
      extension,
      maxAge: Number(maxAgeSt),
      expireAt: Number(expireAtSt),
    }
  } catch {
    return undefined
  }
}

export async function writeCacheEntry(
  cacheDir: string,
  cacheKey: string,
  entry: ImageCacheEntry,
  maximumDiskCacheSize: number | undefined,
): Promise<void> {
  if (maximumDiskCacheSize === 0) return
  if (maximumDiskCacheSize !== undefined && entry.buffer.byteLength > maximumDiskCacheSize) {
    return
  }
  try {
    const dir = path.join(cacheDir, cacheKey)
    const filename = path.join(
      dir,
      `${entry.maxAge}.${entry.expireAt}.${entry.etag}.${entry.upstreamEtag}.${entry.extension}`,
    )
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(filename, entry.buffer)
    if (maximumDiskCacheSize !== undefined) {
      await evictToBudget(cacheDir, cacheKey, maximumDiskCacheSize)
    }
  } catch (err) {
    console.error(`Failed to write image to cache ${cacheKey}`, err)
  }
}

// Drop oldest-expiring entries (never the one just written) until the cache
// dir fits the byte budget.
async function evictToBudget(
  cacheDir: string,
  keepKey: string,
  maximumDiskCacheSize: number,
): Promise<void> {
  const keys = await fs.readdir(cacheDir).catch(() => [] as string[])
  const entries: { key: string; size: number; expireAt: number }[] = []
  let total = 0
  for (const key of keys) {
    const dir = path.join(cacheDir, key)
    const files = await fs.readdir(dir).catch(() => [] as string[])
    const file = files[0]
    if (!file) continue
    const stat = await fs.stat(path.join(dir, file)).catch(() => null)
    if (!stat) continue
    total += stat.size
    entries.push({ key, size: stat.size, expireAt: Number(file.split('.', 2)[1]) || 0 })
  }
  if (total <= maximumDiskCacheSize) return
  entries.sort((a, b) => a.expireAt - b.expireAt)
  for (const entry of entries) {
    if (total <= maximumDiskCacheSize) break
    if (entry.key === keepKey) continue
    await fs
      .rm(path.join(cacheDir, entry.key), { recursive: true, force: true })
      .catch(() => undefined)
    total -= entry.size
  }
}
