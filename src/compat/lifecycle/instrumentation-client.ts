// instrumentation-client (COMPAT): a build step bundles the inject modules then the app's
// instrumentation-client into one asset. A <head> script starts its import as `self.__PNEXT_IC__`;
// the route entry awaits it before mounting, as Next runs it before hydration.

import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { build } from '../../utils/esbuild'
import type { ResolvedConfig } from '../../config'
import { getNextConfig } from '../next/config-loader'
import { instrumentationLookupRoots } from './instrumentation'
import { outCachePath } from '../../out-paths'

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

export function hasInstrumentationClient(config: ResolvedConfig): boolean {
  return findInstrumentationClient(config) !== undefined
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
function entrySource(modules: string[], transitionEvents: boolean): string {
  const imports = modules
    .map((file, index) => `import * as mod${index} from ${JSON.stringify(file)};`)
    .join('\n')
  const names = modules.map((_file, index) => `mod${index}`).join(', ')
  const eventSource = transitionEvents
    ? `let nextTransitionId = 0
function sourceRoutePath(route: string, catchAllOptional = false): string {
  return (
    '/' +
    route
      .split('/')
      .filter(Boolean)
      .filter(segment => !/^\\((?!\\.{1,3}\\))/.test(segment))
      .map(segment => {
        const catchAll = /^:([\\w$]+)\\*$/.exec(segment)
        if (catchAll) return catchAllOptional ? \`[[...\${catchAll[1]}]]\` : \`[...\${catchAll[1]}]\`
        const dynamic = /^:([\\w$]+)$/.exec(segment)
        return dynamic ? \`[\${dynamic[1]}]\` : segment
      })
      .join('/')
  )
}

function transitionFromRoutes(): string[] {
  let nav = {}
  try { nav = JSON.parse(document.getElementById('__PNEXT_NAV_STATE__')?.textContent || '{}') } catch {}
  nav.children ||= location.pathname
  const prefix = 'window.__PNEXT_ROUTE__='
  const source = [...document.scripts].map(script => script.textContent || '').find(text => text.startsWith(prefix))
  let state
  try { state = source && JSON.parse(source.slice(prefix.length).replace(/;\\s*$/, '')) } catch {}
  const primary = sourceRoutePath(
    nav.hostRender ? (nav.children ?? '/') : (state?.route ?? nav.children ?? '/'),
    state?.catchAllOptional,
  )
  const routes = [primary]
  const primarySegments = (nav.children ?? '/').split('/').filter(Boolean)
  const targetPattern = sourceRoutePath(
    nav.interceptedRoute ?? state?.route ?? nav.children ?? '/',
    state?.catchAllOptional,
  )
    .split('/')
    .filter(Boolean)
  for (const [slotDir, source] of Object.entries(nav.slots ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const base = sourceRoutePath(slotDir)
    const sourcePath = source.split('?')[0] || '/'
    if (sourcePath === nav.children) routes.push(base)
    else {
      const suffix = targetPattern.slice(primarySegments.length)
      routes.push(\`\${base}\${suffix.length ? \`/(.)\${suffix.join('/')}\` : ''}\`)
    }
  }
  return [...new Set(routes)]
}

function routerTransitionEvent(intent) {
  return {
    id: \`\${Date.now().toString(36)}-\${(++nextTransitionId).toString(36)}\`,
    timestamp: performance.timeOrigin + performance.now(),
    fromRoutes: transitionFromRoutes(),
    prefetchIntent: intent,
  }
}

`
    : ''
  return `${imports}
${eventSource}
const modules = [${names}];
window.__PNEXT_ON_ROUTER_TRANSITION_START__ = (href, navigateType, intent) => {
  const event = ${transitionEvents ? 'routerTransitionEvent(intent)' : 'null'};
  for (const mod of modules) {
    const hooks = mod && typeof mod.default === 'object' ? mod.default : mod;
    const hook = hooks && hooks.onRouterTransitionStart;
    if (typeof hook === 'function') {
      try {
        hook(href, navigateType, ${transitionEvents ? 'event' : 'null'});
      } catch (error) {
        console.error('An instrumentation-client router transition hook failed', error);
      }
    }
  }
};
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
  const workDir = path.join(outCachePath(config.outPath), 'instrumentation-client')
  mkdirSync(workDir, { recursive: true })
  const entryFile = path.join(workDir, 'entry.ts')
  const outfile = path.join(config.outPath, 'static', INSTRUMENTATION_CLIENT_ASSET)
  mkdirSync(path.dirname(outfile), { recursive: true })
  const experimental = getNextConfig().experimental as
    { instrumentationClientRouterTransitionEvents?: boolean } | undefined
  await Bun.write(
    entryFile,
    entrySource(modules, experimental?.instrumentationClientRouterTransitionEvents === true),
  )
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
  bundlePresence ??= existsSync(path.join(config.outPath, 'static', INSTRUMENTATION_CLIENT_ASSET))
  return bundlePresence
}

/** Test-only reset for the bundle-presence cache. */
export function resetInstrumentationClientForTest(): void {
  bundlePresence = undefined
}

/** The `<head>` script importing the instrumentation-client bundle, or '' when the app has none. */
export function instrumentationClientHeadTag(config: ResolvedConfig): string {
  if (!hasInstrumentationClientBundle(config)) return ''
  const prefix = config.basePath ?? ''
  return `<script>self.__PNEXT_IC__=import(${JSON.stringify(`${prefix}/${INSTRUMENTATION_CLIENT_ASSET}`)})</script>`
}
