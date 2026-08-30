import { ACTION_REDIRECT_HEADER, REDIRECT_TYPE_HEADER } from './protocol'

export const ACTION_FLIGHT_CONTENT_TYPE = 'text/x-component'

export interface ActionFlightPayload {
  a?: unknown
  f: { kind: 'pnext-html'; html: string; url: string } | ''
  q: string
  i: boolean
}

export interface CreateActionFlightResponseOptions {
  pageResponse: Response
  target: URL
  actionHeaders: Headers
  redirect?: string
  redirectType?: string
}

export async function createActionFlightResponse({
  pageResponse,
  target,
  actionHeaders,
  redirect,
  redirectType,
}: CreateActionFlightResponseOptions): Promise<Response> {
  const html = await pageResponse.text()
  const payload: ActionFlightPayload = {
    f: { kind: 'pnext-html', html, url: target.pathname + target.search },
    q: target.search,
    i: false,
  }
  const headers = new Headers(pageResponse.headers)
  headers.set('content-type', ACTION_FLIGHT_CONTENT_TYPE)
  copyActionHeaders(actionHeaders, headers)
  if (redirect) headers.set(ACTION_REDIRECT_HEADER, redirect)
  if (redirectType) headers.set(REDIRECT_TYPE_HEADER, redirectType)
  // A framework redirect returns HTTP 303 (matching Next's action-redirect wire
  // the e2e suite asserts) with the destination page HTML inline in the flight
  // payload; the client swaps the document without a follow-up GET. A plain
  // flight envelope (revalidation, no redirect) stays 200.
  return new Response(JSON.stringify(payload), { status: redirect ? 303 : 200, headers })
}

function copyActionHeaders(from: Headers, to: Headers): void {
  for (const name of ['x-pnext-action-refresh', 'x-action-revalidated']) {
    const value = from.get(name)
    if (value) to.set(name, value)
  }
  const setCookies = (from as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
  for (const cookie of setCookies) to.append('set-cookie', cookie)
}
