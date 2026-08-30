/**
 * Per-file memo for the bundler plugins' load/resolve callbacks. Those callbacks are the plugin
 * chain's whole JS cost - they run once per FILE per BUILD, and the vendor pipeline runs hundreds
 * of builds over an overlapping set of node_modules files.
 *
 * Staleness follows the rule the rest of the runtime uses: a file under `node_modules` is immutable
 * for the life of the process (the same assumption the vendor artifact cache makes), and anything
 * else is keyed on mtime + size so an edit is never served from the memo.
 */
import { statSync } from 'node:fs'
import path from 'node:path'

const NODE_MODULES = `${path.sep}node_modules${path.sep}`

interface Entry<T> {
  stamp: string
  value: T
}

/** mtime+size stamp, or '' for a file whose contents cannot change here. */
function stamp(file: string) {
  if (file.includes(NODE_MODULES)) return ''
  try {
    const info = statSync(file)
    return `${info.mtimeMs}\0${info.size}`
  } catch {
    // A missing file is a real answer for the callers here (they all catch), so
    // it is cached like any other — under a stamp no live file can produce.
    return 'missing'
  }
}

/** A memo whose entries are recomputed when their file changes on disk. */
export function fileMemo<T>(compute: (file: string) => T) {
  const entries = new Map<string, Entry<T>>()
  return (file: string): T => {
    const current = stamp(file)
    const cached = entries.get(file)
    if (cached?.stamp === current) return cached.value
    const value = compute(file)
    entries.set(file, { stamp: current, value })
    return value
  }
}

/**
 * The same memo for a callback that reads off the event loop. A bundler plugin callback runs on the
 * SINGLE JS thread the whole pipeline shares, so a synchronous read there is time no other build can
 * use - awaiting one lets the other builds' callbacks interleave with it.
 */
export function fileMemoAsync<T>(compute: (file: string) => Promise<T>) {
  const entries = new Map<string, Entry<Promise<T>>>()
  return (file: string): Promise<T> => {
    const current = stamp(file)
    const cached = entries.get(file)
    if (cached?.stamp === current) return cached.value
    const value = compute(file)
    entries.set(file, { stamp: current, value })
    return value
  }
}
