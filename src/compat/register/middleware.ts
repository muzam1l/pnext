// Middleware extension registration (COMPAT - may import core freely). Registers the build step that
// emits the Next-shaped middleware manifests (middleware-manifest.json +
// functions-config-manifest.json). The middleware runtime itself is the existing proxy machinery; this
// module owns only the build-time manifest output.

import path from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { registerBuildSteps } from '../../extensions'
import { nextCompatEnabled } from '../../compat/aliases'
import {
  findProxyFile,
  proxyExternalLoadTarget,
  type ProxyConfig,
  type ProxyModule,
} from '../../routing/proxy'
import { devServerModuleHref } from '../../runtime/modules'
import { pathToFileHref, type ResolvedConfig } from '../../config'
import { toPosixPath } from '../../utils/fs'
import type { RouteManifestEntry } from '../../types'
import { readMiddlewareWasmBindingsForOutPath } from '../bundler/wasm'
import { preferredRegionForRoute } from '../next/preferred-region'

export function registerMiddlewareExtensions(): void {
  registerBuildSteps(async ({ config, routes }) => {
    if (!nextCompatEnabled(config)) return
    const file = findProxyFile(config)
    let relative: string | undefined
    if (file) {
      // Must name the SAME artifact buildProxyModule emits (the build copies it to
      // .next/server/middleware.js), so every option that keys the compile profile is spelled out here - a
      // divergence would be a second full compile of the proxy AND a manifest entrypoint pointing at a copy
      // the build never emitted. Same href, so this joins that build's promise.
      const href = await devServerModuleHref(config, file, 'prod', {
        conditionTarget: 'edge',
        externalLoadTarget: proxyExternalLoadTarget(file),
        reactServerLayer: true,
      })
      relative = toPosixPath(path.relative(config.outPath, fileURLToPath(href)))
    }
    // Edge-runtime segments produce manifest entries even with no middleware.
    await writeMiddlewareManifests(config, relative, routes as RouteManifestEntry[])
  })
}

// Middleware manifest emission.
//
// Writes the two Next-shaped manifests a few suites read directly from the build output:
//   - `<out>/server/middleware-manifest.json`: the edge-middleware entry with its compiled matchers,
//     entrypoint and files list.
//   - `<out>/server/functions-config-manifest.json`: the node-runtime variant, when the middleware opts
//     into `runtime: 'nodejs'`.
//
// Only the fields the tests read are populated. A pure-core app writes neither.

interface ManifestMatcher {
  regexp: string
  originalSource: string
}

interface MiddlewareEntry {
  name: string
  page: string
  matchers: ManifestMatcher[]
  wasm: { name: string; filePath: string }[]
  assets: never[]
  files: string[]
  entrypoint: string
  env: Record<string, string>
}

interface MiddlewareManifest {
  version: number
  sortedMiddleware: string[]
  middleware: Record<string, MiddlewareEntry>
  functions: Record<string, unknown>
}

interface FunctionsConfigManifest {
  version: number
  functions: Record<string, { runtime: string; matchers: ManifestMatcher[] }>
}

/**
 * Emit the middleware manifests for the resolved proxy file, if any. `entryFile`
 * is the compiled proxy module path (relative to `outPath`, posix) produced by
 * the build; it is recorded as the manifest `entrypoint` under `server/`.
 */
export async function writeMiddlewareManifests(
  config: ResolvedConfig,
  entryFile: string | undefined,
  routes: RouteManifestEntry[] = [],
): Promise<void> {
  const source = findProxyFile(config)
  // Edge-runtime app segments are manifest `functions` entries alongside the
  // middleware, keyed by their app path (route groups included) — an app with
  // an edge page and no middleware still writes the manifest for them.
  const functions = edgeFunctionEntries(config, routes)
  if (!source || !entryFile) {
    if (Object.keys(functions).length === 0) return
    const serverDir = path.join(config.outPath, 'server')
    await mkdir(serverDir, { recursive: true })
    await writeFile(
      path.join(serverDir, 'middleware-manifest.json'),
      `${JSON.stringify({ ...emptyMiddlewareManifest(), functions }, null, 2)}\n`,
    )
    return
  }

  const moduleFile = path.resolve(config.outPath, entryFile)
  const module = (await import(pathToFileHref(moduleFile))) as ProxyModule
  const matchers = manifestMatchers(module.config)
  const runtime = proxyRuntime(module.config)
  const entrypoint = toServerEntrypoint(entryFile)

  const serverDir = path.join(config.outPath, 'server')
  await mkdir(serverDir, { recursive: true })

  if (runtime === 'nodejs') {
    const functionsConfig: FunctionsConfigManifest = {
      version: 1,
      functions: { '/_middleware': { runtime: 'nodejs', matchers } },
    }
    await writeFile(
      path.join(serverDir, 'functions-config-manifest.json'),
      `${JSON.stringify(functionsConfig, null, 2)}\n`,
    )
    // A node-runtime middleware still lists an empty edge middleware manifest so
    // consumers that always read it find a valid (empty) shape.
    await writeFile(
      path.join(serverDir, 'middleware-manifest.json'),
      `${JSON.stringify({ ...emptyMiddlewareManifest(), functions }, null, 2)}\n`,
    )
    return
  }

  const entry: MiddlewareEntry = {
    name: 'middleware',
    page: '/',
    matchers,
    wasm: readMiddlewareWasmBindingsForOutPath(config.outPath),
    assets: [],
    files: [entrypoint],
    entrypoint,
    env: {},
  }
  const manifest: MiddlewareManifest = {
    version: 3,
    sortedMiddleware: ['/'],
    middleware: { '/': entry },
    functions,
  }
  await writeFile(
    path.join(serverDir, 'middleware-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
}

function emptyMiddlewareManifest(): MiddlewareManifest {
  return { version: 3, sortedMiddleware: [], middleware: {}, functions: {} }
}

/**
 * Manifest `functions` entries for app segments that declared
 * `export const runtime = 'edge'`. Next keys them by the segment's app path
 * (route groups kept, e.g. `/(group)/group/page`) and records the URL the
 * segment answers as its matcher.
 */
function edgeFunctionEntries(
  config: ResolvedConfig,
  routes: RouteManifestEntry[],
): Record<string, unknown> {
  const entries: Record<string, unknown> = {}
  if (!config.appPath) return entries
  for (const route of routes) {
    const runtime = route.segmentConfig?.runtime
    if (runtime !== 'edge' && runtime !== 'experimental-edge') continue
    const page = appManifestKey(config.appPath, route.file)
    if (!page) continue
    const regions = preferredRegionForRoute(route)
    entries[page] = {
      files: [],
      name: `app${page}`,
      page,
      matchers: [{ regexp: `^${routeMatcherRegexp(route.route)}$`, originalSource: route.route }],
      wasm: [],
      assets: [],
      env: {},
      ...(regions ? { regions } : {}),
    }
  }
  return entries
}

// `<app>/(group)/group/page.tsx` → `/(group)/group/page`.
function appManifestKey(appPath: string, file: string): string | undefined {
  const relative = toPosixPath(path.relative(appPath, file))
  if (!relative || relative.startsWith('..')) return undefined
  return `/${relative.replace(/\.[^./]+$/, '')}`
}

// The URL regexp Next records for a segment: literal path with each dynamic
// segment widened to a single path part.
function routeMatcherRegexp(route: string): string {
  return route.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&').replace(/:([^/\\]+)/g, '[^/]+')
}

// Compile config.matcher entries into { regexp, originalSource } pairs. With no
// matcher, the middleware runs on every path: Next records the `/:path*` source
// and its `^/.*$` regexp.
function manifestMatchers(config: ProxyConfig | undefined): ManifestMatcher[] {
  const matcher = config?.matcher
  if (!matcher) return [{ regexp: '^/.*$', originalSource: '/:path*' }]
  const list = Array.isArray(matcher) ? matcher : [matcher]
  return list.map(item => {
    const originalSource = typeof item === 'string' ? item : item.source
    return { regexp: `^${matcherRegexp(originalSource)}$`, originalSource }
  })
}

// Mirror src/proxy.ts matcherPattern for the manifest regexp string (kept in
// sync with the runtime matcher). Raw regex sources pass through unchanged.
function matcherRegexp(matcher: string): string {
  if (matcher.includes('(')) return matcher
  if (matcher === '/') return '/'
  let source = ''
  for (const segment of matcher.split('/').filter(Boolean)) {
    if (/^:[^/]+\*$/.test(segment)) source += '(?:/.*)?'
    else if (/^:[^/]+$/.test(segment)) source += '/[^/]+'
    else source += `/${segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
  }
  return source || '/'
}

function proxyRuntime(config: ProxyConfig | undefined): 'edge' | 'nodejs' {
  const runtime = (config as { runtime?: unknown } | undefined)?.runtime
  return runtime === 'nodejs' ? 'nodejs' : 'edge'
}

// Record the compiled entry under the `server/` prefix Next uses, forcing a
// `.js` extension (the manifest tests assert `^server/.+\.(js|mjs|cjs)$`).
function toServerEntrypoint(entryFile: string): string {
  const posix = toPosixPath(entryFile).replace(/^\.?\//, '')
  const withinServer = posix.startsWith('server/') ? posix : `server/${path.posix.basename(posix)}`
  return withinServer.replace(/\.[^./]+$/, '.js')
}
