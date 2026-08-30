// ---------------------------------------------------------------------------
// localPatterns / remotePatterns matching (COMPAT).
//
// Mirrors Next's hasLocalMatch / hasRemoteMatch used by the optimizer to decide
// whether a requested `url` is allowed (else 400).
// ---------------------------------------------------------------------------

import type { LocalPattern, RemotePattern } from './config'

function makePathnameRegex(pathname: string): RegExp {
  // Convert a Next path-to-regexp style glob ('/assets/**') into a RegExp.
  // '**' matches any depth; '*' matches a single segment.
  let source = ''
  const escaped = pathname.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  // Handle ** then * (double-star must be processed first).
  source = escaped
    .replace(/\/\*\*/g, '(?:/.*)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
  return new RegExp(`^${source}$`)
}

export function hasLocalMatch(localPatterns: LocalPattern[] | undefined, url: URL): boolean {
  // undefined localPatterns => allow all local images (Next default).
  if (localPatterns === undefined) return true
  return localPatterns.some(pattern => {
    if (pattern.pathname !== undefined && !makePathnameRegex(pattern.pathname).test(url.pathname)) {
      return false
    }
    if (pattern.search !== undefined && pattern.search !== url.search) return false
    return true
  })
}

export function hasRemoteMatch(
  domains: string[],
  remotePatterns: RemotePattern[],
  url: URL,
): boolean {
  if (domains.includes(url.hostname)) return true
  return remotePatterns.some(pattern => {
    if (pattern.protocol !== undefined && pattern.protocol !== url.protocol.replace(/:$/, '')) {
      return false
    }
    if (pattern.hostname !== undefined && !matchHostname(pattern.hostname, url.hostname)) {
      return false
    }
    if (pattern.port !== undefined && pattern.port !== '' && pattern.port !== url.port) {
      return false
    }
    if (pattern.pathname !== undefined && !makePathnameRegex(pattern.pathname).test(url.pathname)) {
      return false
    }
    if (pattern.search !== undefined && pattern.search !== '' && pattern.search !== url.search) {
      return false
    }
    return true
  })
}

function matchHostname(pattern: string, hostname: string): boolean {
  if (pattern.startsWith('**.')) {
    const suffix = pattern.slice(2) // ".example.com"
    return hostname.endsWith(suffix) && hostname.length > suffix.length
  }
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1)
    if (!hostname.endsWith(suffix)) return false
    const sub = hostname.slice(0, -suffix.length)
    return sub.length > 0 && !sub.includes('.')
  }
  return pattern === hostname
}

/**
 * Next serializes localPatterns into images-manifest.json as pathname RegExp
 * source strings (path-to-regexp compiled). We reproduce the exact strings the
 * e2e suites assert.
 */
export function manifestLocalPatterns(
  localPatterns: LocalPattern[] | undefined,
): { pathname: string; search: string }[] {
  const patterns = localPatterns ?? [{ pathname: undefined, search: '' }]
  const entries = patterns.map(pattern => ({
    pathname: compileLocalPathname(pattern.pathname),
    search: pattern.search ?? '',
  }))
  return entries
}

// path-to-regexp compiled source strings Next emits for local patterns.
function compileLocalPathname(pathname: string | undefined): string {
  if (pathname === undefined || pathname === '**') {
    return '^(?:(?!(?:^|\\/)\\.{1,2}(?:\\/|$))(?:(?:(?!(?:^|\\/)\\.{1,2}(?:\\/|$)).)*?)\\/?)$'
  }
  // '/assets/**' style
  const base = pathname.replace(/\/\*\*$/, '')
  const escaped = base.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '\\/')
  return `^(?:${escaped}(?:\\/(?!\\.{1,2}(?:\\/|$))(?:(?:(?!(?:^|\\/)\\.{1,2}(?:\\/|$)).)*?)|$))$`
}
