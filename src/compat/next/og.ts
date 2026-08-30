// next/og - ImageResponse (COMPAT).
//
// Renders a JSX element to a PNG the way Next's `next/og` / `@vercel/og` does: satori compiles the
// element tree to an SVG, then @resvg/resvg-js rasterizes it to PNG bytes. Both are optionalDependencies
// - when either is absent (or no usable font is available for satori's text layout) the endpoint falls
// back to a self-contained minimal-but-valid PNG, so it still answers `content-type: image/png` with a
// non-empty body in every runtime.
//
// The Response is constructed synchronously (Response bodies may be a stream), so the async
// satori/resvg pipeline is driven through a ReadableStream that resolves the bytes lazily; the fallback
// path also flows through the stream.

import { createRequire } from 'node:module'
import path from 'node:path'

export interface ImageResponseFont {
  name: string
  data: ArrayBuffer | Uint8Array
  weight?: 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900
  style?: 'normal' | 'italic'
}

export type ImageResponseOptions = ResponseInit & {
  width?: number
  height?: number
  debug?: boolean
  fonts?: ImageResponseFont[]
  emoji?: string
}

const DEFAULT_WIDTH = 1200
const DEFAULT_HEIGHT = 630
const MAX_DIMENSION = 4096
const MAX_RAW_IMAGE_BYTES = 3 * 1024 * 1024
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

let crcTable: Uint32Array | undefined

export class ImageResponse extends Response {
  static displayName = 'ImageResponse'

  constructor(element: unknown, options: ImageResponseOptions = {}) {
    // Validate dimensions eagerly so an invalid width/height throws from the
    // constructor (matching Next), not later inside the async PNG stream — a
    // stream-time RangeError would otherwise surface as a degraded fallback PNG
    // instead of the synchronous error callers assert on.
    dimension(options.width, DEFAULT_WIDTH, 'width')
    dimension(options.height, DEFAULT_HEIGHT, 'height')
    const headers = new Headers(options.headers)
    headers.set('content-type', 'image/png')
    // Match Next's default caching behavior for on-the-fly OG images.
    if (!headers.has('cache-control')) {
      headers.set('cache-control', 'public, immutable, no-transform, max-age=31536000')
    }
    super(pngStream(element, options), {
      status: options.status,
      statusText: options.statusText,
      headers,
    })
  }
}

/**
 * A one-shot ReadableStream that renders the element to PNG bytes. Rendering is
 * async (satori/resvg), so we enqueue inside `start`. Any failure degrades to
 * the deterministic minimal PNG rather than erroring the response.
 */
function pngStream(element: unknown, options: ImageResponseOptions): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let bytes: Uint8Array
      try {
        bytes =
          (await renderWithVercelOg(element, options)) ??
          (await renderWithSatori(element, options)) ??
          createFallbackPng(options)
      } catch {
        bytes = createFallbackPng(options)
      }
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

interface VercelOgModule {
  ImageResponse: new (element: unknown, options?: Record<string, unknown>) => Response
}

/**
 * Preferred path: delegate to the app's own `@vercel/og` (which `next/og` wraps in real Next). It
 * bundles satori, a wasm resvg and a default font, so it produces a real JSX-to-PNG rasterization even
 * when the fixture provides no `fonts` option - satori alone cannot lay out text without one.
 *
 * Resolved from the APP ROOT, not from pnext's own node_modules: the bundled server output lives outside
 * the app tree, so a bare `import('@vercel/og')` would resolve against the wrong node_modules, or not at
 * all. Resolving to an absolute path first keeps the optional dep bound to the user's install.
 */
async function renderWithVercelOg(
  element: unknown,
  options: ImageResponseOptions,
): Promise<Uint8Array | undefined> {
  const og = await loadFromAppRoot<VercelOgModule>('@vercel/og')
  if (!og?.ImageResponse) return undefined

  const width = dimension(options.width, DEFAULT_WIDTH, 'width')
  const height = dimension(options.height, DEFAULT_HEIGHT, 'height')
  const response = new og.ImageResponse(element, {
    width,
    height,
    ...(options.fonts === undefined ? {} : { fonts: options.fonts }),
    ...(options.debug === undefined ? {} : { debug: options.debug }),
    ...(options.emoji === undefined ? {} : { emoji: options.emoji }),
  })
  const bytes = new Uint8Array(await response.arrayBuffer())
  return bytes.length > 0 ? bytes : undefined
}

interface SatoriModule {
  default: (element: unknown, opts: Record<string, unknown>) => Promise<string>
}
interface ResvgModule {
  Resvg: new (
    svg: string | Uint8Array,
    opts?: Record<string, unknown>,
  ) => { render: () => { asPng: () => Uint8Array } }
}

/**
 * Full JSX-to-PNG pipeline via the optional deps. Returns undefined - triggering the fallback - when
 * either dependency or a usable font is missing, since satori cannot lay out text without one.
 */
async function renderWithSatori(
  element: unknown,
  options: ImageResponseOptions,
): Promise<Uint8Array | undefined> {
  const satori = await loadOptional<SatoriModule>('satori')
  const resvg = await loadOptional<ResvgModule>('@resvg/resvg-js')
  if (!satori || !resvg) return undefined

  const fonts = normalizeFonts(options.fonts)
  if (fonts.length === 0) return undefined

  const width = dimension(options.width, DEFAULT_WIDTH, 'width')
  const height = dimension(options.height, DEFAULT_HEIGHT, 'height')

  const svg = await satori.default(element, {
    width,
    height,
    fonts,
    ...(options.debug === undefined ? {} : { debug: options.debug }),
    ...(options.emoji === undefined ? {} : { emoji: options.emoji }),
  })

  const renderer = new resvg.Resvg(svg, {
    fitTo: { mode: 'width', value: width },
  })
  return renderer.render().asPng()
}

interface SatoriFont {
  name: string
  data: ArrayBuffer | Uint8Array
  weight?: number
  style?: 'normal' | 'italic'
}

function normalizeFonts(fonts: ImageResponseFont[] | undefined): SatoriFont[] {
  if (!fonts) return []
  return fonts.map(font => ({
    name: font.name,
    data: font.data,
    ...(font.weight === undefined ? {} : { weight: font.weight }),
    ...(font.style === undefined ? {} : { style: font.style }),
  }))
}

/**
 * Resolve an optional dependency without letting a missing module become a hard
 * build/runtime error. The dynamic specifier is opaque to the bundler so the
 * optional dep is never eagerly required.
 */
async function loadOptional<T>(name: string): Promise<T | undefined> {
  try {
    const specifier = name
    return (await import(/* @vite-ignore */ specifier)) as T
  } catch {
    return undefined
  }
}

/**
 * Resolve + import an optional dependency from the APP ROOT (process.cwd(), the
 * pnext server's working dir at runtime), not from the bundled output's
 * location. Mirrors the MDX plugin resolution: createRequire anchored at the
 * project root turns the bare name into an absolute path, which the opaque
 * dynamic import then loads. Returns undefined when the package is not
 * installed in the user's app.
 */
async function loadFromAppRoot<T>(name: string): Promise<T | undefined> {
  try {
    const resolveFrom = createRequire(path.join(process.cwd(), 'pnext-og-resolve.cjs'))
    const resolved = resolveFrom.resolve(name)
    return (await import(/* @vite-ignore */ resolved)) as T
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Fallback: a deterministic, valid 1-bit PNG of the requested dimensions. Not a
// rendering of the element, but a non-empty `image/png` body honoring the
// endpoint contract when satori/resvg (or a font) are unavailable.
// ---------------------------------------------------------------------------

function createFallbackPng(options: ImageResponseOptions) {
  const width = dimension(options.width, DEFAULT_WIDTH, 'width')
  const height = dimension(options.height, DEFAULT_HEIGHT, 'height')
  const rowBytes = Math.ceil(width / 8) + 1
  const rawBytes = rowBytes * height
  if (rawBytes > MAX_RAW_IMAGE_BYTES) {
    throw new RangeError(
      `ImageResponse dimensions ${width}x${height} exceed the lightweight PNG limit.`,
    )
  }

  const ihdr = new Uint8Array(13)
  const ihdrView = new DataView(ihdr.buffer)
  ihdrView.setUint32(0, width)
  ihdrView.setUint32(4, height)
  ihdr[8] = 1

  return concat(
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibStoreZeros(rawBytes)),
    chunk('IEND', new Uint8Array()),
  )
}

function dimension(value: number | undefined, fallback: number, name: string) {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`ImageResponse ${name} must be a positive finite number.`)
  }
  const rounded = Math.floor(value)
  if (rounded > MAX_DIMENSION) {
    throw new RangeError(`ImageResponse ${name} must be ${MAX_DIMENSION} pixels or less.`)
  }
  return rounded
}

function zlibStoreZeros(length: number) {
  const blockCount = Math.max(1, Math.ceil(length / 0xffff))
  const output = new Uint8Array(2 + blockCount * 5 + length + 4)
  output[0] = 0x78
  output[1] = 0x01

  let offset = 2
  let remaining = length
  while (remaining > 0 || offset === 2) {
    const blockLength = Math.min(remaining, 0xffff)
    remaining -= blockLength
    output[offset++] = remaining === 0 ? 0x01 : 0x00
    output[offset++] = blockLength & 0xff
    output[offset++] = (blockLength >> 8) & 0xff
    const inverse = 0xffff - blockLength
    output[offset++] = inverse & 0xff
    output[offset++] = (inverse >> 8) & 0xff
    offset += blockLength
  }

  const adler = ((length % 65521) << 16) | 1
  new DataView(output.buffer).setUint32(output.length - 4, adler)
  return output
}

function chunk(type: string, data: Uint8Array) {
  const output = new Uint8Array(12 + data.length)
  const view = new DataView(output.buffer)
  view.setUint32(0, data.length)
  for (let index = 0; index < 4; index += 1) {
    output[4 + index] = type.charCodeAt(index)
  }
  output.set(data, 8)
  view.setUint32(output.length - 4, crc32(output.subarray(4, output.length - 4)))
  return output
}

function crc32(bytes: Uint8Array) {
  const table = crcTable ?? createCrcTable()
  crcTable = table
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function createCrcTable() {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
}

function concat(...parts: Uint8Array[]) {
  const length = parts.reduce((total, part) => total + part.length, 0)
  const output = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}
