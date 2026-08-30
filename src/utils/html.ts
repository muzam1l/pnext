export function escapeHtml(value: unknown) {
  return stringifyHtmlValue(value).replace(/[&<>"']/g, char => {
    switch (char) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      case "'":
        // React/Next use the hexadecimal spelling in both text and attribute
        // nodes. Keep our hand-written document/metadata serializers on the
        // same wire format rather than relying on browser-equivalent entities.
        return '&#x27;'
      default:
        return char
    }
  })
}

export function stringifyHtmlValue(value: unknown) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  if (value instanceof URL) return value.href
  if (value instanceof Date) return value.toISOString()
  if (typeof value !== 'object') return ''

  const stringifier = (value as { toString?: (this: object) => unknown }).toString
  if (!stringifier || stringifier === Object.prototype.toString) return ''
  const stringified = stringifier.call(value)
  if (typeof stringified === 'string') return stringified
  if (
    typeof stringified === 'number' ||
    typeof stringified === 'boolean' ||
    typeof stringified === 'bigint'
  ) {
    return String(stringified)
  }
  return ''
}
