import type {
  Metadata,
  MetadataAuthor,
  MetadataIcon,
  MetadataIconGroups,
  MetadataImage,
  MetadataLink,
  MetadataOpenGraph,
  MetadataRobots,
  MetadataValue,
  ResourceHint,
  MetadataTwitter,
  Viewport,
} from '../types'
import {
  metadataHasOwnImages,
  staticMetadataLink,
  type StaticMetadataForPath,
} from '../routing/metadata-files'
import { escapeHtml, stringifyHtmlValue } from '../utils/html'
import { getTrailingSlashUrls, withBasePath } from '../routing/href'

/** Every metadata field is nullable: null means "not set", exactly like undefined. */
type MetaContent = MetadataValue | null | undefined

function absent(value: unknown): value is null | undefined {
  return value === undefined || value === null
}

export type MetadataExport = Metadata | (() => Metadata | Promise<Metadata>)

export type ViewportExport = Viewport | (() => Viewport | Promise<Viewport>)

export interface MetadataEntry {
  metadata: Metadata
  dir?: string
  kind?: 'layout' | 'page'
  root?: boolean
}

export interface MetadataContext {
  url?: URL
  metadataBase?: URL
}

export interface MetadataRenderPage {
  metadata: Metadata
  metadataUrl?: string
  fontPreloads: MetadataLink[]
  resourceHints?: ResourceHint[]
  stylesheets: StylesheetLink[]
  modulePreloads?: string[]
  dynamicScriptPreloads?: string[]
  staticMetadata?: StaticMetadataForPath
  suppressIconLinks?: boolean
}

export interface StylesheetLink {
  url: string | string[]
  dataPrecedence?: string
}

export function metadataContext(page: MetadataRenderPage): MetadataContext {
  const url = page.metadataUrl ? new URL(page.metadataUrl) : undefined
  return {
    url,
    metadataBase: coerceMetadataBase(page.metadata.metadataBase, url),
  }
}

// Links describing the render's own bytes, not metadata - so they stay in the
// head even when metadata streams into the body.
export function assetLinks(page: MetadataRenderPage) {
  return assetLinkGroups(page).filter(Boolean).join('\n')
}

export function assetLinkGroups(page: MetadataRenderPage) {
  const connects: ResourceHint[] = []
  const preloads: ResourceHint[] = []
  const lateHints: ResourceHint[] = []
  for (const hint of page.resourceHints ?? []) {
    if (hint.rel === 'preconnect' || hint.rel === 'dns-prefetch') connects.push(hint)
    else if (hint.rel === 'preload' && (hint.as === 'font' || hint.as === 'image'))
      preloads.push(hint)
    else lateHints.push(hint)
  }
  const bulk: (MetadataLink | ResourceHint)[] = [
    ...(page.modulePreloads ?? []).map(url => ({ rel: 'modulepreload', url })),
    ...(page.dynamicScriptPreloads ?? []).map(url => ({
      rel: 'preload',
      url,
      as: 'script',
      // `crossorigin` keeps the hint's fetch mode matching the later
      // `import()` (cors/same-origin), so the chunk isn't downloaded twice.
      crossOrigin: 'anonymous' as const,
      fetchPriority: 'low' as const,
    })),
  ]
  return [
    renderLinks(connects),
    renderLinks([...page.fontPreloads, ...preloads]),
    renderLinks(stylesheetLinks(page.stylesheets)),
    renderLinks(bulk),
    renderLinks(lateHints),
  ]
}

// Links derived from `metadata` - these travel with it into the body.
export function metadataOnlyLinks(page: MetadataRenderPage, context: MetadataContext) {
  const canonical = coerceCanonical(page.metadata.alternates, context)
  const links: (MetadataLink | ResourceHint)[] = [
    ...(canonical ? [{ rel: 'canonical', url: canonical }] : []),
    ...staticMetadataLinks(page),
    ...authorLinks(page.metadata.authors, context),
    ...manifestLink(page.metadata.manifest, context),
    ...alternateLinks(page.metadata.alternates, context),
    ...paginationLinks(page.metadata.pagination, context),
    ...appleStartupLinks(page.metadata.appleWebApp, context),
    ...coerceIcons(page.metadata.icons, context),
    ...(page.metadata.links ?? []),
  ]
  return renderLinks(links)
}

export function headLinks(page: MetadataRenderPage, context: MetadataContext) {
  return [assetLinks(page), metadataOnlyLinks(page, context)].filter(Boolean).join('\n')
}

function renderLinks(links: (MetadataLink | ResourceHint)[]) {
  return links.map(link => `    <link ${linkAttrs(link)}/>`).join('\n')
}

function stylesheetLinks(stylesheets: StylesheetLink[]): MetadataLink[] {
  return stylesheets.flatMap(({ url, dataPrecedence }) =>
    (Array.isArray(url) ? url : [url]).map(href => ({
      rel: 'stylesheet',
      url: href,
      ...(dataPrecedence ? { dataPrecedence } : {}),
    })),
  )
}

export function metadataIconLinks(metadata: Metadata, context: MetadataContext, indent = '    ') {
  return coerceIcons(metadata.icons, context)
    .map(link => `${indent}<link ${linkAttrs(link)}/>`)
    .join('\n')
}

function staticMetadataLinks(page: MetadataRenderPage): MetadataLink[] {
  const metadata = page.staticMetadata
  if (!metadata) return []
  const hasExplicitIcons = page.metadata.icons !== undefined
  const hasExplicitManifest = page.metadata.manifest !== undefined
  if (page.suppressIconLinks) {
    return prefixLinks([
      ...(!hasExplicitManifest && metadata.manifestLink ? [metadata.manifestLink] : []),
      ...(!hasExplicitManifest && metadata.manifest ? [staticMetadataLink(metadata.manifest)] : []),
    ])
  }
  return prefixLinks([
    ...(metadata.favicon ? [staticMetadataLink(metadata.favicon)] : []),
    ...(!hasExplicitManifest && metadata.manifestLink ? [metadata.manifestLink] : []),
    ...(!hasExplicitManifest && metadata.manifest ? [staticMetadataLink(metadata.manifest)] : []),
    ...metadata.icons.map(staticMetadataLink),
    ...(metadata.dynamicIcons ?? []),
    // Root icons share the icon bucket. Keeping them after apple icons made
    // the link order differ from Next whenever both conventions were present.
    ...(!hasExplicitIcons && metadata.icons.length === 0
      ? metadata.rootIcons.map(staticMetadataLink)
      : []),
    ...metadata.appleIcons.map(staticMetadataLink),
    ...(metadata.dynamicAppleIcons ?? []),
  ])
}

// File-convention metadata assets (favicon, icons, manifest, ...) are served
// under the configured basePath, so their hrefs carry the prefix. A no-basePath
// app leaves every href untouched (withBasePath is a no-op).
function prefixLinks(links: MetadataLink[]): MetadataLink[] {
  return links.map(link => ({ ...link, url: withBasePath(link.url) }))
}

export function applyStaticMetadata(
  metadata: Metadata,
  staticMetadata: StaticMetadataForPath,
): Metadata {
  let next = metadata
  const openGraphImages = [
    ...(staticMetadata.openGraphImage ? [staticMetadata.openGraphImage] : []),
    ...(staticMetadata.dynamicOpenGraphImages ?? []),
  ].map(prefixImageBasePath)
  if (openGraphImages.length > 0 && !metadataHasOwnImages(metadata, 'openGraph')) {
    next = {
      ...next,
      openGraph: {
        ...(next.openGraph ?? {}),
        images: openGraphImages.length === 1 ? openGraphImages[0] : openGraphImages,
      },
    }
  }
  const twitterImages = [
    ...(staticMetadata.twitterImage ? [staticMetadata.twitterImage] : []),
    ...(staticMetadata.dynamicTwitterImages ?? []),
  ].map(prefixImageBasePath)
  if (twitterImages.length > 0 && !metadataHasOwnImages(metadata, 'twitter')) {
    next = {
      ...next,
      twitter: {
        ...(next.twitter ?? {}),
        images: twitterImages.length === 1 ? twitterImages[0] : twitterImages,
      },
    }
  }
  return next
}

// File-convention og/twitter images resolve to a root-relative asset path
// (e.g. `/dir/opengraph-image.png?metadata`); under a basePath the asset is
// served with that prefix, so the href carries it. String/URL images and a
// no-basePath app are left untouched.
function prefixImageBasePath(image: MetadataImage): MetadataImage {
  if (typeof image === 'string') return withBasePath(image)
  if (image instanceof URL) return image
  if (typeof image === 'object' && image !== null && typeof image.url === 'string') {
    return { ...image, url: withBasePath(image.url) }
  }
  return image
}

// Emits the common metadata <meta> tags. Every value passes through
// escapeHtml (which itself coerces via String()), so no value shape can throw.
export function metadataTags(metadata: Metadata, context: MetadataContext): string {
  const meta = metadata
  const tags: string[] = []
  const push = (name: string, content: MetaContent) => {
    if (content)
      tags.push(`<meta name="${escapeHtml(name)}" content="${escapeHtml(coerceString(content))}"/>`)
  }
  const pushProperty = (property: string, content: MetaContent) => {
    if (content)
      tags.push(
        `<meta property="${escapeHtml(property)}" content="${escapeHtml(coerceString(content))}"/>`,
      )
  }

  push('description', meta.description)
  push('keywords', coerceKeywords(meta.keywords))
  for (const author of coerceAuthors(meta.authors)) push('author', author)
  push('generator', meta.generator)
  push('application-name', meta.applicationName)
  push('referrer', meta.referrer)
  push('creator', meta.creator)
  push('publisher', meta.publisher)
  push('robots', coerceRobots(meta.robots))
  push(
    'googlebot',
    coerceRobots(isRecord(meta.robots) ? (meta.robots.googleBot as MetadataRobots) : undefined),
  )
  push('format-detection', coerceFormatDetection(meta.formatDetection))
  for (const [name, value] of verificationTags(meta.verification)) push(name, value)
  for (const value of list(meta.verification?.other?.me)) push('me', value)
  for (const [name, values] of Object.entries(meta.other ?? {})) {
    for (const value of list(values)) push(name, value)
  }
  const itunes = itunesContent(meta.itunes)
  push('apple-itunes-app', itunes)
  const apple = meta.appleWebApp
  if (apple) {
    push('mobile-web-app-capable', appleWebAppCapable(apple) ? 'yes' : undefined)
    if (typeof apple === 'object') {
      push('apple-mobile-web-app-title', apple.title)
      push('apple-mobile-web-app-status-bar-style', apple.statusBarStyle)
    }
  }
  if (meta.facebook?.appId) pushProperty('fb:app_id', meta.facebook.appId)
  for (const admin of list(meta.facebook?.admins)) pushProperty('fb:admins', admin)
  if (!absent(meta.pinterest?.richPin)) {
    pushProperty('pinterest-rich-pin', String(meta.pinterest.richPin))
  }
  for (const [property, value] of appLinkTags(meta.appLinks)) pushProperty(property, value)

  const social = resolveSocialMetadata(meta)
  tags.push(...openGraphTags(social.openGraph, context))
  tags.push(...twitterTags(social.twitter, context))

  return tags.join('\n    ')
}

function openGraphTags(og: MetadataOpenGraph | undefined, context: MetadataContext): string[] {
  if (!og) return []
  const tags: string[] = []
  const push = (property: string, content: MetaContent) => {
    if (content)
      tags.push(
        `<meta property="${escapeHtml(property)}" content="${escapeHtml(coerceString(content))}"/>`,
      )
  }
  push('og:title', og.title === undefined ? undefined : resolveTitleChain([{ title: og.title }]))
  push('og:description', og.description)
  push('og:url', resolveMetadataUrl(og.url, context))
  push('og:site_name', og.siteName)
  push('og:locale', og.locale)
  push('og:type', og.type)
  for (const image of coerceImages(og.images, context)) {
    push('og:image', image.url)
    push('og:image:secure_url', image.secureUrl)
    push('og:image:width', image.width)
    push('og:image:height', image.height)
    push('og:image:alt', image.alt)
    push('og:image:type', image.type)
  }
  for (const video of coerceImages(og.videos, context)) {
    push('og:video', video.url)
    push('og:video:width', video.width)
    push('og:video:height', video.height)
  }
  for (const audio of coerceImages(og.audio, context)) push('og:audio', audio.url)
  push('article:published_time', og.publishedTime)
  for (const author of list(og.authors)) push('article:author', author)
  for (const email of list(og.emails)) push('og:email', email)
  for (const phone of list(og.phoneNumbers)) push('og:phone_number', phone)
  for (const fax of list(og.faxNumbers)) push('og:fax_number', fax)
  return tags
}

function twitterTags(twitter: MetadataTwitter | undefined, context: MetadataContext): string[] {
  if (!twitter) return []
  const tags: string[] = []
  const push = (name: string, content: MetaContent) => {
    if (content)
      tags.push(`<meta name="${escapeHtml(name)}" content="${escapeHtml(coerceString(content))}"/>`)
  }
  push('twitter:card', twitterCard(twitter))
  push('twitter:site', twitter.site)
  push('twitter:site:id', twitter.siteId)
  push('twitter:creator', twitter.creator)
  push('twitter:creator:id', twitter.creatorId)
  push(
    'twitter:title',
    twitter.title === undefined ? undefined : resolveTitleChain([{ title: twitter.title }]),
  )
  push('twitter:description', twitter.description)
  for (const image of coerceImages(twitter.images, context)) {
    push('twitter:image', image.url)
    push('twitter:image:secure_url', image.secureUrl)
    push('twitter:image:width', image.width)
    push('twitter:image:height', image.height)
    push('twitter:image:alt', image.alt)
    push('twitter:image:type', image.type)
  }
  const players = twitter.players === undefined ? [] : [twitter.players].flat()
  for (const player of players) {
    push('twitter:player', resolveMetadataUrl(player.playerUrl, context))
    push('twitter:player:stream', resolveMetadataUrl(player.streamUrl, context))
    push('twitter:player:width', coerceString(player.width) || undefined)
    push('twitter:player:height', coerceString(player.height) || undefined)
  }
  for (const [device, id] of Object.entries(twitter.app?.id ?? {})) {
    push(`twitter:app:id:${device}`, id)
  }
  for (const [device, url] of Object.entries(twitter.app?.url ?? {})) {
    push(`twitter:app:url:${device}`, resolveMetadataUrl(url, context))
  }
  return tags
}

// theme-color: string | { color, media } | array of those.
export function themeColorTags(value: Viewport['themeColor']): string {
  if (absent(value)) return ''
  const list = Array.isArray(value) ? value : [value]
  return list
    .map(entry => {
      if (typeof entry === 'string')
        return `<meta name="theme-color" content="${escapeHtml(entry)}"/>`
      const media = entry.media ? ` media="${escapeHtml(entry.media)}"` : ''
      return `<meta name="theme-color"${media} content="${escapeHtml(entry.color)}"/>`
    })
    .join('\n    ')
}

function linkAttrs(link: MetadataLink | ResourceHint) {
  const attrs = [
    ['rel', link.rel],
    ['href', link.url],
    ['data-precedence', link.dataPrecedence],
    ['type', link.type],
    ['media', link.media],
    ['sizes', link.sizes],
    ['as', link.as],
    ['title', link.title],
    ['hreflang', link.hrefLang],
    ['crossorigin', link.crossOrigin],
    ['fetchpriority', link.fetchPriority],
    ['nonce', link.nonce],
  ]
    .filter((attr): attr is [string, string] => typeof attr[1] === 'string')
    .map(([key, value]) => `${key}="${escapeHtml(value)}"`)
  const attributes = 'attributes' in link ? link.attributes : undefined
  for (const [key, value] of Object.entries(attributes ?? {})) {
    attrs.push(`${escapeHtml(key)}="${escapeHtml(value)}"`)
  }
  return attrs.join(' ')
}

export function viewportContent(viewport: Viewport) {
  const entries: [string, string | number | boolean | undefined][] = [
    ['width', viewport.width ?? 'device-width'],
    [
      'initial-scale',
      Object.prototype.hasOwnProperty.call(viewport, 'initialScale') ? viewport.initialScale : 1,
    ],
    ['minimum-scale', viewport.minimumScale],
    ['maximum-scale', viewport.maximumScale],
    [
      'user-scalable',
      viewport.userScalable === undefined ? undefined : viewport.userScalable ? 'yes' : 'no',
    ],
    ['viewport-fit', viewport.viewportFit],
    ['interactive-widget', viewport.interactiveWidget],
  ]

  return entries
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ')
}

// Core metadata is static for a route render: object exports are read as-is and
// function exports run without request data. Compat registers the Next
// generateMetadata/generateViewport resolver separately.
export async function readModuleMetadata(module: {
  metadata?: MetadataExport
}): Promise<Metadata | undefined> {
  return typeof module.metadata === 'function' ? module.metadata() : module.metadata
}

export async function readModuleViewport(module: {
  viewport?: ViewportExport
}): Promise<Viewport | undefined> {
  return typeof module.viewport === 'function' ? module.viewport() : module.viewport
}

export function mergeMetadataEntries(
  ...entryGroups: (MetadataEntry | MetadataEntry[])[]
): Metadata {
  const entries = entryGroups.flat()
  const items = entries.map(entry => entry.metadata)
  const merged = items.reduce<Metadata>(
    (metadata, item) => ({
      ...metadata,
      ...item,
      icons: mergeIcons(metadata.icons, item.icons),
      links: [...(metadata.links ?? []), ...(item.links ?? [])],
    }),
    {},
  )
  merged.title = resolveTitleEntries(entries)
  return merged
}

function mergeIcons(base: Metadata['icons'], next: Metadata['icons']): Metadata['icons'] {
  if (next === undefined) return base
  if (Array.isArray(base) && Array.isArray(next)) return [...base, ...next]
  return next
}

interface TitleTemplateState {
  template: string | null
  previous: string | null
  dir?: string
  root?: boolean
}

function resolveTitleEntries(entries: MetadataEntry[]): string | undefined {
  let template: TitleTemplateState = { template: null, previous: null }
  let resolved: string | undefined

  for (const entry of entries) {
    const title = entry.metadata.title
    if (title === undefined) continue
    const activeTemplate =
      entry.kind === 'page' && entry.dir && entry.dir === template.dir && !template.root
        ? template.previous
        : template.template

    if (typeof title === 'object' && title !== null) {
      if (typeof title.absolute === 'string') {
        resolved = title.absolute
      } else if (typeof title.default === 'string') {
        resolved = applyTitleTemplate(activeTemplate, title.default)
      }
      if ('template' in title) {
        template = {
          template: title.template ?? null,
          previous: activeTemplate,
          dir: entry.dir,
          root: entry.root,
        }
      }
    } else {
      resolved = applyTitleTemplate(activeTemplate, coerceString(title))
    }
  }
  return resolved
}

// Walks the chain root->page tracking the last-seen template. A child's plain
// string title is wrapped by the nearest ancestor template; an `absolute`
// bypasses the template; a `default` supplies a title when the child has none.
function resolveTitleChain(items: Metadata[]): string | undefined {
  return resolveTitleEntries(items.map(metadata => ({ metadata })))
}

function applyTitleTemplate(template: string | null, value: string): string {
  return template ? template.replace('%s', value) : value
}

// Coerces any metadata scalar (string | number | URL | unknown) into a string.
// Numbers go through String(); undefined/null collapse to ''. This is the guard
// that keeps emission from ever crashing on an unexpected value shape.
export function coerceString(value: unknown): string {
  return stringifyHtmlValue(value)
}

// keywords: string | number | Array -> comma-joined string.
function coerceKeywords(value: Metadata['keywords']): string | undefined {
  const list = normalizeKeywordList(value)
  if (list === undefined) return undefined
  const joined = list.map(coerceString).filter(Boolean).join(',')
  return joined || undefined
}

function normalizeKeywordList(value: Metadata['keywords']): (string | number)[] | undefined {
  if (absent(value)) return undefined
  return Array.isArray(value) ? value : [value]
}

// authors -> list of display names for meta[name=author].
function coerceAuthors(value: Metadata['authors']): string[] {
  if (absent(value)) return []
  const list = Array.isArray(value) ? value : [value]
  return list
    .map(author => (typeof author === 'string' ? author : author.name))
    .map(name => coerceString(name))
    .filter(Boolean)
}

// robots: string passthrough, or object -> "index, follow, noarchive" style.
function coerceRobots(value: Metadata['robots']): string | undefined {
  if (absent(value)) return undefined
  if (typeof value === 'string') return value
  const flags: string[] = []
  const r = value
  if (r.index !== undefined) flags.push(r.index ? 'index' : 'noindex')
  if (r.follow !== undefined) flags.push(r.follow ? 'follow' : 'nofollow')
  if (r.noarchive) flags.push('noarchive')
  if (r.nosnippet) flags.push('nosnippet')
  if (r.noimageindex) flags.push('noimageindex')
  if (r.nocache) flags.push('nocache')
  for (const [key, item] of Object.entries(r)) {
    if (
      item === undefined ||
      item === false ||
      key === 'index' ||
      key === 'follow' ||
      key === 'noarchive' ||
      key === 'nosnippet' ||
      key === 'noimageindex' ||
      key === 'nocache' ||
      key === 'googleBot'
    ) {
      continue
    }
    if (item === true) flags.push(key)
    else flags.push(`${key}:${String(item)}`)
  }
  return flags.length ? flags.join(', ') : undefined
}

interface ResolvedImage {
  url: string
  secureUrl?: string
  width?: string
  height?: string
  alt?: string
  type?: string
}

function coerceImages(
  value: MetadataImage | MetadataImage[] | undefined,
  context: MetadataContext,
): ResolvedImage[] {
  if (value === undefined) return []
  const list = Array.isArray(value) ? value : [value]
  return list
    .map((image): ResolvedImage | undefined => {
      if (typeof image === 'string')
        return { url: resolveMetadataUrl(image, context, true) ?? image }
      if (image instanceof URL) return { url: image.href }
      if (typeof image === 'object' && image !== null && 'url' in image) {
        const img = image
        return {
          url: resolveMetadataUrl(img.url, context, true) ?? coerceString(img.url),
          secureUrl: resolveMetadataUrl(img.secureUrl, context, true),
          width: img.width === undefined ? undefined : coerceString(img.width),
          height: img.height === undefined ? undefined : coerceString(img.height),
          alt: img.alt,
          type: img.type,
        }
      }
      return undefined
    })
    .filter((image): image is ResolvedImage => image !== undefined && Boolean(image.url))
}

function coerceCanonical(
  value: Metadata['alternates'],
  context: MetadataContext,
): string | undefined {
  const canonical = value?.canonical
  if (absent(canonical)) return undefined
  if (typeof canonical === 'string') return resolveMetadataUrl(canonical, context)
  if (canonical instanceof URL) return canonical.href
  if (typeof canonical === 'object' && 'url' in canonical)
    return resolveMetadataUrl(canonical.url, context)
  return undefined
}

function coerceMetadataBase(value: Metadata['metadataBase'], url?: URL): URL | undefined {
  if (value instanceof URL) return value
  if (typeof value === 'string' && value) {
    try {
      return new URL(value)
    } catch {
      return url ? new URL(value, url) : undefined
    }
  }
  return undefined
}

function resolveMetadataUrl(
  value: unknown,
  context: MetadataContext,
  fallbackToRequestUrl = false,
): string | undefined {
  if (value === undefined || value === null) return undefined
  if (value instanceof URL) return value.href
  const raw = coerceString(value)
  if (!raw) return undefined
  if (/^[a-z][a-z\d+.-]*:/i.test(raw)) return raw
  const base =
    context.metadataBase ?? (fallbackToRequestUrl ? requestFallbackBase(context.url) : undefined)
  if (!base) return raw
  const origin = base.origin
  const prefix = base.pathname === '/' ? '' : `/${base.pathname.replace(/^\/+|\/+$/g, '')}`
  if (raw.startsWith('./') && context.url) {
    const requestPath = joinUrlPath(prefix, context.url.pathname)
    const directory = requestPath.endsWith('/') ? requestPath : `${requestPath}/`
    const resolved = new URL(raw, `${origin}${directory}`).pathname
    const pathname =
      resolved.length > 1 && resolved.endsWith('/') ? resolved.slice(0, -1) : resolved
    return joinMetadataUrl(origin, pathname)
  }
  const relative = metadataRelativePath(raw)
  const resolvedPath = joinUrlPath(prefix, relative)
  return joinMetadataUrl(origin, resolvedPath)
}

function requestFallbackBase(url?: URL) {
  if (!url) return undefined
  if (url.hostname !== 'pnext.local') return new URL(url.origin)
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const port = process.env.PORT
  return port && port !== '0' ? new URL(`http://localhost:${port}`) : undefined
}

// Join a resolved origin + pathname into an absolute metadata URL, honoring the
// app's trailingSlash config (canonical/alternate URLs mirror the page URL). A
// path carrying a query or hash is left untouched — Next only normalizes the
// bare path, and `/metadata?query=string` must not become `/metadata/?...`.
function joinMetadataUrl(origin: string, pathname: string) {
  if (/[?#]/.test(pathname)) {
    return pathname === '/' ? origin : `${origin}${pathname}`
  }
  if (getTrailingSlashUrls()) {
    if (pathname === '/') return `${origin}/`
    return pathname.endsWith('/') ? `${origin}${pathname}` : `${origin}${pathname}/`
  }
  return pathname === '/' ? origin : `${origin}${pathname}`
}

function metadataRelativePath(value: string) {
  let next = value
  while (next.startsWith('./')) next = next.slice(2)
  while (next.startsWith('../')) next = next.slice(3)
  while (next.startsWith('/')) next = next.slice(1)
  return next
}

function joinUrlPath(...parts: string[]) {
  const path = parts.filter(Boolean).join('/').replace(/\/+/g, '/')
  return path.startsWith('/') ? path : `/${path}`
}

// Normalizes every icon form (string | URL | object | group) into <link> descriptors.
function coerceIcons(value: Metadata['icons'], context: MetadataContext): MetadataLink[] {
  if (absent(value)) return []
  if (isIconGroups(value)) {
    return [
      ...iconList(value.icon, 'icon', context),
      ...iconList(value.shortcut, 'shortcut icon', context),
      ...iconList(value.apple, 'apple-touch-icon', context),
      ...iconList(value.other, 'icon', context),
    ]
  }
  return iconList(value, 'icon', context)
}

function isIconGroups(value: NonNullable<Metadata['icons']>): value is MetadataIconGroups {
  if (Array.isArray(value) || typeof value === 'string' || value instanceof URL) return false
  if (typeof value !== 'object') return false
  return 'icon' in value || 'shortcut' in value || 'apple' in value || 'other' in value
}

function iconList(
  value: MetadataIcon | MetadataIcon[] | null | undefined,
  rel: string,
  context: MetadataContext,
): MetadataLink[] {
  if (absent(value)) return []
  const list = Array.isArray(value) ? value : [value]
  return list.map((icon): MetadataLink => {
    if (typeof icon === 'string') return { rel, url: resolveMetadataUrl(icon, context) ?? icon }
    if (icon instanceof URL) return { rel, url: icon.href }
    const obj = icon
    return {
      ...obj,
      rel: obj.rel ?? rel,
      url: resolveMetadataUrl(obj.url, context) ?? coerceString(obj.url),
    }
  })
}

function authorLinks(value: Metadata['authors'], context: MetadataContext): MetadataLink[] {
  if (absent(value)) return []
  return (Array.isArray(value) ? value : [value])
    .filter((author): author is MetadataAuthor => typeof author === 'object' && author !== null)
    .flatMap(author => {
      const url = resolveMetadataUrl(author.url, context)
      return url ? [{ rel: 'author', url }] : []
    })
}

function manifestLink(value: Metadata['manifest'], context: MetadataContext): MetadataLink[] {
  const url = resolveMetadataUrl(value, context)
  return url ? [{ rel: 'manifest', url }] : []
}

function paginationLinks(value: Metadata['pagination'], context: MetadataContext): MetadataLink[] {
  return [
    ...(value?.previous
      ? [
          {
            rel: 'prev',
            url: resolveMetadataUrl(value.previous, context) ?? coerceString(value.previous),
          },
        ]
      : []),
    ...(value?.next
      ? [{ rel: 'next', url: resolveMetadataUrl(value.next, context) ?? coerceString(value.next) }]
      : []),
  ]
}

function alternateLinks(value: Metadata['alternates'], context: MetadataContext): MetadataLink[] {
  if (!value) return []
  const links: MetadataLink[] = []
  for (const [hrefLang, url] of Object.entries(value.languages ?? {})) {
    links.push({
      rel: 'alternate',
      url: resolveMetadataUrl(url, context) ?? coerceString(url),
      hrefLang,
    })
  }
  for (const [media, url] of Object.entries(value.media ?? {})) {
    links.push({
      rel: 'alternate',
      media,
      url: resolveMetadataUrl(url, context) ?? coerceString(url),
    })
  }
  for (const [type, entries] of Object.entries(value.types ?? {})) {
    const listEntries = Array.isArray(entries) ? entries : [entries]
    for (const entry of listEntries) {
      const record: { url: unknown; title?: string } =
        typeof entry === 'object' && !(entry instanceof URL) && entry !== null && 'url' in entry
          ? entry
          : { url: entry }
      links.push({
        rel: 'alternate',
        type,
        ...(record.title ? { title: record.title } : {}),
        url: resolveMetadataUrl(record.url, context) ?? coerceString(record.url),
      })
    }
  }
  return links
}

function appleStartupLinks(
  value: Metadata['appleWebApp'],
  context: MetadataContext,
): MetadataLink[] {
  if (!value || typeof value !== 'object' || absent(value.startupImage)) return []
  const images = [value.startupImage].flat()
  return images.map(image => {
    if (typeof image === 'string' || image instanceof URL) {
      return {
        rel: 'apple-touch-startup-image',
        url: resolveMetadataUrl(image, context) ?? coerceString(image),
      }
    }
    return {
      rel: 'apple-touch-startup-image',
      url: resolveMetadataUrl(image.url, context) ?? coerceString(image.url),
      media: image.media,
    }
  })
}

function list(value: unknown): string[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value.map(coerceString) : [coerceString(value)]
}

function coerceFormatDetection(value: Metadata['formatDetection']): string | undefined {
  if (!value) return undefined
  const entries: string[] = []
  if (value.telephone === false) entries.push('telephone=no')
  if (value.address === false) entries.push('address=no')
  if (value.email === false) entries.push('email=no')
  if (value.url === false) entries.push('url=no')
  return entries.length ? entries.join(', ') : undefined
}

function verificationTags(value: Metadata['verification']): [string, string][] {
  if (!value) return []
  return [
    ...list(value.google).map(item => ['google-site-verification', item] as [string, string]),
    ...list(value.yahoo).map(item => ['y_key', item] as [string, string]),
    ...list(value.yandex).map(item => ['yandex-verification', item] as [string, string]),
  ]
}

function itunesContent(value: Metadata['itunes']): string | undefined {
  if (!value?.appId) return undefined
  return [
    `app-id=${value.appId}`,
    value.appArgument ? `app-argument=${value.appArgument}` : undefined,
  ]
    .filter(Boolean)
    .join(', ')
}

function appleWebAppCapable(value: NonNullable<Metadata['appleWebApp']>) {
  return typeof value === 'boolean' ? value : (value.capable ?? true)
}

function appLinkTags(value: Metadata['appLinks']): [string, string][] {
  if (!value) return []
  const tags: [string, string][] = []
  for (const [platform, entries] of Object.entries(value)) {
    for (const target of entries === undefined ? [] : [entries].flat()) {
      for (const [name, item] of Object.entries(target)) {
        if (item !== undefined) tags.push([`al:${platform}:${name}`, coerceString(item)])
      }
    }
  }
  return tags
}

function twitterCard(twitter: MetadataTwitter) {
  if (twitter.card) return twitter.card
  if (twitter.players) return 'player'
  if (twitter.app) return 'app'
  return twitter.images === undefined ? 'summary' : 'summary_large_image'
}

// og/twitter resolve in one final pass over the merged chain: twitter auto-fills
// from openGraph, then whichever of the two exists inherits the page
// title/description it still lacks. Emission is that pass - nothing between the
// merge and here reads these fields, and the parent handed to generateMetadata
// is pre-merge by design.
function resolveSocialMetadata(meta: Metadata): {
  openGraph?: MetadataOpenGraph
  twitter?: MetadataTwitter
} {
  const og = meta.openGraph
  let twitter = meta.twitter
  if (og) {
    const ownImages = twitter && 'images' in twitter && twitter.images
    twitter = {
      ...twitter,
      // card follows twitter's OWN images: an og image inherited below never
      // upgrades a declared twitter block to summary_large_image.
      card: twitterCard(twitter ?? { images: og.images }),
      title: titleText(twitter?.title) === undefined ? og.title : twitter?.title,
      description: twitter?.description || og.description,
      images: ownImages ? twitter?.images : og.images,
    }
  }
  return {
    openGraph: og ? inherited(og, meta) : undefined,
    twitter: twitter ? inherited(twitter, meta) : undefined,
  }
}

// A block that renders no title/description of its own falls back to the page's.
function inherited<T extends { title?: Metadata['title']; description?: string | null }>(
  block: T,
  meta: Metadata,
): T {
  const own = titleText(block.title)
  if (own !== undefined && block.description) return block
  return {
    ...block,
    title: own === undefined ? titleText(meta.title) : block.title,
    description: block.description || meta.description,
  }
}

// The title a chain entry actually renders, or undefined when it renders none
// (a bare `template`, an empty string) and so counts as missing for inheritance.
function titleText(title: Metadata['title']): string | undefined {
  if (title === undefined) return undefined
  return resolveTitleChain([{ title }]) || undefined
}

export function mergeViewport(...items: Viewport[]) {
  return items.reduce<Viewport>(
    (viewport, item) => ({
      ...viewport,
      ...item,
    }),
    {},
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
