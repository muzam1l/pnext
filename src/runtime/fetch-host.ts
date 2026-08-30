/**
 * Bun's fetch sends a caller-supplied `host` header verbatim; undici (Node, and therefore Next)
 * always derives Host from the request URL and drops any supplied one. An app that forwards its
 * inbound request headers to an upstream - every proxy/BFF route handler - would otherwise send
 * the local Host upstream, an RFC 9110 7.2 violation that real upstreams reject. Match undici.
 *
 * Bun also ignores response-body cancellation: cancelling a fetch Response's stream leaves the
 * upstream request in flight and its keep-alive socket checked out for good, so a passthrough proxy
 * route whose client disconnects mid-stream leaks a connection per abort until later fetches to that
 * host queue behind them forever. Only the fetch's own AbortSignal tears the request down, so each
 * response body is tracked against its controller here and the serving layer fires it on disconnect.
 */

let installed = false

const upstreamAborts = new WeakMap<ReadableStream<Uint8Array>, AbortController>()

function isHostKey(key: unknown): boolean {
  return typeof key === 'string' && key.length === 4 && key.toLowerCase() === 'host'
}

/** Allocation-free probe: the overwhelmingly common case is no `host` at all. */
function hasHost(headers: HeadersInit): boolean {
  if (headers instanceof Headers) return headers.has('host')
  if (Array.isArray(headers)) {
    for (const entry of headers) if (isHostKey(entry?.[0])) return true
    return false
  }
  for (const key in headers) if (isHostKey(key)) return true
  return false
}

/** Only ever runs when a `host` was actually supplied, so the copy stays off the hot path. */
function withoutHost(headers: HeadersInit): Headers {
  const next = new Headers(headers)
  next.delete('host')
  return next
}

/** Idempotent; safe to call from every server and build entry point. */
export function installFetchHostNormalization(): void {
  if (installed) return
  installed = true
  const original = globalThis.fetch.bind(globalThis)
  globalThis.fetch = function fetch(input: RequestInfo | URL, init?: RequestInit) {
    const source = init?.headers ?? (input instanceof Request ? input.headers : undefined)
    const normalized =
      source !== undefined && hasHost(source) ? { ...init, headers: withoutHost(source) } : init
    return trackUpstream(original, input, normalized)
  } as typeof globalThis.fetch
}

/** Give every fetch an abort handle of its own, keyed on the body it streams back. */
function trackUpstream(
  original: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<Response> {
  const controller = new AbortController()
  const caller = init?.signal ?? (input instanceof Request ? input.signal : undefined)
  const signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal
  return original(input, { ...init, signal }).then(response => {
    if (response.body) upstreamAborts.set(response.body, controller)
    return response
  })
}

/**
 * Tear down the upstream fetch `body` is streaming from once the client goes away. Bun.serve never
 * cancels the body it is writing, so this disconnect is the only chance to release that socket.
 * Zero-cost for any response that is not a fetch passthrough.
 */
export function abortUpstreamFetchOnDisconnect(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal | undefined,
): void {
  if (!body || !signal || !upstreamAborts.has(body)) return
  const abort = () => {
    const controller = upstreamAborts.get(body)
    if (!controller) return
    upstreamAborts.delete(body)
    controller.abort()
  }
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
}
