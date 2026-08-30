// AppRender.fetch span (COMPAT).
//
// Wraps globalThis.fetch to emit a `fetch <METHOD> <url>` CLIENT span nested under the request's render,
// for every outgoing fetch made during a render. Installed AFTER the cache fetch-patch (register order:
// cache before otel) so the span brackets the cache layer too. Disabled by NEXT_OTEL_FETCH_DISABLED=1.
// Only emits when a root span is open, so build-time and out-of-request fetches pass through untouched.

import { SPAN_TYPE, withChildSpan, rootOtelContext, otelExportInProgress } from './tracer'
import { getOtelApi } from './api'

let installed = false

export function installFetchSpan(appRoot: string): void {
  if (installed) return
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  if (process.env.NEXT_OTEL_FETCH_DISABLED === '1') return
  if (!getOtelApi(appRoot)) return
  installed = true

  const original = globalThis.fetch.bind(globalThis)
  const patched = async function fetch(
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> {
    // Only trace inside an active request render (root span open).
    if (otelExportInProgress()) return original(input, init)
    if (!rootOtelContext()) return original(input, init)
    const info = describeFetch(input, init)
    if (!info) return original(input, init)
    const name = `fetch ${info.method} ${info.url}`
    return withChildSpan(
      name,
      SPAN_TYPE.fetch,
      {
        'http.method': info.method,
        'http.url': info.url,
        'net.peer.name': info.host,
      },
      () => original(input, init),
      { kind: fetchSpanKind() },
    )
  }
  globalThis.fetch = patched as typeof globalThis.fetch
}

function fetchSpanKind(): number | undefined {
  // SpanKind.CLIENT (2) — resolved lazily so we don't hold the api reference.
  return 2
}

function describeFetch(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
): { method: string; url: string; host: string } | undefined {
  try {
    let url: string
    let method = 'GET'
    if (typeof input === 'string' || input instanceof URL) {
      url = String(input)
      method = (init?.method ?? 'GET').toUpperCase()
    } else if (input instanceof Request) {
      url = input.url
      method = (init?.method ?? input.method).toUpperCase()
    } else {
      return undefined
    }
    if (!/^https?:/i.test(url)) return undefined
    const parsed = new URL(url)
    return { method, url: parsed.href, host: parsed.hostname }
  } catch {
    return undefined
  }
}

export function resetFetchSpanForTest(): void {
  installed = false
}
