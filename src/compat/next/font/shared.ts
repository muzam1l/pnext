/**
 * Client-safe font naming/hashing logic shared by the server font runtime
 * (runtime.ts) and the client font runtime (runtime-client.ts).
 *
 * MUST stay free of `node:*` imports (no async_hooks / crypto / fs / module) so
 * it can be pulled into browser bundles. The SHA-256 here is a pure-JS
 * implementation whose hex output is byte-identical to
 * `node:crypto.createHash('sha256').update(value).digest('hex')`, so the
 * className/variable hashes a client component computes match the server's
 * exactly.
 */

export type FontDisplay = 'auto' | 'block' | 'swap' | 'fallback' | 'optional'

export interface GoogleFontOptions {
  axes?: string[]
  adjustFontFallback?: boolean
  display?: FontDisplay
  fallback?: string[]
  preload?: boolean
  subsets?: string[]
  style?: string | string[]
  variable?: string
  weight?: string | string[]
}

export interface LocalFontSource {
  path: string
  style?: string
  weight?: string
}

export interface LocalFontOptions {
  declarations?: { prop: string; value: string }[]
  display?: FontDisplay
  fallback?: string[]
  preload?: boolean
  src: string | LocalFontSource | LocalFontSource[]
  style?: string
  variable?: string
  weight?: string
}

export interface NextFont {
  className: string
  style: {
    fontFamily: string
    fontStyle?: string
    fontWeight?: number | string
  }
}

export interface NextFontWithVariable extends NextFont {
  variable: string
}

/**
 * The pre-hashed identifiers + style a client only ever needs off a font object.
 * Both runtimes derive these from the same inputs, so they agree byte-for-byte.
 */
export interface FontNaming {
  className: string
  variable: string
  style: NextFont['style']
  /** Human-readable CSS family label (single, unquoted). */
  fontFamily: string
  /** 12-char hash used for `__className_<hash>` / `__variable_<hash>`. */
  hash: string
  /** Whether the loader call requested a CSS variable. When false the returned
   * font object omits the `variable` key entirely (Next only exposes it when
   * `variable` was passed). */
  hasVariable: boolean
}

/** Naming for a `next/font/google` loader call: keyed on `{family, options}`. */
export function googleFontNaming(family: string, options: GoogleFontOptions): FontNaming {
  const normalizedKey = stableJson({ family, options })
  const hash = hashString(normalizedKey).slice(0, 12)
  // Next scopes the family to the human-readable font name (`'Inter'`), not a
  // hashed token; only the className/variable identifiers are hashed.
  const fontFamily = family
  return {
    className: `__className_${hash}`,
    variable: `__variable_${hash}`,
    fontFamily,
    hash,
    hasVariable: Boolean(options.variable),
    style: fontStyle(fontFamily, options, options.fallback ?? []),
  }
}

/**
 * Naming for a `next/font/local` loader call: keyed on `{callerFile, options}`.
 * `callerFile` MUST be the same value the server sees (the transform threads it
 * via `withFile(<file>)`), or the hashes diverge.
 */
export function localFontNaming(
  callerFile: string | undefined,
  options: LocalFontOptions,
): FontNaming {
  const normalizedKey = stableJson({ callerFile, options })
  const hash = hashString(normalizedKey).slice(0, 12)
  // Next derives the CSS font-family from the loader call's JS binding
  // (`variableName`). We reproduce the same human-readable label from the
  // (first) source filename stem: `font1_roboto.woff2` -> `font1`.
  const fontFamily = localFontFamilyLabel(options) ?? `local_${hash}`
  return {
    className: `__className_${hash}`,
    variable: `__variable_${hash}`,
    fontFamily,
    hash,
    hasVariable: Boolean(options.variable),
    style: fontStyle(fontFamily, options, options.fallback ?? []),
  }
}

/** Human-readable family label from the first local `src` filename stem. */
export function localFontFamilyLabel(options: LocalFontOptions): string | undefined {
  const first = Array.isArray(options.src) ? options.src[0] : options.src
  const srcPath = typeof first === 'string' ? first : first?.path
  if (!srcPath) return undefined
  const base = srcPath.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
  const stem = base.split('_', 1)[0] ?? base
  return /^[-_a-zA-Z0-9 ]+$/.test(stem) ? stem : undefined
}

export function fontStyle(
  family: string,
  options: GoogleFontOptions | LocalFontOptions,
  fallbackFonts: string[],
): NextFont['style'] {
  // Next exports numeric font-weight and the raw font-style, but only when a
  // single (non-range) value is set on the loader call.
  const weight =
    typeof options.weight === 'string' &&
    !isRangeValue(options.weight) &&
    !Number.isNaN(Number(options.weight))
      ? { fontWeight: Number(cssIdentifier(options.weight)) }
      : {}
  const style =
    typeof options.style === 'string' && !isRangeValue(options.style)
      ? { fontStyle: cssIdentifier(options.style) }
      : {}
  return {
    fontFamily: familyStack(family, fallbackFonts),
    ...weight,
    ...style,
  }
}

/**
 * The full family stack Next writes into `style.fontFamily`: the font, then an
 * `<family> Fallback` metrics-adjusted fallback (adjustFontFallback defaults
 * on), then any user fallbacks. Single-quoted to match Next's postcss output.
 */
export function familyStack(
  family: string,
  fallbackFonts: string[] = [],
  adjustFontFallback = true,
) {
  return [
    singleQuoteFamily(family),
    ...(adjustFontFallback ? [singleQuoteFamily(`${family} Fallback`)] : []),
    ...fallbackFonts.map(singleQuoteFamily),
  ].join(', ')
}

export function singleQuoteFamily(value: string) {
  if (!/^[-_a-zA-Z0-9 ]+$/.test(value)) throw new Error(`Invalid font family: ${value}`)
  return `'${value}'`
}

function cssIdentifier(value: string) {
  if (!/^[-_a-zA-Z0-9. ]+$/.test(value)) throw new Error(`Invalid font option value: ${value}`)
  return value
}

function isRangeValue(value: string) {
  return value.trim().includes(' ')
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortObject(value))
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortObject(item)]),
  )
}

/**
 * SHA-256 hex digest of a UTF-8 string. Pure JS (no `node:crypto`) so this
 * module stays browser-safe; the hex output is byte-identical to
 * `createHash('sha256').update(value).digest('hex')`, keeping client and server
 * font hashes in lock-step.
 */
export function hashString(value: string): string {
  return sha256Hex(utf8Bytes(value))
}

function utf8Bytes(value: string): Uint8Array {
  // TextEncoder is available in browsers and in Node/Bun.
  return new TextEncoder().encode(value)
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function sha256Hex(message: Uint8Array): string {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])

  const bitLen = message.length * 8
  // Padded length: message + 0x80 + zeros + 8-byte length, up to a 64-byte block.
  const padded = new Uint8Array((((message.length + 8) >> 6) + 1) << 6)
  padded.set(message)
  padded[message.length] = 0x80
  // 64-bit big-endian bit length in the final 8 bytes (high 32 bits ~always 0
  // for our short inputs, but write both halves for correctness).
  const dv = new DataView(padded.buffer)
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000))
  dv.setUint32(padded.length - 4, bitLen >>> 0)

  const w = new Uint32Array(64)
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15]!
      const w2 = w[i - 2]!
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }

    let a = h[0]!,
      b = h[1]!,
      c = h[2]!,
      d = h[3]!
    let e = h[4]!,
      f = h[5]!,
      g = h[6]!,
      hh = h[7]!

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }

    h[0] = (h[0]! + a) >>> 0
    h[1] = (h[1]! + b) >>> 0
    h[2] = (h[2]! + c) >>> 0
    h[3] = (h[3]! + d) >>> 0
    h[4] = (h[4]! + e) >>> 0
    h[5] = (h[5]! + f) >>> 0
    h[6] = (h[6]! + g) >>> 0
    h[7] = (h[7]! + hh) >>> 0
  }

  let hex = ''
  for (let i = 0; i < 8; i++) hex += h[i]!.toString(16).padStart(8, '0')
  return hex
}

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0
}
