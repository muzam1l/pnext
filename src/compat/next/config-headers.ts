/**
 * next.config `headers()` support (Next compat): every rule whose `source` matches the as-requested
 * pathname contributes its `headers` to the response. Shares the source/condition/substitution
 * machinery with rewrites and redirects (`:param`, `:param*`/`+`/`?`, `:param(regex)`, bare `(regex)`,
 * has/missing of type host/header/query/cookie, `basePath: false`).
 *
 * Unlike redirects/rewrites, matching does NOT stop at the first hit: Next walks the whole header route
 * list and accumulates, so a later rule overwrites an earlier one per key while `set-cookie` appends.
 * Key AND value take `:param` substitution (Next's compileNonPath).
 *
 * The rules are applied by the cache-control finalizer (compat/cache-control.ts), which owns the
 * response seam headers share with the ISR Cache-Control defaults - config headers land first, exactly
 * as Next's router sets them on `res` before the render runs.
 */
import { loadNextConfig, loadResolvedNextConfig } from '../actions/config'
import {
  compileSource,
  evaluateConditions,
  parseConditions,
  substitute,
  type RewriteCondition,
  type RewriteRequestContext,
} from './rewrites'

export interface CompatHeaderPair {
  key: string
  value: string
}

export interface CompatHeaderRule {
  regex: RegExp
  paramNames: string[]
  headers: CompatHeaderPair[]
  has: RewriteCondition[]
  missing: RewriteCondition[]
  /** `basePath: false`: the source matches the RAW path, outside the basePath. */
  outsideBasePath: boolean
}

interface HeaderEntry {
  source?: string
  headers?: unknown
  has?: unknown
  missing?: unknown
  basePath?: unknown
}

export async function loadCompatHeaders(root: string): Promise<CompatHeaderRule[]> {
  let config = await loadResolvedNextConfig(root)
  if (typeof config?.headers !== 'function') config = await loadNextConfig(root)
  const producer = config?.headers
  if (typeof producer !== 'function') return []
  let value: unknown
  try {
    value = await producer()
  } catch {
    return []
  }
  if (!Array.isArray(value)) return []

  const rules: CompatHeaderRule[] = []
  for (const entry of value as HeaderEntry[]) {
    if (!entry?.source || !Array.isArray(entry.headers)) continue
    const headers = parseHeaderPairs(entry.headers)
    if (headers.length === 0) continue
    const has = parseConditions(entry.has)
    const missing = parseConditions(entry.missing)
    if (has === null || missing === null) continue // unsupported condition shape
    const compiled = compileSource(entry.source)
    if (!compiled) continue
    rules.push({
      ...compiled,
      headers,
      has,
      missing,
      outsideBasePath: entry.basePath === false,
    })
  }
  return rules
}

function parseHeaderPairs(value: readonly unknown[]): CompatHeaderPair[] {
  const pairs: CompatHeaderPair[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const { key, value: headerValue } = raw as Record<string, unknown>
    if (typeof key !== 'string' || typeof headerValue !== 'string') continue
    pairs.push({ key, value: headerValue })
  }
  return pairs
}

/** Every matching rule's headers, in rule order (the caller resolves per-key precedence). */
export function resolveCompatHeaders(
  rules: readonly CompatHeaderRule[],
  pathname: string,
  ctx?: RewriteRequestContext,
): CompatHeaderPair[] {
  const context: RewriteRequestContext = ctx ?? {
    host: '',
    headers: new Headers(),
    cookies: {},
    query: new URLSearchParams(),
  }
  const resolved: CompatHeaderPair[] = []
  for (const rule of rules) {
    const match = rule.regex.exec(pathname)
    if (!match) continue

    const params: Record<string, string> = {}
    rule.paramNames.forEach((name, index) => {
      params[name] = match[index + 1] ?? ''
    })

    const conditionParams = evaluateConditions(rule, context)
    if (conditionParams === null) continue // has/missing gate failed
    Object.assign(params, conditionParams)

    const hasParams = Object.keys(params).length > 0
    for (const pair of rule.headers) {
      resolved.push(
        hasParams
          ? {
              key: substitute(pair.key, params).pathname,
              value: substitute(pair.value, params).pathname,
            }
          : pair,
      )
    }
  }
  return resolved
}

/** The in-app path for a raw request pathname, or undefined when it lies outside the basePath. */
export function appPathname(pathname: string, basePath: string): string | undefined {
  if (!basePath) return pathname
  if (pathname === basePath) return '/'
  return pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : undefined
}
