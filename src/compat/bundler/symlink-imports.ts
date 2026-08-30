import { readdirSync, realpathSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import type { Plugin } from 'esbuild'
import type { ResolvedConfig } from '../../config'
import { resolveImport } from '../../resolve/imports'

const resolvedMarker = Symbol('pnext-symlink-import')

/**
 * Whether a file IS its own real path - asked once per relative import, so the same importers are
 * re-resolved component-by-component across every build. Keyed on the path alone: a path's symlink
 * identity changes only on an install, which already invalidates every resolved artifact key.
 */
const realPaths = new Map<string, Promise<boolean>>()

function isRealPath(file: string) {
  let real = realPaths.get(file)
  if (!real) {
    real = realpath(file).then(
      resolved => resolved === file,
      () => true,
    )
    realPaths.set(file, real)
  }
  return real
}

/**
 * What the layout scan concluded:
 *   'none'          no symlink anywhere the resolver could meet one
 *   'package-links' only whole-package node_modules links (workspace or link installs) - esbuild follows
 *                   these during node_modules resolution, so importers come out as realpaths
 *   'other'         pnpm trees, symlinked roots, stray source symlinks, or a failed scan
 */
type SymlinkLayout = 'none' | 'package-links' | 'other'

const symlinkLayouts = new Map<string, SymlinkLayout>()

/**
 * Whether this build can see a SYMLINKED importer, so the plugin's onResolve is registered only where it
 * can matter. `realPathEntries` builds hand esbuild realpath-resolved entries, and esbuild's own
 * resolution follows symlinks - there, workspace links alone cannot produce a symlinked importer. Any
 * detection error registers the plugin: a missed hook silently changes resolution.
 */
export function symlinkedImportsPossible(
  config: ResolvedConfig,
  realPathEntries?: boolean,
): boolean {
  const key = `${config.root}\0${config.workspaceRoot}`
  let layout = symlinkLayouts.get(key)
  if (layout === undefined) {
    layout = detectSymlinkLayout(config)
    symlinkLayouts.set(key, layout)
  }
  if (layout === 'none') return false
  if (layout === 'package-links') return !realPathEntries
  return true
}

function detectSymlinkLayout(config: ResolvedConfig): SymlinkLayout {
  try {
    const roots = [...new Set([config.root, config.workspaceRoot])].map(root => path.resolve(root))
    let packageLinks = false
    for (const root of roots) {
      if (realpathSync(root) !== root) return 'other'
      if (readDirEntries(root).some(entry => entry.isSymbolicLink())) return 'other'
      const nodeModules = path.join(root, 'node_modules')
      for (const entry of readDirEntries(nodeModules)) {
        if (entry.name === '.pnpm') return 'other'
        if (entry.isSymbolicLink()) packageLinks = true
        else if (entry.isDirectory() && entry.name.startsWith('@')) {
          const scopeDir = path.join(nodeModules, entry.name)
          if (readDirEntries(scopeDir).some(scoped => scoped.isSymbolicLink())) packageLinks = true
        }
      }
    }
    return packageLinks ? 'package-links' : 'none'
  } catch {
    return 'other'
  }
}

/** Missing dir = no symlinks there; any other failure propagates as "uncertain". */
function readDirEntries(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Resolve relative imports from the real target of a symlinked source file. */
export function serverSymlinkImportPlugin(config: ResolvedConfig): Plugin {
  return {
    name: 'pnext-symlink-imports',
    setup(build) {
      build.onResolve({ filter: /^\.\.?\// }, async args => {
        if (
          !args.importer ||
          (args.pluginData as Record<PropertyKey, unknown> | undefined)?.[resolvedMarker]
        ) {
          return undefined
        }
        if (await isRealPath(args.importer)) return undefined
        const target = resolveImport(config.root, args.importer, args.path)
        if (!target) return undefined
        return build.resolve(target, {
          kind: args.kind,
          importer: args.importer,
          namespace: args.namespace,
          resolveDir: args.resolveDir,
          pluginData: { ...(args.pluginData as object | undefined), [resolvedMarker]: true },
        })
      })
    },
  }
}
