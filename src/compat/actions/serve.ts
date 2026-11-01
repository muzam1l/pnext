import { resolveAction, runAction, type RunActionOptions } from './endpoint'
import { allActions, lookupAction } from './registry'
import {
  ACTION_FLIGHT_CONTENT_TYPE,
  actionRedirectHeaderValue,
  createActionFlightResponse,
} from './flight'
import { INVALID_ORIGIN_MESSAGE, isActionOriginAllowed } from './origin'
import {
  ACTION_ID_FIELD,
  SUBMIT_ACTION_ID_FIELD,
  ACTION_ID_HEADER,
  ACTION_NOT_FOUND_HEADER,
  NEXT_ACTION_NOT_FOUND_HEADER,
  ACTION_REDIRECT_HEADER,
  ACTION_REFRESH_HEADER,
  NEXT_ACTION_REVALIDATED_HEADER,
  FORM_STATE_FIELD,
  MASKED_ACTION_ERROR,
  REDIRECT_TYPE_HEADER,
  type ActionSuccessBody,
} from './protocol'

export { ACTION_REFRESH_HEADER, ACTION_ID_FIELD }

/**
 * Server-action dispatch for the pnext servers. Actions POST to the page's own
 * URL (mirroring Next's wire shape, which the e2e suites observe):
 *
 * - JS clients (the pnext action client runtime) send the id in the
 *   `next-action` header. Redirects come back as 200 JSON `{ redirect }` so the
 *   client can soft-navigate (an HTTP 303 would be transparently followed by
 *   fetch, breaking external URLs and history control).
 * - No-JS progressive submissions carry the id in a hidden form field; the
 *   server promotes it to the header and shapes browser-navigation responses:
 *   303 back to the page on success, 303 to the target on redirect(), and the
 *   404 page for notFound().
 */

/** True when a request is a JS-client action RPC (id in header). */
export function isActionRequest(request: Request): boolean {
  return request.method.toUpperCase() === 'POST' && request.headers.has(ACTION_ID_HEADER)
}

/**
 * True when a POST looks like a no-JS progressive action submission: a form
 * body carrying the hidden action id field. Reads a clone, so the request
 * stays consumable. Non-form POSTs and forms without the field return false.
 */
export async function isProgressiveActionRequest(request: Request): Promise<boolean> {
  if (request.method.toUpperCase() !== 'POST') return false
  if (request.headers.has(ACTION_ID_HEADER)) return false
  const contentType = request.headers.get('content-type') ?? ''
  const isForm =
    contentType.includes('multipart/form-data') || contentType.includes('form-urlencoded')
  if (!isForm) return false
  try {
    const form = await request.clone().formData()
    // A form-level action (ACTION_ID_FIELD) OR a bare submitter override
    // (SUBMIT_ACTION_ID_FIELD, e.g. <form><button formAction={fn}> with no form
    // action) both count as a progressive action submission.
    const id =
      lastFieldValue(form, SUBMIT_ACTION_ID_FIELD) ??
      lastFieldValue(form, ACTION_ID_FIELD) ??
      reactFormActionId(form)
    return typeof id === 'string' && id !== ''
  } catch {
    return false
  }
}

export interface ServeActionOptions extends RunActionOptions {
  /** Render the app's 404 page for a notFound() result (progressive + RPC). */
  renderNotFound?: (request: Request) => Promise<Response>
  /**
   * Progressive useActionState submissions: re-render the posted page with the
   * action's result as the form's state (published via the consumed-once
   * global override) and return the HTML. Null falls back to the 303.
   */
  renderPageForFormState?: (
    request: Request,
    state: unknown,
    actionId: string,
  ) => Promise<Response | null>
  /**
   * Single-pass redirects: render the redirect target's page for an RPC redirect so the 200 response
   * carries the destination HTML and the client swaps it in without a follow-up GET. The request passed
   * already carries the action's cookie mutations. Null falls back to the JSON redirect envelope.
   */
  renderRedirectTarget?: (request: Request, target: URL) => Promise<Response | null>
  /** Render a page payload for a JS action Flight response. */
  renderActionFlight?: (request: Request, target: URL) => Promise<Response | null>
  /**
   * Next "forwarded action" discrimination: true when the POSTed route's module graph does NOT contain
   * the action (the client dispatched it after navigating away from the page that owns it). Next
   * forwards such requests to the owning worker and relays the inner response's HEADERS but not its
   * status, so the browser observes 200 + `x-action-redirect`.
   */
  isForwardedAction?: (id: string) => boolean
}

/** Serve a server-action request (either kind). */
export async function serveAction(
  request: Request,
  options: ServeActionOptions,
): Promise<Response> {
  const progressive = !request.headers.has(ACTION_ID_HEADER)
  if (
    !progressive &&
    request.headers.get('content-type')?.includes('application/x-www-form-urlencoded')
  ) {
    return options.renderNotFound?.(request) ?? new Response(null, { status: 404 })
  }

  // CSRF origin check runs before the action executes: a mismatched origin must
  // never run the action. JS clients get the error as a text/plain body (thrown
  // into the error boundary); no-JS MPA submits get a plain 500.
  if (!isActionOriginAllowed(request)) {
    if (progressive) {
      return new Response('Internal Server Error', {
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    }
    return new Response(options.dev ? INVALID_ORIGIN_MESSAGE : MASKED_ACTION_ERROR, {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  const promoted = progressive ? await promoteFormActionId(request, options) : undefined
  const prepared = promoted?.request ?? request

  if (progressive && (promoted?.errorStatus || !prepared.headers.has(ACTION_ID_HEADER))) {
    const status = promoted?.errorStatus ?? (allActions().length > 0 ? 400 : 409)
    console.error(
      'Failed to find Server Action. This request might be from an older or newer deployment.\n' +
        'Read more: https://nextjs.org/docs/messages/failed-to-find-server-action',
    )
    return new Response(
      status === 400 ? 'Invalid Server Action request.' : 'Server Action unavailable.',
      {
        status,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          [NEXT_ACTION_NOT_FOUND_HEADER]: '1',
        },
      },
    )
  }

  const response = await runAction(prepared, options)

  if (response.headers.has(ACTION_NOT_FOUND_HEADER) && options.renderNotFound) {
    // Serve the real 404 page HTML with a 404 status and the marker header. A
    // progressive submit shows it directly; the JS client runtime detects the
    // 404 + marker and swaps the document in place (client.ts). Returning
    // an empty 200 JSON here would leave the JS client with nothing to render.
    const notFound = await options.renderNotFound(request)
    const headers = new Headers(notFound.headers)
    headers.set(ACTION_NOT_FOUND_HEADER, '1')
    copySetCookies(response.headers, headers)
    return new Response(notFound.body, { status: 404, headers })
  }

  if (!progressive) {
    const wantsFlight = acceptsActionFlight(request)
    if (response.status === 303 && response.headers.has(ACTION_REDIRECT_HEADER)) {
      const target = response.headers.get(ACTION_REDIRECT_HEADER)!
      const headers = new Headers()
      if (response.headers.has(ACTION_REFRESH_HEADER)) headers.set(ACTION_REFRESH_HEADER, '1')
      const revalidated = response.headers.get(NEXT_ACTION_REVALIDATED_HEADER)
      if (revalidated) headers.set(NEXT_ACTION_REVALIDATED_HEADER, revalidated)
      const redirectType = response.headers.get(REDIRECT_TYPE_HEADER)
      copySetCookies(response.headers, headers)

      // Forwarded action (dispatched from a page that does not own it): Next
      // relays the owning worker's headers on a 200.
      // The JSON envelope makes the client soft-navigate to the target.
      const actionId = prepared.headers.get(ACTION_ID_HEADER)
      if (actionId && options.isForwardedAction?.(actionId)) {
        headers.set(
          ACTION_REDIRECT_HEADER,
          actionRedirectHeaderValue(target, redirectType ?? undefined),
        )
        headers.set('content-type', 'application/json; charset=utf-8')
        return new Response(JSON.stringify({ redirect: target }), { status: 200, headers })
      }

      // Same-origin targets: single-pass redirect. The 200 has NO location header and
      // carries the destination page HTML; the client pushes history and swaps the
      // document in one round trip, like Next's flight redirects.
      const targetUrl = resolveRedirectTarget(request, target)
      if (targetUrl && (options.renderActionFlight || options.renderRedirectTarget)) {
        const rendered = await options
          .renderActionFlight?.(
            requestWithAppliedCookies(request, targetUrl, response.headers),
            targetUrl,
          )
          .catch(() => null)
        if (wantsFlight && rendered?.status === 200) {
          return createActionFlightResponse({
            pageResponse: rendered,
            target: targetUrl,
            actionHeaders: response.headers,
            redirect: targetUrl.pathname + targetUrl.search,
            ...(redirectType ? { redirectType } : {}),
          })
        }
        const fallbackRendered = rendered
          ? rendered
          : await options
              .renderRedirectTarget?.(
                requestWithAppliedCookies(request, targetUrl, response.headers),
                targetUrl,
              )
              .catch(() => null)
        if (wantsFlight && fallbackRendered?.status === 200) {
          return createActionFlightResponse({
            pageResponse: fallbackRendered,
            target: targetUrl,
            actionHeaders: response.headers,
            redirect: targetUrl.pathname + targetUrl.search,
            ...(redirectType ? { redirectType } : {}),
          })
        }
        // A same-host path outside the app cannot be rendered in-process. Keep
        // the action response successful and let the client navigate once.
        headers.set(
          ACTION_REDIRECT_HEADER,
          actionRedirectHeaderValue(
            targetUrl.pathname + targetUrl.search,
            redirectType ?? undefined,
          ),
        )
        headers.set('content-type', 'application/json; charset=utf-8')
        return new Response(JSON.stringify({ redirect: target }), { status: 200, headers })
      }

      // Fallback: JSON envelope; the client soft-navigates (or hard-navigates
      // for external origins).
      headers.set('content-type', 'application/json; charset=utf-8')
      return new Response(JSON.stringify({ redirect: target }), { status: 200, headers })
    }
    // A non-redirect action returns its plain JSON envelope. When it also revalidated (or mutated
    // cookies), the refresh header rides along and the JS client soft-refreshes the current route in
    // place, preserving hydrated island state. Wrapping the return in a full-page flight envelope here
    // would force the client to rewrite the document, discarding that live state.
    return response
  }

  // Progressive success: a useActionState form re-renders the page with the
  // action's result as the new form state; anything else 303s back to the
  // page it posted from so the browser renders the (possibly revalidated)
  // page rather than a JSON body.
  if (response.status === 200) {
    if (promoted?.hasFormState && options.renderPageForFormState) {
      try {
        const body = (await response.clone().json()) as ActionSuccessBody
        const page = await options.renderPageForFormState(
          request,
          body.data,
          prepared.headers.get(ACTION_ID_HEADER)!,
        )
        if (page) {
          copySetCookies(response.headers, page.headers)
          return page
        }
      } catch {
        // fall through to the 303
      }
    }
    // A revalidating (or cookie-mutating) progressive action must show its effects immediately. A 303
    // back to the page would have the browser GET it fresh - but that GET can serve prebuilt static
    // output, which predates the action's revalidation and would leave the user looking at stale data.
    // So when the action signalled a refresh, render the posted page inline (a fresh dynamic render
    // that observes the just-applied invalidations and cookie mutations) and return it as the POST
    // response, matching the single-pass render the flight client path already performs.
    if (response.headers.has(ACTION_REFRESH_HEADER) && options.renderRedirectTarget) {
      const pageUrl = new URL(request.url)
      const refreshRequest = requestWithAppliedCookies(request, pageUrl, response.headers)
      refreshRequest.headers.set('x-pnext-soft-nav', '1')
      const rendered = await options.renderRedirectTarget(refreshRequest, pageUrl).catch(() => null)
      if (rendered?.status === 200) {
        const headers = new Headers(rendered.headers)
        copySetCookies(response.headers, headers)
        return new Response(rendered.body, { status: 200, headers })
      }
    }
    const headers = new Headers({ location: progressiveReturnTarget(request) })
    copySetCookies(response.headers, headers)
    return new Response(null, { status: 303, headers })
  }
  // Progressive failures retain the same unavailable-action status and body as fetch actions.
  if (response.headers.has(NEXT_ACTION_NOT_FOUND_HEADER)) {
    console.error(
      response.status === 400
        ? 'Error: Invalid Server Actions request.'
        : `Error: Failed to find Server Action "${prepared.headers.get(ACTION_ID_HEADER)}". This request might be from an older or newer deployment`,
    )
  }
  return response
}

function progressiveReturnTarget(request: Request): string {
  const referer = request.headers.get('referer')
  if (referer) return referer
  return new URL(request.url).pathname || '/'
}

function acceptsActionFlight(request: Request): boolean {
  return request.headers.get('accept')?.includes(ACTION_FLIGHT_CONTENT_TYPE) ?? false
}

/**
 * No-JS progressive enhancement: a plain HTML form submit cannot set the next-action header, so the id
 * goes in a hidden field (and on the submit button's name for per-button formAction). Promote the LAST
 * occurrence to the header - the submitter's entry serializes after the form-level hidden field, so it
 * wins.
 */
async function promoteFormActionId(
  request: Request,
  options: ServeActionOptions,
): Promise<{ request: Request; hasFormState: boolean; errorStatus?: 400 | 409 }> {
  const contentType = request.headers.get('content-type') ?? ''
  const isForm =
    contentType.includes('multipart/form-data') || contentType.includes('form-urlencoded')
  if (!isForm) return { request, hasFormState: false }

  let form: FormData
  try {
    form = await request.clone().formData()
  } catch {
    // Unparseable body (e.g. a mismatched multipart boundary): no id to promote;
    // the caller treats it as an unrecognized MPA action.
    return { request, hasFormState: false }
  }
  // A per-button formAction override (SUBMIT_ACTION_ID_FIELD) wins over the
  // form's default action (ACTION_ID_FIELD), unambiguously and independent of
  // field order — a no-JS submit has no event.submitter to tell them apart, and
  // the form-level hidden field can render either before or after the button.
  const ids: FormDataEntryValue[] = []
  for (const [name, value] of form) {
    if (name === ACTION_ID_FIELD || name === SUBMIT_ACTION_ID_FIELD) ids.push(value)
    else if (name.startsWith('$ACTION_ID_')) ids.push(name.slice('$ACTION_ID_'.length))
  }
  if (allActions().length > 0 || ids.length > 1) {
    for (const actionId of ids) {
      if (
        typeof actionId !== 'string' ||
        (!lookupAction(actionId) && !(await resolveAction(actionId, request, options)))
      ) {
        return {
          request,
          hasFormState: false,
          errorStatus: typeof actionId === 'string' && actionId.length === 42 ? 409 : 400,
        }
      }
    }
  }
  const submitId = lastFieldValue(form, SUBMIT_ACTION_ID_FIELD)
  const formActionId = lastFieldValue(form, ACTION_ID_FIELD)
  const id = submitId ?? formActionId ?? reactFormActionId(form)
  if (typeof id !== 'string' || id === '') return { request, hasFormState: false }
  form.delete(SUBMIT_ACTION_ID_FIELD)
  // Form state only applies to the form's own useActionState action, never a
  // plain submitter override (which runs as action(formData), not (state, fd)).
  const hasFormState = submitId === undefined && typeof form.get(FORM_STATE_FIELD) === 'string'
  if (!hasFormState) form.delete(FORM_STATE_FIELD)

  const headers = new Headers(request.headers)
  headers.set(ACTION_ID_HEADER, id)
  // Drop the stale content-type/length; the runtime derives a fresh multipart
  // content-type (with a new boundary) from the FormData body below.
  headers.delete('content-type')
  headers.delete('content-length')
  return {
    request: new Request(request.url, { method: 'POST', headers, body: form }),
    hasFormState,
  }
}

function lastFieldValue(form: FormData, name: string) {
  const values = form.getAll(name)
  return values.length > 0 ? values[values.length - 1] : undefined
}

function reactFormActionId(form: FormData): string | undefined {
  let id: string | undefined
  for (const name of form.keys()) {
    if (name.startsWith('$ACTION_ID_')) id = name.slice('$ACTION_ID_'.length)
  }
  return id
}

function copySetCookies(from: Headers, to: Headers) {
  const setCookies = (from as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
  for (const cookie of setCookies) to.append('set-cookie', cookie)
}

/** Same-origin redirect target URL, or undefined for external redirects. */
function resolveRedirectTarget(request: Request, target: string): URL | undefined {
  try {
    const requestUrl = new URL(request.url)
    const relativeBase = new URL(requestUrl)
    if (!target.startsWith('/') && !/^[a-z][a-z0-9+.-]*:/i.test(target)) {
      relativeBase.pathname = `${relativeBase.pathname.replace(/\/+$/, '')}/`
    }
    const url = new URL(target, relativeBase)
    return url.origin === requestUrl.origin ? url : undefined
  } catch {
    return undefined
  }
}

/**
 * Build the GET request for the redirect-target render: the action's cookie
 * mutations (set-cookie on the action response) are applied onto the request's
 * cookie header so the target page reads the post-action jar, exactly like a
 * browser following the redirect would send.
 */
function requestWithAppliedCookies(request: Request, target: URL, actionHeaders: Headers): Request {
  const headers = new Headers(request.headers)
  headers.delete('content-type')
  headers.delete('content-length')
  headers.delete(ACTION_ID_HEADER)

  const setCookies =
    (actionHeaders as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
  if (setCookies.length > 0) {
    const jar = new Map<string, string>()
    const existing = headers.get('cookie') ?? ''
    for (const part of existing.split(';')) {
      const eq = part.indexOf('=')
      if (eq === -1) continue
      jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
    }
    for (const setCookie of setCookies) {
      const [pair, ...attributes] = setCookie.split(';')
      const eq = (pair ?? '').indexOf('=')
      if (eq === -1) continue
      const name = pair!.slice(0, eq).trim()
      const value = pair!.slice(eq + 1).trim()
      const expired = attributes.some(attr => /^\s*max-age\s*=\s*0*\s*$/i.test(attr))
      if (expired) jar.delete(name)
      else jar.set(name, value)
    }
    const cookieHeader = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
    if (cookieHeader) headers.set('cookie', cookieHeader)
    else headers.delete('cookie')
  }

  return new Request(target.href, { headers })
}
