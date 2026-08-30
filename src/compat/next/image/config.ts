// ---------------------------------------------------------------------------
// Resolved images config (COMPAT).
//
// Mirrors Next's imageConfigDefault, overlaid with the app's next.config
// `images` block (read through the compat config store). Both the optimizer
// endpoint and the next/image component read a single resolved config so the
// srcset the component emits stays in lock-step with the widths the endpoint
// accepts.
// ---------------------------------------------------------------------------

import { getNextConfig } from '../config-loader'

export interface LocalPattern {
  pathname?: string
  search?: string
}

export interface RemotePattern {
  protocol?: string
  hostname?: string
  port?: string
  pathname?: string
  search?: string
}

export interface ResolvedImagesConfig {
  deviceSizes: number[]
  imageSizes: number[]
  /** deviceSizes + imageSizes, sorted ascending (Next's `allSizes`). */
  allSizes: number[]
  qualities: number[] | undefined
  formats: string[]
  path: string
  loader: string
  loaderFile: string
  domains: string[]
  disableStaticImages: boolean
  minimumCacheTTL: number
  maximumRedirects: number
  maximumResponseBody: number
  dangerouslyAllowLocalIP: boolean
  dangerouslyAllowSVG: boolean
  contentSecurityPolicy: string
  contentDispositionType: string
  localPatterns: LocalPattern[] | undefined
  remotePatterns: RemotePattern[]
  unoptimized: boolean
  customCacheHandler: boolean
}

const DEFAULTS = {
  deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
  imageSizes: [32, 48, 64, 96, 128, 256, 384],
  path: '/_next/image',
  loader: 'default',
  loaderFile: '',
  domains: [] as string[],
  disableStaticImages: false,
  minimumCacheTTL: 14400,
  formats: ['image/webp'],
  maximumRedirects: 3,
  maximumResponseBody: 50_000_000,
  dangerouslyAllowLocalIP: false,
  dangerouslyAllowSVG: false,
  contentSecurityPolicy: `script-src 'none'; frame-src 'none'; sandbox;`,
  contentDispositionType: 'attachment',
  localPatterns: undefined as LocalPattern[] | undefined,
  remotePatterns: [] as RemotePattern[],
  qualities: [75] as number[] | undefined,
  unoptimized: false,
  customCacheHandler: false,
} as const

let cached: { key: unknown; value: ResolvedImagesConfig } | undefined

function asNumberArray(value: unknown, fallback: number[]): number[] {
  if (!Array.isArray(value)) return fallback
  const nums = value.filter((v): v is number => typeof v === 'number')
  return nums.length > 0 ? nums : fallback
}

/** The app's resolved images config, defaults overlaid with next.config.images. */
export function getImagesConfig(): ResolvedImagesConfig {
  const raw = getNextConfig().images
  if (cached && cached.key === raw) return cached.value
  const images = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>

  const deviceSizes = asNumberArray(images.deviceSizes, [...DEFAULTS.deviceSizes]).sort(
    (a, b) => a - b,
  )
  const imageSizes = asNumberArray(images.imageSizes, [...DEFAULTS.imageSizes]).sort(
    (a, b) => a - b,
  )
  const qualities =
    images.qualities === undefined
      ? [...(DEFAULTS.qualities ?? [])]
      : asNumberArray(images.qualities, [...(DEFAULTS.qualities ?? [])]).sort((a, b) => a - b)

  const value: ResolvedImagesConfig = {
    deviceSizes,
    imageSizes,
    allSizes: [...deviceSizes, ...imageSizes].sort((a, b) => a - b),
    qualities,
    formats: Array.isArray(images.formats) ? (images.formats as string[]) : [...DEFAULTS.formats],
    path: typeof images.path === 'string' ? images.path : DEFAULTS.path,
    loader: typeof images.loader === 'string' ? images.loader : DEFAULTS.loader,
    loaderFile: typeof images.loaderFile === 'string' ? images.loaderFile : DEFAULTS.loaderFile,
    domains: Array.isArray(images.domains) ? (images.domains as string[]) : [...DEFAULTS.domains],
    disableStaticImages:
      typeof images.disableStaticImages === 'boolean'
        ? images.disableStaticImages
        : DEFAULTS.disableStaticImages,
    minimumCacheTTL:
      typeof images.minimumCacheTTL === 'number'
        ? images.minimumCacheTTL
        : DEFAULTS.minimumCacheTTL,
    maximumRedirects:
      typeof images.maximumRedirects === 'number'
        ? images.maximumRedirects
        : DEFAULTS.maximumRedirects,
    maximumResponseBody:
      typeof images.maximumResponseBody === 'number'
        ? images.maximumResponseBody
        : DEFAULTS.maximumResponseBody,
    dangerouslyAllowLocalIP:
      typeof images.dangerouslyAllowLocalIP === 'boolean'
        ? images.dangerouslyAllowLocalIP
        : DEFAULTS.dangerouslyAllowLocalIP,
    dangerouslyAllowSVG:
      typeof images.dangerouslyAllowSVG === 'boolean'
        ? images.dangerouslyAllowSVG
        : DEFAULTS.dangerouslyAllowSVG,
    contentSecurityPolicy:
      typeof images.contentSecurityPolicy === 'string'
        ? images.contentSecurityPolicy
        : DEFAULTS.contentSecurityPolicy,
    contentDispositionType:
      typeof images.contentDispositionType === 'string'
        ? images.contentDispositionType
        : DEFAULTS.contentDispositionType,
    localPatterns: normalizeLocalPatterns(images.localPatterns),
    remotePatterns: normalizeRemotePatterns(images.remotePatterns),
    unoptimized:
      typeof images.unoptimized === 'boolean' ? images.unoptimized : DEFAULTS.unoptimized,
    customCacheHandler: Boolean(images.customCacheHandler),
  }
  cached = { key: raw, value }
  return value
}

function normalizeLocalPatterns(value: unknown): LocalPattern[] | undefined {
  if (!Array.isArray(value)) return undefined
  const patterns = value.map(entry => {
    if (typeof entry === 'string') return { pathname: entry, search: '' }
    const obj = (entry ?? {}) as Record<string, unknown>
    return {
      pathname: typeof obj.pathname === 'string' ? obj.pathname : undefined,
      search: typeof obj.search === 'string' ? obj.search : undefined,
    }
  })
  // Next implicitly allows statically-imported media once localPatterns is
  // configured, so build-time optimized static images keep loading. Appended to
  // the normalized list so the runtime check and the images-manifest writer
  // share one source of truth.
  patterns.push(
    { pathname: '/_next/static/media/**', search: '' },
    { pathname: '/_next/static/immutable/media/**', search: '' },
  )
  return patterns
}

function normalizeRemotePatterns(value: unknown): RemotePattern[] {
  if (!Array.isArray(value)) return []
  return value.map(entry => {
    // next.config may pass a URL instance (new URL('https://host/**')).
    if (entry instanceof URL) {
      return {
        protocol: entry.protocol.replace(/:$/, ''),
        hostname: entry.hostname,
        ...(entry.port ? { port: entry.port } : {}),
        pathname: entry.pathname,
        search: entry.search,
      }
    }
    const obj = (entry ?? {}) as Record<string, unknown>
    return {
      protocol: typeof obj.protocol === 'string' ? obj.protocol : undefined,
      hostname: typeof obj.hostname === 'string' ? obj.hostname : undefined,
      port: typeof obj.port === 'string' ? obj.port : undefined,
      pathname: typeof obj.pathname === 'string' ? obj.pathname : undefined,
      search: typeof obj.search === 'string' ? obj.search : undefined,
    }
  })
}
