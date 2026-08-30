// `turbopack.rules` loader-chain support (COMPAT).
//
// Next's turbopack.rules let a project route specific extensions through custom "loader" modules -
// plain functions receiving the raw file content and returning replacement module source. pnext has no
// webpack/turbopack graph to run these against, so this plugin re-implements the loader-invocation
// contract directly: resolve each configured loader module, call it with a minimal loader-context
// (resourcePath, resourceQuery, fs, async/callback, getOptions, getResolve, addDependency,
// importModule), and feed the result to esbuild via the loader picked from the rule's `as` or the
// source file's own extension - matching the sync/async/callback-style loaders, raw-Buffer content and
// chained-output-as-module-source shapes the fixtures exercise.
//
// Also supports the conditional-array rule form (condition.query selects a chain by the import's
// query), `turbopack.resolveAlias`, and no-loader `type` asset rules.
//
// Registered first in both client and server esbuild plugin arrays so a configured rule preempts
// pnext's default handling for the same extension.

import { createHash } from 'node:crypto'
import { existsSync, readFile, readFileSync, realpathSync } from 'node:fs'
import { mkdir, readFile as readFileP, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Plugin } from 'esbuild'
import type { ResolvedConfig } from '../../config'
import { rewriteSpecifierLiterals } from '../../resolve/scan-facts'
import { turbopackLoaderRules, turbopackResolveAlias, type WebpackLoaderRule } from './config'

interface LoaderFn {
  (this: LoaderContext, content: string | Buffer): unknown
  raw?: boolean
}

interface LoaderContext {
  resourcePath: string
  resourceQuery: string
  mode: string
  fs: {
    readFile: typeof readFile
    readFileSync: typeof readFileSync
  }
  addDependency: (file: string) => void
  getOptions: () => Record<string, unknown>
  async: () => (err: unknown, result?: unknown) => void
  callback: (err: unknown, result?: unknown, ...rest: unknown[]) => void
  getResolve: (options?: unknown) => (context: string, request: string) => Promise<string>
  emitFile: (name: string, content: unknown) => void
  importModule: (request: string) => Promise<unknown>
}

/** Where a loader chain runs — client builds cannot support `this.importModule`. */
type LoaderContextTarget = 'client' | 'server'

const RESOLVE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json']

function stripLeadingWildcard(glob: string): string {
  return glob.startsWith('*') ? glob.slice(1) : glob
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function ruleMatches(rule: WebpackLoaderRule, filePath: string): boolean {
  return rule.glob.startsWith('*')
    ? filePath.endsWith(stripLeadingWildcard(rule.glob))
    : path.basename(filePath) === rule.glob
}

function conditionMatches(rule: WebpackLoaderRule, resourceQuery: string): boolean {
  if (!rule.condition) return true
  const query = rule.condition.query
  return typeof query === 'string' ? resourceQuery === query : query.test(resourceQuery)
}

/** First rule whose glob matches (ignoring any `condition`). */
function findRule(rules: WebpackLoaderRule[], filePath: string): WebpackLoaderRule | undefined {
  return rules.find(rule => ruleMatches(rule, filePath))
}

/** First rule whose glob matches AND whose `condition.query` accepts `resourceQuery`. */
function findRuleForResource(
  rules: WebpackLoaderRule[],
  filePath: string,
  resourceQuery: string,
): WebpackLoaderRule | undefined {
  return rules.find(rule => ruleMatches(rule, filePath) && conditionMatches(rule, resourceQuery))
}

/**
 * Whether a configured `turbopack.rules` loader chain claims this file. The generic "ignored
 * asset"/static-image resolvers redirect those extensions to their own namespace unconditionally, ahead
 * of the bundler-extension plugins where this plugin lives, so a configured rule for e.g. `*.svg` would
 * never get a chance without this escape hatch. Registered as the sole `hasLoaderRuleFor`
 * implementation so all three asset-claiming resolvers share one check. Accepts a raw specifier with an
 * optional query or hash suffix and strips it here.
 */
export function hasWebpackLoaderRuleFor(filePath: string): boolean {
  const [sourcePath = filePath] = filePath.split(/[?#]/, 1)
  return findRule(turbopackLoaderRules(), sourcePath) !== undefined
}

/**
 * Run the loader chain a `turbopack.rules` entry configures for `specifier` (alias-aware,
 * query-carrying) and materialize its output as a real module on disk, returning that path - or
 * undefined when no rule claims it.
 *
 * This is the SERVER-graph counterpart of the esbuild plugin. Server modules are not one esbuild graph:
 * each app module is compiled on its own and route files are inlined into a route bundle, so a rule
 * source never reaches a plugin onLoad with its importer's query intact. Core's resolvers ask this seam
 * instead and import the artifact directly. Loaders may be effectful, so each (file, query) pair runs
 * exactly once per process and every resolver shares the result.
 */
export function webpackLoaderRuleModule(
  config: ResolvedConfig,
  specifier: string,
  importer: string,
): string | undefined | Promise<string | undefined> {
  const rules = turbopackLoaderRules()
  if (rules.length === 0) return undefined
  const [base = specifier] = specifier.split(/[?#]/, 1)
  const query = specifier.slice(base.length)
  const fromDir = path.dirname(originalResourcePath(importer, config))
  const resourcePath = resolveSpecifier(config.root, fromDir, base) ?? base
  if (!findRuleForResource(rules, resourcePath, query)) return undefined
  const key = `${resourcePath}\0${query}`
  const existing = ruleModuleArtifacts.get(key)
  if (existing) return existing
  const built = buildRuleModuleArtifact(config, rules, resourcePath, query).catch(error => {
    ruleModuleArtifacts.delete(key)
    throw error
  })
  ruleModuleArtifacts.set(key, built)
  return built
}

const ruleModuleArtifacts = new Map<string, Promise<string | undefined>>()

async function buildRuleModuleArtifact(
  config: ResolvedConfig,
  rules: WebpackLoaderRule[],
  resourcePath: string,
  query: string,
): Promise<string | undefined> {
  const loaded = await loadRuleModule(config.root, rules, resourcePath, query, 'server', config)
  if (!loaded) return undefined
  // Named by the source name + a hash of (path, query, output): distinct
  // `?query` imports of one file stay distinct modules, and a re-run that
  // produces the same text reuses the same artifact.
  const hash = createHash('sha256')
    .update(`${resourcePath}\0${query}\0${loaded.contents}`)
    .digest('hex')
    .slice(0, 16)
  const name = path.basename(resourcePath).replace(/[^A-Za-z0-9_.-]+/g, '-')
  // The chain's output loader doubles as the artifact extension, so Bun and
  // esbuild both parse it the way the rule's `as` declared.
  const outFile = path.join(
    config.outPath,
    'cache',
    'loader-rules',
    `${name}.${hash}.${loaded.loader}`,
  )
  await mkdir(path.dirname(outFile), { recursive: true })
  await writeFile(outFile, loaded.contents)
  return outFile
}

/** esbuild/Bun `loader` for a rule's declared (or inferred) output extension. */
function outputLoader(rule: WebpackLoaderRule, resourcePath: string): 'ts' | 'tsx' | 'jsx' {
  const ext = (rule.as ? stripLeadingWildcard(rule.as) : path.extname(resourcePath)).toLowerCase()
  if (ext.endsWith('.tsx')) return 'tsx'
  if (ext.endsWith('.ts')) return 'ts'
  return 'jsx'
}

function toBuffer(content: string | Buffer): Buffer {
  return Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
}

function toStringContent(content: string | Buffer): string {
  return Buffer.isBuffer(content) ? content.toString('utf8') : content
}

// ---------------------------------------------------------------------------
// Specifier resolution (resolveAlias + relative/absolute, with extension probe)
// ---------------------------------------------------------------------------

// Absolute path of pnext's own `src/` (or `dist/` in a built install) — modules
// under it are framework runtime, not app code, and are exempt from user
// `resolveAlias`/`resolve.alias` entries.
const PNEXT_RUNTIME_ROOT = path.resolve(import.meta.dirname, '../..')

function isPNextRuntimeImporter(importer: string): boolean {
  if (!importer) return false
  const rel = path.relative(PNEXT_RUNTIME_ROOT, importer)
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function firstExisting(base: string): string | undefined {
  for (const ext of RESOLVE_EXTENSIONS) {
    if (existsSync(base + ext)) return base + ext
  }
  return undefined
}

/**
 * Map a specifier through `turbopack.resolveAlias`, returning the resolved absolute target path, or
 * undefined when no alias matches. Supports exact keys and trailing-glob keys.
 */
function resolveAliasSpecifier(specifier: string, root: string): string | undefined {
  for (const [key, target] of Object.entries(turbopackResolveAlias())) {
    if (key.endsWith('/*')) {
      const prefix = key.slice(0, -1) // e.g. '@/*' -> '@/'
      if (specifier.startsWith(prefix)) {
        const rest = specifier.slice(prefix.length)
        const mapped = target.endsWith('/*')
          ? target.slice(0, -1) + rest
          : target.replace('*', rest)
        return resolveAliasTarget(mapped, root)
      }
    } else if (specifier === key) {
      return resolveAliasTarget(target, root)
    }
  }
  return undefined
}

function resolveAliasTarget(target: string, root: string): string {
  if (path.isAbsolute(target)) return target
  if (target.startsWith('.')) return path.resolve(root, target)
  return target
}

/**
 * Resolve a specifier (alias-aware) to an absolute on-disk path. Returns the best candidate even when
 * the file cannot be probed; bare non-alias specifiers return undefined and are left to the host
 * resolver.
 */
function resolveSpecifier(root: string, fromDir: string, specifier: string): string | undefined {
  const aliased = resolveAliasSpecifier(specifier, root)
  if (aliased) return firstExisting(aliased) ?? aliased
  if (path.isAbsolute(specifier)) return firstExisting(specifier) ?? specifier
  if (specifier.startsWith('.')) {
    const base = path.resolve(fromDir, specifier)
    return firstExisting(base) ?? base
  }
  return undefined
}

/**
 * Rewrite `turbopack.resolveAlias` BARE specifiers to their resolved absolute paths in server source.
 *
 * Both esbuild passes and the runtime Bun.plugin hook below map aliases in onResolve - but Bun's runtime
 * resolver rejects an unknown bare package specifier before any plugin onResolve runs, so a module the
 * SERVER RUNTIME loads directly can only be fixed in its source. That is the case for a
 * `this.importModule()` target's own transitive imports: the direct request is alias-resolved by
 * importModuleFor, everything past it is plain import() resolution. Relative and absolute specifiers
 * are left alone - those resolve natively.
 */
export function rewriteResolveAliasImports(source: string, file: string, root: string): string {
  const aliases = turbopackResolveAlias()
  if (Object.keys(aliases).length === 0) return source
  return rewriteSpecifierLiterals(source, file, (specifier, kind) => {
    // Same scope as the `from`-anchored regex this replaced: side-effect
    // imports stay with the host resolver.
    if (kind === 'side-effect') return undefined
    if (specifier.startsWith('.') || path.isAbsolute(specifier)) return undefined
    const aliased = resolveAliasSpecifier(specifier, root)
    if (!aliased) return undefined
    const target = firstExisting(aliased) ?? aliased
    // A bare alias target (e.g. `'preact/compat': 'react'`) is not a file path;
    // leave the host resolver to handle it.
    if (!path.isAbsolute(target)) return undefined
    return JSON.stringify(target)
  })
}

/** `this.getResolve()(context, request)` — alias-aware, extension-probing. */
function resolveLoaderRequest(root: string, context: string, request: string): Promise<string> {
  const resolved = resolveSpecifier(root, context, request)
  if (resolved && existsSync(resolved)) return Promise.resolve(resolved)
  return Promise.reject(new Error(`Cannot resolve '${request}' from '${context}'`))
}

/**
 * Server bundles compile against materialized COPIES of the app tree, not symlinks, so sibling files do
 * not exist next to the materialized copy. A loader's relative `this.importModule('../x')` /
 * `this.getResolve()` must therefore resolve against the ORIGINAL file's directory. Recover it by
 * rebasing the materialized path onto `config.workspaceRoot`, stripping the cache root and the leading
 * profile segment; out-of-workspace modules are keyed `external/<hash>` and simply fail the existence
 * check, falling through unchanged. `realpathSync` is kept only as a secondary fallback for the
 * symlinked-asset case - it is a no-op for the real copied code-module files this path mainly handles.
 */
function originalResourcePath(resourcePath: string, config: ResolvedConfig | undefined): string {
  if (config) {
    const cacheRoot = path.join(config.outPath, 'cache', 'server')
    const rel = path.relative(cacheRoot, resourcePath)
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      const segments = rel.split(path.sep)
      segments.shift() // drop <profileDir>
      const original = path.join(config.workspaceRoot, ...segments)
      if (existsSync(original)) return original
    }
  }
  try {
    return realpathSync(resourcePath)
  } catch {
    return resourcePath
  }
}

/**
 * `this.importModule(request)`: resolve (alias + relative/absolute aware) then dynamically import the
 * module in the server/runtime context, letting Bun's onLoad hooks handle the transitive graph. Never
 * available in the client build context.
 *
 * Only the DIRECT request goes through `resolveSpecifier`; the imported module's own imports are
 * resolved by Bun. Those transitive specifiers still need the same resolveAlias and loader-rule
 * treatment, which is exactly what the runtime Bun.plugin hook provides, so ensure it is installed
 * before importing. Registration is idempotent per root, so a build that already did it pays nothing.
 */
async function importModuleFor(
  root: string,
  resourcePath: string,
  request: string,
  config: ResolvedConfig | undefined,
): Promise<unknown> {
  if (config) registerWebpackLoaderRuleRuntime(config)
  const resolved = resolveSpecifier(root, path.dirname(resourcePath), request)
  if (!resolved) {
    throw new Error(`this.importModule: cannot resolve '${request}' from '${resourcePath}'`)
  }
  return import(pathToFileURL(resolved).href)
}

// ---------------------------------------------------------------------------
// Loader invocation
// ---------------------------------------------------------------------------

/** Invokes a single loader function, bridging its sync/promise/callback return conventions. */
function runLoader(
  fn: LoaderFn,
  root: string,
  resourcePath: string,
  resourceQuery: string,
  input: string | Buffer,
  target: LoaderContextTarget,
  config: ResolvedConfig | undefined,
): Promise<string | Buffer> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (err: unknown, result?: unknown) => {
      if (settled) return
      settled = true
      if (err) reject(err instanceof Error ? err : new Error(JSON.stringify(err)))
      else resolve(result as string | Buffer)
    }
    const ctx: LoaderContext = {
      resourcePath,
      resourceQuery,
      mode: 'production',
      fs: { readFile, readFileSync },
      // eslint-disable-next-line @typescript-eslint/no-empty-function -- loader deps aren't tracked
      addDependency: () => {},
      getOptions: () => ({}),
      async: () => finish,
      callback: finish,
      getResolve: () => (context: string, request: string) =>
        resolveLoaderRequest(root, context, request),
      // eslint-disable-next-line @typescript-eslint/no-empty-function -- emitted files aren't tracked
      emitFile: () => {},
      importModule:
        target === 'server'
          ? (request: string) => importModuleFor(root, resourcePath, request, config)
          : () =>
              Promise.reject(
                new Error('this.importModule() is not supported in the client build context'),
              ),
    }
    try {
      const result = fn.call(ctx, input)
      if (result === undefined) return // loader signaled async via this.async()/this.callback()
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        ;(result as Promise<unknown>).then(value => finish(null, value), finish)
      } else {
        finish(null, result)
      }
    } catch (error) {
      finish(error)
    }
  })
}

function resolveLoaderExport(mod: unknown): LoaderFn {
  if (typeof mod === 'function') return mod as LoaderFn
  const withDefault = mod as { default?: unknown } | null | undefined
  if (withDefault && typeof withDefault.default === 'function')
    return withDefault.default as LoaderFn
  return mod as LoaderFn
}

// A loader commonly returns CJS-style source on the assumption webpack's CJS/ESM interop will bind a
// default import to it. esbuild's build() pass does that automatically, but Bun's plugin onLoad - used
// for the runtime's per-file SSR loading - does not synthesize a default export from a bare
// `module.exports` assignment, so normalize to a real ESM default export.
function normalizeToEsmDefault(contents: string): string {
  const match = /^\s*module\.exports\s*=\s*([\s\S]*?);?\s*$/.exec(contents)
  return match ? `export default (${match[1]});` : contents
}

export async function runLoaderChain(
  root: string,
  rule: WebpackLoaderRule,
  resourcePath: string,
  resourceQuery: string,
  target: LoaderContextTarget,
  config: ResolvedConfig | undefined,
): Promise<string> {
  const requireFromRoot = createRequire(path.join(root, 'noop-require.cjs'))
  // esbuild loads the materialized copy, but the loader context (`this.resourcePath`
  // and the base dir for relative `importModule`/`getResolve`) must point at the
  // original source so sibling modules resolve. Reading the materialized copy
  // yields identical bytes.
  const contextPath = originalResourcePath(resourcePath, config)
  let content: string | Buffer = await readFileP(resourcePath)
  for (const specifier of rule.loaders) {
    const resolvedSpecifier = path.isAbsolute(specifier)
      ? specifier
      : requireFromRoot.resolve(specifier)
    const mod: unknown = requireFromRoot(resolvedSpecifier)
    const fn = resolveLoaderExport(mod)
    const input = fn.raw ? toBuffer(content) : toStringContent(content)
    content = await runLoader(fn, root, contextPath, resourceQuery, input, target, config)
  }
  return normalizeToEsmDefault(toStringContent(content))
}

// ---------------------------------------------------------------------------
// `type` asset rules (no loaders)
// ---------------------------------------------------------------------------

/** asset/resource: emit the file under a hashed `/_next/static/media` URL, export the URL string. */
async function emitAssetResourceModule(
  config: ResolvedConfig,
  resourcePath: string,
  bytes: Uint8Array,
): Promise<string> {
  const ext = path.extname(resourcePath).toLowerCase() || '.bin'
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 8)
  const base = path
    .basename(resourcePath, path.extname(resourcePath))
    .replace(/[^A-Za-z0-9_-]+/g, '-')
  const relative = path.posix.join('_next', 'static', 'media', `${base}.${hash}${ext}`)
  const target = path.join(config.outPath, 'public', ...relative.split('/'))
  await mkdir(path.dirname(target), { recursive: true })
  if (!existsSync(target)) await writeFile(target, bytes)
  const src = `/${relative}`
  return `const src = ${JSON.stringify(src)};\nexport default src;\nexport { src };\n`
}

async function loadTypeAssetModule(
  rule: WebpackLoaderRule,
  resourcePath: string,
  config: ResolvedConfig | undefined,
): Promise<string> {
  const bytes = new Uint8Array(await readFileP(resourcePath))
  if (rule.assetType === 'bytes') {
    return `export default new Uint8Array(${JSON.stringify(Array.from(bytes))});`
  }
  if (rule.assetType === 'source') {
    return `export default ${JSON.stringify(Buffer.from(bytes).toString('utf8'))};`
  }
  // asset/resource — needs a config to know the output tree; without one, fall
  // back to exporting the basename so a build still resolves the import.
  if (config) return emitAssetResourceModule(config, resourcePath, bytes)
  return `export default ${JSON.stringify(`/${path.basename(resourcePath)}`)};`
}

// ---------------------------------------------------------------------------
// Rule-module loading (shared by esbuild plugins and the Bun runtime hook)
// ---------------------------------------------------------------------------

interface LoadedRuleModule {
  contents: string
  loader: 'ts' | 'tsx' | 'jsx' | 'js'
}

async function loadRuleModule(
  root: string,
  rules: WebpackLoaderRule[],
  resourcePath: string,
  resourceQuery: string,
  target: LoaderContextTarget,
  config: ResolvedConfig | undefined,
): Promise<LoadedRuleModule | undefined> {
  const rule = findRuleForResource(rules, resourcePath, resourceQuery)
  if (!rule) return undefined
  if (rule.assetType) {
    return { contents: await loadTypeAssetModule(rule, resourcePath, config), loader: 'js' }
  }
  const contents = await runLoaderChain(root, rule, resourcePath, resourceQuery, target, config)
  return { contents, loader: outputLoader(rule, resourcePath) }
}

function ruleSuffixFilter(rules: WebpackLoaderRule[]): RegExp | undefined {
  const suffixes = [
    ...new Set(
      rules.filter(rule => rule.glob.startsWith('*')).map(rule => stripLeadingWildcard(rule.glob)),
    ),
  ]
  if (suffixes.length === 0) return undefined
  return new RegExp(`(?:${suffixes.map(escapeRegExp).join('|')})$`)
}

/** Build the alias-key onResolve filter (exact keys + trailing-`/*` prefixes). */
function aliasSpecifierFilter(): RegExp | undefined {
  const keys = Object.keys(turbopackResolveAlias())
  if (keys.length === 0) return undefined
  const alternatives = keys.map(key =>
    key.endsWith('/*') ? escapeRegExp(key.slice(0, -1)) : `${escapeRegExp(key)}$`,
  )
  return new RegExp(`^(?:${alternatives.join('|')})`)
}

// A null byte separates a virtual query module's real path from its threaded
// resourceQuery (real paths never contain a null byte); used for the Bun
// runtime namespace so two `?query` imports of one file stay distinct modules.
const QUERY_SEPARATOR = '\0'
const QUERY_NAMESPACE = 'pnext-webpack-loader-query'

/**
 * esbuild plugin applying configured `turbopack.rules` loader chains (plus
 * `resolveAlias` and `?query` threading). Returns `undefined` when the project
 * configures no rules and no aliases, so callers can skip registering it.
 */
export function webpackLoaderRulesPlugin(
  config: ResolvedConfig,
  target: LoaderContextTarget,
): Plugin | undefined {
  const rules = turbopackLoaderRules()
  const filter = ruleSuffixFilter(rules)
  const aliasFilter = aliasSpecifierFilter()
  if (!filter && !aliasFilter) return undefined
  return {
    name: 'pnext-compat-webpack-loader-rules',
    setup(build) {
      // `?query`-suffixed specifiers whose base matches a loader rule: strip the
      // query, resolve the base (alias-aware), thread the query via esbuild's
      // `suffix` so the two `?query` imports of one file stay distinct modules.
      if (filter) {
        build.onResolve({ filter: /\?/ }, args => {
          const queryIndex = args.path.indexOf('?')
          if (queryIndex === -1) return undefined
          const base = args.path.slice(0, queryIndex)
          const query = args.path.slice(queryIndex)
          const resolved = resolveSpecifier(config.root, args.resolveDir, base)
          if (!resolved || !findRule(rules, resolved)) return undefined
          return { path: resolved, suffix: query }
        })
      }
      // `resolveAlias` specifier rewrites (without a query — query handled above).
      if (aliasFilter) {
        build.onResolve({ filter: aliasFilter }, async args => {
          if (args.path.includes('?')) return undefined
          // A user alias describes the APP's module graph. pnext's own runtime imports preact/compat to
          // build the react shim, so a config alias redirecting preact/compat to react points the shim
          // at the module pnext maps back to the shim - a self-import that throws on client bundle
          // init, killing all client JS. Framework modules resolve unaliased.
          if (isPNextRuntimeImporter(args.importer)) return undefined
          const resolved = resolveAliasSpecifier(args.path, config.root)
          if (!resolved) return undefined
          const target = firstExisting(resolved) ?? resolved
          // A bare alias target (e.g. `'preact/compat': 'react'`) is not a
          // file path — hand it back to esbuild's own resolver.
          if (!path.isAbsolute(target)) {
            if (target === args.path) return undefined
            return build.resolve(target, {
              resolveDir: args.resolveDir,
              kind: args.kind,
              importer: args.importer,
            })
          }
          return { path: target }
        })
      }
      if (filter) {
        build.onLoad({ filter, namespace: 'file' }, async args => {
          const resourcePath = path.resolve(args.path)
          const resourceQuery = args.suffix ?? ''
          try {
            const loaded = await loadRuleModule(
              config.root,
              rules,
              resourcePath,
              resourceQuery,
              target,
              config,
            )
            return loaded ?? undefined
          } catch (error) {
            return { errors: [{ text: error instanceof Error ? error.message : String(error) }] }
          }
        })
      }
    },
  }
}

const runtimeRegisteredRoots = new Set<string>()

/**
 * Registers a Bun.plugin hook applying `turbopack.rules` loader chains (plus resolveAlias and query
 * threading) for the SERVER runtime's own per-file module loading - the on-demand transform, not an
 * esbuild build() pass. Idempotent per project root; a no-op when nothing is configured.
 */
export function registerWebpackLoaderRuleRuntime(config: ResolvedConfig): void {
  const rules = turbopackLoaderRules()
  const suffixFilter = ruleSuffixFilter(rules)
  const aliasFilter = aliasSpecifierFilter()
  if (!suffixFilter && !aliasFilter) return
  const root = path.resolve(config.root)
  if (runtimeRegisteredRoots.has(root)) return
  runtimeRegisteredRoots.add(root)
  const ruleFileFilter = suffixFilter
    ? new RegExp(`^${escapeRegExp(root)}(?:/.*)?${suffixFilter.source}`)
    : undefined
  Bun.plugin({
    name: `pnext-compat-webpack-loader-runtime-${root}`,
    setup(plugin) {
      // `?query`-suffixed specifiers whose base matches a loader rule: resolve
      // the base (alias-aware), thread the query through the returned path so
      // Bun keeps each `?query` import a distinct module (keyed by namespace +
      // path). The onLoad below reads the query back off the path.
      if (suffixFilter) {
        plugin.onResolve({ filter: /\?/ }, args => {
          const queryIndex = args.path.indexOf('?')
          if (queryIndex === -1) return undefined
          const base = args.path.slice(0, queryIndex)
          const query = args.path.slice(queryIndex)
          const fromDir = args.importer ? path.dirname(args.importer) : root
          const resolved = resolveSpecifier(root, fromDir, base)
          if (!resolved || !findRule(rules, resolved)) return undefined
          return { path: `${resolved}${QUERY_SEPARATOR}${query}`, namespace: QUERY_NAMESPACE }
        })
      }
      // `resolveAlias` specifier rewrites (without a query — query handled above).
      if (aliasFilter) {
        plugin.onResolve({ filter: aliasFilter }, args => {
          if (args.path.includes('?')) return undefined
          // See the build-time alias hook: pnext's own runtime graph is exempt
          // from user aliases, or the react shim self-imports.
          if (isPNextRuntimeImporter(args.importer)) return undefined
          const resolved = resolveAliasSpecifier(args.path, root)
          if (!resolved) return undefined
          const target = firstExisting(resolved) ?? resolved
          // Bare alias target: resolve through Bun's resolver relative to the
          // importer so a specifier like 'react' becomes a real file path.
          if (!path.isAbsolute(target)) {
            if (target === args.path) return undefined
            const fromDir = args.importer ? path.dirname(args.importer) : root
            try {
              return { path: Bun.resolveSync(target, fromDir) }
            } catch {
              return undefined
            }
          }
          return { path: target }
        })
      }
      plugin.onLoad({ filter: /.*/, namespace: QUERY_NAMESPACE }, async ({ path: virtualPath }) => {
        const sep = virtualPath.indexOf(QUERY_SEPARATOR)
        const realPath = sep === -1 ? virtualPath : virtualPath.slice(0, sep)
        const resourceQuery = sep === -1 ? '' : virtualPath.slice(sep + 1)
        const loaded = await loadRuleModule(root, rules, realPath, resourceQuery, 'server', config)
        return loaded ?? { contents: await readFileP(realPath, 'utf8'), loader: 'text' }
      })
      // `.mjs` sources are NOT claimed by core's runtime load hook (its filter is `[jt]sx?`), so they
      // never see the registered server source transforms - including the resolveAlias rewrite. Bun then
      // resolves their bare imports natively and an aliased specifier throws, since its onResolve hook is
      // never consulted for bare specifiers. Claim them here; Bun rejects an undefined onLoad return, so
      // the hook always hands the source back. Kept synchronous, and `.cjs` deliberately left out: an
      // onLoad hook turns the module async, which breaks require() of the materialized next.config.
      if (aliasFilter) {
        const esmFilter = new RegExp(`^${escapeRegExp(root)}(?!.*/node_modules/)(?:/.*)?\\.mjs$`)
        plugin.onLoad({ filter: esmFilter }, ({ path: file }) => ({
          contents: rewriteResolveAliasImports(readFileSync(file, 'utf8'), file, root),
          loader: 'js',
        }))
      }
      if (ruleFileFilter) {
        plugin.onLoad({ filter: ruleFileFilter }, async ({ path: file }) => {
          const loaded = await loadRuleModule(root, rules, path.resolve(file), '', 'server', config)
          return loaded ?? { contents: await readFileP(file, 'utf8'), loader: 'text' }
        })
      }
    },
  })
}
