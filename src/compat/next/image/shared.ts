// ---------------------------------------------------------------------------
// Shared next/image URL + srcset logic (COMPAT).
//
// Ports Next's get-img-props / image-loader / image-blur-svg so the rendered
// markup matches Next byte-for-byte where the e2e suites snapshot it.
// ---------------------------------------------------------------------------

import type { ResolvedImagesConfig } from './config'

export const BLUR_IMG_SIZE = 8
export const BLUR_QUALITY = 70

/** Default loader: build the /_next/image optimizer URL. */
export function defaultLoader(
  config: ResolvedImagesConfig,
  src: string,
  width: number,
  quality?: number,
): string {
  const q = findClosestQuality(config, quality)
  return `${config.path}?url=${encodeURIComponent(src)}&w=${width}&q=${q}`
}

/**
 * Coerce the requested quality to the closest allowed value (Next coerces
 * out-of-list qualities to the nearest configured one; default 75).
 */
export function findClosestQuality(config: ResolvedImagesConfig, quality?: number): number {
  const qualities = config.qualities
  if (!qualities || qualities.length === 0) return quality ?? 75
  if (quality === undefined) {
    // Next's default when qualities is configured: 75 if present, else closest to 75.
    return closest(qualities, 75)
  }
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

export interface GenImgAttrsResult {
  src: string
  srcSet: string | undefined
  sizes: string | undefined
}

interface GetWidthsResult {
  widths: number[]
  kind: 'w' | 'x'
}

function getWidths(
  config: ResolvedImagesConfig,
  width: number | undefined,
  sizes: string | undefined,
): GetWidthsResult {
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
  if (typeof width !== 'number') {
    return { widths: deviceSizes, kind: 'w' }
  }
  const widths = [
    ...new Set(
      [width, width * 2].map(w => allSizes.find(p => p >= w) || allSizes[allSizes.length - 1]!),
    ),
  ]
  return { widths, kind: 'x' }
}

/** Build src/srcSet/sizes exactly as Next's generateImgAttrs. */
export function generateImgAttrs(params: {
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
  if (unoptimized) {
    return { src, srcSet: undefined, sizes: undefined }
  }
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

/** Next's getImageBlurSvg — the inline feGaussianBlur SVG placeholder. */
export function getImageBlurSvg(params: {
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
