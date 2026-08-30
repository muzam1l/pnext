import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { listFilesSync } from '../../utils/fs'
import type { ResolvedConfig } from '../../config'
import { nextCompatEnabled } from '../aliases'
import { importSpecifiers } from '../../resolve/scan-facts'
import { readSourceSync } from '../../resolve/source-text'
import {
  packageNameOfSpecifier,
  resolutionRootForFile,
  resolvePackageSpecifier,
} from '../../resolve/imports'
import { moduleActionExports, moduleLevelUseCache, moduleLevelUseServer } from './detect'
import { canonical, canonicalActionId } from './client-plugin'
import { registerActionModule, type ActionEntry } from './registry'

/**
 * One discovered server-action module: its source path, the action export
 * names, the wire ids for each, and the module path that runAction's
 * importModule() should load (a compiled output path in prod, the source path
 * in dev).
 */
export interface DiscoveredActionModule {
  /** Source file of the 'use server' module. */
  file: string
  /** Action export names (named exports + 'default'). */
  exports: string[]
  /** actionId(file, exportName, root) keyed by export name. */
  ids: Record<string, string>
  /** What runAction hands to importModule() (defaults to `file`). */
  modulePath: string
}

export interface ActionDiscovery {
  modules: DiscoveredActionModule[]
  /** Every source file that is a 'use server' module, for the client alias. */
  actionFiles: Set<string>
  /**
   * First-party files that import a node_modules action module. The route-fact scan's client-entry-reason
   * walk never descends into node_modules (see collectSourceFiles), so a route reaching an action only
   * through one of these files needs its 'actions' reason added explicitly - the action file itself never
   * lands in route.sourceFiles the way a first-party action module does.
   */
  actionImporters: Set<string>
}

/**
 * Scan the app for module-level `'use server'` files - the reliable, fully static wire path. Each such
 * file contributes every named export (plus a default export) as an RPC target.
 *
 * Inline `'use server'` functions inside Server Components are intentionally NOT discovered here: they
 * cannot be resolved to a stable module export reachable as an RPC target. They still work when passed
 * to <form action={fn}> as a local declaration rendered on the server.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function discoverActions(
  config: ResolvedConfig,
  options: { modulePathFor?: (file: string) => string } = {},
): Promise<ActionDiscovery> {
  const empty: ActionDiscovery = { modules: [], actionFiles: new Set(), actionImporters: new Set() }
  if (!nextCompatEnabled(config)) return empty

  const roots = actionScanRoots(config)
  const seen = new Set<string>()
  const files: string[] = []
  // Synchronous on purpose: every await hands the loop back to the build's sync route-fact walk and
  // gate steps, which hold it long enough to stretch this work into a span the client stage then
  // waits on. Running it straight through costs the same CPU and unblocks the stage.
  const listings = roots.map(root => (existsSync(root) ? listFilesSync(root) : []))
  for (const listing of listings) {
    for (const file of listing) {
      const resolved = path.resolve(file)
      if (seen.has(resolved) || !isScriptFile(resolved)) continue
      seen.add(resolved)
      files.push(resolved)
    }
  }
  const sources = readSources(files)
  const { files: nodeModuleActionFiles, importers: actionImporters } =
    discoverNodeModuleActionFiles(config, files, sources, seen)
  for (const file of nodeModuleActionFiles) {
    files.push(file)
    seen.add(file)
  }
  for (const [file, source] of readSources(files.filter(file => !sources.has(file)))) {
    sources.set(file, source)
  }

  const modules: DiscoveredActionModule[] = []
  const actionFiles = new Set<string>()
  for (const file of files) {
    const source = sources.get(file)!
    // Module-level 'use cache' files are server-reference modules too: their
    // exports cross to client components as RPC stubs (Next semantics — the
    // cached function always runs, and caches, on the server).
    if (!moduleLevelUseServer(source) && !moduleLevelUseCache(source)) continue
    const exports = moduleActionExports(source)
    if (exports.length === 0) continue

    const ids: Record<string, string> = {}
    for (const exportName of exports)
      ids[exportName] = canonicalActionId(file, exportName, config.root)
    modules.push({
      file,
      exports,
      ids,
      modulePath: options.modulePathFor ? options.modulePathFor(file) : file,
    })
    actionFiles.add(file)
  }

  return { modules, actionFiles, actionImporters }
}

/**
 * Register discovered action modules into the process registry so the endpoint
 * can resolve incoming ids. Returns the flat entry list (id/modulePath/export).
 */
export function registerDiscoveredActions(
  config: ResolvedConfig,
  discovery: ActionDiscovery,
): ActionEntry[] {
  const entries: ActionEntry[] = []
  const root = canonical(config.root)
  for (const module of discovery.modules) {
    // Canonical (file, root) so registry ids match the client stub / manifest.
    entries.push(
      ...registerActionModule(canonical(module.file), module.exports, {
        root,
        modulePath: module.modulePath,
      }),
    )
  }
  return entries
}

// Server actions live under the app dir and (for monorepos) may be shared from
// workspace packages, but scanning the whole workspace is too broad. Scan the
// app dir plus the project src dir if present — the common home for a shared
// actions module. node_modules and the build output are excluded.
function actionScanRoots(config: ResolvedConfig) {
  const roots = new Set<string>([config.appPath])
  if (config.appPath.includes('pnext-pages-compat')) {
    const rootApp = path.join(config.root, 'app')
    if (existsSync(rootApp)) roots.add(rootApp)
    const srcApp = path.join(config.root, 'src', 'app')
    if (existsSync(srcApp)) roots.add(srcApp)
  }
  const srcDir = path.join(config.root, 'src')
  if (existsSync(srcDir)) roots.add(srcDir)
  return [...roots]
}

function isScriptFile(file: string) {
  if (file.includes(`${path.sep}node_modules${path.sep}`)) return false
  return /\.(?:tsx?|jsx?|mjs)$/.test(file) && !file.endsWith('.d.ts')
}

const ACTION_RESOLVE_CONDITIONS = ['react-server', 'node', 'import', 'module', 'default'] as const
/**
 * node_modules packages that export module-level 'use server' modules the app imports directly.
 * Reading a file's real imports costs an oxc parse - but an import specifier is always a quoted string
 * literal, so the cheap textual superset below decides which files can possibly reach an action
 * package. Only those are parsed; everything the set returns is confirmed against the parse.
 */
function discoverNodeModuleActionFiles(
  config: ResolvedConfig,
  sourceFiles: string[],
  sources: Map<string, string>,
  seen: Set<string>,
): { files: string[]; importers: Set<string> } {
  const actionFiles = new Set<string>()
  const importers = new Set<string>()
  // A bare specifier resolves purely from the importer's resolution root, so
  // both the resolution and the 'use server' verdict are cached app-wide, and
  // each is derived only for the specifiers a file actually reaches.
  const targets = new Map<string, string | undefined>()
  const verdicts = new Map<string, boolean>()
  const actionTarget = (resolveRoot: string, file: string, specifier: string) => {
    const packageName = packageNameOfSpecifier(specifier)
    if (!packageName || builtinModules.includes(packageName)) return undefined
    const key = `${resolveRoot}\0${specifier}`
    if (!targets.has(key)) {
      targets.set(
        key,
        resolvePackageSpecifier(config.root, file, specifier, ACTION_RESOLVE_CONDITIONS),
      )
    }
    const resolved = targets.get(key)
    if (!resolved) return undefined
    const absolute = path.resolve(resolved)
    if (seen.has(absolute) || !isNodeModuleScriptFile(absolute)) return undefined
    let verdict = verdicts.get(absolute)
    if (verdict === undefined) {
      // An unreadable candidate is simply not an action module.
      try {
        verdict = moduleLevelUseServer(readFileSync(absolute, 'utf8'))
      } catch {
        verdict = false
      }
      verdicts.set(absolute, verdict)
    }
    return verdict ? absolute : undefined
  }

  for (const file of sourceFiles) {
    const source = sources.get(file) ?? ''
    const resolveRoot = resolutionRootForFile(config.root, file)
    let reachable = false
    for (const candidate of candidateSpecifiers(source)) {
      if (actionTarget(resolveRoot, file, candidate)) {
        reachable = true
        break
      }
    }
    // No candidate resolves to an action module, so neither can the file's real
    // imports (a subset) — the parse would only reproduce this answer.
    if (!reachable) continue
    for (const specifier of importSpecifiers(source, file)) {
      const target = actionTarget(resolveRoot, file, specifier)
      if (target) {
        actionFiles.add(target)
        importers.add(file)
      }
    }
  }
  return { files: [...actionFiles], importers }
}

// Every string literal in an import position: `from 'x'`, `import 'x'`,
// `import('x')`, `require('x')`. Deliberately looser than the grammar (it also
// matches inside comments and strings) — over-reporting only costs a resolve.
const importedLiteral =
  /\b(?:from|import|require)\s*\(?\s*(?:\/\*[\s\S]*?\*\/\s*)?(['"])([^'"\n]{1,256})\1/g
// npm package names are lowercase `[a-z0-9._-]` with an optional @scope, so a
// literal with whitespace or a leading ./ can never be a bare specifier.
const bareSpecifier = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[^\s]+)?$/i

/** Every literal in the source that could be an imported bare package specifier. */
function candidateSpecifiers(source: string) {
  const found = new Set<string>()
  importedLiteral.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = importedLiteral.exec(source))) {
    const value = match[2]!
    if (bareSpecifier.test(value)) found.add(value)
  }
  return found
}

/** Read each file once (build-scope cached: the walk's reads are free here). */
function readSources(files: string[]) {
  const sources = new Map<string, string>()
  for (const file of files) sources.set(file, readSourceSync(file))
  return sources
}

function isNodeModuleScriptFile(file: string) {
  return /\.(?:tsx?|jsx?|mjs|cjs|cts)$/.test(file) && !file.endsWith('.d.ts')
}
