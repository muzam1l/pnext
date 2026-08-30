// Shared spine of the persisted restart records (global-css, route-facts): the key everything a
// record depends on that is NOT a walked source folds into, and the stat->hash ladder that
// revalidates the sources themselves. Both halves were duplicated per record; a key rule that lives
// in two copies is a key rule that gets fixed in one of them.
import { readFileSync, statSync } from 'node:fs'
import type { ResolvedConfig } from '../../config'
import { frameworkFingerprint } from '../../runtime/fingerprint'
import { cacheRoot } from '../../runtime/module-cache'

/** `[file, mtimeMs, size, contentHash]` — the shape every restart cache records. */
export type SourceEntry = [string, number, number, string]

export const hash = (value: string) => Bun.hash(value).toString(36)

/**
 * A record's answer can change without any app file moving, when the thing that *interprets* the
 * graph does: the resolver's config (aliases, conditions, page extensions) or pnext itself.
 *
 * The framework half is the CONTENT of pnext's whole shipped tree, never the mtime+size of one
 * hand-picked walker file. A record derived by reading many framework files cannot be keyed on one
 * of them - the stamp is blind to an edit in any of the others - and mtime+size is not content: a
 * same-length edit landing in the same mtime tick moved nothing the stamp could see. The tree
 * fingerprint is already computed at boot for the module cache and memoized per process, so this
 * costs a memo read.
 */
export function recordCacheKey(config: ResolvedConfig, version: number): string | undefined {
  try {
    const shape = JSON.stringify(config, (_key, value: unknown) =>
      typeof value === 'function' ? '[fn]' : value,
    )
    return hash(`${version}\n${frameworkFingerprint(cacheRoot(config.outPath))}\n${shape}`)
  } catch {
    // A config that will not serialize (cycles, exotic values) simply opts out.
    return undefined
  }
}

/**
 * The same key, on first USE rather than at install. The stores are installed during boot but first
 * read on the first page, and the fingerprint the key folds in is paid by the module cache on that
 * same page - so computing it eagerly does not save the work, it just moves it in front of the
 * server being ready to serve.
 */
export function lazyRecordCacheKey(config: ResolvedConfig, version: number) {
  let key: string | undefined
  let computed = false
  return () => {
    if (!computed) {
      computed = true
      key = recordCacheKey(config, version)
    }
    return key
  }
}

export function sourceEntries(files: string[]): SourceEntry[] | undefined {
  const entries: SourceEntry[] = []
  for (const file of files) {
    const entry = sourceEntry(file)
    if (!entry) return undefined
    entries.push(entry)
  }
  return entries
}

export function sourceEntry(file: string): SourceEntry | undefined {
  try {
    const source = readFileSync(file, 'utf8')
    // Stat AFTER the read: a file that changes between the two records the
    // older stat, so the next boot re-hashes rather than trusting a stale one.
    const info = statSync(file, { throwIfNoEntry: false })
    if (!info) return undefined
    return [file, info.mtimeMs, info.size, hash(source)]
  } catch {
    return undefined
  }
}

/**
 * The recorded sources, re-stated: `files` itself when nothing moved, a fresh list when only stats moved,
 * `undefined` when any content actually differs - or a source is gone, which is the same thing, since the
 * walk has to run again.
 */
export function revalidate(files: SourceEntry[]): SourceEntry[] | undefined {
  let moved = false
  const checked: SourceEntry[] = []
  for (const entry of files) {
    const [file, mtimeMs, size, contentHash] = entry
    const info = statSync(file, { throwIfNoEntry: false })
    if (!info) return undefined
    if (info.mtimeMs === mtimeMs && info.size === size) {
      checked.push(entry)
      continue
    }
    let source: string
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      return undefined
    }
    if (hash(source) !== contentHash) return undefined
    moved = true
    checked.push([file, info.mtimeMs, info.size, contentHash])
  }
  return moved ? checked : files
}
