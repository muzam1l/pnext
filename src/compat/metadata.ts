import type { Metadata, MetadataOpenGraph, PageProps, RouteManifestEntry, Viewport } from '../types'
import { staticMetadataForPathFromFiles, type StaticMetadataFile } from '../routing/metadata-files'
import { coerceString } from '../render/metadata'
import { legacyRequestAPIs } from '../request/context'
import { readSourceText } from '../resolve/source-text'
import { SPAN_TYPE, withChildSpan } from './otel/tracer'
import { settledPromise } from '../render/renderer'
import type { SlotHeadBranch, SlotHeadInput, SlotHeadPolicy } from '../render/hooks'
import { getNextConfig } from './next/config-loader'
import {
  createVaryingParams,
  createVaryingSearchParams,
  getMetadataVaryParamsAccumulator,
  varyTrackingInfo,
  type VaryTrackingInfo,
} from './segment/vary-params'

type NextGenerateMetadata = (
  props: Pick<PageProps, 'params' | 'searchParams'>,
  parent: Promise<Metadata>,
) => Metadata | Promise<Metadata>

type NextGenerateViewport = (
  props: Pick<PageProps, 'params' | 'searchParams'>,
) => Viewport | Promise<Viewport>

export async function readNextModuleMetadata(
  module: Record<string, unknown>,
  props: PageProps,
  parent: Metadata,
  modulePath?: string,
): Promise<Metadata | undefined> {
  if (typeof module.generateMetadata === 'function') {
    const generate = module.generateMetadata as NextGenerateMetadata
    const headProps = headVaryTrackedProps(props)
    const run = () =>
      generate(
        { params: headProps.params, searchParams: headProps.searchParams },
        Promise.resolve(resolvedParentMetadata(parent)),
      )
    const name = metadataSpanName(modulePath)
    return await (name
      ? withChildSpan(
          name,
          SPAN_TYPE.generateMetadata,
          { 'next.page': name.slice('generateMetadata '.length) },
          run,
        )
      : run())
  }
  return module.metadata as Metadata | undefined
}

function metadataSpanName(modulePath: string | undefined): string | undefined {
  if (!modulePath) return undefined
  const normalized = modulePath.replace(/\\/g, '/').replace(/\.[cm]?[jt]sx?$/, '')
  return `generateMetadata /${normalized.replace(/^\/+/, '')}`
}

export async function readNextModuleViewport(
  module: Record<string, unknown>,
  props: PageProps,
): Promise<Viewport | undefined> {
  if (typeof module.generateViewport === 'function') {
    const headProps = headVaryTrackedProps(props)
    return (module.generateViewport as NextGenerateViewport)({
      params: headProps.params,
      searchParams: headProps.searchParams,
    })
  }
  return module.viewport as Viewport | undefined
}

/**
 * `generateMetadata` / `generateViewport` param access accrues to the HEAD segment's vary set, never the
 * page's - a page that shares one payload across params but whose metadata reads `params.id` must keep
 * the head keyed per id while the body stays shared.
 *
 * The incoming props already carry the PAGE's tracking view; re-wrap the raw object behind it against
 * the head accumulator so reading here never widens the page's set. Untracked or hanging
 * (fallback-shell) props pass through untouched - a hanging promise must keep its identity so the
 * postpone machinery still sees it.
 */
function headVaryTrackedProps(props: PageProps): Pick<PageProps, 'params' | 'searchParams'> {
  const head = getMetadataVaryParamsAccumulator()
  if (!head) return { params: props.params, searchParams: props.searchParams }
  return {
    params: retrackSettled(props.params, (raw, info) =>
      createVaryingParams(head, raw, info.optionalCatchAllParam),
    ),
    searchParams: retrackSettled(props.searchParams, raw => createVaryingSearchParams(head, raw)),
  }
}

/**
 * Re-wrap a SETTLED params/searchParams promise around a fresh tracking view
 * built from the ORIGINAL object behind it. Anything else (a hanging promise, an
 * untracked value) is returned as-is.
 */
function retrackSettled<T extends Record<string, unknown>>(
  promise: Promise<T>,
  wrap: (raw: T, info: VaryTrackingInfo) => T,
): Promise<T> {
  const settled = promise as Promise<T> & { status?: string; value?: T }
  if (settled.status !== 'fulfilled' || settled.value === undefined) return promise
  const info = varyTrackingInfo(settled.value)
  if (!info) return promise
  return settledPromise(wrap(info.raw as T, info))
}

export function hasRuntimeMetadata(module: Record<string, unknown>) {
  return typeof module.generateMetadata === 'function'
}

const HTML_LIMITED_BOT_UA_RE =
  /[\w-]+-Google|Google-[\w-]+|Chrome-Lighthouse|Slurp|DuckDuckBot|baiduspider|yandex|sogou|bitlybot|tumblr|vkShare|quora link preview|redditbot|ia_archiver|Bingbot|BingPreview|applebot|facebookexternalhit|facebookcatalog|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|SkypeUriPreview|Yeti|googleweblight/i

export function shouldRenderMetadataInBody({
  config,
  request,
}: {
  config: { htmlLimitedBots?: RegExp }
  request?: Request
}) {
  const userAgent = request?.headers.get('user-agent') ?? ''
  const limitedBot = config.htmlLimitedBots ?? HTML_LIMITED_BOT_UA_RE
  return !limitedBot.test(userAgent)
}

function resolvedParentMetadata(parent: Metadata): Metadata {
  return {
    ...parent,
    metadataBase: parent.metadataBase === undefined ? undefined : coerceString(parent.metadataBase),
    keywords: normalizeKeywordList(parent.keywords),
    openGraph: resolvedParentOpenGraph(parent.openGraph),
    twitter: parent.twitter ?? {},
    robots: parent.robots ?? {},
    alternates: parent.alternates ?? {},
    icons: parent.icons ?? {},
  }
}

function resolvedParentOpenGraph(
  openGraph: MetadataOpenGraph | null | undefined,
): MetadataOpenGraph {
  if (!openGraph) return {}
  return {
    ...openGraph,
    title:
      openGraph.title === undefined ||
      (typeof openGraph.title === 'object' && openGraph.title !== null)
        ? openGraph.title
        : { absolute: coerceString(openGraph.title) },
    images:
      openGraph.images === undefined
        ? []
        : Array.isArray(openGraph.images)
          ? openGraph.images
          : [openGraph.images],
  }
}

function normalizeKeywordList(value: Metadata['keywords']): (string | number)[] | undefined {
  if (value === undefined || value === null) return undefined
  return Array.isArray(value) ? value : [value]
}

export async function warnNextMetadataBuildIssues(
  appPath: string,
  routes: RouteManifestEntry[],
  staticMetadataFiles: StaticMetadataFile[],
) {
  const warned = new Set<string>()
  // A route's own file plus its layout chain: on a 23-route app with one shell
  // that is the same handful of layouts 23 times over. Each file's four verdicts
  // are derived once and reused, and the reads come from the build's shared
  // source cache (the route-fact walk has already read every one of them).
  const facts = new Map<string, MetadataSourceFacts>()
  const factsFor = async (file: string) => {
    let cached = facts.get(file)
    if (!cached) {
      cached = metadataSourceFacts(await readSourceTextOrEmpty(file))
      facts.set(file, cached)
    }
    return cached
  }
  for (const route of routes) {
    if (route.kind !== 'page') continue
    const routeFacts = await Promise.all(routeSourceFiles(appPath, route).map(factsFor))
    const some = (pick: (fact: MetadataSourceFacts) => boolean) => routeFacts.some(pick)
    // themeColor-in-metadata deprecation is Next 15+; legacy (Next-14 era) apps never saw it.
    if (!legacyRequestAPIs() && some(fact => fact.themeColor)) {
      warnOnce(
        warned,
        `themeColor:${route.route}`,
        `Unsupported metadata themeColor is configured in metadata export in ${route.route || '/'}. Please move it to viewport\nRead more: https://nextjs.org/docs/app/api-reference/functions/generate-viewport`,
      )
    }
    if (some(fact => fact.appleTouchFullscreen)) {
      warnOnce(
        warned,
        'apple-touch-fullscreen',
        'Unsupported metadata other.apple-touch-fullscreen is configured in metadata export. Use appleWebApp instead.',
      )
    }
    if (some(fact => fact.appleTouchIconPrecomposed)) {
      warnOnce(
        warned,
        'apple-touch-icon-precomposed',
        'Unsupported metadata other.apple-touch-icon-precomposed is configured in metadata export. Use icons.apple instead.',
      )
    }
    if (
      !some(fact => fact.metadataBase) &&
      routeUsesRelativeSocialImage(route, routeFacts, staticMetadataFiles)
    ) {
      warnOnce(
        warned,
        'metadataBase',
        'metadataBase property in metadata export is not set for resolving social open graph or twitter images, using "http://localhost:3000". See https://nextjs.org/docs/app/api-reference/functions/generate-metadata#metadatabase',
      )
    }
  }
}

/** The app-dir files whose metadata exports apply to this route. */
function routeSourceFiles(appPath: string, route: RouteManifestEntry) {
  const root = `${appPath}/`
  return route.sourceFiles.filter(file => file === appPath || file.startsWith(root))
}

async function readSourceTextOrEmpty(file: string) {
  try {
    return await readSourceText(file)
  } catch {
    return ''
  }
}

/**
 * Every metadata verdict this pass needs from one source file. The substring
 * gates run first: a regex over the whole source costs ~40x a `includes`, and
 * nearly every file has none of these keys.
 */
interface MetadataSourceFacts {
  themeColor: boolean
  appleTouchFullscreen: boolean
  appleTouchIconPrecomposed: boolean
  metadataBase: boolean
  relativeSocialImage: boolean
}

function metadataSourceFacts(source: string): MetadataSourceFacts {
  return {
    themeColor: themeColorInMetadataExport(source),
    appleTouchFullscreen:
      source.includes('apple-touch-fullscreen') && /['"]apple-touch-fullscreen['"]/.test(source),
    appleTouchIconPrecomposed:
      source.includes('apple-touch-icon-precomposed') &&
      /['"]apple-touch-icon-precomposed['"]/.test(source),
    metadataBase: source.includes('metadataBase') && /\bmetadataBase\s*:/.test(source),
    relativeSocialImage: hasRelativeSocialImage(source),
  }
}

// A themeColor inside a viewport export is where the notice says to put it, so
// only occurrences outside viewport/generateViewport blocks count.
function themeColorInMetadataExport(source: string): boolean {
  if (!source.includes('themeColor') || !/\bthemeColor\s*:/.test(source)) return false
  return /\bthemeColor\s*:/.test(stripViewportExports(source))
}

function stripViewportExports(source: string): string {
  const starts =
    /export\s+(?:const|let|var)\s+viewport\b|export\s+(?:async\s+)?function\s+generateViewport\b/g
  let out = ''
  let last = 0
  for (let match = starts.exec(source); match; match = starts.exec(source)) {
    const open = source.indexOf('{', match.index)
    if (open === -1) break
    let depth = 0
    let end = open
    for (; end < source.length; end++) {
      const char = source[end]
      if (char === '{') depth++
      else if (char === '}' && --depth === 0) break
    }
    out += source.slice(last, match.index)
    last = end + 1
    starts.lastIndex = last
  }
  return out + source.slice(last)
}

function routeUsesRelativeSocialImage(
  route: RouteManifestEntry,
  facts: MetadataSourceFacts[],
  staticMetadataFiles: StaticMetadataFile[],
) {
  if (facts.some(fact => fact.relativeSocialImage)) return true
  if (route.params.length > 0) return false
  const staticMetadata = staticMetadataForPathFromFiles(staticMetadataFiles, route.route)
  return Boolean(staticMetadata.openGraphImage || staticMetadata.twitterImage)
}

function hasRelativeSocialImage(source: string) {
  if (!source.includes('images')) return false
  return /(?:openGraph|twitter)\s*:\s*\{[\s\S]*?\bimages\s*:\s*['"`](?:\/|\.\.?\/)/m.test(source)
}

function warnOnce(warned: Set<string>, key: string, message: string) {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(message)
}

/**
 * Next's slot metadata model: only a rendered outlet delivers metadata/viewport errors. Without
 * `experimental.parallelRouteMetadata` only children owns one, except that a navigation into a
 * named-slot-only route renders from its slot. With it, every slot branch starts eagerly and owns
 * an outlet, and the head takes ONE branch: children when it defines head tags below the fork, else
 * the deepest definition, then the deeper page, then the lexically first slot.
 */
export async function nextSlotHead(input: SlotHeadInput): Promise<SlotHeadPolicy> {
  const experimental = getNextConfig().experimental as
    { parallelRouteMetadata?: boolean } | undefined
  if (experimental?.parallelRouteMetadata === true) {
    return parallelSlotHead(input, await input.analyze())
  }
  if (!input.namedSlotsOnly) return { outlets: new Map(), head: input.fallback }
  const branches = await input.analyze()
  return {
    outlets: new Map(
      input.routerPayload
        ? branches.map(branch => [branch.slotDir, slotOutlet(branch)] as const)
        : [],
    ),
    head: async () => {
      for (const branch of branches) {
        const entries = await branch.metadata().catch(() => [])
        if (branch.hasSource) return { entries, viewport: [], runtime: branch.runtime }
      }
      return { entries: [], viewport: [], runtime: false }
    },
  }
}

function parallelSlotHead(input: SlotHeadInput, branches: SlotHeadBranch[]): SlotHeadPolicy {
  const outlets = new Map(branches.map(branch => [branch.slotDir, slotOutlet(branch)] as const))
  let selected: SlotHeadBranch | undefined
  for (const branch of branches) {
    if (branch.childrenDefinesHead || branch.definitionDepth < 0) continue
    if (
      !selected ||
      branch.definitionDepth > selected.definitionDepth ||
      (branch.definitionDepth === selected.definitionDepth &&
        (branch.pageDepth > selected.pageDepth ||
          (branch.pageDepth === selected.pageDepth && branch.slotDir < selected.slotDir)))
    ) {
      selected = branch
    }
  }
  return {
    outlets,
    onSlotFileError: input.logError,
    head: async rendered => {
      for (const branch of branches) {
        if (rendered.has(branch.slotDir)) continue
        void branch.metadata().catch(input.logError)
        void branch.viewport().catch(input.logError)
      }
      if (!selected) return { entries: [], viewport: [], runtime: false }
      // Each part degrades on its own; its rejection is the selected outlet's to deliver.
      const [entries, viewport] = await Promise.all([
        selected.metadata().catch(() => []),
        selected.viewport().catch(() => []),
      ])
      return { entries, viewport, runtime: selected.runtime }
    },
  }
}

function slotOutlet(branch: SlotHeadBranch) {
  const outlet = Promise.all([branch.metadata(), branch.viewport()])
  outlet.catch(() => undefined)
  return outlet
}
