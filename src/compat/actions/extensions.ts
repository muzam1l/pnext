// Server actions extension implementation (COMPAT - may import core freely): the action build step
// (discovery/bundling + server-reference manifest), request interceptors (action dispatch, then
// next.config redirects/rewrites), the render extension that serializes a server-action prop, and
// the dev/prod action-registry arming they all share. Registered by ../register/actions.ts, which
// wires the exports below into the extension registries.

import path from 'node:path'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { ResolvedConfig } from '../../config'
import { pathToFileHref } from '../../config'
import { nextCompatEnabled } from '../../compat/aliases'
import {
  type ActionRef,
  type BuildStep,
  type BuildStepContext,
  type RequestInterceptor,
  type ServerActionPropContext,
} from '../../extensions'
import { getRequestRuntime, type RequestRuntime } from '../../routing/request-environment'
import { toPosixPath } from '../../utils/fs'
import type { ActionManifestEntry, BuildManifest, RouteManifestEntry } from '../../types'
import { devServerModuleHref } from '../../runtime/modules'
import { serverBundleTargetForRuntime } from '../../runtime/loader'
import {
  renderActionReturnElement,
  renderGlobalNotFoundResponse,
  renderNotFoundForRoute,
  renderPage,
  renderPageResponse,
} from '../../render/renderer'
import { routeParamsFromPath } from '../../routing/handler'
import { selectRouteForRequest } from '../../routing/routes'
import { discoverActions, registerDiscoveredActions } from './discovery'
import { clearActions, lookupActionSource, registerActionModule } from './registry'
import {
  canonical,
  canonicalActionId,
  clearClientActionModules,
  clientActionModuleFiles,
  clientActionModulesRoot,
  isClientActionModule,
  setClientActionModules,
} from './client-plugin'
import {
  isActionRequest,
  isProgressiveActionRequest,
  serveAction,
  type ServeActionOptions,
} from './serve'
import { NEXT_ACTION_NOT_FOUND_HEADER, PROP_ACTION_MARKER } from './protocol'
import { loadServerActionsConfig } from './config'
import { renderWithFormStateOverride } from './form-state'
import { loadCompatRewrites, type CompatRewrite, resolveCompatRewrite } from '../next/rewrites'
import { loadCompatRedirects, type CompatRedirect, resolveCompatRedirect } from '../next/redirects'
import { recordRewrite } from '../protocol'
import { activateTestProxy } from '../lifecycle/testmode'
import { canonicalUrlHref, recordCanonicalUrl } from '../next/canonical-url'
import {
  assignedInlineActionId,
  createInstanceScope,
  instanceActionRouteId,
  isInstanceActionId,
  isMarkedInlineAction,
  overriddenActionId,
  registerActionInstance,
  type InstanceScope,
} from './instances'
import { serverActionId, tagServerAction } from './server-tag'
import { opensWithUseServerDirective } from './detect'
import { inlineActionModuleKey, isInlineActionId } from './rewrite'
import { reportActionErrorToUser } from '../lifecycle/error-funnel'

// ---------------------------------------------------------------------------
// Build step: action discovery/bundling + server-reference manifest.
// ---------------------------------------------------------------------------

interface ActionStepState {
  actions: ActionManifestEntry[]
  actionSources?: string[]
  actionImporters?: string[]
  deferred?: Promise<void>
}

export const runActionBuildStep: BuildStep = async (ctx: BuildStepContext): Promise<void> => {
  const config = ctx.config
  const state = ctx.manifest as ActionStepState
  // Discovery is what arms the client stub set and names the action source
  // files, and it is the only part of this step the client stage waits on.
  const discovery = await (ctx.log
    ? ctx.log.step('action discovery', () => discoverActions(config))
    : discoverActions(config))
  state.actionSources = actionSourceKeys(config, discovery)
  state.actionImporters = [...discovery.actionImporters]
  // Compiling those modules to server bundles produces manifest entries nothing
  // upstream of the build manifest reads, so it is handed back to run under the
  // client stage instead of ahead of it.
  state.deferred = (async () => {
    const actions = await compileActionModules(config, discovery, ctx.log)
    // The step's `manifest` accumulator carries the actions array the core build
    // folds into the build manifest (manifest.actions) verbatim.
    state.actions = actions
    if (actions.length > 0) await writeServerReferenceManifest(config, actions)
  })()
}

/**
 * Discover 'use server' modules, compile each to a server bundle (compat
 * aliases + directive handling applied, like the proxy module), and produce the
 * action manifest start serves from. Also arms the client-bundle stub set so
 * client imports of these modules become the RPC stub during buildClientEntries.
 *
 * The wire id is computed from the SOURCE file path (config.root-relative), so
 * the client stub and the server registry agree; modulePath is the COMPILED
 * output the endpoint imports at request time.
 */
function actionSourceKeys(
  config: ResolvedConfig,
  discovery: Awaited<ReturnType<typeof discoverActions>>,
): string[] {
  clearActions()
  if (discovery.modules.length === 0) {
    setClientActionModules(config.root, [])
    return []
  }
  // Client bundling replaces these source imports with the stub.
  setClientActionModules(config.root, discovery.actionFiles)
  // Registered from the discovery facts alone (ids come from source paths), so
  // build-time lookupAction parity holds before the compile below finishes.
  registerDiscoveredActions(config, discovery)
  return discovery.modules.map(module => actionSourceKey(config, module.file))
}

/** The registry id's source key: canonical, root-relative, POSIX. */
function actionSourceKey(config: ResolvedConfig, file: string) {
  // Must reproduce the registry id at startup: registerManifestActions calls
  // actionId(sourceKey) with no root, so this has to equal
  // workspaceRelative(canonical(file), canonical(root)).
  return toPosixPath(path.relative(canonical(config.root), canonical(file)))
}

async function compileActionModules(
  config: ResolvedConfig,
  discovery: Awaited<ReturnType<typeof discoverActions>>,
  log?: BuildStepContext['log'],
): Promise<ActionManifestEntry[]> {
  if (discovery.modules.length === 0) return []

  const entries: ActionManifestEntry[] = []
  const compile = async () => {
    for (const module of discovery.modules) {
      // 'build', matching render/index.tsx's prod moduleHref: the endpoint and the
      // page render must import the SAME compiled file so a module imported in
      // both the render and action layers is one instance (shared module state).
      const href = await devServerModuleHref(config, module.file, 'build')
      const compiled = fileURLToPath(href)
      const modulePath = toPosixPath(path.relative(config.outPath, compiled))
      const sourceKey = actionSourceKey(config, module.file)
      for (const exportName of module.exports) {
        entries.push({ id: module.ids[exportName]!, sourceKey, modulePath, exportName })
      }
    }
  }
  if (log) await log.step(`action modules (${discovery.modules.length})`, compile)
  else await compile()
  return entries
}

// Next-compatible server-reference manifest (.next/server/): tools and Next's
// own e2e suite introspect it for the registered action ids and their source
// modules. pnext's real registry lives in .pnext/manifest.json; this mirror
// exists purely for ecosystem compatibility.
async function writeServerReferenceManifest(
  config: ResolvedConfig,
  actions: ActionManifestEntry[],
) {
  const node: Record<
    string,
    {
      workers: Record<string, unknown>
      layer: Record<string, unknown>
      filename: string
      exportedName: string
    }
  > = {}
  for (const action of actions) {
    node[action.id] = {
      workers: {},
      layer: {},
      filename: action.sourceKey,
      exportedName: action.exportName,
    }
  }
  const manifest = { node, edge: {}, encryptionKey: 'pnext' }
  const outDir = path.join(config.root, '.next', 'server')
  await mkdir(outDir, { recursive: true })
  await writeFile(
    path.join(outDir, 'server-reference-manifest.json'),
    JSON.stringify(manifest, null, 2),
  )
}

// Request interceptor: server-action dispatch. Actions POST to the page's own URL (id in the
// next-action header for JS clients, or a hidden form field for no-JS progressive submissions).
// Route-handler POSTs pass through even with an id header - actions only dispatch on page URLs, or on
// unmatched paths, which still get the action error semantics.

export const actionDispatchInterceptor: RequestInterceptor = async (request, ctx) => {
  const config = ctx.config
  if (!nextCompatEnabled(config)) return undefined
  const runtime = getRequestRuntime()
  if (!runtime) return undefined
  const url = new URL(request.url)
  const actionTarget = selectRouteForRequest(runtime.routes, url.pathname, undefined)
  // Route-handler POSTs pass through even with an id header — actions only
  // dispatch on page URLs (or unmatched paths, which still get the action
  // error semantics the unrecognized-action suite asserts).
  if (actionTarget && actionTarget.route.kind !== 'page') return undefined

  // A form-encoded POST to an existing page with no recognizable action id is still an MPA action attempt
  // in Next, which routes every page form POST through the action handler: with no action to run it
  // answers 404 action-not-found rather than rendering the page. Only applies to real page targets - a
  // POST to a nonexistent route stays a clean 404.
  const isFormPost = actionTarget?.route.kind === 'page' && isFormPostRequest(request)
  if (!(isActionRequest(request) || (await isProgressiveActionRequest(request)) || isFormPost)) {
    return undefined
  }

  await ensureActionsRegistered(runtime)

  const actionId = request.headers.get('next-action')
  if (
    actionId &&
    canonicalUrlHref() !== undefined &&
    isForwardedActionForRoute(config, actionTarget, actionId)
  ) {
    return new Response(`Server Action "${actionId}" was not found on the server.`, {
      status: 404,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        [NEXT_ACTION_NOT_FOUND_HEADER]: '1',
      },
    })
  }

  const maxBodyBytes = runtime.maxBodyBytes ?? (await resolveMaxBodyBytes(config))
  const options = buildServeActionOptions(runtime, request, actionTarget, maxBodyBytes)
  return serveAction(request, options)
}

// Strip the configured basePath from a redirect-target URL so it lines up with
// the app-relative route table. Same matching rule as start.ts stripBasePath;
// a target outside the basePath (a `basePath:false` rewrite destination) is
// returned unchanged so it simply fails to match a page (external redirect).
function stripActionBasePath(target: URL, basePath: string): URL {
  if (!basePath) return target
  const pathname = target.pathname
  if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) return target
  const stripped = new URL(target)
  stripped.pathname = pathname.slice(basePath.length) || '/'
  return stripped
}

// Rebuild the render request against the basePath-stripped URL, preserving the
// action's applied cookie/header state. Returns the original request untouched
// when no stripping happened.
function strippedRequest(request: Request, target: URL, stripped: URL): Request {
  if (stripped.href === target.href) return request
  return new Request(stripped.href, { headers: request.headers })
}

function isFormPostRequest(request: Request): boolean {
  if (request.method.toUpperCase() !== 'POST') return false
  if (request.headers.has('next-action')) return false
  const contentType = request.headers.get('content-type') ?? ''
  // Only multipart counts as an id-less MPA action attempt: React's progressive action forms always post
  // multipart/form-data, so a urlencoded POST without an action id is a plain form POST to the page - a
  // browser re-POSTing after a route handler's 307/308 redirect, say - and must render the page, not 404.
  // urlencoded POSTs that DO carry the hidden action id field are still dispatched.
  return contentType.includes('multipart/form-data')
}

// serverActions.bodySizeLimit from next.config, resolved once per project.
// Invalid values throw (Next's message) — surfaced on the first action request
// as a 500, matching the size-limit-invalid suite's expectation.
const bodyLimitCache = new Map<string, Promise<number | undefined>>()

function resolveMaxBodyBytes(config: ResolvedConfig): Promise<number | undefined> {
  const key = config.root
  let cached = bodyLimitCache.get(key)
  if (!cached) {
    cached = loadServerActionsConfig(config.root).then(c => c.bodySizeLimitBytes)
    bodyLimitCache.set(key, cached)
  }
  return cached
}

// Instance-recovery render dedup: the first dispatch against a prebuilt page
// re-renders the route to re-materialize its `i:` action closures
// (instances.ts); concurrent dispatches share that in-flight render instead of
// each starting a full one. Keyed route+pathname (dynamic routes recover per
// path), cleared on settle so evicted instances recover again.
const instanceRecoveries = new Map<string, Promise<void>>()

function dedupeInstanceRecovery(
  routeId: string,
  pathname: string,
  render: () => Promise<void>,
): Promise<void> {
  const key = `${routeId} ${pathname}`
  const inFlight = instanceRecoveries.get(key)
  if (inFlight) return inFlight
  const started = render().finally(() => instanceRecoveries.delete(key))
  instanceRecoveries.set(key, started)
  return started
}

/**
 * Reconstruct the ServeActionOptions the old start/dev handlers built inline,
 * from the published request runtime + core render/import helpers. Dev vs prod
 * only changes how modules resolve to hrefs.
 */
function buildServeActionOptions(
  runtime: RequestRuntime,
  request: Request,
  actionTarget: ReturnType<typeof selectRouteForRequest>,
  maxBodyBytes: number | undefined,
): ServeActionOptions {
  const config = runtime.config
  const dev = runtime.dev
  const version = runtime.devImportVersion ?? 'build'
  const url = new URL(request.url)
  const actionConditionTarget =
    actionTarget?.route.kind === 'page'
      ? serverBundleTargetForRuntime(actionTarget.route.segmentConfig?.runtime)
      : 'server'

  const importModule = dev
    ? async (modulePath: string) =>
        (await import(
          await devServerModuleHref(config, modulePath, version, {
            conditionTarget: actionConditionTarget,
          })
        )) as Record<string, unknown>
    : async (modulePath: string) =>
        (await import(pathToFileHref(path.resolve(config.outPath, modulePath)))) as Record<
          string,
          unknown
        >

  const options: ServeActionOptions = {
    ...(dev ? { dev: true } : {}),
    importModule,
    // skipNoindex: Next omits the fallback robots meta for an action-triggered
    // not-found (app-render's NonIndex), keeping the page's own robots value.
    renderNotFound: async notFoundRequest =>
      actionTarget?.route.kind === 'page'
        ? renderNotFoundForRoute(
            {
              config,
              route: actionTarget.route,
              params: actionTarget.params,
              url: new URL(notFoundRequest.url),
              // GET conversion: the page renderer refuses non-GET requests.
              request: new Request(notFoundRequest.url, { headers: notFoundRequest.headers }),
              ...(dev ? { dev: true, devImportVersion: version } : {}),
            },
            { skipNoindex: true },
          )
        : renderGlobalNotFoundResponse(
            {
              config,
              url: new URL(notFoundRequest.url),
              request: new Request(notFoundRequest.url, { headers: notFoundRequest.headers }),
              ...(dev ? { dev: true, devImportVersion: version } : {}),
            },
            { skipNoindex: true },
          ),
    renderPageForFormState: async (formRequest, state, actionId) => {
      if (actionTarget?.route.kind !== 'page') return null
      const formUrl = new URL(formRequest.url)
      return renderWithFormStateOverride(state, actionId, () =>
        renderPageResponse({
          config,
          route: actionTarget.route,
          params: actionTarget.params,
          url: formUrl,
          request: new Request(formRequest.url, { headers: formRequest.headers }),
          ...(dev ? { dev: true, devImportVersion: version } : {}),
        }),
      )
    },
    renderRedirectTarget: async (redirectRequest, target) => {
      // The redirect target arrives in basePath space (redirect() prefixes it);
      // strip the prefix so it matches the app-relative route table and the
      // rendered page's usePathname excludes the basePath, exactly like a
      // freshly-routed GET (which start.ts strips before matching).
      const stripped = stripActionBasePath(target, config.basePath)
      const targetMatch = selectRouteForRequest(runtime.routes, stripped.pathname, undefined)
      if (targetMatch?.route.kind !== 'page') return null
      return renderPageResponse({
        config,
        route: targetMatch.route,
        params: targetMatch.params,
        url: stripped,
        request: strippedRequest(redirectRequest, target, stripped),
        ...(dev ? { dev: true, devImportVersion: version } : {}),
      })
    },
    renderActionFlight: async (flightRequest, target) => {
      const stripped = stripActionBasePath(target, config.basePath)
      const targetMatch = selectRouteForRequest(runtime.routes, stripped.pathname, undefined)
      if (targetMatch?.route.kind !== 'page') return null
      return renderPageResponse({
        config,
        route: targetMatch.route,
        params: targetMatch.params,
        url: stripped,
        request: strippedRequest(flightRequest, target, stripped),
        ...(dev ? { dev: true, devImportVersion: version } : {}),
      })
    },
    importSourceModule: async moduleKey => {
      const absolute = path.resolve(config.root, moduleKey)
      await import(
        await devServerModuleHref(config, absolute, version, {
          conditionTarget: actionConditionTarget,
        })
      )
    },
    rerenderRoute: async routeId => {
      const route = runtime.routes.find(entry => entry.id === routeId && entry.kind === 'page')
      if (!route) throw new Error(`Unknown route for action re-render: ${routeId}`)
      await dedupeInstanceRecovery(routeId, url.pathname, () =>
        renderPage({
          config,
          route,
          params: routeParamsFromPath(route, url.pathname),
          url,
          request: new Request(request.url, { headers: request.headers }),
          ...(dev ? { dev: true, devImportVersion: version } : {}),
        }).then(() => undefined),
      )
    },
    isForwardedAction: id => isForwardedActionForRoute(config, actionTarget, id),
    onError: reportActionErrorToUser,
    ...(maxBodyBytes !== undefined ? { maxBodyBytes } : {}),
    // Element-returning actions server-render the returned tree through the same
    // machinery a page render uses (async server components, host elements),
    // producing the island wire HTML the action client revives. Scoped to page
    // targets — the only routes that own such actions.
    ...(actionTarget?.route.kind === 'page'
      ? {
          renderActionElement: (element: unknown) =>
            renderActionReturnElement(element, {
              config,
              route: actionTarget.route,
              params: actionTarget.params,
              url,
              request: new Request(request.url, { headers: request.headers }),
              ...(dev ? { dev: true, devImportVersion: version } : {}),
            }),
        }
      : {}),
  }
  return options
}

/**
 * Next "forwarded action" discrimination: the POSTed route's static source closure does not contain the
 * action's source module, meaning the client dispatched the action after navigating to a different page.
 * For live-instance actions the owning route is encoded in the id; for module and inline actions the
 * registered source file is checked against the route's sourceFiles closure, realpath-canonicalized since
 * the closure may hold /private-var vs /var aliases of the same file on macOS.
 */
function isForwardedActionForRoute(
  config: ResolvedConfig,
  actionTarget: ReturnType<typeof selectRouteForRequest>,
  id: string,
): boolean {
  const route = actionTarget?.route
  if (route?.kind !== 'page') return false
  if (isInstanceActionId(id)) {
    const owner = instanceActionRouteId(id)
    return Boolean(owner && owner !== route.id)
  }
  const source = isInlineActionId(id) ? inlineActionModuleKey(id) : lookupActionSource(id)
  if (!source) return false
  const sources = route.sourceFiles
  if (!sources?.length) return false
  const target = canonical(path.resolve(config.root, source))
  return !sources.some(file => canonical(file) === target)
}

// ---------------------------------------------------------------------------
// Action registry arming.
//
// prod: rebuild the registry from the built manifest once (id parity with the
//       client stub via the stored source key).
// dev:  re-run discovery whenever the dev import version changes (reload), so
//       the endpoint + client-stub set stay current without core importing us.
// ---------------------------------------------------------------------------

// Memoized on the in-flight PROMISE, not on a "started" flag: a page can fire several actions at once,
// and a flag set before the await lets the second POST through against a registry that is still empty, so
// it 404s as an unknown action. Every caller awaits the same registration. A failed one is dropped so the
// next request retries instead of inheriting the rejection forever. `UNREGISTERED` keys the initial (and
// post-failure) state so the memo itself is never optional.
const UNREGISTERED = Symbol('pnext.actions.unregistered')
const noRegistration = { key: UNREGISTERED, version: UNREGISTERED, done: Promise.resolve() }
let manifestRegistration: { key: string | symbol; done: Promise<void> } = noRegistration
let devRegistration: { version: string | symbol | undefined; done: Promise<void> } = noRegistration

export async function ensureActionsRegistered(runtime: RequestRuntime): Promise<void> {
  if (runtime.dev) {
    if (devRegistration.version !== runtime.devImportVersion) {
      const pending = { version: runtime.devImportVersion, done: Promise.resolve() }
      pending.done = refreshDevActions(runtime.config).catch((error: unknown) => {
        if (devRegistration === pending) devRegistration = noRegistration
        throw error
      })
      devRegistration = pending
    }
    await devRegistration.done
    return
  }
  const key = runtime.config.outPath
  if (manifestRegistration.key !== key) {
    const pending = { key, done: Promise.resolve() }
    pending.done = registerManifestActions(runtime.config).catch((error: unknown) => {
      if (manifestRegistration === pending) manifestRegistration = noRegistration
      throw error
    })
    manifestRegistration = pending
  }
  await manifestRegistration.done
}

// Rebuild the action registry from the built manifest so the endpoint can
// resolve an incoming id to its compiled module + export. Also restore the
// client-action module set (normally armed by the build): render-time form/prop
// tagging reads it to give module-level actions their stable wire ids.
async function registerManifestActions(config: ResolvedConfig): Promise<void> {
  const manifestPath = path.join(config.outPath, 'manifest.json')
  let manifest: BuildManifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as BuildManifest
  } catch {
    return
  }
  const files = new Set<string>()
  for (const action of manifest.actions ?? []) {
    registerActionModule(action.sourceKey, [action.exportName], {
      modulePath: action.modulePath,
    })
    files.add(path.resolve(config.root, action.sourceKey))
  }
  if (files.size > 0) setClientActionModules(config.root, files)
}

// Rescan the app for 'use server' modules and refresh both the endpoint
// registry (id -> module) and the client-bundle stub set. In dev the action's
// modulePath stays the source file: devServerModuleHref compiles it on demand
// when the endpoint imports it. Gated on compat.next inside discoverActions.
async function refreshDevActions(config: ResolvedConfig): Promise<void> {
  clearActions()
  clearClientActionModules()
  const discovery = await discoverActions(config)
  if (discovery.modules.length === 0) return
  registerDiscoveredActions(config, discovery)
  setClientActionModules(config.root, discovery.actionFiles)
}

// ---------------------------------------------------------------------------
// Request interceptor: next.config rewrites.
//
// Rewrites map the request pathname to its destination before static lookup and
// routing, so prebuilt output + revalidatePath marks work against the
// destination. The render keeps the requested URL canonical (usePathname); core
// preserves the original URL for rendering (see start/dev canonicalUrl).
// ---------------------------------------------------------------------------

const rewriteCache = new Map<string, Promise<CompatRewrite[]>>()

function loadRewritesFor(config: ResolvedConfig): Promise<CompatRewrite[]> {
  const key = config.root
  let cached = rewriteCache.get(key)
  if (!cached) {
    cached = loadCompatRewrites(config.root)
    rewriteCache.set(key, cached)
  }
  return cached
}

const redirectCache = new Map<string, Promise<CompatRedirect[]>>()

function loadRedirectsFor(config: ResolvedConfig): Promise<CompatRedirect[]> {
  const key = config.root
  let cached = redirectCache.get(key)
  if (!cached) {
    cached = loadCompatRedirects(config.root)
    redirectCache.set(key, cached)
  }
  return cached
}

export const redirectInterceptor: RequestInterceptor = async (request, ctx) => {
  const config = ctx.config
  if (!nextCompatEnabled(config)) return undefined
  // `basePath: false` entries match the raw path core would otherwise 404;
  // every other entry matches the in-app (basePath-stripped) path. The two
  // passes are disjoint.
  const redirects = (await loadRedirectsFor(config)).filter(
    redirect => redirect.outsideBasePath === Boolean(ctx.outsideBasePath),
  )
  if (redirects.length === 0) return undefined
  const url = new URL(request.url)
  const result = resolveCompatRedirect(redirects, url.pathname, {
    host: request.headers.get('host') ?? '',
    headers: request.headers,
    cookies: parseCookieHeader(request.headers.get('cookie')),
    query: url.searchParams,
  })
  if (!result) return undefined
  const location = new URL(result.location, url.href)
  // Next passes the incoming query through to the redirect destination (the
  // `_rsc` union query among it — rsc-query-routing relies on the followed
  // request keeping it). Destination-specified params win.
  for (const [key, value] of url.searchParams) {
    if (!location.searchParams.has(key)) location.searchParams.append(key, value)
  }
  return new Response(null, { status: result.status, headers: { location: location.href } })
}

export const rewriteInterceptor: RequestInterceptor = async (request, ctx) => {
  const config = ctx.config
  if (!nextCompatEnabled(config)) return undefined
  // See redirectInterceptor: `basePath: false` rules own the outside-basePath
  // pass, the rest own the in-app one.
  const rewrites = (await loadRewritesFor(config)).filter(
    rewrite => rewrite.outsideBasePath === Boolean(ctx.outsideBasePath),
  )
  if (rewrites.length === 0) return undefined
  const url = new URL(request.url)
  const context = {
    host: request.headers.get('host') ?? '',
    headers: request.headers,
    cookies: parseCookieHeader(request.headers.get('cookie')),
    query: url.searchParams,
  }
  // beforeFiles/afterFiles (and the array form) apply ahead of routing; a
  // `fallback` rewrite only gets a turn once nothing else can serve the path.
  let result = resolveCompatRewrite(
    rewrites.filter(rewrite => !rewrite.fallback),
    url.pathname,
    context,
  )
  if (!result && requestWouldMiss(config, url.pathname)) {
    result = resolveCompatRewrite(
      rewrites.filter(rewrite => rewrite.fallback),
      url.pathname,
      context,
    )
  }
  if (!result) return undefined
  if (result.destination) {
    activateTestProxy(request.headers)
    // The incoming `host` (and its forwarded twins) name THIS server; carrying
    // them onto an outbound request makes the TLS handshake disagree with the
    // destination's certificate. Let fetch derive them from the destination URL.
    const headers = new Headers(request.headers)
    for (const header of ['host', 'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-proto']) {
      headers.delete(header)
    }
    const rewrittenRequest = new Request(result.destination, {
      method: request.method,
      headers,
      ...(request.body ? { body: request.body, duplex: 'half' } : {}),
    })
    return fetch(rewrittenRequest)
  }
  const rewritten = new URL(url.href)
  rewritten.pathname = result.pathname
  rewritten.search = result.search.toString()
  recordCanonicalUrl(url)
  recordRewrite(url, rewritten)
  return { request: new Request(rewritten, request) }
}

/**
 * Whether a request for `pathname` would 404 - the gate Next's `fallback` rewrites sit behind. A path is
 * servable when the route table matches it or a built/public file backs it; `/_next/*` assets are always
 * served by core. Divergence: dev has no built output, so only the route table is consulted.
 */
function requestWouldMiss(config: ResolvedConfig, pathname: string): boolean {
  if (pathname.startsWith('/_next/')) return false
  const runtime = getRequestRuntime()
  if (runtime && selectRouteForRequest(runtime.routes, pathname)) return false
  return !servableFile(config, pathname)
}

function servableFile(config: ResolvedConfig, pathname: string): boolean {
  const publicRoot = path.join(config.outPath, 'public')
  const trimmed = pathname.replace(/^\/+|\/+$/g, '')
  const file = trimmed ? path.join(publicRoot, trimmed) : publicRoot
  // Never let a traversal-shaped path claim to be servable (it is not).
  const relative = path.relative(publicRoot, file)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false
  return (
    existsSync(path.join(file, 'index.html')) ||
    (trimmed !== '' && (existsSync(file) || existsSync(`${file}.html`)))
  )
}

function parseCookieHeader(header: string | null): Record<string, string> {
  if (!header) return {}
  const cookies: Record<string, string> = {}
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim()
  }
  return cookies
}

// ---------------------------------------------------------------------------
// Render extension: serialize a server-action function crossing the
// server->client boundary into the { [PROP_ACTION_MARKER]: id } marker.
//
// Id policy (Next-compatible), highest priority first:
//   1. caller-overridden $$id (version-skew simulation)
//   2. compile-tagged module-scope inline action ($$pnextAssignedId, 'if:')
//   3. tagged module-level 'use server' export (stable module id)
//   4. inline / .bind() / HOC closures -> a live per-render instance ('i:')
//
// Per-render instance scopes are keyed on the opaque renderKey (core's
// RenderOptions) so occurrence indices stay consistent within one render.
// ---------------------------------------------------------------------------

const instanceScopes = new WeakMap<object, InstanceScope>()

export function serializeServerActionProp(
  value: unknown,
  context: ServerActionPropContext,
): ActionRef | undefined {
  if (typeof value !== 'function') return undefined
  if (!nextCompatEnabled(context.config)) return undefined

  const overridden = overriddenActionId(value)
  if (overridden) return { [PROP_ACTION_MARKER]: overridden }

  const assigned = assignedInlineActionId(value)
  if (assigned) return { [PROP_ACTION_MARKER]: assigned }

  const moduleId = serverActionId(value)
  if (moduleId) return { [PROP_ACTION_MARKER]: moduleId }

  if (
    context.identifiedOnly &&
    !isMarkedInlineAction(value) &&
    !opensWithUseServerDirective(value)
  ) {
    return undefined
  }

  const scope = instanceScopeFor(context.renderKey)
  const id = registerActionInstance(scope, value)
  return { [PROP_ACTION_MARKER]: id }
}

/** Tag each function export of a discovered action module with its wire id. */
export function tagActionModuleExports(
  config: ResolvedConfig,
  file: string,
  module: Record<string, unknown>,
): void {
  if (!nextCompatEnabled(config) || !isClientActionModule(file)) return
  const root = clientActionModulesRoot() ?? config.root
  for (const [exportName, value] of Object.entries(module)) {
    if (typeof value === 'function') {
      tagServerAction(value, canonicalActionId(file, exportName, root))
    }
  }
}

/** Import + tag every discovered action module ahead of a page render. */
export async function tagActionModulesForRender(
  config: ResolvedConfig,
  importModule: (file: string) => Promise<Record<string, unknown>>,
): Promise<void> {
  if (!nextCompatEnabled(config)) return
  for (const file of clientActionModuleFiles()) {
    try {
      tagActionModuleExports(config, file, await importModule(file))
    } catch {
      // Best-effort: an action module that fails to import here still POSTs via
      // the client stub when JS runs; the form just renders without the hidden id.
    }
  }
}

function instanceScopeFor(renderKey: object): InstanceScope {
  let scope = instanceScopes.get(renderKey)
  if (!scope) {
    const routeId = (renderKey as { route?: RouteManifestEntry }).route?.id ?? 'unknown'
    scope = createInstanceScope(routeId)
    instanceScopes.set(renderKey, scope)
  }
  return scope
}
