import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { nextCompatEnabled } from '../compat/aliases'
import type { ResolvedConfig } from '../config'
import type { ResponseFinalizer, ResponseFinalizerContext } from '../extensions'
import { getNextConfig } from './next/config-loader'
import { escapeRegex } from '../utils/code'
import { canonicalUrlHref } from './next/canonical-url'
import {
  appPathname,
  loadCompatHeaders,
  resolveCompatHeaders,
  type CompatHeaderPair,
  type CompatHeaderRule,
} from './next/config-headers'
import type { RewriteRequestContext } from './next/rewrites'

const DEFAULT_EXPIRE_TIME = 31536000

interface RevalidateRule {
  regex: RegExp
  revalidateSeconds: number
}

export function cacheControlFinalizers(config: ResolvedConfig): ResponseFinalizer[] {
  if (!nextCompatEnabled(config)) return []

  let rules: Promise<CompatHeaderRule[]> | undefined
  let pagesRevalidateRules: RevalidateRule[] | undefined
  const finalizer: ResponseFinalizer = async ctx => {
    rules ??= loadCompatHeaders(config.root)
    applyConfigHeaders(ctx, await rules, config.basePath)
    applyPoweredByHeader(ctx)
    pagesRevalidateRules ??= loadPagesRevalidateRules(config.root)
    applyDefaultIsrHeader(ctx, pagesRevalidateRules)
  }
  return [finalizer]
}

/**
 * Next sends `X-Powered-By: Next.js` on HTML payloads (send-payload.ts gates on the HTML content
 * type) and omits it entirely under `poweredByHeader: false`.
 */
function applyPoweredByHeader(ctx: ResponseFinalizerContext): void {
  if (getNextConfig().poweredByHeader === false) return
  if (!ctx.headers.get('content-type')?.startsWith('text/html')) return
  ctx.headers.set('x-powered-by', 'Next.js')
}

function applyConfigHeaders(
  ctx: ResponseFinalizerContext,
  rules: readonly CompatHeaderRule[],
  basePath: string,
): void {
  if (rules.length === 0) return
  // Header routes precede rewrites (and middleware) in Next's route list, so
  // they match the URL the browser asked for, never a rewrite destination.
  const url = new URL(canonicalUrlHref() ?? ctx.request.url.href)
  const requestCtx: RewriteRequestContext = {
    host: url.host,
    headers: ctx.request.headers,
    cookies: parseCookieHeader(ctx.request.headers.get('cookie')),
    query: url.searchParams,
  }
  // `basePath: false` entries match the RAW path; every other entry's source is
  // basePath-prefixed, i.e. matches the in-app path. The two passes are disjoint.
  const inApp = appPathname(url.pathname, basePath)
  const matched: CompatHeaderPair[] = [
    ...(inApp === undefined
      ? []
      : resolveCompatHeaders(
          rules.filter(rule => !rule.outsideBasePath),
          inApp,
          requestCtx,
        )),
    ...resolveCompatHeaders(
      rules.filter(rule => rule.outsideBasePath),
      url.pathname,
      requestCtx,
    ),
  ]

  // Config `Set-Cookie` headers must be appended (each entry is its own header,
  // never overwriting) and must precede the response's own Set-Cookie headers —
  // Next applies config headers at the router layer before the route's own
  // cookies (set-cookies suite asserts [...nextConfigHeaders, ...cookies]).
  const configSetCookies: string[] = []
  // A route handler's Response headers are user code running AFTER the router
  // set these, so those keys stay the handler's (Next: res.setHeader last wins).
  const pageOwnsHeaders = ctx.routeKind === 'route-handler'
  for (const { key, value } of matched) {
    if (key.toLowerCase() === 'set-cookie') configSetCookies.push(value)
    else if (!pageOwnsHeaders || !ctx.headers.has(key)) ctx.headers.set(key, value)
  }
  if (configSetCookies.length > 0) {
    const existing =
      (ctx.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
    ctx.headers.delete('set-cookie')
    for (const cookie of configSetCookies) ctx.headers.append('set-cookie', cookie)
    for (const cookie of existing) ctx.headers.append('set-cookie', cookie)
  }
}

function applyDefaultIsrHeader(
  ctx: ResponseFinalizerContext,
  pagesRevalidateRules: readonly RevalidateRule[],
): void {
  const pagesRevalidateSeconds = pagesRevalidateRules.find(rule =>
    rule.regex.test(ctx.request.url.pathname),
  )?.revalidateSeconds
  const existing = ctx.headers.get('cache-control')
  // An RSC payload is never browser-cacheable: the flight response embeds the
  // render's data, so a cached copy replays stale content after a revalidation
  // (actions "should invalidate client cache when path is revalidated"). Match
  // the RSC document path in register-segment, which stamps `private, no-store`.
  if (isRscPayload(ctx)) {
    if (existing === null || isBrowserCacheable(existing)) {
      ctx.headers.set('cache-control', 'private, no-store')
    }
    return
  }
  if (existing && (pagesRevalidateSeconds === undefined || existing !== 'no-store')) return
  const revalidateSeconds =
    pagesRevalidateSeconds ?? (ctx.routeMode === 'isr' ? ctx.hints?.revalidateSeconds : undefined)
  if (typeof revalidateSeconds !== 'number' || revalidateSeconds <= 0) return
  const config = getNextConfig()
  const expireTime = typeof config.expireTime === 'number' ? config.expireTime : DEFAULT_EXPIRE_TIME
  const swr = Math.max(0, expireTime - revalidateSeconds)
  ctx.headers.set('cache-control', `s-maxage=${revalidateSeconds}, stale-while-revalidate=${swr}`)
}

/** A flight response: core's `data` route kind, or an `_rsc` cache-busted URL. */
function isRscPayload(ctx: ResponseFinalizerContext): boolean {
  return ctx.routeKind === 'data' || ctx.request.url.searchParams.has('_rsc')
}

/** True for a cache-control a browser may reuse (no `no-store`/`no-cache`). */
function isBrowserCacheable(value: string): boolean {
  return !/\bno-store\b|\bno-cache\b/i.test(value)
}

function loadPagesRevalidateRules(root: string): RevalidateRule[] {
  const pagesDir = path.join(root, 'pages')
  if (!existsSync(pagesDir)) return []
  const rules: RevalidateRule[] = []
  for (const file of walkFiles(pagesDir)) {
    const source = readFileSync(file, 'utf8')
    if (!/\bgetStaticProps\b/.test(source)) continue
    const match = /\brevalidate\s*:\s*(\d+)/.exec(source)
    if (!match?.[1]) continue
    const regex = pagesRouteRegex(path.relative(pagesDir, file))
    if (!regex) continue
    rules.push({ regex, revalidateSeconds: Number(match[1]) })
  }
  return rules
}

function walkFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walkFiles(file))
    else if (/\.(?:tsx|ts|jsx|js|mjs)$/.test(entry.name)) files.push(file)
  }
  return files
}

function pagesRouteRegex(relative: string): RegExp | undefined {
  const withoutExt = relative
    .replace(/\.(?:tsx|ts|jsx|js|mjs)$/, '')
    .split(path.sep)
    .join('/')
  const route = withoutExt === 'index' ? '' : withoutExt.replace(/\/index$/, '')
  const parts = route.split('/').filter(Boolean)
  const pattern = parts
    .map(part => {
      if (/^\[\[\.\.\.[^\]]+\]\]$/.test(part)) return '(?:/.*)?'
      if (/^\[\.\.\.[^\]]+\]$/.test(part)) return '/.+'
      if (/^\[[^\]]+\]$/.test(part)) return '/[^/]+'
      return `/${escapeRegex(part)}`
    })
    .join('')
  return new RegExp(`^${pattern || '/'}\\/?$`)
}

function parseCookieHeader(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = {}
  if (!header) return cookies
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    const name = part.slice(0, index).trim()
    if (!name) continue
    cookies[name] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return cookies
}
