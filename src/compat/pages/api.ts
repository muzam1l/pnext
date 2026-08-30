// Pages-router API/data serving implementation (COMPAT - may import core freely): Node req/res
// shims plus the API-route and data-fetch (`/_next/data`) dispatch. Registered by
// ../register/pages-api.ts, which wires the exports below into the extension registries.

import { existsSync, readFileSync } from 'node:fs'
import { Writable } from 'node:stream'
import path from 'node:path'
import { devServerModuleHref } from '../../runtime/modules'
import { pagesApiBundleTargetForRuntime } from '../../runtime/loader'
import { getRequestExtensions, type RequestInterceptor } from '../../extensions'
import { getRequestRuntime } from '../../routing/request-environment'
import { selectRouteForRequest } from '../../routing/routes'
import { serverBundleTargetForRuntime } from '../../runtime/loader'
import { setWorkUnitRoute } from '../../request/context'
import { canonicalUrlHref } from '../next/canonical-url'
import { markPathRevalidated, normalizeRevalidatePath } from '../cache/revalidate'
import { withPagesApiHandlerSpan } from '../otel/tracer'
import { toNextRequest } from '../../api/server'

type PagesApiHandler = (req: unknown, res: PagesApiResponse) => Promise<unknown>

interface PagesApiModule {
  default?: PagesApiHandler
}

interface PagesApiResponse {
  statusCode: number
  on(event: 'close' | 'error', listener: (...args: unknown[]) => void): PagesApiResponse
  write(chunk: unknown, encoding?: BufferEncoding, callback?: () => void): boolean
  setHeader(name: string, value: string | number | readonly string[]): PagesApiResponse
  getHeader(name: string): string | null
  status(code: number): PagesApiResponse
  json(value: unknown): PagesApiResponse
  send(value?: unknown): PagesApiResponse
  end(value?: unknown): PagesApiResponse
  revalidate(path: string): Promise<void>
}

const pageExtensions = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'mts']

/** The preview-mode id written into prerender-manifest.json (see register/pages-api.ts). */
export const PREVIEW_MODE_ID = 'pnext-preview-id'

/**
 * Pages-router data protocol (`/_next/data/<id>/<page>.json`, normalized to the page path by cli/start.ts
 * with the `x-nextjs-data` marker): serve the page's data-fetch result as Next's data JSON -
 * `{ pageProps }` from getServerSideProps/getStaticProps of the materialized pages route - instead of
 * rendering HTML. When the request was rewritten, `x-nextjs-matched-path` reports the destination the
 * data was served from, which the pages client router uses to resolve the rewrite.
 */
export const pagesDataInterceptor: RequestInterceptor = async request => {
  if (request.headers.get('x-nextjs-data') !== '1') return undefined
  const method = request.method.toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') return undefined
  const runtime = getRequestRuntime()
  if (!runtime) return undefined
  const url = new URL(request.url)
  // Un-normalized data URLs (skipMiddlewareUrlNormalize without a middleware
  // rewrite) never match a route here; header-only marker requests for
  // document paths fall through to the HTML render.
  if (url.pathname.startsWith('/_next/')) return undefined

  const selection = selectRouteForRequest(runtime.routes, url.pathname)
  if (selection?.route.kind !== 'page') {
    return dataResponse({ notFound: true }, 404, url)
  }
  const route = selection.route
  if (!isMaterializedPagesRoute(route.file)) return undefined

  const module = (await import(
    await devServerModuleHref(
      runtime.config,
      route.file,
      runtime.dev ? (runtime.devImportVersion ?? 'dev') : 'build',
      {
        conditionTarget: serverBundleTargetForRuntime(route.segmentConfig?.runtime),
      },
    )
  )) as PagesDataModule

  setWorkUnitRoute('data', 'dynamic')
  const params = selection.params ?? {}
  const query = { ...Object.fromEntries(url.searchParams), ...params }
  if (typeof module.getServerSideProps === 'function') {
    const result = await module.getServerSideProps({
      params,
      query,
      req: pagesDataRequestShim(request, url),
      res: pagesDataResponseShim(),
      resolvedUrl: `${url.pathname}${url.search}`,
      preview: false,
      previewData: undefined,
    })
    return pagesDataResult(result, url)
  }
  if (typeof module.getStaticProps === 'function') {
    const result = await module.getStaticProps({ params })
    return pagesDataResult(result, url, true)
  }
  return dataResponse({ pageProps: {} }, 200, url)
}

interface PagesDataFnResult {
  props?: Record<string, unknown>
  notFound?: boolean
  redirect?: { destination: string; permanent?: boolean; statusCode?: number }
}

interface PagesDataModule {
  getServerSideProps?: (
    context: Record<string, unknown>,
  ) => Promise<PagesDataFnResult> | PagesDataFnResult
  getStaticProps?: (
    context: Record<string, unknown>,
  ) => Promise<PagesDataFnResult> | PagesDataFnResult
}

function pagesDataResult(result: PagesDataFnResult | undefined, url: URL, ssg = false): Response {
  if (result?.notFound) return dataResponse({ notFound: true }, 404, url)
  if (result?.redirect) {
    const status = result.redirect.statusCode ?? (result.redirect.permanent ? 308 : 307)
    return dataResponse(
      {
        pageProps: {
          __N_REDIRECT: result.redirect.destination,
          __N_REDIRECT_STATUS: status,
        },
      },
      200,
      url,
    )
  }
  return dataResponse(
    { pageProps: result?.props ?? {}, ...(ssg ? { __N_SSG: true } : { __N_SSP: true }) },
    200,
    url,
  )
}

function dataResponse(body: Record<string, unknown>, status: number, url: URL): Response {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' })
  // A rewrite happened when the canonical (as-requested, post-normalization)
  // pathname differs from the URL the route was matched on.
  const canonical = canonicalUrlHref()
  if (canonical && new URL(canonical).pathname !== url.pathname) {
    headers.set('x-nextjs-matched-path', url.pathname)
  }
  return new Response(JSON.stringify(body), { status, headers })
}

// The materialized hybrid app hosts BOTH routers; only pages wrappers
// re-export from source-pages/, so sniff the (tiny, generated) wrapper body —
// app routes must never serve _next/data.
function isMaterializedPagesRoute(file: string): boolean {
  if (!file.split(path.sep).join('/').includes('pnext-pages-compat/')) return false
  try {
    return readFileSync(file, 'utf8').includes('source-pages/')
  } catch {
    return false
  }
}

function pagesDataRequestShim(request: Request, url: URL) {
  return {
    method: request.method,
    url: `${url.pathname}${url.search}`,
    headers: Object.fromEntries(request.headers),
    cookies: cookiesFromHeader(request.headers.get('cookie')),
  }
}

function pagesDataResponseShim() {
  const headers = new Headers()
  let statusCode = 200
  return {
    get statusCode() {
      return statusCode
    },
    set statusCode(value: number) {
      statusCode = value
    },
    setHeader(name: string, value: string | number | readonly string[]) {
      headers.set(name, Array.isArray(value) ? value.join(', ') : String(value))
      return this
    },
    getHeader(name: string) {
      return headers.get(name)
    },
    removeHeader(name: string) {
      headers.delete(name)
    },
  }
}

export const pagesApiInterceptor: RequestInterceptor = async (request, { config }) => {
  const url = new URL(request.url)
  const file = pagesApiFile(config.root, url.pathname)
  if (!file) return undefined
  const imported = (await import(
    await devServerModuleHref(config, file, 'build', {
      conditionTarget: pagesApiBundleTargetForRuntime(apiRuntime(file)),
    })
  )) as PagesApiModule
  if (typeof imported.default !== 'function') return undefined

  const responder = createPagesApiResponse(request)
  // Edge-runtime pages API handlers receive the real NextRequest (signal,
  // nextUrl, text() — Request prototype getters a spread would lose); node
  // handlers get the IncomingMessage-shaped shim.
  const handlerRequest =
    apiRuntime(file) === 'edge' ? toNextRequest(request) : createPagesApiRequest(request, url)
  const finished = withPagesApiHandlerSpan(url.pathname, () =>
    Promise.resolve(imported.default!(handlerRequest, responder.res)),
  ).catch(error => responder.fail(error))
  // A handler that starts writing (res.write / pipeline) streams: the response returns at the first write
  // and the body flows through until end or disconnect - a client disconnect destroys `res`, surfacing as
  // its 'close' event, which is Node pages-API cancellation semantics. A handler that only buffers
  // resolves on completion exactly as before.
  const outcome = await Promise.race([responder.started.then(() => STREAM_STARTED), finished])
  if (outcome !== STREAM_STARTED) {
    if (outcome instanceof Response) return outcome
    return responder.response(outcome)
  }
  return responder.streamResponse()
}

const STREAM_STARTED = Symbol('pnext.pagesApiStreamStarted')

function pagesApiFile(root: string, pathname: string): string | undefined {
  if (pathname !== '/api' && !pathname.startsWith('/api/')) return undefined
  let relative: string
  try {
    relative = decodeURIComponent(pathname === '/api' ? 'index' : pathname.slice('/api/'.length))
  } catch {
    return undefined
  }
  const baseDir = path.join(root, 'pages', 'api')
  const base = path.resolve(baseDir, relative)
  if (base !== baseDir && !base.startsWith(`${baseDir}${path.sep}`)) return undefined
  for (const ext of pageExtensions) {
    const file = `${base}.${ext}`
    if (existsSync(file)) return file
    const index = path.join(base, `index.${ext}`)
    if (existsSync(index)) return index
  }
  return undefined
}

function apiRuntime(file: string): string | undefined {
  return /\bruntime\b\s*[:=]\s*(['"`])(?:edge|experimental-edge)\1/.test(readFileSync(file, 'utf8'))
    ? 'edge'
    : undefined
}

function createPagesApiRequest(request: Request, url: URL) {
  const nextRequest = toNextRequest(request)
  return {
    ...nextRequest,
    method: request.method,
    url: `${url.pathname}${url.search}`,
    headers: Object.fromEntries(request.headers),
    query: Object.fromEntries(url.searchParams),
    cookies: cookiesFromHeader(request.headers.get('cookie')),
    nextUrl: nextRequest.nextUrl,
    text() {
      return request.text()
    },
    json() {
      return request.json()
    },
  }
}

function createPagesApiResponse(request: Request) {
  const headers = new Headers()
  let statusCode = 200
  let sent = false
  let body: BodyInit | null = null
  let started = false
  let notifyStarted: () => void = () => undefined
  const startedPromise = new Promise<void>(resolve => {
    notifyStarted = resolve
  })

  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const streamBody = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
    // The client disconnected mid-stream: destroy the res so the handler
    // observes it as the response closing (Node pages-API semantics —
    // `res.on('close', ...)` aborts its inner stream).
    cancel() {
      writable.destroy()
    },
  })
  const start = () => {
    if (!started) {
      started = true
      notifyStarted()
    }
  }
  const enqueue = (chunk: unknown) => {
    const value = normalizeWriteChunk(chunk)
    if (value === '') return
    try {
      controller?.enqueue(
        typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value),
      )
    } catch {
      // Stream already closed/cancelled — drop the late chunk.
    }
  }
  // A REAL Writable: `stream.pipeline(source, res)` and event listeners need a
  // genuine EventEmitter/stream destination, not a duck-typed object.
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      start()
      enqueue(chunk)
      callback()
    },
    final(callback) {
      // Only a stream that actually wrote flags the streaming path: a plain
      // res.end(value) is a BUFFERED response (its body rides `body`, not the
      // stream) and must resolve through the handler-completion race.
      try {
        controller?.close()
      } catch {
        // Already closed.
      }
      callback()
    },
    destroy(error, callback) {
      try {
        controller?.close()
      } catch {
        // Already closed.
      }
      callback(error ?? null)
    },
  })
  request.signal?.addEventListener?.('abort', () => writable.destroy(), { once: true })

  const api = {
    setHeader(name: string, value: string | number | readonly string[]) {
      headers.set(name, Array.isArray(value) ? value.join(', ') : String(value))
      return res
    },
    getHeader(name: string) {
      return headers.get(name)
    },
    removeHeader(name: string) {
      headers.delete(name)
    },
    status(code: number) {
      statusCode = code
      return res
    },
    json(value: unknown) {
      if (!headers.has('content-type'))
        headers.set('content-type', 'application/json; charset=utf-8')
      body = JSON.stringify(value)
      sent = true
      return res
    },
    send(value?: unknown) {
      body = bodyFromValue(value, headers)
      sent = true
      return res
    },
    end(value?: unknown) {
      if (!sent) {
        body = bodyFromValue(value, headers)
        sent = true
      }
      if (value !== undefined && value !== null && started) {
        // Mid-stream end(chunk): flush the tail through the stream.
        enqueue(value)
      }
      ;(Writable.prototype.end as (this: Writable) => Writable).call(writable)
      return res
    },
    async revalidate(pathname: string) {
      markPathRevalidated(pathname)
      await getRequestExtensions().onDemandRevalidatePath(normalizeRevalidatePath(pathname))
    },
  }
  const res = Object.assign(writable, api) as unknown as PagesApiResponse
  Object.defineProperty(res, 'statusCode', {
    get: () => statusCode,
    set: (value: number) => {
      statusCode = value
    },
  })

  return {
    res,
    started: startedPromise,
    fail(error: unknown): never | undefined {
      if (!started) throw error
      try {
        controller?.error(error)
      } catch {
        // Stream already settled.
      }
      return undefined
    },
    streamResponse() {
      // Null-body statuses (204/304) must not carry a body stream.
      if (statusCode === 204 || statusCode === 304) {
        return new Response(null, { status: statusCode, headers })
      }
      return new Response(streamBody, { status: statusCode, headers })
    },
    response(result: unknown) {
      if (result !== undefined && !sent) body = bodyFromValue(result, headers)
      return new Response(statusCode === 204 || statusCode === 304 ? null : body, {
        status: statusCode,
        headers,
      })
    },
  }
}

function normalizeWriteChunk(chunk: unknown) {
  if (chunk === null || chunk === undefined) return ''
  if (typeof chunk === 'string') return chunk
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk)
  if (ArrayBuffer.isView(chunk))
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  if (typeof chunk === 'number' || typeof chunk === 'boolean' || typeof chunk === 'bigint') {
    return String(chunk)
  }
  return JSON.stringify(chunk) ?? ''
}

function bodyFromValue(value: unknown, headers: Headers): BodyInit | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' || value instanceof Blob || value instanceof ArrayBuffer)
    return value
  if (value instanceof Uint8Array && value.buffer instanceof ArrayBuffer) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
  }
  if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8')
  return JSON.stringify(value)
}

function cookiesFromHeader(header: string | null): Record<string, string> {
  if (!header) return {}
  return Object.fromEntries(
    header
      .split(';')
      .map(part => part.trim().split('='))
      .filter((parts): parts is [string, string] => parts.length === 2 && parts[0] !== ''),
  )
}
