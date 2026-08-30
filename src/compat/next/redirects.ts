/**
 * next.config `redirects` support (Next compat): a request whose pathname matches a redirect source is
 * answered with an HTTP redirect to the destination before routing. Shares the
 * source/condition/substitution machinery with rewrites; unlike rewrites, external (http/https)
 * destinations are kept, since redirects commonly point off-site.
 *
 * Status: `permanent: true` is 308, `permanent: false` is 307, or an explicit numeric `statusCode`.
 * Source params captured but not consumed by the destination are appended to the destination query,
 * the same rule rewrites follow.
 */
import { loadNextConfig } from '../actions/config'
import {
  compileSource,
  evaluateConditions,
  parseConditions,
  splitDestination,
  substitute,
  type RewriteCondition,
  type RewriteRequestContext,
} from './rewrites'

export interface CompatRedirect {
  regex: RegExp
  paramNames: string[]
  destination: string
  has: RewriteCondition[]
  missing: RewriteCondition[]
  status: number
  /** `basePath: false`: the source matches the RAW path, outside the basePath. */
  outsideBasePath: boolean
}

interface RedirectEntry {
  source?: string
  destination?: string
  permanent?: boolean
  statusCode?: number
  has?: unknown
  missing?: unknown
  basePath?: unknown
}

export async function loadCompatRedirects(root: string): Promise<CompatRedirect[]> {
  const config = await loadNextConfig(root)
  const producer = config?.redirects
  if (typeof producer !== 'function') return []
  let value: unknown
  try {
    value = await producer()
  } catch {
    return []
  }
  if (!Array.isArray(value)) return []

  const redirects: CompatRedirect[] = []
  for (const entry of value as RedirectEntry[]) {
    if (!entry?.source || !entry.destination) continue
    const has = parseConditions(entry.has)
    const missing = parseConditions(entry.missing)
    if (has === null || missing === null) continue // unsupported condition shape
    const compiled = compileSource(entry.source)
    if (!compiled) continue
    const status =
      typeof entry.statusCode === 'number' ? entry.statusCode : entry.permanent ? 308 : 307
    redirects.push({
      ...compiled,
      destination: entry.destination,
      has,
      missing,
      status,
      outsideBasePath: entry.basePath === false,
    })
  }
  return redirects
}

export interface RedirectResult {
  location: string
  status: number
}

/** First matching redirect for the request, or undefined. */
export function resolveCompatRedirect(
  redirects: readonly CompatRedirect[],
  pathname: string,
  ctx?: RewriteRequestContext,
): RedirectResult | undefined {
  const context: RewriteRequestContext = ctx ?? {
    host: '',
    headers: new Headers(),
    cookies: {},
    query: new URLSearchParams(),
  }
  for (const redirect of redirects) {
    const match = redirect.regex.exec(pathname)
    if (!match) continue

    const params: Record<string, string> = {}
    redirect.paramNames.forEach((name, index) => {
      params[name] = match[index + 1] ?? ''
    })

    const conditionParams = evaluateConditions(redirect, context)
    if (conditionParams === null) continue // has/missing gate failed
    Object.assign(params, conditionParams)

    const [destPath, destQuery] = splitDestination(redirect.destination)
    const { pathname: resolvedPath, used: usedInPath } = substitute(destPath, params)

    const query = new URLSearchParams()
    let usedInQuery = false
    if (destQuery) {
      for (const [key, rawValue] of new URLSearchParams(destQuery).entries()) {
        const { pathname: value, used } = substitute(rawValue, params)
        if (used) usedInQuery = true
        query.set(key, value)
      }
    }
    // Next appends source params not consumed by the destination to the query.
    if (usedInPath.size === 0 && !usedInQuery) {
      for (const [name, value] of Object.entries(params)) {
        if (!query.has(name)) query.append(name, value)
      }
    }

    const search = query.toString()
    const location = search
      ? `${resolvedPath}${resolvedPath.includes('?') ? '&' : '?'}${search}`
      : resolvedPath
    return { location, status: redirect.status }
  }
  return undefined
}
