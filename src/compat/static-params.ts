import { AsyncLocalStorage } from 'node:async_hooks'
import type { RouteManifestEntry, RouteParamValue } from '../types'

// globalThis-anchored (this module can be loaded twice — original + built copy
// — and both must observe the same scope; see the use-cache module-duplication
// incident).
const GSP_SCOPE = Symbol.for('pnext.generateStaticParamsScope')
interface GspScope {
  /** Params provided by parent generateStaticParams calls. */
  provided: Record<string, unknown>
}
const globals = globalThis as { [GSP_SCOPE]?: AsyncLocalStorage<GspScope> }
const gspScope = (globals[GSP_SCOPE] ??= new AsyncLocalStorage<GspScope>())

/** The active generateStaticParams scope, or undefined outside one. */
export function generateStaticParamsScope(): GspScope | undefined {
  return gspScope.getStore()
}

export function aliasGenerateStaticParams(
  module: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof module.params === 'function' || typeof module.generateStaticParams !== 'function') {
    return module
  }
  const generate = module.generateStaticParams as (args?: {
    params?: Record<string, unknown>
  }) => unknown
  // Wrap so root-params getters can tell they are running inside a
  // generateStaticParams call (and which parent params are available) —
  // reading a root param inside the generateStaticParams that defines it is a
  // build error (app-root-params-getters/generate-static-params-error).
  const params = (args?: { params?: Record<string, unknown> }) =>
    gspScope.run({ provided: args?.params ?? {} }, () => generate(args))
  return { ...module, params }
}

// Request-time admission of closed params: a `not-found` matching policy or a
// `dynamicParams = false` declaration restricts those params to the sets
// generateStaticParams produced at build. A rejected route falls through to
// the next match (Next's prerender-manifest `fallback: false` matchers).

/** A generated (raw) param value against the request's canonical-encoded one. */
export function paramValueMatches(
  generated: RouteParamValue | undefined,
  requested: RouteParamValue | undefined,
): boolean {
  const encoded =
    generated === undefined
      ? ''
      : Array.isArray(generated)
        ? generated.map(encodeURIComponent).join('/')
        : encodeURIComponent(generated)
  const actual =
    requested === undefined ? '' : Array.isArray(requested) ? requested.join('/') : requested
  return encoded === actual
}

export function paramSetMatches(
  set: Record<string, RouteParamValue>,
  params: Record<string, RouteParamValue>,
  names: string[],
): boolean {
  return names.every(name => paramValueMatches(set[name], params[name]))
}

export function admitRoute(
  route: RouteManifestEntry,
  params: Record<string, RouteParamValue>,
  headers?: Headers,
): boolean {
  // Only a build enumerates sets; read it first so matching never resolves deferred scan facts.
  const sets = route.prerenderedParams
  if (!sets) return true
  const closed = closedParams(route)
  if (closed.length === 0) return true
  // Draft mode previews an unlisted path without admitting it for others.
  if (/(?:^|;\s*)__prerender_bypass=/.test(headers?.get('cookie') ?? '')) return true
  // Handler params arrive decoded; pages carry the encoded form generated values compare against.
  const requested = route.kind === 'handler' ? encodedParams(params) : params
  return sets.some(set => paramSetMatches(set, requested, closed))
}

function encodedParams(params: Record<string, RouteParamValue>): Record<string, RouteParamValue> {
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.map(encodeURIComponent) : encodeURIComponent(value),
    ]),
  )
}

/**
 * The prefix a request promotes into a concrete shell: every param through the last one
 * configured `not-found`, `blocking` or `fallback`; a `blocking` param makes the response wait.
 * An unconfigured tail stays dynamic.
 */
export function paramPromotion(
  route: RouteManifestEntry,
): { length: number; foreground: boolean } | undefined {
  const policy = route.paramMatching
  if (!policy) return undefined
  const names = [...route.params, ...(route.catchAll ? [route.catchAll] : [])]
  let length = 0
  let foreground = false
  names.forEach((name, index) => {
    const mode = policy[name]
    if (mode === 'blocking') foreground = true
    if (mode === 'not-found' || mode === 'blocking' || mode === 'fallback') length = index + 1
  })
  return length > 0 ? { length, foreground } : undefined
}

function closedParams(route: RouteManifestEntry): string[] {
  const names = [...route.params, ...(route.catchAll ? [route.catchAll] : [])]
  const governed = route.segmentConfig?.dynamicParamsFalse ?? []
  // The page's own static params export: the full tuple must match (Next's fallback: false).
  if (governed.length > 0 && route.segmentConfig?.strictDynamicParams) return names
  const policy = route.paramMatching ?? {}
  return names.filter(name => governed.includes(name) || policy[name] === 'not-found')
}
