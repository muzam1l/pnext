import { isNotFoundError, isRedirectError } from '../api/navigation'
import { getWorkUnit, runWithRequest } from '../request/context'
import { nextResponseMeta, toNextRequest } from '../api/server'
import { getRenderExtensions, reportRequestError } from '../extensions'
import type { NextRequest, RouteManifestEntry, RouteParamValue } from '../types'
import { safeDecode } from '../utils/decode'

const routeMethods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const

type RouteMethod = (typeof routeMethods)[number]

// Methods that are valid HTTP verbs but may be unimplemented on a route (405),
// vs. tokens that are not HTTP methods at all (400). Next answers 400 for the
// latter (e.g. a `HEADER` request) and 405 for a real-but-missing verb.
const httpMethods = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'CONNECT',
  'TRACE',
])

interface RouteHandlerContext {
  params?: Promise<Record<string, RouteParamValue>>
}

interface HandleRouteOptions {
  /** Absolute route file path, used in the "no response returned" CLI error. */
  routeFile?: string
}

export interface RouteHandlerModule {
  params?: () => Record<string, RouteParamValue>[] | Promise<Record<string, RouteParamValue>[]>
  GET?: RouteHandler
  HEAD?: RouteHandler
  POST?: RouteHandler
  PUT?: RouteHandler
  PATCH?: RouteHandler
  DELETE?: RouteHandler
  OPTIONS?: RouteHandler
}

type RouteHandler = (
  request: NextRequest,
  context: RouteHandlerContext,
) => Response | undefined | void | Promise<Response | undefined | void>

export async function handleRouteModule(
  module: RouteHandlerModule,
  request: Request,
  params: Record<string, RouteParamValue>,
  options: HandleRouteOptions = {},
) {
  // Response-headers channel for the handler's request scope: APIs like
  // draftMode().enable() append set-cookie here while the handler runs, and
  // the headers are merged onto whatever response goes out — including the
  // synthesized redirect response when the handler throws redirect().
  const responseHeaders = new Headers()
  const method = request.method.toUpperCase()
  try {
    // A request method that is not a valid HTTP verb is a bad request, not an
    // unimplemented one (Next returns 400 with an empty body).
    if (!httpMethods.has(method)) return new Response(null, { status: 400 })

    const handler = routeMethods.includes(method as RouteMethod)
      ? module[method as RouteMethod]
      : undefined

    if (!handler) {
      if (method === 'HEAD' && module.GET) {
        // Auto-HEAD from GET: run GET, validate it, then drop the body.
        const response = finalizeResponse(
          await callHandler(module.GET, request, params, responseHeaders),
          request,
          responseHeaders,
          options,
        )
        return new Response(null, { status: response.status, headers: response.headers })
      }
      return missingMethodResponse(module, method)
    }

    return finalizeResponse(
      await callHandler(handler, request, params, responseHeaders),
      request,
      responseHeaders,
      options,
    )
  } catch (error) {
    if (isRedirectError(error)) {
      // POST submissions get a 303 (Next's behavior for redirect() and
      // permanentRedirect() thrown in route handlers): the browser follows
      // with a GET instead of replaying the POST against the target.
      const status = method === 'POST' ? 303 : error.status
      return withResponseHeaders(
        new Response(null, { status, headers: { location: error.location } }),
        responseHeaders,
      )
    }
    // notFound() thrown inside a handler is a 404 with an empty body.
    if (isNotFoundError(error)) {
      return withResponseHeaders(new Response(null, { status: 404 }), responseHeaders)
    }
    // Any other throw is a 500 with an empty body. Report it through the error
    // funnel (onRequestError) here since core no longer sees it as uncaught.
    await reportRequestError(
      error,
      { method, url: request.url, headers: request.headers },
      { phase: 'handler', routeKind: 'route-handler', ...(getWorkUnit()?.responseHints ?? {}) },
    )
    console.error(error)
    return new Response(null, { status: 500 })
  }
}

/**
 * Validate the handler's return value and apply the scope's collected headers.
 * A handler must return a Response; `undefined` or a `NextResponse.next()`
 * result is a 500 (with Next's contract-violation CLI error) rather than a
 * passthrough.
 */
function finalizeResponse(
  response: Response | undefined | void,
  request: Request,
  responseHeaders: Headers,
  options: HandleRouteOptions,
) {
  const method = request.method.toUpperCase()
  if (!response) {
    const file = options.routeFile ?? '<route>'
    console.error(
      `No response is returned from route handler '${file}'. Expected a Response object but ` +
        `received '${typeof response}' (method: ${method}, url: ${request.url}). Ensure you ` +
        'return a `Response` or a `NextResponse` in all branches of your handler.',
    )
    return new Response(null, { status: 500 })
  }
  if (nextResponseMeta(response)?.kind === 'next') {
    console.error('https://nextjs.org/docs/messages/next-response-next-in-app-route-handler')
    return new Response(null, { status: 500 })
  }
  return withResponseHeaders(response, responseHeaders)
}

function callHandler(
  handler: RouteHandler,
  request: Request,
  params: Record<string, RouteParamValue>,
  responseHeaders: Headers,
) {
  const nextRequest = toNextRequest(request)
  // Static routes (no dynamic segments) get no `params` in context — Next
  // omits it, so `context.params` is `undefined` rather than a promise of `{}`.
  const context: RouteHandlerContext =
    Object.keys(params).length > 0
      ? {
          params: getRenderExtensions().legacySyncProps(Promise.resolve(params), 'params', params),
        }
      : {}
  return runWithRequest(nextRequest, () => handler(nextRequest, context), params, {
    responseHeaders,
  })
}

/** Merge scope-collected headers (set-cookie appends, everything else sets) onto the response. */
function withResponseHeaders(response: Response, extra: Headers) {
  const withSetCookie = extra as Headers & { getSetCookie?: () => string[] }
  const scopeCookies = withSetCookie.getSetCookie?.() ?? []
  let hasOthers = false
  extra.forEach((_, key) => {
    if (key !== 'set-cookie') hasOthers = true
  })
  if (scopeCookies.length === 0 && !hasOthers) return response

  const apply = (headers: Headers) => {
    extra.forEach((value, key) => {
      if (key !== 'set-cookie') headers.set(key, value)
    })
    // Cookie-jar merge (Next's ResponseCookies semantics): scope cookies
    // (cookies().set during the handler) first, the response's own Set-Cookie
    // headers override same-name entries, and every cookie is normalized with
    // a default Path=/.
    const responseCookies =
      (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
    const jar = new Map<string, string>()
    for (const cookie of [...scopeCookies, ...responseCookies]) {
      jar.set(cookieName(cookie), normalizeSetCookie(cookie))
    }
    headers.delete('set-cookie')
    for (const cookie of jar.values()) headers.append('set-cookie', cookie)
  }
  try {
    apply(response.headers)
    return response
  } catch {
    // Immutable headers (e.g. a Response forwarded from fetch): re-wrap.
    const headers = new Headers(response.headers)
    apply(headers)
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
}

function cookieName(setCookie: string) {
  return (setCookie.split('=')[0] ?? '').trim()
}

function normalizeSetCookie(setCookie: string) {
  return /;\s*path=/i.test(setCookie) ? setCookie : `${setCookie}; Path=/`
}

export async function staticRouteParams(route: RouteManifestEntry, module: RouteHandlerModule) {
  if (typeof module.GET !== 'function') return []
  // `dynamic = 'force-static'` and `dynamic = 'error'` both evaluate a static
  // request; the latter lets request APIs fail at their call sites. A
  // `revalidate` export opts a request-independent GET into static/ISR output.
  const config = route.segmentConfig
  const optedStatic =
    config?.dynamic === 'force-static' ||
    config?.dynamic === 'error' ||
    config?.revalidate === false ||
    (typeof config?.revalidate === 'number' && config.revalidate > 0)
  if (route.hasStaticParams) return module.params?.() ?? []
  if (route.usesRequest && !optedStatic) return []
  return route.mode === 'static' || optedStatic ? [{}] : []
}

export function routeParamsFromPath(
  route: Pick<RouteManifestEntry, 'catchAll' | 'params' | 'pattern'>,
  pathname: string,
) {
  const match = new RegExp(`^${route.pattern}$`).exec(pathname)
  const params: Record<string, RouteParamValue> = {}
  if (!match) return params

  for (let index = 0; index < route.params.length; index += 1) {
    params[route.params[index]!] = safeDecode(match[index + 1] ?? '')
  }
  if (route.catchAll) {
    params[route.catchAll] = (match[route.params.length + 1] ?? '')
      .split('/')
      .filter(Boolean)
      .map(safeDecode)
  }
  return params
}

function missingMethodResponse(module: RouteHandlerModule, method: string) {
  const headers = { Allow: allowedMethods(module).join(', ') }
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers })
  return new Response(null, { status: 405, headers })
}

function allowedMethods(module: RouteHandlerModule) {
  const allowed = new Set(routeMethods.filter(method => typeof module[method] === 'function'))
  // GET implies auto-HEAD; every route gets auto-OPTIONS. The Allow header is
  // sorted (Next emits e.g. `OPTIONS, POST`).
  if (allowed.has('GET')) allowed.add('HEAD')
  allowed.add('OPTIONS')
  return [...allowed].sort()
}
