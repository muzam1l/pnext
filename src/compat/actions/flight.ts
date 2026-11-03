import { ACTION_FLIGHT_CONTENT_TYPE, ACTION_REDIRECT_HEADER } from './protocol'

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
  data?: unknown
}

export function actionRedirectHeaderValue(target: string, redirectType?: string): string {
  return `${target};${redirectType === 'replace' ? 'replace' : 'push'}`
}

export async function createActionFlightResponse({
  pageResponse,
  target,
  actionHeaders,
  redirect,
  redirectType,
  data,
}: CreateActionFlightResponseOptions): Promise<Response> {
  const html = await pageResponse.text()
  const payload: ActionFlightPayload = {
    a: data,
    f: { kind: 'pnext-html', html, url: target.pathname + target.search },
    q: target.search,
    i: false,
  }
  const headers = new Headers(pageResponse.headers)
  headers.set('content-type', ACTION_FLIGHT_CONTENT_TYPE)
  copyActionHeaders(actionHeaders, headers)
  if (redirect)
    headers.set(ACTION_REDIRECT_HEADER, actionRedirectHeaderValue(redirect, redirectType))
  // Fetch-action redirects are successful Flight responses, not HTTP redirects.
  return new Response(JSON.stringify(payload), { status: 200, headers })
}

function copyActionHeaders(from: Headers, to: Headers): void {
  for (const name of ['x-pnext-action-refresh', 'x-action-revalidated']) {
    const value = from.get(name)
    if (value) to.set(name, value)
  }
  const setCookies = (from as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
  for (const cookie of setCookies) to.append('set-cookie', cookie)
}
