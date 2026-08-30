// x-forwarded-* request header injection (CORE HTTP correctness).
//
// Before route matching / render, the server records the observed host, port,
// protocol, and peer address on the incoming request headers so headers() during
// render and any request-header reader (middleware, route handlers) see them. Client-sent
// x-forwarded-* values are never overridden (a trusted proxy already set them),
// including multi-value forms like "https, https".

const FORWARDED_HOST = 'x-forwarded-host'
const FORWARDED_PORT = 'x-forwarded-port'
const FORWARDED_PROTO = 'x-forwarded-proto'
const FORWARDED_FOR = 'x-forwarded-for'

/** The serving runtime, narrowed to the peer-address lookup (Bun's `Server`). */
export interface PeerAddressSource {
  requestIP(request: Request): { address: string } | null
}

/**
 * Return the request with x-forwarded-host/port/proto/for injected from the
 * request URL + Host header + peer address, preserving any client-sent values.
 * Returns the same request when every value was already present (no allocation
 * on the hot path).
 */
export function withForwardedHeaders(request: Request, peer?: PeerAddressSource): Request {
  const headers = request.headers
  const hasHost = headers.has(FORWARDED_HOST)
  const hasPort = headers.has(FORWARDED_PORT)
  const hasProto = headers.has(FORWARDED_PROTO)
  const hasFor = headers.has(FORWARDED_FOR)
  if (hasHost && hasPort && hasProto && (hasFor || !peer)) return request

  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return request
  }
  const host = headers.get('host') ?? url.host
  const proto = url.protocol.replace(':', '')
  // The server's own listen port (reflected in the request URL by the runtime).
  const port = url.port

  const next = new Headers(headers)
  if (!hasHost) next.set(FORWARDED_HOST, host)
  if (!hasPort) next.set(FORWARDED_PORT, port)
  if (!hasProto) next.set(FORWARDED_PROTO, proto)
  // Next sets it from the socket's remoteAddress and never appends to a client-sent value.
  if (!hasFor && peer) {
    const address = peer.requestIP(request)?.address
    if (address) next.set(FORWARDED_FOR, address)
  }
  return new Request(request, { headers: next })
}
