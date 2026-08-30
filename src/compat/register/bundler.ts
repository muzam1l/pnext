// Bundler-feature registration (COMPAT - may import core freely).
//
// Wires the bundler features into core's bundler seams. All are gated on compat.next, so a pure-core app
// registers nothing.
//
// Features wired here:
//   react-server / next-js conditions -> setServerBundleConditions (core always adds `react-server`;
//                                        `next-js` gates on cacheComponents)
//   compiler.define / defineServer    -> registerServerSourceTransforms (the server graph inlines both;
//                                        the client graph, owned elsewhere, inlines only `define`)
//   serverExternalPackages/transpile  -> setExternalPackagePolicy
//   resolveExtensions                 -> setResolveExtensions
//
// Ownership boundary: the CLIENT-side `compiler.define` merge lives in client/build.ts, not here - this
// file only handles the SERVER graph.

import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { OnLoadResult, Plugin } from 'esbuild'
import type { ResolvedConfig } from '../../config'
import type { ServerEsbuildPluginOptions } from '../../extensions'
import { compatAliases, nextCompatEnabled, rewriteNextFontSource } from '../../compat/aliases'
import {
  getBundlerExtensions,
  getCompatModeExtensions,
  registerClientSourceAsyncPreTransforms,
  registerClientSourceTransforms,
  registerServerSourcePreTransforms,
  registerServerSourceTransforms,
  setAssetExtensions,
  setBundlerExtensions,
  setCompatModeExtensions,
  withSniff,
} from '../../extensions'
import {
  isEsmModuleFile,
  isWorkspacePackage,
  packageNameForFile,
  packageNameOfSpecifier,
  resolvePackageImportSpecifier,
  resolvePackageSpecifier,
  setExternalLoadResolver,
  setExternalPackagePolicy,
  setResolveExtensions,
  setTsConfigPath,
} from '../../resolve/imports'
import { setServerBundleConditions } from '../../runtime/loader'
import { escapeRegex, specifierSniffTokens } from '../../utils/code'
import {
  cacheComponentsEnabled,
  compilerDefines,
  esmExternals,
  modularizeImports,
  optimizePackageImports,
  publicRuntimeConfig,
  reactCompilerEnabled,
  relayCompilerConfig,
  removeConsoleTargets,
  resolveExtensions,
  serverExternalPackages,
  swcEnvUsageMode,
  tsconfigPath,
  transpilePackages,
  turbopackResolveAlias,
} from '../bundler/config'
import { createModularizeImportsTransform } from '../bundler/modularize-imports'
import {
  createOptimizePackageImportsTransform,
  optimizePackageImportsSniffTokens,
  optimizedPackageSet,
} from '../bundler/optimize-package-imports'
import { createRelayTransform } from '../bundler/relay-transform'
import {
  polyfillsChunkFileName,
  POLYFILLS_NOMODULE_SOURCE,
  POLYFILL_USAGE_TOKENS,
  rewriteUsagePolyfillImports,
} from '../bundler/polyfill'
import { rewriteBunBuiltinExternals } from '../bundler/bun-externals'
import { clientExternalPackageResolvePlugin } from '../bundler/externals'
import {
  clientDynamicCommonJsImportsPlugin,
  clientReferenceLoad,
  commonJsDefaultInteropPlugin,
  commonJsInteropEntry,
  recoverCommonJsNamedExportsPlugin,
  rewriteClientDynamicImportPromises,
  rewriteStaticCommonJsNamespaceImports,
} from '../bundler/cjs-exports'
import { rewriteImportMetaUrlSource } from '../bundler/import-meta-url'
import { rewriteNewUrlAssetClientSource, rewriteNewUrlAssetSource } from '../bundler/new-url-asset'
import { rewriteReactProfilerImport } from '../bundler/react-compiler'
import { rewriteRequireContextSource } from '../bundler/require-context'
import { clientResolveExtensionsPlugin } from '../bundler/resolve-extensions'
import { tsconfigPathsPlugin } from '../bundler/tsconfig-paths'
import { fileMemoAsync } from '../bundler/source-cache'
import { serverSymlinkImportPlugin, symlinkedImportsPossible } from '../bundler/symlink-imports'
import { registerWasmModuleRuntime, wasmModulePlugin } from '../bundler/wasm'
import {
  hasWebpackLoaderRuleFor,
  registerWebpackLoaderRuleRuntime,
  rewriteResolveAliasImports,
  webpackLoaderRuleModule,
  webpackLoaderRulesPlugin,
} from '../bundler/webpack-loaders'
import { rewriteStaticCompatImports } from '../bundler/static-imports'
import { createClientWorkerTransform } from '../bundler/worker'
import { rewriteStyledJsxSource } from '../css/styled-jsx'
import { getImagesConfig } from '../next/image/config'
import { appUsesBlurPlaceholder, appUsesLegacyLink } from '../next/usage'
import { rewriteLegacyLinkValidation } from '../next/link-transform'
import { pagesClientModulePlugin } from '../pages/client-plugin'

export function registerBundlerExtensions(config: ResolvedConfig): void {
  // The alias registries (setImportAliasExtensions + setModuleAliases) are boot
  // facts — the route scanner and the server runtime latch them before the
  // first compile, so register-boot.ts owns them.
  if (!nextCompatEnabled(config)) return

  // B3: user-configured resolver extension order (empty -> core default). The
  // server resolver consumes it via setResolveExtensions; the client esbuild
  // graph gets a probe plugin applying the same order (registered further down
  // with the other client plugins, only when configured).
  const configuredExtensions = resolveExtensions()
  setResolveExtensions(configuredExtensions)
  // A custom `typescript.tsconfigPath` keeps compiler `paths` in a
  // non-default file esbuild never discovers; the client build then needs an
  // explicit resolver plugin (server graph consults setTsConfigPath directly).
  const customTsconfigPath = tsconfigPath()
  setTsConfigPath(customTsconfigPath ? path.resolve(config.root, customTsconfigPath) : undefined)

  // `turbopack.rules` loader chains: the esbuild-plugin form (webpackLoaderPlugins
  // below) only covers the vendor/client build() passes. The server runtime's
  // per-file SSR loading goes through Bun's own require hooks instead, so a
  // configured rule extension without other pnext handling (e.g. `*.txt`) needs
  // its own registration to preempt Bun's native fallback loader.
  registerWebpackLoaderRuleRuntime(config)
  // Same story for a bare `.wasm` import the server runtime loads directly (a
  // `this.importModule()` target's graph): Bun's native loader has no named
  // exports, so the runtime needs its own instantiating hook.
  registerWasmModuleRuntime(config)
  // A configured loader rule for an image/asset extension must preempt core's generic image/asset
  // resolver so the loader chain runs; core consults `hasLoaderRuleFor` before claiming the extension for
  // its own pipeline, then pulls the chain's output through `loaderRuleModule` - the server graph compiles
  // module-by-module, so there is no onLoad to run it in.
  setAssetExtensions({
    hasLoaderRuleFor: hasWebpackLoaderRuleFor,
    loaderRuleModule: (specifier, importer) => webpackLoaderRuleModule(config, specifier, importer),
  })

  // B7: external/transpile package policy consulted by the server compile sites.
  const externals = serverExternalPackages()
  const transpile = new Set(transpilePackages())
  setExternalPackagePolicy({
    external: name => externals.has(name),
    transpile: name =>
      !externals.has(name) && (transpile.has(name) || isLinkedWorkspacePackage(config, name)),
    // Linked workspace packages are deliberately absent: esbuild resolves their
    // symlinks to real paths, so they never reach a filter as node_modules.
    transpiled: () => [...transpile].filter(name => !externals.has(name)),
    esmExternals,
  })
  setExternalLoadResolver(({ root, fromFile, specifier, target }) => {
    const packageName = specifier.startsWith('#')
      ? packageNameForFile(fromFile)
      : packageNameOfSpecifier(specifier)
    if (!packageName || !externals.has(packageName)) return undefined

    const conditions =
      target === 'client'
        ? ['import', 'browser', 'require', 'default']
        : target === 'edge'
          ? ['react-server', 'edge-light', 'browser', 'module', 'import', 'default']
          : ['node', 'import', 'default']
    if (specifier.startsWith('#')) {
      return resolvePackageImportSpecifier(root, fromFile, specifier, conditions)
    }

    const imported = resolvePackageSpecifier(root, fromFile, specifier, conditions)
    if (target === 'client' || !imported || esmExternals() !== true || isEsmModuleFile(imported)) {
      return imported
    }
    const requireConditions =
      target === 'edge'
        ? ['react-server', 'edge-light', 'browser', 'module', 'require', 'import', 'default']
        : ['node', 'require', 'default']
    return resolvePackageSpecifier(root, fromFile, specifier, requireConditions) ?? imported
  })
  // B4/B5(next-js): rendering follows it only with Cache Components; core
  // adds react-server for server vendor bundles.
  setServerBundleConditions(() => (cacheComponentsEnabled() ? ['next-js'] : []))

  // modularizeImports: split barrel `import { A, B } from '<spec>'` into
  // per-member imports BEFORE path-alias resolution, so the emitted specifiers
  // still flow through tsconfig `paths`. Registered as a server pre-transform
  // (runs ahead of the static-compat alias rewrites below) and a client
  // transform; a no-op when unconfigured.
  const modularize = modularizeImports()
  if (Object.keys(modularize).length > 0) {
    const modularizeTransform = createModularizeImportsTransform(modularize)
    registerServerSourcePreTransforms(modularizeTransform)
    registerClientSourceTransforms(modularizeTransform)
  }

  // optimizePackageImports: rewrite a barrel package's named imports to the leaf modules its entry
  // re-exports them from, so the vendor pipeline compiles - and the server evaluates - only what the
  // route named. Same chain position as modularizeImports, so the emitted leaf specifiers still flow
  // through alias/path resolution.
  const optimizedPackages = optimizedPackageSet(optimizePackageImports())
  const optimizeSniff = optimizePackageImportsSniffTokens(optimizedPackages)
  const optimizeTransform = createOptimizePackageImportsTransform(optimizedPackages, config.root)
  registerServerSourcePreTransforms(optimizeTransform)
  registerClientSourceTransforms(optimizeTransform)

  // compiler.relay: replace `graphql`...`` tagged templates with the artifact
  // relay-compiler generated for the operation. Registered as a pre-transform
  // for the same reason modularizeImports is — the injected artifact imports
  // must still flow through alias/path resolution.
  const relay = relayCompilerConfig()
  if (relay) {
    const relayTransform = createRelayTransform(relay)
    registerServerSourcePreTransforms(relayTransform)
    registerClientSourceTransforms(relayTransform)
  }

  // Next font/root-params rewrites must precede generic server transforms.
  const fontSniff = ['next/font', 'next/root-params']
  registerServerSourcePreTransforms(
    withSniff(fontSniff, (source, file, root) =>
      rewriteNextFontSource(source, file, 'server', root),
    ),
  )
  registerClientSourceTransforms(
    withSniff(fontSniff, (source, file, root) =>
      rewriteNextFontSource(source, file, 'client', root),
    ),
  )
  const linkSniff = ['Link', 'legacyBehavior']
  registerServerSourcePreTransforms(withSniff(linkSniff, rewriteLegacyLinkValidation))
  registerClientSourceTransforms(withSniff(linkSniff, rewriteLegacyLinkValidation))
  registerServerSourcePreTransforms(withSniff(['<style'], rewriteStyledJsxSource))
  registerClientSourceTransforms(withSniff(['<style'], rewriteStyledJsxSource))
  registerServerSourceTransforms(withSniff(["'bun", '"bun'], rewriteBunBuiltinExternals))
  // Materialized fixtures can re-import original sources outside esbuild's
  // alias graph. Keep their static compat imports on the registered facades.
  // Leave React entrypoints for the resolver: RSC/proxy/middleware needs the
  // stricter react-server-layer overrides instead of the ordinary shims.
  const staticServerAliases = compatAliases(config, 'server')
  delete staticServerAliases.react
  delete staticServerAliases['react-dom']
  // The CJS facades live in compat/next, one level up from this register dir.
  const nextRoot = path.resolve(import.meta.dirname, '..', 'next')
  const requireAliases = {
    'next/navigation': path.join(nextRoot, 'navigation.cjs'),
    'next/router': path.join(nextRoot, 'router.cjs'),
  }
  registerServerSourceTransforms(
    withSniff(
      specifierSniffTokens([...Object.keys(staticServerAliases), ...Object.keys(requireAliases)]),
      (source, file) =>
        rewriteStaticCompatImports(source, file, staticServerAliases, requireAliases),
    ),
  )
  const namespaceImportSniff = [/import\s+\*/]
  registerServerSourceTransforms(
    withSniff(namespaceImportSniff, rewriteStaticCommonJsNamespaceImports),
  )
  // `turbopack.resolveAlias` bare specifiers: the esbuild/Bun onResolve hooks
  // cover the graphs they own, but Bun's runtime resolver rejects an unknown
  // bare package before plugins run, so modules the server runtime loads
  // directly (a `this.importModule()` target's transitive imports) need the
  // alias applied in source.
  registerServerSourceTransforms(
    withSniff(specifierSniffTokens(Object.keys(turbopackResolveAlias())), (source, file) =>
      rewriteResolveAliasImports(source, file, config.root),
    ),
  )
  registerClientSourceTransforms(
    withSniff(namespaceImportSniff, rewriteStaticCommonJsNamespaceImports),
  )

  // B5: compiler.define + compiler.defineServer, both graphs, through the
  // bundler's own `define`. The server graph inlines both; the client graph
  // inlines `define` and folds `defineServer` keys to `undefined` so client
  // fallback branches stay reachable. `define` wins a key present in both.
  const { define, defineServer } = compilerDefines()
  const serverDefines = { ...define, ...defineServer }
  const clientDefines = {
    ...Object.fromEntries(Object.keys(defineServer).map(key => [key, 'undefined'])),
    ...define,
  }

  // B5: compiler.removeConsole — strip console.* calls from the client graph
  // via esbuild's `pure` option (unused-result calls are dropped in the
  // minified production build).
  const removeConsole = removeConsoleTargets()

  // experimental.swcEnvOptions: core-js polyfills for the targeted features, on
  // the client graph only — the server graph runs on the current Node/Bun and
  // needs no polyfill.
  if (swcEnvUsageMode()) {
    registerClientSourceTransforms(
      withSniff(POLYFILL_USAGE_TOKENS, (source, file) =>
        rewriteUsagePolyfillImports(source, file, config),
      ),
    )
  }

  // B: `new URL('./asset.png', import.meta.url)` -> emitted /_next/static/media
  // URL (matching `import img from './asset.png'`.src). Both graphs via a source
  // transform; the client one skips the middleware form and the Profiler pass
  // (registered on its own below).
  registerServerSourceTransforms(
    // `Profiler` too: the new-URL pass front-runs the react-profiler rewrite.
    withSniff(['import.meta.url', 'Profiler'], (source, file) =>
      rewriteNewUrlAssetSource(source, file),
    ),
  )
  registerServerSourceTransforms(withSniff(['import.meta.url'], rewriteImportMetaUrlSource))
  // Client order is load-bearing: the worker pass (async, registered below) and
  // the new-URL asset pass both read `import.meta.url`, which this one inlines.
  registerClientSourceTransforms(
    withSniff(['import.meta.url'], rewriteNewUrlAssetClientSource),
    withSniff(['Profiler'], rewriteReactProfilerImport),
    withSniff([/\.then\s*\(/], source => rewriteClientDynamicImportPromises(source)),
    withSniff(['import.meta.url'], rewriteImportMetaUrlSource),
  )
  // webpack's `require.context(dir, recursive, regExp)`: expanded on disk into static imports plus a
  // synthesized context object. Registered as a source transform, not an esbuild onLoad plugin, so it
  // reaches every consumer of the compiled source without preempting the extension-specific loaders -
  // the server graph through `rewriteServerSource` and the client graph through
  // `applyClientSourceTransforms`.
  const requireContextPaths = { outPath: config.outPath, workspaceRoot: config.workspaceRoot }
  registerServerSourceTransforms(
    withSniff(['.context('], (source, file) =>
      rewriteRequireContextSource(source, file, requireContextPaths),
    ),
  )
  registerClientSourceTransforms(
    withSniff(['.context('], (source, file) =>
      rewriteRequireContextSource(source, file, requireContextPaths),
    ),
  )
  // Web Worker bundling: an async pre-transform, so it sees `import.meta.url`
  // before the sync chain above inlines it. The rest of the chain then runs on
  // its output — no companion re-application needed.
  const workerTransform = createClientWorkerTransform(config, configuredExtensions)
  registerClientSourceAsyncPreTransforms(
    withSniff(['new Worker(', 'new SharedWorker('], (source, file) =>
      workerTransform(source, file),
    ),
  )

  // next.config's `reactCompiler` is the same switch as pnext's own
  // `compat.reactCompiler`: fold it into the compat-mode options so the single
  // compiler pass (core's client-source loader) sees one answer.
  const priorReactCompilerOptions = getCompatModeExtensions().reactCompilerOptions
  setCompatModeExtensions({
    reactCompilerOptions: cfg =>
      priorReactCompilerOptions(cfg) ?? (reactCompilerEnabled() ? { target: '18' } : undefined),
  })

  // Created once, not per build: the memo spans the hundreds of server builds
  // a vendor pass runs over the same workspace sources.
  const firstPartyRewrite = createFirstPartySourceRewrite(config, {
    transform: optimizeTransform,
    sniff: optimizeSniff,
  })
  const priorClient = getBundlerExtensions().clientEsbuildPlugins
  const priorServer = getBundlerExtensions().serverEsbuildPlugins
  const priorPure = getBundlerExtensions().clientPureFunctions
  setBundlerExtensions({
    clientPureFunctions: cfg => [...priorPure(cfg), ...(removeConsole ?? [])],
    serverDefines: () => serverDefines,
    // The blur gate reads app source, so it is computed on the first client
    // build that asks — never at registration, which runs inside the boot
    // budget. `appUsesBlurPlaceholder` memoizes per root.
    clientDefines: () => ({
      ...clientDefines,
      __PNEXT_IMAGE_BLUR__: String(appUsesBlurPlaceholder(config.root)),
      // Same one-sided source scan for `<Link legacyBehavior>` (usage.ts).
      __PNEXT_LINK_LEGACY__: String(appUsesLegacyLink(config.root)),
      // next.config `images` only ever reached the server global, so the client
      // fell back to the defaults — config-dependent props (path, qualities,
      // sizes) mismatched on hydration. Inlining the resolved config also drops
      // the defaults + resolver from every client bundle.
      __PNEXT_IMAGE_CONFIG_INLINE__: JSON.stringify(getImagesConfig()),
      __PNEXT_IMAGE_CONFIG_INLINED__: 'true',
      // publicRuntimeConfig inlined the same way; omitted entirely when unset so an app that
      // never configures it adds zero bytes (unlike images, there is no default to drop).
      ...(Object.keys(publicRuntimeConfig()).length > 0
        ? {
            __PNEXT_PUBLIC_RUNTIME_CONFIG_INLINE__: JSON.stringify(publicRuntimeConfig()),
            __PNEXT_PUBLIC_RUNTIME_CONFIG_INLINED__: 'true',
          }
        : {}),
    }),
    // Next ships a `polyfills-<hash>.js` chunk + a `<script noModule>` tag; the
    // body is inert for pnext's module-capable targets (see polyfill.ts).
    staticClientChunks: () => [
      { name: polyfillsChunkFileName(), contents: POLYFILLS_NOMODULE_SOURCE },
    ],
    clientEsbuildPlugins: (cfg: ResolvedConfig): Plugin[] => [
      ...webpackLoaderPlugins(cfg, 'client'),
      pagesClientModulePlugin(cfg),
      wasmModulePlugin(cfg),
      // tsconfig `paths` resolution for the client graph, whenever any reachable tsconfig declares them:
      // esbuild's native discovery misses standard `tsconfig.json` paths for stdin-based builds and never
      // skips `.d.ts`-first array targets. Everything else stays on esbuild's native resolution.
      ...optional(tsconfigPathsPlugin(cfg)),
      ...(configuredExtensions ? [clientResolveExtensionsPlugin(configuredExtensions)] : []),
      ...optional(clientExternalPackageResolvePlugin(cfg, externals)),
      // First-party source outside every source root gets no
      // registerClientSourceTransforms pass — the OPI rewrite must live here too.
      firstPartyClientOptimizeImportsLoadPlugin(cfg, optimizeTransform, optimizeSniff),
      clientDynamicCommonJsImportsPlugin(cfg.root),
      ...priorClient(cfg),
    ],
    serverEsbuildPlugins: (cfg: ResolvedConfig, opts?: ServerEsbuildPluginOptions): Plugin[] => [
      ...webpackLoaderPlugins(cfg, 'server'),
      wasmModulePlugin(cfg),
      ...optional(tsconfigPathsPlugin(cfg)),
      ...(symlinkedImportsPossible(cfg, opts?.realPathEntries)
        ? [serverSymlinkImportPlugin(cfg)]
        : []),
      serverSourceLoadPlugin(firstPartyRewrite, opts?.vendorClientBoundary),
      commonJsDefaultInteropPlugin(),
      recoverCommonJsNamedExportsPlugin(),
      ...priorServer(cfg, opts),
    ],
    serverBundleEntry: commonJsInteropEntry,
  })
}

/** Spread helper for the plugins that skip registration when unconfigured. */
function optional(plugin: Plugin | undefined): Plugin[] {
  return plugin ? [plugin] : []
}

function webpackLoaderPlugins(cfg: ResolvedConfig, target: 'client' | 'server'): Plugin[] {
  const plugin = webpackLoaderRulesPlugin(cfg, target)
  return plugin ? [plugin] : []
}

// Source rewrites a bundle has to get BEFORE resolution, applied where esbuild reads the file:
//   - next/font: vendor bundles transform esbuild's OUTPUT, where `next/font/google` has already been
//     alias-rewritten to a file:// path, so the font rewrite no-ops there and the untouched named imports
//     hit the empty shim.
//   - optimizePackageImports: a `'use client'` component in a LINKED workspace package is compiled by the
//     vendor bundler, which never runs the source-transform chain, so its barrel imports bypassed the
//     rewrite and the whole catalogue was compiled and evaluated.
// Both are idempotent: re-running either on already-rewritten source is a no-op.
interface FirstPartySourceRewrite {
  rewrite: (file: string) => Promise<OnLoadResult | undefined>
  /** node_modules dirs transpilePackages opts back into the rewrite. */
  transpiledFilter?: RegExp
}

function createFirstPartySourceRewrite(
  config: ResolvedConfig,
  optimize: { transform: (source: string, file: string) => string; sniff: readonly string[] },
): FirstPartySourceRewrite {
  const transpiled = transpilePackages()
  const rewrite = fileMemoAsync(async (file: string): Promise<OnLoadResult | undefined> => {
    let source: string
    try {
      source = await readFile(file, 'utf8')
    } catch {
      return undefined
    }
    let contents = source
    if (contents.includes('next/font/')) {
      contents = rewriteNextFontSource(contents, file, 'server', config.root)
    }
    // TS only: what reaches this hook is first-party or transpiled source, and
    // both ship .ts/.tsx. The sniff keeps the parse off everything else.
    if (/\.tsx?$/.test(file) && optimize.sniff.some(token => contents.includes(token))) {
      contents = optimize.transform(contents, file)
    }
    if (contents === source) return undefined
    // Keep the file's own syntax: `.ts` must not parse as `.tsx` (`<T>`
    // casts), and .js/.mjs/.cjs app source may legitimately contain JSX.
    return { contents, loader: file.endsWith('.ts') ? 'ts' : 'tsx' }
  })
  return {
    rewrite,
    transpiledFilter:
      transpiled.length > 0
        ? new RegExp(
            `[\\\\/]node_modules[\\\\/](?:${transpiled.map(escapeRegex).join('|')})[\\\\/]`,
          )
        : undefined,
  }
}

/**
 * The server chain's ONE claiming onLoad over JS/TS sources. esbuild hands a file to the FIRST onLoad
 * that claims it, so the three passes that used to be separate plugins - CJS client references, the
 * first-party font/OPI rewrite, and the vendor client-boundary stub - each cost a full callback round
 * trip per input file per build. Composed here in their original registration order, they share one
 * callback.
 */
function serverSourceLoadPlugin(
  firstParty: FirstPartySourceRewrite,
  vendorClientBoundary?: (file: string) => Promise<OnLoadResult | undefined>,
): Plugin {
  return {
    name: 'pnext-server-source-load',
    setup(build) {
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/, namespace: 'file' }, async args => {
        // `use client` in a CommonJS file -> tag its exports as references.
        if (/\.c?js$/.test(args.path)) {
          const references = await clientReferenceLoad(args.path)
          if (references) {
            // On the react-server layer the boundary stub wins over the in-place tag: a CommonJS
            // `'use client'` leaf (a package's own `require()`d client half) must never EVALUATE
            // server-side, exactly like the ESM ones this same scan already replaces.
            return (await vendorClientBoundary?.(args.path)) ?? references
          }
        }
        // First-party (or transpilePackages-opted) source: font/OPI rewrites.
        // Everything else under node_modules keeps esbuild's native load path.
        if (
          !args.path.includes(`${path.sep}node_modules${path.sep}`) ||
          firstParty.transpiledFilter?.test(args.path)
        ) {
          const rewritten = await firstParty.rewrite(args.path)
          if (rewritten) return rewritten
        }
        return vendorClientBoundary?.(args.path)
      })
    },
  }
}

// Client twin of firstPartySourceLoadPlugin, OPI rewrite only (the client pipeline handles next/font
// itself); same outside-node_modules claim boundary, minus what core's client-source loader already owns.
// esbuild gives a file to the FIRST onLoad that claims it, and this plugin is registered ahead of that
// loader - claiming a source root file here would silently drop the whole client chain on it (React
// Compiler, `dynamic()` rewrite, defines). Under a root the chain applies this same transform anyway;
// only source living outside every root needs the hook.
function firstPartyClientOptimizeImportsLoadPlugin(
  config: ResolvedConfig,
  transform: (source: string, file: string) => string,
  sniff: readonly string[],
): Plugin {
  const roots = clientSourceRootPrefixes(config)
  const rewriteFile = fileMemoAsync(async (file: string) => {
    let source: string
    try {
      source = await readFile(file, 'utf8')
    } catch {
      return undefined
    }
    if (!/\.tsx?$/.test(file) || !sniff.some(token => source.includes(token))) return undefined
    const contents = transform(source, file)
    if (contents === source) return undefined
    return { contents, loader: file.endsWith('.ts') ? ('ts' as const) : ('tsx' as const) }
  })
  return {
    name: 'pnext-first-party-client-optimize-imports-load',
    setup(build) {
      build.onLoad({ filter: /\.tsx?$/, namespace: 'file' }, args =>
        args.path.includes(`${path.sep}node_modules${path.sep}`) ||
        roots.some(root => args.path.startsWith(root))
          ? undefined
          : rewriteFile(args.path),
      )
    },
  }
}

// The roots core's client-source loader claims under (client/build.ts
// `clientSourceRoots`), each with a trailing separator so a sibling directory
// sharing the prefix is not swallowed.
function clientSourceRootPrefixes(config: ResolvedConfig): string[] {
  const roots = new Set<string>()
  for (const root of [config.root, config.workspaceRoot]) {
    const resolved = path.resolve(root)
    roots.add(resolved + path.sep)
    try {
      roots.add(realpathSync.native(resolved) + path.sep)
    } catch {
      // Unresolvable root: its literal form already covers the files under it.
    }
  }
  return [...roots]
}

// First-party workspace source is implicitly transpiled. Hoisting puts the
// package only in the workspace root's node_modules, so both roots are asked.
function isLinkedWorkspacePackage(config: ResolvedConfig, name: string) {
  return isWorkspacePackage(config.root, name) || isWorkspacePackage(config.workspaceRoot, name)
}
