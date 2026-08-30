import path from 'node:path'
import { realpathSync } from 'node:fs'
import type { Plugin } from 'esbuild'
import { readText } from '../../utils/fs'
import { escapeRegex } from '../../utils/code'
import { actionId } from './ids'
import { moduleActionExports, moduleLevelUseCache, moduleLevelUseServer } from './detect'
import { clientStubSource } from './client-stub'

/**
 * Process-level set of `'use server'` module source paths (absolute) that the
 * client bundler must replace with the generated RPC stub. Populated by the
 * build/dev discovery pass before client bundling runs, and consulted by the
 * esbuild plugin below (wired through compatAliasPlugin so it participates in
 * every client build without editing the client build pipeline directly).
 *
 * Keyed by the workspace/project root the ids were computed against so the stub
 * emits ids that match the server registry.
 */
interface ClientActionState {
  root: string
  /** Original (as-discovered) absolute paths — used for import identity. */
  files: Set<string>
  /** Realpath-canonical paths — used to match esbuild's resolved paths. */
  canonicalFiles: Set<string>
}

let clientActionState: ClientActionState | undefined

export function setClientActionModules(root: string, files: Iterable<string>) {
  const originals = new Set<string>()
  const canonicalFiles = new Set<string>()
  for (const file of files) {
    originals.add(path.resolve(file))
    canonicalFiles.add(canonical(file))
  }
  clientActionState = originals.size > 0 ? { root, files: originals, canonicalFiles } : undefined
}

// esbuild reports resolved paths through the OS realpath (e.g. /private on
// macOS), so both the stored set and the lookup canonicalize to match. Also
// used for id computation so the build, the client stub, and the render-side
// form tagging all derive the same wire id from the same (realpath) basis.
export function canonical(file: string) {
  const abs = path.resolve(file)
  try {
    return realpathSync.native(abs)
  } catch {
    return abs
  }
}

export function clearClientActionModules() {
  clientActionState = undefined
}

export function hasClientActionModules() {
  return clientActionState !== undefined && clientActionState.files.size > 0
}

function isActionModule(file: string) {
  if (!clientActionState) return false
  // Match both the original and the realpath-canonical form: render passes the
  // original path; esbuild passes the realpath.
  return (
    clientActionState.files.has(path.resolve(file)) ||
    clientActionState.canonicalFiles.has(canonical(file))
  )
}

/** True when `file` is a discovered client-replaced action module. */
export function isClientActionModule(file: string) {
  return isActionModule(file)
}

/** Root the client action ids were computed against (for stub id parity). */
export function clientActionModulesRoot() {
  return clientActionState?.root
}

/** All discovered action module source paths (absolute). */
export function clientActionModuleFiles(): string[] {
  return clientActionState ? [...clientActionState.files] : []
}

/** Generate the client fetch-stub source for an action module file. */
export function actionStubSourceFor(file: string, root?: string) {
  return stubSourceFor(file, root ?? clientActionState?.root)
}

/**
 * esbuild plugin that swaps a client import of a `'use server'` module for the generated fetch stub.
 * It hooks LOAD, not resolve: the filter is the exact discovered action paths, so esbuild's own
 * resolver decides what a specifier points at and this plugin only sees the handful of files it
 * replaces. A catch-all onResolve here used to re-resolve every import in the graph through
 * `build.resolve`, and perturbed esbuild's CJS-interop decisions on the way.
 */
export function actionClientStubPlugin(): Plugin {
  const paths = clientActionState
    ? [...clientActionState.files, ...clientActionState.canonicalFiles]
    : []
  const filter = new RegExp(`^(?:${[...new Set(paths)].map(escapeRegex).join('|')})$`)
  return {
    name: 'pnext-action-client-stub',
    setup(build) {
      if (paths.length === 0) return
      build.onLoad({ filter, namespace: 'file' }, async args => {
        if (!isActionModule(args.path)) return undefined
        return {
          contents: await stubSourceFor(args.path, clientActionState?.root),
          loader: 'js',
        }
      })
    },
  }
}

async function stubSourceFor(file: string, root?: string) {
  const source = await readText(file)
  return stubSourceFromSource(file, source, root)
}

export function stubSourceFromSource(file: string, source: string, root?: string) {
  if (!moduleLevelUseServer(source) && !moduleLevelUseCache(source)) return 'export {};'
  const exports = moduleActionExports(source)
  const actionIds: Record<string, string> = {}
  for (const name of exports) actionIds[name] = canonicalActionId(file, name, root)
  return clientStubSource({ modulePath: file, exports, actionIds })
}

export async function loadClientActionSource(file: string, root?: string) {
  const source = await readText(file)
  if (!moduleLevelUseServer(source) && !moduleLevelUseCache(source)) return { source }
  return { source, stubSource: stubSourceFromSource(file, source, root) }
}

/**
 * Compute an action wire id from a realpath-canonical (file, root) basis so every producer -
 * discovery/registry, the client stub, and render-side form tagging - agrees regardless of
 * symlink/realpath differences (e.g. /private on macOS temp dirs).
 */
export function canonicalActionId(file: string, exportName: string, root?: string): string {
  return actionId(canonical(file), exportName, root ? canonical(root) : undefined)
}
