// Build-time validation pass (COMPAT - may import core freely).
//
// One route-tree + module-graph scan emitting Next-compatible build-error strings. Runs as a build
// step; a validation failure throws, which aborts `pnext build` - exactly what the Next e2e suites
// assert (`next build` FAILS with a specific message, substring-matched from stderr).
//
// The pass reads ONLY the scanned route table plus route source files on disk. It never renders.
// Checks: missing root layout; an app/ page conflicting with a pages/ file; two parallel
// (route-group) pages resolving to the same path; useSearchParams() without a Suspense boundary;
// undefined/non-component default export; and the output:'export' extras (exportPathMap + app, a
// dynamic route without generateStaticParams, route handlers without static opt-ins, force-dynamic).

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { ResolvedConfig } from '../../config'
import { extraPageExtensions } from '../../extensions'
import type { RouteManifestEntry } from '../../types'
import { legacyRequestAPIs } from '../../request/context'
import { getNextConfig } from '../next/config-loader'
import { stripComments } from '../../utils/code'
import {
  conflictingAppAndPageMessage,
  conflictingParallelPagesMessage,
  dynamicForceDynamicWithExportMessage,
  forceDynamicPageWithExportMessage,
  exportPathMapWithAppDirMessage,
  incompatibleCacheComponentsSegmentConfigMessage,
  missingDefaultParallelRouteMessage,
  missingGenerateStaticParamsForExportMessage,
  missingRootLayoutMessage,
  missingSuspenseWithCsrBailoutMessage,
  routeHandlerNotStaticWithExportMessage,
  undefinedDefaultExportMessage,
  unresolvedCodemodCommentMessage,
} from './errors'

const BASE_PAGE_EXTENSIONS = ['tsx', 'ts', 'jsx', 'js', 'mjs'] as const

/**
 * A build-error the validation pass surfaces. Carries only Next's message; the
 * build's catch surfaces `.message` to stderr, where the harness greps it.
 */
export class PnextBuildValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PnextBuildValidationError'
  }
}

/**
 * Run every validation check; throws PnextBuildValidationError on the first
 * failure. Fully synchronous: every check reads through `readSource`, so the
 * pass never yields and each file is read at most once.
 */
export function validateBuild(config: ResolvedConfig, routes: RouteManifestEntry[]): void {
  sourceCache.clear()
  const pageRoutes = routes.filter(route => route.kind === 'page' && !route.interception)

  // Warnings first: Next surfaces them while compiling, i.e. BEFORE any
  // app-structure error aborts the build. An app that trips both (the
  // invalid-reexport fixture has no root layout at all) must still show them.
  warnBuildDiagnostics(config, routes)
  validateRootLayout(config, pageRoutes)
  validateAppPagesConflict(config)
  validateParallelPageConflicts(config, pageRoutes)
  validateMissingSlotDefaults(config, routes)
  validateCodemodComments(routes)
  validateDefaultExports(config, routes)
  validateSearchParamsSuspense(config, pageRoutes)
  validateUseCacheDirectives(config, routes)
  validateUseCacheSearchParams(routes)
  validateUseCacheHangingInputs(routes)
  validateCacheComponentsSegmentConfigs(config, routes)
  validateInstantStaticShells(config, routes)
  validateClientSegmentConfigs(config, routes)
  validateImageLoaderFile(config)
  validateStaticImageImports(config, routes)
  validateExportMode(config, routes)
}

function validateInstantStaticShells(config: ResolvedConfig, routes: RouteManifestEntry[]): void {
  if (!cacheComponentsIsEnabled()) return
  for (const route of routes) {
    if (route.kind !== 'page') continue
    const pageSource = readSource(route.file)
    if (!pageSource || !/\bexport\s+const\s+unstable_instant\s*=\s*false\b/.test(pageSource))
      continue
    if (!/\bconnection\s*\(/.test(pageSource)) continue
    const staticParent = layoutChain(config.appPath, route.file).some(file => {
      const source = readSource(file)
      return Boolean(source && /\bexport\s+const\s+unstable_instant\s*=\s*true\b/.test(source))
    })
    if (!staticParent) continue
    throw new PnextBuildValidationError(
      `Error occurred during prerendering page "${route.route || '/'}": Next.js encountered uncached data during prerendering.`,
    )
  }
}

function validateUseCacheHangingInputs(routes: RouteManifestEntry[]): void {
  if (!cacheComponentsIsEnabled()) return
  const failures: string[] = []
  const timeout =
    'Filling a cache during prerender timed out, likely because request-specific arguments such as params, searchParams, cookies() or dynamic data were used inside "use cache".'
  for (const route of routes) {
    if (route.kind !== 'page') continue
    const source = readSource(route.file)
    if (!source || useCacheDirectives(source).length === 0) continue
    const routePath = nextPagePath(route)
    const thrown = /\bthrow\s+new\s+Error\(\s*['"]([^'"]+)['"]\s*\)/.exec(source)
    // Only a throw the PRERENDER would execute fails the build. A page that
    // reads request data outside its cache scopes never prerenders, so its
    // throw surfaces as a runtime error log instead (use-cache-runtime-error /
    // use-cache-catch-error both `await connection()` before the cached call).
    if (thrown?.[1] && !readsRequestDataOutsideCache(source)) {
      failures.push(
        `Error occurred prerendering page "${routePath}". Read more: https://nextjs.org/docs/messages/prerender-error\nError: ${thrown[1]}`,
      )
      continue
    }
    // Only an await of a hanging input INSIDE a cache scope hangs the fill; an
    // `await params` outside the cached function resolves normally (e.g. under
    // a Suspense boundary during a fallback-shell prerender) and only plain
    // values cross the cache boundary. Scope the heuristic to cache bodies.
    // Private scopes never hang the build: they are excluded from prerenders
    // entirely (evaluated per-request), so only shared cache bodies count.
    const scoped = useCacheScopedSource(source).filter(scope => scope.kind !== 'private')
    // `await params` inside a cache scope only hangs when the params can never resolve during the
    // prerender. With generateStaticParams the concrete prerenders pass resolved params (they join the
    // cache key) and the fallback-shell prerender aborts the fill to a dynamic hole, so the heuristic
    // must not flag them.
    //
    // A hanging input awaited from the cached function's OWN parameters is the legitimate
    // runtime-prefetch pattern: the page awaits `params`/searchParams outside the cache and passes the
    // promise IN as a vary key. Only a closed-over page-level `params`/promise still hangs, so exempt
    // the scope's declared parameters.
    const isHangingInput = (ident: string): boolean =>
      ident === 'promise' ||
      /^[A-Za-z_$][\w$]*Promise$/.test(ident) ||
      (!route.hasStaticParams && ident === 'params')
    const hangs = scoped.some(scope => {
      const params = new Set(scope.params)
      return awaitedIdentifiers(scope.body).some(
        ident => isHangingInput(ident) && !params.has(ident),
      )
    })
    // The exemption above (a cached function awaiting its OWN parameter) only holds when the CALLER
    // passes something that resolves during the prerender. Passing an uncached promise IN
    // (`<Foo promise={fetchData()} />`, `indirection(getUncachedData())`) is the hanging-input
    // violation: the fill waits on request-time IO a prerender never resolves. Detect it at the cached
    // function's call sites. A value produced by ANOTHER cached function resolves from the cache
    // during the prerender, so only calls into uncached code count.
    const cachedNames = new Set(scoped.map(scope => scope.name).filter(name => name !== ''))
    // A REQUEST-BOUND promise (`cookies()`, `headers()`, a `next/root-params` accessor) is not a
    // hanging input either: such a page never statically prerenders - the request API postpones the
    // boundary and the route builds as runtime-prefetchable/dynamic - so the fill resolves from
    // request data instead of hanging.
    const exemptNames = new Set([...cachedNames, ...requestApiNames(source)])
    const receivesUncachedPromise = scoped.some(
      scope =>
        scope.name !== '' &&
        scope.params.length > 0 &&
        passesUncachedPromiseInto(source, scope.name, exemptNames),
    )
    if (!hangs && !receivesUncachedPromise) continue
    failures.push(
      `${timeout}\nError occurred prerendering page "${routePath}". Read more: https://nextjs.org/docs/messages/prerender-error`,
    )
  }
  if (failures.length > 0) throw new PnextBuildValidationError(failures.join('\n\n'))
}

function validateUseCacheSearchParams(routes: RouteManifestEntry[]): void {
  if (!cacheComponentsIsEnabled()) return
  const failures: string[] = []
  for (const route of routes) {
    if (route.kind !== 'page') continue
    const source = readSource(route.file)
    if (!source || useCacheDirectives(source).length === 0) continue
    // Only an await INSIDE a shared cache scope is the E842 violation. A
    // `use cache: private` scope MAY read searchParams (it is excluded from
    // prerenders and evaluated per-request), and an await outside any cache
    // body is an ordinary dynamic read.
    const scoped = useCacheScopedSource(source).filter(scope => scope.kind !== 'private')
    // Awaiting `searchParams` that is the cached function's OWN parameter is the
    // legal runtime-prefetch pattern (the page passes the searchParams promise
    // into `publicCache(searchParams)` as a vary key). Only a closed-over
    // page-level `searchParams` read is the E842 violation.
    const violates = scoped.some(scope => {
      const params = new Set(scope.params)
      return awaitedIdentifiers(scope.body).some(
        ident => ident === 'searchParams' && !params.has(ident),
      )
    })
    if (!violates) continue
    const routePath = route.route || '/'
    failures.push(
      `Route ${routePath} used \`searchParams\` inside "use cache". Accessing dynamic request data inside a cache scope is not supported. ` +
        'If you need some search params inside a cached function await `searchParams` outside of the cached function and pass only the required search params as arguments to the cached function. ' +
        'See more info here: https://nextjs.org/docs/messages/next-request-in-use-cache\n' +
        `Error occurred prerendering page "${routePath}"`,
    )
  }
  if (failures.length > 0) throw new PnextBuildValidationError(failures.join('\n\n'))
}

function validateClientSegmentConfigs(config: ResolvedConfig, routes: RouteManifestEntry[]): void {
  for (const route of routes) {
    if (route.kind !== 'page') continue
    const source = readSource(route.file)
    if (!source || !hasDirective(source, 'use client')) continue
    if (/\bexport\s+const\s+unstable_instant\b/.test(source)) {
      throw new PnextBuildValidationError(
        `"unstable_instant" is a route segment config and can only be used when the segment is a Server Component module. Remove the "use client" directive`,
      )
    }
    if (
      getNextConfig().output === 'export' &&
      /\bexport\s+(?:async\s+)?function\s+generateStaticParams\b/.test(source)
    ) {
      throw new PnextBuildValidationError(
        `Page "/${appDirRelativeFile(config, route.file).replace(/\.[^.]+$/, '')}" cannot use both "use client" and export function "generateStaticParams()".`,
      )
    }
  }
}

function validateImageLoaderFile(config: ResolvedConfig): void {
  const images = getNextConfig().images
  if (!images || typeof images !== 'object' || Array.isArray(images)) return
  const loaderFile = (images as Record<string, unknown>).loaderFile
  if (typeof loaderFile !== 'string' || loaderFile.length === 0) return
  const file = path.resolve(config.root, loaderFile)
  const source = readSource(file)
  if (source && /\bexport\s+default\b|\bmodule\.exports\s*=/.test(source)) return
  throw new PnextBuildValidationError(
    'images.loaderFile detected but the file is missing default export.\n' +
      'Read more: https://nextjs.org/docs/messages/invalid-images-config',
  )
}

function validateStaticImageImports(config: ResolvedConfig, routes: RouteManifestEntry[]): void {
  const seen = new Set<string>()
  for (const route of routes) {
    for (const file of routeFiles(route)) {
      if (seen.has(file)) continue
      seen.add(file)
      if (!isAppSourceFile(config, file)) continue
      const source = readSource(file)
      if (!source) continue
      // Comment-stripped: a commented-out image import (or a doc-comment example) is not an
      // import, and webpack under Next would never error on one.
      const imports = stripComments(source).matchAll(
        /\bimport\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+\.(?:png|jpe?g|gif|webp|avif|ico|bmp|svg))['"]/gi,
      )
      for (const match of imports) {
        const specifier = match[1]!
        if (!specifier.startsWith('.')) continue
        if (existsSync(path.resolve(path.dirname(file), specifier))) continue
        throw new PnextBuildValidationError(
          `Module not found: Can't resolve '${specifier}'\n./app/${appDirRelativeFile(config, file)}`,
        )
      }
    }
  }
}

function warnBuildDiagnostics(config: ResolvedConfig, routes: RouteManifestEntry[]): void {
  const nextConfig = getNextConfig()
  const experimental = nextConfig.experimental as Record<string, unknown> | undefined
  if (hasBabelConfig(config.root) && experimental?.forceSwcTransforms !== true) {
    console.warn('Disabled SWC as replacement for Babel because of custom Babel configuration')
  }
  if (
    !legacyRequestAPIs() &&
    typeof nextConfig.outputFileTracingRoot !== 'string' &&
    !(
      nextConfig.turbopack &&
      typeof nextConfig.turbopack === 'object' &&
      typeof (nextConfig.turbopack as Record<string, unknown>).root === 'string'
    )
  ) {
    warnMultipleLockfiles(config.root)
  }

  let warnedEdgeRuntime = false
  for (const file of new Set(routes.flatMap(route => routeFiles(route)))) {
    if (!isAppSourceFile(config, file)) continue
    const source = readSource(file)
    if (!source) continue
    if (!warnedEdgeRuntime && /\bruntime\s*=\s*['"](?:edge|experimental-edge)['"]/.test(source)) {
      console.warn('The Edge Runtime is deprecated. You can use the "nodejs" runtime instead.')
      warnedEdgeRuntime = true
    }
    for (const key of ['runtime', 'preferredRegion'] as const) {
      if (new RegExp(`\\bexport\\s*\\{[^}]*\\b${key}\\b[^}]*\\}\\s*from\\s*['"]`).test(source)) {
        console.warn(
          `Next.js can't recognize the exported \`${key}\` field in ${toPosix(path.relative(config.root, file))}`,
        )
      }
    }
  }
}

function hasBabelConfig(root: string): boolean {
  return [
    '.babelrc',
    '.babelrc.json',
    '.babelrc.js',
    '.babelrc.cjs',
    'babel.config.js',
    'babel.config.cjs',
  ].some(name => existsSync(path.join(root, name)))
}

function warnMultipleLockfiles(root: string): void {
  // A configured `outputFileTracingRoot` is authoritative — Next stays silent.
  if (typeof getNextConfig().outputFileTracingRoot === 'string') return
  const lockfiles: string[] = []
  let current = root
  while (true) {
    for (const name of [
      'package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      'bun.lock',
      'bun.lockb',
    ]) {
      const file = path.join(current, name)
      if (existsSync(file)) lockfiles.push(file)
    }
    // A `pnpm-workspace.yaml` marks the definitive workspace root: stop the walk
    // there (nothing above it belongs to this project), but still report what was
    // collected — a lockfile written between the app and the workspace root is
    // exactly the ambiguity Next warns about.
    if (existsSync(path.join(current, 'pnpm-workspace.yaml'))) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  // The ambiguity is about DIRECTORIES: two lockfiles side by side in one
  // directory still name a single root.
  const dirs = [...new Set(lockfiles.map(file => path.dirname(file)))]
  if (dirs.length < 2) return
  // Next selects the closest lockfile's directory as the root and lists the rest.
  const selected = dirs[0]
  const additional = lockfiles.filter(file => path.dirname(file) !== selected)
  console.warn(
    '⚠ Warning: Next.js inferred your workspace root, but it may not be correct.\n' +
      ` We detected multiple lockfiles and selected the directory of ${selected} as the root directory.\n` +
      " To silence this warning, set `outputFileTracingRoot` in your Next.js config, or consider removing one of the lockfiles if it's not needed.\n" +
      '   See https://nextjs.org/docs/app/api-reference/config/next-config-js/output#caveats for more information.\n' +
      ' Detected additional lockfiles: \n' +
      additional.map(file => `   * ${file}`).join('\n'),
  )
}

/**
 * One read per file per build. A dozen validators walk the same route files, and `route.sourceFiles`
 * is the route's whole graph, so a shared layout's modules appear in every route's list. A build
 * never sees its sources change under it.
 */
const sourceCache = new Map<string, string | undefined>()

function readSource(file: string): string | undefined {
  if (sourceCache.has(file)) return sourceCache.get(file)
  let source: string | undefined
  try {
    source = readFileSync(file, 'utf8')
  } catch {
    source = undefined
  }
  sourceCache.set(file, source)
  return source
}

function routeFiles(route: RouteManifestEntry): string[] {
  return [...new Set([route.file, ...route.sourceFiles])]
}

function isAppSourceFile(config: ResolvedConfig, file: string): boolean {
  if (isInside(config.outPath, file)) return false
  const relative = path.relative(config.root, file)
  if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    // A standalone npm layout keeps node_modules INSIDE the root; framework-supplied route
    // files (pnext's own defaults) are not app sources and must never be validated as such
    // (a JSDoc example in pnext's extensions.ts failed a real app's build as './pic.png').
    return !relative.split(path.sep).includes('node_modules')
  }
  return (
    file.includes(`${path.sep}source-app${path.sep}`) ||
    file.includes(`${path.sep}source-pages${path.sep}`)
  )
}

function isInside(parent: string, file: string): boolean {
  const relative = path.relative(parent, file)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function hasDirective(source: string, directive: string): boolean {
  return directivePrologue(source, 0).includes(directive)
}

/** Whether `cacheComponents` (or a legacy alias) is enabled in next.config. */
function cacheComponentsIsEnabled(): boolean {
  const nextConfig = getNextConfig()
  const experimental = nextConfig.experimental as Record<string, unknown> | undefined
  return (
    nextConfig.cacheComponents === true ||
    experimental?.cacheComponents === true ||
    experimental?.useCache === true ||
    experimental?.dynamicIO === true ||
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    process.env.__NEXT_CACHE_COMPONENTS === 'true'
  )
}

// Segment-config exports `cacheComponents` forbids: each forces a dynamic / caching / runtime disposition
// the cacheComponents model derives per-boundary instead. Presence of the export (any value) is the error.
// `dynamicParams` is the leaf param-fallback control; the rest are the classic dynamic-rendering knobs.
//
// `runtime` is handled separately (value-based) rather than listed here: only a non-`edge` runtime is
// forbidden. `runtime = 'edge'` stays valid, while any other value is rejected with the same "remove it"
// error. See the runtime check in validateCacheComponentsSegmentConfigs.
const CACHE_COMPONENTS_FORBIDDEN_SEGMENT_CONFIGS = [
  'dynamic',
  'dynamicParams',
  'revalidate',
  'fetchCache',
] as const

const SEGMENT_CONFIG_FILE = /(?:^|\/)(?:page|layout|route|default)\.(?:tsx|ts|jsx|js|mjs)$/

/**
 * Under `cacheComponents`, error when a route segment (page/layout/route/
 * default) exports a config that pins dynamic/caching/runtime behavior. Next
 * fails the build listing every offending file with the config name; the suites
 * grep the `./app/...` path and the message fragment. Each unique segment file
 * is checked once (a shared layout appears in many routes' sourceFiles) and the
 * FIRST forbidden export in the file (by source position) is reported, matching
 * Next's one-error-per-file build output.
 */
function validateCacheComponentsSegmentConfigs(
  config: ResolvedConfig,
  routes: RouteManifestEntry[],
): void {
  if (!cacheComponentsIsEnabled()) return
  const projectRoot = path.resolve(config.appPath, '..')
  const seen = new Set<string>()
  const failures: string[] = []
  for (const route of routes) {
    for (const file of route.sourceFiles) {
      if (seen.has(file)) continue
      if (!SEGMENT_CONFIG_FILE.test(toPosix(file))) continue
      seen.add(file)
      if (!isProjectSourceFile(projectRoot, file)) continue
      const source = readSource(file)
      if (source === undefined) continue
      // Skip pnext-generated pages-router wrappers. In a hybrid app the pages/
      // materializer emits an app `page.js` that re-exports from a `source-pages`
      // symlink and, for getServerSideProps pages, injects
      // `export const dynamic = 'force-dynamic'`. cacheComponents' forbidden
      // segment-config check is an app-router concern; a pages-router page uses
      // getServerSideProps legitimately and never authored that config, so the
      // synthetic wrapper must not be flagged.
      if (isMaterializedPagesWrapper(source)) continue
      let earliest: { key: string; index: number } | undefined
      for (const key of CACHE_COMPONENTS_FORBIDDEN_SEGMENT_CONFIGS) {
        const match = new RegExp(`(?:^|[;\\n])\\s*export\\s+const\\s+${key}\\b`).exec(source)
        if (match && (earliest === undefined || match.index < earliest.index)) {
          earliest = { key, index: match.index }
        }
      }
      // `runtime` is forbidden under cacheComponents ONLY when it pins a non-`edge` runtime.
      // `runtime = 'edge'` remains a valid opt-in; Next rejects any other runtime value with the same
      // "remove it" error, and that rejection propagates from a layout to every page under it.
      // Under `experimental.useCache` ALONE there is no dynamic-shell opt-in, so EVERY runtime value -
      // `edge` included - is rejected.
      const runtimeMatch = /(?:^|[;\n])\s*export\s+const\s+runtime\s*=\s*['"]([^'"]+)['"]/.exec(
        source,
      )
      if (
        runtimeMatch &&
        (runtimeMatch[1] !== 'edge' || useCacheOnlyIsEnabled()) &&
        (earliest === undefined || runtimeMatch.index < earliest.index)
      ) {
        earliest = { key: 'runtime', index: runtimeMatch.index }
      }
      if (!earliest) continue
      // Under `experimental.useCache` ONLY (no cacheComponents alias), Next
      // fails at webpack compile with a differently-worded error and a full
      // webpack-errors block that the use-cache-segment-configs suite
      // inline-snapshots — emit that exact block for the first offending file.
      if (useCacheOnlyIsEnabled()) {
        throw new PnextBuildValidationError(useCacheSegmentConfigBuildError(source, earliest.key))
      }
      // Next prints the offending file on its own line ahead of the message. A layout is not a webpack
      // entry - it is imported by every page beneath it, so its config error propagates and webpack attaches
      // an "Import trace for requested module" block naming each importing page then the layout. Reproduce
      // one trace block per importing page so the propagation suite's page-to-layout grep matches, which
      // also proves the layout config reaches the pages.
      let trace = ''
      if (/(?:^|\/)layout\.(?:tsx|ts|jsx|js|mjs)$/.test(toPosix(file))) {
        const importers = new Set<string>()
        for (const other of routes) {
          if (other.kind !== 'page') continue
          if (!other.sourceFiles.includes(file)) continue
          importers.add(`./app/${appDirRelativeFile(config, other.file)}`)
        }
        const layoutRel = `./app/${appDirRelativeFile(config, file)}`
        for (const importer of [...importers].sort()) {
          trace += `\n\nImport trace for requested module:\n${importer}\n${layoutRel}`
        }
      }
      failures.push(
        `./app/${appDirRelativeFile(config, file)}\n` +
          incompatibleCacheComponentsSegmentConfigMessage(earliest.key) +
          trace,
      )
    }
  }
  if (failures.length > 0) throw new PnextBuildValidationError(failures.join('\n\n'))
}

/** Enabled via `experimental.useCache` alone (no cacheComponents alias). */
function useCacheOnlyIsEnabled(): boolean {
  const nextConfig = getNextConfig()
  const experimental = nextConfig.experimental as Record<string, unknown> | undefined
  return (
    experimental?.useCache === true &&
    nextConfig.cacheComponents !== true &&
    experimental?.cacheComponents !== true &&
    experimental?.dynamicIO !== true &&
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    process.env.__NEXT_CACHE_COMPONENTS !== 'true'
  )
}

/**
 * Next's webpack build failure for a forbidden segment-config export under `experimental.useCache`. The
 * suite slices everything after "Failed to compile", replaces any line containing `__next_edge_ssr_entry__`
 * with a fixed placeholder, and inline-snapshot-matches the block - so the file line must carry that token,
 * the code frame keeps the trailing space of the `N | ` prefix on empty source lines, and nothing may print
 * after the final build-failed line.
 */
function useCacheSegmentConfigBuildError(source: string, key: string): string {
  const lines = source.split('\n')
  const exportRe = new RegExp(`\\bexport\\s+const\\s+${key}\\b`)
  let line = 1
  let column = 1
  for (let i = 0; i < lines.length; i += 1) {
    const match = new RegExp(`\\b${key}\\b`).exec(lines[i] ?? '')
    if (exportRe.test(lines[i] ?? '') && match) {
      line = i + 1
      column = match.index + 1
      break
    }
  }
  const last = Math.min(lines.length, line + 3)
  const width = String(last).length
  const gutter = ' '.repeat(width + 2)
  const frame: string[] = [`${gutter},-[${line}:1]`]
  for (let n = line; n <= last; n += 1) {
    frame.push(` ${String(n).padStart(width)} | ${lines[n - 1] ?? ''}`)
    if (n === line) {
      frame.push(`${gutter}: ${' '.repeat(column - 1)}${'^'.repeat(key.length)}`)
    }
  }
  frame.push(`${gutter}\`----`)
  return (
    'Failed to compile.\n' +
    '\n' +
    '__next_edge_ssr_entry__\n' +
    `Error:   x Route segment config "${key}" is not compatible with \`nextConfig.experimental.useCache\`. Please remove it.\n` +
    `${frame.join('\n')}\n` +
    '\n' +
    'Import trace for requested module:\n' +
    '__next_edge_ssr_entry__\n' +
    '\n' +
    '\n' +
    '> Build failed because of webpack errors'
  )
}

// A pnext-generated pages-router wrapper re-exports from the materializer's
// `source-pages` symlink; that import specifier is the stable marker separating
// synthetic wrappers from user-authored app segments.
function isMaterializedPagesWrapper(source: string): boolean {
  return /\bfrom\s+['"][^'"]*source-pages[/\\]/.test(source)
}

function validateUseCacheDirectives(config: ResolvedConfig, routes: RouteManifestEntry[]): void {
  const nextConfig = getNextConfig()
  const experimental = nextConfig.experimental as Record<string, unknown> | undefined
  const enabled =
    nextConfig.cacheComponents === true ||
    experimental?.cacheComponents === true ||
    experimental?.useCache === true ||
    experimental?.dynamicIO === true ||
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    process.env.__NEXT_CACHE_COMPONENTS === 'true'
  const kinds = new Set<string>(['default', 'private', 'remote'])
  const configured = nextConfig.cacheHandlers
  if (configured && typeof configured === 'object' && !Array.isArray(configured)) {
    for (const kind of Object.keys(configured)) kinds.add(kind)
  }

  const projectRoot = path.resolve(config.appPath, '..')
  // sourceFiles is the route's whole graph; shared modules repeat across every
  // route, so visit each file once.
  const seen = new Set<string>()
  for (const route of routes) {
    for (const file of route.sourceFiles) {
      if (seen.has(file)) continue
      seen.add(file)
      if (!isProjectSourceFile(projectRoot, file)) continue
      const source = readSource(file)
      if (source === undefined) continue
      for (const directive of useCacheDirectives(source)) {
        if (!enabled) {
          throw new PnextBuildValidationError(
            useCacheNotEnabledBuildError(`./app/${appDirRelativeFile(config, file)}`, source),
          )
        }
        const kind = directive.kind
        if (!kinds.has(kind)) {
          throw new PnextBuildValidationError(
            unknownCacheKindBuildError(`./app/${appDirRelativeFile(config, file)}`, source, kind),
          )
        }
      }
    }
  }
}

function isProjectSourceFile(projectRoot: string, file: string): boolean {
  const relative = path.relative(projectRoot, file)
  return (
    relative !== '' &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative) &&
    !relative.split(path.sep).includes('node_modules')
  )
}

export function useCacheDirectives(source: string): { kind: string }[] {
  const directives = [
    ...directivePrologue(source, 0),
    ...functionBodies(source).flatMap(offset => directivePrologue(source, offset)),
  ]
  return directives.flatMap(value => {
    const match = /^use cache(?:\s*:\s*([\w-]+))?$/.exec(value)
    return match ? [{ kind: match[1] ?? 'default' }] : []
  })
}

/**
 * The source regions that execute inside a 'use cache' scope: the whole module
 * when the directive sits in the module prologue, plus each function body whose
 * prologue carries the directive (from its opening brace to the matching close).
 * Each scope carries its cache kind (`default`, `private`, a custom handler
 * name) so callers can exempt private scopes. Used to scope hanging-input /
 * searchParams heuristics to code that actually runs in a cache fill rather
 * than the whole file.
 */
function useCacheScopedSource(
  source: string,
): { kind: string; body: string; params: string[]; name: string }[] {
  const kindOf = (value: string) => /^use cache(?:\s*:\s*([\w-]+))?$/.exec(value)
  for (const directive of directivePrologue(source, 0)) {
    // A module-level directive caches the whole file; there is no single cached
    // function whose parameters could be legal vary keys, so `params` is empty.
    const match = kindOf(directive)
    if (match) return [{ kind: match[1] ?? 'default', body: source, params: [], name: '' }]
  }
  const scopes: { kind: string; body: string; params: string[]; name: string }[] = []
  for (const scope of functionScopes(source)) {
    for (const directive of directivePrologue(source, scope.offset)) {
      const match = kindOf(directive)
      if (!match) continue
      scopes.push({
        kind: match[1] ?? 'default',
        body: source.slice(scope.offset, functionBodyEnd(source, scope.offset)),
        params: scope.params,
        name: scope.name,
      })
      break
    }
  }
  return scopes
}

/**
 * Whether `source` passes an unawaited call expression (an uncached promise) into the cached function bound
 * to `name` - either as a call argument or as a JSX prop. An identifier (`params`, `searchParams`, an
 * already-awaited value) is NOT a hanging input: those resolve during the prerender and join the cache key.
 * `resolvableNames` are callees whose promises DO settle during the prerender (other cached functions and
 * request APIs).
 */
function passesUncachedPromiseInto(
  source: string,
  name: string,
  resolvableNames: ReadonlySet<string>,
): boolean {
  const isUncached = (expression: string) =>
    isUncachedPromiseExpression(expression, resolvableNames)
  const pattern = new RegExp(`(<)?\\b${escapeRegExp(name)}\\b`, 'g')
  for (const match of source.matchAll(pattern)) {
    const index = match.index
    if (index === undefined || !isCodeOffset(source, index)) continue
    const after = index + match[0].length
    if (match[1] === '<') {
      if (jsxPropsPassUncachedPromise(source, after, isUncached)) return true
      continue
    }
    const open = source.slice(after).search(/\S/)
    if (open === -1 || source[after + open] !== '(') continue
    const args = balancedFrom(source, after + open, '(', ')')
    if (args !== undefined && splitTopLevelCommas(args).some(isUncached)) return true
  }
  return false
}

/** Scan a JSX element's attributes (from just past `<Name`) for `prop={call()}`. */
function jsxPropsPassUncachedPromise(
  source: string,
  offset: number,
  isUncached: (expression: string) => boolean,
): boolean {
  for (let cursor = offset; cursor < source.length; cursor++) {
    const current = source[cursor]!
    if (current === '>') return false
    if (current !== '{') continue
    const expression = balancedFrom(source, cursor, '{', '}')
    if (expression === undefined) return false
    if (isUncached(expression)) return true
    cursor += expression.length + 1
  }
  return false
}

/** The text between `open` at `index` and its matching `close`. */
function balancedFrom(
  source: string,
  index: number,
  open: string,
  close: string,
): string | undefined {
  let depth = 0
  let quote: string | undefined
  for (let cursor = index; cursor < source.length; cursor++) {
    const current = source[cursor]!
    if (quote) {
      if (current === '\\') cursor++
      else if (current === quote) quote = undefined
      continue
    }
    if (current === '"' || current === "'" || current === '`') {
      quote = current
      continue
    }
    if (current === open) depth++
    else if (current === close && --depth === 0) return source.slice(index + 1, cursor)
  }
  return undefined
}

/** `foo()` / `a.b(…)` — an unawaited call whose promise crosses a cache boundary. */
function isUncachedPromiseExpression(
  expression: string,
  resolvableNames: ReadonlySet<string>,
): boolean {
  const trimmed = expression.trim()
  if (trimmed === '' || /^await\b/.test(trimmed)) return false
  const call = /^([A-Za-z_$][\w$.]*)\s*\(/.exec(trimmed)
  return call !== null && !resolvableNames.has(call[1]!)
}

/**
 * The locally-bound names of request-scoped APIs imported from `next/headers` or `next/root-params`. A
 * promise rooted at one of these settles from request data - or, for root params, from the prerender's
 * params - rather than hanging: `publicCache(cookies().then(...))` is the runtime-prefetch pattern, where
 * the request API postpones the boundary and the route builds as runtime-prefetchable/dynamic. Scoped to
 * actual imports, so an app-local helper that happens to be named `cookies()` still counts as uncached IO.
 */
function requestApiNames(source: string): Set<string> {
  const names = new Set<string>()
  const imports = source.matchAll(
    /\bimport\s*\{([^}]*)\}\s*from\s*['"]next\/(?:headers|root-params)['"]/g,
  )
  for (const match of imports) {
    for (const clause of match[1]!.split(',')) {
      const local = /([A-Za-z_$][\w$]*)\s*$/.exec(clause.trim())
      if (local) names.add(local[1]!)
    }
  }
  return names
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whether the page reads request data (connection/cookies/headers/draftMode) outside every 'use cache'
 * scope - such a route is dynamic and never prerendered, so build-time prerender heuristics do not apply.
 * A module-level 'use cache' page has no code outside a scope, so it stays subject to them.
 */
function readsRequestDataOutsideCache(source: string): boolean {
  const outside = useCacheScopedSource(source).reduce(
    (rest, scope) => rest.replace(scope.body, ''),
    source,
  )
  return /\b(?:connection|cookies|headers|draftMode)\s*\(\s*\)/.test(outside)
}

/**
 * Index of the `}` closing the function body whose content starts at `offset`
 * (just past the opening brace). Brace-counts while skipping strings, template
 * literals and comments; an unbalanced body yields the end of the source.
 */
function functionBodyEnd(source: string, offset: number): number {
  let depth = 1
  let quote: string | undefined
  for (let cursor = offset; cursor < source.length; cursor++) {
    const current = source[cursor]!
    if (quote) {
      // Template literals are treated as opaque text (interpolations included):
      // their braces are skipped rather than counted. Good enough for the
      // heuristic; a nested template inside an interpolation may end the skip
      // early, which at worst widens the scanned scope.
      if (current === '\\') cursor++
      else if (current === quote) quote = undefined
      continue
    }
    if (current === '/' && source[cursor + 1] === '/') {
      const newline = source.indexOf('\n', cursor + 2)
      if (newline === -1) return source.length
      cursor = newline
      continue
    }
    if (current === '/' && source[cursor + 1] === '*') {
      const end = source.indexOf('*/', cursor + 2)
      if (end === -1) return source.length
      cursor = end + 1
      continue
    }
    if (current === '"' || current === "'" || current === '`') {
      quote = current
      continue
    }
    if (current === '{') depth++
    else if (current === '}' && --depth === 0) return cursor
  }
  return source.length
}

/**
 * Next's exact webpack-style build failure for a 'use cache' directive found without `cacheComponents` (or
 * a legacy alias) enabled. The e2e suite slices everything after a "Failed to compile" line and
 * inline-snapshot-matches the whole block - including the swc code frame (line numbers, caret span under
 * the directive, trailing-space `N | ` prefix on empty source lines) and the duplicated import-trace and
 * build-failed footer - so the text below is byte-for-byte Next's output. The CLI prints the thrown message
 * verbatim; nothing may print after it.
 */
function useCacheNotEnabledBuildError(displayPath: string, source: string): string {
  return useCacheDirectiveBuildError(
    displayPath,
    source,
    'To use "use cache", please enable the feature flag `cacheComponents` in your Next.js config.\n' +
      '  |\n' +
      '  | Read more: https://nextjs.org/docs/app/api-reference/directives/use-cache#usage',
  )
}

/**
 * Same webpack-style block for a `'use cache: <kind>'` directive naming a kind with no configured cache
 * handler - inline-snapshot-matched the same way.
 */
function unknownCacheKindBuildError(displayPath: string, source: string, kind: string): string {
  return useCacheDirectiveBuildError(
    displayPath,
    source,
    `Unknown cache kind "${kind}". Please configure a cache handler for this kind in the \`cacheHandlers\` object in your Next.js config.`,
  )
}

/** The shared `Failed to compile` block: message, swc code frame, import trace. */
function useCacheDirectiveBuildError(displayPath: string, source: string, message: string): string {
  const match = /(['"])use cache(?:\s*:\s*[\w-]+)?\1/.exec(source)
  const index = match?.index ?? 0
  const span = match?.[0].length ?? 11
  const before = source.slice(0, index)
  const line = before.split('\n').length
  const column = index - before.lastIndexOf('\n')
  const frame = swcCodeFrame(source, line, column, span)
  return (
    'Failed to compile.\n' +
    '\n' +
    `${displayPath}\n` +
    `Error:   x ${message}\n` +
    '\n' +
    `${frame}\n` +
    '\n' +
    'Import trace for requested module:\n' +
    `${displayPath}\n` +
    '\n' +
    '\n' +
    '> Build failed because of webpack errors'
  )
}

/**
 * An swc-style code frame: a `,-[line:column]` header, the offending line plus up to three following
 * context lines (the `N | ` prefix keeps its trailing space on empty lines, matching swc), a caret marker
 * under the span, and a backtick footer.
 */
function swcCodeFrame(source: string, line: number, column: number, span: number): string {
  const lines = source.split('\n')
  const last = Math.min(lines.length, line + 3)
  const width = String(last).length
  const gutter = ' '.repeat(width + 2)
  const out: string[] = [`${gutter},-[${line}:${column}]`]
  for (let n = line; n <= last; n += 1) {
    out.push(` ${String(n).padStart(width)} | ${lines[n - 1] ?? ''}`)
    if (n === line) {
      out.push(`${gutter}: ${' '.repeat(column - 1)}${'^'.repeat(span)}`)
    }
  }
  out.push(`${gutter}\`----`)
  return out.join('\n')
}

function directivePrologue(source: string, offset: number): string[] {
  const directives: string[] = []
  let cursor = offset
  while (true) {
    cursor = skipTrivia(source, cursor)
    const quote = source[cursor]
    if (quote !== '"' && quote !== "'") return directives
    const end = stringEnd(source, cursor, quote)
    if (end === -1) return directives
    const value = source.slice(cursor + 1, end)
    const afterString = end + 1
    cursor = skipTrivia(source, afterString)
    if (source[cursor] === ';') cursor++
    else if (
      cursor < source.length &&
      source[cursor] !== '}' &&
      !/[\r\n]/.test(source.slice(afterString, cursor))
    ) {
      return directives
    }
    directives.push(value)
  }
}

function functionBodies(source: string): number[] {
  return functionScopes(source).map(scope => scope.offset)
}

/**
 * Every function/arrow body in `source`, as `{ offset, params }`: `offset` is the index just past the
 * opening brace and `params` are the binding names declared by that function's signature. The parameter
 * names let the hanging-input heuristics tell a cached function's OWN vary-key arguments - legal, since the
 * runtime-prefetch pattern passes params/searchParams promises into a 'use cache' function and awaits them
 * there - from closed-over request data, which is still flagged.
 */
function functionScopes(source: string): { offset: number; params: string[]; name: string }[] {
  const scopes: { offset: number; params: string[]; name: string }[] = []
  const pattern =
    /\b(?:async\s+)?function(?:\s*\*)?(?:\s+[A-Za-z_$][\w$]*)?\s*(?:<[^>{}]*>)?\s*\([^)]*\)\s*(?::\s*[^={]+)?\{|\b(?:async\s+)?(?:[A-Za-z_$][\w$]*|\([^)]*\))\s*=>\s*\{/g
  for (const match of source.matchAll(pattern)) {
    if (match.index !== undefined && isCodeOffset(source, match.index)) {
      scopes.push({
        offset: match.index + match[0].length,
        params: signatureParams(match[0]),
        name: signatureName(source, match.index, match[0]),
      })
    }
  }
  return scopes
}

/**
 * The binding name a function scope is reachable by: the declared name for `function Foo(...)`, otherwise
 * the const/let/var binding an arrow or function expression is assigned to. '' when anonymous. Used to find
 * a cached function's CALL SITES.
 */
function signatureName(source: string, index: number, signature: string): string {
  const declared = /\bfunction(?:\s*\*)?\s+([A-Za-z_$][\w$]*)/.exec(signature)
  if (declared) return declared[1]!
  const before = source.slice(Math.max(0, index - 200), index)
  const assigned = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*$/.exec(before)
  return assigned?.[1] ?? ''
}

/**
 * Binding names declared by a function/arrow signature (the matched text from `functionScopes`, which ends
 * at the opening brace). Handles named params, object/array destructuring including renames, rest params
 * and a single unparenthesized arrow parameter. Type annotations are ignored - only the bound identifiers
 * matter.
 */
export function signatureParams(signature: string): string[] {
  // Arrow with a single unparenthesized parameter: `arg => {`.
  const bareArrow = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>\s*\{\s*$/.exec(signature)
  if (bareArrow && !signature.includes('(')) return [bareArrow[1]!]
  const open = signature.indexOf('(')
  if (open === -1) return []
  // The signatures `functionScopes` matches use `\([^)]*\)` for the parameter
  // list, so the list never contains a nested `)` — the first `)` closes it.
  const close = signature.indexOf(')', open)
  if (close === -1) return []
  return paramBindingNames(signature.slice(open + 1, close))
}

/** Bound identifiers of a comma-separated parameter list. */
function paramBindingNames(paramList: string): string[] {
  const names: string[] = []
  for (const raw of splitTopLevelCommas(paramList)) {
    const part = stripDefaultValue(raw)
      .trim()
      .replace(/^\.\.\.\s*/, '')
    if (!part) continue
    if (part.startsWith('{') || part.startsWith('[')) {
      destructureBindings(firstBalancedGroup(part), names)
    } else {
      // `name: Type` / `name?: Type` — the binding is the leading identifier.
      const ident = /^([A-Za-z_$][\w$]*)/.exec(part)
      if (ident) names.push(ident[1]!)
    }
  }
  return names
}

/** Local bindings introduced by a destructuring pattern (`{…}` or `[…]`). */
function destructureBindings(pattern: string, names: string[]): void {
  const inner = pattern.slice(1, -1)
  for (const raw of splitTopLevelCommas(inner)) {
    const entry = stripDefaultValue(raw)
      .trim()
      .replace(/^\.\.\.\s*/, '')
    if (!entry) continue
    // In a destructure entry a top-level `:` renames (`key: binding`); the local
    // binding is on the RIGHT — the opposite of a parameter's `name: Type`.
    const colon = topLevelColonIndex(entry)
    const binding = (colon === -1 ? entry : entry.slice(colon + 1)).trim()
    if (binding.startsWith('{') || binding.startsWith('[')) {
      destructureBindings(firstBalancedGroup(binding), names)
    } else {
      const ident = /^([A-Za-z_$][\w$]*)/.exec(binding)
      if (ident) names.push(ident[1]!)
    }
  }
}

/** Split `text` on commas that sit at bracket depth 0 (strings skipped). */
function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  let quote: string | undefined
  for (let i = 0; i < text.length; i++) {
    const current = text[i]!
    if (quote) {
      if (current === '\\') i++
      else if (current === quote) quote = undefined
      continue
    }
    if (current === '"' || current === "'" || current === '`') quote = current
    else if (current === '{' || current === '[' || current === '(' || current === '<') depth++
    else if (current === '}' || current === ']' || current === ')' || current === '>') depth--
    else if (current === ',' && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

/** The first balanced `{…}`/`[…]` group in `text` (which starts with it). */
function firstBalancedGroup(text: string): string {
  const open = text[0]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let quote: string | undefined
  for (let i = 0; i < text.length; i++) {
    const current = text[i]!
    if (quote) {
      if (current === '\\') i++
      else if (current === quote) quote = undefined
      continue
    }
    if (current === '"' || current === "'" || current === '`') quote = current
    else if (current === open) depth++
    else if (current === close && --depth === 0) return text.slice(0, i + 1)
  }
  return text
}

/** Index of the first `:` at bracket depth 0, or -1. */
function topLevelColonIndex(text: string): number {
  let depth = 0
  let quote: string | undefined
  for (let i = 0; i < text.length; i++) {
    const current = text[i]!
    if (quote) {
      if (current === '\\') i++
      else if (current === quote) quote = undefined
      continue
    }
    if (current === '"' || current === "'" || current === '`') quote = current
    else if (current === '{' || current === '[' || current === '(' || current === '<') depth++
    else if (current === '}' || current === ']' || current === ')' || current === '>') depth--
    else if (current === ':' && depth === 0) return i
  }
  return -1
}

/** Drop a top-level `= default` suffix from a parameter/binding entry. */
function stripDefaultValue(entry: string): string {
  let depth = 0
  let quote: string | undefined
  for (let i = 0; i < entry.length; i++) {
    const current = entry[i]!
    if (quote) {
      if (current === '\\') i++
      else if (current === quote) quote = undefined
      continue
    }
    if (current === '"' || current === "'" || current === '`') quote = current
    else if (current === '{' || current === '[' || current === '(' || current === '<') depth++
    else if (current === '}' || current === ']' || current === ')' || current === '>') depth--
    else if (
      current === '=' &&
      depth === 0 &&
      entry[i + 1] !== '=' &&
      entry[i + 1] !== '>' &&
      entry[i - 1] !== '=' &&
      entry[i - 1] !== '!' &&
      entry[i - 1] !== '<' &&
      entry[i - 1] !== '>'
    ) {
      return entry.slice(0, i)
    }
  }
  return entry
}

/** Identifiers directly awaited in `body` (the `X` of every `await X`). */
function awaitedIdentifiers(body: string): string[] {
  return [...body.matchAll(/\bawait\s+([A-Za-z_$][\w$]*)\b/g)].map(match => match[1]!)
}

function isCodeOffset(source: string, target: number): boolean {
  let quote: string | undefined
  for (let cursor = 0; cursor < target; cursor++) {
    const current = source[cursor]!
    if (quote) {
      if (current === '\\') cursor++
      else if (current === quote) quote = undefined
      continue
    }
    if (current === '/' && source[cursor + 1] === '/') {
      const newline = source.indexOf('\n', cursor + 2)
      if (newline === -1 || newline >= target) return false
      cursor = newline
      continue
    }
    if (current === '/' && source[cursor + 1] === '*') {
      const end = source.indexOf('*/', cursor + 2)
      if (end === -1 || end >= target) return false
      cursor = end + 1
      continue
    }
    if (current === '"' || current === "'" || current === '`') quote = current
  }
  return quote === undefined
}

function skipTrivia(source: string, start: number): number {
  let cursor = start
  while (cursor < source.length) {
    if (/\s/.test(source[cursor]!)) {
      cursor++
      continue
    }
    if (source[cursor] === '/' && source[cursor + 1] === '/') {
      const newline = source.indexOf('\n', cursor + 2)
      cursor = newline === -1 ? source.length : newline + 1
      continue
    }
    if (source[cursor] === '/' && source[cursor + 1] === '*') {
      const end = source.indexOf('*/', cursor + 2)
      if (end === -1) return source.length
      cursor = end + 2
      continue
    }
    return cursor
  }
  return cursor
}

function stringEnd(source: string, start: number, quote: string): number {
  for (let cursor = start + 1; cursor < source.length; cursor++) {
    if (source[cursor] === '\\') {
      cursor++
      continue
    }
    if (source[cursor] === quote) return cursor
  }
  return -1
}

function validateCodemodComments(routes: RouteManifestEntry[]): void {
  for (const file of new Set(routes.map(route => route.file))) {
    const source = readSource(file)
    if (source === undefined) continue
    const match = /@next-codemod-error\s+([^\n*]+)/.exec(source)
    if (match?.[1]) {
      throw new PnextBuildValidationError(unresolvedCodemodCommentMessage(match[1].trim()))
    }
  }
}

// --- missing root layout ---------------------------------------------------

function validateRootLayout(config: ResolvedConfig, pageRoutes: RouteManifestEntry[]): void {
  if (pageRoutes.length === 0) return
  const hasRootLayout = pageExtensions().some(ext =>
    existsSync(path.join(config.appPath, `layout.${ext}`)),
  )
  if (hasRootLayout) return
  // No root `app/layout.*`. Next treats the topmost segment layout as the root
  // and, when a page has an ancestor layout, does NOT error — the segment layout
  // (or the synthesized builtin default `<html><body>{children}</body>`) supplies
  // the document. Only a page with NO ancestor layout anywhere is a hard error.
  const orphan = pageRoutes.find(route => !hasAncestorLayout(config.appPath, route.file))
  if (!orphan) return
  throw new PnextBuildValidationError(
    missingRootLayoutMessage(appDirRelativeFile(config, orphan.file)),
  )
}

/** Whether any `layout.*` exists on the route file's directory chain (below appPath). */
function hasAncestorLayout(appPath: string, routeFile: string): boolean {
  let dir = path.dirname(routeFile)
  while (dir.startsWith(appPath)) {
    if (pageExtensions().some(ext => existsSync(path.join(dir, `layout.${ext}`)))) return true
    if (dir === appPath) break
    dir = path.dirname(dir)
  }
  return false
}

function pageExtensions(): string[] {
  return [...new Set([...BASE_PAGE_EXTENSIONS, ...extraPageExtensions()])]
}

// --- app/ vs pages/ conflict ----------------------------------------------

function validateAppPagesConflict(config: ResolvedConfig): void {
  const pagesDir = pagesDirFor(config)
  if (!pagesDir || !existsSync(pagesDir)) return
  const pagePaths = collectPagesRouterPaths(pagesDir)
  if (pagePaths.size === 0) return
  const appPaths = collectAppRouterPaths(path.join(config.root, 'app'))

  const conflicts: { page: string; app: string }[] = []
  for (const [route, app] of appPaths) {
    const page = pagePaths.get(route)
    if (page) conflicts.push({ page, app })
  }
  if (conflicts.length === 0) return
  throw new PnextBuildValidationError(
    conflictingAppAndPageMessage(dedupeConflicts(conflicts).sort(conflictSort)),
  )
}

/** The pages/ directory sibling to the resolved app/ directory, if any. */
function pagesDirFor(config: ResolvedConfig): string | undefined {
  return path.join(config.root, 'pages')
}

function collectAppRouterPaths(appDir: string): Map<string, string> {
  const paths = new Map<string, string>()
  if (!existsSync(appDir)) return paths
  const walk = (dir: string, segments: string[]) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('@') || (entry.name.startsWith('(') && entry.name.includes('.')))
          continue
        walk(
          full,
          entry.name.startsWith('(') && entry.name.endsWith(')')
            ? segments
            : [...segments, entry.name],
        )
        continue
      }
      if (!/^page\.(?:tsx|ts|jsx|js|mjs)$/.test(entry.name)) continue
      const route = segments.length === 0 ? '/' : `/${segments.join('/')}`
      paths.set(route, toPosix(path.relative(path.dirname(appDir), full)))
    }
  }
  walk(appDir, [])
  return paths
}

/** Public route paths declared under a pages/ directory (excludes api/ + _-files). */
function collectPagesRouterPaths(pagesDir: string): Map<string, string> {
  const paths = new Map<string, string>()
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('_')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'api') continue
        walk(full, `${prefix}/${entry.name}`)
        continue
      }
      const match = /^(.*)\.(tsx|ts|jsx|js|mjs)$/.exec(entry.name)
      if (!match) continue
      const base = match[1]
      const rel = toPosix(path.relative(path.dirname(pagesDir), full))
      if (base === 'index') {
        paths.set(prefix || '/', rel)
      } else {
        paths.set(`${prefix}/${base}`, rel)
      }
    }
  }
  walk(pagesDir, '')
  return paths
}

function dedupeConflicts(conflicts: { page: string; app: string }[]) {
  const seen = new Set<string>()
  return conflicts.filter(conflict => {
    const key = `${conflict.page}\0${conflict.app}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function conflictSort(a: { page: string; app: string }, b: { page: string; app: string }) {
  return a.page.localeCompare(b.page) || a.app.localeCompare(b.app)
}

// --- two parallel (route-group) pages on the same path ---------------------

function validateParallelPageConflicts(
  config: ResolvedConfig,
  pageRoutes: RouteManifestEntry[],
): void {
  const byPattern = new Map<string, RouteManifestEntry>()
  for (const route of pageRoutes) {
    if (route.synthetic) continue
    const existing = byPattern.get(route.pattern)
    if (existing) {
      const labels = [routeGroupLabel(config, existing), routeGroupLabel(config, route)].sort()
      throw new PnextBuildValidationError(conflictingParallelPagesMessage(labels[0]!, labels[1]!))
    }
    byPattern.set(route.pattern, route)
  }
}

/** The app-relative dir of the route's page file, as Next reports it. */
function routeGroupLabel(config: ResolvedConfig, route: RouteManifestEntry): string {
  const dir = path.dirname(appDirRelativeFile(config, route.file))
  return dir === '.' ? '/' : `/${dir}`
}

// --- missing named-slot default on non-leaf segments -----------------------

function validateMissingSlotDefaults(config: ResolvedConfig, routes: RouteManifestEntry[]): void {
  const failures: string[] = []
  const interceptedTargets = interceptedTargetDirs(routes)
  const visit = (dir: string): void => {
    for (const entry of readDirEntries(dir)) {
      if (!entry.isDirectory()) continue
      const child = path.join(dir, entry.name)
      if (isSlotDir(entry.name)) continue
      visit(child)
    }

    if (!hasNormalChildRoute(dir)) return
    if (interceptedTargets.has(dir)) return
    for (const slot of readDirEntries(dir)) {
      if (!slot.isDirectory() || !isNamedSlotDir(slot.name)) continue
      const slotDir = path.join(dir, slot.name)
      if (hasConventionFile(slotDir, 'default')) continue
      // A catch-all page inside the slot (`[...x]`/`[[...x]]`) matches any
      // otherwise-unmatched path, so it doubles as the slot's fallback and
      // Next does not require an explicit default.js (parallel-slot catch-all).
      if (slotHasCatchAllPage(slotDir)) continue
      failures.push(missingDefaultParallelRouteMessage(appPath(config, slotDir), slot.name))
    }
  }

  visit(config.appPath)
  if (failures.length > 0) throw new PnextBuildValidationError(failures.join('\n\n'))
}

function interceptedTargetDirs(routes: RouteManifestEntry[]): Set<string> {
  const patterns = new Set(
    routes.filter(route => route.kind === 'page' && route.interception).map(route => route.pattern),
  )
  return new Set(
    routes
      .filter(route => route.kind === 'page' && !route.interception && patterns.has(route.pattern))
      .map(route => path.dirname(route.file)),
  )
}

function hasNormalChildRoute(dir: string, depth = 0): boolean {
  for (const entry of readDirEntries(dir)) {
    if (!entry.isDirectory() || isSlotDir(entry.name)) continue
    const child = path.join(dir, entry.name)
    const nextDepth = isGroupDir(entry.name) ? depth : depth + 1
    if (
      nextDepth > 0 &&
      (hasConventionFile(child, 'page') || hasConventionFile(child, 'default'))
    ) {
      return true
    }
    if (hasNormalChildRoute(child, nextDepth)) return true
  }
  return false
}

// Whether a slot subtree contains a catch-all page segment (`[...x]` or the
// optional `[[...x]]`) that can serve as the slot's fallback. Group dirs
// (`(group)`) and nested normal segments are walked; other slot dirs are not.
function slotHasCatchAllPage(dir: string): boolean {
  for (const entry of readDirEntries(dir)) {
    if (!entry.isDirectory()) continue
    const child = path.join(dir, entry.name)
    if (/^\[\[?\.\.\..+\]\]?$/.test(entry.name) && hasConventionFile(child, 'page')) return true
    if (slotHasCatchAllPage(child)) return true
  }
  return false
}

function hasConventionFile(dir: string, name: string): boolean {
  return pageExtensions().some(ext => existsSync(path.join(dir, `${name}.${ext}`)))
}

function readDirEntries(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function isSlotDir(name: string): boolean {
  return name.startsWith('@')
}

function isNamedSlotDir(name: string): boolean {
  return isSlotDir(name) && name !== '@children'
}

function isGroupDir(name: string): boolean {
  return name.startsWith('(') && name.endsWith(')')
}

function appPath(config: ResolvedConfig, file: string): string {
  return `app/${appDirRelativeFile(config, file)}`
}

// --- undefined default export ----------------------------------------------

function validateDefaultExports(config: ResolvedConfig, routes: RouteManifestEntry[]): void {
  const failures: string[] = []
  const appPath = path.resolve(config.appPath)
  for (const route of routes) {
    if (route.kind !== 'page' || route.interception || route.synthetic) continue
    for (const file of defaultExportFiles(route)) {
      // MDX pages have no literal `export default` in source; the compiler emits one.
      if (/\.mdx?$/.test(file)) continue
      // A core-authored root layout exports only `metadata` — pnext synthesizes
      // the <html>/<body> shell from it, so there is no component to default-export.
      // Next requires one; under compat the shell still comes from core, so the
      // layout is valid (SPEC change 9). Nested layouts keep Next's rule.
      if (isRootLayoutFile(appPath, file)) continue
      const source = readSource(file)
      if (source === undefined) continue
      if (!hasDefaultExport(stripCommentsAndStrings(source))) {
        failures.push(undefinedDefaultExportMessage(componentRoutePath(route, file)))
      }
    }
  }
  if (failures.length > 0) throw new PnextBuildValidationError([...new Set(failures)].join('\n'))
}

function defaultExportFiles(route: RouteManifestEntry): string[] {
  const files = new Set<string>([route.file])
  const dir = path.dirname(route.file)
  for (const ext of pageExtensions()) {
    files.add(path.join(dir, `layout.${ext}`))
    files.add(path.join(dir, `not-found.${ext}`))
  }
  return [...files].filter(file => existsSync(file))
}

function isRootLayoutFile(appPath: string, file: string): boolean {
  return (
    path.basename(file).replace(/\.[^.]+$/, '') === 'layout' &&
    path.resolve(path.dirname(file)) === appPath
  )
}

function componentRoutePath(route: RouteManifestEntry, file: string): string {
  const convention = path.basename(file).replace(/\.(tsx|ts|jsx|js|mjs)$/, '')
  const routePath = route.route || '/'
  if (convention === 'page') return routePath === '/' ? '/page' : `${routePath}/page`
  return `${routePath === '/' ? '' : routePath}/${convention}`
}

function hasDefaultExport(searchable: string): boolean {
  return /\bexport\s+default\b/.test(searchable) || hasDefaultNamedExport(searchable)
}

function hasDefaultNamedExport(searchable: string): boolean {
  for (const match of searchable.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    const specifiers = match[1]?.split(',') ?? []
    if (specifiers.some(exportsDefaultSpecifier)) return true
  }
  return false
}

function exportsDefaultSpecifier(specifier: string): boolean {
  const parts = specifier.trim().split(/\s+as\s+/)
  return parts.length === 1 ? parts[0] === 'default' : parts.at(-1) === 'default'
}

// --- useSearchParams without Suspense --------------------------------------

function validateSearchParamsSuspense(
  config: ResolvedConfig,
  pageRoutes: RouteManifestEntry[],
): void {
  // The CSR bailout applies when a client page reads useSearchParams and there
  // is no Suspense boundary anywhere in the page's own file or layout chain.
  // Next only surfaces this at build for routes it STATICALLY prerenders: a
  // dynamically rendered route (dynamic params without generateStaticParams,
  // force-dynamic, or request-data usage) reads useSearchParams on-demand, so
  // no prerender-time CSR bailout occurs. Scope the check accordingly.
  for (const route of pageRoutes) {
    if (!route.client) continue
    if (!isStaticallyPrerendered(route)) continue
    const source = readSource(route.file)
    if (source === undefined) continue
    const stripped = stripCommentsAndStrings(source)
    // This shape uses useSyncExternalStore's server snapshot to render a stable
    // shell, then fills the URLSearchParams instance after hydration.
    if (/\buseSyncExternalStore\s*\(/.test(stripped)) continue
    if (!usesSearchParamsHook(stripped)) continue
    if (fileTreeHasSuspense(config, route)) continue
    throw new PnextBuildValidationError(missingSuspenseWithCsrBailoutMessage(route.route || '/'))
  }
}

function usesSearchParamsHook(searchable: string): boolean {
  return /\buseSearchParams\s*\(/.test(searchable)
}

/**
 * Whether Next would STATICALLY GENERATE this page - the precondition for the CSR bailout to be a build
 * error. Next reports it only for prerendered routes; a dynamically rendered one reads useSearchParams
 * on-demand and CSR-bails at runtime instead. A route renders dynamically when its segment config forces
 * it, or it has dynamic segments with no `generateStaticParams` to enumerate them. This mirrors the
 * prerender gate in cli/build.ts, EXCEPT it ignores `usesRequest`/`mode`: for a client page those are set
 * by the useSearchParams hook itself, which does not opt Next out of static generation - it is precisely
 * what triggers the bailout during prerender.
 */
function isStaticallyPrerendered(route: RouteManifestEntry): boolean {
  const config = route.segmentConfig
  const configForcesDynamic =
    config?.dynamic === 'force-dynamic' ||
    config?.revalidate === 0 ||
    config?.fetchCache === 'force-no-store'
  if (configForcesDynamic) return false
  // Dynamic segments can only be prerendered when generateStaticParams
  // enumerates them; otherwise the route renders on-demand per request.
  const isDynamicRoute = route.params.length > 0 || Boolean(route.catchAll)
  if (isDynamicRoute && !route.hasStaticParams) return false
  return true
}

function fileTreeHasSuspense(config: ResolvedConfig, route: RouteManifestEntry): boolean {
  // A Suspense boundary anywhere on the layout chain (root->leaf) or in the page
  // file itself satisfies the requirement. We scan the source text for a JSX
  // <Suspense usage or a Suspense import, which is what the fixtures rely on.
  const files = [route.file, ...layoutChain(config.appPath, route.file)]
  for (const file of files) {
    const source = readSource(file)
    if (source === undefined) continue
    if (/<Suspense[\s/>]/.test(source) || /\bReact\.Suspense\b/.test(source)) return true
  }
  return false
}

function layoutChain(appPath: string, routeFile: string): string[] {
  const files: string[] = []
  let dir = path.dirname(routeFile)
  while (dir.startsWith(appPath)) {
    for (const ext of pageExtensions()) {
      const candidate = path.join(dir, `layout.${ext}`)
      if (existsSync(candidate)) files.push(candidate)
    }
    if (dir === appPath) break
    dir = path.dirname(dir)
  }
  return files
}

// --- output: 'export' mode -------------------------------------------------

function validateExportMode(config: ResolvedConfig, routes: RouteManifestEntry[]): void {
  const nextConfig = getNextConfig()
  if (nextConfig.output !== 'export') return

  // exportPathMap is a pages-router-only config; using it with the app dir is a
  // hard error.
  const hasAppPages = routes.some(route => route.kind === 'page' && !route.interception)
  if (hasAppPages && typeof nextConfig.exportPathMap === 'function') {
    throw new PnextBuildValidationError(exportPathMapWithAppDirMessage())
  }

  // Server actions need a server to receive them — Next fails the export build
  // before any per-route diagnostics.
  if (routesUseServerActions(routes)) {
    throw new PnextBuildValidationError('Server Actions are not supported with static export.')
  }

  if (routes.some(route => route.interception)) {
    throw new PnextBuildValidationError('Intercepting routes are not supported with static export.')
  }

  for (const route of routes) {
    if (route.interception || route.synthetic) continue
    // force-dynamic is incompatible with a static export. Pages get Next's
    // create-component-tree wording; handlers keep the route-level message.
    if (route.segmentConfig?.dynamic === 'force-dynamic') {
      throw new PnextBuildValidationError(
        route.kind === 'page'
          ? forceDynamicPageWithExportMessage()
          : dynamicForceDynamicWithExportMessage(nextPagePath(route)),
      )
    }
    if (route.kind === 'handler' && !routeHandlerStaticExportable(route)) {
      throw new PnextBuildValidationError(
        routeHandlerNotStaticWithExportMessage(nextPagePath(route)),
      )
    }
    // A dynamic route (params/catch-all) must supply generateStaticParams to be
    // exportable — there is no runtime to fill params in a static export.
    const isDynamicRoute = route.params.length > 0 || Boolean(route.catchAll)
    if (route.kind === 'page' && isDynamicRoute && !route.hasStaticParams) {
      throw new PnextBuildValidationError(
        missingGenerateStaticParamsForExportMessage(nextPagePath(route)),
      )
    }
  }
}

// Whether any route's source graph declares server actions ('use server' as a
// module prologue or an inline function directive).
function routesUseServerActions(routes: RouteManifestEntry[]): boolean {
  const seen = new Set<string>()
  for (const route of routes) {
    for (const file of route.sourceFiles ?? []) {
      if (seen.has(file)) continue
      seen.add(file)
      const source = readSource(file)
      if (source === undefined) continue
      if (/(["'])use server\1\s*;?/.test(source)) return true
    }
  }
  return false
}

function routeHandlerStaticExportable(route: RouteManifestEntry): boolean {
  const config = route.segmentConfig
  return (
    config?.dynamic === 'force-static' ||
    // `dynamic = 'error'` opts the handler into static rendering (dynamic API
    // access becomes a hard error), which Next accepts for a static export.
    config?.dynamic === 'error' ||
    config?.revalidate === false ||
    (typeof config?.revalidate === 'number' && config.revalidate > 0) ||
    route.hasStaticParams
  )
}

/** The route path in Next's page notation (`/blog/[slug]`, `/[...all]`). */
function nextPagePath(route: RouteManifestEntry): string {
  let value = route.route || '/'
  if (route.catchAll) {
    const token = route.catchAllOptional ? `[[...${route.catchAll}]]` : `[...${route.catchAll}]`
    value = value.replace(`:${route.catchAll}*`, token)
  }
  for (const param of route.params) value = value.replace(`:${param}`, `[${param}]`)
  return value
}

// --- shared source scanning ------------------------------------------------

function appDirRelativeFile(config: ResolvedConfig, file: string): string {
  return toPosix(path.relative(config.appPath, file))
}

function toPosix(file: string): string {
  return file.split(path.sep).join('/')
}

/**
 * Strip block/line comments and string/template literals so keyword scans do not match inside comments or
 * strings. A local copy (the routes.ts version is not exported), conservative - it only needs to blank out
 * obvious literals.
 *
 * Single left-to-right pass: sequential `.replace()` steps are unsafe because a `//` inside a string
 * literal would be eaten by the line-comment strip before the string strip ran, which desyncs the quote
 * matching and swallows the rest of the file. Scanning once, deciding comment-vs-string by which token
 * opens first at the cursor, keeps them from interfering.
 */
function stripCommentsAndStrings(source: string): string {
  let out = ''
  let i = 0
  const n = source.length
  while (i < n) {
    const ch = source[i]
    const next = source[i + 1]
    // Block comment.
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      out += ' '
      i = end === -1 ? n : end + 2
      continue
    }
    // Line comment.
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i + 2)
      out += ' '
      i = end === -1 ? n : end
      continue
    }
    // String / template literal.
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      out += quote
      i += 1
      while (i < n) {
        const c = source[i]
        if (c === '\\') {
          i += 2
          continue
        }
        if (c === quote) {
          i += 1
          break
        }
        i += 1
      }
      out += quote
      continue
    }
    out += ch
    i += 1
  }
  return out
}
