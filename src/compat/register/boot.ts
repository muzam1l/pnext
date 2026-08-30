// Boot-tier compat registration (COMPAT - may import core freely).
//
// The MINIMAL set of compat facts core reads before it compiles anything, kept in one deliberately
// shallow module so a dev boot never pulls the full compat graph. Everything registered here is
// consulted by boot-time core code:
//
//   - route conventions / usage detectors / page extensions   -> scanRoutes
//   - `.scss`/`.sass` + CSS dependency resolution             -> scanRoutes
//   - bare-specifier aliases (module + import-alias registry)  -> scanRoutes and registerServerRuntime,
//     which latch the alias map at boot
//   - proxy file names                                         -> findProxyFile
//   - lifecycle init hooks                                     -> runInitHooks
//
// Everything else waits for registerCompatExtensions on the first compile/request. Registrars in the
// full tier that re-assign a value set here re-assign the SAME implementation, so the two tiers cannot
// disagree.

import type { ResolvedConfig } from '../../config'
import {
  getProxyExtensions,
  onExtensionHostReset,
  registerLoadableExtensions,
  registerPageExtensions,
  setBundlerExtensions,
  setCompatModeExtensions,
  setCssExtensions,
  setImportAliasExtensions,
  setProxyExtensions,
} from '../../extensions'
import { findProxyFiles } from '../../routing/proxy'
import {
  packageNameOfSpecifier,
  resolvePackageSpecifier,
  setModuleAliases,
} from '../../resolve/imports'
import {
  compatAliases,
  missingCompatImportError,
  nextCompatAliases,
  nextCompatEnabled,
  reactCompatEnabled,
  reactCompilerOptions,
  reactServerLayerAliases,
} from '../aliases'
import { transpilePackages } from '../bundler/config'
import { materializeNextCssSources, nextCssResolveDependency } from '../css/modules'
import { getNextConfig } from '../next/config-loader'
import { registerLifecycleBootHooks } from './lifecycle'
import { registerRoutingExtensions } from './routing'

/** Proxy entrypoint basenames Next supports (`middleware` is the legacy name). */
const NEXT_PROXY_NAMES = ['proxy', 'middleware']

// Extensions core already carries as page/convention files (base list in
// routes.ts). Registering one of these is a no-op, so we filter them out and
// only register the genuinely-extra ones a configured pageExtensions adds.
const CORE_BASE_PAGE_EXTENSIONS = new Set(['tsx', 'ts', 'jsx', 'js', 'mjs'])

let registered = false
// Host-scoped guard: a fresh host must be registered into again.
onExtensionHostReset(() => (registered = false))

export function registerCompatBootExtensions(config: ResolvedConfig): void {
  if (registered) return
  registered = true

  setCompatModeExtensions({
    nextEnabled: nextCompatEnabled,
    reactEnabled: reactCompatEnabled,
    reactCompilerOptions,
  })
  setImportAliasExtensions({
    aliases: compatAliases,
    clientSsrAliases: cfg => nextCompatAliases(cfg, 'server'),
    missingImportError: missingCompatImportError,
    reactServerLayerAliases,
  })
  // Route scanning (client-reference/boundary detection) resolves imports statically, with no per-call
  // config to consult - register the same bare-specifier aliases the bundler uses so a server component
  // importing e.g. `next/form` still resolves to its compat file and gets walked for 'use client'
  // detection.
  setModuleAliases(compatAliases(config, 'server'))
  registerRoutingExtensions(config)
  registerLifecycleBootHooks(config)

  if (!nextCompatEnabled(config)) return

  registerCompatPageExtensions()
  setBundlerExtensions({ resolveRouteDependency: resolveTranspiledRouteDependency() })
  materializeNextCssSources(config)
  setCssExtensions({
    extraCssExtensions: () => ['.scss', '.sass'],
    resolveCssDependency: nextCssResolveDependency(config),
  })
  setProxyExtensions({ names: NEXT_PROXY_NAMES, validateFiles: validateProxyFiles })
}

/**
 * Register the extra page extensions the app's `pageExtensions` config declares
 * (Next semantics: pageExtensions is authoritative; @next/mdx's createMDX
 * appends `md`/`mdx`). Only extensions core does not already carry are
 * registered, and only when the app actually configured pageExtensions. The
 * matching MDX compilation is wired later, in register-mdx.
 */
function registerCompatPageExtensions(): void {
  const configured = getNextConfig().pageExtensions
  if (Array.isArray(configured)) {
    const extras = configured.filter(
      (ext): ext is string =>
        typeof ext === 'string' && ext.length > 0 && !CORE_BASE_PAGE_EXTENSIONS.has(ext),
    )
    if (extras.length > 0) registerPageExtensions(...extras)
  }
  // Imported markdown is loadable even when not routable: `pageExtensions:
  // ['mdx']` still allows `import Doc from './x.md'` through @next/mdx's
  // /\.mdx?$/ rule, and the server runtime compiles both (runtime/modules,
  // transformSource). Without this the Bun load plugin never claims `.md` and
  // the import falls through to the file loader (default export = the path).
  registerLoadableExtensions('mdx', 'md')
}

/** B7 `transpilePackages` resolution used by the route scanner's module walk. */
function resolveTranspiledRouteDependency() {
  const transpile = new Set(transpilePackages())
  return (root: string, fromFile: string, specifier: string): string | undefined => {
    const packageName = packageNameOfSpecifier(specifier)
    if (!packageName || !transpile.has(packageName)) return undefined
    return resolvePackageSpecifier(root, fromFile, specifier, ['import', 'browser', 'default'])
  }
}

/**
 * Next's proxy/middleware diagnostics. Only an app that actually ships one of those files loads the proxy
 * implementation - for everyone else this is the whole cost of proxy support at boot.
 */
async function validateProxyFiles(config: ResolvedConfig): Promise<void> {
  if (findProxyFiles(config, NEXT_PROXY_NAMES).length === 0) return
  const { registerProxyExtensions } = await import('./proxy')
  registerProxyExtensions(config)
  await getProxyExtensions().validateFiles(config)
}
