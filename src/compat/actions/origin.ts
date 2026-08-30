// Server Actions CSRF origin validation (COMPAT).
//
// Mirrors Next's action-handler origin check: an action POST carrying an
// `origin` header whose host does not match the request host (`x-forwarded-host`
// preferred, else `host`) is rejected unless the origin is whitelisted via
// `experimental.serverActions.allowedOrigins`. Opaque origins ('null', e.g. a
// sandboxed iframe) are treated as the literal host 'null'. A missing origin is
// allowed (handcrafted request; can't carry unwilling credentials).

import { getNextConfig } from '../next/config-loader'

export const INVALID_ORIGIN_MESSAGE = 'Invalid Server Actions request.'

/** Read experimental.serverActions.allowedOrigins (also the top-level key). */
export function allowedOrigins(): string[] {
  const config = getNextConfig()
  const top = (config.serverActions as { allowedOrigins?: unknown } | undefined)?.allowedOrigins
  const experimental = config.experimental as
    { serverActions?: { allowedOrigins?: unknown } | boolean } | undefined
  const exp =
    experimental && typeof experimental.serverActions === 'object'
      ? experimental.serverActions.allowedOrigins
      : undefined
  const list = top ?? exp
  return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : []
}

function firstHeaderValue(value: string | null): string | undefined {
  if (value === null) return undefined
  return value.split(',')[0]?.trim() || undefined
}

/** Request host used to compare against the origin (x-forwarded-host > host). */
function requestHost(headers: Headers): string | undefined {
  return firstHeaderValue(headers.get('x-forwarded-host')) ?? headers.get('host') ?? undefined
}

function originHost(headers: Headers): string | undefined {
  const origin = headers.get('origin')
  if (origin === null) return undefined
  if (origin === 'null') return 'null'
  try {
    return new URL(origin).host
  } catch {
    return undefined
  }
}

function matchWildcardDomain(domain: string, pattern: string): boolean {
  const normalizedDomain = domain.replace(/[A-Z]/g, c => c.toLowerCase())
  const normalizedPattern = pattern.replace(/[A-Z]/g, c => c.toLowerCase())
  const domainParts = normalizedDomain.split('.')
  const patternParts = normalizedPattern.split('.')
  if (patternParts.length < 1) return false
  if (domainParts.length < patternParts.length) return false
  if (patternParts.length === 1 && (patternParts[0] === '*' || patternParts[0] === '**')) {
    return false
  }
  while (patternParts.length) {
    const patternPart = patternParts.pop()
    const domainPart = domainParts.pop()
    if (patternPart === '') return false
    if (patternPart === '*') {
      if (domainPart) continue
      return false
    }
    if (patternPart === '**') {
      if (patternParts.length > 0) return false
      return domainPart !== undefined
    }
    if (domainPart !== patternPart) return false
  }
  return domainParts.length === 0
}

function isCsrfOriginAllowed(originDomain: string, origins: string[]): boolean {
  const normalizedOrigin = originDomain.replace(/[A-Z]/g, c => c.toLowerCase())
  return origins.some(allowed => {
    if (!allowed) return false
    const normalizedAllowed = allowed.replace(/[A-Z]/g, c => c.toLowerCase())
    return normalizedAllowed === normalizedOrigin || matchWildcardDomain(originDomain, allowed)
  })
}

/**
 * Returns true when the request passes the CSRF origin check (or has no origin
 * to check). Returns false when the action must be aborted; the caller responds
 * with the "Invalid Server Actions request." error. Logs the mismatch like Next.
 */
export function isActionOriginAllowed(request: Request): boolean {
  const headers = request.headers
  const oHost = originHost(headers)
  if (oHost === undefined) return true
  const host = requestHost(headers)
  if (host !== undefined && oHost === host) return true
  if (isCsrfOriginAllowed(oHost, allowedOrigins())) return true
  if (host) {
    const hostType = headers.has('x-forwarded-host') ? 'x-forwarded-host' : 'host'
    console.error(
      `\`${hostType}\` header with value \`${host}\` does not match \`origin\` header with value \`${oHost}\` from a forwarded Server Actions request. Aborting the action.`,
    )
  } else {
    console.error(
      '`x-forwarded-host` or `host` headers are not provided. One of these is needed to compare the `origin` header from a forwarded Server Actions request. Aborting the action.',
    )
  }
  return false
}
