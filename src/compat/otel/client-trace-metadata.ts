// experimental.clientTraceMetadata (COMPAT).
//
// For each key listed in `experimental.clientTraceMetadata`, inject a `<meta name="<key>"
// content="<value>">` into the HTML head, where the value comes from running the app's GLOBAL
// propagator inject() against the active render's span context. The app's propagator decides which keys
// carry a value; keys with no injected value are skipped, and keys the propagator sets but that are not
// in the config list are dropped.
//
// Gating (matches Next): only DYNAMIC renders, and only in production - a prod STATIC page emits
// nothing, while dev emits for static too. The tags are produced once per document render, so soft navs
// never mutate them.

import { getNextConfig } from '../next/config-loader'
import { activeOtelContext, carrierSetter } from './tracer'

/**
 * Return the clientTraceMetadata `<meta>` tag HTML for the current render, or ''
 * when the feature is off / not applicable. `dynamic` is true when the render is
 * request-dependent (Next only injects on dynamic renders in prod). Values are
 * escaped by the caller's head-composition path if needed; keys/values here come
 * from config + the propagator and are attribute-safe in practice, but we escape
 * defensively.
 */
export function clientTraceMetadataTags(input: {
  dynamic: boolean
  isNextStart: boolean
  rsc: boolean
}): string {
  const keys = configuredKeys()
  if (keys.length === 0) return ''
  if (input.rsc) return ''
  // Prod + static → no injection. Dev injects for static too (handled by the
  // caller passing dynamic=true in dev, since a dev render is never prebuilt).
  if (input.isNextStart && !input.dynamic) return ''

  const active = activeOtelContext()
  if (!active) return ''
  const { api, context } = active

  const carrier: Record<string, string> = {}
  try {
    api.propagation.inject(context, carrier, carrierSetter)
  } catch {
    return ''
  }

  const tags: string[] = []
  for (const key of keys) {
    const value = carrier[key]
    if (value === undefined || value === null) continue
    tags.push(`<meta name="${escapeAttr(key)}" content="${escapeAttr(String(value))}"/>`)
  }
  return tags.join('')
}

function configuredKeys(): string[] {
  const experimental = getNextConfig().experimental as { clientTraceMetadata?: unknown } | undefined
  const list = experimental?.clientTraceMetadata
  if (!Array.isArray(list)) return []
  return list.filter((k): k is string => typeof k === 'string')
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
