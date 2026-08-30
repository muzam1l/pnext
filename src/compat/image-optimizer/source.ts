// ---------------------------------------------------------------------------
// /_next/image upstream fetching (COMPAT).
//
// Fetches the source image either from a remote origin (manual redirects,
// 7-second timeout, private-IP SSRF guard, response-size cap) or from this
// server itself via a loopback request that forwards no headers (so cookies
// never leak into internal image fetches). Error statuses/messages mirror
// Next's fetchExternalImage / fetchInternalImage exactly.
// ---------------------------------------------------------------------------

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { getHash } from './cache'

export class ImageError extends Error {
  statusCode: number
  constructor(statusCode: number, message: string) {
    super(message)
    // Ensure an error status is used > 400 (Next normalizes 1xx-3xx to 500).
    this.statusCode = statusCode >= 400 ? statusCode : 500
  }
}

export interface ImageUpstream {
  buffer: Buffer
  contentType: string | null
  cacheControl: string | null
  etag: string
}

/** Upstream etag when present (base64url so it is filename-safe), else a content hash. */
export function extractEtag(etag: string | null | undefined, buffer: Buffer): string {
  if (etag) return Buffer.from(etag).toString('base64url')
  return getHash([buffer])
}

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const parts = ip.split('.').map(Number)
    const [a = -1, b = -1] = parts
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    )
  }
  const lower = ip.toLowerCase()
  return (
    lower === '::' ||
    lower === '::1' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb') ||
    lower.startsWith('::ffff:127.') ||
    lower === 'localhost'
  )
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status)
}

async function readBodyWithLimit(
  body: ReadableStream<Uint8Array>,
  maximumResponseBody: number,
  onExceeded: () => never,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let totalSize = 0
  const reader = body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = Buffer.from(value)
    totalSize += chunk.byteLength
    if (totalSize > maximumResponseBody) {
      await reader.cancel().catch(() => undefined)
      onExceeded()
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export async function fetchExternalImage(
  href: string,
  dangerouslyAllowLocalIP: boolean,
  maximumResponseBody: number,
  count: number,
): Promise<ImageUpstream> {
  if (!dangerouslyAllowLocalIP) {
    const { hostname } = new URL(href)
    let ips = [hostname]
    if (!isIP(hostname)) {
      const records = await lookup(hostname, { family: 0, all: true }).catch(() => [
        { address: hostname },
      ])
      ips = records.map(record => record.address)
    }
    const privateIps = ips.filter(ip => isPrivateIp(ip))
    if (privateIps.length > 0) {
      console.error(
        'upstream image',
        href,
        'hostname resolved to private IP',
        JSON.stringify(privateIps),
        'If this is expected and you understand SSRF risk, use images.dangerouslyAllowLocalIP = true to continue.',
      )
      throw new ImageError(400, '"url" parameter is not allowed')
    }
  }

  const res = await fetch(href, {
    signal: AbortSignal.timeout(7_000),
    redirect: 'manual',
  }).catch(err => err as Error)

  if (res instanceof Error) {
    const err = res
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      console.error('upstream image response timed out for', href)
      throw new ImageError(504, '"url" parameter is valid but upstream response timed out')
    }
    throw err
  }

  const locationHeader = res.headers.get('Location')
  if (isRedirect(res.status) && locationHeader && URL.canParse(locationHeader, href)) {
    await res.body?.cancel().catch(() => undefined)
    if (count === 0) {
      console.error('upstream image response had too many redirects', href)
      throw new ImageError(508, '"url" parameter is valid but upstream response is invalid')
    }
    const redirect = new URL(locationHeader, href).href
    return fetchExternalImage(redirect, dangerouslyAllowLocalIP, maximumResponseBody, count - 1)
  }

  if (!res.ok) {
    console.error('upstream image response failed for', href, res.status)
    throw new ImageError(res.status, '"url" parameter is valid but upstream response is invalid')
  }

  if (!res.body) {
    console.error('upstream image response is empty for', href)
    throw new ImageError(400, '"url" parameter is valid but upstream response is invalid')
  }

  const buffer = await readBodyWithLimit(res.body, maximumResponseBody, () => {
    console.error('upstream image response exceeded maximum size for', href)
    throw new ImageError(413, '"url" parameter is valid but upstream response is invalid')
  })

  return {
    buffer,
    contentType: res.headers.get('Content-Type'),
    cacheControl: res.headers.get('Cache-Control'),
    etag: extractEtag(res.headers.get('ETag'), buffer),
  }
}

/**
 * Fetch a local image by looping the request back through this server, so public files, API routes and
 * built static media all resolve the same way they would for a browser. No request headers are
 * forwarded - notably not cookies.
 */
/**
 * Serve a public/ file straight from disk when it exists. Handles URLs whose unicode normalization
 * differs from the on-disk filename (macOS stores NFD, browsers request NFC) - those never match the
 * static file server.
 */
export async function readPublicFile(
  publicDirs: string[],
  href: string,
): Promise<Buffer | undefined> {
  let decoded: string
  try {
    decoded = decodeURIComponent(href.split('?', 1)[0] ?? href)
  } catch {
    return undefined
  }
  if (decoded.includes('..') || decoded.includes('\0')) return undefined
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  for (const dir of publicDirs) {
    for (const form of ['NFC', 'NFD'] as const) {
      const candidate = path.join(dir, ...decoded.normalize(form).split('/').filter(Boolean))
      if (!candidate.startsWith(dir)) continue
      try {
        return await fs.readFile(candidate)
      } catch {
        // try next candidate
      }
    }
  }
  return undefined
}

export async function fetchInternalImage(
  href: string,
  origin: string,
  maximumResponseBody: number,
): Promise<ImageUpstream> {
  try {
    const res = await fetch(new URL(href, origin), {
      redirect: 'follow',
      headers: { 'x-pnext-internal-image': '1' },
    })

    if (!res.body) {
      console.error('internal image response is empty for', href)
      throw new ImageError(400, '"url" parameter is valid but internal response is invalid')
    }
    const buffer = await readBodyWithLimit(res.body, maximumResponseBody, () => {
      console.error('internal image response exceeded maximum size for', href)
      throw new ImageError(413, '"url" parameter is valid but internal response is invalid')
    })
    if (buffer.byteLength === 0) {
      console.error('internal image response is empty for', href)
      throw new ImageError(400, '"url" parameter is valid but internal response is invalid')
    }

    return {
      buffer,
      contentType: res.headers.get('Content-Type'),
      cacheControl: res.headers.get('Cache-Control'),
      etag: extractEtag(res.headers.get('ETag'), buffer),
    }
  } catch (err) {
    if (err instanceof ImageError) throw err
    console.error('upstream image response failed for', href, err)
    throw new ImageError(500, '"url" parameter is valid but upstream response is invalid')
  }
}
