import { existsSync, realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { outCachePath, standaloneOutSegment } from './out-paths'
import { loadEnv } from './env'
import { findWorkspaceRoot } from './resolve/package-json'
import { PREFETCH_MODES, type PNextConfig } from './types'
import { setCacheComponents } from './render/ppr'
import { setLegacyRequestAPIs } from './request/context'
import {
  attachRelease,
  buildIndexFile,
  linkStandaloneOrigins,
  readBuildIndex,
  releaseConfig,
  releaseSourceRoot,
  servingReleaseDir,
} from './runtime/production'

export type ResolvedConfig = Required<Pick<PNextConfig, 'outDir' | 'basePath'>> &
  Omit<PNextConfig, 'outDir' | 'basePath'> & {
    root: string
    workspaceRoot: string
    appDir: string
    publicDir: 'public'
    appPath: string
    publicPath: string
    /** Where this process writes and serves from: `<outRoot>/standalone`, or `<outRoot>/dev` in dev. */
    outPath: string
    /** The out root itself (`.pnext`), identical in dev and build. */
    outRootPath: string
    /** Generated types — always under the out root, because tsconfig points at it. */
    typesPath: string
    /**
     * Generated per-route assignability checks. Deliberately OUTSIDE typesPath: an app's
     * tsconfig includes `<outRoot>/types/**` and a foreign compiler must never see pnext's
     * own internals. pnext's private typecheck project includes this directory instead.
     */
    checksPath: string
  }

/**
 * The out root before any `outDir`/`distDir` override. Also where a config source keeps the build
 * artifacts it must emit BEFORE the override it carries is known — the next.config bundle sits here
 * even for an app whose own output moved elsewhere, so deployment adapters ship it from here.
 */
export const DEFAULT_OUT_DIR = '.pnext'

const defaultConfig = {
  outDir: DEFAULT_OUT_DIR,
  basePath: '',
} satisfies Required<Pick<PNextConfig, 'outDir' | 'basePath'>>

// configSources seam. Core owns the shape; compat populates it.
//
// A configSource loads an external framework config (Next's next.config.*), applies its side effects (env,
// say), and returns the subset that maps onto pnext's core config. loadConfig invokes the registered
// source, if any, after resolving the pnext config and merges its overrides on top of the defaults.
//
// The Next source is registered from src/compat/register/config.ts. Because loadConfig runs at each
// composition root *before* bootstrapCompat, it also lazily loads that source itself through one gated
// dynamic import when compat.next is enabled - mirroring the compat-bootstrap gate so core keeps no static
// edge into compat.
export interface ConfigSourceOverrides {
  basePath?: string
  trailingSlash?: boolean
  skipTrailingSlashRedirect?: boolean
  outDir?: string
  assetPrefix?: string
  productionBrowserSourceMaps?: boolean
}
export type ConfigSource = (
  root: string,
  options: {
    dev?: boolean
    serve?: boolean
    warnings?: boolean
    bundle?: string | null
    handlers?: Record<string, string>
  },
) => Promise<ConfigSourceOverrides>

let configSource: ConfigSource | undefined

export function registerConfigSource(source: ConfigSource): void {
  configSource = source
}

async function resolveConfigSource(
  config: PNextConfig,
  root: string,
  options: Parameters<ConfigSource>[1],
): Promise<ConfigSourceOverrides> {
  if (!config.compat?.next) return {}
  if (!configSource) {
    await import('./compat/register/config').then(module => module.registerConfigSource())
  }
  if (!configSource) return {}
  return configSource(root, options)
}

// `serve` marks a production start (including a deployment adapter's request handler): config sources
// then consume what the build emitted instead of regenerating it, since request time can be read-only.
export async function loadConfig(
  rootInput = process.cwd(),
  options: { dev?: boolean; serve?: boolean; warnings?: boolean } = {},
): Promise<ResolvedConfig> {
  const root = canonicalRoot(path.resolve(rootInput))
  const released = options.serve ? servingReleaseDir() : undefined
  if (released) return loadReleasedConfig(root, released, options)
  await loadEnv(root, options)
  const configPath = path.join(root, 'pnext.config.ts')
  const loadedConfig = existsSync(configPath)
    ? ((await import(pathToFileHref(configPath))) as { default?: PNextConfig })
    : {}
  const config: PNextConfig = {
    ...(loadedConfig.default ?? {}),
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    ...(process.env.PNEXT_COMPAT === 'next'
      ? {
          compat: {
            ...(loadedConfig.default?.compat ?? {}),
            // An object `next` already enables compat — keep its options rather than flattening to true.
            next: loadedConfig.default?.compat?.next || true,
          },
        }
      : {}),
  }
  validateConfig(config)
  // Per-app flag on a process-global cell (like cacheComponents): always written, never inherited.
  setLegacyRequestAPIs(
    typeof config.compat?.next === 'object' && config.compat.next.legacyRequestAPIs === true,
  )
  // cacheComponents is a per-app flag on a process-global cell: clear it before
  // the next.config source re-derives it, so a pure-core (or flag-off) app
  // loaded after a cacheComponents app never inherits the previous build's flag.
  setCacheComponents(false)
  const sourceOverrides = stripUndefined(await resolveConfigSource(config, root, options))
  const merged = { ...defaultConfig, ...config, ...sourceOverrides }
  const outRootPath = path.resolve(root, merged.outDir)
  // `pnext start` reads outDir from the config, as `next start` reads distDir, then serves the release.
  const release = path.join(outRootPath, standaloneOutSegment)
  if (options.serve && existsSync(buildIndexFile(release))) {
    // The source config above already warned; its compiled copy must not warn again.
    return loadReleasedConfig(root, release, { ...options, warnings: false })
  }
  // A build materializes pages into its output, so the release names them portably.
  const appPath = await resolveAppPath(
    root,
    config,
    options.dev ? undefined : path.join(outRootPath, 'pnext-pages-compat'),
  )
  const workspaceRoot = canonicalRoot(
    config.workspaceRoot
      ? path.resolve(root, config.workspaceRoot)
      : (findWorkspaceRoot(root) ?? root),
  )

  return {
    ...config,
    trailingSlash: merged.trailingSlash ?? config.trailingSlash,
    productionBrowserSourceMaps:
      merged.productionBrowserSourceMaps ?? config.productionBrowserSourceMaps,
    skipTrailingSlashRedirect: merged.skipTrailingSlashRedirect ?? config.skipTrailingSlashRedirect,
    appDir: path.relative(root, appPath),
    publicDir: 'public',
    outDir: merged.outDir,
    basePath: merged.basePath,
    // Assets are addressed under basePath (the server 404s outside it), so an
    // app that sets basePath without an explicit assetPrefix serves assets at
    // `${basePath}/assets/...` — Next's default (assetPrefix falls back to
    // basePath).
    assetPrefix: merged.assetPrefix ?? merged.basePath,
    root,
    workspaceRoot,
    appPath,
    publicPath: path.resolve(root, 'public'),
    // Dev owns `<outRoot>/dev` exclusively so a concurrent `pnext build` — which
    // wipes its own outputs under the out root — can never pull a running dev
    // server's cache, manifest or assets out from under it.
    outPath: path.join(outRootPath, options.dev ? devOutSegment : standaloneOutSegment),
    outRootPath,
    typesPath: path.join(outRootPath, 'types'),
    checksPath: path.join(outRootPath, 'typecheck', 'checks'),
  }
}

/**
 * A production server's config: what the build resolved, read from its release instead of re-importing
 * `pnext.config.ts`/`next.config.*`. Per-app process state is re-derived exactly as a source load does.
 */
async function loadReleasedConfig(
  root: string,
  outPath: string,
  options: { dev?: boolean; serve?: boolean; warnings?: boolean },
): Promise<ResolvedConfig> {
  const index = readBuildIndex(outPath)
  linkStandaloneOrigins(outPath)
  const sourceRoot = releaseSourceRoot(outPath, index.config.outPath as string)
  const config = releaseConfig(index.config, sourceRoot, outPath)
  await loadEnv(root, options)
  setLegacyRequestAPIs(
    typeof config.compat?.next === 'object' && config.compat.next.legacyRequestAPIs === true,
  )
  setCacheComponents(false)
  await resolveConfigSource(config, root, {
    ...options,
    bundle: index.nextConfig ? path.resolve(outPath, index.nextConfig) : null,
    handlers: Object.fromEntries(
      Object.entries(index.compat?.cacheHandlers ?? {}).map(([name, file]) => [
        name,
        path.resolve(outPath, file),
      ]),
    ),
  })
  attachRelease(config, index)
  return config
}

// One row per enum-valued config field; validateConfig checks them all.
const enumFields: readonly [keyof PNextConfig, readonly unknown[]][] = [
  ['prefetch', PREFETCH_MODES],
]

function validateConfig(config: PNextConfig) {
  for (const [field, allowed] of enumFields) {
    const value = config[field]
    if (value === undefined || allowed.includes(value)) continue
    const list = allowed.map(v => (typeof v === 'string' ? `'${v}'` : String(v))).join(', ')
    throw new Error(
      `Invalid pnext config: '${field}' must be one of ${list} (received ${JSON.stringify(value)}).`,
    )
  }
}

/** Dev's private subtree under the out root. Build never touches it. */
export const devOutSegment = 'dev'

export { outCachePath, standaloneOutSegment }

// Relative-import resolution realpaths the importing file (so a materialized shim resolves `./sibling`
// against real source), so every containment check against root/workspaceRoot compares realpaths.
// Canonicalize the roots to match - otherwise an app served through a symlinked directory (a macOS
// tmpdir, a pnpm-linked checkout) reads as "outside the workspace" and its own source files stop
// resolving. A no-op when the path holds no symlinks.
function canonicalRoot(dir: string) {
  try {
    return realpathSync(dir)
  } catch {
    return dir
  }
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

export function pathToFileHref(filePath: string) {
  // pathToFileURL percent-encodes literal special characters (notably `%`, so a
  // directory physically named `%5Ffoo` on disk stays `%255Ffoo` in the href and
  // import() decodes it back to the literal `%5Ffoo` rather than to `_foo`).
  return pathToFileURL(path.resolve(filePath)).href
}

export function publicEnvDefines() {
  const publicEnv = Object.fromEntries([
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    ['NODE_ENV', process.env.NODE_ENV ?? 'production'],
    ...Object.entries(process.env).filter(
      ([key]) => key.startsWith('NEXT_PUBLIC_') || key.startsWith('PNEXT_PUBLIC_'),
    ),
  ]) as Record<string, string>
  return {
    // The whole object, not just the keys that happen to be SET at build time. A browser has no
    // `process`, so a `NEXT_PUBLIC_*` the source reads but the environment never defined would
    // otherwise survive as a bare reference and throw ReferenceError on first evaluation - taking
    // hydration, and every event handler on the page, down with it. Reading a missing key off this
    // yields undefined, which is what Next inlines for one.
    'process.env': JSON.stringify(publicEnv),
    ...Object.fromEntries(
      Object.entries(publicEnv).map(([key, value]) => [
        `process.env.${key}`,
        JSON.stringify(value),
      ]),
    ),
  }
}

type FrameworkRuntimeAlias =
  | 'preact'
  | 'preact/hooks'
  | 'preact/compat'
  | 'preact/compat/client'
  | 'preact/jsx-runtime'
  | 'preact/jsx-dev-runtime'
  | 'react-compiler-runtime'

export type CompatAliasTarget = 'server' | 'client'

/**
 * Seven `import.meta.resolve` calls against the framework's OWN install - the answer cannot change for the
 * life of the process, and every esbuild build builds an alias map (a vendor pass runs hundreds of those).
 */
let frameworkRuntimeAliases: Record<FrameworkRuntimeAlias, string> | undefined

export function frameworkRuntimeAliasEntries(): Record<FrameworkRuntimeAlias, string> {
  frameworkRuntimeAliases ??= {
    preact: resolveRuntimeModule('preact'),
    'preact/hooks': resolveRuntimeModule('preact/hooks'),
    'preact/compat': resolveRuntimeModule('preact/compat'),
    'preact/compat/client': resolveRuntimeModule('preact/compat/client'),
    'preact/jsx-runtime': resolveRuntimeModule('preact/jsx-runtime'),
    'preact/jsx-dev-runtime': resolveRuntimeModule('preact/jsx-dev-runtime'),
    'react-compiler-runtime': resolveRuntimeModule('react-compiler-runtime'),
  }
  return frameworkRuntimeAliases
}

/** Packages the framework resolves at runtime by name, not by import. */
export const frameworkRuntimeSpecifiers = (): string[] =>
  Object.keys(frameworkRuntimeAliasEntries())

function resolveRuntimeModule(specifier: string) {
  return fileURLToPath(import.meta.resolve(specifier))
}

export function pnextAliases(target: CompatAliasTarget): Record<string, string> {
  if (target !== 'client') return {}
  return {
    '@wular/pnext/cache': path.resolve(import.meta.dirname, 'api/client-cache.ts'),
  }
}

async function resolveAppPath(root: string, config: PNextConfig, pagesBase?: string) {
  const rootApp = path.join(root, 'app')
  if (config.compat?.next) {
    const pagesPath = path.join(root, 'pages')
    const hasPages = existsSync(pagesPath)
    if (existsSync(rootApp)) {
      if (hasPages) {
        const { materializePagesApp } = await import('./compat/pages/router')
        const hybrid = await materializePagesApp(root, pagesBase)
        if (hybrid) return hybrid
      }
      return rootApp
    }
    const { materializePagesApp } = await import('./compat/pages/router')
    const pagesApp = await materializePagesApp(root, pagesBase)
    if (pagesApp) return pagesApp
  } else if (existsSync(rootApp)) return rootApp
  return path.join(root, 'src', 'app')
}
