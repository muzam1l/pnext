// ---------------------------------------------------------------------------
// Bundler config accessors (COMPAT).
//
// Small typed readers over the loaded next.config (getNextConfig()) for the
// bundler-feature plugins. Kept in one place so every plugin reads the same
// normalized shapes and a pure-core / non-next app (empty config) degrades to
// safe defaults.
// ---------------------------------------------------------------------------

import { getNextConfig } from '../next/config-loader'
import type { ModularizeRule } from './modularize-imports'

/** A predefined built-in set kept external server-side (Next ships this list). */
const PREDEFINED_SERVER_EXTERNAL_PACKAGES = [
  'sharp',
  'sqlite3',
  'better-sqlite3',
  'canvas',
  '@node-rs/argon2',
  '@node-rs/bcrypt',
]

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

/**
 * `serverExternalPackages` + the predefined built-in list: packages kept external
 * (resolved from node_modules, never bundled) in the server graph.
 */
export function serverExternalPackages(): Set<string> {
  const config = getNextConfig()
  return new Set([
    ...PREDEFINED_SERVER_EXTERNAL_PACKAGES,
    ...stringArray(config.serverExternalPackages),
  ])
}

/**
 * The build's deployment id: next.config `deploymentId`, else the
 * `NEXT_DEPLOYMENT_ID` env var (Next accepts either). Inlined into every graph
 * and written to `required-server-files.json` so tooling can read it back.
 */
export function deploymentId(): string | undefined {
  const configured = getNextConfig().deploymentId
  if (typeof configured === 'string' && configured.length > 0) return configured
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const fromEnv = process.env.NEXT_DEPLOYMENT_ID
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined
}

/** `publicRuntimeConfig`: the subset of runtime config safe to inline into client bundles. */
export function publicRuntimeConfig(): Record<string, unknown> {
  const config = getNextConfig().publicRuntimeConfig
  return config && typeof config === 'object' ? (config as Record<string, unknown>) : {}
}

/** `transpilePackages`: node_modules packages force-bundled + transpiled. */
export function transpilePackages(): string[] {
  return stringArray(getNextConfig().transpilePackages)
}

/**
 * `modularizeImports`: specifier -> `{ transform, skipDefaultConversion }`
 * rules that split barrel imports into per-member imports. Only the string
 * `transform` template form is honored (the shape Next's compat fixtures use);
 * malformed/object-template entries are dropped so a build still proceeds.
 */
export function modularizeImports(): Record<string, ModularizeRule> {
  const raw = getNextConfig().modularizeImports
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, ModularizeRule> = {}
  for (const [specifier, value] of Object.entries(raw as Record<string, unknown>)) {
    if (
      value &&
      typeof value === 'object' &&
      typeof (value as ModularizeRule).transform === 'string'
    ) {
      const rule = value as ModularizeRule
      out[specifier] = {
        transform: rule.transform,
        skipDefaultConversion: Boolean(rule.skipDefaultConversion),
      }
    }
  }
  return out
}

/**
 * `experimental.optimizePackageImports`: barrel packages whose named imports
 * are rewritten to their leaf modules (see optimize-package-imports.ts). The
 * configured list EXTENDS the built-in default set, as Next's does.
 */
export function optimizePackageImports(): string[] {
  const experimental = getNextConfig().experimental as
    { optimizePackageImports?: unknown } | undefined
  return stringArray(experimental?.optimizePackageImports)
}

/** A normalized `compiler.relay` entry (see relay-transform.ts). */
export interface RelayCompilerConfig {
  /** Source root the transform applies to, relative to `process.cwd()`. */
  src: string
  /** Where relay-compiler wrote its artifacts, relative to `process.cwd()`. */
  artifactDirectory?: string
  /** The artifact language: decides the generated file's extension. */
  language: 'javascript' | 'typescript' | 'flow'
}

/**
 * `compiler.relay`: the Relay SWC transform's config. `src` is required by
 * Next's schema; `language` defaults to `'javascript'`. Returns undefined when
 * unconfigured so the transform stays a no-op.
 */
export function relayCompilerConfig(): RelayCompilerConfig | undefined {
  const compiler = getNextConfig().compiler as
    { relay?: { src?: unknown; artifactDirectory?: unknown; language?: unknown } } | undefined
  const relay = compiler?.relay
  if (!relay || typeof relay !== 'object' || typeof relay.src !== 'string') return undefined
  const language = relay.language
  return {
    src: relay.src,
    artifactDirectory:
      typeof relay.artifactDirectory === 'string' ? relay.artifactDirectory : undefined,
    language:
      language === 'typescript' || language === 'flow' || language === 'javascript'
        ? language
        : 'javascript',
  }
}

/**
 * `experimental.esmExternals`: `true` (default) | `false` | `'loose'`.
 * Controls whether ESM externals stay external or are bundled.
 */
export function esmExternals(): boolean | 'loose' {
  const experimental = getNextConfig().experimental as
    { esmExternals?: boolean | 'loose' } | undefined
  return experimental?.esmExternals ?? true
}

/**
 * `resolveExtensions`: user-supplied resolver extension order, if any. Next accepts the top-level key,
 * `turbopack.resolveExtensions`, and the legacy `experimental.turbo.resolveExtensions` spelling.
 */
export function resolveExtensions(): string[] | undefined {
  const config = getNextConfig()
  const turbopack = config.turbopack as { resolveExtensions?: unknown } | undefined
  const experimental = config.experimental as
    { turbo?: { resolveExtensions?: unknown } } | undefined
  for (const value of [
    config.resolveExtensions,
    turbopack?.resolveExtensions,
    experimental?.turbo?.resolveExtensions,
  ]) {
    const list = stringArray(value)
    if (list.length > 0) return list
  }
  return undefined
}

/** `typescript.tsconfigPath`: a non-default tsconfig location. */
export function tsconfigPath(): string | undefined {
  const ts = getNextConfig().typescript as { tsconfigPath?: string } | undefined
  return typeof ts?.tsconfigPath === 'string' ? ts.tsconfigPath : undefined
}

export interface CompilerDefines {
  /** Inlined into BOTH server and client bundles. */
  define: Record<string, string>
  /** Inlined into the SERVER bundle only (client sees the fallback). */
  defineServer: Record<string, string>
}

function normalizeDefineMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    // esbuild `define` values must be JS source text: strings need to be
    // JSON-encoded, primitives stringified.
    if (typeof raw === 'string') out[key] = JSON.stringify(raw)
    else if (typeof raw === 'number' || typeof raw === 'boolean') out[key] = String(raw)
  }
  return out
}

/** `compiler.define` / `compiler.defineServer` inlined-constant maps. */
export function compilerDefines(): CompilerDefines {
  const compiler = getNextConfig().compiler as
    { define?: Record<string, unknown>; defineServer?: Record<string, unknown> } | undefined
  return {
    define: normalizeDefineMap(compiler?.define),
    defineServer: normalizeDefineMap(compiler?.defineServer),
  }
}

/** The console methods Next's SWC `removeConsole` transform can target. */
const CONSOLE_METHODS = [
  'assert',
  'clear',
  'count',
  'countReset',
  'debug',
  'dir',
  'dirxml',
  'error',
  'group',
  'groupCollapsed',
  'groupEnd',
  'info',
  'log',
  'table',
  'time',
  'timeEnd',
  'timeLog',
  'trace',
  'warn',
]

/**
 * `compiler.removeConsole`: `true` strips every `console.*` call; `{ exclude }`
 * strips all methods except the listed ones. Returns the `console.<method>`
 * esbuild `pure` targets to strip, or `undefined` when unconfigured.
 */
export function removeConsoleTargets(): string[] | undefined {
  const compiler = getNextConfig().compiler as
    { removeConsole?: boolean | { exclude?: unknown } } | undefined
  const removeConsole = compiler?.removeConsole
  if (!removeConsole) return undefined
  const exclude = new Set(
    typeof removeConsole === 'object' ? stringArray(removeConsole.exclude) : [],
  )
  return CONSOLE_METHODS.filter(method => !exclude.has(method)).map(method => `console.${method}`)
}

/** `cacheComponents` (PPR): gates the `next-js` export condition. */
export function cacheComponentsEnabled(): boolean {
  const config = getNextConfig()
  const experimental = config.experimental as { cacheComponents?: boolean } | undefined
  return Boolean(config.cacheComponents ?? experimental?.cacheComponents)
}

/**
 * `experimental.swcEnvOptions`: when `mode: 'usage'`, SWC injects core-js
 * polyfills for JS features the build targets (per browserslist) that the user
 * code actually uses. pnext mirrors the user-visible outcome for the features
 * apps rely on: usage-based injection of the matching core-js module into the
 * client graph. Returns the configured mode (or undefined when unset).
 */
export function swcEnvUsageMode(): 'usage' | 'entry' | undefined {
  const experimental = getNextConfig().experimental as
    { swcEnvOptions?: { mode?: unknown } } | undefined
  const mode = experimental?.swcEnvOptions?.mode
  return mode === 'usage' || mode === 'entry' ? mode : undefined
}

/** Next's `reactCompiler` / legacy experimental flag. */
export function reactCompilerEnabled(): boolean {
  const config = getNextConfig()
  const experimental = config.experimental as { reactCompiler?: boolean } | undefined
  return Boolean(config.reactCompiler ?? experimental?.reactCompiler)
}

/** A single `turbopack.rules` entry, normalized to the shapes pnext supports. */
export interface WebpackLoaderRule {
  /** The rule's glob key, e.g. `'*.txt'` or `'*.test-file.ts'`. Only a leading `*` wildcard is honored. */
  glob: string
  /** Loader module specifiers (relative path or bare package name), applied in array order. */
  loaders: string[]
  /** The virtual extension of the loader chain's final output, e.g. `'*.js'`. */
  as?: string
  /**
   * A conditional rule guard: the rule only applies when the import's
   * `resourceQuery` matches (string equality or a regex `.test`). Comes from the
   * conditional-array rule form `'*.ext': [{ condition: { query }, loaders }]`.
   */
  condition?: { query: string | RegExp }
  /**
   * A no-loader `type` asset rule: how the raw file is represented as a module.
   * `'resource'` emits the file under `/_next/static/media` and exports its URL
   * string; `'bytes'` exports a `Uint8Array`; `'source'` exports the file text.
   */
  assetType?: 'resource' | 'bytes' | 'source'
}

/**
 * `turbopack.rules`: Next's webpack-loader-rule config, read directly (rather
 * than executing the `webpack(config)` mutator) since fixtures configure both
 * spellings with equivalent semantics. Handles the loader shorthand/object
 * form, the conditional-array form (`[{ condition, loaders, as }]`), and no-
 * loader `type` asset rules (`{ type: 'asset' | 'bytes' | 'asset/source' }`).
 */
export function turbopackLoaderRules(): WebpackLoaderRule[] {
  const config = getNextConfig()
  const turbopack = config.turbopack as { rules?: Record<string, unknown> } | undefined
  const rules = turbopack?.rules
  if (!rules || typeof rules !== 'object') return []
  const out: WebpackLoaderRule[] = []
  for (const [glob, raw] of Object.entries(rules)) collectLoaderRuleEntries(glob, raw, out)
  return out
}

function collectLoaderRuleEntries(glob: string, raw: unknown, out: WebpackLoaderRule[]): void {
  if (Array.isArray(raw)) {
    // A plain array of loader specifiers, or the conditional-array form whose
    // entries are `{ condition, loaders, as }` objects.
    if (raw.every(item => typeof item === 'string')) {
      const loaders = stringArray(raw)
      if (loaders.length > 0) out.push({ glob, loaders })
      return
    }
    for (const item of raw) {
      if (item && typeof item === 'object')
        pushLoaderRuleObject(glob, item as Record<string, unknown>, out)
    }
    return
  }
  if (raw && typeof raw === 'object')
    pushLoaderRuleObject(glob, raw as Record<string, unknown>, out)
}

function pushLoaderRuleObject(
  glob: string,
  entry: Record<string, unknown>,
  out: WebpackLoaderRule[],
): void {
  const loaders = stringArray(entry.loaders)
  const as = typeof entry.as === 'string' ? entry.as : undefined
  const condition = parseRuleCondition(entry.condition)
  if (loaders.length > 0) {
    out.push({ glob, loaders, as, ...(condition ? { condition } : {}) })
    return
  }
  const assetType = parseAssetRuleType(entry.type)
  if (assetType) out.push({ glob, loaders: [], as, assetType })
}

function parseRuleCondition(value: unknown): { query: string | RegExp } | undefined {
  if (!value || typeof value !== 'object') return undefined
  const query = (value as { query?: unknown }).query
  if (typeof query === 'string' || query instanceof RegExp) return { query }
  return undefined
}

function parseAssetRuleType(value: unknown): 'resource' | 'bytes' | 'source' | undefined {
  if (value === 'asset' || value === 'asset/resource') return 'resource'
  if (value === 'bytes') return 'bytes'
  if (value === 'asset/source') return 'source'
  return undefined
}

/**
 * `turbopack.resolveAlias`: specifier-to-replacement-path mappings. Exact keys and trailing-glob keys
 * are both honored. Values are returned verbatim - relative paths are resolved against the project root
 * by the consumer.
 */
export function turbopackResolveAlias(): Record<string, string> {
  const turbopack = getNextConfig().turbopack as { resolveAlias?: unknown } | undefined
  const alias = turbopack?.resolveAlias
  if (!alias || typeof alias !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(alias as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}
