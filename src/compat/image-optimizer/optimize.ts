// ---------------------------------------------------------------------------
// /_next/image optimizer endpoint (COMPAT).
//
// Next-parity implementation of the image optimizer: parameter validation with
// Next's exact 400 messages, local/remote source fetching, magic-byte content
// detection, animated/bypass passthrough, sharp resize + Accept-negotiated
// re-encode, Next's disk-cache layout with MISS/HIT/STALE semantics and
// stale-while-revalidate refresh, and Next's exact response headers
// (Cache-Control, Vary, ETag/304, Content-Disposition, CSP, X-Nextjs-Cache).
//
// Served from the request interceptor registered in ../register-image.ts.
// ---------------------------------------------------------------------------

import path from 'node:path'
import type { ResolvedConfig } from '../../config'
import { getNextConfig } from '../next/config-loader'
import { getImagesConfig, type ResolvedImagesConfig } from '../next/image/config'
import { hasLocalMatch, hasRemoteMatch } from '../next/image/patterns'
import { cacheHandlerGet, cacheHandlerSet, hasCacheHandler } from '../cache/handler'
import {
  ANIMATABLE_TYPES,
  AVIF,
  BYPASS_TYPES,
  JPEG,
  PNG,
  WEBP,
  detectContentType,
  extensionForType,
  isAnimated,
  typeForExtension,
} from './detect'
import {
  IMAGE_CACHE_VERSION,
  getHash,
  imageCacheDir,
  readCacheEntry,
  writeCacheEntry,
  type ImageCacheEntry,
} from './cache'
import {
  ImageError,
  fetchExternalImage,
  fetchInternalImage,
  readPublicFile,
  type ImageUpstream,
} from './source'

type XCacheHeader = 'MISS' | 'HIT' | 'STALE'

interface ImageParams {
  href: string
  isAbsolute: boolean
  isStatic: boolean
  width: number
  quality: number
  mimeType: string
}

interface GeneratedImage {
  buffer: Buffer
  contentType: string
  maxAge: number
  etag: string
  upstreamEtag: string
}

// -- sharp ------------------------------------------------------------------

interface SharpPipeline {
  timeout(options: { seconds: number }): SharpPipeline
  rotate(): SharpPipeline
  resize(
    width: number | null,
    height?: number | null,
    options?: { withoutEnlargement?: boolean },
  ): SharpPipeline
  webp(options: { quality: number }): SharpPipeline
  avif(options: { quality: number; effort?: number }): SharpPipeline
  png(options: { quality: number }): SharpPipeline
  jpeg(options: { quality: number; mozjpeg?: boolean }): SharpPipeline
  toBuffer(): Promise<Buffer>
}

type SharpModule = (input: Buffer | Uint8Array) => SharpPipeline

let sharpPromise: Promise<SharpModule | undefined> | undefined
function loadSharp(): Promise<SharpModule | undefined> {
  if (!sharpPromise) {
    sharpPromise = import('sharp')
      .then(m => ((m as { default?: unknown }).default ?? m) as SharpModule)
      .catch(() => undefined)
  }
  return sharpPromise
}

// -- helpers ----------------------------------------------------------------

const warnedOnce = new Set<string>()
function warnOnce(message: string): void {
  if (warnedOnce.has(message)) return
  warnedOnce.add(message)
  console.warn(message)
}

function badRequest(message: string): Response {
  return new Response(message, { status: 400, headers: { 'content-type': 'text/plain' } })
}

function errorResponse(error: unknown): Response {
  if (error instanceof ImageError) {
    return new Response(error.message, {
      status: error.statusCode,
      headers: { 'content-type': 'text/plain' },
    })
  }
  console.error('image optimizer failed', error)
  return new Response('Internal Server Error', { status: 500 })
}

function getMaxAge(cacheControl: string | null | undefined): number {
  if (!cacheControl) return 0
  for (const directive of cacheControl.split(',')) {
    const [key = '', rawValue] = directive.trim().split('=', 2)
    if (key.toLowerCase() !== 's-maxage' && key.toLowerCase() !== 'max-age') continue
    let value = (rawValue ?? '').toLowerCase()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    const n = parseInt(value, 10)
    if (!isNaN(n)) return n
  }
  return 0
}

/** First configured format the Accept header explicitly names, or '' (keep source format). */
function getSupportedMimeType(formats: string[], accept: string): string {
  for (const format of formats) {
    if (accept.includes(format)) return format
  }
  return ''
}

function getFileNameWithExtension(url: string, contentType: string | null): string {
  const [urlWithoutQueryParams = url] = url.split('?', 1)
  const fileNameWithExtension = urlWithoutQueryParams.split('/').pop()
  if (!contentType || !fileNameWithExtension) return 'image.bin'
  const [fileName = 'image'] = fileNameWithExtension.split('.', 1)
  const extension = extensionForType(contentType) ?? 'bin'
  return `${fileName}.${extension}`
}

function contentDispositionHeader(type: string, fileName: string): string {
  if (/^[\x20-\x7e]*$/.test(fileName) && !fileName.includes('"')) {
    return `${type}; filename="${fileName}"`
  }
  return `${type}; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

// -- validation -------------------------------------------------------------

function validateParams(
  request: Request,
  searchParams: URLSearchParams,
  config: ResolvedImagesConfig,
  basePath: string,
): ImageParams | { errorMessage: string } {
  const url = searchParams.get('url')
  const w = searchParams.get('w')
  const q = searchParams.get('q')

  if (!url) return { errorMessage: '"url" parameter is required' }
  if (url.length > 3072) return { errorMessage: '"url" parameter is too long' }
  if (url.startsWith('//')) {
    return { errorMessage: '"url" parameter cannot be a protocol-relative URL (//)' }
  }

  let href: string
  let isAbsolute: boolean
  if (url.startsWith('/')) {
    href = url
    isAbsolute = false
    let pathname = url.split('?', 1)[0] ?? url
    try {
      pathname = decodeURIComponent(pathname)
    } catch {
      // keep the raw pathname; the regex below still guards the raw form
    }
    if (/\/_next\/image($|\/)/.test(pathname)) {
      return { errorMessage: '"url" parameter cannot be recursive' }
    }
    if (!hasLocalMatch(config.localPatterns, new URL(url, 'http://n'))) {
      return { errorMessage: '"url" parameter is not allowed' }
    }
  } else {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return { errorMessage: '"url" parameter is invalid' }
    }
    href = parsed.toString()
    isAbsolute = true
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { errorMessage: '"url" parameter is invalid' }
    }
    if (!hasRemoteMatch(config.domains, config.remotePatterns, parsed)) {
      return { errorMessage: '"url" parameter is not allowed' }
    }
  }

  if (!w) return { errorMessage: '"w" parameter (width) is required' }
  if (!/^[0-9]+$/.test(w)) {
    return { errorMessage: '"w" parameter (width) must be an integer greater than 0' }
  }
  if (!q) return { errorMessage: '"q" parameter (quality) is required' }
  if (!/^[0-9]+$/.test(q)) {
    return { errorMessage: '"q" parameter (quality) must be an integer between 1 and 100' }
  }

  const width = parseInt(w, 10)
  if (width <= 0 || isNaN(width)) {
    return { errorMessage: '"w" parameter (width) must be an integer greater than 0' }
  }
  const sizes = [...config.deviceSizes, ...config.imageSizes]
  if (!sizes.includes(width)) {
    return { errorMessage: `"w" parameter (width) of ${width} is not allowed` }
  }

  const quality = parseInt(q, 10)
  if (isNaN(quality) || quality < 1 || quality > 100) {
    return { errorMessage: '"q" parameter (quality) must be an integer between 1 and 100' }
  }
  if (config.qualities && !config.qualities.includes(quality)) {
    return { errorMessage: `"q" parameter (quality) of ${q} is not allowed` }
  }

  const mimeType = getSupportedMimeType(config.formats, request.headers.get('accept') ?? '')
  const isStatic =
    url.startsWith(`${basePath}/_next/static/media`) ||
    url.startsWith(`${basePath}/_next/static/immutable/media`)

  return { href, isAbsolute, isStatic, width, quality, mimeType }
}

// -- optimization -----------------------------------------------------------

async function optimizeImage(
  buffer: Buffer,
  contentType: string,
  width: number,
  quality: number,
): Promise<Buffer> {
  const sharp = await loadSharp()
  if (!sharp) throw new Error('sharp is not available')
  let transformer = sharp(buffer)
    .timeout({ seconds: 7 })
    .rotate()
    .resize(width, undefined, { withoutEnlargement: true })
  if (contentType === AVIF) {
    transformer = transformer.avif({ quality: Math.max(quality - 20, 1), effort: 3 })
  } else if (contentType === WEBP) {
    transformer = transformer.webp({ quality })
  } else if (contentType === PNG) {
    transformer = transformer.png({ quality })
  } else if (contentType === JPEG) {
    transformer = transformer.jpeg({ quality, mozjpeg: true })
  }
  return transformer.toBuffer()
}

async function generateImage(
  upstream: ImageUpstream,
  params: ImageParams,
  config: ResolvedImagesConfig,
): Promise<GeneratedImage> {
  const { href, width, quality, mimeType } = params
  const upstreamBuffer = upstream.buffer
  const upstreamEtag = upstream.etag
  const maxAge = Math.max(config.minimumCacheTTL, getMaxAge(upstream.cacheControl))

  const upstreamType = detectContentType(upstreamBuffer)
  if (!upstreamType || !upstreamType.startsWith('image/') || upstreamType.includes(',')) {
    console.error("The requested resource isn't a valid image for", href, 'received', upstreamType)
    throw new ImageError(400, "The requested resource isn't a valid image.")
  }
  if (upstreamType.startsWith('image/svg') && !config.dangerouslyAllowSVG) {
    console.error(
      `The requested resource "${href}" has type "${upstreamType}" but dangerouslyAllowSVG is disabled. Consider adding the "unoptimized" property to the <Image>.`,
    )
    throw new ImageError(400, '"url" parameter is valid but image type is not allowed')
  }
  if (ANIMATABLE_TYPES.includes(upstreamType) && isAnimated(upstreamBuffer)) {
    warnOnce(
      `The requested resource "${href}" is an animated image so it will not be optimized. Consider adding the "unoptimized" property to the <Image>.`,
    )
    return {
      buffer: upstreamBuffer,
      contentType: upstreamType,
      maxAge,
      etag: upstreamEtag,
      upstreamEtag,
    }
  }
  if (BYPASS_TYPES.includes(upstreamType)) {
    return {
      buffer: upstreamBuffer,
      contentType: upstreamType,
      maxAge,
      etag: upstreamEtag,
      upstreamEtag,
    }
  }

  let contentType: string
  if (mimeType) {
    contentType = mimeType
  } else if (extensionForType(upstreamType) && upstreamType !== WEBP && upstreamType !== AVIF) {
    contentType = upstreamType
  } else {
    contentType = JPEG
  }

  try {
    const optimizedBuffer = await optimizeImage(upstreamBuffer, contentType, width, quality)
    return {
      buffer: optimizedBuffer,
      contentType,
      maxAge,
      etag: getHash([optimizedBuffer]),
      upstreamEtag,
    }
  } catch {
    // If optimization fails, fall back to the original image bytes.
    return {
      buffer: upstreamBuffer,
      contentType: upstreamType,
      maxAge: config.minimumCacheTTL,
      etag: upstreamEtag,
      upstreamEtag,
    }
  }
}

// -- cache orchestration ----------------------------------------------------

interface OptimizerImagesConfig extends ResolvedImagesConfig {
  maximumDiskCacheSize: number | undefined
}

function resolveOptimizerConfig(): OptimizerImagesConfig {
  const base = getImagesConfig()
  const raw = (getNextConfig().images ?? {}) as Record<string, unknown>
  return {
    ...base,
    maximumDiskCacheSize:
      typeof raw.maximumDiskCacheSize === 'number' ? raw.maximumDiskCacheSize : undefined,
  }
}

function diskCacheEnabled(config: OptimizerImagesConfig): boolean {
  if (config.customCacheHandler && hasCacheHandler()) return false
  if (config.maximumDiskCacheSize === 0) return false
  const experimental = (getNextConfig().experimental ?? {}) as Record<string, unknown>
  return experimental.isrFlushToDisk !== false
}

async function fetchUpstream(
  params: ImageParams,
  config: OptimizerImagesConfig,
  coreConfig: ResolvedConfig,
  origin: string,
): Promise<ImageUpstream> {
  if (params.isAbsolute) {
    return fetchExternalImage(
      params.href,
      config.dangerouslyAllowLocalIP,
      config.maximumResponseBody,
      config.maximumRedirects,
    )
  }
  const publicFile = await readPublicFile(
    [
      path.join(coreConfig.outPath, 'public'),
      coreConfig.publicPath,
      path.join(coreConfig.root, 'public'),
    ],
    params.href,
  )
  if (publicFile) {
    return {
      buffer: publicFile,
      contentType: null,
      cacheControl: null,
      etag: getHash([publicFile]),
    }
  }
  return fetchInternalImage(params.href, origin, config.maximumResponseBody)
}

async function generateAndStore(
  cacheKey: string,
  params: ImageParams,
  config: OptimizerImagesConfig,
  coreConfig: ResolvedConfig,
  origin: string,
): Promise<ImageCacheEntry & { contentType: string }> {
  const upstream = await fetchUpstream(params, config, coreConfig, origin)
  const image = await generateImage(upstream, params, config)
  const entry: ImageCacheEntry & { contentType: string } = {
    buffer: image.buffer,
    etag: image.etag,
    upstreamEtag: image.upstreamEtag,
    extension: extensionForType(image.contentType) ?? 'bin',
    maxAge: image.maxAge,
    expireAt: Math.max(image.maxAge, config.minimumCacheTTL) * 1000 + Date.now(),
    contentType: image.contentType,
  }
  if (config.customCacheHandler && hasCacheHandler()) {
    const revalidate = Math.max(image.maxAge, config.minimumCacheTTL)
    await cacheHandlerSet(
      cacheKey,
      {
        kind: 'IMAGE',
        buffer: entry.buffer.toString('base64'),
        etag: entry.etag,
        upstreamEtag: entry.upstreamEtag,
        extension: entry.extension,
        revalidate,
      },
      { kind: 'IMAGE' },
    )
  } else if (diskCacheEnabled(config)) {
    await writeCacheEntry(
      imageCacheDir(coreConfig.root),
      cacheKey,
      entry,
      config.maximumDiskCacheSize,
    )
  }
  return entry
}

// Concurrent requests for the same (url, w, q, format) share one upstream
// fetch + optimization; every waiter reports MISS, matching Next.
const inFlight = new Map<string, Promise<ImageCacheEntry & { contentType: string }>>()
// One background stale-refresh per key at a time.
const refreshing = new Set<string>()

async function readCache(
  cacheKey: string,
  config: OptimizerImagesConfig,
  coreConfig: ResolvedConfig,
): Promise<(ImageCacheEntry & { isStale: boolean }) | undefined> {
  if (config.customCacheHandler && hasCacheHandler()) {
    const cached = (await cacheHandlerGet(cacheKey, { kind: 'IMAGE' })) as
      { value?: Record<string, unknown>; lastModified?: number } | undefined
    const value = cached?.value
    if (value?.kind !== 'IMAGE' || typeof value.buffer !== 'string') return undefined
    const revalidate =
      typeof value.revalidate === 'number' ? value.revalidate : config.minimumCacheTTL
    const lastModified = cached?.lastModified ?? Date.now()
    const expireAt = Math.max(revalidate, config.minimumCacheTTL) * 1000 + lastModified
    return {
      buffer: Buffer.from(value.buffer, 'base64'),
      etag: typeof value.etag === 'string' ? value.etag : getHash([value.buffer]),
      upstreamEtag: typeof value.upstreamEtag === 'string' ? value.upstreamEtag : '',
      extension: typeof value.extension === 'string' ? value.extension : 'bin',
      maxAge: revalidate,
      expireAt,
      isStale: expireAt < Date.now(),
    }
  }
  if (!diskCacheEnabled(config)) return undefined
  const entry = await readCacheEntry(imageCacheDir(coreConfig.root), cacheKey)
  if (!entry) return undefined
  return { ...entry, isStale: Date.now() > entry.expireAt }
}

// -- response ---------------------------------------------------------------

function buildResponse(
  request: Request,
  params: ImageParams,
  config: OptimizerImagesConfig,
  buffer: Buffer,
  contentType: string,
  etag: string,
  maxAge: number,
  xCache: XCacheHeader,
): Response {
  const headers = new Headers()
  headers.set('Vary', 'Accept')
  headers.set(
    'Cache-Control',
    params.isStatic
      ? 'public, max-age=315360000, immutable'
      : `public, max-age=${maxAge}, must-revalidate`,
  )
  headers.set('ETag', etag)

  const ifNoneMatch = request.headers.get('if-none-match')
  if (ifNoneMatch && (ifNoneMatch === etag || ifNoneMatch === `"${etag}"`)) {
    headers.set('X-Nextjs-Cache', xCache)
    return new Response(null, { status: 304, headers })
  }

  headers.set('Content-Type', contentType)
  const fileName = getFileNameWithExtension(params.href, contentType)
  headers.set(
    'Content-Disposition',
    contentDispositionHeader(config.contentDispositionType, fileName),
  )
  headers.set('Content-Security-Policy', config.contentSecurityPolicy)
  headers.set('X-Nextjs-Cache', xCache)
  headers.set('Content-Length', String(buffer.byteLength))

  if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
  return new Response(new Uint8Array(buffer), { status: 200, headers })
}

// -- entry point ------------------------------------------------------------

export async function serveImageOptimizer(
  request: Request,
  coreConfig: ResolvedConfig,
): Promise<Response> {
  const config = resolveOptimizerConfig()
  const url = new URL(request.url)
  const basePath = ''

  const paramsResult = validateParams(request, url.searchParams, config, basePath)
  if ('errorMessage' in paramsResult) return badRequest(paramsResult.errorMessage)
  const params = paramsResult

  const cacheKey = getHash([
    IMAGE_CACHE_VERSION,
    params.href,
    params.width,
    params.quality,
    params.mimeType,
  ])
  const origin = url.origin

  try {
    const cached = await readCache(cacheKey, config, coreConfig)
    if (cached && !cached.isStale) {
      return buildResponse(
        request,
        params,
        config,
        cached.buffer,
        typeForExtension(cached.extension) ?? 'application/octet-stream',
        cached.etag,
        cached.maxAge,
        'HIT',
      )
    }
    if (cached) {
      // Serve the stale bytes now, refresh in the background.
      if (!refreshing.has(cacheKey)) {
        refreshing.add(cacheKey)
        void generateAndStore(cacheKey, params, config, coreConfig, origin)
          .catch(() => undefined)
          .finally(() => refreshing.delete(cacheKey))
      }
      return buildResponse(
        request,
        params,
        config,
        cached.buffer,
        typeForExtension(cached.extension) ?? 'application/octet-stream',
        cached.etag,
        cached.maxAge,
        'STALE',
      )
    }

    let pending = inFlight.get(cacheKey)
    if (!pending) {
      pending = generateAndStore(cacheKey, params, config, coreConfig, origin)
      inFlight.set(cacheKey, pending)
      void pending.catch(() => undefined).finally(() => inFlight.delete(cacheKey))
    }
    const entry = await pending
    return buildResponse(
      request,
      params,
      config,
      entry.buffer,
      entry.contentType,
      entry.etag,
      entry.maxAge,
      'MISS',
    )
  } catch (error) {
    return errorResponse(error)
  }
}
