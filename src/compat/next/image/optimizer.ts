// ---------------------------------------------------------------------------
// next/image optimizer glue (COMPAT).
//
// The full /_next/image endpoint lives in ../../image-optimizer/. This module
// keeps the pieces the rest of the image pipeline uses: the endpoint matcher
// and the build-time blur-placeholder generator for static imports.
// ---------------------------------------------------------------------------

import type { ResolvedImagesConfig } from './config'

export { serveImageOptimizer } from '../../image-optimizer/optimize'

const BLUR_QUALITY = 70

interface SharpPipeline {
  resize(options: { width?: number; height?: number; withoutEnlargement?: boolean }): SharpPipeline
  webp(options: { quality: number }): SharpPipeline
  avif(options: { quality: number }): SharpPipeline
  png(options: { quality: number }): SharpPipeline
  jpeg(options: { quality: number; mozjpeg?: boolean }): SharpPipeline
  toBuffer(): Promise<Buffer>
}

type SharpModule = (input: Buffer | Uint8Array) => SharpPipeline

let sharpPromise: Promise<SharpModule | undefined> | undefined
function loadSharp(): Promise<SharpModule | undefined> {
  if (!sharpPromise) {
    sharpPromise = import('sharp')
      .then(m => (m.default ?? m) as unknown as SharpModule)
      .catch(() => undefined)
  }
  return sharpPromise
}

/** True if this request is for the image optimizer endpoint. */
export function isImageOptimizerRequest(url: URL, config: ResolvedImagesConfig): boolean {
  // `/_next/image/` (trailingSlash: true apps) is served the same as the bare
  // path — the interceptor runs before core's trailing-slash normalization.
  return url.pathname === config.path || url.pathname === `${config.path}/`
}

const VALID_BLUR_EXT = new Set(['jpeg', 'jpg', 'png', 'webp', 'avif'])

/** True for animated webp/gif/avif — Next skips blur-placeholder generation for these. */
function isAnimated(buffer: Buffer): boolean {
  // WebP: an 'ANIM' chunk under a VP8X container.
  if (
    buffer.length > 16 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return buffer.includes(Buffer.from('ANIM', 'ascii'))
  }
  // GIF: more than one image descriptor (0x2C) block before the trailer (0x3B).
  if (buffer.length > 6 && buffer.toString('ascii', 0, 3) === 'GIF') {
    let frames = 0
    for (let i = 6; i < buffer.length; i++) {
      if (buffer[i] === 0x2c) frames++
      if (frames > 1) return true
    }
    return false
  }
  // AVIF: 'avis' major/compatible brand in the ftyp box signals an image sequence.
  if (buffer.length > 16 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    return buffer.toString('ascii', 8, 200).includes('avis')
  }
  return false
}

/**
 * Generate a blur data URL from image bytes (build-time static import blur).
 * Mirrors Next's `getBlurImage`: shrink to an 8px-max thumbnail (aspect-scaled
 * height passed explicitly so sharp's rounding matches Next's), quality 70,
 * mozjpeg for JPEG. Returns undefined for extensions/animated images Next
 * does not generate a placeholder for.
 */
export async function generateBlurDataURL(
  buffer: Buffer,
  ext: string,
  blurWidth: number,
  blurHeight: number,
): Promise<string | undefined> {
  const extension = ext === 'jpg' ? 'jpeg' : ext
  if (!VALID_BLUR_EXT.has(extension) || isAnimated(buffer)) return undefined
  const sharp = await loadSharp()
  if (!sharp) return undefined
  try {
    const pipeline = sharp(buffer).resize({ width: blurWidth, height: blurHeight })
    let out: SharpPipeline
    if (extension === 'png') out = pipeline.png({ quality: BLUR_QUALITY })
    else if (extension === 'webp') out = pipeline.webp({ quality: BLUR_QUALITY })
    else if (extension === 'avif') out = pipeline.avif({ quality: BLUR_QUALITY })
    else out = pipeline.jpeg({ quality: BLUR_QUALITY, mozjpeg: true })
    const resized = await out.toBuffer()
    return `data:image/${extension};base64,${resized.toString('base64')}`
  } catch {
    return undefined
  }
}
