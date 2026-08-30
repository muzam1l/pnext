import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

const NODE_MODULES = `${path.sep}node_modules${path.sep}`

// One cached dirent listing per directory replaces per-file stat probes.
// node_modules only: installed layouts are process-immutable, app paths are not.
const dirents = new Map<string, Set<string> | undefined>()

function direntsFor(dir: string) {
  if (dirents.has(dir)) return dirents.get(dir)
  let names: Set<string> | undefined
  try {
    names = new Set(readdirSync(dir))
  } catch {
    names = undefined
  }
  dirents.set(dir, names)
  return names
}

/** `existsSync`, served from the dirent cache for node_modules paths. */
export function cachedExistsSync(file: string): boolean {
  if (!file.includes(NODE_MODULES)) return existsSync(file)
  return direntsFor(path.dirname(file))?.has(path.basename(file)) ?? false
}

/** Structural-save invalidation: a file added or deleted changes the answers. */
export function clearNodeModulesFsCache(): void {
  dirents.clear()
}
