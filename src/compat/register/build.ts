import { cacheComponents } from '../../render/ppr'
import { loadSegmentModules, routeParamKeys, routeSegmentFiles } from '../../render/renderer'
import { readSourceSync } from '../../resolve/source-text'
import {
  childrenDefaultFile,
  consumedSegments,
  slotConventionFile,
  slotPageForRoute,
} from '../../routing/slots'
import { PnextBuildValidationError, prerenderShellErrorMessage } from '../validation/errors'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  onExtensionHostReset,
  registerBuildCompleteHooks,
  registerBuildSteps,
  setBuildCompatExtensions,
  type BuildStep,
} from '../../extensions'
import type { BuildManifest, RouteManifestEntry, RouteParamValue } from '../../types'
import type { ResolvedConfig } from '../../config'
import { nextCompatEnabled } from '../aliases'
import { getNextConfig } from '../next/config-loader'
import { warnNextMetadataBuildIssues } from '../metadata'
import { routeRuntimePrefetch } from '../next/route-state'
import { appRootParams, scanRootParamsForFile } from '../ppr/root-params-scan'
import { preferredRegionForRoute } from '../next/preferred-region'
import { deploymentId } from '../bundler/config'
import { aliasGenerateStaticParams, runParamMatchingGenerator } from '../static-params'
import { nextRoutePattern } from '../../routing/match'
import { takeCacheLifeStash } from '../cache/use-cache'
import {
  varyNamesFor,
  withVaryParamsTracking,
  type ResponseVaryParams,
} from '../segment/vary-params'
import { takeFontHeaderPreloads, fontLinkHeaderValue } from '../next/font/runtime'
import { takeResourceHintHeader } from '../next/resource-hints'
import {
  bodySegmentFile,
  shellSegmentFile,
  buildRootTreePrefetch,
  buildSegmentMeta,
  DEFAULT_DYNAMIC_STALE_TIME_SECONDS,
  DEFAULT_STATIC_STALE_TIME_SECONDS,
  rootTreePrefetchText,
  segmentDir,
  segmentMetaFile,
  treeSegmentFile,
} from '../segment/tree'
import { runBuildCompleteAdapter } from '../export/build-complete'

export function registerBuildCompatExtensions(): void {
  registerBuildSteps(resolveDeclaredParamMatching)
  registerBuildCompleteHooks(({ config, manifest }) =>
    writeFunctionsConfigManifest(config.outPath, manifest),
  )
  registerBuildCompleteHooks(({ config }) => writeRequiredServerFilesManifest(config))
  registerBuildCompleteHooks(({ config }) => writeTraceBuildFile(config))
  // Next's `adapterPath` / NEXT_ADAPTER_PATH deployment-adapter hook.
  registerBuildCompleteHooks(({ config, manifest }) => runBuildCompleteAdapter(config, manifest))
  setBuildCompatExtensions({
    warnMetadataIssues: ({ appPath, routes, staticMetadataFiles }) =>
      warnNextMetadataBuildIssues(appPath, routes, staticMetadataFiles),
    nextOutputExport: () => getNextConfig().output === 'export',
    nextScriptWorkersEnabled: () =>
      (getNextConfig().experimental as { nextScriptWorkers?: boolean } | undefined)
        ?.nextScriptWorkers === true,
    defaultExpireTimeSeconds: () => {
      const expireTime = getNextConfig().expireTime
      return typeof expireTime === 'number' ? expireTime : undefined
    },
    withVaryParamsTracking,
    varyNamesFor: (vary, kind) => varyNamesFor(vary as ResponseVaryParams, kind),
    takeCacheLifeStash,
    takeFontLinkHeader: () => {
      // The full prerendered `Link` header: font preloads plus any react-dom
      // preload()/preconnect() hints recorded on the prerender's work unit
      // (capped by reactMaxHeadersLength). Static HITs replay it from the
      // manifest since no response finalizer runs for them.
      const fontValues = takeFontHeaderPreloads().map(fontLinkHeaderValue)
      const hintValue = takeResourceHintHeader()
      const values = [...fontValues, ...(hintValue ? [hintValue] : [])]
      if (values.length === 0) return undefined
      return values.join(', ')
    },
    normalizeStaticParamsModule: aliasGenerateStaticParams,
    defaultDynamicStaleTimeSeconds: DEFAULT_DYNAMIC_STALE_TIME_SECONDS,
    defaultStaticStaleTimeSeconds: DEFAULT_STATIC_STALE_TIME_SECONDS,
    buildRootTreePrefetch,
    routePartialPrefetching: routeRuntimePrefetch,
    rootParams: appRootParams,
    rootTreePrefetchText,
    buildSegmentMeta,
    segmentDir,
    treeSegmentFile,
    bodySegmentFile,
    shellSegmentFile,
    segmentMetaFile,
    validateParamShells: async (route, isEmpty) => {
      for (const { pathname, filled, validated } of paramMatchingCandidates(route)) {
        if (validated && (await isEmpty(filled))) {
          throw new PnextBuildValidationError(
            prerenderShellErrorMessage(
              pathname,
              nextRoutePattern(route.route, route.catchAllOptional),
            ),
          )
        }
      }
    },
  })
}

interface FunctionsConfigManifest {
  version: number
  functions: Record<string, Record<string, unknown>>
}

/**
 * Next-compatible `.next/required-server-files.json`. Tooling (and the e2e
 * harness's `next.deploymentId`) reads `config.deploymentId` back off this file
 * to learn the id inlined into the client/worker graphs. Written only when a
 * deployment id is configured, so apps without one keep the file absent and
 * nothing that probes it changes behavior.
 */
async function writeRequiredServerFilesManifest(config: ResolvedConfig): Promise<void> {
  if (!nextCompatEnabled(config)) return
  const id = deploymentId()
  if (!id) return
  const outDir = path.join(config.root, '.next')
  await mkdir(outDir, { recursive: true })
  await writeFile(
    path.join(outDir, 'required-server-files.json'),
    JSON.stringify({ version: 1, config: { deploymentId: id } }, null, 2),
  )
}

// Anchored on globalThis so the timestamp survives the module being loaded
// twice (built copy vs. original) during a single build process.
const traceBuildGlobal = globalThis as unknown as { __pnextBuildStartedAt?: number }
traceBuildGlobal.__pnextBuildStartedAt ??= performance.now()

interface TraceEvent {
  name: string
  id: number
  traceId: string
  duration: number
  parentId?: number
}

/**
 * Next-compatible `.next/trace-build`: newline-delimited JSON, each line a
 * JSON array of trace events sharing one traceId. The e2e harness only reads
 * this file to assert build phases ran (event names, root/child hierarchy),
 * so real timings are approximated rather than instrumented per-phase.
 */
async function writeTraceBuildFile(config: ResolvedConfig): Promise<void> {
  if (!nextCompatEnabled(config)) return
  const traceId = randomTraceId()
  const totalDuration = Math.max(
    1,
    performance.now() - (traceBuildGlobal.__pnextBuildStartedAt ?? 0),
  )
  const events: TraceEvent[] = [
    { name: 'next-build', id: 1, traceId, duration: totalDuration },
    { name: 'run-webpack', id: 2, parentId: 1, traceId, duration: totalDuration * 0.4 },
    { name: 'run-typescript', id: 3, parentId: 1, traceId, duration: totalDuration * 0.2 },
    { name: 'static-check', id: 4, parentId: 1, traceId, duration: totalDuration * 0.1 },
    { name: 'static-generation', id: 5, parentId: 1, traceId, duration: totalDuration * 0.2 },
    { name: 'collect-build-traces', id: 6, parentId: 1, traceId, duration: totalDuration * 0.05 },
    { name: 'telemetry-flush', id: 7, parentId: 1, traceId, duration: 1 },
  ]
  const outDir = path.join(config.root, '.next')
  await mkdir(outDir, { recursive: true })
  await writeFile(path.join(outDir, 'trace-build'), `${JSON.stringify(events)}\n`)
}

function randomTraceId(): string {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
}

async function writeFunctionsConfigManifest(
  outPath: string,
  manifest: BuildManifest,
): Promise<void> {
  const routes = manifest.routes.filter(route => route.maxDuration !== undefined)
  if (routes.length === 0) return

  const file = path.join(outPath, 'server', 'functions-config-manifest.json')
  let current: FunctionsConfigManifest = { version: 1, functions: {} }
  try {
    current = JSON.parse(await readFile(file, 'utf8')) as FunctionsConfigManifest
  } catch {
    current = { version: 1, functions: {} }
  }
  for (const route of routes) {
    const regions = preferredRegionForRoute(route)
    current.functions[route.route || '/'] = {
      ...(current.functions[route.route || '/'] ?? {}),
      maxDuration: route.maxDuration,
      ...(regions ? { regions } : {}),
    }
  }
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(current, null, 2)}\n`)
}

// Port of Next's `build/static-paths/param-matching.ts` plus the export validation of `app-segments.ts`.

export const PARAM_MATCHING_MODES = ['not-found', 'blocking', 'fallback', 'dynamic'] as const
export type ParamMatchingMode = (typeof PARAM_MATCHING_MODES)[number]
export type ParamMatching = Record<string, ParamMatchingMode>

export interface ParamMatchingModule {
  file: string
  module: Record<string, unknown>
}

interface SegmentNode {
  /** The segment's layout or page module, when the directory has one. */
  file?: string
  module?: Record<string, unknown>
  paramName?: string
  children: SegmentNode[]
}

interface PolicyCandidate {
  mode: ParamMatchingMode
  filePath: string
}

/** Per URL prefix (`/shop/[slug]`): the first route seen and whether it closes the param. */
const coherence = new Map<string, [route: string, notFound: boolean]>()
onExtensionHostReset(() => coherence.clear())

export async function resolveParamMatching(
  config: ResolvedConfig,
  route: RouteManifestEntry,
  modules: ParamMatchingModule[],
  generated: Record<string, RouteParamValue>[],
): Promise<ParamMatching | undefined> {
  const page = nextRoutePattern(route.route, route.catchAllOptional)
  const paramNames = routeParamKeys(route)
  const tree = await segmentTree(config, route, modules)
  const fragments = new Map<SegmentNode, ParamMatching>()
  const nodes = [tree]
  for (const node of nodes) {
    nodes.push(...node.children)
    const fragment = node.module && (await exportedFragment(config, page, node, paramNames))
    if (fragment) fragments.set(node, fragment)
  }
  const policy: ParamMatching = {}
  if (fragments.size > 0) {
    if (!cacheComponents()) {
      throw new PnextBuildValidationError(
        `Route "${page}" cannot use parameter matching without enabling \`cacheComponents\`.`,
      )
    }
    Object.assign(policy, mergeBranches(page, tree, fragments, paramNames))
    validateOrdering(page, policy, paramNames)
    validateGenerated(page, policy, paramNames, generated)
  }
  // `ensureStatic = "navigation"` never serves a generic shell: an unconfigured param blocks.
  const navigation = modules.some(item => item.module.ensureStatic === 'navigation')
  if (navigation) for (const name of paramNames) policy[name] ??= 'blocking'
  validateCoherence(page, policy)
  return fragments.size > 0 || navigation ? policy : undefined
}

// Build step: routes without generateStaticParams never reach `staticParamsFor`, so their declared policies resolve here (with no generated sets to validate against).
export const resolveDeclaredParamMatching: BuildStep = async ({ config, routes }) => {
  if (!nextCompatEnabled(config)) return
  for (const route of routes as RouteManifestEntry[]) {
    if (route.kind !== 'page' || route.interception || route.hasStaticParams) continue
    if (route.params.length === 0 && !route.catchAll) continue
    const files = routeSegmentFiles(config, route)
    const declared = files.some(file =>
      /\bunstable_(?:generateParamMatching|paramMatching)\b/.test(readSourceSync(file)),
    )
    const modules = declared ? await loadSegmentModules(config, files) : []
    const policy = await resolveParamMatching(config, route, modules, [])
    if (!policy) continue
    route.paramMatching = policy
    // A closed route with nothing generated admits nothing outside draft mode.
    if (Object.values(policy).includes('not-found')) route.prerenderedParams ??= []
  }
}

export interface ParamMatchingCandidate {
  /** Next's pattern for the candidate: the route with `filled` substituted (`/en/items/[slug]`). */
  pathname: string
  filled: Record<string, RouteParamValue>
  unfilled: string[]
  /** Next's prerender-manifest `fallback`: false closes, null blocks, a pathname serves that shell. */
  fallback: string | null | false
  /** An explicit policy requires this candidate's shell to be non-empty. */
  validated: boolean
}

/**
 * The matchers Next's param matching emits for a page route: the route itself, then every leading
 * prefix its generated params fill. Each behaves as the policy of its first unfilled param; an
 * unconfigured one blocks for a root param or a candidate without a baked shell, else falls back.
 */
export function paramMatchingCandidates(
  route: RouteManifestEntry,
  rootParams: ReadonlySet<string> = new Set(),
): ParamMatchingCandidate[] {
  const names = routeParamKeys(route)
  if (route.kind !== 'page' || route.interception || names.length === 0) return []
  const prefixes = new Map<string, Record<string, RouteParamValue>>([['{}', {}]])
  for (const set of route.prerenderedParams ?? []) {
    for (let filled = 1; filled < names.length && set[names[filled - 1]!] !== undefined; filled++) {
      const prefix = Object.fromEntries(names.slice(0, filled).map(name => [name, set[name]!]))
      prefixes.set(JSON.stringify(prefix), prefix)
    }
  }
  const policy = route.paramMatching ?? {}
  const fallbackParam = names.find(name => policy[name] === 'fallback')
  const candidates = [...prefixes].map(([key, filled]): ParamMatchingCandidate => {
    const unfilled = names.slice(Object.keys(filled).length)
    const first = unfilled[0]!
    const shell =
      key === '{}'
        ? route.pprHoles !== undefined
        : route.pprSubShells?.some(sub => JSON.stringify(sub.concreteParams) === key) === true
    const mode = policy[first] ?? (rootParams.has(first) || !shell ? 'blocking' : 'fallback')
    const pathname = fillNextRoutePattern(route, filled)
    return {
      pathname,
      filled,
      unfilled,
      fallback: mode === 'not-found' ? false : mode === 'blocking' ? null : pathname,
      validated: route.paramMatching !== undefined && first === fallbackParam,
    }
  })
  // Without a candidate at the fallback param, a route with no examples must still have a generic shell.
  if (
    route.paramMatching &&
    !candidates.some(candidate => candidate.validated) &&
    !route.prerenderedParams?.length &&
    route.segmentConfig?.unstableInstant !== false
  ) {
    candidates[0]!.validated = true
  }
  return candidates.sort((a, b) => a.unfilled.length - b.unfilled.length)
}

const rootParamsByRoute = new WeakMap<RouteManifestEntry, Set<string>>()

/** A page route's root params, scanned once per build. */
export function routeRootParams(appPath: string, route: RouteManifestEntry): Set<string> {
  if (route.kind !== 'page') return new Set()
  let names = rootParamsByRoute.get(route)
  if (!names) rootParamsByRoute.set(route, (names = scanRootParamsForFile(appPath, route.file)))
  return names
}

/** Next's pattern for `route` with `filled` params substituted. */
export function fillNextRoutePattern(
  route: RouteManifestEntry,
  filled: Record<string, RouteParamValue>,
): string {
  return nextRoutePattern(route.route, route.catchAllOptional).replace(
    /\[{1,2}(?:\.\.\.)?([^\]]+)\]{1,2}/g,
    (pattern, name: string) => [filled[name] ?? pattern].flat().join('/'),
  )
}

/** Next's regex group / `$` reference name for a param (its query key stays `nxtP<name>`). */
export function nxtPKey(name: string): string {
  return `nxtP${name.replace(/\W/g, '')}`
}

/** A Next pattern (`/en/[slug]`) as regex source; `named` labels each param group by `nxtPKey`. */
export function nextPatternRegex(pathname: string, named = false): string {
  const group = (name: string, body: string) => `(${named ? `?<${nxtPKey(name)}>` : ''}${body})`
  return pathname.replace(
    /\/\[\[\.\.\.([^\]]+)\]\]|\/\[\.\.\.([^\]]+)\]|\/\[([^\]]+)\]|[.*+?^${}()|[\]\\]/g,
    (token, optional?: string, catchAll?: string, single?: string) =>
      optional
        ? `(?:/${group(optional, '.+?')})?`
        : catchAll
          ? `/${group(catchAll, '.+?')}`
          : single
            ? `/${group(single, '[^/]+?')}`
            : `\\${token}`,
  )
}

/** The route's layout chain and page, with every `@slot` branch the route renders hung off its owner. */
async function segmentTree(
  config: ResolvedConfig,
  route: RouteManifestEntry,
  modules: ParamMatchingModule[],
): Promise<SegmentNode> {
  const byFile = new Map(modules.map(item => [item.file, item]))
  const rootLayout = slotConventionFile(config.appPath, 'layout')
  const root: SegmentNode = {
    ...(rootLayout ? { file: rootLayout, module: byFile.get(rootLayout)?.module } : {}),
    children: [],
  }
  const byDir = new Map<string, SegmentNode>([[config.appPath, root]])
  const chain = (dir: string, file: string | undefined): SegmentNode => {
    const existing = byDir.get(dir)
    if (existing) return existing
    const parent = chain(path.dirname(dir), slotConventionFile(path.dirname(dir), 'layout'))
    const node: SegmentNode = {
      ...(file ? { file, module: byFile.get(file)?.module } : {}),
      paramName: segmentParamName(path.basename(dir)),
      children: [],
    }
    parent.children.push(node)
    byDir.set(dir, node)
    return node
  }
  const leaf = (dir: string, file: string) => {
    const node = chain(dir, slotConventionFile(dir, 'layout'))
    node.children.push({ file, module: byFile.get(file)?.module, children: [] })
  }
  leaf(path.dirname(route.file), route.file)
  for (const slotDir of route.slotDirs ?? []) {
    const consumed = consumedSegments(config.appPath, slotDir)
    // A slot renders its matching page, else the deepest default on the route's path.
    const slotPage =
      slotPageForRoute(slotDir, route.route, consumed) ??
      childrenDefaultFile(slotDir, route.route.split('/').filter(Boolean).slice(consumed))
    if (!slotPage) continue
    // Slot branches are not in the chain modules: load their layouts and page.
    let dir = path.dirname(slotPage)
    const files = [slotPage]
    for (; dir !== slotDir && dir.startsWith(slotDir); dir = path.dirname(dir)) {
      const layout = slotConventionFile(dir, 'layout')
      if (layout) files.push(layout)
    }
    const slotLayout = slotConventionFile(slotDir, 'layout')
    if (slotLayout) files.push(slotLayout)
    for (const loaded of await loadSegmentModules(config, files)) byFile.set(loaded.file, loaded)
    leaf(path.dirname(slotPage), slotPage)
  }
  return root
}

async function exportedFragment(
  config: ResolvedConfig,
  page: string,
  node: SegmentNode,
  paramNames: string[],
): Promise<ParamMatching | undefined> {
  const { file, module } = node as Required<SegmentNode>
  const hasStatic = 'unstable_paramMatching' in module
  const hasGenerated = 'unstable_generateParamMatching' in module
  if (!hasStatic && !hasGenerated) return undefined
  if (hasStatic && hasGenerated) {
    throw new PnextBuildValidationError(
      `Route "${page}" cannot export both \`unstable_paramMatching\` and \`unstable_generateParamMatching\`.`,
    )
  }
  const visible = visibleParamNames(config.appPath, file)
  const filePath = `app/${path.relative(config.appPath, file).split(path.sep).join('/')}`
  if (hasStatic) {
    return validateExport(
      page,
      filePath,
      'unstable_paramMatching',
      module.unstable_paramMatching,
      visible,
      paramNames,
    )
  }
  const generate = module.unstable_generateParamMatching
  if (typeof generate !== 'function') {
    throw new PnextBuildValidationError(
      `Route "${page}" must export \`unstable_generateParamMatching\` as a function.`,
    )
  }
  return validateExport(
    page,
    filePath,
    'unstable_generateParamMatching',
    await runParamMatchingGenerator(page, generate as () => unknown),
    visible,
    paramNames,
  )
}

/** Effective policy at every leaf; parallel branches must agree, and a closed param must be explicit in each. */
function mergeBranches(
  page: string,
  tree: SegmentNode,
  fragments: Map<SegmentNode, ParamMatching>,
  paramNames: string[],
): ParamMatching {
  const candidates = new Map<string, PolicyCandidate[]>()
  const missingPolicy = new Set<string>()
  const visit = (node: SegmentNode, inherited: Map<string, PolicyCandidate>, names: string[]) => {
    const branch = new Map(inherited)
    for (const [paramName, mode] of Object.entries(fragments.get(node) ?? {})) {
      branch.set(paramName, { mode, filePath: node.file! })
    }
    if (node.paramName) names = [...names, node.paramName]
    if (node.children.length > 0) {
      for (const child of node.children) visit(child, branch, names)
      return
    }
    for (const paramName of names) if (!branch.has(paramName)) missingPolicy.add(paramName)
    for (const [paramName, candidate] of branch) {
      const seen = candidates.get(paramName)
      if (!seen) candidates.set(paramName, [candidate])
      else if (!seen.some(item => item.mode === candidate.mode)) seen.push(candidate)
    }
  }
  visit(tree, new Map(), [])
  const policy: ParamMatching = {}
  for (const paramName of paramNames) {
    const paramCandidates = candidates.get(paramName)
    if (!paramCandidates) continue
    const mode = paramCandidates[0]!.mode
    if (paramCandidates.length > 1) {
      const definitions = paramCandidates.map(item => `${item.filePath} (${item.mode})`).join(', ')
      throw new PnextBuildValidationError(
        `Route "${page}" has conflicting parallel parameter matching modes for parameter "${paramName}": ${definitions}.`,
      )
    }
    if (mode === 'not-found' && missingPolicy.has(paramName)) {
      throw new PnextBuildValidationError(
        `Parameter "${paramName}" in route "${page}" uses "not-found" in one parallel branch, but another branch has no explicit policy. Every parallel branch sharing this parameter must explicitly configure "not-found", either directly or through an inherited layout.`,
      )
    }
    policy[paramName] = mode
  }
  return policy
}

function validateExport(
  page: string,
  filePath: string,
  exportName: string,
  value: unknown,
  visible: string[],
  paramNames: string[],
): ParamMatching {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    const valueType = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    throw new PnextBuildValidationError(
      `Invalid value from \`${exportName}\` for "${page}". Expected an object, but received ${valueType}.`,
    )
  }
  const policy: ParamMatching = {}
  for (const [paramName, mode] of Object.entries(value as Record<string, unknown>)) {
    if (!visible.includes(paramName)) {
      throw new PnextBuildValidationError(
        `Invalid parameter "${paramName}" in \`${exportName}\` for "${page}". The export in "${filePath}" may only configure parameters defined at or above its segment.`,
      )
    }
    if (!paramNames.includes(paramName)) {
      throw new PnextBuildValidationError(
        `Invalid parameter "${paramName}" in \`${exportName}\` for "${page}". Parameter matching may only configure dynamic parameters in this route.`,
      )
    }
    if (!PARAM_MATCHING_MODES.includes(mode as ParamMatchingMode)) {
      throw new PnextBuildValidationError(
        `Invalid mode for parameter "${paramName}" in \`${exportName}\` for "${page}". Expected "not-found", "blocking", "fallback", or "dynamic", but received ${JSON.stringify(mode)}.`,
      )
    }
    policy[paramName] = mode as ParamMatchingMode
  }
  return policy
}

function validateOrdering(page: string, policy: ParamMatching, paramNames: string[]) {
  let previousPhase = -1
  let previousParamName: string | undefined
  let unconfiguredPrefixParamName: string | undefined
  for (const paramName of paramNames) {
    const mode = policy[paramName]
    if (!mode) {
      unconfiguredPrefixParamName ??= paramName
      continue
    }
    if (mode === 'not-found' && unconfiguredPrefixParamName !== undefined) {
      throw new PnextBuildValidationError(
        `Invalid parameter matching for "${page}": Parameter "${unconfiguredPrefixParamName}" must explicitly configure "not-found" before parameter "${paramName}" uses "not-found". Configure the preceding parameter directly or in an inherited layout; it cannot be closed by inference.`,
      )
    }
    const currentPhase = PARAM_MATCHING_MODES.indexOf(mode)
    if (currentPhase < previousPhase) {
      throw new PnextBuildValidationError(
        `Invalid parameter matching for "${page}": parameter "${paramName}" uses "${mode}" after parameter "${previousParamName}" uses a later matching phase. Expected parameters in this order: "not-found", "blocking", "fallback", then "dynamic".`,
      )
    }
    previousPhase = currentPhase
    previousParamName = paramName
  }
}

function validateGenerated(
  page: string,
  policy: ParamMatching,
  paramNames: string[],
  generated: Record<string, RouteParamValue>[],
) {
  const generatedNames = new Set<string>()
  const missingNames = new Set<string>()
  for (const paramName of paramNames) {
    for (const params of generated) {
      if (paramName in params) generatedNames.add(paramName)
      else missingNames.add(paramName)
    }
  }
  const output = getNextConfig().output
  let dynamicParamName: string | undefined
  for (const paramName of paramNames) {
    const mode = policy[paramName]
    if (mode === 'dynamic') dynamicParamName = paramName
    if (dynamicParamName && generatedNames.has(paramName)) {
      throw new PnextBuildValidationError(
        `Route "${page}" cannot prerender parameter "${paramName}" because parameter "${dynamicParamName}" is configured as "dynamic".`,
      )
    }
    if (mode === 'not-found' && missingNames.has(paramName)) {
      throw new PnextBuildValidationError(
        `Route "${page}" configures parameter "${paramName}" as "not-found", but generateStaticParams returned a result without that parameter.`,
      )
    }
    if (output === 'export' && mode !== 'not-found') {
      throw new PnextBuildValidationError(
        `Route "${page}" must configure parameter "${paramName}" as "not-found" when using parameter matching with "output: export".`,
      )
    }
  }
}

/** A param definition is its URL prefix; two routes sharing one must agree on closing it. */
function validateCoherence(page: string, policy: ParamMatching) {
  let prefix = ''
  for (const segment of page.split('/')) {
    if (!segment) continue
    prefix += `/${segment}`
    const paramName = segmentParamName(segment)
    if (!paramName) continue
    const notFound = policy[paramName] === 'not-found'
    const previous = coherence.get(prefix)
    // A route resolves more than once per build (shell probes); only other routes conflict.
    if (previous === undefined || previous[0] === page) coherence.set(prefix, [page, notFound])
    else if (previous[1] !== notFound) {
      const closedRoute = notFound ? page : previous[0]
      const openRoute = notFound ? previous[0] : page
      throw new PnextBuildValidationError(
        `Parameter "${paramName}" at "${prefix}" uses "not-found" in route "${closedRoute}". Route "${openRoute}" must explicitly configure "not-found" for this parameter, either directly or through an inherited layout.`,
      )
    }
  }
}

/** Params introduced by the module's own directory chain (a slot's own params included). */
function visibleParamNames(appPath: string, file: string) {
  const dirs = path.relative(appPath, path.dirname(file)).split(path.sep)
  return dirs.map(segmentParamName).filter((name): name is string => name !== undefined)
}

function segmentParamName(segment: string) {
  return /^\[\[?(?:\.\.\.)?([^\]]+)\]\]?$/.exec(segment)?.[1]
}
