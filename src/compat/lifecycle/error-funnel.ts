// onRequestError funnel (COMPAT).
//
// Implements RequestExtensions.onRequestError: core calls it once per failed request with the error,
// request info and work-unit context. Compat classifies control-flow errors
// (notFound/redirect/forbidden/unauthorized/dynamic bailouts) and skips them, then forwards real errors
// to the user's instrumentation onRequestError(error, { path, method, headers }, context).
//
// Dedupe: the same request may surface an error at both the render site and the top-level catch, so a
// per-work-unit flag ensures the user hook fires exactly once.

import { getWorkUnit } from '../../request/context'
import { getRequestRuntime } from '../../routing/request-environment'
import { selectRouteForRequest } from '../../routing/routes'
import path from 'node:path'
import type { RouteManifestEntry } from '../../types'
import type { RequestErrorContext, RequestErrorInfo } from '../../extensions'
import {
  isForbiddenError,
  isNotFoundError,
  isRedirectError,
  isUnauthorizedError,
} from '../../api/navigation'
import { isPostpone } from '../../render/ppr'
import { markErrorLogged } from '../../utils/error-log'
import { getUserOnRequestError, instrumentationReady } from './instrumentation'

const ERROR_REPORTED_KEY = Symbol.for('pnext.errorReported')

/** True for Next control-flow errors that must NOT be reported to the hook. */
function isControlFlowError(error: unknown): boolean {
  return (
    isRedirectError(error) ||
    isNotFoundError(error) ||
    isForbiddenError(error) ||
    isUnauthorizedError(error) ||
    isPostpone(error) ||
    isNextDynamicNoSsr(error)
  )
}

/** next/dynamic ssr:false bailout digest (skip-next-internal-error asserts skip). */
function isNextDynamicNoSsr(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null | undefined)?.digest
  return (
    digest === 'NEXT_DYNAMIC_NO_SSR_CODE' ||
    (typeof digest === 'string' && digest.startsWith('DYNAMIC_SERVER_USAGE'))
  )
}

/**
 * Convert a pnext route pattern (`/app-page/dynamic/:id`, `:slug*` catch-alls)
 * into Next's display form (`/app-page/dynamic/[id]`, `[...slug]`), which the
 * onRequestError `routePath` field reports. Mirrors pnext-cli's toNextRoute.
 */
function toDisplayRoute(route: RouteManifestEntry): string {
  let value = route.route || '/'
  if (route.catchAll) {
    const pattern = route.catchAllOptional ? `[[...${route.catchAll}]]` : `[...${route.catchAll}]`
    value = value.replace(`:${route.catchAll}*`, pattern)
  }
  for (const param of route.params) value = value.replace(`:${param}`, `[${param}]`)
  return value
}

/** Return `Pages Router` when route files live under pages/, otherwise `App Router`. */
function routeKindFromFile(
  runtimeRoot: string | undefined,
  route: RouteManifestEntry,
): 'Pages Router' | 'App Router' {
  if (!runtimeRoot) {
    return 'App Router'
  }
  const normalized = path.normalize(route.file)
  const pagesRoot = path.join(runtimeRoot, 'pages')
  const appRoot = path.join(runtimeRoot, 'app')
  return normalized.startsWith(pagesRoot + path.sep) || normalized === pagesRoot
    ? 'Pages Router'
    : normalized.startsWith(appRoot + path.sep) || normalized === appRoot
      ? 'App Router'
      : 'App Router'
}

interface RouteMatch {
  route: RouteManifestEntry
  routePath: string
}

function resolveRoute(pathname: string): RouteMatch | undefined {
  const runtime = getRequestRuntime()
  if (!runtime) return undefined
  const selectedPath = pathname.split('?')[0] ?? pathname
  const matched = selectRouteForRequest(runtime.routes, selectedPath, undefined)
  if (!matched) return undefined
  return { route: matched.route, routePath: toDisplayRoute(matched.route) }
}

/**
 * Resolve the matched route's display pattern for the failing request from the
 * live routing runtime (the same seam otel uses for `next.route`). Returns
 * undefined outside a request scope or when no route matches (e.g. a 404).
 */
function resolveRoutePath(path: string): string | undefined {
  try {
    return resolveRoute(path)?.routePath
  } catch {
    return undefined
  }
}

/**
 * Map the work-unit facts onto Next's onRequestError context. pnext is
 * app-router only, so routerKind is always 'App Router'. routeType is 'route'
 * for route handlers and 'render' for page renders. routePath is the matched
 * route's display pattern. renderSource is reported for page renders (route
 * handlers leave it undefined). A dedicated revalidateReason is threaded in when
 * core reports an ISR revalidation error.
 */
function errorDigest(error: unknown): string | undefined {
  const digest = (error as { digest?: unknown } | null | undefined)?.digest
  return typeof digest === 'string' ? digest : undefined
}

function buildContext(
  error: unknown,
  context: RequestErrorContext,
  path: string,
): Record<string, unknown> {
  const runtime = getRequestRuntime()
  const match = runtime ? resolveRoute(path) : undefined
  const out: Record<string, unknown> = {}
  out.routerKind = match ? routeKindFromFile(runtime?.config.root, match.route) : 'App Router'
  out.routeType = context.routeKind === 'route-handler' ? 'route' : 'render'
  const routePath = match ? match.routePath : resolveRoutePath(path)
  if (routePath) out.routePath = routePath
  if (context.routeKind === 'html') {
    out.renderSource =
      (context as { renderSource?: string }).renderSource ?? 'react-server-components'
  }
  const revalidateReason = (context as { revalidateReason?: string }).revalidateReason
  if (revalidateReason) out.revalidateReason = revalidateReason
  const digest = errorDigest(error)
  if (digest) out.digest = digest
  return out
}

/**
 * Next's onRequestError context for a thrown server action. Shared by the action endpoint path and the
 * render-funnel path: an inline `<form action>` action throws DURING the page re-render, so core's
 * render funnel reports it first and wins the per-work-unit dedupe - it must carry the same action
 * context the endpoint would (routeType 'action', RSC-payload source) or the suite sees a render context.
 */
function buildActionContext(error: unknown, path: string): Record<string, unknown> {
  const runtime = getRequestRuntime()
  const match = runtime ? resolveRoute(path) : undefined
  const out: Record<string, unknown> = {
    routerKind: match ? routeKindFromFile(runtime?.config.root, match.route) : 'App Router',
    routeType: 'action',
    renderSource: 'react-server-components-payload',
  }
  const routePath = match ? match.routePath : resolveRoutePath(path)
  if (routePath) out.routePath = routePath
  const digest = errorDigest(error)
  if (digest) out.digest = digest
  return out
}

/** True when the failing request is a server-action invocation (JS/form dispatch). */
function isServerActionRequest(headers: Headers): boolean {
  if (headers.has('next-action')) return true
  const accept = headers.get('accept') ?? ''
  return accept.includes('text/x-component')
}

/**
 * Report a thrown server-action error to the user's onRequestError hook. The
 * action endpoint swallows the throw into a masked 500 response, so core's funnel
 * never sees it; this is the action-path equivalent. Context mirrors Next's
 * action error shape (`routeType: 'action'`, RSC-payload render source) the
 * on-request-error/server-action-error suite asserts. Skips control-flow errors
 * (redirect()/notFound()) and never throws.
 */
export async function reportActionErrorToUser(error: unknown, request: Request): Promise<void> {
  if (isControlFlowError(error)) return

  const unit = getWorkUnit()
  if (unit) {
    const bag = (unit.compat ??= {})
    if (bag[ERROR_REPORTED_KEY]) return
    bag[ERROR_REPORTED_KEY] = true
  }

  await instrumentationReady()
  const hook = getUserOnRequestError()
  if (!hook) return

  let path = request.url
  try {
    const parsed = new URL(request.url)
    path = parsed.pathname + parsed.search
  } catch {
    // request.url is already a path.
  }

  try {
    await hook(
      error,
      { path, method: request.method, headers: headersToObject(request.headers) },
      buildActionContext(error, path),
    )
  } catch (hookError) {
    console.error('instrumentation onRequestError failed:', hookError)
  }
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}

/**
 * RequestExtensions.onRequestError implementation. Skips control-flow errors,
 * dedupes per work unit, and forwards to the user hook. Never throws.
 */
export async function reportRequestErrorToUser(
  error: unknown,
  requestInfo: RequestErrorInfo,
  context: RequestErrorContext,
): Promise<void> {
  if (isControlFlowError(error)) return

  const unit = getWorkUnit()
  if (unit) {
    const bag = (unit.compat ??= {})
    if (bag[ERROR_REPORTED_KEY]) return
    bag[ERROR_REPORTED_KEY] = true
  }

  await instrumentationReady()
  const hook = getUserOnRequestError()
  if (!hook) return

  // `path` is the original URL incl. search (dynamic-routes asserts search present).
  let path = requestInfo.url
  try {
    const parsed = new URL(requestInfo.url)
    path = parsed.pathname + parsed.search
  } catch {
    // requestInfo.url is already a path.
  }

  // An inline `<form action>` action throws inside the page re-render, so this
  // render funnel reports before the action endpoint and wins the dedupe — emit
  // the action context so it matches what the endpoint would have reported.
  const hookContext = isServerActionRequest(requestInfo.headers)
    ? buildActionContext(error, path)
    : buildContext(error, context, path)

  try {
    await hook(
      error,
      { path, method: requestInfo.method, headers: headersToObject(requestInfo.headers) },
      hookContext,
    )
  } catch (hookError) {
    console.error('instrumentation onRequestError failed:', hookError)
  }
}

let guardInstalled = false

/**
 * Server-lifecycle safety net for SSR errors that escape as unhandled promise rejections instead of
 * surfacing through a render catch.
 *
 * A `'use client'` component that throws during server rendering is stringified by
 * preact-render-to-string's async pass, which RESOLVES the render to an empty string while floating the
 * component's own rejected promise. That rejection is never awaited by the render pipeline, so without
 * this guard it reaches the process as an unhandledRejection and takes down every in-flight and
 * subsequent request.
 *
 * Installed once, compat-only:
 *   - Control-flow signals are navigation intents, not failures. They are absorbed silently, never
 *     logged, matching Next's skip-next-internal-error contract - the raw digests would otherwise print
 *     the internal strings those tests assert are absent.
 *   - A real error is logged once, deduped against the render/handler catch's own log, so it is never
 *     silently lost. The listener's mere presence stops the default process crash.
 *
 * The correct request-scoped report for such an error requires the renderer to catch the async client
 * throw at the SSR site and route it through reportRequestError; this net only guarantees survival.
 */
export function installUnhandledRejectionGuard(): void {
  if (guardInstalled) return
  if (typeof process === 'undefined' || typeof process.on !== 'function') return
  guardInstalled = true
  process.on('unhandledRejection', (reason: unknown) => {
    if (isControlFlowError(reason)) return
    if (markErrorLogged(reason)) console.error(reason)
  })
}
