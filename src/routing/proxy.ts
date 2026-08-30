import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
// Lazy: the oxc-parser native binding costs ~12.6 MB RSS; load it only when a parse happens.
const parseSync: typeof import('oxc-parser').parseSync = (...args) =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  loadNative(() => require('oxc-parser') as typeof import('oxc-parser')).parseSync(...args)
import { loadNative } from '../utils/native-require'
import { registerServerRuntime } from '../runtime/loader'
import { pathToFileHref, type ResolvedConfig } from '../config'
import { devServerModuleHref } from '../runtime/modules'
import { runWithRequest } from '../request/context'
import {
  copyMiddlewareHeaders,
  forwardMiddlewareRequestHeaders,
  getSetCookie,
  NextResponse,
  nextResponseMeta,
  parseCookies,
  requestCookieHeader,
  toNextRequest,
} from '../api/server'
import type { ExternalLoadTarget } from '../resolve/imports'
import { getProxyExtensions, withRouteRuntime } from '../extensions'
import { canonicalTrailingSlashPath, isBuildAssetPathname } from './href'

export interface ProxyModule {
  default?: ProxyHandler
  proxy?: ProxyHandler
  config?: ProxyConfig
}

export type ProxyHandler = (
  request: import('../types').NextRequest,
  event: import('../types').NextFetchEvent,
) => Response | undefined | void | Promise<Response | undefined | void>

export interface ProxyConfig {
  matcher?: ProxyMatcher | ProxyMatcher[]
}

export interface ProxyRouteCondition {
  type: 'header' | 'query' | 'cookie' | 'host'
  key?: string
  value?: string
}

type ProxyMatcher =
  string | { source: string; has?: ProxyRouteCondition[]; missing?: ProxyRouteCondition[] }

interface CompiledMatcher {
  regex: RegExp
  has?: ProxyRouteCondition[]
  missing?: ProxyRouteCondition[]
}

export interface ProxyRunOptions {
  dev?: boolean
  devImportVersion?: string
}

export type ProxyRewriteObserver = (from: URL, to: URL) => void

let proxyRewriteObserver: ProxyRewriteObserver | undefined

export function setProxyRewriteObserver(observer: ProxyRewriteObserver | undefined): void {
  proxyRewriteObserver = observer
}

export type ProxyRunObserver = <T>(request: Request, fn: () => T) => T

let proxyRunObserver: ProxyRunObserver | undefined

export function setProxyRunObserver(observer: ProxyRunObserver | undefined): void {
  proxyRunObserver = observer
}

function wrapMiddleware<T>(request: Request, fn: () => T): T {
  return proxyRunObserver ? proxyRunObserver(request, fn) : fn()
}

export interface ProxyNextResult {
  request: Request
  response?: Response
}

export interface ProxyRunner {
  (request: Request, options?: ProxyRunOptions): Promise<ProxyNextResult | Response | undefined>
  /**
   * Start compiling and importing the proxy module now. The proxy runs serially in front of every
   * request, so leaving its first import to the first request puts the whole compile on the critical
   * path of the first page; dev calls this at boot so it overlaps route scanning and the warmup.
   */
  warm(options?: ProxyRunOptions): void
}

const proxyExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mts']

export function findProxyFile(config: ResolvedConfig) {
  return findProxyFiles(config)[0]
}

export function proxyExternalLoadTarget(file: string): ExternalLoadTarget {
  return path.basename(file).startsWith('proxy.') ? 'client-ssr' : 'edge'
}

export function findProxyFiles(config: ResolvedConfig, names = getProxyExtensions().names) {
  const files: string[] = []
  for (const base of proxyBases(config)) {
    for (const name of names) {
      for (const extension of proxyExtensions) {
        const file = path.join(base, `${name}${extension}`)
        if (existsSync(file)) files.push(file)
      }
    }
  }
  return files
}

export async function validateProxyFiles(config: ResolvedConfig) {
  await getProxyExtensions().validateFiles(config)
}

export async function runProxy(
  config: ResolvedConfig,
  request: Request,
  options: ProxyRunOptions = {},
): Promise<ProxyNextResult | Response | undefined> {
  const url = new URL(request.url)
  if (url.pathname.startsWith('/__pnext/') || isBuildAssetPathname(url.pathname)) {
    return undefined
  }

  return createProxyRunner(config)(request, options)
}

export interface ProxyRunnerOptions {
  /**
   * Pre-compiled proxy module from the production build. Raw Bun imports
   * cannot resolve bare compat specifiers (next/server etc.), so prod must
   * load the build-time bundle that has aliases baked in.
   */
  compiledModuleHref?: string
}

export function createProxyRunner(
  config: ResolvedConfig,
  runnerOptions: ProxyRunnerOptions = {},
): ProxyRunner {
  const file = findProxyFile(config)
  registerServerRuntime(config, file ? [file] : [])
  let moduleKey: string | undefined
  let modulePromise: Promise<ProxyModule> | undefined
  let matchers: CompiledMatcher[] | undefined

  /** The module for `options`, started at most once per import version. */
  function proxyModule(options: ProxyRunOptions) {
    const key = proxyModuleKey(options)
    if (key !== moduleKey) {
      moduleKey = key
      modulePromise = importProxyModule(config, file!, options, runnerOptions)
      matchers = undefined
    }
    return (modulePromise ??= importProxyModule(config, file!, options, runnerOptions))
  }

  const runner: ProxyRunner = async (request, options = {}) => {
    const url = new URL(request.url)
    if (
      url.pathname.startsWith('/__pnext/') ||
      (!config.compat?.next && isBuildAssetPathname(url.pathname))
    ) {
      return undefined
    }
    if (!file) return undefined

    // Matcher first, straight off the source: a request no matcher selects must not wait on the
    // proxy's compile+import, which is otherwise the first serial link of a cold page.
    if (!matchers && proxyMatcherGateEnabled()) {
      const staticMatchers = staticProxyMatchers(file)
      if (staticMatchers && !matchesProxy(staticMatchers, url, request)) return undefined
    }

    const module = await proxyModule(options)
    matchers ??= proxyMatchers(module.config)
    if (!matchesProxy(matchers, url, request)) return undefined

    // A proxied request's body is buffered so both the proxy and the matched
    // route can read it; buffering is capped at clientMaxBodySize (compat maps
    // experimental.proxyClientMaxBodySize, default 10MB) — the excess is
    // dropped with a warning, matching Next's router-server behavior.
    request = await bufferProxyRequestBody(request, url.pathname)

    const handlerExport = getProxyExtensions().handlerExport(module as Record<string, unknown>)
    if (typeof handlerExport !== 'function') throw new Error(`${file} must export proxy or default`)
    const handler = handlerExport as ProxyHandler

    // Next normally hides the RSC cache key and Flight headers from proxy;
    // skipProxyUrlNormalize exposes the original request for advanced routing.
    const handlerRequest = getProxyExtensions().skipUrlNormalize()
      ? request
      : stripFlightHeaders(stripRscUnionQuery(request))
    const nextRequest = toNextRequest(handlerRequest)
    // Response-headers channel so request-scoped APIs invoked inside the proxy
    // (notably draftMode().enable()/disable() from next/headers) can emit
    // Set-Cookie even when the handler returns NextResponse.next() — otherwise
    // the cookie would be dropped since it is not written onto that response.
    const proxyResponseHeaders = new Headers()
    let response = await runWithRequest(
      nextRequest,
      () =>
        withRouteRuntime('edge', () =>
          wrapMiddleware(nextRequest, () =>
            handler(nextRequest, {
              waitUntil(promise) {
                void promise
              },
            }),
          ),
        ),
      {},
      { responseHeaders: proxyResponseHeaders },
    )

    const scopedCookies = getSetCookie(proxyResponseHeaders)
    if (scopedCookies.length > 0) {
      // No explicit return means an implicit NextResponse.next(): synthesize one
      // so the emitted Set-Cookie survives while the request still continues.
      if (!response) response = NextResponse.next()
      for (const cookie of scopedCookies) response.headers.append('set-cookie', cookie)
    }

    if (!response) return { request }

    // Redirects use the router-server envelope: relative same-origin target in
    // both Location and body, with trailing-slash normalization when enabled.
    response = await normalizeRedirectResponse(response, url, request.method, config)

    const meta = nextResponseMeta(response)
    if (!meta) return response
    const forwardedRequest = forwardMiddlewareRequestHeaders(
      response,
      applyProxyCookies(applyRequestOverride(request, meta.requestHeaders), response),
    )
    if (meta.kind === 'rewrite' && meta.url) {
      let rewritten = rewriteRequest(forwardedRequest, meta.url)
      const rewrittenUrl = new URL(rewritten.url)
      // A rewrite to another origin is proxied: the response for THIS request
      // comes from the external server (Next's router-server does the same for
      // any middleware rewrite whose destination carries a protocol).
      if (rewrittenUrl.origin !== url.origin) {
        // An RSC fetch's `_rsc` cache-buster must ride along: the external
        // server cannot recover it from the original URL, and the router keys
        // its response on it. Only added when the destination lacks its own.
        const rscHash = url.searchParams.get('_rsc')
        if (rscHash !== null && !rewrittenUrl.searchParams.has('_rsc')) {
          rewrittenUrl.searchParams.set('_rsc', rscHash)
          rewritten = new Request(rewrittenUrl, rewritten)
        }
        getProxyExtensions().onExternalRewrite(rewritten)
        // The forwarded request still carries the ORIGINAL Host header (the
        // local server); Bun uses it for SNI/verification, so an https target
        // fails certificate checks. Drop it and let fetch derive Host from the
        // target URL, like Next's external-rewrite proxying.
        const externalHeaders = new Headers(rewritten.headers)
        externalHeaders.delete('host')
        const external = await fetch(new Request(rewritten, { headers: externalHeaders }))
        const headers = new Headers(external.headers)
        headers.delete('content-encoding')
        headers.delete('content-length')
        headers.delete('transfer-encoding')
        const proxied = new Response(external.body, {
          status: external.status,
          statusText: external.statusText,
          headers,
        })
        copyMiddlewareHeaders(response, proxied)
        return proxied
      }
      if (rewrittenUrl.origin === url.origin) {
        proxyRewriteObserver?.(url, rewrittenUrl)
        if (request.headers.get('x-nextjs-data') === '1') {
          response.headers.set('x-nextjs-rewrite', rewrittenUrl.href)
        }
      }
      return { request: rewritten, response }
    }

    return { request: forwardedRequest, response }
  }

  runner.warm = (options = {}) => {
    if (!file) return
    // A failure surfaces on the first request, which awaits this same promise;
    // the swallow here only keeps the unawaited warm call from going unhandled.
    void proxyModule(options).catch(() => undefined)
  }

  return runner
}

// Normalize the redirect emitted by middleware into the router-server envelope.
async function normalizeRedirectResponse(
  response: Response,
  requestUrl: URL,
  method: string,
  config: ResolvedConfig,
) {
  if (response.status < 300 || response.status >= 400) return response
  const location = response.headers.get('location')
  if (!location) return response
  let target: URL
  try {
    target = new URL(location, requestUrl)
  } catch {
    return response
  }
  if (target.origin === requestUrl.origin) {
    if (!config.skipTrailingSlashRedirect && config.trailingSlash) {
      target.pathname = canonicalTrailingSlashPath(target.pathname, true)
    }
  }
  const destination =
    target.origin === requestUrl.origin
      ? `${target.pathname}${target.search}${target.hash}`
      : target.href
  const headers = new Headers(response.headers)
  headers.set('location', destination)
  const body =
    method.toUpperCase() === 'HEAD' || response.body === null ? null : await response.arrayBuffer()
  const synthesizeDestination = method.toUpperCase() !== 'HEAD' && (!body || body.byteLength === 0)
  if (synthesizeDestination) headers.delete('content-length')
  return new Response(synthesizeDestination ? destination : body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

// Human label for the truncation warning ("10MB", "500KB") — whole units only,
// mirroring Next's log line ("Request body exceeded 10MB for /api/echo").
function formatBodyLimit(bytes: number): string {
  if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)}MB`
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024}KB`
  return `${bytes}B`
}

async function bufferProxyRequestBody(request: Request, pathname: string): Promise<Request> {
  if (request.method === 'GET' || request.method === 'HEAD' || !request.body) return request
  const limit = getProxyExtensions().clientMaxBodySize()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  const reader = request.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!truncated && total + value.byteLength > limit) {
      const keep = limit - total
      if (keep > 0) chunks.push(value.subarray(0, keep))
      total = limit
      truncated = true
      // Keep draining (and discarding) the rest of the upload — cancelling the
      // stream mid-upload stalls the connection and the response never flushes.
      continue
    }
    if (!truncated) {
      chunks.push(value)
      total += value.byteLength
    }
  }
  if (truncated) {
    console.warn(`Request body exceeded ${formatBodyLimit(limit)} for ${pathname}`)
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  const headers = new Headers(request.headers)
  headers.set('content-length', String(total))
  return new Request(request.url, {
    method: request.method,
    headers,
    body,
    // @ts-expect-error Bun/Node fetch option for streaming request bodies.
    duplex: 'half',
  })
}

export function applyProxyResponse(response: Response, proxyResponse?: Response) {
  if (proxyResponse) copyMiddlewareHeaders(proxyResponse, response)
  return response
}

export function proxyRoutePatterns(config: ProxyConfig | undefined) {
  const matcher = config?.matcher
  if (!matcher) return ['^/(.*)$']
  const matchers = Array.isArray(matcher) ? matcher : [matcher]
  return matchers.map(item => `^${matcherPattern(matcherSource(item))}$`)
}

async function importProxyModule(
  config: ResolvedConfig,
  file: string,
  options: ProxyRunOptions,
  runnerOptions: ProxyRunnerOptions,
) {
  const href = options.dev
    ? await devServerModuleHref(config, file, options.devImportVersion ?? 'dev', {
        conditionTarget: 'edge',
        externalLoadTarget: proxyExternalLoadTarget(file),
        reactServerLayer: true,
      })
    : (runnerOptions.compiledModuleHref ?? pathToFileHref(file))
  return import(href) as Promise<ProxyModule>
}

function proxyBases(config: ResolvedConfig) {
  return config.appPath === path.join(config.root, 'src', 'app')
    ? [path.join(config.root, 'src'), config.root]
    : [config.root]
}

/**
 * `PNEXT_PROXY_MATCHER_GATE=0` restores the old order - every request awaits the proxy module before its
 * matchers are consulted - so the gate can be measured on one tree at one machine load.
 */
function proxyMatcherGateEnabled() {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  return process.env.PNEXT_PROXY_MATCHER_GATE !== '0'
}

/** Parsed matchers per proxy file, keyed on the source's size+mtime. */
const staticMatcherCache = new Map<string, { key: string; matchers?: CompiledMatcher[] }>()

/**
 * Compile the matchers of `export const config` off the proxy source itself. Only a wholly literal config
 * qualifies (Next requires a statically analyzable matcher anyway - it extracts one into
 * middleware-manifest.json at build time); anything computed, any parse error, and any file without a
 * literal `config` yields undefined, and the caller falls back to the imported module's config.
 */
function staticProxyMatchers(file: string): CompiledMatcher[] | undefined {
  let key: string
  try {
    const stats = statSync(file)
    key = `${stats.size}:${stats.mtimeMs}`
  } catch {
    return undefined
  }
  const cached = staticMatcherCache.get(file)
  if (cached?.key === key) return cached.matchers
  let matchers: CompiledMatcher[] | undefined
  try {
    const config = staticProxyConfig(file, readFileSync(file, 'utf8'))
    if (config) matchers = proxyMatchers(config)
  } catch {
    matchers = undefined
  }
  staticMatcherCache.set(file, { key, matchers })
  return matchers
}

function staticProxyConfig(file: string, source: string): ProxyConfig | undefined {
  const result = parseSync(file, source, { lang: parserLang(file) })
  // A recovered parse may have dropped the very declaration we are reading.
  if (result.errors.length > 0) return undefined
  for (const statement of result.program.body as StaticNode[]) {
    if (statement.type !== 'ExportNamedDeclaration') continue
    const declaration = statement.declaration
    if (declaration?.type !== 'VariableDeclaration') continue
    for (const declarator of declaration.declarations ?? []) {
      if (declarator.id?.type !== 'Identifier' || declarator.id.name !== 'config') continue
      const value = staticValue(declarator.init)
      return isProxyConfigShape(value) ? (value as ProxyConfig) : undefined
    }
  }
  return undefined
}

function parserLang(file: string) {
  const ext = path.extname(file)
  if (ext === '.tsx') return 'tsx'
  if (ext === '.jsx') return 'jsx'
  return ext === '.js' || ext === '.mjs' ? 'js' : 'ts'
}

/** Structural view of the oxc AST nodes this file reads — no full type import. */
interface StaticNode {
  type: string
  name?: string
  value?: unknown
  computed?: boolean
  shorthand?: boolean
  key?: StaticNode
  init?: StaticNode
  id?: StaticNode
  declaration?: StaticNode
  declarations?: StaticNode[]
  expression?: StaticNode
  properties?: StaticNode[]
  elements?: (StaticNode | null)[]
  expressions?: StaticNode[]
  quasis?: { value?: { cooked?: string } }[]
}

/** Literal-only evaluation; `undefined` marks "not statically known". */
function staticValue(node: StaticNode | undefined | null): unknown {
  if (!node) return undefined
  switch (node.type) {
    // `… as const` / `… satisfies ProxyConfig` wrap the literal, they never change it.
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
      return staticValue(node.expression)
    case 'Literal':
    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
      // A regex literal reports `value: null` here; it is not a matcher shape.
      return node.value === null ? undefined : node.value
    case 'TemplateLiteral':
      return node.expressions?.length === 0
        ? (node.quasis?.[0]?.value?.cooked ?? undefined)
        : undefined
    case 'ArrayExpression': {
      const items: unknown[] = []
      for (const element of node.elements ?? []) {
        const value = staticValue(element)
        if (value === undefined) return undefined
        items.push(value)
      }
      return items
    }
    case 'ObjectExpression': {
      const object: Record<string, unknown> = {}
      for (const property of node.properties ?? []) {
        if (property.type !== 'Property' && property.type !== 'ObjectProperty') return undefined
        if (property.computed) return undefined
        const key =
          property.key?.type === 'Identifier' ? property.key.name : (property.key?.value as string)
        if (typeof key !== 'string') return undefined
        const value = staticValue(property.value as StaticNode | undefined)
        if (value === undefined) return undefined
        object[key] = value
      }
      return object
    }
    default:
      return undefined
  }
}

/** Only a config whose `matcher` is exactly the documented shape may gate. */
function isProxyConfigShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const matcher = (value as { matcher?: unknown }).matcher
  if (matcher === undefined) return true
  const items = Array.isArray(matcher) ? matcher : [matcher]
  return items.every(item => {
    if (typeof item === 'string') return true
    if (typeof item !== 'object' || item === null) return false
    const { source, has, missing } = item as Record<string, unknown>
    if (typeof source !== 'string') return false
    return [has, missing].every(
      list => list === undefined || (Array.isArray(list) && list.every(isConditionShape)),
    )
  })
}

function isConditionShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const { type, key, value: expected } = value as Record<string, unknown>
  if (type !== 'header' && type !== 'query' && type !== 'cookie' && type !== 'host') return false
  if (key !== undefined && typeof key !== 'string') return false
  return expected === undefined || typeof expected === 'string'
}

function proxyMatchers(config: ProxyConfig | undefined): CompiledMatcher[] {
  const matcher = config?.matcher
  if (!matcher) return [{ regex: /.*/ }]
  const matchers = Array.isArray(matcher) ? matcher : [matcher]
  return matchers.map(item => ({
    regex: matcherRegex(matcherSource(item)),
    ...(typeof item === 'object' && item.has ? { has: item.has } : {}),
    ...(typeof item === 'object' && item.missing ? { missing: item.missing } : {}),
  }))
}

function matchesProxy(matchers: CompiledMatcher[], url: URL, request: Request) {
  const decoded = decodePathSeparators(url.pathname)
  return matchers.some(
    matcher =>
      (matcher.regex.test(url.pathname) || matcher.regex.test(decoded)) &&
      matchesConditions(matcher, url, request),
  )
}

// A matcher applies only when every `has` condition is present and no `missing`
// condition is present (Next's route-matcher semantics). The proxy config's
// `missing: [{ type: 'header', key: 'Next-Router-Prefetch' }]` is how a proxy
// opts out of running for prefetch requests.
function matchesConditions(matcher: CompiledMatcher, url: URL, request: Request) {
  if (matcher.has && !matcher.has.every(condition => hasCondition(condition, url, request))) {
    return false
  }
  if (matcher.missing?.some(condition => hasCondition(condition, url, request))) {
    return false
  }
  return true
}

function hasCondition(condition: ProxyRouteCondition, url: URL, request: Request): boolean {
  const actual = conditionValue(condition, url, request)
  if (actual === null) return false
  if (condition.value === undefined) return true
  try {
    return new RegExp(`^${condition.value}$`).test(actual)
  } catch {
    return condition.value === actual
  }
}

function conditionValue(condition: ProxyRouteCondition, url: URL, request: Request): string | null {
  switch (condition.type) {
    case 'header':
      return condition.key ? request.headers.get(condition.key) : null
    case 'query':
      return condition.key ? url.searchParams.get(condition.key) : null
    case 'cookie': {
      if (!condition.key) return null
      const cookie = parseCookies(request.headers.get('cookie') ?? '').find(
        item => item.name === condition.key,
      )
      return cookie ? cookie.value : null
    }
    case 'host':
      return url.host
    default:
      return null
  }
}

function decodePathSeparators(pathname: string) {
  return pathname.replace(/%2f/gi, '/')
}

function matcherSource(matcher: ProxyMatcher) {
  return typeof matcher === 'string' ? matcher : matcher.source
}

function matcherRegex(matcher: string) {
  return new RegExp(`^${matcherPattern(matcher)}$`)
}

function matcherPattern(matcher: string) {
  if (matcher.includes('(')) return matcher
  if (matcher === '/') return '/'

  let source = ''
  for (const segment of matcher.split('/').filter(Boolean)) {
    if (/^:[^/]+\*$/.test(segment)) {
      source += '(?:/.*)?'
    } else if (/^:[^/]+$/.test(segment)) {
      source += '/[^/]+'
    } else {
      source += `/${escapeRegex(segment)}`
    }
  }
  return source || '/'
}

function rewriteRequest(request: Request, url: string) {
  return new Request(new URL(url, request.url), request)
}

// Drop `?_rsc=<hash>` from the request the middleware handler sees. GET/HEAD
// only ever carry it (router fetches), so re-wrapping the Request is body-safe.
function stripRscUnionQuery(request: Request): Request {
  const url = new URL(request.url)
  if (!url.searchParams.has('_rsc')) return request
  url.searchParams.delete('_rsc')
  return new Request(url, request)
}

// The app-router flight headers Next removes from the request middleware sees
// (FLIGHT_HEADERS in next/dist/client/components/app-router-headers). They are
// only elided for the middleware view; the downstream render keeps them.
const FLIGHT_HEADERS = [
  'rsc',
  'next-router-state-tree',
  'next-router-prefetch',
  'next-hmr-refresh',
  'next-router-segment-prefetch',
]

// Drop the flight headers from the request the middleware handler sees. GET/HEAD
// router fetches carry them, so re-wrapping the Request is body-safe.
function stripFlightHeaders(request: Request): Request {
  if (!FLIGHT_HEADERS.some(header => request.headers.has(header))) return request
  const headers = new Headers(request.headers)
  for (const header of FLIGHT_HEADERS) headers.delete(header)
  return new Request(request, { headers })
}

function applyRequestOverride(request: Request, headers: Headers | undefined) {
  if (!headers) return request
  return new Request(request, { headers })
}

function applyProxyCookies(request: Request, response: Response) {
  const setCookies = getSetCookie(response.headers)
  if (setCookies.length === 0) return request

  const cookies = parseCookies(request.headers.get('cookie') ?? '')
  for (const header of setCookies) {
    const cookie = parseSetCookie(header)
    if (!cookie) continue
    const index = cookies.findIndex(item => item.name === cookie.name)
    if (cookie.deleted) {
      if (index !== -1) cookies.splice(index, 1)
      continue
    }
    if (index === -1) cookies.push({ name: cookie.name, value: cookie.value })
    else cookies[index] = { name: cookie.name, value: cookie.value }
  }

  const headers = new Headers(request.headers)
  const cookieHeader = requestCookieHeader(cookies)
  if (cookieHeader) headers.set('cookie', cookieHeader)
  else headers.delete('cookie')
  return new Request(request, { headers })
}

function parseSetCookie(header: string) {
  const [pair = '', ...attributes] = header.split(';').map(part => part.trim())
  const [name = '', ...valueParts] = pair.split('=')
  if (!name) return undefined
  const deleted = attributes.some(attribute => /^max-age=0$/i.test(attribute))
  return { name: decodeCookiePart(name), value: decodeCookiePart(valueParts.join('=')), deleted }
}

function decodeCookiePart(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function proxyModuleKey(options: ProxyRunOptions) {
  return options.dev ? `dev:${options.devImportVersion ?? 'dev'}` : 'prod'
}
