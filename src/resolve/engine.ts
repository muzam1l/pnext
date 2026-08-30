import { existsSync } from 'node:fs'
import path from 'node:path'
import type { ResolverFactory, NapiResolveOptions } from 'oxc-resolver'
import { loadNative } from '../utils/native-require'

// Lazy: the native binding costs ~1.3 MB RSS and a prod server may never resolve.
function createResolverFactory(options: NapiResolveOptions): ResolverFactory {
  const { ResolverFactory: Factory } = loadNative(
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    () => require('oxc-resolver') as typeof import('oxc-resolver'),
  )
  return new Factory(options)
}
import { clearNodeModulesFsCache } from '../utils/fs-cache'

const sourceExtensions = [
  '.tsx',
  '.ts',
  '.jsx',
  '.js',
  '.mjs',
  '.mts',
  '.cts',
  '.module.css',
  '.css',
]

// An ESM `import './x.js'` is authored against the source file that compiles to
// it — a source convention only (see isSourceRequest / probePackageTarget).
const extensionAlias = {
  '.js': ['.ts', '.tsx', '.js'],
  '.jsx': ['.tsx', '.jsx'],
  '.mjs': ['.mts', '.mjs'],
  '.cjs': ['.cts', '.cjs'],
}

export interface ResolvedModule {
  path: string
}

/** The package answered "no" for this subpath (Node's ERR_PACKAGE_PATH_NOT_EXPORTED). */
export interface UnexportedModule {
  notExported: true
}

export type ResolveOutcome = ResolvedModule | UnexportedModule | undefined

let configuredExtensions: string[] | undefined
let configuredTsConfigPath: string | undefined

let baseFactory: ResolverFactory | undefined
const factories = new Map<string, ResolverFactory>()
const tsConfigFiles = new Map<string, string | undefined>()

export function setEngineExtensions(extensions: readonly string[] | undefined): void {
  configuredExtensions = extensions && extensions.length > 0 ? [...extensions] : undefined
  resetEngine()
}

export function setEngineTsConfigPath(file: string | undefined): void {
  configuredTsConfigPath = file
  resetEngine()
}

function resetEngine() {
  baseFactory = undefined
  factories.clear()
  tsConfigFiles.clear()
  nodeModulesOutcomes.clear()
}

/**
 * Drop oxc's cached filesystem lookups (positive AND negative) so a file
 * created/deleted since the last resolve is seen. Dev-only: the factories stay
 * constructed, only their fs cache is emptied.
 */
export function clearResolverFsCache(): void {
  baseFactory?.clearCache()
  for (const factory of factories.values()) factory.clearCache()
  nodeModulesOutcomes.clear()
  clearNodeModulesFsCache()
}

/** The tsconfig (or jsconfig) driving `paths`/`baseUrl` for a resolution root. */
export function tsConfigFileFor(root: string): string | undefined {
  const key = path.resolve(root)
  if (tsConfigFiles.has(key)) return tsConfigFiles.get(key)
  const candidates = [
    ...(configuredTsConfigPath ? [path.resolve(key, configuredTsConfigPath)] : []),
    path.join(key, 'tsconfig.json'),
    path.join(key, 'jsconfig.json'),
  ]
  const file = candidates.find(candidate => existsSync(candidate))
  tsConfigFiles.set(key, file)
  return file
}

/**
 * Split a webpack resource specifier into its file request and its `?query#fragment` suffix - loader
 * plumbing (turbopack rules, `.wasm?module`) that takes no part in the on-disk lookup. A leading `#` is a
 * package-imports specifier, not a fragment.
 */
export function splitResourceQuery(specifier: string): { path: string; query: string } {
  const offset = specifier.startsWith('#') ? 1 : 0
  const match = /[?#]/.exec(specifier.slice(offset))
  if (!match) return { path: specifier, query: '' }
  const index = offset + match.index
  return { path: specifier.slice(0, index), query: specifier.slice(index) }
}

/**
 * Resolve `specifier` from `dir`. `tsConfigRoot` opts the lookup into that
 * root's tsconfig `paths`; package lookups deliberately pass none.
 */
export function resolveFrom(
  dir: string,
  specifier: string,
  conditions: readonly string[],
  tsConfigRoot?: string,
): ResolveOutcome {
  const { path: request } = splitResourceQuery(specifier)
  const tsconfig = tsConfigRoot ? tsConfigFileFor(tsConfigRoot) : undefined
  return resolveRequest(dir, request, conditions, tsconfig, isSourceRequest(request))
}

/** Probe a literal on-disk path with the resolver's extension/index rules. */
export function probeFile(target: string, conditions: readonly string[]): string | undefined {
  return probe(target, conditions, true)
}

/**
 * Probe a package's `exports`/`main` TARGET (or an on-disk subpath standing in
 * for one). Same extension/index rules as probeFile, minus the `.js` -> `.ts`
 * source alias: Node and webpack read a package's stated target literally, so a
 * stale `x.ts` next to the built `x.js` must never win.
 */
export function probePackageTarget(
  target: string,
  conditions: readonly string[],
): string | undefined {
  return probe(target, conditions, false)
}

function probe(target: string, conditions: readonly string[], sourceAlias: boolean) {
  const { path: file } = splitResourceQuery(target)
  const request = `./${path.basename(file)}`
  const outcome = resolveRequest(path.dirname(file), request, conditions, undefined, sourceAlias)
  return outcome && 'path' in outcome ? outcome.path : undefined
}

/** Runtime-cache reset (bench/tests): drop memoized node_modules resolutions. */
export function clearNodeModulesResolutionCache(): void {
  nodeModulesOutcomes.clear()
}

// Lookups FROM node_modules only: installed layouts are process-immutable,
// app-source resolution must stay live under watch (see clearResolverFsCache).
const nodeModulesOutcomes = new Map<string, ResolveOutcome>()
const NODE_MODULES_SEGMENT = `${path.sep}node_modules${path.sep}`

function resolveRequest(
  dir: string,
  request: string,
  conditions: readonly string[],
  tsconfig: string | undefined,
  sourceAlias: boolean,
): ResolveOutcome {
  const key = dir.includes(NODE_MODULES_SEGMENT)
    ? `${dir}\0${request}\0${conditions.join(',')}\0${tsconfig ?? ''}\0${sourceAlias}`
    : undefined
  if (key !== undefined && nodeModulesOutcomes.has(key)) return nodeModulesOutcomes.get(key)
  const { path: file, error } = resolverFor(conditions, tsconfig, sourceAlias).sync(dir, request)
  // Declaration files carry no runtime and are never a valid resolution.
  const outcome: ResolveOutcome = file
    ? isDeclarationFile(file)
      ? undefined
      : { path: file }
    : error?.includes('is not exported')
      ? { notExported: true }
      : undefined
  if (key !== undefined) nodeModulesOutcomes.set(key, outcome)
  return outcome
}

// oxc applies `extensionAlias` to the target it reads out of a package's
// `exports`/`main` too, where the target is literal — so only a source request
// (relative or absolute, authored against the file its own build emits) gets
// the `.js` -> `.ts` rewrite. Bare specifiers are package lookups.
function isSourceRequest(request: string) {
  return request.startsWith('.') || path.isAbsolute(request)
}

function resolverFor(
  conditions: readonly string[],
  tsconfig: string | undefined,
  sourceExtensionAlias: boolean,
) {
  const key = `${conditions.join(',')}\0${tsconfig ?? ''}\0${sourceExtensionAlias}`
  let resolver = factories.get(key)
  if (!resolver) {
    // cloneWithOptions replaces the option set rather than merging it, so the
    // base options are repeated here; the clone shares the base file-system cache.
    const options: NapiResolveOptions = {
      ...baseOptions(),
      extensionAlias: sourceExtensionAlias ? extensionAlias : {},
      conditionNames: [...conditions],
      mainFields: mainFieldsFor(conditions),
    }
    if (tsconfig) options.tsconfig = { configFile: tsconfig }
    resolver = baseResolver().cloneWithOptions(options)
    factories.set(key, resolver)
  }
  return resolver
}

function baseOptions(): NapiResolveOptions {
  return {
    extensions: configuredExtensions ?? sourceExtensions,
    // Symlink policy is the caller's (see realLinkedPackageFile in imports.ts):
    // pnpm virtual-store paths carry version identity that must not collapse.
    symlinks: false,
  }
}

function baseResolver() {
  baseFactory ??= createResolverFactory(baseOptions())
  return baseFactory
}

// `edge-light`/`browser` are plain package.json main fields in Next/webpack, not
// only `exports` conditions — a package shipping just `main`/`module`/`edge-light`
// must still prefer `edge-light` on the edge layer.
function mainFieldsFor(conditions: readonly string[]) {
  const fields = ['module', 'main']
  if (conditions.includes('browser')) fields.unshift('browser')
  if (conditions.includes('edge-light')) fields.unshift('edge-light')
  return fields
}

function isDeclarationFile(file: string) {
  return /\.d\.[cm]?ts$/.test(file)
}
