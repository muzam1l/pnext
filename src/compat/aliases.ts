import path from 'node:path'
import { createRequire } from 'node:module'
import type { Plugin } from 'esbuild'
import { frameworkRuntimeAliasEntries, pnextAliases, type CompatAliasTarget } from '../config'
import type { PNextConfig } from '../types'
import { escapeRegex, isIdentifier, uniqueIdentifier } from '../utils/code'
import { actionClientStubPlugin, hasClientActionModules } from './actions/client-plugin'
import { rewriteRootParamsSource } from './ppr/root-params-transform'

export type CompatConfig = Pick<PNextConfig, 'compat'>

export function reactCompatEnabled(config: CompatConfig) {
  return Boolean(config.compat?.next || config.compat?.react || reactCompilerOptions(config))
}

export function reactCompilerOptions(config: CompatConfig) {
  if (!config.compat?.reactCompiler) return undefined
  return { target: '18' }
}

export function nextCompatEnabled(config: CompatConfig) {
  return Boolean(config.compat?.next)
}

/** The only `next/dist/*` deep imports pnext shims (see https://pnext.dev/docs/compat "Smaller surfaces"). */
export const SHIMMED_NEXT_DIST_PATHS = [
  'next/dist/client/components/app-router-headers',
  'next/dist/server/web/spec-extension/unstable-cache',
  'next/dist/server/web/spec-extension/unstable-no-store',
  'next/dist/server/web/spec-extension/revalidate',
  'next/dist/server/app-render/work-unit-async-storage.external',
]

/**
 * Clear failure for compat-only imports in apps that never enabled the
 * matching compat mode.
 */
export function missingCompatImportError(
  config: CompatConfig,
  specifier: string,
): string | undefined {
  if (/^next(\/|$)/.test(specifier)) {
    if (!nextCompatEnabled(config)) {
      return `'${specifier}' requires Next compatibility. Enable compat.next in pnext.config.ts.`
    }
    if (specifier.startsWith('next/dist/')) {
      const bare = specifier.replace(/\.js$/, '')
      if (!SHIMMED_NEXT_DIST_PATHS.includes(bare)) {
        return (
          `'${specifier}' is not a supported import: next/dist internals are not part of the ` +
          `public surface pnext shims. Only these next/dist/* paths are shimmed:\n` +
          SHIMMED_NEXT_DIST_PATHS.map(path => `  - ${path}`).join('\n') +
          `\nSee https://pnext.dev/docs/compat ("Smaller surfaces") and report the library that needs a new shim.`
        )
      }
    }
    return undefined
  }
  if (/^react(-dom)?(\/|$)/.test(specifier) && !reactCompatEnabled(config)) {
    return `'${specifier}' requires React compatibility. Enable compat.react (or compat.next) in pnext.config.ts.`
  }
  return undefined
}

export function compatAliases(
  config: CompatConfig,
  target: CompatAliasTarget,
): Record<string, string> {
  return {
    ...frameworkRuntimeAliasEntries(),
    ...pnextAliases(target),
    ...reactCompatAliases(config, target),
    ...nextCompatAliases(config, target),
  }
}

/**
 * B4 react-server layer override for App RSC, route handlers, and edge
 * modules. The base server shims keep client hooks for Pages/API and
 * instrumentation compatibility.
 */
export function reactServerLayerAliases(config: CompatConfig): Record<string, string> {
  if (!reactCompatEnabled(config)) return {}
  const reactRoot = path.resolve(import.meta.dirname, 'react')
  return {
    react: path.join(reactRoot, 'react-server.ts'),
    'react-dom': path.join(reactRoot, 'dom-react-server.ts'),
  }
}

export function reactCompatAliases(
  config: CompatConfig,
  target: CompatAliasTarget,
): Record<string, string> {
  if (!reactCompatEnabled(config)) return {}
  const reactRoot = path.resolve(import.meta.dirname, 'react')
  const runtime = frameworkRuntimeAliasEntries()
  return {
    react: path.join(reactRoot, target === 'client' ? 'client.ts' : 'server.ts'),
    // dom.ts wraps preact/compat with the form-action hooks react-dom ships
    // (useFormState/useFormStatus/requestFormReset).
    'react-dom': path.join(reactRoot, 'dom.ts'),
    'react-dom/client': runtime['preact/compat/client'],
    // react-dom/server (+ .edge/.browser entrypoints) shimmed over
    // preact-render-to-string for the synchronous string renderers.
    'react-dom/server': path.join(reactRoot, 'dom-server.ts'),
    'react-dom/server.edge': path.join(reactRoot, 'dom-server.ts'),
    'react-dom/server.browser': path.join(reactRoot, 'dom-server.ts'),
    'react/jsx-runtime': runtime['preact/jsx-runtime'],
    'react/jsx-dev-runtime': runtime['preact/jsx-dev-runtime'],
    // React Compiler memo-cache runtime. Both the React 19 built-in specifier
    // (`react/compiler-runtime`) and the standalone npm package name
    // (`react-compiler-runtime`, emitted for a React 17/18 compiler target, and
    // imported by pre-compiled libraries) map to a preact-backed shim. The npm
    // package's own `require('react').useMemo` throws under preact SSR.
    'react/compiler-runtime': path.join(reactRoot, 'compiler-runtime.ts'),
    'react-compiler-runtime': path.join(reactRoot, 'compiler-runtime.ts'),
  }
}

export function nextCompatAliases(
  config: CompatConfig,
  target: CompatAliasTarget,
): Record<string, string> {
  if (!nextCompatEnabled(config)) return {}
  return nextCompatAliasEntries(target)
}

export function nextCompatAliasEntries(target: CompatAliasTarget): Record<string, string> {
  const nextRoot = path.resolve(import.meta.dirname, 'next')
  return withJsExtensionAliases({
    next: path.join(nextRoot, 'index.ts'),
    // Client variant avoids node:async_hooks (render cache-meta collector) in
    // browser bundles; the APIs are server-only in Next anyway.
    'next/cache': path.join(nextRoot, target === 'client' ? 'client-cache.ts' : 'cache.ts'),
    'next/config': path.join(nextRoot, 'config.ts'),
    // CJS so an app `require('next/constants')` loads a genuine CommonJS module: the server runtime's
    // onLoad transform only intercepts `[jt]sx?`, so a `.cjs` external is left to Bun's native loader
    // and stays synchronously requirable - an ESM `.ts` external forced through that transform becomes
    // async and require() returns undefined for every named export.
    'next/constants': path.join(nextRoot, 'constants.cjs'),
    'next/dynamic': path.join(nextRoot, 'dynamic.tsx'),
    'next/error': path.join(nextRoot, 'error.tsx'),
    'next/font': path.join(nextRoot, 'font', 'index.ts'),
    'next/font/google': path.join(nextRoot, 'font', 'google.ts'),
    'next/font/local': path.join(nextRoot, 'font', 'local.ts'),
    'next/form': path.join(nextRoot, 'form.tsx'),
    'next/head': path.join(nextRoot, 'head.tsx'),
    'next/headers': path.join(nextRoot, 'headers.ts'),
    'next/image': path.join(nextRoot, 'image.tsx'),
    // The legacy component blanks a lazy image's `src` until it is near the
    // viewport — its own module, not an alias of the modern one.
    'next/legacy/image': path.join(nextRoot, 'legacy-image.tsx'),
    'next/link': path.join(nextRoot, 'link.tsx'),
    'next/navigation': path.join(
      nextRoot,
      target === 'client' ? 'client-navigation.ts' : 'navigation.ts',
    ),
    'next/offline': path.join(nextRoot, 'offline.ts'),
    'next/og': path.join(nextRoot, 'og.ts'),
    '@vercel/og': path.join(nextRoot, 'og.ts'),
    'next/root-params': path.join(nextRoot, 'root-params.ts'),
    'next/router': path.join(nextRoot, 'router.ts'),
    'next/script': path.join(nextRoot, target === 'client' ? 'client-script.tsx' : 'script.tsx'),
    'next/web-vitals': path.join(nextRoot, 'web-vitals.ts'),
    // Client variant avoids node:async_hooks (request scope / ppr / revalidate)
    // in browser bundles; the request-scope APIs are server-only in Next anyway.
    'next/server': path.join(nextRoot, target === 'client' ? 'client-server.ts' : 'server.ts'),
    // Server compiles accept the marker (react-server condition equivalent);
    // client bundles keep the package's own error behavior.
    ...(target === 'server' ? { 'server-only': path.join(nextRoot, 'server-only.ts') } : {}),
    // client-only must resolve on both targets: a 'use client' page importing it
    // is legitimately SSR'd (server compile) as well as browser-bundled.
    'client-only': path.join(nextRoot, 'client-only.ts'),
    // The styled-jsx source transform (css/styled-jsx.ts) rewrites <style jsx>
    // blocks to import from this specifier; apps never install styled-jsx.
    'styled-jsx': path.join(nextRoot, '..', 'css', 'styled-jsx-runtime.ts'),
    // Deep next/dist imports that show up in real Next apps and e2e fixtures.
    // Exact-match aliases only; unknown next/dist paths keep failing through
    // missingCompatImportError / normal resolution.
    'next/dist/client/components/app-router-headers': path.join(
      nextRoot,
      'dist',
      'client',
      'components',
      'app-router-headers.ts',
    ),
    'next/dist/server/web/spec-extension/unstable-cache': path.join(
      nextRoot,
      'dist',
      'server',
      'web',
      'spec-extension',
      'unstable-cache.ts',
    ),
    'next/dist/server/web/spec-extension/unstable-no-store': path.join(
      nextRoot,
      'dist',
      'server',
      'web',
      'spec-extension',
      'unstable-no-store.ts',
    ),
    'next/dist/server/web/spec-extension/revalidate': path.join(
      nextRoot,
      'dist',
      'server',
      'web',
      'spec-extension',
      'revalidate.ts',
    ),
    // Direct import of the work-unit store (see the shim's header). Server-only;
    // a browser bundle never reaches request context. CJS for the same reason as
    // next/constants above: apps `require()` this deep internal, and a `.ts`
    // external would become an async module through the onLoad transform, making
    // the require() throw outright.
    ...(target === 'server'
      ? {
          'next/dist/server/app-render/work-unit-async-storage.external': path.join(
            nextRoot,
            'dist',
            'server',
            'app-render',
            'work-unit-async-storage.external.cjs',
          ),
        }
      : {}),
  })
}

function withJsExtensionAliases(aliases: Record<string, string>) {
  const entries = { ...aliases }
  for (const [specifier, target] of Object.entries(aliases)) {
    if (specifier !== 'next') entries[`${specifier}.js`] = target
  }
  return entries
}

/**
 * esbuild client-bundle aliasing for compat specifiers, with clear failures
 * for compat-only imports instead of resolving to whatever react/next package
 * happens to be installed.
 */
export function compatAliasPlugin(config: CompatConfig): Plugin {
  const aliases = compatAliases(config, 'client')
  const specifiers = Object.keys(aliases)
  return {
    name: 'pnext-compat-alias',
    setup(build) {
      // When compat.next discovered server-action modules, swap their client
      // imports for the generated fetch stub. Registered here so the action
      // stub participates in every client build without editing the client
      // build pipeline. No-op when no action modules were discovered.
      if (nextCompatEnabled(config) && hasClientActionModules()) {
        void actionClientStubPlugin().setup(build)
      }

      build.onResolve({ filter: /^(?:react(?:-dom)?|next)(?:\/|$)/ }, args => {
        if (aliases[args.path]) return undefined
        const message = missingCompatImportError(config, args.path)
        return message ? { errors: [{ text: message }] } : undefined
      })
      if (specifiers.length === 0) return
      build.onResolve(
        { filter: new RegExp(`^(${specifiers.map(escapeRegex).join('|')})$`) },
        async args => {
          const target = aliases[args.path]
          if (!target) return undefined
          if (path.isAbsolute(target)) return { path: target }
          return build.resolve(target, {
            kind: args.kind,
            importer: args.importer,
            namespace: args.namespace,
            resolveDir: args.resolveDir,
          })
        },
      )
    },
  }
}

// Compat apps render React's Suspense (the preact/compat class, via the react
// aliases or a direct import). That identity is loaded lazily and only when
// compat is enabled, so core apps never pull preact/compat into the server
// process — core streaming uses PNext's own Suspense marker instead.
let compatSuspense: unknown

export async function ensureCompatSuspense(config: CompatConfig) {
  if (compatSuspense !== undefined || !reactCompatEnabled(config)) return
  compatSuspense = ((await import('preact/compat')) as { Suspense: unknown }).Suspense
}

export function compatSuspenseType() {
  return compatSuspense
}

/**
 * next/font runtime targets. The SERVER runtime (runtime.ts) emits CSS + font
 * files and imports `node:*` at module scope; the CLIENT runtime
 * (runtime-client.ts) is `node:*`-free and only returns the pre-hashed
 * className/variable/style a browser bundle needs (CORE GAP D). The rewrite
 * binds font imports to the runtime matching the build target, mirroring the
 * next/cache + next/navigation client/server alias split in nextCompatAliasEntries.
 */
const fontRuntimePaths: Record<CompatAliasTarget, string> = {
  server: path.join(import.meta.dirname, 'next', 'font', 'runtime.ts'),
  client: path.join(import.meta.dirname, 'next', 'font', 'runtime-client.ts'),
}

/**
 * Next-compat source rewrites for `next/font/google` and `next/font/local` imports. Only invoked when
 * compat.next is enabled; without it the imports survive untouched and fail with the missing-compat
 * resolve error.
 *
 * `target` selects the runtime the rewritten imports bind to: 'server' (default) for server compiles,
 * 'client' for browser bundles, which avoids pulling node:async_hooks / node:crypto into the bundle.
 */
export function rewriteNextFontSource(
  source: string,
  file: string,
  target: CompatAliasTarget = 'server',
  root?: string,
) {
  if (!source.includes('next/font') && !source.includes('next/root-params')) return source
  // The single next/root-params rewrite in the tree; every other call site
  // reaches it through this pass rather than re-running its own copy.
  source = rewriteRootParamsSource(source)
  const runtimePath = fontRuntimePaths[target]
  let next = rewriteNextGoogleFontImports(source, runtimePath)
  const localFontNames = nextLocalFontImportNames(next)
  if (localFontNames.size === 0) return next
  const callerFile = localFontCallerFile(file, root)
  // Rewrite each `NAME(...)` call to `NAME.withFile(<file>)(...)` so the runtime
  // gets the caller path (for `src` resolution + a stable per-caller hash). The
  // client runtime only uses `callerFile` for the hash (which must match the
  // server's exactly), so the SAME `withFile(<file>)` wrapping applies to both.
  for (const name of localFontNames) {
    next = next.replace(
      new RegExp(`(?<![.$\\w])${escapeRegex(name)}\\s*\\(`, 'g'),
      `${name}.withFile(${JSON.stringify(callerFile)})(`,
    )
  }
  // Next names local-font families after the binding (`const myFont = …`),
  // including when the loader lives in a package under node_modules.
  for (const name of localFontNames) {
    next = next.replace(
      new RegExp(
        `((?:export\\s+)?(?:const|let|var)\\s+)([A-Za-z_$][\\w$]*)(\\s*=\\s*)${escapeRegex(name)}\\.withFile\\(([^)]*)\\)\\(`,
        'g',
      ),
      (_statement, declaration: string, binding: string, equals: string, caller: string) =>
        `${declaration}${binding}${equals}${name}.withFile(${caller}, ${JSON.stringify(binding)})(`,
    )
  }
  // Replace the bare `import NAME from 'next/font/local'` with an import bound
  // directly to the runtime's absolute path. This avoids relying on server-side
  // `next/font/local` alias resolution, which does not reach modules imported
  // from workspace dirs outside app/ (e.g. a `fonts/index.js` barrel).
  next = next.replace(
    /^[ \t]*import\s+([A-Za-z_$][\w$]*)\s+from\s+(['"])([^'"]+)\2\s*;?[ \t]*$/gm,
    (statement, name: string, _quote: string, specifier: string) => {
      if (!isNextLocalFontSpecifier(specifier)) return statement
      return `import { localFont as ${name} } from ${JSON.stringify(runtimePath)};`
    },
  )
  return next
}

function rewriteNextGoogleFontImports(source: string, runtimePath: string) {
  const statements: string[] = []
  const helperName = uniqueIdentifier(source, '__pnextGoogleFont')
  const namespaceHelperName = uniqueIdentifier(source, '__pnextGoogleFonts', helperName)
  const rewritten = source.replace(
    /^[ \t]*import\s+(?!type\b)((?:[^\n;]|\n(?![ \t]*(?:import|export)\b))*?)\s+from\s+['"]next\/font\/google['"]\s*;?[ \t]*(?:\r?\n)?/gm,
    (_statement: string, clause: string) => {
      const bindings = nextGoogleFontBindings(clause)
      if (bindings.length === 0) return ''
      statements.push(
        ...bindings.map(binding =>
          googleFontBindingSource(binding, helperName, namespaceHelperName),
        ),
      )
      return ''
    },
  )

  if (statements.length === 0) return source
  return [
    `import { googleFont as ${helperName} } from ${JSON.stringify(runtimePath)};`,
    `const ${namespaceHelperName} = new Proxy({}, { get: (_target, key) => typeof key === 'string' ? ${helperName}(key.replace(/_/g, ' ')) : undefined });`,
    ...statements,
    rewritten,
  ].join('\n')
}

interface GoogleFontBinding {
  imported: string
  local: string
  namespace?: boolean
}

function nextGoogleFontBindings(clause: string): GoogleFontBinding[] {
  const trimmed = clause.trim()
  const namespace = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(trimmed)?.[1]
  if (namespace) return [{ imported: namespace, local: namespace, namespace: true }]

  const named = /\{([\s\S]*)\}/.exec(trimmed)?.[1]
  if (!named) return []
  return named
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .flatMap(part => {
      if (part.startsWith('type ')) return []
      const [importedRaw, localRaw] = part.split(/\s+as\s+/)
      const imported = importedRaw?.trim()
      const local = (localRaw ?? importedRaw)?.trim()
      if (!imported || !local || !isIdentifier(imported) || !isIdentifier(local)) return []
      return [{ imported, local }]
    })
}

function googleFontBindingSource(
  binding: GoogleFontBinding,
  helperName: string,
  namespaceHelperName: string,
) {
  if (binding.namespace) return `const ${binding.local} = ${namespaceHelperName};`
  return `const ${binding.local} = ${helperName}(${JSON.stringify(googleFontFamily(binding.imported))});`
}

function googleFontFamily(exportName: string) {
  return exportName.replace(/_/g, ' ')
}

function nextLocalFontImportNames(source: string) {
  const names = new Set<string>()
  const pattern = /\bimport\s+([A-Za-z_$][\w$]*)\s+from\s+(['"])([^'"]+)\2/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source))) {
    if (match[1] && match[3] && isNextLocalFontSpecifier(match[3])) names.add(match[1])
  }
  return names
}

function isNextLocalFontSpecifier(specifier: string) {
  if (specifier === 'next/font/local' || specifier === 'next/font/local.js') return true
  const normalized = specifier.replace(/^file:\/\//, '').replace(/\\/g, '/')
  return /\/compat\/next\/font\/local\.[jt]s$/.test(normalized)
}

function localFontCallerFile(file: string, root: string | undefined) {
  if (path.isAbsolute(file)) return file
  if (file.startsWith('.')) return path.resolve(root ?? process.cwd(), file)
  if (!root) return file
  try {
    return createRequire(path.join(root, 'pnext-resolve.cjs')).resolve(file)
  } catch {
    return file
  }
}
