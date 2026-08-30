// ---------------------------------------------------------------------------
// next.config.(js|cjs|mjs|ts|mts|cts) loader (COMPAT).
//
// Loads a Next.js config authored in any of the supported module formats and
// maps it onto pnext's resolved core config, keeping the full loaded object in
// a compat-only store other compat modules read via getNextConfig().
//
// One esbuild-based loader covers all three e2e suite families
// (next-config-ts, -native-ts, -native-mts): the config is bundled with the
// app tsconfig (so `paths` aliases, `extends`, and `.ts`/`.cts`/`.mts` imports
// resolve), node_modules kept external, then the emitted ESM module imported.
// This handles export default / export-as-default / async function / Promise
// export / top-level await / dynamic import() and CJS+ESM authoring styles.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from '../../utils/esbuild'
import { setConfig } from './config'
import { setCacheComponents } from '../../render/ppr'
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from './constants'
import { nextMdxConfigStubPlugin } from '../mdx/stub'
import { collectImagesConfigErrors } from './image/validate'
import { setSvgAsComponentEnabled, webpackReferencesSvgr } from './svgr'
import { emitBuildFeatureUsageTelemetry, emitSessionStartedTelemetry } from './telemetry'

export type NextConfigObject = Record<string, unknown>
type NextConfigFn = (
  phase: string,
  context: { defaultConfig: NextConfigObject },
) => NextConfigObject | Promise<NextConfigObject>
type NextConfigExport = NextConfigObject | NextConfigFn | Promise<NextConfigObject>

const CONFIG_BASENAMES = [
  'next.config.ts',
  'next.config.mts',
  'next.config.cts',
  'next.config.js',
  'next.config.mjs',
  'next.config.cjs',
]

let store: NextConfigObject = {}

/** The full loaded next.config object; empty until loadNextConfig runs. */
export function getNextConfig(): NextConfigObject {
  return store
}

/**
 * Read the effective `cacheComponents` flag from a loaded next.config. Next
 * accepts the modern `cacheComponents: true` and the legacy
 * `experimental.dynamicIO` alias, plus the env override
 * `__NEXT_CACHE_COMPONENTS`. Note that `experimental.useCache` is NOT an alias:
 * it only enables the `use cache` directive (Next maps cacheComponents ->
 * useCache, never the reverse), so a useCache-only app keeps the classic full
 * static/ISR prerender semantics.
 */
function readCacheComponentsFlag(config: NextConfigObject): boolean {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  if (process.env.__NEXT_CACHE_COMPONENTS === 'true') return true
  if (config.cacheComponents === true) return true
  const experimental = config.experimental as Record<string, unknown> | undefined
  if (experimental?.cacheComponents === true) return true
  if (experimental?.dynamicIO === true) return true
  return false
}

export function setNextConfig(config: NextConfigObject): void {
  store = config
  // Derived per config load, never a process one-shot: a second build in the
  // same process (dev server, programmatic API, test suite) must see its OWN
  // app's flag, not the previous app's.
  setCacheComponents(readCacheComponentsFlag(config))
  setSvgAsComponentEnabled(webpackReferencesSvgr(config))
  // Expose basePath to server-side render code through the isomorphic
  // globalThis global (compat/client/base-path.ts reads it). The client reads
  // the window global the render layer injects instead; keeping both in sync
  // lets Link/redirect/nav prefix basePath identically on server and client.
  ;(globalThis as { __PNEXT_BASE_PATH__?: string }).__PNEXT_BASE_PATH__ =
    typeof config.basePath === 'string' ? config.basePath : ''
  // Expose skipTrailingSlashRedirect the same way so server-rendered Links skip
  // trailing-slash normalization (the client reads the injected window global).
  ;(globalThis as { __PNEXT_SKIP_TRAILING_SLASH__?: boolean }).__PNEXT_SKIP_TRAILING_SLASH__ =
    config.skipTrailingSlashRedirect === true
  ;(globalThis as { __PNEXT_TRAILING_SLASH__?: boolean }).__PNEXT_TRAILING_SLASH__ =
    config.trailingSlash === true
}

/** Overrides mapped onto pnext's resolved core config. */
export interface NextConfigCoreOverrides {
  basePath?: string
  trailingSlash?: boolean
  skipTrailingSlashRedirect?: boolean
  outDir?: string
  assetPrefix?: string
  productionBrowserSourceMaps?: boolean
}

export interface LoadNextConfigResult {
  config: NextConfigObject
  overrides: NextConfigCoreOverrides
}

function findConfigPath(root: string): string | undefined {
  for (const name of CONFIG_BASENAMES) {
    const candidate = path.join(root, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

// `Bun` through globalThis: pnext ships TypeScript source, so app compilers without
// bun-types typecheck this file and a bare `Bun` identifier would fail them.
const { Bun: bun } = globalThis as unknown as {
  Bun: { hash(input: string | ArrayBufferView): { toString(radix?: number): string } }
}

/** Stable per config content, so the emitted bundle keeps one name per boot. */
function configSourceKey(configPath: string): string {
  try {
    return bun.hash(readFileSync(configPath)).toString(36)
  } catch {
    return 'config'
  }
}

function findTsconfig(root: string): string | undefined {
  const candidate = path.join(root, 'tsconfig.json')
  return existsSync(candidate) ? candidate : undefined
}

/**
 * Bundle the config with esbuild (external node_modules) and import the result.
 * The emitted file is written next to the config so Node resolves the app's
 * node_modules and relative assets from the original location.
 *
 * The bundle is also a BUILD artifact: the build leaves it on disk, deployment adapters ship it with
 * the app's out dir, and a serve imports that file rather than re-running the pass. Request time is
 * read-only on a serverless host (Vercel's `/var/task`), where the pass cannot write at all - and
 * where it could, it would still put an esbuild spawn on every cold start. A serve whose build left
 * no bundle (the config changed since, matching `next start` re-reading next.config) still bundles.
 */
async function importConfigModule(
  configPath: string,
  root: string,
  options: { dev: boolean; serve: boolean },
): Promise<NextConfigExport> {
  const cjs = cjsConfigFormat(configPath, root)
  if (process.env.PNEXT_CONFIG_FAST !== '0' && selfContainedConfig(configPath)) {
    // Nothing left for the bundle pass to do, and Bun loads every supported config format natively -
    // so skip it. Worth a special case because this is the common shape and the pass is not cheap:
    // it loads esbuild and spawns its service child on the dev/start boot critical path.
    if (cjs) return createRequire(pathToFileURL(configPath))(configPath) as NextConfigExport
    const module = (await import(pathToFileURL(configPath).href)) as { default?: NextConfigExport }
    return module.default ?? {}
  }
  // Dev keeps its scratch bundle in its own subtree; a concurrent build wipes
  // only the build-owned `config/`.
  const outDir = path.join(root, '.pnext', ...(options.dev ? ['dev'] : []), 'config')
  // Content-addressed, not timestamped: a per-boot name leaked one bundle per
  // dev start and put a path that changes every boot into the module graph,
  // which renamed every artifact that could reach it. It also makes the name a
  // pure function of the config source, so a serve recomputes what its build wrote.
  const outfile = path.join(
    outDir,
    `next.config.${configSourceKey(configPath)}.${cjs ? 'cjs' : 'mjs'}`,
  )
  if (options.serve && existsSync(outfile)) return importConfigBundle(outfile, cjs)
  try {
    mkdirSync(outDir, { recursive: true })
    await bundleConfig({ configPath, root, outDir, outfile, cjs })
  } catch (error) {
    // The only way here on a serve is a build that shipped no bundle for this config, and the most
    // likely reason the rebuild then failed is the read-only request-time filesystem it was meant to
    // avoid. Name the artifact rather than surfacing an esbuild write error from a boot path.
    if (!options.serve) throw error
    throw new Error(
      `pnext: ${path.relative(root, outfile)} is missing and could not be rebuilt here — run ` +
        '`pnext build` and deploy its output dir, which carries the config bundle. Cause: ' +
        (error instanceof Error ? error.message : String(error)),
      { cause: error },
    )
  }
  pruneStaleConfigBundles(outDir, outfile)
  return importConfigBundle(outfile, cjs)
}

function bundleConfig({
  configPath,
  root,
  outDir,
  outfile,
  cjs,
}: {
  configPath: string
  root: string
  outDir: string
  outfile: string
  cjs: boolean
}) {
  return build({
    entryPoints: [configPath],
    outfile,
    bundle: true,
    platform: 'node',
    format: cjs ? 'cjs' : 'esm',
    target: 'esnext',
    // Keep bare package imports external so Node resolves them from the app's
    // node_modules at import time (preserves CJS/ESM interop and identity).
    packages: 'external',
    // Fixture/app configs may require() or require.resolve() Next internals
    // (next/dist/*) that don't exist without a real `next` install. Stub them
    // so the config still loads; features pointing at the stubs degrade
    // gracefully instead of crashing config loading.
    plugins: [nextDistStubPlugin(outDir), nextMdxConfigStubPlugin()],
    banner: cjs
      ? {
          js:
            'var __pnextNodeRequire = module.require.bind(module);\n' +
            `var require = __pnextNodeRequire("node:module").createRequire(${JSON.stringify(pathToFileURL(configPath).href)});`,
        }
      : {
          js:
            'import { createRequire as __pnextCreateRequire } from "node:module";\n' +
            `const require = __pnextCreateRequire(${JSON.stringify(pathToFileURL(configPath).href)});`,
        },
    // Relative/absolute imports (incl. .ts/.cts/.mts/.cjs/.mjs and tsconfig
    // `paths` aliases) are bundled in. esbuild reads `paths`/`extends` and
    // `baseUrl` from the app tsconfig.
    tsconfig: findTsconfig(root),
    // __dirname / __filename in CJS-authored .ts configs (node-api-cjs) and
    // import.meta.url in ESM configs (node-api-esm) must point at the config's
    // original location, not the emitted file under .pnext/config.
    define: {
      __dirname: JSON.stringify(path.dirname(configPath)),
      __filename: JSON.stringify(configPath),
      'import.meta.url': JSON.stringify(pathToFileURL(configPath).href),
    },
    logLevel: 'silent',
    sourcemap: false,
    metafile: false,
  })
}

async function importConfigBundle(outfile: string, cjs: boolean): Promise<NextConfigExport> {
  if (cjs) return createRequire(pathToFileURL(outfile))(outfile) as NextConfigExport
  const module = (await import(pathToFileURL(outfile).href)) as { default?: NextConfigExport }
  return module.default ?? {}
}

/**
 * Drop bundles left by an earlier config source. The emitted file used to be deleted right after it
 * was imported, which is what made a serve re-bundle; keeping only the current key holds the line
 * that motivated the delete - one bundle per app, not one per edit.
 */
function pruneStaleConfigBundles(outDir: string, outfile: string): void {
  try {
    for (const entry of readdirSync(outDir)) {
      if (!/^next\.config\..+\.[cm]js$/.test(entry)) continue
      if (path.join(outDir, entry) === outfile) continue
      rmSync(path.join(outDir, entry), { force: true })
    }
  } catch {
    // Housekeeping only: a missing or unreadable out dir costs nothing here.
  }
}

/**
 * Whether the config reaches nothing the bundle pass provides: `import`/`require` are its only routes
 * to other modules and `__dirname`/`__filename` the only globals the pass defines. A false positive
 * (token in a comment/string) just runs the bundle pass we would have run anyway.
 */
function selfContainedConfig(configPath: string): boolean {
  try {
    const source = readFileSync(configPath, 'utf8').replaceAll('import.meta', '')
    return !/\b(?:import|require|__dirname|__filename)\b/.test(source)
  } catch {
    return false
  }
}

function cjsConfigFormat(configPath: string, root: string): boolean {
  if (configPath.endsWith('.cjs') || configPath.endsWith('.cts')) return true
  if (!configPath.endsWith('.js')) return false
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      type?: unknown
    }
    return pkg.type !== 'module'
  } catch {
    return true
  }
}

// Stub next/dist/* internals during config bundling: imports and requires resolve to an inert module
// (its default export is a no-op class so `extends` works), and require.resolve() returns the path of a
// real on-disk stub module instead of throwing. The emitted config calls Node's require.resolve at
// runtime, so the returned path must exist - and configs commonly feed it back into features like
// `cacheHandlers`, whose loaders then require() it. Only next/dist deep imports are stubbed; top-level
// `next/*` config helpers stay external.
const NEXT_DIST_STUB_CONTENTS =
  'class PNextConfigStub {}\n' +
  'module.exports = new Proxy(PNextConfigStub, { get: (t, k) => (k === "default" ? PNextConfigStub : t[k] ?? PNextConfigStub) });\n'

function nextDistStubPlugin(outDir: string): import('esbuild').Plugin {
  return {
    name: 'pnext-next-dist-stub',
    setup(build) {
      build.onResolve({ filter: /^next\/dist\// }, args => {
        if (args.kind === 'require-resolve') {
          // Preserve the requested module path under the stub root so loaders
          // downstream can still recognize WHICH next internal was meant.
          const stubPath = path.join(outDir, 'next-dist-stub', `${args.path}.cjs`)
          mkdirSync(path.dirname(stubPath), { recursive: true })
          writeFileSync(stubPath, NEXT_DIST_STUB_CONTENTS)
          return { path: stubPath, external: true }
        }
        return { path: args.path, namespace: 'pnext-next-dist-stub' }
      })
      build.onLoad({ filter: /.*/, namespace: 'pnext-next-dist-stub' }, () => ({
        contents: NEXT_DIST_STUB_CONTENTS,
        loader: 'js',
      }))
    },
  }
}

function currentPhase(dev: boolean): string {
  return dev ? PHASE_DEVELOPMENT_SERVER : PHASE_PRODUCTION_BUILD
}

/** A missing-module resolution failure (vs a genuine config error to surface). */
function isModuleNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return true
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && /Cannot find (?:module|package)/.test(message)
}

function describeMissingModule(error: unknown): string {
  const message = (error as { message?: unknown }).message
  const match =
    typeof message === 'string'
      ? /Cannot find (?:module|package) ['"]([^'"]+)['"]/.exec(message)
      : null
  return match ? `${match[1]} not installed` : 'a required module is not installed'
}

async function resolveConfigExport(
  exported: NextConfigExport,
  dev: boolean,
): Promise<NextConfigObject> {
  const value =
    typeof exported === 'function'
      ? await exported(currentPhase(dev), { defaultConfig: {} })
      : await exported
  return value ?? {}
}

function mapOverrides(config: NextConfigObject): NextConfigCoreOverrides {
  const overrides: NextConfigCoreOverrides = {}
  if (typeof config.basePath === 'string') overrides.basePath = config.basePath
  if (typeof config.assetPrefix === 'string' && config.assetPrefix.length > 0) {
    overrides.assetPrefix = config.assetPrefix
  }
  if (typeof config.trailingSlash === 'boolean') overrides.trailingSlash = config.trailingSlash
  if (typeof config.skipTrailingSlashRedirect === 'boolean')
    overrides.skipTrailingSlashRedirect = config.skipTrailingSlashRedirect
  if (typeof config.productionBrowserSourceMaps === 'boolean')
    overrides.productionBrowserSourceMaps = config.productionBrowserSourceMaps
  // Next's distDir maps onto pnext's outDir. pnext's default output dir is .pnext; only override when
  // the app explicitly sets distDir. Under `output: 'export'` a custom distDir is the EXPORT
  // destination instead - the build keeps its default dir and the static export tree lands in distDir.
  if (
    typeof config.distDir === 'string' &&
    config.distDir.length > 0 &&
    config.output !== 'export'
  ) {
    overrides.outDir = config.distDir
  }
  return overrides
}

function normalizeCacheHandlerPath(config: NextConfigObject, root: string): NextConfigObject {
  const value = config.cacheHandler
  const cacheHandlers = config.cacheHandlers
  let next = config
  if (typeof value === 'string' && isRelativePathSpecifier(value)) {
    next = { ...next, cacheHandler: path.resolve(root, value) }
  }
  if (cacheHandlers && typeof cacheHandlers === 'object' && !Array.isArray(cacheHandlers)) {
    const normalized: Record<string, unknown> = {}
    let changed = false
    for (const [key, handlerPath] of Object.entries(cacheHandlers as Record<string, unknown>)) {
      if (typeof handlerPath === 'string' && isRelativePathSpecifier(handlerPath)) {
        normalized[key] = path.resolve(root, handlerPath)
        changed = true
      } else {
        normalized[key] = handlerPath
      }
    }
    if (changed) next = { ...next, cacheHandlers: normalized }
  }
  return next
}

function isRelativePathSpecifier(value: string): boolean {
  return value === '.' || value === '..' || value.startsWith('./') || value.startsWith('../')
}

/**
 * Apply the config's `env` object to process.env so server-rendered pages read
 * `process.env.<key>` (Next semantics: config env are inlined/defined for the
 * app). Values already present in the environment win.
 */
function applyEnv(config: NextConfigObject): void {
  const env = config.env
  if (!env || typeof env !== 'object') return
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (value === undefined || value === null) continue
    if (process.env[key] !== undefined) continue
    process.env[key] = typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
  }
}

/** Feed next/config's getConfig() from the loaded config's runtime configs. */
function applyRuntimeConfig(config: NextConfigObject): void {
  const serverRuntimeConfig = config.serverRuntimeConfig
  const publicRuntimeConfig = config.publicRuntimeConfig
  if (!serverRuntimeConfig && !publicRuntimeConfig) return
  setConfig({
    ...(serverRuntimeConfig && typeof serverRuntimeConfig === 'object'
      ? { serverRuntimeConfig: serverRuntimeConfig as Record<string, unknown> }
      : {}),
    ...(publicRuntimeConfig && typeof publicRuntimeConfig === 'object'
      ? { publicRuntimeConfig: publicRuntimeConfig as Record<string, unknown> }
      : {}),
  })
}

const VALID_DEV_INDICATOR_POSITIONS = new Set([
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
])

const KNOWN_TOP_LEVEL_CONFIG_KEYS = new Set([
  'adapterPath',
  'agentRules',
  'allowedDevOrigins',
  'assetPrefix',
  'basePath',
  'bundlePagesRouterDependencies',
  'cacheComponents',
  'cacheHandler',
  'cacheHandlers',
  'cacheLife',
  'cacheMaxMemorySize',
  'cleanDistDir',
  'compiler',
  'compress',
  'configFile',
  'configFileName',
  'configOrigin',
  'crossOrigin',
  'deploymentId',
  'devIndicators',
  'distDir',
  'enablePrerenderSourceMaps',
  'env',
  'excludeDefaultMomentLocales',
  'expireTime',
  'experimental',
  'exportPathMap',
  'generateBuildId',
  'generateEtags',
  'headers',
  'htmlLimitedBots',
  'httpAgentOptions',
  'images',
  'logging',
  'modularizeImports',
  'onDemandEntries',
  'output',
  'outputFileTracingExcludes',
  'outputFileTracingIncludes',
  'outputFileTracingRoot',
  'pageExtensions',
  'partialPrefetching',
  'poweredByHeader',
  'productionBrowserSourceMaps',
  'publicRuntimeConfig',
  'reactCompiler',
  'reactMaxHeadersLength',
  'reactProductionProfiling',
  'reactStrictMode',
  'resolveExtensions',
  'redirects',
  'rewrites',
  'sassOptions',
  'serverExternalPackages',
  'serverRuntimeConfig',
  'skipProxyUrlNormalize',
  'skipTrailingSlashRedirect',
  'staticPageGenerationTimeout',
  'i18n',
  'instrumentationClientInject',
  'trailingSlash',
  'skipMiddlewareUrlNormalize',
  'transpilePackages',
  'turbopack',
  'typedRoutes',
  'typescript',
  'useFileSystemPublicRoutes',
  'watchOptions',
  'webpack',
])

// Deprecated next.config options and the exact warning Next emits for each. The
// deprecation-warnings e2e suite asserts these substrings appear on the CLI when
// the option is explicitly configured (and that none appear otherwise).
const DEPRECATED_CONFIG_OPTIONS: readonly { key: string; reason: (file: string) => string }[] = [
  {
    key: 'experimental.middlewarePrefetch',
    reason: file =>
      `\`experimental.middlewarePrefetch\` is deprecated. Please use \`experimental.proxyPrefetch\` instead in ${file}.`,
  },
  {
    key: 'experimental.middlewareClientMaxBodySize',
    reason: file =>
      `\`experimental.middlewareClientMaxBodySize\` is deprecated. Please use \`experimental.proxyClientMaxBodySize\` instead in ${file}.`,
  },
  {
    key: 'experimental.externalMiddlewareRewritesResolve',
    reason: file =>
      `\`experimental.externalMiddlewareRewritesResolve\` is deprecated. Please use \`experimental.externalProxyRewritesResolve\` instead in ${file}.`,
  },
  {
    key: 'skipMiddlewareUrlNormalize',
    reason: file =>
      `\`skipMiddlewareUrlNormalize\` is deprecated. Please use \`skipProxyUrlNormalize\` instead in ${file}.`,
  },
  {
    key: 'experimental.instrumentationHook',
    reason: file =>
      `\`experimental.instrumentationHook\` is no longer needed, because \`instrumentation.js\` is available by default. You can remove it from ${file}.`,
  },
]

// Config-warning de-dup: loadNextConfig runs several times per process, but Next emits each
// next.config validation warning only ONCE per process. Track which config files have already been
// warned about so repeated loads within a single process stay silent. Fatal validation is intentionally
// re-run every call - it throws.
const warnedConfigPaths = new Set<string>()

function validateConfig(config: NextConfigObject, configPath: string, emitWarnings: boolean): void {
  if (emitWarnings && !warnedConfigPaths.has(configPath)) {
    warnedConfigPaths.add(configPath)
    const configFileName = path.basename(configPath)
    warnUnknownConfigKeys(config)
    warnEsmExternalsFalse(config)
    warnDeprecatedConfigOptions(config, configFileName)
    warnWebpackCompat(config, configFileName)
  }
  validateDevIndicatorPosition(config)
  const imageErrors = collectImagesConfigErrors(config, path.dirname(configPath))
  if (imageErrors.length > 0) {
    throw new Error(
      `Invalid next.config.js options detected: \n${imageErrors.map(e => `    ${e}`).join('\n')}\nSee more info here: https://nextjs.org/docs/messages/invalid-next-config`,
    )
  }
}

/** True when a dotted key path (e.g. `experimental.instrumentationHook`) is set. */
function hasNestedKey(config: NextConfigObject, dottedKey: string): boolean {
  let current: unknown = config
  for (const key of dottedKey.split('.')) {
    if (!current || typeof current !== 'object') return false
    current = (current as Record<string, unknown>)[key]
    if (current === undefined) return false
  }
  return true
}

function warnDeprecatedConfigOptions(config: NextConfigObject, configFileName: string): void {
  for (const { key, reason } of DEPRECATED_CONFIG_OPTIONS) {
    if (hasNestedKey(config, key)) console.warn(reason(configFileName))
  }
}

function warnUnknownConfigKeys(config: NextConfigObject): void {
  const invalid = Object.keys(config).filter(key => !KNOWN_TOP_LEVEL_CONFIG_KEYS.has(key))
  if (invalid.length === 0) return
  console.warn(
    `Invalid next.config.js options detected: ${invalid.map(key => `"${key}"`).join(', ')}`,
  )
}

/**
 * pnext bundles with esbuild only; a configured `webpack()` never runs. Warn once per config file (the
 * `webpackReferencesSvgr` check in setNextConfig separately auto-enables the `.svg`-as-component shim for
 * the common `@svgr/webpack` case, but the function itself is still never executed).
 */
function warnWebpackCompat(config: NextConfigObject, configFileName: string): void {
  if (typeof config.webpack !== 'function') return
  console.warn(
    `\`webpack\` in ${configFileName} is not executed by pnext — esbuild is the only bundler. ` +
      '`transpilePackages`, `experimental.optimizePackageImports`, and `turbopack.resolveAlias` are ' +
      'supported natively; see https://pnext.dev/docs/compat.',
  )
  if (webpackReferencesSvgr(config)) {
    console.info(
      'pnext detected @svgr/webpack in `webpack()` and will compile `.svg` imports to inline Preact ' +
        'components instead (see https://pnext.dev/docs/compat).',
    )
  }
}

function warnEsmExternalsFalse(config: NextConfigObject): void {
  const experimental = config.experimental
  if (!experimental || typeof experimental !== 'object') return
  if ((experimental as { esmExternals?: unknown }).esmExternals !== false) return
  console.warn(
    'The "experimental.esmExternals" option has been modified. experimental.esmExternals is not recommended to be modified as it may disrupt module resolution. It should be removed from your next.config.js',
  )
}

function validateDevIndicatorPosition(config: NextConfigObject): void {
  const devIndicators = config.devIndicators
  if (!devIndicators || typeof devIndicators !== 'object') return
  const position = (devIndicators as { position?: unknown }).position
  if (typeof position !== 'string' || VALID_DEV_INDICATOR_POSITIONS.has(position)) return
  throw new Error(
    `Invalid "devIndicator.position" provided, expected one of top-left, top-right, bottom-left, bottom-right, received ${position}`,
  )
}

/**
 * Load the app's next.config.* (if present), apply its `env`, stash the full
 * object for other compat modules, and return the subset mapped onto core.
 * Returns empty overrides when no config exists.
 */
export async function loadNextConfig(
  root: string,
  options: { dev?: boolean; serve?: boolean; warnings?: boolean } = {},
): Promise<LoadNextConfigResult> {
  const configPath = findConfigPath(root)
  if (!configPath) {
    setNextConfig({})
    emitSessionStartedTelemetry({})
    return { config: {}, overrides: {} }
  }
  let exported: NextConfigExport
  try {
    exported = await importConfigModule(configPath, root, {
      dev: Boolean(options.dev),
      serve: Boolean(options.serve),
    })
  } catch (error) {
    // A next.config that pulls in an optional wrapper dependency not installed
    // in this app (e.g. @next/mdx when deps are declared but not installed)
    // must not crash the whole build — the config's extras are optional here.
    // Fall back to defaults instead, matching the next/dist/* stub philosophy.
    if (isModuleNotFoundError(error)) {
      console.warn(
        `pnext: could not load ${path.relative(root, configPath)} ` +
          `(${describeMissingModule(error)}); continuing with default config`,
      )
      setNextConfig({})
      emitSessionStartedTelemetry({})
      return { config: {}, overrides: {} }
    }
    throw error
  }
  const config = normalizeCacheHandlerPath(
    await resolveConfigExport(exported, Boolean(options.dev)),
    root,
  )
  // Internal build workers need the resolved config but must not surface a
  // second copy of CLI warnings already emitted by the owning build process.
  validateConfig(config, configPath, options.warnings !== false)
  setNextConfig(config)
  applyEnv(config)
  applyRuntimeConfig(config)
  emitSessionStartedTelemetry(config)
  emitBuildFeatureUsageTelemetry(config)
  return { config, overrides: mapOverrides(config) }
}
