// /_next/image content sniffing (COMPAT). Magic-byte content-type detection, animated-image detection,
// and the content-type/file-extension maps - mirrors Next's detectContentType / is-animated /
// serve-static tables so the optimizer classifies sources (bypass vs optimize vs reject) exactly like
// Next.

export const AVIF = 'image/avif'
export const WEBP = 'image/webp'
export const PNG = 'image/png'
export const JPEG = 'image/jpeg'
export const JXL = 'image/jxl'
export const JP2 = 'image/jp2'
export const HEIC = 'image/heic'
export const GIF = 'image/gif'
export const SVG = 'image/svg+xml'
export const ICO = 'image/x-icon'
export const ICNS = 'image/x-icns'
export const TIFF = 'image/tiff'
export const BMP = 'image/bmp'
export const PDF = 'application/pdf'

/** Animated variants of these are served as-is (never re-encoded). */
export const ANIMATABLE_TYPES = [WEBP, PNG, GIF]
/** Types sharp never re-encodes — passthrough with the original bytes. */
export const BYPASS_TYPES = [SVG, ICO, ICNS, BMP, JXL, HEIC]

const EXTENSION_BY_TYPE: Record<string, string> = {
  [AVIF]: 'avif',
  [WEBP]: 'webp',
  [PNG]: 'png',
  [JPEG]: 'jpeg',
  [JXL]: 'jxl',
  [JP2]: 'jp2',
  [HEIC]: 'heic',
  [GIF]: 'gif',
  [SVG]: 'svg',
  [ICO]: 'ico',
  [ICNS]: 'icns',
  [TIFF]: 'tiff',
  [BMP]: 'bmp',
}

const TYPE_BY_EXTENSION: Record<string, string> = Object.fromEntries(
  Object.entries(EXTENSION_BY_TYPE).map(([type, ext]) => [ext, type]),
)

/** File extension for a content type (Next's getExtension); undefined if unknown. */
export function extensionForType(contentType: string): string | undefined {
  return EXTENSION_BY_TYPE[contentType]
}

/** Content type for a cache-file extension (Next's getContentType). */
export function typeForExtension(extension: string): string | undefined {
  return TYPE_BY_EXTENSION[extension]
}

function startsWithBytes(buffer: Buffer, bytes: number[]): boolean {
  // A zero in the signature is a wildcard byte (Next's convention).
  return bytes.every((b, i) => !b || buffer[i] === b)
}

/**
 * Sniff the image content type from the first bytes of the buffer. Mirrors
 * Next's detectContentType signature table; returns null for non-images and
 * unknown formats.
 */
export function detectContentType(buffer: Buffer): string | null {
  if (buffer.byteLength === 0) return null
  if ([0xff, 0xd8, 0xff].every((b, i) => buffer[i] === b)) return JPEG
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => buffer[i] === b)) {
    return PNG
  }
  if ([0x47, 0x49, 0x46, 0x38].every((b, i) => buffer[i] === b)) return GIF
  if (startsWithBytes(buffer, [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])) {
    return WEBP
  }
  if ([0x3c, 0x3f, 0x78, 0x6d, 0x6c].every((b, i) => buffer[i] === b)) return SVG
  if ([0x3c, 0x73, 0x76, 0x67].every((b, i) => buffer[i] === b)) return SVG
  if (startsWithBytes(buffer, [0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66])) {
    return AVIF
  }
  if ([0x00, 0x00, 0x01, 0x00].every((b, i) => buffer[i] === b)) return ICO
  if ([0x69, 0x63, 0x6e, 0x73].every((b, i) => buffer[i] === b)) return ICNS
  if ([0x49, 0x49, 0x2a, 0x00].every((b, i) => buffer[i] === b)) return TIFF
  if ([0x4d, 0x4d, 0x00, 0x2a].every((b, i) => buffer[i] === b)) return TIFF
  if ([0x42, 0x4d].every((b, i) => buffer[i] === b)) return BMP
  if ([0xff, 0x0a].every((b, i) => buffer[i] === b)) return JXL
  if (
    [0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a].every(
      (b, i) => buffer[i] === b,
    )
  ) {
    return JXL
  }
  if (startsWithBytes(buffer, [0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])) {
    return HEIC
  }
  if ([0x25, 0x50, 0x44, 0x46, 0x2d].every((b, i) => buffer[i] === b)) return PDF
  if (
    [0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a].every(
      (b, i) => buffer[i] === b,
    )
  ) {
    return JP2
  }
  // SVG documents may start with whitespace/comments/doctype before <svg.
  const head = buffer.toString('utf8', 0, Math.min(buffer.length, 512)).trimStart()
  if (/^(<\?xml|<!doctype svg|<svg)/i.test(head)) return SVG
  return null
}

/** True when a gif/apng/webp buffer contains multiple frames (Next's is-animated). */
export function isAnimated(buffer: Buffer): boolean {
  // GIF: more than one Graphics Control Extension block (0x21 0xF9 0x04).
  if (buffer.length > 6 && buffer.toString('ascii', 0, 3) === 'GIF') {
    let frames = 0
    for (let i = 0; i < buffer.length - 2; i++) {
      if (buffer[i] === 0x21 && buffer[i + 1] === 0xf9 && buffer[i + 2] === 0x04) {
        frames++
        if (frames > 1) return true
      }
    }
    return false
  }
  // APNG: an acTL chunk appearing before the first IDAT chunk.
  if (
    buffer.length > 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => buffer[i] === b)
  ) {
    const actl = buffer.indexOf('acTL')
    if (actl === -1) return false
    const idat = buffer.indexOf('IDAT')
    return idat === -1 || actl < idat
  }
  // WebP: an ANIM chunk inside a VP8X container.
  if (
    buffer.length > 16 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return buffer.includes('ANIM')
  }
  return false
}
