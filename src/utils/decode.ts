export function safeDecode(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** A path segment as page params expose it: decoded once, then re-encoded. Malformed escapes stay verbatim. */
export function canonicalSegment(value: string) {
  try {
    return encodeURIComponent(decodeURIComponent(value))
  } catch {
    return value
  }
}
