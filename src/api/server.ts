import { safeDecode } from '../utils/decode'
import { getProxyExtensions, getProxyResponseProtocol } from '../extensions'
import { getBasePathPrefix } from '../routing/href'
import type {
  NextRequest as NextRequestLike,
  NextRequestCookie,
  NextRequestCookies,
  NextURL,
  NextResponseCookies,
} from '../types'

const nextResponseMetaSymbol = Symbol.for('pnext.nextResponse')

export type { NextFetchEvent } from '../types'

export interface NextRequestGeo {
  city?: string
  country?: string
  region?: string
  latitude?: string
  longitude?: string
}

/**
 * Runtime NextRequest for user code that constructs requests, mirroring
 * Next's `new NextRequest(input, init?)`. Internal paths keep augmenting
 * plain Requests via toNextRequest().
 */
export class NextRequest extends Request implements NextRequestLike {
  readonly cookies: NextRequestCookies
  readonly nextUrl: NextURL
  readonly geo?: NextRequestGeo
  readonly ip?: string

  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, init)
    this.cookies = requestCookies(this.headers)
    this.nextUrl = createNextUrl(this.url)
  }
}

export type NextResponseKind = 'next' | 'rewrite'

export interface NextResponseMeta {
  kind: NextResponseKind
  url?: string
  requestHeaders?: Headers
}

type NextResponseInit = ResponseInit & {
  request?: {
    headers?: HeadersInit
  }
}

export class NextResponse extends Response {
  readonly cookies: NextResponseCookies
  readonly [nextResponseMetaSymbol]?: NextResponseMeta

  constructor(body?: BodyInit | null, init?: ResponseInit) {
    super(body, init)
    this.cookies = responseCookies(this.headers)
  }

  static json<JsonBody>(body: JsonBody, init?: ResponseInit) {
    const headers = new Headers(init?.headers)
    if (!headers.has('content-type')) headers.set('content-type', 'application/json')
    return new NextResponse(JSON.stringify(body), {
      ...init,
      headers,
    })
  }

  static next(init?: NextResponseInit) {
    const response = new NextResponse(null, init)
    response.headers.set(getProxyResponseProtocol().nextHeader, '1')
    defineMeta(response, { kind: 'next', ...requestMeta(init) })
    return response
  }

  static rewrite(url: string | URL, init?: NextResponseInit) {
    const response = new NextResponse(null, init)
    response.headers.set(getProxyResponseProtocol().rewriteHeader, String(url))
    defineMeta(response, { kind: 'rewrite', url: String(url), ...requestMeta(init) })
    return response
  }

  static redirect(url: string | URL, init: number | ResponseInit = 307) {
    const responseInit = typeof init === 'number' ? { status: init } : init
    const headers = new Headers(responseInit.headers)
    headers.set('location', String(url))
    return new NextResponse(null, {
      ...responseInit,
      status: responseInit.status ?? 307,
      headers,
    })
  }
}

export function toNextRequest(request: Request): NextRequestLike {
  const nextRequest = request as Partial<NextRequestLike>
  if (nextRequest.cookies && nextRequest.nextUrl) return request as NextRequestLike

  Object.defineProperties(request, {
    cookies: {
      configurable: true,
      enumerable: true,
      value: requestCookies(request.headers),
    },
    nextUrl: {
      configurable: true,
      enumerable: true,
      value: createNextUrl(request.url),
    },
  })
  return request as NextRequestLike
}

export function nextResponseMeta(response: Response): NextResponseMeta | undefined {
  const meta = (response as Response & { [nextResponseMetaSymbol]?: NextResponseMeta })[
    nextResponseMetaSymbol
  ]
  if (meta) return meta

  const protocol = getProxyResponseProtocol()
  const rewrite = response.headers.get(protocol.rewriteHeader)
  if (rewrite) return { kind: 'rewrite', url: rewrite }
  if (response.headers.get(protocol.nextHeader)) return { kind: 'next' }
  return undefined
}

export function copyMiddlewareHeaders(from: Response, to: Response) {
  const internalHeaders = proxyInternalHeaders()
  from.headers.forEach((value, key) => {
    if (internalHeaders.has(key) || key === 'content-length' || key === 'set-cookie') return
    // Vary is merged, never overwritten: the middleware's vary tokens join the
    // handler/page's own (both survive for CDN correctness). Every other header
    // is the middleware's to set.
    if (key === 'vary') mergeVaryInto(to.headers, value)
    else to.headers.set(key, value)
  })
  const middlewareCookies = getSetCookie(from.headers)
  if (middlewareCookies.length === 0) return
  const responseCookies = getSetCookie(to.headers)
  to.headers.delete('set-cookie')
  for (const cookie of middlewareCookies) to.headers.append('set-cookie', cookie)
  for (const cookie of responseCookies) to.headers.append('set-cookie', cookie)
}

// Forward a middleware response's non-internal headers onto the DOWNSTREAM REQUEST (in addition to
// the response). Next applies every non-internal middleware response header to both req.headers and
// the final response, so NextResponse.next({ headers }) values are visible to route handlers and
// pages as request headers. set-cookie is handled separately and never forwarded here.
export function forwardMiddlewareRequestHeaders(from: Response, request: Request): Request {
  const additions: [string, string][] = []
  const internalHeaders = proxyInternalHeaders()
  from.headers.forEach((value, key) => {
    if (internalHeaders.has(key) || key === 'content-length' || key === 'set-cookie') return
    additions.push([key, value])
  })
  if (additions.length === 0) return request
  const headers = new Headers(request.headers)
  for (const [key, value] of additions) headers.set(key, value)
  return new Request(request, { headers })
}

function proxyInternalHeaders() {
  const protocol = getProxyResponseProtocol()
  return new Set([protocol.nextHeader, protocol.rewriteHeader])
}

// Append `value`'s comma-separated tokens to the response's Vary, preserving
// existing tokens and never duplicating (case-insensitive).
function mergeVaryInto(headers: Headers, value: string) {
  const existing = headers.get('vary')
  const seen = new Set(
    (existing ?? '')
      .split(',')
      .map(token => token.trim().toLowerCase())
      .filter(Boolean),
  )
  const merged = existing
    ? existing
        .split(',')
        .map(token => token.trim())
        .filter(Boolean)
    : []
  for (const token of value
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)) {
    if (seen.has(token.toLowerCase())) continue
    seen.add(token.toLowerCase())
    merged.push(token)
  }
  if (merged.length > 0) headers.set('vary', merged.join(', '))
}

function defineMeta(response: NextResponse, meta: NextResponseMeta) {
  Object.defineProperty(response, nextResponseMetaSymbol, {
    configurable: false,
    enumerable: false,
    value: meta,
  })
}

function requestMeta(init: NextResponseInit | undefined): Pick<NextResponseMeta, 'requestHeaders'> {
  return init?.request?.headers ? { requestHeaders: new Headers(init.request.headers) } : {}
}

function createNextUrl(url: string | URL): NextURL {
  const nextUrl = new URL(url) as NextURL
  Object.defineProperty(nextUrl, 'clone', {
    configurable: true,
    enumerable: false,
    value: () => createNextUrl(nextUrl.href),
  })
  // Next's NextURL exposes basePath (the configured prefix, '' when unset) and
  // locale ('' without i18n). The request URL reaching middleware already has
  // any basePath stripped, so pathname stays app-relative while basePath holds
  // the prefix. Defaulting these to strings (never undefined) matches Next, so
  // `req.nextUrl.basePath` reads as a falsy '' rather than the string
  // "undefined" when forwarded through a header.
  nextUrl.basePath = getBasePathPrefix()
  nextUrl.locale = getProxyExtensions().locale(nextUrl)
  return nextUrl
}

function requestCookies(headers: Headers): NextRequestCookies {
  let cookies = parseCookies(headers.get('cookie') ?? '')
  const sync = () => {
    const header = requestCookieHeader(cookies)
    if (header) headers.set('cookie', header)
    else headers.delete('cookie')
  }
  return {
    get(name) {
      return cookies.find(cookie => cookie.name === name)
    },
    getAll(name) {
      return name ? cookies.filter(cookie => cookie.name === name) : [...cookies]
    },
    has(name) {
      return cookies.some(cookie => cookie.name === name)
    },
    set(name, value) {
      cookies = [...cookies.filter(cookie => cookie.name !== name), { name, value }]
      sync()
      return this
    },
    delete(name) {
      const existed = cookies.some(cookie => cookie.name === name)
      cookies = cookies.filter(cookie => cookie.name !== name)
      sync()
      return existed
    },
    clear() {
      cookies = []
      sync()
    },
  }
}

function responseCookies(headers: Headers): NextResponseCookies {
  return {
    set(
      nameOrOptions: string | ResponseCookie,
      value?: string,
      options: ResponseCookieOptions = {},
    ) {
      const cookie: ResponseCookie =
        typeof nameOrOptions === 'string'
          ? { ...options, name: nameOrOptions, value: value ?? '' }
          : nameOrOptions
      headers.append('set-cookie', serializeCookie(cookie.name, cookie.value, cookie))
      return this
    },
    delete(name) {
      headers.append('set-cookie', serializeCookie(name, '', { maxAge: 0, path: '/' }))
      return this
    },
  }
}

interface ResponseCookieOptions {
  path?: string
  maxAge?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'strict' | 'lax' | 'none'
}

interface ResponseCookie extends ResponseCookieOptions {
  name: string
  value: string
}

function serializeCookie(name: string, value: string, options: ResponseCookieOptions) {
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`]
  // Next's ResponseCookies default the cookie path to '/' when unspecified,
  // so a route handler's Set-Cookie is visible to sibling routes/middleware
  // (not scoped to the request path). Match that default.
  parts.push(`Path=${options.path ?? '/'}`)
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`)
  if (options.httpOnly) parts.push('HttpOnly')
  if (options.secure) parts.push('Secure')
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`)
  return parts.join('; ')
}

export function parseCookies(header: string): NextRequestCookie[] {
  return header
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const [key = '', ...rest] = part.split('=')
      return { name: safeDecode(key), value: safeDecode(rest.join('=')) }
    })
}

export function requestCookieHeader(cookies: NextRequestCookie[]) {
  return cookies
    .map(cookie => `${encodeURIComponent(cookie.name)}=${encodeURIComponent(cookie.value)}`)
    .join('; ')
}

export function getSetCookie(headers: Headers) {
  const withSetCookie = headers as Headers & { getSetCookie?: () => string[] }
  return withSetCookie.getSetCookie?.() ?? []
}
