// CSP nonce extraction (COMPAT).
//
// Next reads a `nonce-<value>` token out of the request's Content-Security-Policy header and stamps it
// onto the script / style / preload tags it emits so a strict CSP admits them. This module owns the
// EXTRACTION, parsing the header exactly as Next does; the actual stamping onto the emitted tags is
// renderer territory.
//
// Matches Next's parser: scan every directive's sources for a single-quoted `'nonce-<base64>'` token
// and return the first one found.

/** Extract the CSP nonce from a Content-Security-Policy header value, if any. */
export function nonceFromCsp(csp: string | null | undefined): string | undefined {
  if (!csp) return undefined
  // A directive looks like `script-src 'self' 'nonce-abc123=='`. Sources are
  // whitespace-separated; the nonce token is single-quoted `'nonce-<value>'`.
  const directives = csp.split(';')
  for (const directive of directives) {
    for (const token of directive.trim().split(/\s+/)) {
      const match = /^'nonce-([^']+)'$/.exec(token)
      if (match?.[1]) return match[1]
    }
  }
  return undefined
}

/** Extract the CSP nonce from a request's headers. */
export function nonceFromRequest(request: Request | undefined): string | undefined {
  if (!request) return undefined
  return nonceFromCsp(request.headers.get('content-security-policy'))
}
