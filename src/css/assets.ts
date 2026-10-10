/**
 * Built-asset naming and the CSS-module runtime: what a render needs to link stylesheets. The CSS
 * compiler lives in `./build`; a production server never loads it.
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { getCssExtensions } from '../extensions'
import { nextCompatEnabled } from '../render/hooks'
import { productionRelease } from '../runtime/production'
import { hashedAssetName } from '../utils/asset-hash'
import { cssModuleScopePath, ensureDir, readText } from '../utils/fs'
import type { ResolvedConfig } from '../config'
import type { RouteManifestEntry } from '../types'

let build: Promise<typeof import('./build')> | undefined

export async function globalCssHref(config: ResolvedConfig) {
  const sources =
    productionRelease(config)?.globalCss ??
    (await (build ??= import('./build'))).globalCssSources(config)
  return sources.length > 0 ? assetHref(config, 'global.css') : undefined
}

export type AssetHrefConfig = Pick<ResolvedConfig, 'assetPrefix' | 'compat' | 'outPath'>

/**
 * Logical build-asset name -> the content-hashed name the build actually emitted
 * (`global.css` -> `global-1f4a9c2b3d5e6f70.css`). A production asset name must
 * carry its content, or the URL cannot honestly be served `immutable`: the same
 * name would answer different bytes after a deploy.
 *
 * Keyed by outPath, never process-global: one process builds several apps (the
 * test suite does it constantly) and their names must not cross. Empty in dev,
 * where names stay flat and every asset is served `no-cache` anyway.
 */
const emittedAssets = new Map<string, Map<string, string>>()

export function recordEmittedAsset(outPath: string, logical: string, emitted: string): void {
  const names = emittedAssets.get(outPath) ?? new Map<string, string>()
  names.set(logical, emitted)
  emittedAssets.set(outPath, names)
}

/** Re-publish the build's name map at server boot (see BuildManifest.assetNames). */
export function publishEmittedAssets(
  outPath: string,
  names: Record<string, string> | undefined,
): void {
  if (!names) return
  for (const [logical, emitted] of Object.entries(names))
    recordEmittedAsset(outPath, logical, emitted)
}

export function emittedAssetNames(outPath: string): Record<string, string> {
  return Object.fromEntries(emittedAssets.get(outPath) ?? [])
}

export function clearEmittedAssets(outPath: string): void {
  emittedAssets.delete(outPath)
}

/** The file name a logical asset name resolves to. Identity until a build records one. */
export function emittedAssetName(
  config: Pick<ResolvedConfig, 'outPath'> | undefined,
  name: string,
): string {
  if (!config?.outPath) return name
  return emittedAssets.get(config.outPath)?.get(name) ?? name
}

// Where a built asset lives in the URL space. next-compat serves the build output under Next's
// static path, so a compat app's document references its CSS/JS exactly as Next does; core keeps
// `/assets/`. Every document-emitted build-asset URL goes through here (and the dev/prod servers
// accept both spellings), so an emitted href can never name a path the server will not serve —
// including the content hash the production name carries.
export function assetPathname(
  config: Pick<ResolvedConfig, 'compat' | 'outPath'> | undefined,
  name: string,
) {
  const emitted = emittedAssetName(config, name)
  return nextCompatEnabled(config ?? {}) ? `/_next/static/${emitted}` : `/assets/${emitted}`
}

export function assetHref(config: AssetHrefConfig | undefined, name: string) {
  return withAssetPrefix(config, assetPathname(config, name))
}

// A route's built CSS filenames - the one rule behind the document's links, the
// inline-CSS path and analyze, so no consumer can disagree about whether a
// route has CSS. compat cssChunking records split names in cssAssets.
export function routeCssAssetNames(
  route: Pick<RouteManifestEntry, 'id' | 'cssImports' | 'cssAssets'>,
): string[] {
  if (route.cssImports.length === 0) return []
  return route.cssAssets?.length ? route.cssAssets : [`${route.id}.css`]
}

export function routeCssHref(
  route: RouteManifestEntry,
  config?: AssetHrefConfig,
): string | string[] | undefined {
  const assets = routeCssAssetNames(route)
  if (assets.length === 0) return undefined
  return assets.map(asset => assetHref(config, asset))
}

/**
 * Put a render's next/font rules in the first stylesheet chunk, matching Next's
 * linked CSS delivery without changing the rest of the route's chunk order.
 */
export async function emitFontCssStylesheet(
  config: ResolvedConfig,
  routeId: string,
  fontCss: string,
  baseAsset: string | undefined,
  options: { dev: boolean },
) {
  const outDir = path.join(config.outPath, options.dev ? 'cache' : 'static', 'assets')
  await ensureDir(outDir)
  const baseFile = baseAsset ? path.join(outDir, baseAsset) : undefined
  const baseCss = baseFile && existsSync(baseFile) ? await readFile(baseFile, 'utf8') : ''
  const contents = [fontCss, baseCss].filter(Boolean).join('\n')
  const logicalName = baseAsset
    ? baseAsset.replace(/-[0-9a-f]{16}(?=\.css$)/, '')
    : `${routeId}.css`
  const name = hashedAssetName(logicalName, contents)
  const file = path.join(outDir, name)
  if (!existsSync(file) || (await readFile(file, 'utf8')) !== contents)
    await writeFile(file, contents)
  return name
}

// Prepend the configured assetPrefix (a CDN origin or path) to an app-absolute
// asset URL. Link hrefs use basePath instead and must NOT go through here.
export function withAssetPrefix(
  config: Pick<ResolvedConfig, 'assetPrefix'> | undefined,
  href: string,
) {
  const prefix = config?.assetPrefix
  if (!prefix) return href
  return `${prefix.replace(/\/$/, '')}${href}`
}

let cssRuntimeRegistered = false

export function registerCssRuntime() {
  if (cssRuntimeRegistered) return
  cssRuntimeRegistered = true

  Bun.plugin({
    name: 'pnext-css-runtime',
    setup(plugin) {
      plugin.onLoad({ filter: /\.(?:css|scss|sass)$/ }, async ({ path: file }) =>
        isCssModuleFile(file)
          ? {
              exports: { default: await cssModuleMapping(file) },
              loader: 'object',
            }
          : {
              contents: 'export default undefined;',
              loader: 'js',
            },
      )
    },
  })
}

// Sass is unsupported (no compiler); its imports still must not break the
// bundle, so .scss/.sass load as empty modules with module class-name maps.
export function isCssModuleFile(file: string) {
  return /\.module\.(?:css|scss|sass)$/.test(file)
}

export async function cssModuleMapping(file: string) {
  // Compat handles *.module.{scss,sass} (sass compiles + scopes); core keeps
  // plain .module.css. Lazy read: the registry populates at compat bootstrap.
  const compatMapping = getCssExtensions().resolveCssModule(file)
  if (compatMapping) return compatMapping
  const source = await readText(file)
  const classNames = cssClassNames(source)

  return Object.fromEntries(
    [...classNames].map(className => [className, cssModuleClassName(file, className)]),
  )
}

export function cssClassNames(source: string) {
  const classNames = new Set<string>()
  const classPattern = /(^|[^\\])\.(-?[_a-zA-Z][\w-]*)/g
  let match: RegExpExecArray | null

  while ((match = classPattern.exec(source))) {
    if (match[2]) classNames.add(match[2])
  }

  return classNames
}

export function cssModuleClassName(file: string, className: string) {
  const base = path
    .basename(file)
    .replace(/\.module\.css$/, '')
    .replace(/[^_a-zA-Z0-9]/g, '_')
  const hash = pathHash(cssModuleScopePath(file))
  return `${base}_${className}_${hash}`
}

function pathHash(file: string) {
  let hash = 5381
  for (const char of file) hash = ((hash << 5) + hash) ^ char.charCodeAt(0)
  return (hash >>> 0).toString(36).slice(0, 5)
}
