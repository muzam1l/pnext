import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type {
  Metadata,
  MetadataImage,
  MetadataLink,
  MetadataRouteEntry,
  MetadataRouteKind,
  RouteManifestEntry,
  RouteParamValue,
  StaticMetadataFileEntry,
} from '../types'
import { escapeHtml, stringifyHtmlValue } from '../utils/html'
import { toPosixPath } from '../utils/fs'

export type StaticMetadataKind =
  | 'favicon'
  | 'icon'
  | 'apple-icon'
  | 'opengraph-image'
  | 'twitter-image'
  | 'robots'
  | 'sitemap'
  | 'manifest'

export interface StaticMetadataFile extends StaticMetadataFileEntry {
  kind: StaticMetadataKind
}

export interface StaticMetadataForPath {
  favicon?: StaticMetadataFile
  manifest?: StaticMetadataFile
  manifestLink?: MetadataLink
  icons: StaticMetadataFile[]
  appleIcons: StaticMetadataFile[]
  rootIcons: StaticMetadataFile[]
  dynamicIcons?: MetadataLink[]
  dynamicAppleIcons?: MetadataLink[]
  openGraphImage?: MetadataImage
  dynamicOpenGraphImages?: MetadataImage[]
  twitterImage?: MetadataImage
  dynamicTwitterImages?: MetadataImage[]
}

const imageExtensions = ['ico', 'jpg', 'jpeg', 'png', 'svg', 'gif', 'webp'] as const
const imageExtensionPattern = imageExtensions.join('|')
const iconPattern = new RegExp(`^icon\\d*\\.(${imageExtensionPattern})$`, 'i')
const appleIconPattern = new RegExp(`^apple-icon\\d*\\.(${imageExtensionPattern})$`, 'i')
const openGraphPattern = new RegExp(`^opengraph-image\\d*\\.(${imageExtensionPattern})$`, 'i')
const twitterPattern = new RegExp(`^twitter-image\\d*\\.(${imageExtensionPattern})$`, 'i')

export const staticMetadataCacheControl = 'public, max-age=0, must-revalidate'

// Both discoveries walk ALL of app/ (recursive readdirSync) and every render asked for both. The
// answer changes only when files appear or disappear, so memoize per appPath; dev clears these on a
// structural save.
const staticMetadataFiles = new Map<string, StaticMetadataFile[]>()
const dynamicMetadataFiles = new Map<string, DynamicMetadataFile[]>()

/** Drop the memoized app/ metadata-file walks (dev structural invalidation). */
export function clearMetadataFileCaches() {
  staticMetadataFiles.clear()
  dynamicMetadataFiles.clear()
}

export function discoverStaticMetadataFiles(appPath: string): StaticMetadataFile[] {
  const cached = staticMetadataFiles.get(appPath)
  if (cached) return cached
  const files = existsSync(appPath)
    ? listFilesSync(appPath)
        .flatMap(file => staticMetadataFile(appPath, file) ?? [])
        .sort((a, b) => a.outputPath.localeCompare(b.outputPath))
    : []
  staticMetadataFiles.set(appPath, files)
  return files
}

export function staticMetadataForPath(appPath: string, pathname: string): StaticMetadataForPath {
  const files = discoverStaticMetadataFiles(appPath).filter(file =>
    metadataAppliesToPath(file, pathname),
  )
  return staticMetadataForFiles(files)
}

export function staticMetadataForPathFromFiles(
  files: StaticMetadataFile[],
  pathname: string,
): StaticMetadataForPath {
  return staticMetadataForFiles(files.filter(file => metadataAppliesToPath(file, pathname)))
}

export function staticMetadataForRoute(
  appPath: string,
  routeFile: string,
  pathname: string,
): StaticMetadataForPath {
  const routeDir = toPosixPath(path.relative(appPath, path.dirname(routeFile)))
  const files = discoverStaticMetadataFiles(appPath).filter(
    file => metadataAppliesToPath(file, pathname) || metadataAppliesToRoute(file, routeDir),
  )
  return staticMetadataForFiles(files)
}

export function staticMetadataForRouteFromFiles(
  files: StaticMetadataFile[],
  appPath: string,
  routeFile: string,
  pathname: string,
): StaticMetadataForPath {
  const routeDir = toPosixPath(path.relative(appPath, path.dirname(routeFile)))
  return staticMetadataForFiles(
    files.filter(
      file => metadataAppliesToPath(file, pathname) || metadataAppliesToRoute(file, routeDir),
    ),
  )
}

export function staticRouteMetadataKey(pathname: string) {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') || '/' : pathname
  return path || '/'
}

export type MetadataModuleLoader = (file: string) => Promise<Record<string, unknown>>

interface DynamicMetadataFile {
  kind: MetadataRouteKind
  file: string
  relative: string
  dir: string
  routeSegments: string[]
  base: string
}

interface MatchedDynamicMetadataFile extends DynamicMetadataFile {
  params: Record<string, RouteParamValue>
  routePath: string
  specificity: number
}

export async function withDynamicMetadataRoutes(
  metadata: StaticMetadataForPath,
  appPath: string,
  routeFile: string,
  pathname: string,
  loadModule: MetadataModuleLoader,
): Promise<StaticMetadataForPath> {
  // Every render with no prebuilt metadata reaches here, so an app with no
  // manifest/icon/sitemap modules pays one memoized lookup and no copy.
  const discovered = discoverDynamicMetadataFiles(appPath)
  if (discovered.length === 0) return metadata
  const routeDir = toPosixPath(path.relative(appPath, path.dirname(routeFile)))
  const files = discovered
    .map(file => matchDynamicMetadataFile(file, pathname, routeDir))
    .filter((file): file is MatchedDynamicMetadataFile => file !== undefined)

  const manifest = bestDynamicFiles(files, 'manifest')[0]
  const icons = await dynamicImageLinks(bestDynamicFiles(files, 'icon'), loadModule, 'icon')
  const appleIcons = await dynamicImageLinks(
    bestDynamicFiles(files, 'apple-icon'),
    loadModule,
    'apple-touch-icon',
  )
  const openGraphImages = await dynamicMetadataImages(
    bestDynamicFiles(files, 'opengraph-image'),
    loadModule,
  )
  const twitterImages = await dynamicMetadataImages(
    bestDynamicFiles(files, 'twitter-image'),
    loadModule,
  )

  return {
    ...metadata,
    ...(manifest ? { manifestLink: { rel: 'manifest', url: manifest.routePath } } : {}),
    ...(icons.length > 0 ? { dynamicIcons: icons } : {}),
    ...(appleIcons.length > 0 ? { dynamicAppleIcons: appleIcons } : {}),
    ...(openGraphImages.length > 0 ? { dynamicOpenGraphImages: openGraphImages } : {}),
    ...(twitterImages.length > 0 ? { dynamicTwitterImages: twitterImages } : {}),
  }
}

function staticMetadataForFiles(files: StaticMetadataFile[]): StaticMetadataForPath {
  const favicon = files.find(file => file.kind === 'favicon' && file.routeSegments.length === 0)
  const manifest = files.find(file => file.kind === 'manifest' && file.routeSegments.length === 0)
  const icons = nearestFiles(files, 'icon').filter(file => file.routeSegments.length > 0)
  const appleIcons = nearestFiles(files, 'apple-icon')
  const rootIcons = nearestFiles(files, 'icon').filter(file => file.routeSegments.length === 0)
  const openGraphFile = nearestFile(files, 'opengraph-image')
  const twitterFile = nearestFile(files, 'twitter-image')
  return {
    favicon,
    manifest,
    icons,
    appleIcons,
    rootIcons,
    openGraphImage: openGraphFile ? metadataImage(openGraphFile) : undefined,
    twitterImage: twitterFile ? metadataImage(twitterFile) : undefined,
  }
}

export function staticMetadataLink(file: StaticMetadataFile): MetadataLink {
  const url = staticMetadataUrl(file)
  if (file.kind === 'manifest') {
    return { rel: 'manifest', url }
  }
  return {
    rel: file.kind === 'apple-icon' ? 'apple-touch-icon' : 'icon',
    url,
    type: file.contentType,
    ...(file.sizes ? { sizes: file.sizes } : {}),
  }
}

export function staticMetadataOutputFile(outPath: string, file: StaticMetadataFile) {
  return path.join(outPath, 'public', file.outputPath)
}

export function metadataHasOwnImages(metadata: Metadata, field: 'openGraph' | 'twitter') {
  const value = metadata[field]
  return Boolean(
    value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'images'),
  )
}

function staticMetadataFile(appPath: string, file: string): StaticMetadataFile | undefined {
  const relative = toPosixPath(path.relative(appPath, file))
  const name = path.basename(relative)
  if (name.endsWith('.alt.txt')) return undefined
  const dir = path.dirname(relative) === '.' ? '' : path.dirname(relative)
  const root = dir === ''
  const routeSegments = routeSegmentsForDir(dir)
  const outputDir = outputDirForDir(dir)
  const kind = metadataKind(name, root)
  if (!kind) return undefined
  const info = imageInfo(file)
  if (kind === 'favicon' && !info) {
    throw new Error(`Error: Process image "/${relative}" failed: unable to decode image data`)
  }
  const alt = metadataAltText(file)
  const outputName = metadataOutputName(name, kind, dir)
  return {
    kind,
    file,
    relative,
    outputPath: toPosixPath(path.join(outputDir, outputName)),
    routeSegments,
    contentType: contentTypeForFile(name),
    ...(kind === 'manifest' ? {} : { cacheIdentity: metadataFileIdentity(file) }),
    ...(info?.width ? { width: info.width } : {}),
    ...(info?.height ? { height: info.height } : {}),
    ...(info?.sizes ? { sizes: info.sizes } : {}),
    ...(alt ? { alt } : {}),
  }
}

function metadataKind(name: string, root: boolean): StaticMetadataKind | undefined {
  if (name === 'favicon.ico') return root ? 'favicon' : undefined
  if (iconPattern.test(name)) return 'icon'
  if (appleIconPattern.test(name)) return 'apple-icon'
  if (openGraphPattern.test(name)) return 'opengraph-image'
  if (twitterPattern.test(name)) return 'twitter-image'
  if (name === 'robots.txt') return root ? 'robots' : undefined
  if (name === 'sitemap.xml') return 'sitemap'
  if (name === 'manifest.webmanifest') return root ? 'manifest' : undefined
  if (name === 'manifest.json') return root ? 'manifest' : undefined
  return undefined
}

function metadataOutputName(name: string, kind: StaticMetadataKind, relativeDir: string) {
  if (!metadataUsesSegmentSuffix(kind)) return name
  const suffix = metadataRouteSuffix(relativeDir)
  if (!suffix) return name
  const extension = path.extname(name)
  return `${name.slice(0, -extension.length)}-${suffix}${extension}`
}

function metadataUsesSegmentSuffix(kind: StaticMetadataKind) {
  return (
    kind === 'icon' ||
    kind === 'apple-icon' ||
    kind === 'opengraph-image' ||
    kind === 'twitter-image'
  )
}

function metadataRouteSuffix(relativeDir: string) {
  if (!relativeDir) return ''
  const segments = relativeDir.split('/').filter(Boolean)
  if (!segments.some(segment => isRouteGroup(segment) || isSlotSegment(segment))) return ''
  return djb2Hash(`/${relativeDir}`).toString(36).slice(0, 6)
}

function metadataImage(file: StaticMetadataFile): MetadataImage {
  return {
    url: staticMetadataUrl(file),
    ...(file.width ? { width: file.width } : {}),
    ...(file.height ? { height: file.height } : {}),
    ...(file.alt ? { alt: file.alt } : {}),
    type: file.contentType,
  }
}

function staticMetadataUrl(file: StaticMetadataFile) {
  // File-convention images carry their content identity in the query so an
  // image replacement cannot be served from an old browser cache. Manifests
  // are the one non-image convention represented by this type.
  if (file.kind === 'manifest') return `/${file.outputPath}`
  return `/${file.outputPath}?${file.kind}.${file.cacheIdentity}.${path.extname(file.outputPath).slice(1)}`
}

function metadataFileIdentity(file: string) {
  return createHash('sha256').update(readFileSync(file)).digest('base64url').slice(0, 16)
}

function nearestFile(files: StaticMetadataFile[], kind: StaticMetadataKind) {
  return nearestFiles(files, kind)[0]
}

function nearestFiles(files: StaticMetadataFile[], kind: StaticMetadataKind) {
  const matches = files.filter(file => file.kind === kind)
  const maxDepth = Math.max(-1, ...matches.map(file => file.routeSegments.length))
  return matches.filter(file => file.routeSegments.length === maxDepth)
}

function metadataAppliesToPath(file: StaticMetadataFile, pathname: string) {
  if (file.kind === 'favicon') return file.routeSegments.length === 0
  const segments = pathname
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean)
  if (file.routeSegments.length > segments.length) return false
  return file.routeSegments.every((segment, index) => {
    if (segment === '*') return true
    if (segment.startsWith(':')) return Boolean(segments[index])
    return segment === segments[index]
  })
}

function metadataAppliesToRoute(file: StaticMetadataFile, routeDir: string) {
  const dir = path.dirname(file.relative) === '.' ? '' : path.dirname(file.relative)
  if (!dir) return false
  return routeDir === dir || routeDir.startsWith(`${dir}/`)
}

function discoverDynamicMetadataFiles(appPath: string): DynamicMetadataFile[] {
  const cached = dynamicMetadataFiles.get(appPath)
  if (cached) return cached
  const files = existsSync(appPath)
    ? listFilesSync(appPath)
        .flatMap(file => dynamicMetadataFile(appPath, file) ?? [])
        .sort((a, b) => a.relative.localeCompare(b.relative))
    : []
  dynamicMetadataFiles.set(appPath, files)
  return files
}

function dynamicMetadataFile(appPath: string, file: string): DynamicMetadataFile | undefined {
  const relative = toPosixPath(path.relative(appPath, file))
  const name = path.basename(relative)
  const extension = path.extname(name).slice(1)
  if (!(metadataCodeExtensions as readonly string[]).includes(extension)) return undefined
  const dir = path.dirname(relative) === '.' ? '' : path.dirname(relative)
  const root = dir === ''
  const base = name.slice(0, -(extension.length + 1))
  const kind = dynamicMetadataKind(base, root)
  if (!kind) return undefined
  return {
    kind,
    file,
    relative,
    dir,
    routeSegments: routeSegmentsForDir(dir),
    base,
  }
}

const metadataCodeExtensions = ['tsx', 'ts', 'jsx', 'js', 'mjs'] as const

function dynamicMetadataKind(base: string, root: boolean): MetadataRouteKind | undefined {
  if (base === 'robots') return root ? 'robots' : undefined
  if (base === 'sitemap') return 'sitemap'
  if (base === 'manifest') return root ? 'manifest' : undefined
  if (/^icon\d*$/.test(base)) return 'icon'
  if (/^apple-icon\d*$/.test(base)) return 'apple-icon'
  if (/^opengraph-image\d*$/.test(base)) return 'opengraph-image'
  if (/^twitter-image\d*$/.test(base)) return 'twitter-image'
  return undefined
}

function metadataImageKind(kind: MetadataRouteKind) {
  return (
    kind === 'icon' ||
    kind === 'apple-icon' ||
    kind === 'opengraph-image' ||
    kind === 'twitter-image'
  )
}

function matchDynamicMetadataFile(
  file: DynamicMetadataFile,
  pathname: string,
  routeDir: string,
): MatchedDynamicMetadataFile | undefined {
  const match = matchDynamicMetadataDir(file.dir, pathname)
  const routeMatch = dynamicMetadataAppliesToRoute(file.dir, routeDir)
  if (!match) return undefined
  if (hasHiddenSegments(file.dir) && !routeMatch && file.routeSegments.length === 0) {
    return undefined
  }
  return {
    ...file,
    params: match.params,
    routePath: dynamicMetadataRoutePath(file, match.params),
    specificity: file.dir.split('/').filter(Boolean).length + (routeMatch ? 1000 : 0),
  }
}

function matchDynamicMetadataDir(
  relativeDir: string,
  pathname: string,
): { params: Record<string, RouteParamValue> } | undefined {
  const routeSegments = relativeDir
    .split('/')
    .filter(segment => segment && !isRouteGroup(segment) && !isSlotSegment(segment))
  const pathSegments = pathname
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean)
  if (routeSegments.length > pathSegments.length) return undefined

  const params: Record<string, RouteParamValue> = {}
  for (let index = 0; index < routeSegments.length; index += 1) {
    const routeSegment = routeSegments[index]!
    const pathSegment = decodeURIComponent(pathSegments[index] ?? '')
    const catchAll = /^\[\.\.\.([^\]]+)\]$/.exec(routeSegment)
    if (catchAll) {
      params[catchAll[1]!] = pathSegments.slice(index).map(decodeURIComponent)
      return { params }
    }
    const optionalCatchAll = /^\[\[\.\.\.([^\]]+)\]\]$/.exec(routeSegment)
    if (optionalCatchAll) {
      const values = pathSegments.slice(index).map(decodeURIComponent)
      if (values.length > 0) params[optionalCatchAll[1]!] = values
      return { params }
    }
    const dynamic = /^\[([^\]]+)\]$/.exec(routeSegment)
    if (dynamic) {
      if (!pathSegment) return undefined
      params[dynamic[1]!] = pathSegment
      continue
    }
    if (routeSegment !== pathSegment) return undefined
  }
  return { params }
}

function dynamicMetadataAppliesToRoute(relativeDir: string, routeDir: string) {
  if (!relativeDir) return routeDir === ''
  return routeDir === relativeDir || routeDir.startsWith(`${relativeDir}/`)
}

function hasHiddenSegments(relativeDir: string) {
  return relativeDir.split('/').some(segment => isRouteGroup(segment) || isSlotSegment(segment))
}

function dynamicMetadataRoutePath(
  file: DynamicMetadataFile,
  params: Record<string, RouteParamValue>,
) {
  if (file.kind === 'robots') return '/robots.txt'
  if (file.kind === 'manifest') return '/manifest.webmanifest'
  if (file.kind === 'sitemap')
    return `/${joinUrlPath(dynamicMetadataOutputDir(file.dir, params), 'sitemap.xml').replace(/^\/+/, '')}`

  const suffix = metadataRouteSuffix(file.dir)
  const base = suffix ? `${file.base}-${suffix}` : file.base
  return joinUrlPath(dynamicMetadataOutputDir(file.dir, params), base)
}

function dynamicMetadataOutputDir(relativeDir: string, params: Record<string, RouteParamValue>) {
  return relativeDir
    .split('/')
    .filter(segment => segment && !isRouteGroup(segment) && !isSlotSegment(segment))
    .flatMap(segment => {
      const catchAll = /^\[\.\.\.([^\]]+)\]$/.exec(segment)
      const optionalCatchAll = /^\[\[\.\.\.([^\]]+)\]\]$/.exec(segment)
      const dynamic = /^\[([^\]]+)\]$/.exec(segment)
      const key = catchAll?.[1] ?? optionalCatchAll?.[1] ?? dynamic?.[1]
      if (!key) return [segment]
      const value = params[key]
      if (value === undefined) return []
      return Array.isArray(value) ? value : [value]
    })
    .join('/')
}

function bestDynamicFiles(files: MatchedDynamicMetadataFile[], kind: MetadataRouteKind) {
  const matches = files.filter(file => file.kind === kind)
  const specificity = Math.max(-1, ...matches.map(file => file.specificity))
  return matches.filter(file => file.specificity === specificity)
}

async function dynamicImageLinks(
  files: MatchedDynamicMetadataFile[],
  loadModule: MetadataModuleLoader,
  rel: string,
): Promise<MetadataLink[]> {
  const links: MetadataLink[] = []
  for (const file of files) {
    const module = (await loadModule(file.file)) as DynamicMetadataModule
    for (const image of await dynamicImageEntries(file, module)) {
      links.push({
        rel,
        url: image.url,
        type: image.type,
        ...(image.sizes ? { sizes: image.sizes } : {}),
      })
    }
  }
  return links
}

async function dynamicMetadataImages(
  files: MatchedDynamicMetadataFile[],
  loadModule: MetadataModuleLoader,
): Promise<MetadataImage[]> {
  const images: MetadataImage[] = []
  for (const file of files) {
    const module = (await loadModule(file.file)) as DynamicMetadataModule
    for (const image of await dynamicImageEntries(file, module)) {
      images.push({
        url: image.url,
        type: image.type,
        ...(image.width ? { width: image.width } : {}),
        ...(image.height ? { height: image.height } : {}),
        ...(image.alt ? { alt: image.alt } : {}),
      })
    }
  }
  return images
}

interface DynamicImageEntry {
  url: string
  type: string
  width?: string
  height?: string
  sizes?: string
  alt?: string
}

async function dynamicImageEntries(
  file: MatchedDynamicMetadataFile,
  module: DynamicMetadataModule,
): Promise<DynamicImageEntry[]> {
  const generated =
    metadataImageKind(file.kind) && module.generateImageMetadata
      ? await metadataGeneratedEntries(module, { kind: file.kind }, file.params)
      : []
  const entries = generated.length > 0 ? generated : [undefined]
  return entries.map(entry => {
    const id = entry ? coerceString(entry.id) : undefined
    const size = dynamicImageSize(entry?.size) ?? dynamicImageSize(module.size)
    const type =
      (entry && typeof entry.contentType === 'string' ? entry.contentType : undefined) ??
      module.contentType ??
      'image/png'
    const routePath = id ? joinUrlPath(file.routePath, encodeURIComponent(id)) : file.routePath
    return {
      url: `${routePath}?metadata`,
      type,
      ...(size?.width ? { width: size.width } : {}),
      ...(size?.height ? { height: size.height } : {}),
      ...(size?.sizes ? { sizes: size.sizes } : {}),
      ...(typeof entry?.alt === 'string'
        ? { alt: entry.alt }
        : typeof module.alt === 'string'
          ? { alt: module.alt }
          : {}),
    }
  })
}

function dynamicImageSize(value: unknown) {
  if (!isRecord(value)) return undefined
  const width = value.width === undefined ? undefined : coerceString(value.width)
  const height = value.height === undefined ? undefined : coerceString(value.height)
  return {
    width,
    height,
    ...(width && height ? { sizes: `${width}x${height}` } : {}),
  }
}

function routeSegmentsForDir(relativeDir: string) {
  if (!relativeDir) return []
  return relativeDir
    .split('/')
    .filter(segment => segment && !isRouteGroup(segment) && !isSlotSegment(segment))
    .map(segment => {
      if (/^\[\[\.\.\.[^\]]+\]\]$/.test(segment)) return '*'
      if (/^\[\.\.\.[^\]]+\]$/.test(segment)) return '*'
      if (/^\[[^\]]+\]$/.test(segment)) return `:${segment.slice(1, -1)}`
      return segment
    })
}

function outputDirForDir(relativeDir: string) {
  if (!relativeDir) return ''
  return toPosixPath(
    relativeDir
      .split('/')
      .filter(segment => segment && !isRouteGroup(segment) && !isSlotSegment(segment))
      .map(segment => (segment.startsWith('[') && segment.endsWith(']') ? '-' : segment))
      .join('/'),
  )
}

function isRouteGroup(segment: string) {
  return segment.startsWith('(') && segment.endsWith(')')
}

function isSlotSegment(segment: string) {
  return segment.startsWith('@')
}

function metadataAltText(file: string) {
  const extension = path.extname(file)
  const altFile = `${file.slice(0, -extension.length)}.alt.txt`
  if (!existsSync(altFile)) return undefined
  return readFileSync(altFile, 'utf8').trim() || undefined
}

function imageInfo(file: string): { width?: number; height?: number; sizes?: string } | undefined {
  const extension = path.extname(file).toLowerCase()
  if (extension === '.svg') return { sizes: 'any' }
  const bytes = readFileSync(file)
  const png = pngInfo(bytes)
  if (png) return png
  if (extension === '.png') return pngInfo(bytes)
  if (extension === '.ico') return icoInfo(bytes)
  return undefined
}

function pngInfo(bytes: Buffer): { width?: number; height?: number; sizes?: string } | undefined {
  if (
    bytes.length < 24 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  ) {
    return undefined
  }
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  return { width, height, sizes: `${width}x${height}` }
}

function icoInfo(bytes: Buffer): { width?: number; height?: number; sizes?: string } | undefined {
  if (bytes.length < 22) return undefined
  if (bytes.readUInt16LE(0) !== 0) return undefined
  const type = bytes.readUInt16LE(2)
  if (type !== 1 && type !== 2) return undefined
  if (bytes.readUInt16LE(4) < 1) return undefined
  const width = bytes[6] === 0 ? 256 : bytes[6]
  const height = bytes[7] === 0 ? 256 : bytes[7]
  return { width, height, sizes: `${width}x${height}` }
}

function contentTypeForFile(file: string) {
  const extension = path.extname(file).toLowerCase()
  if (file === 'manifest.json') return 'application/manifest+json'
  if (extension === '.ico') return 'image/x-icon'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.png') return 'image/png'
  if (extension === '.svg') return 'image/svg+xml'
  if (extension === '.gif') return 'image/gif'
  if (extension === '.webp') return 'image/webp'
  if (extension === '.txt') return 'text/plain'
  if (extension === '.xml') return 'application/xml'
  if (extension === '.webmanifest') return 'application/manifest+json'
  return 'application/octet-stream'
}

function listFilesSync(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true })
  return entries.flatMap(entry => {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) return listFilesSync(file)
    return entry.isFile() ? [file] : []
  })
}

function djb2Hash(value: string) {
  let hash = 5381
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) & 0xffffffff
  }
  return hash >>> 0
}

interface DynamicMetadataModule {
  default?: (props?: MetadataRouteProps) => unknown
  generateImageMetadata?: (props: { params: MetadataRouteParams }) => unknown
  generateSitemaps?: (props: { params: MetadataRouteParams }) => unknown
  alt?: string
  size?: { width?: number; height?: number }
  contentType?: string
}

type MetadataRouteParams = Promise<Record<string, RouteParamValue>> &
  Record<string, RouteParamValue>

interface MetadataRouteProps {
  params: MetadataRouteParams
  id?: Promise<string | number> & { valueOf(): string | number; toString(): string }
}

interface DynamicMetadataHandlerModule {
  params?: () => Promise<Record<string, RouteParamValue>[]>
  GET: (
    request: Request,
    context: { params: Promise<Record<string, RouteParamValue>> },
  ) => Promise<Response>
}

export function metadataRouteHandlerModule(
  module: DynamicMetadataModule,
  route: RouteManifestEntry,
): DynamicMetadataHandlerModule | undefined {
  const metadata = route.metadataRoute
  if (!metadata) return undefined

  const handler: DynamicMetadataHandlerModule = {
    GET: async (_request, context) => metadataRouteResponse(module, metadata, await context.params),
  }
  if (metadata.generatedParam) {
    handler.params = () => metadataRouteStaticParams(module, route)
  }
  return handler
}

async function metadataRouteStaticParams(
  module: DynamicMetadataModule,
  route: RouteManifestEntry,
): Promise<Record<string, RouteParamValue>[]> {
  const metadata = route.metadataRoute
  const generatedParam = metadata?.generatedParam
  if (!metadata || !generatedParam) return [{}]
  if (route.params.some(param => param !== generatedParam)) return []
  const entries = await metadataGeneratedEntries(module, metadata, {})
  return entries.map(entry => ({ [generatedParam]: String(entry.id) }))
}

async function metadataRouteResponse(
  module: DynamicMetadataModule,
  metadata: MetadataRouteEntry,
  params: Record<string, RouteParamValue>,
) {
  const generatedParam = metadata.generatedParam
  const metadataId = generatedParam ? coerceRouteParam(params[generatedParam]) : undefined
  const routeParams = generatedParam ? omitKey(params, generatedParam) : params
  const generated = generatedParam
    ? await metadataGeneratedEntries(module, metadata, routeParams)
    : undefined
  const generatedEntry = metadataId
    ? generated?.find(entry => String(entry.id) === metadataId)
    : undefined
  if (generatedParam && !generatedEntry) return new Response('Not Found', { status: 404 })

  if (typeof module.default !== 'function') return new Response('Not Found', { status: 404 })
  const result = await module.default(
    metadataRouteProps(routeParams, metadataRouteId(metadata, metadataId, generatedEntry)),
  )
  return metadataResultResponse(result, metadata, module, generatedEntry)
}

async function metadataGeneratedEntries(
  module: DynamicMetadataModule,
  metadata: MetadataRouteEntry,
  params: Record<string, RouteParamValue>,
): Promise<Record<string, unknown>[]> {
  const result =
    metadata.kind === 'sitemap'
      ? await module.generateSitemaps?.({ params: paramsPromise(params) })
      : await module.generateImageMetadata?.({ params: paramsPromise(params) })
  return Array.isArray(result)
    ? result.filter(
        (entry): entry is Record<string, unknown> => isRecord(entry) && entry.id !== undefined,
      )
    : []
}

function metadataRouteProps(
  params: Record<string, RouteParamValue>,
  id?: string | number,
): MetadataRouteProps {
  return {
    params: paramsPromise(params),
    ...(id !== undefined ? { id: idPromise(id) } : {}),
  }
}

function metadataRouteId(
  metadata: MetadataRouteEntry,
  metadataId: string | undefined,
  generatedEntry: Record<string, unknown> | undefined,
) {
  if (metadata.kind === 'sitemap') return metadataId
  const id = generatedEntry?.id
  return typeof id === 'string' || typeof id === 'number' ? id : metadataId
}

function paramsPromise(params: Record<string, RouteParamValue>) {
  return Object.assign(Promise.resolve(params), params)
}

function idPromise(id: string | number) {
  return Object.assign(Promise.resolve(id), {
    valueOf: () => id,
    toString: () => String(id),
  })
}

function metadataResultResponse(
  result: unknown,
  metadata: MetadataRouteEntry,
  module: DynamicMetadataModule,
  generatedEntry: Record<string, unknown> | undefined,
) {
  if (result instanceof Response) {
    return withMetadataHeaders(
      result,
      metadataContentType(metadata, module, generatedEntry, result.headers.get('content-type')),
    )
  }
  if (metadata.kind === 'robots') {
    return metadataTextResponse(serializeRobots(result), 'text/plain')
  }
  if (metadata.kind === 'sitemap') {
    return metadataTextResponse(serializeSitemap(result), 'application/xml')
  }
  if (metadata.kind === 'manifest') {
    return metadataTextResponse(JSON.stringify(result), 'application/manifest+json')
  }

  const body = metadataBinaryBody(result)
  return new Response(body, {
    headers: metadataHeaders(metadataContentType(metadata, module, generatedEntry)),
  })
}

function withMetadataHeaders(response: Response, contentType: string) {
  const headers = metadataHeaders(contentType, response.headers)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function metadataTextResponse(body: string, contentType: string) {
  return new Response(body, { headers: metadataHeaders(contentType) })
}

function metadataHeaders(contentType: string, base?: Headers) {
  const headers = new Headers(base)
  if (!headers.has('content-type')) headers.set('content-type', contentType)
  // Metadata routes always serve with the revalidating cache-control, even when
  // the underlying result (e.g. an ImageResponse) defaults to an immutable
  // long-lived value — Next overrides it for generated metadata routes.
  headers.set('cache-control', staticMetadataCacheControl)
  return headers
}

function metadataContentType(
  metadata: MetadataRouteEntry,
  module: DynamicMetadataModule,
  generatedEntry?: Record<string, unknown>,
  responseType?: string | null,
) {
  if (responseType) return responseType
  if (metadata.kind === 'robots') return 'text/plain'
  if (metadata.kind === 'sitemap') return 'application/xml'
  if (metadata.kind === 'manifest') return 'application/manifest+json'
  const generatedType = generatedEntry?.contentType
  if (typeof generatedType === 'string') return generatedType
  return module.contentType ?? 'image/png'
}

function metadataBinaryBody(result: unknown): BodyInit {
  if (result instanceof Blob) return result
  if (result instanceof ArrayBuffer) return result
  if (ArrayBuffer.isView(result)) return result as BodyInit
  if (result instanceof ReadableStream) return result
  if (typeof result === 'string') return result
  if (result == null) return new Uint8Array()
  return JSON.stringify(result)
}

function serializeRobots(value: unknown) {
  if (!isRecord(value)) return ''
  const blocks = arrayOf(value.rules).flatMap(rule => (isRecord(rule) ? [robotRule(rule)] : []))
  const footer = [
    ...list(value.host).map(host => `Host: ${host}`),
    ...list(value.sitemap).map(sitemap => `Sitemap: ${sitemap}`),
  ]
  const body = [...blocks, footer.join('\n')].filter(Boolean).join('\n\n')
  if (!body) return ''
  return footer.length > 0 ? `${body}\n` : `${body}\n\n`
}

function robotRule(rule: Record<string, unknown>) {
  const agents = list(rule.userAgent ?? '*')
  const directives: string[] = []
  for (const item of list(rule.allow)) directives.push(`Allow: ${item}`)
  for (const item of list(rule.disallow)) directives.push(`Disallow: ${item}`)
  if (rule.crawlDelay !== undefined)
    directives.push(`Crawl-delay: ${coerceString(rule.crawlDelay)}`)
  return [...agents.map(agent => `User-Agent: ${agent}`), ...directives].join('\n')
}

function serializeSitemap(value: unknown) {
  const entries = Array.isArray(value) ? value : isRecord(value) ? [value] : []
  const usesAlternates = entries.some(entry => isRecord(entry) && isRecord(entry.alternates))
  const usesImages = entries.some(entry => isRecord(entry) && arrayOf(entry.images).length > 0)
  const usesVideos = entries.some(entry => isRecord(entry) && arrayOf(entry.videos).length > 0)
  const attrs = [
    'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
    ...(usesAlternates ? ['xmlns:xhtml="http://www.w3.org/1999/xhtml"'] : []),
    ...(usesImages ? ['xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"'] : []),
    ...(usesVideos ? ['xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"'] : []),
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset ${attrs.join(' ')}>
${entries.flatMap(entry => (isRecord(entry) ? [sitemapUrl(entry)] : [])).join('\n')}
</urlset>
`
}

function sitemapUrl(entry: Record<string, unknown>) {
  const lines = ['<url>', `<loc>${escapeXml(entry.url)}</loc>`]
  if (entry.lastModified)
    lines.push(`<lastmod>${escapeXml(sitemapDate(entry.lastModified))}</lastmod>`)
  if (entry.changeFrequency)
    lines.push(`<changefreq>${escapeXml(entry.changeFrequency)}</changefreq>`)
  if (entry.priority !== undefined) lines.push(`<priority>${escapeXml(entry.priority)}</priority>`)
  const languages = isRecord(entry.alternates) ? entry.alternates.languages : undefined
  if (isRecord(languages)) {
    for (const [language, href] of Object.entries(languages)) {
      lines.push(
        `<xhtml:link rel="alternate" hreflang="${escapeXml(language)}" href="${escapeXml(href)}" />`,
      )
    }
  }
  for (const image of arrayOf(entry.images)) {
    lines.push(sitemapImage(image))
  }
  for (const video of arrayOf(entry.videos)) {
    if (isRecord(video)) lines.push(sitemapVideo(video))
  }
  lines.push('</url>')
  return lines.join('\n')
}

function sitemapImage(image: unknown) {
  const loc = isRecord(image) ? (image.url ?? image.loc ?? image.location) : image
  return `<image:image>\n<image:loc>${escapeXml(loc)}</image:loc>\n</image:image>`
}

function sitemapVideo(video: Record<string, unknown>) {
  const lines = ['<video:video>']
  for (const [key, value] of Object.entries(video)) {
    if (isRecord(value) && 'content' in value) {
      const attrs = Object.entries(value)
        .filter(([name]) => name !== 'content')
        .map(([name, attr]) => ` ${name}="${escapeXml(attr)}"`)
        .join('')
      lines.push(`<video:${key}${attrs}>${escapeXml(value.content)}</video:${key}>`)
    } else {
      lines.push(`<video:${key}>${escapeXml(value)}</video:${key}>`)
    }
  }
  lines.push('</video:video>')
  return lines.join('\n')
}

function sitemapDate(value: unknown) {
  if (value instanceof Date) return value.toISOString()
  return coerceString(value)
}

function escapeXml(value: unknown) {
  return escapeHtml(coerceString(value))
}

function coerceString(value: unknown) {
  return stringifyHtmlValue(value)
}

function list(value: unknown): string[] {
  if (value === undefined || value === null) return []
  return (Array.isArray(value) ? value : [value]).map(coerceString).filter(Boolean)
}

function arrayOf(value: unknown): unknown[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function joinUrlPath(...parts: string[]) {
  const path = parts.filter(Boolean).join('/').replace(/\/+/g, '/')
  return path.startsWith('/') ? path : `/${path}`
}

function coerceRouteParam(value: RouteParamValue | undefined) {
  if (value === undefined) return undefined
  return Array.isArray(value) ? value.join('/') : String(value)
}

function omitKey<T>(value: Record<string, T>, key: string) {
  const next: Record<string, T> = {}
  for (const [name, item] of Object.entries(value)) {
    if (name !== key) next[name] = item
  }
  return next
}
