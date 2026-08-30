// testmode / experimental.testProxy (COMPAT).
//
// When a request carries `Next-Test-Proxy-Port` + `Next-Test-Data` headers, all outgoing fetch during
// that request is proxied to the named localhost port following Next's testmode wire protocol. A
// request interceptor stores the proxy info for the duration of the request; global.fetch is patched
// exactly once at init and consults it - a no-op when no proxy info is active. Gated on
// experimental.testProxy in next.config.

import { PassThrough } from 'node:stream'
import type * as http from 'node:http'
import type * as https from 'node:https'
import type { IncomingMessage } from 'node:http'
import { createRequire } from 'node:module'
import { currentRequest, getWorkUnit } from '../../request/context'

// `import * as http` yields a frozen ES module namespace object under strict
// runtimes (Bun); assigning to `.get` on it throws "Attempted to assign to
// readonly property." `require()` returns the real, mutable CJS exports
// object that node/http/https resolve `.get` calls through at runtime, so
// patch that instead of the namespace binding.
const requireNode = createRequire(import.meta.url)
const httpModule = requireNode('node:http') as typeof http
const httpsModule = requireNode('node:https') as typeof https

interface TestProxyInfo {
  proxyPort: number
  testData: string
}

/**
 * The proxy info rides on the core work unit (which spans the whole request lifecycle) rather than a
 * private ALS, so the patched global.fetch - invoked deep inside a render or handler - can recover it
 * via getWorkUnit(). The interceptor sets it before matching; the fetch patch reads it.
 */
const TEST_PROXY_KEY = Symbol.for('pnext.testProxy')

/** Extract proxy info from a request's Next-Test-* headers, if present. */
export function readTestProxyInfo(headers: Headers): TestProxyInfo | undefined {
  const portHeader = headers.get('next-test-proxy-port')
  if (!portHeader) return undefined
  return { proxyPort: Number(portHeader), testData: headers.get('next-test-data') ?? '' }
}

/** Record the request's test-proxy info onto the active work unit (if any). */
export function activateTestProxy(headers: Headers): void {
  const info = readTestProxyInfo(headers)
  if (!info) return
  const unit = getWorkUnit()
  if (!unit) return
  ;(unit.compat ??= {})[TEST_PROXY_KEY] = info
}

function currentTestProxyInfo(): TestProxyInfo | undefined {
  const workUnitInfo = getWorkUnit()?.compat?.[TEST_PROXY_KEY] as TestProxyInfo | undefined
  if (workUnitInfo) return workUnitInfo
  const request = currentRequest()
  if (!request) return undefined
  return readTestProxyInfo(request.headers)
}

// pnext marks its own proxy round-trips via `next.internal` so the patched
// fetch (below) doesn't re-intercept them. The `next` field is typed as
// NextFetchRequestConfig globally, so extend it via intersection rather than
// interface-extends (which errors on the conflicting `next` property).
type InternalInit = RequestInit & { next?: { internal?: boolean } }

interface ProxyFetchRequest {
  testData: string
  api: 'fetch'
  request: {
    url: string
    method: string
    headers: [string, string][]
    body: string | null
    cache: RequestCache
    credentials: RequestCredentials
    integrity: string
    mode: RequestMode
    redirect: RequestRedirect
    referrer: string
    referrerPolicy: ReferrerPolicy
  }
}

async function buildProxyRequest(testData: string, request: Request): Promise<ProxyFetchRequest> {
  return {
    testData,
    api: 'fetch',
    request: {
      url: request.url,
      method: request.method,
      headers: [...Array.from(request.headers), ['next-test-stack', getTestStack()]],
      body: request.body ? Buffer.from(await request.arrayBuffer()).toString('base64') : null,
      cache: request.cache,
      credentials: request.credentials,
      integrity: request.integrity,
      // Bun defaults a Request built from a URL string to mode 'navigate'
      // (undici/browsers use 'cors'). 'navigate' cannot be reconstructed via
      // the Request constructor, so the test proxy's buildRequest() would throw
      // "invalid request mode navigate". Normalize it to the browser default so
      // the proxy can rebuild the forwarded request.
      mode: request.mode === 'navigate' ? 'cors' : request.mode,
      redirect: request.redirect,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
    },
  }
}

function getTestStack(): string {
  let stack = (new Error().stack ?? '').split('\n')
  for (let i = 1; i < stack.length; i++) {
    const line = stack[i]
    if (line && line.length > 0) {
      stack = stack.slice(i)
      break
    }
  }
  stack = stack.filter(item => !item.includes('/next/dist/'))
  stack = stack.slice(0, 5)
  stack = stack.map(line => line.replace('webpack-internal:///(rsc)/', '').trim())
  return stack.join('    ')
}

interface ProxyResponse {
  api: 'continue' | 'abort' | 'unhandled' | 'fetch'
  response?: { status: number; headers: [string, string][]; body: string | null }
}

async function handleProxiedFetch(
  originalFetch: typeof fetch,
  info: TestProxyInfo,
  request: Request,
): Promise<Response> {
  const proxyRequest = await buildProxyRequest(info.testData, request)
  const resp = await originalFetch(`http://localhost:${info.proxyPort}`, {
    method: 'POST',
    body: JSON.stringify(proxyRequest),
    next: { internal: true },
  } as InternalInit)
  if (!resp.ok) throw new Error(`Proxy request failed: ${resp.status}`)
  const proxyResponse = (await resp.json()) as ProxyResponse
  switch (proxyResponse.api) {
    case 'continue':
      return originalFetch(request)
    case 'fetch': {
      const r = proxyResponse.response!
      return new Response(r.body ? Buffer.from(r.body, 'base64') : null, {
        status: r.status,
        headers: new Headers(r.headers),
      })
    }
    default:
      throw new Error(`Proxy request aborted [${request.method} ${request.url}]`)
  }
}

type TestGetCallback = (res: IncomingMessage) => void
type HttpGetInput = Parameters<typeof http.get>[0]

function buildResponseMessage(
  responsePromise: Promise<Response>,
  callback?: TestGetCallback,
): IncomingMessage {
  const stream = new PassThrough()
  const message = stream as unknown as IncomingMessage
  void responsePromise
    .then(async response => {
      const headers: Record<string, string> = {}
      const rawHeaders: string[] = []
      for (const [name, value] of response.headers) {
        headers[name.toLowerCase()] = value
        rawHeaders.push(name, value)
      }
      message.statusCode = response.status
      message.statusMessage = response.statusText
      message.headers = headers
      message.rawHeaders = rawHeaders
      message.complete = true
      callback?.(message)
      const body = await response.arrayBuffer()
      stream.end(Buffer.from(body))
    })
    .catch(error => {
      stream.emit('error', error)
      stream.end()
    })
  return message
}

function getStringForGetInput(input: HttpGetInput): string | undefined {
  if (typeof input === 'string' || input instanceof URL) return input.toString()
  const candidate = input as {
    href?: string
    protocol?: string
    hostname?: string
    host?: string
    path?: string
    pathname?: string
    search?: string
    port?: number | string
  }
  if (typeof candidate.href === 'string' && /^[a-z][a-z\d+.-]*:\/\//i.test(candidate.href))
    return candidate.href
  const protocol = typeof candidate.protocol === 'string' ? candidate.protocol : 'http:'
  const host =
    typeof candidate.host === 'string'
      ? candidate.host
      : typeof candidate.hostname === 'string'
        ? candidate.hostname
        : undefined
  if (!host) return undefined
  const port =
    typeof candidate.port === 'number'
      ? `:${candidate.port}`
      : typeof candidate.port === 'string'
        ? `:${candidate.port}`
        : ''
  const path =
    typeof candidate.path === 'string'
      ? candidate.path
      : typeof candidate.pathname === 'string'
        ? candidate.pathname
        : '/'
  const search = typeof candidate.search === 'string' ? candidate.search : ''
  return `${protocol}//${host}${port}${path}${search}`
}

function patchableGet(originalGet: typeof http.get, originalFetch: typeof fetch): typeof http.get {
  return ((input: HttpGetInput, options?: Parameters<typeof http.get>[1]) => {
    const callback = typeof options === 'function' ? options : undefined
    const url = getStringForGetInput(input)
    const info = currentTestProxyInfo()
    if (!url || !info) {
      if (typeof options === 'function') {
        return originalGet(input, options)
      }
      if (options === undefined) {
        return originalGet(input)
      }
      return originalGet(input, options)
    }
    const request = new Request(url, {
      method:
        typeof options === 'object' &&
        options &&
        'method' in options &&
        typeof options.method === 'string'
          ? options.method
          : 'GET',
      headers:
        typeof options === 'object' && options && 'headers' in options
          ? (options.headers as HeadersInit)
          : undefined,
    })
    return buildResponseMessage(
      handleProxiedFetch(originalFetch, info, request),
      callback,
    ) as unknown as ReturnType<typeof http.get>
  }) as typeof http.get
}

let patched = false

/** Patch global.fetch and node http/https.get once for testmode outgoing requests. */
export function installTestProxyFetch(): void {
  if (patched) return
  patched = true
  const originalFetch = globalThis.fetch.bind(globalThis)

  const testFetch = function testFetch(
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> {
    const nextInit = (init as { next?: { internal?: boolean } } | undefined)?.next
    if (nextInit?.internal) {
      return originalFetch(input, init)
    }
    const info = currentTestProxyInfo()
    if (!info) return originalFetch(input, init)
    return handleProxiedFetch(originalFetch, info, new Request(input, init))
  }
  // Preserve fetch.preconnect (typeof fetch requires it).
  ;(testFetch as typeof fetch).preconnect = originalFetch.preconnect?.bind(originalFetch)
  globalThis.fetch = testFetch as typeof fetch

  const originalHttpGet = httpModule.get
  const originalHttpsGet = httpsModule.get
  httpModule.get = patchableGet(originalHttpGet, originalFetch)
  httpsModule.get = patchableGet(originalHttpsGet, originalFetch)
}
