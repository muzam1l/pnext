import { routeHref, type SearchInput } from '../routing/href'
import type { RouteParams, RoutePath } from '../types'

export type { SearchInput, SearchValue } from '../routing/href'

const notFoundDigest = 'PNEXT_NOT_FOUND'
const redirectDigest = 'PNEXT_REDIRECT'
const forbiddenDigest = 'PNEXT_FORBIDDEN'
const unauthorizedDigest = 'PNEXT_UNAUTHORIZED'
const nextNotFoundDigest = 'NEXT_HTTP_ERROR_FALLBACK;404'
const nextForbiddenDigest = 'NEXT_HTTP_ERROR_FALLBACK;403'
const nextUnauthorizedDigest = 'NEXT_HTTP_ERROR_FALLBACK;401'

export type RedirectStatus = 303 | 307 | 308

class ReadonlyURLSearchParamsError extends Error {
  constructor() {
    super(
      'Method unavailable on `ReadonlyURLSearchParams`. Read more: https://nextjs.org/docs/app/api-reference/functions/use-search-params#updating-searchparams',
    )
  }
}

/**
 * A read-only `URLSearchParams`: mutation methods throw. Returned by
 * `useSearchParams()` so search params rendered from the URL cannot be
 * mutated in place (matches Next's `ReadonlyURLSearchParams`).
 */
export class ReadonlyURLSearchParams extends URLSearchParams {
  /** @deprecated Method unavailable on `ReadonlyURLSearchParams`. */
  append(): never {
    throw new ReadonlyURLSearchParamsError()
  }
  /** @deprecated Method unavailable on `ReadonlyURLSearchParams`. */
  delete(): never {
    throw new ReadonlyURLSearchParamsError()
  }
  /** @deprecated Method unavailable on `ReadonlyURLSearchParams`. */
  set(): never {
    throw new ReadonlyURLSearchParamsError()
  }
  /** @deprecated Method unavailable on `ReadonlyURLSearchParams`. */
  sort(): never {
    throw new ReadonlyURLSearchParamsError()
  }
}

type ParamsProp<Route extends RoutePath> =
  RouteParams<Route> extends Record<string, never>
    ? { params?: never }
    : { params: RouteParams<Route> }

export type HrefOptions<Route extends RoutePath> = ParamsProp<Route> & {
  search?: SearchInput
  hash?: string
}

export type RedirectOptions<Route extends RoutePath> = HrefOptions<Route> & {
  status?: RedirectStatus
}

export function href<Route extends RoutePath>(
  route: Route,
  ...[options]: RouteParams<Route> extends Record<string, never>
    ? [options?: HrefOptions<Route>]
    : [options: HrefOptions<Route>]
) {
  return routeHref(route, options)
}

export class PNextNotFoundError extends Error {
  digest = notFoundDigest

  constructor() {
    super('not found')
  }
}

export function notFound(): never {
  throw new PNextNotFoundError()
}

export class PNextForbiddenError extends Error {
  digest = forbiddenDigest

  constructor() {
    super('forbidden')
  }
}

/**
 * COMPAT (Next authInterrupts): stop rendering and serve the nearest
 * `forbidden.{tsx,...}` boundary with a 403. Only active when compat.next is on.
 */
export function forbidden(): never {
  throw new PNextForbiddenError()
}

export class PNextUnauthorizedError extends Error {
  digest = unauthorizedDigest

  constructor() {
    super('unauthorized')
  }
}

/**
 * COMPAT (Next authInterrupts): stop rendering and serve the nearest
 * `unauthorized.{tsx,...}` boundary with a 401. Only active when compat.next is on.
 */
export function unauthorized(): never {
  throw new PNextUnauthorizedError()
}

export class PNextRedirectError extends Error {
  digest = redirectDigest

  constructor(
    public location: string,
    public status: RedirectStatus = 307,
  ) {
    super(`redirect to ${location}`)
  }
}

export function redirect<Route extends RoutePath>(
  route: Route,
  options: RedirectOptions<Route>,
): never
export function redirect(location: string, status?: RedirectStatus): never
export function redirect<Route extends RoutePath>(
  location: Route | string,
  optionsOrStatus: RedirectOptions<Route> | RedirectStatus = 307,
): never {
  if (typeof optionsOrStatus === 'number') {
    if (redirectInBrowser(location, 'replace')) return undefined as never
    throw new PNextRedirectError(location, optionsOrStatus)
  }
  const href = routeHref(location, optionsOrStatus)
  if (redirectInBrowser(href, 'replace')) return undefined as never
  throw new PNextRedirectError(href, optionsOrStatus.status ?? 307)
}

export function permanentRedirect<Route extends RoutePath>(
  route: Route,
  options: HrefOptions<Route>,
): never
export function permanentRedirect(location: string): never
export function permanentRedirect<Route extends RoutePath>(
  location: Route | string,
  options?: HrefOptions<Route>,
): never {
  const href = options ? routeHref(location, options) : location
  if (redirectInBrowser(href, 'replace')) return undefined as never
  throw new PNextRedirectError(href, 308)
}

export function isNotFoundError(error: unknown) {
  return (
    error instanceof PNextNotFoundError ||
    errorDigest(error) === notFoundDigest ||
    errorDigest(error) === nextNotFoundDigest
  )
}

export function isRedirectError(error: unknown): error is PNextRedirectError {
  return error instanceof PNextRedirectError || errorDigest(error) === redirectDigest
}

export function isForbiddenError(error: unknown): error is PNextForbiddenError {
  return (
    error instanceof PNextForbiddenError ||
    errorDigest(error) === forbiddenDigest ||
    errorDigest(error) === nextForbiddenDigest
  )
}

export function isUnauthorizedError(error: unknown): error is PNextUnauthorizedError {
  return (
    error instanceof PNextUnauthorizedError ||
    errorDigest(error) === unauthorizedDigest ||
    errorDigest(error) === nextUnauthorizedDigest
  )
}

function errorDigest(error: unknown) {
  return typeof error === 'object' && error !== null && 'digest' in error
    ? (error as { digest?: unknown }).digest
    : undefined
}

function redirectInBrowser(location: string, mode: 'push' | 'replace') {
  if (!process.browser && typeof window === 'undefined') return false

  const href = new URL(location, window.location.href).href
  if (mode === 'push') window.location.assign(href)
  else window.location.replace(href)
  return true
}
