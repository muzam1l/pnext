// next/image static-import metadata (COMPAT - may import core freely).
//
// Parses intrinsic width/height straight out of the image file header for the common raster formats
// (PNG / JPEG / GIF / WebP / BMP / AVIF) plus SVG's width/height/viewBox attributes, derives a tiny
// blurDataURL placeholder, and emits the file under `/_next/static/media/<name>.<hash>.<ext>` - the
// exact `StaticImageData` shape next/image expects for `import img from './pic.png'`.
//
// Registered into core's `staticAssetModule` seam so the server module pipeline picks it up. A
// pure-core app keeps core's generic asset behavior instead.

import { createHash } from 'node:crypto'
import path from 'node:path'
import type { StaticAssetModuleContext } from '../../../extensions'
import { isSvgAsComponentEnabled, svgComponentModule } from '../svgr'
import { generateBlurDataURL } from './optimizer'

export interface ImageDimensions {
  width: number
  height: number
}

/** The `{src,width,height,blurDataURL,blurWidth,blurHeight}` shape next/image consumes. */
export interface StaticImageData {
  src: string
  width: number
  height: number
  blurDataURL: string
  blurWidth: number
  blurHeight: number
}

const STATIC_IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.svg',
  '.ico',
  '.bmp',
])

/**
 * Core `staticAssetModule` seam implementation for next/image. Given the source file and bytes plus
 * core's `emit` (which writes under public/ and returns the public URL), returns the ESM module text a
 * static image import evaluates to - or undefined for non-image assets, so core keeps generic handling.
 */
export async function staticImageModule(
  context: StaticAssetModuleContext,
): Promise<string | undefined> {
  const ext = path.extname(context.sourcePath).toLowerCase()
  if (ext === '.svg' && isSvgAsComponentEnabled()) return svgComponentModule(context.bytes)
  if (!STATIC_IMAGE_EXTENSIONS.has(ext)) return undefined
  const src = context.emit(staticMediaRelative(context.sourcePath, context.bytes), context.bytes)
  const data = await staticImageData(src, context.sourcePath, context.bytes)
  return staticImageModuleText(data)
}

/** POSIX-relative `_next/static/media/<name>.<hash>.<ext>` path for an imported image. */
export function staticMediaRelative(sourcePath: string, bytes: Uint8Array): string {
  const ext = path.extname(sourcePath).toLowerCase() || '.bin'
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 8)
  const base = path.basename(sourcePath, path.extname(sourcePath)).replace(/[^A-Za-z0-9_-]+/g, '-')
  return path.posix.join('_next', 'static', 'media', `${base}.${hash}${ext}`)
}

/** Build the full static-image descriptor (real dimensions + blur placeholder). */
export async function staticImageData(
  src: string,
  sourcePath: string,
  bytes: Uint8Array,
): Promise<StaticImageData> {
  const ext = path.extname(sourcePath).toLowerCase() || '.bin'
  const dimensions = imageDimensions(bytes, ext)
  const { blurWidth, blurHeight } = blurDimensions(dimensions)
  const blurDataURL =
    (await generateBlurDataURL(Buffer.from(bytes), ext.slice(1), blurWidth, blurHeight)) ?? ''
  return {
    src,
    width: dimensions?.width ?? 0,
    height: dimensions?.height ?? 0,
    blurDataURL,
    blurWidth: blurDataURL ? blurWidth : 0,
    blurHeight: blurDataURL ? blurHeight : 0,
  }
}

/** ESM module text for a static-image import (default + named field exports). */
export function staticImageModuleText(image: StaticImageData): string {
  return `const image = ${JSON.stringify(image)};
export default image;
export const src = image.src;
export const width = image.width;
export const height = image.height;
export const blurDataURL = image.blurDataURL;
export const blurWidth = image.blurWidth;
export const blurHeight = image.blurHeight;
`
}

const textDecoder = new TextDecoder()

/** Parse intrinsic pixel dimensions from an image file's header bytes. */
export function imageDimensions(bytes: Uint8Array, ext: string): ImageDimensions | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  switch (ext) {
    case '.png':
      return pngDimensions(view)
    case '.jpg':
    case '.jpeg':
      return jpegDimensions(view)
    case '.gif':
      return gifDimensions(view)
    case '.webp':
      return webpDimensions(view, bytes)
    case '.bmp':
      return bmpDimensions(view)
    case '.avif':
      return avifDimensions(bytes)
    case '.svg':
      return svgDimensions(bytes)
    case '.ico':
      return icoDimensions(view)
    default:
      return undefined
  }
}

function pngDimensions(view: DataView): ImageDimensions | undefined {
  // PNG signature (8 bytes) + IHDR chunk: length(4) + 'IHDR'(4) + width(4) + height(4).
  if (view.byteLength < 24) return undefined
  if (view.getUint32(0) !== 0x89504e47) return undefined
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

function jpegDimensions(view: DataView): ImageDimensions | undefined {
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return undefined
  let offset = 2
  while (offset + 9 < view.byteLength) {
    if (view.getUint8(offset) !== 0xff) {
      offset += 1
      continue
    }
    const marker = view.getUint8(offset + 1)
    // SOF0..SOF15 (baseline / progressive) carry the frame dimensions; skip the
    // RST/standalone markers that have no length field.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) }
    }
    const segmentLength = view.getUint16(offset + 2)
    if (segmentLength < 2) return undefined
    offset += 2 + segmentLength
  }
  return undefined
}

function gifDimensions(view: DataView): ImageDimensions | undefined {
  if (view.byteLength < 10) return undefined
  // 'GIF8' magic; logical screen width/height are little-endian at offset 6/8.
  if (view.getUint32(0) !== 0x47494638) return undefined
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
}

function webpDimensions(view: DataView, bytes: Uint8Array): ImageDimensions | undefined {
  if (view.byteLength < 30) return undefined
  // 'RIFF' .... 'WEBP'
  if (view.getUint32(0) !== 0x52494646 || view.getUint32(8) !== 0x57454250) return undefined
  const format = textDecoder.decode(bytes.subarray(12, 16))
  if (format === 'VP8 ') {
    // Lossy: 16-bit width/height (14 low bits) at offset 26/28, little-endian.
    return {
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    }
  }
  if (format === 'VP8L') {
    // Lossless: 14-bit width-1 / height-1 packed after the 0x2f signature byte.
    const bits = view.getUint32(21, true)
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    }
  }
  if (format === 'VP8X') {
    // Extended: 24-bit width-1 / height-1 at offset 24/27, little-endian.
    const width = (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1
    const height = (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1
    return { width, height }
  }
  return undefined
}

function bmpDimensions(view: DataView): ImageDimensions | undefined {
  if (view.byteLength < 26 || view.getUint16(0) !== 0x424d) return undefined
  return { width: view.getInt32(18, true), height: Math.abs(view.getInt32(22, true)) }
}

function icoDimensions(view: DataView): ImageDimensions | undefined {
  if (view.byteLength < 8 || view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) {
    return undefined
  }
  // First directory entry: width/height bytes (0 means 256).
  const width = view.getUint8(6) || 256
  const height = view.getUint8(7) || 256
  return { width, height }
}

function avifDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  // ISOBMFF: find the 'ispe' box (ImageSpatialExtents) → width(4)/height(4).
  const marker = [0x69, 0x73, 0x70, 0x65] // 'ispe'
  for (let i = 0; i + 12 <= bytes.length; i += 1) {
    if (
      bytes[i] === marker[0] &&
      bytes[i + 1] === marker[1] &&
      bytes[i + 2] === marker[2] &&
      bytes[i + 3] === marker[3]
    ) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      // 'ispe' + version/flags(4) then width/height.
      return { width: view.getUint32(i + 8), height: view.getUint32(i + 12) }
    }
  }
  return undefined
}

function svgDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  const head = textDecoder.decode(bytes.subarray(0, Math.min(bytes.length, 4096)))
  const svgTag = /<svg[^>]*>/i.exec(head)?.[0]
  if (!svgTag) return undefined
  const width = svgLength(svgTag, 'width')
  const height = svgLength(svgTag, 'height')
  if (width && height) return { width, height }
  const viewBox = /viewBox\s*=\s*["']?\s*[\d.]+[ ,]+[\d.]+[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(svgTag)
  if (viewBox?.[1] && viewBox[2]) {
    return { width: Math.round(Number(viewBox[1])), height: Math.round(Number(viewBox[2])) }
  }
  return undefined
}

function svgLength(tag: string, attr: string): number | undefined {
  const match = new RegExp(`${attr}\\s*=\\s*["']?\\s*([\\d.]+)`, 'i').exec(tag)
  if (!match?.[1]) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined
}

const BLUR_IMG_SIZE = 8

/**
 * Blur thumbnail dimensions, matching Next's `getBlurImage`: shrink the
 * image's *largest* dimension to 8px and scale the other proportionally
 * (rather than always fixing the width), so portrait images get a
 * `blurWidth < 8` thumbnail instead of a squashed one.
 */
export function blurDimensions(dimensions: ImageDimensions | undefined): {
  blurWidth: number
  blurHeight: number
} {
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
    return { blurWidth: BLUR_IMG_SIZE, blurHeight: BLUR_IMG_SIZE }
  }
  const { width, height } = dimensions
  if (width >= height) {
    return {
      blurWidth: BLUR_IMG_SIZE,
      blurHeight: Math.max(Math.round((height / width) * BLUR_IMG_SIZE), 1),
    }
  }
  return {
    blurWidth: Math.max(Math.round((width / height) * BLUR_IMG_SIZE), 1),
    blurHeight: BLUR_IMG_SIZE,
  }
}
