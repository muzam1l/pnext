// MDX compile core (COMPAT).
//
// Thin wrapper over `@mdx-js/mdx`'s `compile`. Kept dependency-light and lazy: `@mdx-js/mdx` is an
// optionalDependency loaded on first `.mdx` compile, so a pure app that never touches MDX pays nothing
// and builds without it installed.
//
// The user's remark/rehype/recma plugin arrays come from the wrapped next.config, read via
// `getNextConfig()` so no wiring is required beyond registering the loader.
//
// Output is JSX targeting the preact automatic runtime; the esbuild loader that calls this returns
// `loader: 'jsx'` so esbuild performs the final JSX-to-calls transform with the same jsxImportSource
// every other compile site uses, keeping a single JSX runtime end to end.
//
// `providerImportSource` is set to our components provider only when the app ships an `mdx-components`
// file; without one, MDX emits bare host elements, which is exactly the mdx-no-mdx-components contract.

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { getNextConfig } from '../next/config-loader'

export interface MdxCompileResult {
  code: string
}

interface MdxModule {
  compile: (
    source: string | { value: string; path?: string },
    options?: Record<string, unknown>,
  ) => Promise<{ toString: () => string; value: string }>
}

interface MdxOptions {
  remarkPlugins?: unknown[]
  rehypePlugins?: unknown[]
  recmaPlugins?: unknown[]
  remarkRehypeOptions?: Record<string, unknown>
  providerImportSource?: string
}

let cachedModule: MdxModule | null | undefined

/**
 * Load `@mdx-js/mdx` lazily. Returns `null` (not throwing) when the optional
 * dependency is absent so the loader can surface a single actionable error only
 * when an app actually imports `.mdx`.
 */
async function loadMdx(): Promise<MdxModule | null> {
  if (cachedModule !== undefined) return cachedModule
  try {
    const specifier = '@mdx-js/mdx'
    cachedModule = (await import(/* @vite-ignore */ specifier)) as MdxModule
  } catch {
    cachedModule = null
  }
  return cachedModule
}

/** The user's mdxOptions from the wrapped next.config, normalized. */
export function mdxOptionsFromConfig(): MdxOptions {
  const config = getNextConfig() as {
    mdxOptions?: MdxOptions
    experimental?: { mdxRs?: unknown }
  }
  // @next/mdx stores the merged plugin options under `mdxOptions` on the config
  // object the wrapper produces. `experimental.mdxRs` selects the Rust pipeline
  // upstream; we always use the JS pipeline, so it is intentionally ignored.
  return config.mdxOptions ?? {}
}

/**
 * Resolve the app's `mdx-components.{tsx,ts,jsx,js,mjs}` provider file if present.
 * Next looks for it at the project root (or `src/`). Returns the absolute path
 * used as `providerImportSource`, or `undefined` when absent (bare host elements).
 */
export function resolveMdxComponents(root: string): string | undefined {
  const bases = [root, path.join(root, 'src')]
  const names = [
    'mdx-components.tsx',
    'mdx-components.ts',
    'mdx-components.jsx',
    'mdx-components.js',
    'mdx-components.mjs',
  ]
  for (const base of bases) {
    for (const name of names) {
      const candidate = path.join(base, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

function interopDefault(module: unknown): unknown {
  return (module as { default?: unknown })?.default ?? module
}

// Sentinel returned when a configured plugin package can't be resolved from the
// app, so `resolvePlugins` can filter it out.
const UNRESOLVED_PLUGIN = Symbol('pnext.mdx.unresolved-plugin')

/**
 * Resolve a single plugin entry to the shape `@mdx-js/mdx` expects. `@next/mdx` stores plugins as
 * serializable STRINGS (a bare package name) or `[name, opts]` tuples, because webpack loader options
 * must serialize. Mirroring its mdx-js-loader: resolve the name from the project root and
 * dynamic-import it, taking the default export. Entries that are already functions or tuples of
 * functions pass through untouched.
 *
 * A configured plugin that cannot be resolved OR fails to load returns UNRESOLVED_PLUGIN (a warn, not a
 * throw): neither a missing optional transform nor a broken transitive dependency may take down the
 * whole `.mdx` render. This also matches `mdxRs: true`, where Next never JS-resolves these packages at
 * all. Load failures are common when the toolchain resolves into a flat auto-install cache rather than
 * a real node_modules tree, so the real error is surfaced to the log instead of silently 500ing pages.
 */
async function resolvePlugin(entry: unknown, resolveFrom: NodeRequire): Promise<unknown> {
  if (typeof entry === 'function') return entry
  if (typeof entry === 'string') {
    return loadPlugin(entry, resolveFrom)
  }
  if (Array.isArray(entry) && typeof entry[0] === 'string') {
    const tuple = entry as unknown[]
    const plugin = await loadPlugin(tuple[0] as string, resolveFrom)
    if (plugin === UNRESOLVED_PLUGIN) return UNRESOLVED_PLUGIN
    return [plugin, ...tuple.slice(1)]
  }
  return entry
}

/**
 * Resolve a plugin from the app root and import it. Returns the plugin's default
 * export, or UNRESOLVED_PLUGIN (with a warning) when it is not installed or
 * cannot be loaded. Resolution is rooted at the app (`createRequire(root/...)`)
 * so the toolchain stays inside the app's node_modules.
 */
async function loadPlugin(name: string, resolveFrom: NodeRequire): Promise<unknown> {
  let resolved: string
  try {
    resolved = resolveFrom.resolve(name)
  } catch {
    console.warn(
      `pnext: MDX plugin '${name}' is configured but not installed; skipping it. ` +
        'Install it to apply this remark/rehype/recma plugin.',
    )
    return UNRESOLVED_PLUGIN
  }
  try {
    return interopDefault(await import(pathToFileURL(resolved).href))
  } catch (error) {
    console.warn(
      `pnext: MDX plugin '${name}' failed to load and was skipped: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        'Ensure it is installed in the app’s node_modules (not only Bun’s auto-install cache).',
    )
    return UNRESOLVED_PLUGIN
  }
}

/** Resolve every entry of a remark/rehype/recma plugin array (skipping absent packages). */
async function resolvePlugins(plugins: unknown[], resolveFrom: NodeRequire): Promise<unknown[]> {
  const resolved = await Promise.all(plugins.map(entry => resolvePlugin(entry, resolveFrom)))
  return resolved.filter(entry => entry !== UNRESOLVED_PLUGIN)
}

/**
 * Compile MDX source to JSX targeting the preact automatic runtime. `root` locates
 * the optional mdx-components provider; `filePath` feeds source positions.
 */
export async function compileMdx(
  source: string,
  filePath: string,
  root: string,
): Promise<MdxCompileResult> {
  const mdx = await loadMdx()
  if (!mdx) {
    throw new Error(
      "MDX support requires the '@mdx-js/mdx' package. Install it to render .mdx files.",
    )
  }

  const userOptions = mdxOptionsFromConfig()
  const provider = resolveMdxComponents(root)

  // Resolve string/tuple plugin names (@next/mdx's serialized form) to actual
  // plugin functions from the app's node_modules before handing them to MDX.
  const resolveFrom = createRequire(path.join(root, 'noop.js'))

  const [remarkPlugins, rehypePlugins, recmaPlugins] = await Promise.all([
    resolvePlugins(userOptions.remarkPlugins ?? [], resolveFrom),
    resolvePlugins(userOptions.rehypePlugins ?? [], resolveFrom),
    resolvePlugins(userOptions.recmaPlugins ?? [], resolveFrom),
  ])

  const compiled = await mdx.compile(
    { value: source, path: filePath },
    {
      // Emit JSX; esbuild's `jsx` loader performs the final transform with
      // jsxImportSource: 'preact', matching every other compile site.
      jsx: true,
      jsxImportSource: 'preact',
      // Full MDX (not just markdown) so `import`/`export` and JSX in `.mdx` work.
      format: 'mdx',
      // Development positions off — matches production build output.
      development: false,
      remarkPlugins,
      rehypePlugins,
      recmaPlugins,
      ...(userOptions.remarkRehypeOptions
        ? { remarkRehypeOptions: userOptions.remarkRehypeOptions }
        : {}),
      // Only wire a components provider when the app supplies one; otherwise MDX
      // emits plain host elements (the mdx-no-mdx-components contract).
      ...(userOptions.providerImportSource
        ? { providerImportSource: userOptions.providerImportSource }
        : provider
          ? { providerImportSource: provider }
          : {}),
    },
  )

  return { code: compiled.toString() }
}
