import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import {
  probeFile,
  probePackageTarget,
  resolveFrom,
  setEngineExtensions,
  setEngineTsConfigPath,
  splitResourceQuery,
  tsConfigFileFor,
} from './engine'
import { onExtensionHostReset } from '../extensions'

// `Bun` through globalThis: pnext ships TypeScript source, so app compilers without
// bun-types typecheck this file and a bare `Bun` identifier would fail them.
const { Bun: bun } = globalThis as unknown as {
  Bun: { resolveSync(specifier: string, parent: string): string }
}

// Conditions for "is this a local source file" lookups. Ordered to mirror the
// preference a bundler applies, though `exports` key order ultimately decides.
const localConditions = ['source', 'import', 'browser', 'node', 'default', 'require']

/**
 * Override the resolver's extension probe order (next.config `resolveExtensions`).
 * Pass undefined (or []) to restore the built-in source-extension order.
 */
export function setResolveExtensions(extensions: readonly string[] | undefined): void {
  setEngineExtensions(extensions)
  clearVendorPackageResolutions()
}

// B7 (serverExternalPackages / transpilePackages): the node_modules bundle-vs-
// external decision is driven by next.config, which lives in compat. Core keeps
// no static edge into compat, so compat registers the policy here (a setter) and
// core's server compile sites (runtime/modules.ts, runtime/loader.ts) consult it.
export interface ExternalPackagePolicy {
  /** Force-external (never bundle) — serverExternalPackages + built-ins. */
  external: (packageName: string) => boolean
  /** Force-bundle + transpile (incl. node_modules TS/CSS/font) — transpilePackages. */
  transpile: (packageName: string) => boolean
  /**
   * The same rule as a LIST, where one exists: bundler filters need names up front, and probing
   * `transpile` per installed package is expensive. Absent, callers must assume any package may
   * transpile.
   */
  transpiled?: () => readonly string[]
  /** ESM external mode for package exports interop. */
  esmExternals: () => boolean | 'loose'
}

export type ExternalLoadTarget = 'server' | 'edge' | 'client' | 'client-ssr'

export interface ExternalLoadContext {
  root: string
  fromFile: string
  specifier: string
  target: ExternalLoadTarget
}

export type ExternalLoadResolver = (context: ExternalLoadContext) => string | undefined

const noExternalPolicy: ExternalPackagePolicy = {
  external: () => false,
  transpile: () => false,
  esmExternals: () => true,
}
let externalPackagePolicy: ExternalPackagePolicy = noExternalPolicy
let externalLoadResolver: ExternalLoadResolver | undefined

/** Install the compat-driven external/transpile package policy (see B7). */
export function setExternalPackagePolicy(policy: ExternalPackagePolicy | undefined): void {
  externalPackagePolicy = policy ?? noExternalPolicy
}

export function getExternalPackagePolicy(): ExternalPackagePolicy {
  return externalPackagePolicy
}

/** Install an optional concrete-file resolver for external runtime loads. */
export function setExternalLoadResolver(resolver: ExternalLoadResolver | undefined): void {
  externalLoadResolver = resolver
  externalLoadTargets.clear()
}

// Every bare import evaluated by the server runtime reaches the resolve hook, and an external one costs a
// full oxc package resolve there. Keyed on the RESOLUTION ROOT - the only thing the resolver reads out of
// `fromFile` - for the reason `resolveVendorPackageSpecifier` documents: keying on the importer misses on
// nearly every call.
const externalLoadTargets = new Map<string, string | undefined>()

export function resolveExternalLoadTarget(context: ExternalLoadContext): string | undefined {
  if (!externalLoadResolver) return undefined
  // `#imports` resolve from the importer's OWN package, so they are not
  // shareable across a resolution root; they stay uncached.
  if (context.specifier.startsWith('#')) return externalLoadResolver(context)
  const key = `${context.target}\0${resolutionRootForFile(context.root, context.fromFile)}\0${context.specifier}`
  if (externalLoadTargets.has(key)) return externalLoadTargets.get(key)
  const target = externalLoadResolver(context)
  externalLoadTargets.set(key, target)
  return target
}

/** The npm package name owning a bare specifier (`foo/bar` -> `foo`, scoped ok). */
export function packageNameOfSpecifier(specifier: string): string | undefined {
  return packageNameFromSpecifier(specifier)
}

export function packageNameForFile(file: string): string | undefined {
  const packageRoot = nearestPackageRoot(path.dirname(file))
  return packageRoot ? readPackageJson(packageRoot).name : undefined
}

export function externalPackageImportTarget(
  root: string,
  fromFile: string,
  specifier: string,
): string | undefined {
  const packageName = packageNameFromSpecifier(specifier)
  if (!packageName) return undefined
  const policy = getExternalPackagePolicy()
  if (!policy.external(packageName) || policy.esmExternals() !== true) return undefined
  const imported = resolvePackageSpecifier(root, fromFile, specifier, ['import', 'node', 'default'])
  if (!imported || isEsmModuleFile(imported)) return undefined
  const required = resolvePackageSpecifier(root, fromFile, specifier, [
    'require',
    'node',
    'default',
  ])
  return required && required !== imported ? required : undefined
}

interface TsConfig {
  compilerOptions?: {
    baseUrl?: string
    paths?: Record<string, string[]>
  }
}

export function setTsConfigPath(file: string | undefined): void {
  setEngineTsConfigPath(file)
  tsConfigCache.clear()
  clearVendorPackageResolutions()
}

interface PackageJson {
  name?: string
  type?: string
  browser?: string
  main?: string
  module?: string
  source?: string
  exports?: PackageExport
  imports?: Record<string, PackageExport>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  workspaces?: string[] | { packages?: string[] }
}

// Compat (or any bundler extension) registers its bare-specifier to file aliases here (e.g. `next/form` ->
// `src/compat/next/form.tsx`). Core's own route scanner has no static knowledge of those aliases otherwise,
// so a server component importing a 'use client' compat module would never be walked into and its client
// reference would silently be dropped from the page's bundle.
//
// Deliberately NOT folded into resolveImport itself: that function has many callers, most of which treat
// "resolves to a real file" as "is a local, in-root source file", and an alias pointing outside the app root
// would misfire those assumptions. Only the route scanner's own walk needs this fallback.
let extraModuleAliases: Record<string, string> | undefined
// Compat registers these alongside the extension host, so they clear with it.
onExtensionHostReset(() => {
  extraModuleAliases = undefined
  clearVendorPackageResolutions()
})

/** Register extra bare-specifier -> absolute-file aliases for the route scanner. */
export function setModuleAliases(aliases: Record<string, string> | undefined): void {
  extraModuleAliases = aliases
}

/** Bare-specifier alias lookup registered via setModuleAliases, if any. */
export function resolveModuleAlias(specifier: string): string | undefined {
  const aliased = extraModuleAliases?.[specifier]
  return aliased ? probeFile(aliased, localConditions) : undefined
}

/**
 * Resolve a specifier to a LOCAL source file, or undefined when it belongs to
 * an external package. Callers read undefined as "leave this to node/esbuild".
 */
export function resolveImport(root: string, fromFile: string, specifier: string) {
  // A `?query`/`#fragment` resource belongs to its loader chain (turbopack
  // rules, `.wasm?module`): those plugins strip the suffix and resolve the base
  // themselves, and the query is part of the module's identity — so it is never
  // a local resolution here, and the specifier reaches them untouched.
  if (splitResourceQuery(specifier).query) return undefined

  // realpath: a resolution reached through a symlinked shim dir (pages-compat)
  // must collapse to the real app file, or downstream workspace-membership
  // checks misclassify it as external and leave the specifier verbatim.
  if (specifier.startsWith('.')) {
    return resolveLocalFile(path.dirname(realImportPath(fromFile)), specifier)
  }

  if (path.isAbsolute(specifier)) return probeFile(specifier, localConditions)

  const resolutionRoot = resolutionRootForFile(root, fromFile)

  const tsResolved = resolveTsPath(resolutionRoot, specifier)
  if (tsResolved) return realImportPath(tsResolved)

  if (specifier.startsWith('#')) {
    const resolved = resolveLocalFile(resolutionRoot, specifier)
    return resolved ? realImportPath(resolved) : undefined
  }

  const workspaceResolved = resolveWorkspacePackageImport(root, specifier)
  if (workspaceResolved) return workspaceResolved

  return resolveAppTreePackage(resolutionRoot, root, fromFile, specifier)
}

function resolveLocalFile(dir: string, specifier: string) {
  const outcome = resolveFrom(dir, specifier, localConditions)
  return outcome && 'path' in outcome ? outcome.path : undefined
}

// Every specifier of a file re-resolves that file's real path - one syscall per import, now one per
// path. Only successes are cached: a path that does not exist yet may resolve differently once the
// watcher creates it.
const realImportPathCache = new Map<string, string>()

function realImportPath(file: string) {
  const cached = realImportPathCache.get(file)
  if (cached !== undefined) return cached
  try {
    const real = realpathSync(file)
    realImportPathCache.set(file, real)
    return real
  } catch {
    return file
  }
}

// A package vendored inside the app tree (`app/x/node_modules/my-dep`) is local source the bundler and
// scanner must walk into; the project's own node_modules, or anything above it, stays external and resolves
// at runtime. One resolution per (root, directory, specifier) instead of one per import of it: every module
// of a route's bundle asks about the same handful of app-tree packages, and each ask is a full oxc resolve.
// Successes only, exactly as `realImportPath` and `resolveRuntimeSpecifier` do.
const appTreeResolveCache = new Map<string, string>()
// Bisect seam: `PNEXT_RESOLVE_APPTREE_MEMO=0` restores the resolve-per-import path.
// eslint-disable-next-line turbo/no-undeclared-env-vars
const memoAppTree = process.env.PNEXT_RESOLVE_APPTREE_MEMO !== '0'

function resolveAppTreePackage(
  resolutionRoot: string,
  root: string,
  fromFile: string,
  specifier: string,
) {
  const from = path.dirname(path.resolve(fromFile))
  const key = `${resolutionRoot}\0${root}\0${from}\0${specifier}`
  if (memoAppTree) {
    const cached = appTreeResolveCache.get(key)
    if (cached !== undefined) return cached
  }
  const outcome = resolveFrom(from, specifier, localConditions, resolutionRoot)
  if (!outcome || !('path' in outcome)) return undefined
  const resolved = isAppTreeFile(path.resolve(root), outcome.path) ? outcome.path : undefined
  if (memoAppTree && resolved !== undefined) appTreeResolveCache.set(key, resolved)
  return resolved
}

function isAppTreeFile(root: string, file: string) {
  const relative = path.relative(root, file)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false
  const nodeModules = relative.split(path.sep).indexOf('node_modules')
  return nodeModules !== 0
}

/**
 * Resolve a bare specifier ONLY through the configured tsconfig `paths` (and `baseUrl`), returning the
 * absolute source file or undefined. Unlike resolveImport, this never falls through to node_modules,
 * workspace or package lookups - callers such as the client esbuild resolver want tsconfig `paths` to win
 * but everything else to stay on esbuild's native resolution.
 */
export function resolveConfiguredTsPath(
  root: string,
  fromFile: string,
  specifier: string,
): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('#') || path.isAbsolute(specifier)) {
    return undefined
  }
  return resolveTsPath(resolutionRootForFile(root, fromFile), specifier)
}

/**
 * Every `paths` pattern declared by a tsconfig `resolveConfiguredTsPath` can
 * reach from this app: its own root, the workspace root, and each workspace
 * member (an importer outside the app root resolves against its nearest package
 * root). Lets a caller pre-filter specifiers instead of asking per import.
 */
export function configuredTsPathPatterns(root: string, workspaceRoot?: string): string[] {
  const roots = new Set([path.resolve(root)])
  if (workspaceRoot) {
    const resolved = path.resolve(workspaceRoot)
    roots.add(resolved)
    for (const packageRoot of workspacePackages(resolved).values()) roots.add(packageRoot)
  }
  const patterns = new Set<string>()
  for (const dir of roots) {
    for (const pattern of Object.keys(readTsConfig(dir).compilerOptions?.paths ?? {})) {
      patterns.add(pattern)
    }
  }
  return [...patterns]
}

function resolveTsPath(root: string, specifier: string) {
  const compilerOptions = readTsConfig(root).compilerOptions ?? {}
  const baseUrl = path.resolve(root, compilerOptions.baseUrl ?? '.')

  for (const [pattern, targets] of Object.entries(compilerOptions.paths ?? {})) {
    const match = matchPattern(pattern, specifier)
    if (!match) continue
    for (const target of targets) {
      const resolved = probeFile(
        path.resolve(baseUrl, applyPattern(target, match)),
        localConditions,
      )
      if (resolved) return resolved
    }
  }

  return undefined
}

type PackageExport = unknown

/**
 * Resolve a sibling workspace package to its RAW first-party source - the `source`/`src` entries and the
 * on-disk subpath fallback no standard resolver takes, because the published `exports` point at build output
 * that does not exist in a checkout.
 */
function resolveWorkspacePackageImport(root: string, specifier: string) {
  const workspaceRoot = findWorkspaceRoot(root)
  if (!workspaceRoot) return undefined

  const packageName = packageNameFromSpecifier(specifier)
  if (!packageName) return undefined

  const packageRoot = workspacePackages(workspaceRoot).get(packageName)
  if (!packageRoot) return undefined

  const packageJson = readPackageJson(packageRoot)
  const subpath = subpathOfSpecifier(packageName, specifier)
  const exported = packageExportTarget(packageJson.exports, subpath)
  if (exported) {
    const resolved = probePackageTarget(path.resolve(packageRoot, exported), localConditions)
    if (resolved && isInside(packageRoot, resolved)) return resolved
  }

  const onDisk = onDiskSubpath(packageRoot, subpath, localConditions)
  if (onDisk) return onDisk

  for (const entry of [
    packageJson.source,
    packageJson.module,
    packageJson.main,
    './src/index',
    './index',
  ]) {
    if (!entry) continue
    const resolved = probePackageTarget(path.resolve(packageRoot, entry), localConditions)
    if (resolved) return resolved
  }

  return undefined
}

function packageExportTarget(exports: PackageJson['exports'], subpath: string) {
  if (!exports) return undefined
  if (!isSubpathExports(exports)) return subpath === '.' ? packageTargetPath(exports) : undefined

  for (const [pattern, target] of Object.entries(exports)) {
    const match = matchPattern(pattern, subpath)
    if (!match) continue
    const targetPath = packageTargetPath(target)
    if (targetPath) return applyPattern(targetPath, match)
  }

  return undefined
}

function packageExportTargetForConditions(
  exports: PackageJson['exports'],
  subpath: string,
  conditions: readonly string[],
): string | undefined {
  if (!exports) return undefined
  if (!isSubpathExports(exports)) {
    return subpath === '.' ? packageTargetPathForConditions(exports, conditions) : undefined
  }

  for (const [pattern, target] of Object.entries(exports)) {
    const match = matchPattern(pattern, subpath)
    if (!match) continue
    const targetPath = packageTargetPathForConditions(target, conditions)
    if (targetPath) return applyPattern(targetPath, match)
  }

  return undefined
}

function packageTargetPathForConditions(
  target: unknown,
  conditions: readonly string[],
): string | undefined {
  if (!target) return undefined
  if (typeof target === 'string') return target
  if (Array.isArray(target)) {
    for (const item of target) {
      const resolved = packageTargetPathForConditions(item, conditions)
      if (resolved) return resolved
    }
    return undefined
  }

  if (!isPackageExportObject(target)) return undefined

  for (const [key, value] of Object.entries(target)) {
    if (key !== 'default' && !conditions.includes(key)) continue
    const resolved = packageTargetPathForConditions(value, conditions)
    if (resolved) return resolved
  }

  return undefined
}

function isSubpathExports(exports: PackageExport): exports is Record<string, unknown> {
  return isPackageExportObject(exports) && Object.keys(exports).some(key => key.startsWith('.'))
}

function packageTargetPath(target: unknown): string | undefined {
  if (!target) return undefined
  if (typeof target === 'string') return target
  if (Array.isArray(target)) {
    for (const item of target) {
      const resolved = packageTargetPath(item)
      if (resolved) return resolved
    }
    return undefined
  }

  if (!isPackageExportObject(target)) return undefined

  for (const key of ['source', 'import', 'browser', 'node', 'default', 'types', 'require']) {
    const resolved = packageTargetPath(target[key])
    if (resolved) return resolved
  }

  for (const value of Object.values(target)) {
    const resolved = packageTargetPath(value)
    if (resolved) return resolved
  }

  return undefined
}

function isPackageExportObject(target: unknown): target is Record<string, unknown> {
  return typeof target === 'object' && target !== null && !Array.isArray(target)
}

function matchPattern(pattern: string, specifier: string) {
  if (pattern === specifier) return { wildcard: '' }
  const star = pattern.indexOf('*')
  if (star === -1) return undefined
  const prefix = pattern.slice(0, star)
  const suffix = pattern.slice(star + 1)
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return undefined
  return { wildcard: specifier.slice(prefix.length, specifier.length - suffix.length) }
}

function applyPattern(pattern: string, match: { wildcard: string }) {
  return pattern.replace('*', match.wildcard)
}

function packageNameFromSpecifier(specifier: string) {
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined
  return parts[0] || undefined
}

function subpathOfSpecifier(packageName: string, specifier: string) {
  return specifier === packageName ? '.' : `.${specifier.slice(packageName.length)}`
}

/**
 * The directory a bare specifier resolves from — exported so callers can dedupe
 * repeat resolutions on exactly the inputs the resolver reads.
 */
export function resolutionRootForFile(root: string, fromFile: string) {
  const resolvedRoot = path.resolve(root)
  const resolvedFile = path.resolve(fromFile)
  if (isInside(resolvedRoot, resolvedFile)) return resolvedRoot
  return nearestPackageRoot(path.dirname(resolvedFile)) ?? resolvedRoot
}

/**
 * Resolve a bare specifier as the IMPORTING package sees it: from the importer's REAL path, never collapsed
 * to the app root, so a transitive dependency pinned to a version distinct from the hoisted root copy (pnpm
 * virtual store, npm nesting) resolves to that nested copy. The realpath step is load-bearing under pnpm -
 * the symlinked `node_modules/<pkg>` has no sibling deps, but its `.pnpm/<pkg>@ver` real path does. Used only
 * by the server-external vendoring path.
 */
export function resolveNestedPackageFromImporter(
  importerFile: string,
  specifier: string,
  conditions: readonly string[],
): string | undefined {
  const packageName = packageNameFromSpecifier(specifier)
  if (!packageName) return undefined
  const from = path.dirname(realImportPath(path.resolve(importerFile)))
  return realLinkedPackageFile(resolvePackageFrom(from, packageName, specifier, conditions))
}

/**
 * Memoized per directory: the walk is an `existsSync` per level, and every
 * resolve, every `isEsmModuleFile` and every vendor build asks it about the
 * same few thousand node_modules directories.
 */
const packageRoots = new Map<string, string | undefined>()

function nearestPackageRoot(fromDir: string) {
  const start = path.resolve(fromDir)
  if (packageRoots.has(start)) return packageRoots.get(start)
  let dir = start
  const walked: string[] = []
  let found: string | undefined
  while (true) {
    walked.push(dir)
    // Plain existsSync: the walk is memoized per dir, a dirent listing of large
    // node_modules dirs costs more than the one probe it would save.
    if (existsSync(path.join(dir, 'package.json'))) {
      found = dir
      break
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  for (const seen of walked) packageRoots.set(seen, found)
  return found
}

/**
 * Entry resolutions the vendor build already computed, handed to the CJS-interop
 * plugin so its entry-point onResolve never re-resolves a bare specifier.
 */
const vendorEntryProvisions = new Map<string, string>()

export function provideEntryResolution(specifier: string, resolveDir: string, resolved: string) {
  vendorEntryProvisions.set(`${specifier}\0${resolveDir}`, resolved)
}

export function clearProvidedEntryResolutions() {
  vendorEntryProvisions.clear()
}

export function providedEntryResolution(specifier: string, resolveDir: string) {
  return vendorEntryProvisions.get(`${specifier}\0${resolveDir}`)
}

export function resolvePackageSpecifier(
  root: string,
  fromFile: string,
  specifier: string,
  conditions: readonly string[],
): string | undefined {
  const packageName = packageNameFromSpecifier(specifier)
  if (!packageName) return undefined
  const from = resolutionRootForFile(root, fromFile)
  return realLinkedPackageFile(resolvePackageFrom(from, packageName, specifier, conditions))
}

/**
 * `resolvePackageSpecifier` memoized on exactly the inputs the resolver reads. For the VENDOR path
 * only, where a package's installed layout is already treated as immutable for the process (the
 * artifact cache and the plugin source memo both assume it) - the ordinary dev resolver keeps
 * resolving live.
 */
const vendorPackageResolutions = new Map<string, string | undefined>()

export function resolveVendorPackageSpecifier(
  root: string,
  fromFile: string,
  specifier: string,
  conditions: readonly string[],
): string | undefined {
  const packageName = packageNameFromSpecifier(specifier)
  if (!packageName) return undefined
  // Keyed on the RESOLUTION ROOT, not the importer's directory: that is the only thing the resolver
  // reads out of `fromFile`, and one root stands in for the hundreds of importer dirs inside it.
  // Keying on `fromFile` left the memo missing on nearly every call.
  const from = resolutionRootForFile(root, fromFile)
  const key = `${from}\0${specifier}\0${conditions.join(',')}`
  if (vendorPackageResolutions.has(key)) return vendorPackageResolutions.get(key)
  const resolved = realLinkedPackageFile(
    resolvePackageFrom(from, packageName, specifier, conditions),
  )
  vendorPackageResolutions.set(key, resolved)
  return resolved
}

export function clearVendorPackageResolutions() {
  vendorPackageResolutions.clear()
}

/**
 * Drop the memoized app-tree package resolutions. Paired with
 * `clearResolverFsCache` on a structural dev save: a file created or deleted
 * since the last resolve can move an answer this remembered.
 */
export function clearAppTreeResolutions() {
  appTreeResolveCache.clear()
  externalLoadTargets.clear()
}

export function resolvePackageImportSpecifier(
  root: string,
  fromFile: string,
  specifier: string,
  conditions: readonly string[],
): string | undefined {
  if (!specifier.startsWith('#')) return undefined
  const from = nearestPackageRoot(path.dirname(fromFile)) ?? resolutionRootForFile(root, fromFile)
  const outcome = resolveFrom(from, specifier, conditions)
  return outcome && 'path' in outcome ? outcome.path : undefined
}

function resolvePackageFrom(
  from: string,
  packageName: string,
  specifier: string,
  conditions: readonly string[],
) {
  const outcome = resolveFrom(from, specifier, conditions)
  if (outcome && 'path' in outcome) return outcome.path
  const packageRoot = findNodePackageRoot(from, packageName)
  if (!packageRoot) return undefined
  return onDiskSubpath(packageRoot, subpathOfSpecifier(packageName, specifier), conditions)
}

// `exports` blocks deep access, so an on-disk file at the same path is not a
// fallback Node would ever take — but pnext's resolver does take it.
function onDiskSubpath(packageRoot: string, subpath: string, conditions: readonly string[]) {
  if (subpath === '.') return undefined
  const resolved = probePackageTarget(path.resolve(packageRoot, subpath.slice(2)), conditions)
  return resolved && isInside(packageRoot, resolved) ? resolved : undefined
}

const runtimeResolveCache = new Map<string, string>()

/**
 * Bun's own resolution of `specifier` from `dir`, memoized. Source rewrites ask this about a module they are
 * about to hand to Bun (is it a `.cjs`?), so the answer must be Bun's, not the bundler resolver's - but the
 * syscalls behind it repeat across every module of a chain and belong in one cache. Only successes are
 * cached, as with `realImportPath`: a specifier the watcher is about to create must resolve on the next ask.
 */
export function resolveRuntimeSpecifier(dir: string, specifier: string): string | undefined {
  const key = `${dir}\0${specifier}`
  const cached = runtimeResolveCache.get(key)
  if (cached !== undefined) return cached
  try {
    const resolved = bun.resolveSync(specifier, dir)
    runtimeResolveCache.set(key, resolved)
    return resolved
  } catch {
    return undefined
  }
}

const linkedPackageFileCache = new Map<string, string>()

// webpack's `resolve.symlinks: true`: a linked workspace package compiles from
// its real path, as first-party source. Only collapse when the realpath escapes
// node_modules — pnpm's virtual store links within it, and those paths carry
// the version identity nested-dependency pinning needs.
function realLinkedPackageFile(file: string | undefined) {
  if (!file) return file
  const cached = linkedPackageFileCache.get(file)
  if (cached !== undefined) return cached
  let resolved = file
  try {
    const real = realpathSync(file)
    if (!real.includes(`${path.sep}node_modules${path.sep}`)) resolved = real
  } catch {
    /* keep the unresolved path */
  }
  linkedPackageFileCache.set(file, resolved)
  return resolved
}

/**
 * True when the package ships an `exports` map whose matching subpath entry resolves to nothing under
 * `conditions` - the shape Node reports as ERR_PACKAGE_PATH_NOT_EXPORTED. A browser-only module writes this
 * as `{ "./browser": { "browser": "./b.js", "node": null } }`: the subpath exists, but it is deliberately
 * unavailable to a server graph.
 *
 * Callers use it to tell "the package says no" apart from "the package (or the file) is missing", which need
 * very different handling: the former is a runtime error only if the import is actually evaluated, the
 * latter is a real unresolved dependency.
 */
export function isPackageSubpathUnexported(
  root: string,
  fromFile: string,
  specifier: string,
  conditions: readonly string[],
): boolean {
  const packageName = packageNameFromSpecifier(specifier)
  if (!packageName) return false
  const resolutionRoot = resolutionRootForFile(root, fromFile)
  const packageRoot =
    findNodePackageRoot(resolutionRoot, packageName) ??
    findLinkedPackageRoot(resolutionRoot, packageName)
  if (!packageRoot) return false
  const { exports } = readPackageJson(packageRoot)
  if (!exports || !isSubpathExports(exports)) return false
  const subpath = subpathOfSpecifier(packageName, specifier)
  if (!Object.keys(exports).some(pattern => matchPattern(pattern, subpath))) return false
  if (packageExportTargetForConditions(exports, subpath, conditions)) return false
  return !onDiskSubpath(packageRoot, subpath, conditions)
}

/** Resolve a `link:`/`file:`/relative dependency to its checked-out source. */
export function resolveLinkedPackageSpecifier(
  root: string,
  fromFile: string,
  specifier: string,
  conditions: readonly string[],
): string | undefined {
  const packageName = packageNameFromSpecifier(specifier)
  if (!packageName) return undefined
  const packageRoot = findLinkedPackageRoot(resolutionRootForFile(root, fromFile), packageName)
  if (!packageRoot) return undefined
  return realLinkedPackageFile(
    resolvePackageAtRoot(packageRoot, subpathOfSpecifier(packageName, specifier), conditions),
  )
}

function resolvePackageAtRoot(packageRoot: string, subpath: string, conditions: readonly string[]) {
  const packageJson = readPackageJson(packageRoot)
  const exported = packageExportTargetForConditions(packageJson.exports, subpath, conditions)
  if (exported) {
    const resolved = probePackageTarget(path.resolve(packageRoot, exported), conditions)
    if (resolved && isInside(packageRoot, resolved)) return resolved
  }

  const onDisk = onDiskSubpath(packageRoot, subpath, conditions)
  if (onDisk) return onDisk

  const edgeLight = conditions.includes('edge-light')
    ? [(packageJson as Record<string, unknown>)['edge-light']]
    : []
  const browser = conditions.includes('browser') ? [packageJson.browser] : []
  for (const entry of [...edgeLight, ...browser, packageJson.module, packageJson.main, './index']) {
    if (typeof entry !== 'string') continue
    const resolved = probePackageTarget(path.resolve(packageRoot, entry), conditions)
    if (resolved) return resolved
  }

  return undefined
}

function findNodePackageRoot(root: string, packageName: string) {
  let dir = path.resolve(root)
  while (true) {
    const candidate = path.join(dir, 'node_modules', packageName)
    if (existsSync(path.join(candidate, 'package.json'))) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

// One upward directory walk per (root, package) pair instead of one per import
// of it: the manifests it reads are already memoized (packageJsonCache), so the
// walk itself was the cost, repeated for every specifier a route's graph names.
const linkedPackageRootCache = new Map<string, string | undefined>()
// Bisect seam: `PNEXT_RESOLVE_LINK_MEMO=0` restores the walk-per-import path.
// eslint-disable-next-line turbo/no-undeclared-env-vars
const memoLinkedRoots = process.env.PNEXT_RESOLVE_LINK_MEMO !== '0'

function findLinkedPackageRoot(root: string, packageName: string) {
  if (!memoLinkedRoots) return walkForLinkedPackageRoot(root, packageName)
  const key = `${path.resolve(root)}\0${packageName}`
  const cached = linkedPackageRootCache.get(key)
  if (cached !== undefined || linkedPackageRootCache.has(key)) return cached
  const found = walkForLinkedPackageRoot(root, packageName)
  linkedPackageRootCache.set(key, found)
  return found
}

function walkForLinkedPackageRoot(root: string, packageName: string) {
  let dir = path.resolve(root)
  while (true) {
    const linked = linkedPackageRoot(dir, packageName)
    if (linked) return linked
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function linkedPackageRoot(packageRoot: string, packageName: string) {
  const packageJson = readPackageJson(packageRoot)
  const specifier =
    packageJson.dependencies?.[packageName] ??
    packageJson.devDependencies?.[packageName] ??
    packageJson.optionalDependencies?.[packageName] ??
    packageJson.peerDependencies?.[packageName]
  const relative = localDependencyPath(specifier)
  if (!relative) return undefined
  const candidate = path.resolve(packageRoot, relative)
  const linkedPackageJson = readPackageJson(candidate)
  return linkedPackageJson.name === packageName ? candidate : undefined
}

function localDependencyPath(specifier: string | undefined) {
  if (!specifier) return undefined
  for (const prefix of ['link:', 'file:']) {
    if (specifier.startsWith(prefix)) return specifier.slice(prefix.length)
  }
  return specifier.startsWith('./') || specifier.startsWith('../') ? specifier : undefined
}

export function isEsmModuleFile(file: string) {
  const ext = path.extname(file)
  if (ext === '.mjs' || ext === '.mts') return true
  if (ext === '.cjs' || ext === '.cts') return false
  const packageRoot = nearestPackageRoot(path.dirname(file))
  return Boolean(packageRoot && readPackageJson(packageRoot).type === 'module')
}

const esmEntryCache = new Map<string, boolean>()

/**
 * Whether a resolved package entry is really ESM. `isEsmModuleFile` reads only metadata (extension +
 * nearest `package.json#type`), which calls every plain `.js` entry of a package without
 * `"type": "module"` CommonJS - many of which need no inlining and no facade. Extensions stay
 * authoritative (`.cjs`/`.cts` are CommonJS by definition); only the ambiguous `.js` case falls
 * through to the content check.
 */
export function isEsmModuleEntry(file: string) {
  if (isEsmModuleFile(file)) return true
  if (path.extname(file) !== '.js') return false
  const cached = esmEntryCache.get(file)
  if (cached !== undefined) return cached
  let esm = false
  try {
    esm = !isCommonJsModuleSource(readFileSync(file, 'utf8'), file)
  } catch {
    // Unreadable entry: keep the conservative metadata answer.
  }
  esmEntryCache.set(file, esm)
  return esm
}

export function isCommonJsModuleSource(source: string, file: string) {
  const extension = path.extname(file)
  if ((extension !== '.js' && extension !== '.cjs') || isEsmModuleFile(file)) return false
  return !/^\s*(?:import(?:\s|[{'"*])|export(?:\s|[{*]))/m.test(source)
}

export function commonJsModuleHasDefaultExport(source: string, file: string) {
  return (
    isCommonJsModuleSource(source, file) &&
    (/\bexports\.default\s*=/.test(source) || /\bmodule\.exports\s*=/.test(source))
  )
}

export function findWorkspaceRoot(root: string) {
  const key = path.resolve(root)
  if (workspaceRootCache.has(key)) return workspaceRootCache.get(key)

  let dir = key
  while (true) {
    if (readPackageJson(dir).workspaces || existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      workspaceRootCache.set(key, dir)
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) {
      workspaceRootCache.set(key, undefined)
      return undefined
    }
    dir = parent
  }
}

function isInside(root: string, file: string) {
  const relative = path.relative(root, file)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function workspacePackageDirs(root: string) {
  const workspaces = readPackageJson(root).workspaces
  const patterns = [
    ...(Array.isArray(workspaces) ? workspaces : (workspaces?.packages ?? [])),
    ...readPnpmWorkspacePatterns(root),
  ]
  const dirs = new Set<string>()

  for (const pattern of patterns) {
    if (pattern.startsWith('!')) continue
    const star = pattern.indexOf('*')
    if (star === -1) {
      dirs.add(path.resolve(root, pattern))
      continue
    }

    const base = path.resolve(root, pattern.slice(0, star))
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      dirs.add(path.join(base, entry.name, pattern.slice(star + 1)))
    }
  }

  return [...dirs]
}

function readPnpmWorkspacePatterns(root: string) {
  const file = path.join(root, 'pnpm-workspace.yaml')
  if (!existsSync(file)) return []

  const patterns: string[] = []
  let inPackages = false
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    if (/^packages\s*:\s*$/.test(trimmed)) {
      inPackages = true
      continue
    }
    if (!inPackages) continue
    const match = /^-\s*['"]?([^'"]+)['"]?\s*(?:#.*)?$/.exec(trimmed)
    if (match?.[1]) {
      patterns.push(match[1])
      continue
    }
    if (/^\S/.test(line)) break
  }
  return patterns
}

const tsConfigCache = new Map<string, TsConfig>()
const packageJsonCache = new Map<string, PackageJson>()
const workspaceRootCache = new Map<string, string | undefined>()
const workspacePackageCache = new Map<string, Map<string, string>>()

function readTsConfig(root: string) {
  const existing = tsConfigCache.get(root)
  if (existing) return existing
  const file = tsConfigFileFor(root)
  const config = (file ? readJsonc<TsConfig>(file) : undefined) ?? {}
  tsConfigCache.set(root, config)
  return config
}

function readPackageJson(root: string) {
  const existing = packageJsonCache.get(root)
  if (existing) return existing
  const config = readJson<PackageJson>(path.join(root, 'package.json')) ?? {}
  packageJsonCache.set(root, config)
  return config
}

function workspacePackages(root: string) {
  const existing = workspacePackageCache.get(root)
  if (existing) return existing

  const packages = new Map<string, string>()
  for (const dir of workspacePackageDirs(root)) {
    const packageJson = readPackageJson(dir)
    if (packageJson.name) packages.set(packageJson.name, dir)
  }
  workspacePackageCache.set(root, packages)
  return packages
}

const workspaceMembershipCache = new Map<string, boolean>()

/**
 * True when `name` is first-party workspace source. The workspace manifest (bun/npm `workspaces`,
 * pnpm-workspace.yaml) is the only authority - a node_modules symlink is not, since pnpm links every
 * dependency. An app outside the workspace (a checkout linked into it) sees the package only through
 * node_modules, so the package's own real dir is asked about its manifest too.
 */
export function isWorkspacePackage(root: string, name: string): boolean {
  const key = `${path.resolve(root)}\0${name}`
  const cached = workspaceMembershipCache.get(key)
  if (cached !== undefined) return cached

  const workspaceRoot = findWorkspaceRoot(root)
  let member = Boolean(workspaceRoot && workspacePackages(workspaceRoot).has(name))
  if (!member) {
    const packageRoot = findNodePackageRoot(path.resolve(root), name)
    const real = packageRoot ? realImportPath(packageRoot) : undefined
    const linkedRoot = real ? findWorkspaceRoot(real) : undefined
    const declared = linkedRoot ? workspacePackages(linkedRoot).get(name) : undefined
    member = Boolean(declared && realImportPath(declared) === real)
  }

  workspaceMembershipCache.set(key, member)
  return member
}

export function workspacePackageRoots(root: string) {
  return [...workspacePackages(path.resolve(root)).values()].sort()
}

function readJson<T>(file: string) {
  if (!existsSync(file)) return undefined
  return JSON.parse(readFileSync(file, 'utf8')) as T
}

function readJsonc<T>(file: string) {
  if (!existsSync(file)) return undefined
  return JSON.parse(stripTrailingCommas(stripJsonComments(readFileSync(file, 'utf8')))) as T
}

function stripJsonComments(source: string) {
  let output = ''
  let inString = false
  let quote = ''
  let escaped = false

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!
    const next = source[index + 1]

    if (inString) {
      output += char
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === quote) {
        inString = false
      }
      continue
    }

    if (char === '"' || char === "'") {
      inString = true
      quote = char
      output += char
      continue
    }

    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      output += '\n'
      continue
    }

    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/'))
        index += 1
      index += 1
      continue
    }

    output += char
  }

  return output
}

function stripTrailingCommas(source: string) {
  let output = ''
  let inString = false
  let quote = ''
  let escaped = false

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!

    if (inString) {
      output += char
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === quote) {
        inString = false
      }
      continue
    }

    if (char === '"' || char === "'") {
      inString = true
      quote = char
      output += char
      continue
    }

    if (char === ',') {
      let nextIndex = index + 1
      while (/\s/.test(source[nextIndex] ?? '')) nextIndex += 1
      if (source[nextIndex] === '}' || source[nextIndex] === ']') continue
    }

    output += char
  }

  return output
}
