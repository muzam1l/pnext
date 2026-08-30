// Persisted node_modules bundles - the restart half of runtime/loader.ts' `transformNodeModuleSource`.
// The node_modules load plugin esbuild-bundles each ESM package file it matches and remembers the
// result in memory only, so every restart re-runs those builds on the request path while the route
// bundle it is evaluating waits.
//
// The entry's own stat names the record, but the build inlines the package's relative graph too, so
// the record carries EVERY esbuild input and is reused only while all of them still stat the same.
// Anything else - a missing input, an unparseable record, a vanished file - is a miss, never a
// stale hit: the bundle it names is imported directly, and Bun caches a bad import for the life of
// the process.
import { mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from '../../utils/fs'

/** `[file, mtimeMs, size]` for one esbuild input of the bundle. */
type InputEntry = [string, number, number]

interface BundleRecord {
  inputs: InputEntry[]
  code: string
}

/** The recorded bundle when every input it was built from is unchanged. */
export async function readNodeModuleBundle(recordFile: string): Promise<string | undefined> {
  const contents = await readFile(recordFile, 'utf8').catch(() => undefined)
  if (contents === undefined) return undefined
  let record: BundleRecord | undefined
  try {
    record = JSON.parse(contents) as BundleRecord
  } catch {
    return undefined
  }
  if (typeof record?.code !== 'string' || !Array.isArray(record.inputs)) return undefined
  if (record.inputs.length === 0) return undefined
  const held = await Promise.all(
    record.inputs.map(async ([input, mtimeMs, size]) => {
      const stats = await stat(input).catch(() => undefined)
      return stats?.mtimeMs === mtimeMs && stats.size === size
    }),
  )
  return held.every(Boolean) ? record.code : undefined
}

export async function writeNodeModuleBundle(
  recordFile: string,
  inputs: string[],
  code: string,
): Promise<void> {
  const stated = await Promise.all(
    inputs.map(async (input): Promise<InputEntry | undefined> => {
      const stats = await stat(input).catch(() => undefined)
      return stats ? [input, stats.mtimeMs, stats.size] : undefined
    }),
  )
  // An input that vanished between the build and here would make the record
  // unvalidatable forever; leaving it unwritten costs the next boot one bundle.
  if (stated.length === 0 || stated.some(entry => entry === undefined)) return
  await mkdir(path.dirname(recordFile), { recursive: true }).catch(() => undefined)
  await writeFileAtomic(
    recordFile,
    JSON.stringify({ inputs: stated as InputEntry[], code } satisfies BundleRecord),
  ).catch(() => undefined)
}
