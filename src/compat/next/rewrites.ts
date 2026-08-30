/**
 * next.config `rewrites` support (Next compat): request pathnames are rewritten to their destination
 * before static-file lookup and routing, so prebuilt output and revalidatePath marks work against the
 * destination path.
 *
 * Supported: array form and the { beforeFiles, afterFiles, fallback } object form (fallback entries
 * apply only to requests that would otherwise 404); `:param`, `:param*`/`:param+`/`:param?` and
 * `:param(regex)` tokens in the source; `:param` / `:param*` substitution in the destination path AND
 * query; has/missing conditions of type host/header/query/cookie, including named-capture value regexes
 * whose captures feed destination params.
 *
 * Rewrite parameters follow Next's rule: params captured from the source/has that are NOT consumed by
 * the destination are appended to the query - but only when NONE of the params are used in the
 * destination. If any param is used there, no params are auto-appended and the incoming query is
 * preserved. This is what keeps rewrite params from leaking into searchParams.
 *
 * Divergence: the render sees the destination URL (Next keeps the requested URL as canonical for
 * usePathname; recordCanonicalUrl handles that separately).
 */
import { loadNextConfig, loadResolvedNextConfig } from '../actions/config'

export interface CompatRewrite {
  regex: RegExp
  paramNames: string[]
  destination: string
  has: RewriteCondition[]
  missing: RewriteCondition[]
  /**
   * A `fallback` rewrite: Next applies it only after filesystem AND dynamic
   * routes have all missed, i.e. only on a request that would otherwise 404.
   * `beforeFiles`/`afterFiles` (and the array form, which is `afterFiles`)
   * apply ahead of routing and carry this false.
   */
  fallback: boolean
  /**
   * `basePath: false` on the entry: the source is matched against the RAW
   * request path, outside the configured basePath. Core 404s such paths before
   * routing, so these rules get their turn from the outside-basePath pass
   * instead of the normal one (and never both).
   */
  outsideBasePath: boolean
}

export interface RewriteCondition {
  type: 'host' | 'header' | 'query' | 'cookie'
  key?: string
  value?: string
}

interface RewriteEntry {
  source?: string
  destination?: string
  has?: unknown
  missing?: unknown
  basePath?: unknown
}

/** Request facts a rewrite's `has`/`missing` conditions are evaluated against. */
export interface RewriteRequestContext {
  host: string
  headers: Headers
  cookies: Record<string, string>
  query: URLSearchParams
}

const VALID_CONDITION_TYPES = new Set(['host', 'header', 'query', 'cookie'])

export async function loadCompatRewrites(root: string): Promise<CompatRewrite[]> {
  let config = await loadResolvedNextConfig(root)
  if (typeof config?.rewrites !== 'function') config = await loadNextConfig(root)
  const producer = config?.rewrites
  if (typeof producer !== 'function') return []
  let value: unknown
  try {
    value = await producer()
  } catch {
    return []
  }
  const entries: (RewriteEntry & { fallback: boolean })[] = Array.isArray(value)
    ? (value as RewriteEntry[]).map(entry => ({ ...entry, fallback: false }))
    : value && typeof value === 'object'
      ? (['beforeFiles', 'afterFiles', 'fallback'] as const).flatMap(key => {
          const list = (value as Record<string, unknown>)[key]
          return Array.isArray(list)
            ? (list as RewriteEntry[]).map(entry => ({ ...entry, fallback: key === 'fallback' }))
            : []
        })
      : []

  const rewrites: CompatRewrite[] = []
  for (const entry of entries) {
    if (!entry?.source || !entry.destination) continue
    const has = parseConditions(entry.has)
    const missing = parseConditions(entry.missing)
    if (has === null || missing === null) continue // unsupported condition shape
    const compiled = compileSource(entry.source)
    if (compiled) {
      rewrites.push({
        ...compiled,
        destination: entry.destination,
        has,
        missing,
        fallback: entry.fallback,
        outsideBasePath: entry.basePath === false,
      })
    }
  }
  return rewrites
}

/** Parse a has/missing list into typed conditions; null if any entry is unsupported. */
export function parseConditions(value: unknown): RewriteCondition[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const conditions: RewriteCondition[] = []
  for (const raw of value as unknown[]) {
    if (!raw || typeof raw !== 'object') return null
    const { type, key, value: condValue } = raw as Record<string, unknown>
    if (typeof type !== 'string' || !VALID_CONDITION_TYPES.has(type)) return null
    if (key !== undefined && typeof key !== 'string') return null
    if (condValue !== undefined && typeof condValue !== 'string') return null
    conditions.push({
      type: type as RewriteCondition['type'],
      ...(typeof key === 'string' ? { key } : {}),
      ...(typeof condValue === 'string' ? { value: condValue } : {}),
    })
  }
  return conditions
}

export function compileSource(source: string): { regex: RegExp; paramNames: string[] } | null {
  const paramNames: string[] = []
  // Match against the pathname. Note: the source is a path-to-regexp pattern
  // (query matching is done via `has` conditions), so it never carries a
  // literal `?query`. We must NOT split on `?` — a `?` may legitimately appear
  // inside a regex token such as `:path((?!sitemap.xml$).*)` or `(?<name>...)`.
  const segments = source.split('/').filter(Boolean)
  const parts: string[] = []
  for (const segment of segments) {
    // :param(customRegex) — a named param with an explicit regex body (may span
    // the whole segment, e.g. `:path((?!sitemap.xml$).*)`).
    const custom = /^:([A-Za-z_$][\w$]*)\((.*)\)$/.exec(segment)
    if (custom?.[1] !== undefined && custom[2] !== undefined) {
      paramNames.push(custom[1])
      parts.push(`(${custom[2]})`)
      continue
    }
    const catchAll = /^:([A-Za-z_$][\w$]*)[*+]$/.exec(segment)
    if (catchAll?.[1]) {
      paramNames.push(catchAll[1])
      parts.push('(.*)')
      continue
    }
    const optional = /^:([A-Za-z_$][\w$]*)\?$/.exec(segment)
    if (optional?.[1]) {
      paramNames.push(optional[1])
      parts.push('([^/]*)')
      continue
    }
    const param = /^:([A-Za-z_$][\w$]*)$/.exec(segment)
    if (param?.[1]) {
      paramNames.push(param[1])
      parts.push('([^/]+)')
      continue
    }
    // A bare regex group segment — `/(.*)` is Next's documented way to match
    // every path in a headers rule. Non-capturing so it never shifts the
    // capture indexes the named params above are read from.
    if (segment.startsWith('(') && segment.endsWith(')')) {
      parts.push(`(?:${segment.slice(1, -1)})`)
      continue
    }
    // Plain literal segments may carry regex-significant filename characters
    // (`favicon.ico`, `sitemap.xml`) — escape them. Anything with actual
    // pattern syntax beyond that is unsupported.
    if (/^[\w.\- ]+$/.test(segment)) {
      parts.push(segment.replace(/\./g, '\\.'))
      continue
    }
    if (/[.*+?^${}()|[\]\\]/.test(segment)) return null // unsupported literal syntax
    parts.push(segment.replace(/[/\\]/g, ''))
  }
  return { regex: new RegExp(`^/${parts.join('/')}/?$`), paramNames }
}

/** Evaluate a single has/missing condition, returning captured params or null (no match). */
function evaluateCondition(
  condition: RewriteCondition,
  ctx: RewriteRequestContext,
): Record<string, string> | null {
  const target = conditionTarget(condition, ctx)
  if (target === undefined) return null
  if (condition.value === undefined) return {} // presence-only match
  // Anchor the value regex the way Next does (full-value match).
  const regex = new RegExp(`^(?:${condition.value})$`)
  const match = regex.exec(target)
  if (!match) return null
  return match.groups ? { ...match.groups } : {}
}

function conditionTarget(
  condition: RewriteCondition,
  ctx: RewriteRequestContext,
): string | undefined {
  switch (condition.type) {
    case 'host':
      return ctx.host
    case 'header':
      return condition.key ? (ctx.headers.get(condition.key) ?? undefined) : undefined
    case 'cookie':
      return condition.key ? ctx.cookies[condition.key] : undefined
    case 'query':
      return condition.key ? (ctx.query.get(condition.key) ?? undefined) : undefined
    default:
      return undefined
  }
}

export interface RewriteResult {
  pathname: string
  /** Search params after the rewrite (original query + any auto-appended params). */
  search: URLSearchParams
  /** Fully-qualified destination for external rewrites (`https://...`). */
  destination?: string
}

/**
 * Back-compat wrapper: the destination pathname of the first matching rewrite,
 * or undefined. Prefer resolveCompatRewrite (returns the resolved search params
 * too, so rewrite params never leak into searchParams and `has` conditions can
 * be evaluated against the request).
 */
export function applyCompatRewrites(
  rewrites: readonly CompatRewrite[],
  pathname: string,
  ctx?: RewriteRequestContext,
): string | undefined {
  return resolveCompatRewrite(rewrites, pathname, ctx)?.pathname
}

/**
 * First matching rewrite applied to the request, or undefined. Returns the
 * destination pathname plus the resolved search params (rewrite params only
 * leak into the query when none are used in the destination).
 */
export function resolveCompatRewrite(
  rewrites: readonly CompatRewrite[],
  pathname: string,
  ctx?: RewriteRequestContext,
): RewriteResult | undefined {
  const context: RewriteRequestContext = ctx ?? {
    host: '',
    headers: new Headers(),
    cookies: {},
    query: new URLSearchParams(),
  }
  for (const rewrite of rewrites) {
    const match = rewrite.regex.exec(pathname)
    if (!match) continue

    // Collect all params: source captures first, then has/missing captures.
    const params: Record<string, string> = {}
    rewrite.paramNames.forEach((name, index) => {
      params[name] = match[index + 1] ?? ''
    })

    const conditionParams = evaluateConditions(rewrite, context)
    if (conditionParams === null) continue // has/missing gate failed
    Object.assign(params, conditionParams)

    const [destPath, destQuery] = splitDestination(rewrite.destination)
    const { pathname: newPath, used: usedInPath } = substitute(destPath, params)
    const search = new URLSearchParams(context.query)

    // Destination-declared query params (?key=:val) are always applied.
    let usedInQuery = false
    if (destQuery) {
      const destParams = new URLSearchParams(destQuery)
      for (const [key, rawValue] of destParams.entries()) {
        const { pathname: value, used } = substitute(rawValue, params)
        if (used) usedInQuery = true
        search.set(key, value)
      }
    }

    // Next rule: only auto-append unused params to the query when NONE of the
    // params were used in the destination. If any param is used, nothing leaks.
    const anyUsed = usedInPath.size > 0 || usedInQuery
    if (!anyUsed) {
      for (const [name, value] of Object.entries(params)) {
        if (!search.has(name)) search.append(name, value)
      }
    }

    return {
      pathname: newPath,
      search,
      destination: /^https?:/.test(newPath) ? normalizeDestination(newPath, search) : undefined,
    }
  }
  return undefined
}

function normalizeDestination(pathname: string, search: URLSearchParams): string | undefined {
  try {
    const destination = new URL(pathname)
    for (const [key, value] of search.entries()) {
      destination.searchParams.set(key, value)
    }
    return destination.toString()
  } catch {
    return undefined
  }
}

/** Apply all has (must all match) + missing (must all fail); returns merged captures or null. */
export function evaluateConditions(
  rule: { has: RewriteCondition[]; missing: RewriteCondition[] },
  ctx: RewriteRequestContext,
): Record<string, string> | null {
  const params: Record<string, string> = {}
  for (const condition of rule.has) {
    const captured = evaluateCondition(condition, ctx)
    if (captured === null) return null
    Object.assign(params, captured)
  }
  for (const condition of rule.missing) {
    if (evaluateCondition(condition, ctx) !== null) return null
  }
  return params
}

export function splitDestination(destination: string): [string, string | undefined] {
  const index = destination.indexOf('?')
  if (index === -1) return [destination, undefined]
  return [destination.slice(0, index), destination.slice(index + 1)]
}

/**
 * Substitute `:param*` / `:param` tokens in a destination string. Returns the
 * result and the set of param names actually consumed (drives the leak rule).
 */
export function substitute(
  template: string,
  params: Record<string, string>,
): { pathname: string; used: Set<string> } {
  const used = new Set<string>()
  const result = template.replace(/:([A-Za-z_$][\w$]*)(\*|\+|\?)?/g, (whole, name: string) => {
    if (!(name in params)) return whole
    used.add(name)
    return params[name] ?? ''
  })
  return { pathname: result, used }
}
