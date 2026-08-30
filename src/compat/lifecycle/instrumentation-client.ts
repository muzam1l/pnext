// instrumentation-client.ts (COMPAT).
//
// Next executes the app's instrumentation-client.(ts|js) in the browser BEFORE hydration, plus any
// `instrumentationClientInject` next.config entries before it, in array order; each module may export
// onRouterTransitionStart(href, navigateType) which the client router calls at the start of every soft
// navigation.
//
// pnext emulation:
//   - BUILD: a build step (running before prerendering, so statically generated pages carry the tag
//     too) bundles a synthetic entry importing the inject modules then the user module - static ESM
//     imports preserve array order - into `<out>/public/assets/instrumentation-client.js`.
//   - The synthetic entry collects every module's onRouterTransitionStart into
//     `window.__PNEXT_ON_ROUTER_TRANSITION_START__`; the client router invokes that global when a
//     navigation starts.
//   - DOCUMENT: a `<script type="module">` head tag loads the bundle. Module scripts execute in document
//     order, so the head module runs before the route entry module at the end of <body>.
//
// Zero-cost: apps without an instrumentation-client file get no bundle, no build work, no head tag.

import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { build } from '../../utils/esbuild'
import type { ResolvedConfig } from '../../config'
import { getNextConfig } from '../next/config-loader'
import { instrumentationLookupRoots } from './instrumentation'

const CLIENT_BASENAMES = [
  'instrumentation-client.ts',
  'instrumentation-client.tsx',
  'instrumentation-client.js',
  'instrumentation-client.mjs',
  'instrumentation-client.mts',
]

/** The served pathname of the bundled instrumentation-client asset. */
export const INSTRUMENTATION_CLIENT_ASSET = 'assets/instrumentation-client.js'

function findInstrumentationClient(config: ResolvedConfig): string | undefined {
  for (const root of instrumentationLookupRoots(config)) {
    for (const name of CLIENT_BASENAMES) {
      const candidate = path.join(root, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/** `instrumentationClientInject` module paths from next.config, root-resolved. */
function injectEntries(config: ResolvedConfig): string[] {
  const value = getNextConfig().instrumentationClientInject
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => path.resolve(config.root, entry))
}

/**
 * The synthetic browser entry: inject modules then the user module (static
 * imports evaluate in order), followed by the transition-start hook registry.
 */
function entrySource(modules: string[]): string {
  const imports = modules
    .map((file, index) => `import * as mod${index} from ${JSON.stringify(file)};`)
    .join('\n')
  const names = modules.map((_file, index) => `mod${index}`).join(', ')
  return `${imports}
const hooks = [${names}]
  .map(mod => (mod && typeof mod.onRouterTransitionStart === 'function' ? mod.onRouterTransitionStart : null))
  .filter(Boolean);
if (hooks.length > 0) {
  window.__PNEXT_ON_ROUTER_TRANSITION_START__ = (href, navigateType) => {
    for (const hook of hooks) {
      try {
        hook(href, navigateType);
      } catch (error) {
        console.error(error);
      }
    }
  };
}
`
}

/**
 * Bundle the instrumentation-client entry into the build output. No-op when
 * the app has no instrumentation-client file. Called from the registered build
 * step (before prerendering, so prerendered documents include the head tag).
 */
export async function buildInstrumentationClient(config: ResolvedConfig): Promise<void> {
  const userFile = findInstrumentationClient(config)
  if (!userFile) return
  const modules = [...injectEntries(config), userFile]
  const workDir = path.join(config.outPath, 'cache', 'instrumentation-client')
  mkdirSync(workDir, { recursive: true })
  const entryFile = path.join(workDir, 'entry.ts')
  const outfile = path.join(config.outPath, 'public', INSTRUMENTATION_CLIENT_ASSET)
  mkdirSync(path.dirname(outfile), { recursive: true })
  await Bun.write(entryFile, entrySource(modules))
  const tsconfig = path.join(config.root, 'tsconfig.json')
  await build({
    entryPoints: [entryFile],
    outfile,
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2020',
    minify: false,
    ...(existsSync(tsconfig) ? { tsconfig } : {}),
    logLevel: 'silent',
    sourcemap: false,
  })
  bundlePresence = true
}

let bundlePresence: boolean | undefined

/** Whether the built instrumentation-client bundle exists (cached). */
function hasInstrumentationClientBundle(config: ResolvedConfig): boolean {
  bundlePresence ??= existsSync(path.join(config.outPath, 'public', INSTRUMENTATION_CLIENT_ASSET))
  return bundlePresence
}

/** Test-only reset for the bundle-presence cache. */
export function resetInstrumentationClientForTest(): void {
  bundlePresence = undefined
}

/**
 * The `<head>` tag loading the instrumentation-client bundle, or '' when the
 * app has none. basePath-prefixed like every other asset href.
 */
export function instrumentationClientHeadTag(config: ResolvedConfig): string {
  if (!hasInstrumentationClientBundle(config)) return ''
  const prefix = config.basePath ?? ''
  return `<script type="module" src="${prefix}/${INSTRUMENTATION_CLIENT_ASSET}"></script>`
}
