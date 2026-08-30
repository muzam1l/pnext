import type { JSX } from 'preact'

interface LocalPattern {
  pathname?: string
  search?: string
}

interface RemotePattern {
  protocol?: string
  hostname?: string
  port?: string
  pathname?: string
  search?: string
}

export interface ResolvedImagesConfig {
  deviceSizes: number[]
  imageSizes: number[]
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

declare global {
  var __PNEXT_IMAGE_CONFIG__: ResolvedImagesConfig | undefined
}

// Client-graph bundler defines (see compat/register/bundler.ts). The boolean
// twin gates the branch on a literal so DEFAULT_IMAGES_CONFIG is dropped from
// every client bundle — a `??` against an object define never folds.
declare const __PNEXT_IMAGE_CONFIG_INLINE__: ResolvedImagesConfig
declare const __PNEXT_IMAGE_CONFIG_INLINED__: boolean

const DEFAULT_IMAGES_CONFIG: ResolvedImagesConfig = {
  deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
  imageSizes: [32, 48, 64, 96, 128, 256, 384],
  allSizes: [32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840],
  qualities: [75],
  formats: ['image/webp'],
  path: '/_next/image',
  loader: 'default',
  loaderFile: '',
  domains: [],
  disableStaticImages: false,
  minimumCacheTTL: 14400,
  maximumRedirects: 3,
  maximumResponseBody: 50_000_000,
  dangerouslyAllowLocalIP: false,
  dangerouslyAllowSVG: false,
  contentSecurityPolicy: `script-src 'none'; frame-src 'none'; sandbox;`,
  contentDispositionType: 'attachment',
  localPatterns: undefined,
  remotePatterns: [],
  unoptimized: false,
  customCacheHandler: false,
}

export interface StaticImageData {
  src: string
  width: number
  height: number
  blurDataURL?: string
  blurWidth?: number
  blurHeight?: number
}

type StaticImport = StaticImageData | { default: StaticImageData }

interface LoaderProps {
  src: string
  width: number
  quality?: number
}

export type ImageLoader = (props: LoaderProps) => string

export type ImageProps = Omit<
  JSX.HTMLAttributes<HTMLImageElement>,
  'src' | 'srcset' | 'width' | 'height' | 'loading' | 'ref' | 'alt' | 'style'
> & {
  src: string | StaticImport
  alt?: string
  width?: number | string
  height?: number | string
  fill?: boolean
  loader?: ImageLoader
  quality?: number | string
  priority?: boolean
  /** Preload the image without opting into the `priority` LCP warning gating. */
  preload?: boolean
  loading?: 'lazy' | 'eager'
  placeholder?: 'blur' | 'empty' | `data:image/${string}`
  blurDataURL?: string
  unoptimized?: boolean
  overrideSrc?: string
  sizes?: string
  fetchPriority?: 'high' | 'low' | 'auto'
  decoding?: 'async' | 'auto' | 'sync'
  style?: JSX.CSSProperties | string
  onLoad?: JSX.GenericEventHandler<HTMLImageElement>
  onError?: JSX.GenericEventHandler<HTMLImageElement>
  onLoadingComplete?: (img: HTMLImageElement) => void
  layout?: 'fill' | 'responsive' | 'intrinsic' | 'fixed'
  objectFit?: string
  objectPosition?: string
}

export interface ResolvedImageProps {
  props: Record<string, unknown>
  meta: {
    preload: boolean
    fill: boolean
    unoptimized: boolean
    placeholder: string
    imgAttributes: { src: string; srcSet?: string; sizes?: string }
    /**
     * Serialized style WITHOUT the placeholder background props - what the img should carry once loaded.
     * Set only while a placeholder is applied; the server render stamps it as `data-nimg-ph` so the
     * non-hydrated placeholder script can restore it on load.
     */
    loadedStyle?: string
  }
}

const INVALID_BACKGROUND_SIZE = new Set<string | undefined>([
  '-moz-initial',
  'fill',
  'none',
  'scale-down',
  undefined,
])

function unwrapStaticImport(src: StaticImport): StaticImageData {
  return 'default' in src ? src.default : src
}

function toNumber(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'number') return value
  const n = parseInt(value, 10)
  return Number.isNaN(n) ? undefined : n
}

// The client reads the inlined define, the server the global registerImageExtensions
// sets — both derive from the same resolver, so props cannot drift across hydration.
export function getImagesConfig(): ResolvedImagesConfig {
  return typeof __PNEXT_IMAGE_CONFIG_INLINED__ === 'boolean'
    ? __PNEXT_IMAGE_CONFIG_INLINE__
    : (globalThis.__PNEXT_IMAGE_CONFIG__ ?? DEFAULT_IMAGES_CONFIG)
}

function defaultLoader(
  config: ResolvedImagesConfig,
  src: string,
  width: number,
  quality?: number,
): string {
  const q = findClosestQuality(config, quality)
  return `${config.path}?url=${encodeURIComponent(src)}&w=${width}&q=${q}`
}

export function findClosestQuality(config: ResolvedImagesConfig, quality?: number): number {
  const qualities = config.qualities
  if (!qualities || qualities.length === 0) return quality ?? 75
  if (quality === undefined) return closest(qualities, 75)
  return closest(qualities, quality)
}

function closest(values: number[], target: number): number {
  let best = values[0]!
  let bestDelta = Math.abs(best - target)
  for (const value of values) {
    const delta = Math.abs(value - target)
    if (delta < bestDelta) {
      best = value
      bestDelta = delta
    }
  }
  return best
}

interface GenImgAttrsResult {
  src: string
  srcSet: string | undefined
  sizes: string | undefined
}

function getWidths(
  config: ResolvedImagesConfig,
  width: number | undefined,
  sizes: string | undefined,
): { widths: number[]; kind: 'w' | 'x' } {
  const { deviceSizes, allSizes } = config
  if (sizes) {
    const viewportWidthRe = /(^|\s)(1?\d?\d)vw/g
    const percentSizes: number[] = []
    for (let match; (match = viewportWidthRe.exec(sizes));) {
      percentSizes.push(parseInt(match[2]!, 10))
    }
    if (percentSizes.length) {
      const smallestRatio = Math.min(...percentSizes) * 0.01
      return {
        widths: allSizes.filter(s => s >= deviceSizes[0]! * smallestRatio),
        kind: 'w',
      }
    }
    return { widths: allSizes, kind: 'w' }
  }
  if (typeof width !== 'number') return { widths: deviceSizes, kind: 'w' }
  const widths = [
    ...new Set(
      [width, width * 2].map(w => allSizes.find(p => p >= w) || allSizes[allSizes.length - 1]!),
    ),
  ]
  return { widths, kind: 'x' }
}

function generateImgAttrs(params: {
  config: ResolvedImagesConfig
  src: string
  unoptimized: boolean
  width: number | undefined
  quality: number | undefined
  sizes: string | undefined
  loader: (args: {
    config: ResolvedImagesConfig
    src: string
    width: number
    quality?: number
  }) => string
}): GenImgAttrsResult {
  const { config, src, unoptimized, width, quality, sizes, loader } = params
  if (unoptimized) return { src, srcSet: undefined, sizes: undefined }
  const { widths, kind } = getWidths(config, width, sizes)
  const last = widths.length - 1
  return {
    sizes: !sizes && kind === 'w' ? '100vw' : sizes,
    srcSet: widths
      .map(
        (w, i) =>
          `${loader({ config, src, quality, width: w })} ${kind === 'w' ? w : i + 1}${kind}`,
      )
      .join(', '),
    src: loader({ config, src, quality, width: widths[last]! }),
  }
}

/**
 * Usage gate for the inline blur SVG below - raw template that only `placeholder="blur"` can reach. The
 * bundler defines it to `false` for an app whose source never asks for a blurred placeholder, and the
 * builder is then dead code. Undefined (no define) keeps it, so the gate can only ever remove bytes an
 * app proved it cannot use.
 */
declare const __PNEXT_IMAGE_BLUR__: boolean

function getImageBlurSvg(params: {
  widthInt?: number
  heightInt?: number
  blurWidth?: number
  blurHeight?: number
  blurDataURL: string
  objectFit?: string
}): string {
  const { widthInt, heightInt, blurWidth, blurHeight, blurDataURL, objectFit } = params
  const std = 20
  const svgWidth = blurWidth ? blurWidth * 40 : widthInt
  const svgHeight = blurHeight ? blurHeight * 40 : heightInt
  const viewBox = svgWidth && svgHeight ? `viewBox='0 0 ${svgWidth} ${svgHeight}'` : ''
  const preserveAspectRatio = viewBox
    ? 'none'
    : objectFit === 'contain'
      ? 'xMidYMid'
      : objectFit === 'cover'
        ? 'xMidYMid slice'
        : 'none'
  return `%3Csvg xmlns='http://www.w3.org/2000/svg' ${viewBox}%3E%3Cfilter id='b' color-interpolation-filters='sRGB'%3E%3CfeGaussianBlur stdDeviation='${std}'/%3E%3CfeColorMatrix values='1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 100 -1' result='s'/%3E%3CfeFlood x='0' y='0' width='100%25' height='100%25'/%3E%3CfeComposite operator='out' in='s'/%3E%3CfeComposite in2='SourceGraphic'/%3E%3CfeGaussianBlur stdDeviation='${std}'/%3E%3C/filter%3E%3Cimage width='100%25' height='100%25' x='0' y='0' preserveAspectRatio='${preserveAspectRatio}' style='filter: url(%23b);' href='${blurDataURL}'/%3E%3C/svg%3E`
}

export function getImageProps(imageProps: ImageProps): { props: Record<string, unknown> } {
  const resolved = resolveImageProps(imageProps, getImagesConfig())
  return { props: resolved.props }
}

export function unstable_getImgProps(imageProps: ImageProps) {
  return getImageProps(imageProps)
}

export function resolveImageProps(
  imageProps: ImageProps,
  config: ResolvedImagesConfig,
  blurComplete = false,
  showAltText = false,
): ResolvedImageProps {
  const {
    src: rawSrc,
    alt = '',
    width: widthProp,
    height: heightProp,
    fill: fillProp = false,
    loader,
    quality: qualityProp,
    priority = false,
    preload = false,
    loading,
    placeholder = 'empty',
    blurDataURL: blurDataURLProp,
    unoptimized: unoptimizedProp,
    overrideSrc,
    sizes: sizesProp,
    fetchPriority,
    decoding = 'async',
    style: styleProp,
    layout,
    objectFit,
    objectPosition,
    onLoad: _onLoad,
    onError: _onError,
    onLoadingComplete: _onLoadingComplete,
    ...rest
  } = imageProps

  let fill = fillProp
  let sizes = sizesProp
  let userStyle = normalizeStyle(styleProp)

  if (layout) {
    if (layout === 'fill') fill = true
    const layoutStyle =
      layout === 'intrinsic'
        ? { maxWidth: '100%', height: 'auto' }
        : layout === 'responsive'
          ? { width: '100%', height: 'auto' }
          : undefined
    if (layoutStyle) userStyle = { ...userStyle, ...layoutStyle }
    if (!sizes && (layout === 'responsive' || layout === 'fill')) sizes = '100vw'
  }

  const staticData = rawSrc && typeof rawSrc !== 'string' ? unwrapStaticImport(rawSrc) : undefined
  const src = typeof rawSrc === 'string' ? rawSrc : (staticData?.src ?? '')

  let width = toNumber(widthProp)
  let height = toNumber(heightProp)
  if (staticData) {
    if (width === undefined && height === undefined) {
      width = staticData.width
      height = staticData.height
    } else if (width !== undefined && height === undefined) {
      height = Math.round((staticData.height / staticData.width) * width)
    } else if (height !== undefined && width === undefined) {
      width = Math.round((staticData.width / staticData.height) * height)
    }
  }

  const blurDataURL = blurDataURLProp ?? staticData?.blurDataURL
  const quality = toNumber(qualityProp)
  let unoptimized = Boolean(unoptimizedProp ?? config.unoptimized)
  if (!src || src.startsWith('data:') || src.startsWith('blob:')) unoptimized = true
  // Serve `.svg` as-is instead of proxying through the Image Optimization API,
  // which refuses SVG unless `dangerouslyAllowSVG` is set (otherwise the request
  // 400s and the image never loads, so onLoad/onLoadingComplete never fire).
  // Only applies to the default loader — a custom loader/loaderFile owns SVG.
  const isDefaultLoader = !loader && !config.loaderFile
  if (
    isDefaultLoader &&
    !config.dangerouslyAllowSVG &&
    (src.split('?', 1)[0] ?? '').endsWith('.svg')
  ) {
    unoptimized = true
  }
  if (!unoptimized) validateLocalSrc(config, src)

  const activeLoader: (args: {
    config: ResolvedImagesConfig
    src: string
    width: number
    quality?: number
  }) => string = loader
    ? ({ src: s, width: w, quality: q }) => loader({ src: s, width: w, quality: q })
    : ({ config: c, src: s, width: w, quality: q }) => defaultLoader(c, s, w, q)

  const imgAttrs = generateImgAttrs({
    config,
    src,
    unoptimized,
    width: fill ? undefined : width,
    quality,
    sizes,
    loader: activeLoader,
  })

  const isBlur = placeholder === 'blur' && Boolean(blurDataURL)
  const imgStyle: Record<string, string | number | undefined> = {
    ...(fill ? { ...fillStyle(), objectFit, objectPosition } : {}),
    ...(showAltText ? {} : { color: 'transparent' }),
    ...userStyle,
  }

  const objectFitVal = typeof imgStyle.objectFit === 'string' ? imgStyle.objectFit : undefined
  const backgroundImage =
    !blurComplete && placeholder !== 'empty'
      ? placeholder === 'blur'
        ? // Spelled out here rather than read from a named const: esbuild folds
          // the defined identifier in place, but does not propagate a folded
          // top-level const into this branch, and the const form leaves the
          // whole builder alive (measured — 0 bytes removed).
          (typeof __PNEXT_IMAGE_BLUR__ === 'boolean' ? __PNEXT_IMAGE_BLUR__ : true) && blurDataURL
          ? `url("data:image/svg+xml;charset=utf-8,${getImageBlurSvg({
              widthInt: fill ? undefined : width,
              heightInt: fill ? undefined : height,
              blurWidth: staticData?.blurWidth,
              blurHeight: staticData?.blurHeight,
              blurDataURL,
              objectFit: objectFitVal,
            })}")`
          : undefined
        : `url("${placeholder}")`
      : undefined

  let backgroundSize = 'cover'
  if (objectFitVal === 'fill') backgroundSize = '100% 100%'
  else if (objectFitVal && !INVALID_BACKGROUND_SIZE.has(objectFitVal)) backgroundSize = objectFitVal

  const placeholderStyle: Record<string, string | number> = backgroundImage
    ? {
        backgroundSize,
        backgroundPosition: imgStyle.objectPosition || '50% 50%',
        backgroundRepeat: 'no-repeat',
        backgroundImage,
      }
    : {}

  const style = serializeStyle({ ...imgStyle, ...placeholderStyle })
  const resolvedSrc = (overrideSrc ?? imgAttrs.src) || undefined
  const props: Record<string, unknown> = {
    ...rest,
    alt,
    ...(resolvedSrc !== undefined ? { src: resolvedSrc } : {}),
    ...(imgAttrs.srcSet ? { srcSet: imgAttrs.srcSet } : {}),
    ...(imgAttrs.sizes ? { sizes: imgAttrs.sizes } : {}),
    decoding,
    style,
  }
  if (!fill) {
    if (width !== undefined) props.width = width
    if (height !== undefined) props.height = height
  }
  if (loading !== undefined) props.loading = loading
  else if (!priority && !preload) props.loading = 'lazy'
  if (fetchPriority !== undefined) props.fetchpriority = fetchPriority

  return {
    props,
    meta: {
      preload: preload || priority,
      fill,
      unoptimized,
      placeholder: isBlur ? 'blur' : String(placeholder),
      imgAttributes: {
        src: resolvedSrc ?? '',
        ...(imgAttrs.srcSet ? { srcSet: imgAttrs.srcSet } : {}),
        ...(imgAttrs.sizes ? { sizes: imgAttrs.sizes } : {}),
      },
      ...(backgroundImage ? { loadedStyle: serializeStyle(imgStyle) } : {}),
    },
  }
}

function normalizeStyle(style: JSX.CSSProperties | string | undefined): Record<string, unknown> {
  if (!style) return {}
  if (typeof style !== 'string') return { ...style }
  const out: Record<string, unknown> = {}
  for (const decl of style.split(';')) {
    const [k, v] = decl.split(':')
    if (k && v) out[camel(k.trim())] = v.trim()
  }
  return out
}

function fillStyle(): Record<string, string> {
  return {
    position: 'absolute',
    height: '100%',
    width: '100%',
    left: '0',
    top: '0',
    right: '0',
    bottom: '0',
  }
}

function validateLocalSrc(config: ResolvedImagesConfig, src: string): void {
  if (!src.startsWith('/') || src.startsWith('//') || config.localPatterns !== undefined) return
  const search = new URL(src, 'http://n').search
  if (!search) return
  throw new Error(
    `Image with src "${src}" is using a query string which is not configured in images.localPatterns.\nRead more: https://nextjs.org/docs/messages/next-image-unconfigured-localpatterns`,
  )
}

function camel(prop: string): string {
  return prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

const UNITLESS_STYLE_PROPS = new Set([
  'animationIterationCount',
  'aspectRatio',
  'borderImageOutset',
  'borderImageSlice',
  'borderImageWidth',
  'boxFlex',
  'boxFlexGroup',
  'boxOrdinalGroup',
  'columnCount',
  'columns',
  'flex',
  'flexGrow',
  'flexPositive',
  'flexShrink',
  'flexNegative',
  'flexOrder',
  'gridArea',
  'gridRow',
  'gridRowEnd',
  'gridRowSpan',
  'gridRowStart',
  'gridColumn',
  'gridColumnEnd',
  'gridColumnSpan',
  'gridColumnStart',
  'fontWeight',
  'lineClamp',
  'lineHeight',
  'opacity',
  'order',
  'orphans',
  'tabSize',
  'widows',
  'zIndex',
  'zoom',
  'fillOpacity',
  'floodOpacity',
  'stopOpacity',
  'strokeDasharray',
  'strokeDashoffset',
  'strokeMiterlimit',
  'strokeOpacity',
  'strokeWidth',
])

function serializeStyle(style: Record<string, string | number | undefined>): string {
  return Object.entries(style)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${kebab(k)}:${cssValue(k, v!)}`)
    .join(';')
}

function cssValue(prop: string, value: string | number): string {
  if (typeof value === 'number' && value !== 0 && !UNITLESS_STYLE_PROPS.has(prop))
    return `${value}px`
  return String(value)
}

function kebab(prop: string): string {
  return prop.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)
}
