/**
 * Server module loading as the request path sees it. A release answers from its compiled artifacts;
 * only a dev or build compile loads the compiler side (`./modules`, `./loader`), on demand, so a
 * production server never parses it.
 */
import type { CompatAliasTarget, ResolvedConfig } from '../config'
import { setBasePathPrefix, setDefaultPrefetchMode, setTrailingSlashUrls } from '../routing/href'
import type { DevServerModuleOptions } from './modules'
import { productionRelease, releaseModuleHref } from './production'

let modules: Promise<typeof import('./modules')> | undefined
let loader: Promise<typeof import('./loader')> | undefined
const compiler = () => (modules ??= import('./modules'))

export type ServerBundleTarget =
  CompatAliasTarget | 'edge' | 'pages-api' | 'pages-api-edge' | 'pages' | 'pages-edge'

export function serverBundleTargetForRuntime(runtime: string | undefined): ServerBundleTarget {
  return runtime === 'edge' || runtime === 'experimental-edge' ? 'edge' : 'server'
}

export function pagesApiBundleTargetForRuntime(runtime: string | undefined): ServerBundleTarget {
  return runtime === 'edge' || runtime === 'experimental-edge' ? 'pages-api-edge' : 'pages-api'
}

/** The href state server-rendered links read: trailing slashes, basePath, the prefetch default. */
export function applyServerHrefConfig(config: ResolvedConfig) {
  setTrailingSlashUrls(Boolean(config.trailingSlash))
  setBasePathPrefix(typeof config.basePath === 'string' ? config.basePath : '')
  setDefaultPrefetchMode(config.prefetch)
}

/** A release only sets the href state; a compile also registers the loader's Bun plugins. */
export async function registerServerRuntime(config: ResolvedConfig, sourceFiles: string[] = []) {
  if (productionRelease(config)) return applyServerHrefConfig(config)
  ;(await (loader ??= import('./loader'))).registerServerRuntime(config, sourceFiles)
}

export async function devServerModuleHref(
  config: ResolvedConfig,
  file: string,
  version?: string,
  options: DevServerModuleOptions = {},
) {
  const served = productionRelease(config)
  if (served) return releaseModuleHref(served, 'server', options.conditionTarget ?? 'server', file)
  return (await compiler()).devServerModuleHref(config, file, version, options)
}

export async function devClientModuleHref(
  config: ResolvedConfig,
  file: string,
  version?: string,
  serverTarget?: ServerBundleTarget,
) {
  const served = productionRelease(config)
  if (served) return releaseModuleHref(served, 'client', serverTarget ?? 'server', file)
  return (await compiler()).devClientModuleHref(config, file, version, serverTarget)
}

export async function importDevModule<T>(href: string, options?: { warm?: boolean }): Promise<T> {
  return (await compiler()).importDevModule<T>(href, options)
}

let releaseCompile = false

/** Whether this process is compiling a production release. */
export function isReleaseCompile() {
  return releaseCompile
}

/** The flag alone; `setReleaseCompile` in ./modules also resets the compile caches. */
export function setReleaseCompileFlag(enabled: boolean) {
  releaseCompile = enabled
}

// B4/B5: extra esbuild resolve conditions layered onto the server (RSC) vendor
// bundle. Core always applies `react-server` (the server graph IS the RSC
// layer). Compat can add `next-js` (only when cacheComponents is on) via the
// setter. Kept as a module-level seam so core carries no static edge into
// compat's config reader.
let extraServerBundleConditions: (target: ServerBundleTarget) => string[] = () => []

/** Install compat-driven extra vendor-bundle conditions (B5 `next-js`). */
export function setServerBundleConditions(
  factory: ((target: ServerBundleTarget) => string[]) | undefined,
): void {
  extraServerBundleConditions = factory ?? (() => [])
}

export function serverBundleExtraConditions(target: ServerBundleTarget): string[] {
  return extraServerBundleConditions(target)
}

let preplanDrain: (() => Promise<void>) | undefined

/** Installed by the vendor pipeline when it loads; before that no build can be pending. */
export function setPreplanDrain(drain: () => Promise<void>) {
  preplanDrain = drain
}

/** Settle every pre-planned vendor build before anything evaluates. */
export async function drainPreplanBuilds() {
  await preplanDrain?.()
}

let moduleGraphFailure: Error | undefined

export function clearModuleGraphFailure(): void {
  moduleGraphFailure = undefined
}

/**
 * Fail a build even when its renderer converted a module-resolution exception
 * into a 500 response. Rendering may recover from user-code errors, but a
 * missing content-addressed artifact means the build output itself is broken.
 */
export function throwIfModuleGraphFailed(): void {
  if (moduleGraphFailure !== undefined) throw moduleGraphFailure
}

export function noteModuleGraphFailure(error: unknown): void {
  moduleGraphFailure ??= error instanceof Error ? error : new Error(String(error))
}

function isCompiledModuleResolutionError(error: unknown, href: string): boolean {
  const message = error instanceof Error ? error.message : String(error)
  if (!message.includes('Cannot find module')) return false
  return (
    href.includes('/cache/server/') ||
    /[/\\]cache[/\\]server[/\\]/.test(message) ||
    message.includes('/cache/server/')
  )
}

// A module that throws while evaluating stays failed in Bun's registry for the process lifetime, and
// re-importing it surfaces downstream symptoms (a missing bundle entry, TDZ on an export) instead of
// the original error. Record the first failure per compiled href and re-throw THAT on every later
// request. Compiled hrefs are content-addressed, so a save that fixes the module yields a new href
// and the entry is never consulted again.
const moduleEvalErrors = new Map<string, unknown>()

/** Re-throw `href`'s recorded first evaluation error, if any. */
export function throwIfModuleEvalFailed(href: string): void {
  if (moduleEvalErrors.has(href)) throw moduleEvalErrors.get(href)
}

/** Drop `href`'s recorded failure when it is still `error`. */
export function forgetModuleEvalError(href: string, error: unknown): void {
  if (moduleEvalErrors.get(href) === error) moduleEvalErrors.delete(href)
}

/**
 * Import a compiled module, re-throwing its first evaluation error on later imports.
 *
 * Production needs this as much as dev: a re-import resolves with a half-evaluated namespace whose
 * `export const` bindings are still in TDZ, so the render's next read (`module.metadata`) throws
 * `Cannot access 'metadata' before initialization` and that replaces the real error in the response.
 * Prod hrefs are content-addressed too, so the entry keys the same way dev's does.
 */
export async function importModuleOnce<T>(href: string): Promise<T> {
  throwIfModuleEvalFailed(href)
  try {
    return (await import(href)) as T
  } catch (error) {
    if (isCompiledModuleResolutionError(error, href)) noteModuleGraphFailure(error)
    moduleEvalErrors.set(href, error)
    throw error
  }
}
