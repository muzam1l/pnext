import type { MetadataLink } from '../../types'
import { getWorkUnit } from '../../request/context'
import { registerResponseFinalizers } from '../../extensions'
import type { ResponseFinalizerContext } from '../../extensions'
import { setResourceHintListener } from '../../render/resource-hints'
import { getNextConfig } from './config-loader'

const RESOURCE_HINTS_KEY = Symbol.for('pnext.compat.resourceHints')
const DEFAULT_REACT_MAX_HEADERS_LENGTH = 6000
// Next emits react-dom preload()/preconnect() hints as a `Link` response
// header by default in production; nothing in the compat runtime ever called
// enableResourceHintHeaders, so the finalizer was dead code. The finalizer is
// only registered under next-compat, so defaulting on is scoped already.
let resourceHintHeadersEnabled = true

export type ResourceHint = MetadataLink & {
  rel: string
  url: string
}

export function enableResourceHintHeaders(enabled: boolean): void {
  resourceHintHeadersEnabled = enabled
}

export function registerResourceHintFinalizer(): void {
  registerResponseFinalizers(resourceHintResponseFinalizer)
  // Every react-dom preload()/preconnect()/preinit() during a render lands on
  // the active work unit so the finalizer (and the build prerender) can emit
  // Next's `Link` response header alongside the in-document <link> tags.
  setResourceHintListener(hint => recordResourceHint(hint as ResourceHint))
}

export function recordResourceHint(hint: ResourceHint): void {
  const unit = getWorkUnit()
  if (!unit) return

  const existing = (unit.compat?.[RESOURCE_HINTS_KEY] as ResourceHint[] | undefined) ?? []
  if (!unit.compat) unit.compat = {}
  unit.compat[RESOURCE_HINTS_KEY] = dedupeResourceHints([...existing, hint])
}

export function takeResourceHintsForResponse(): ResourceHint[] {
  const unit = getWorkUnit()
  const compat = unit?.compat
  if (!compat) return []
  const hints = (compat[RESOURCE_HINTS_KEY] as ResourceHint[] | undefined) ?? []
  compat[RESOURCE_HINTS_KEY] = undefined
  return hints
}

const ALLOWED_ROUTE_KINDS = new Set<ResponseFinalizerContext['routeKind']>(['html', 'data'])

function resourceHintResponseFinalizer(ctx: ResponseFinalizerContext): void {
  if (!shouldEmitResourceHintsHeader()) return
  if (ctx.hints?.runtime === 'edge') return
  if (!ALLOWED_ROUTE_KINDS.has(ctx.routeKind)) return

  const value = takeResourceHintHeader()
  if (value === undefined) return
  const existing = ctx.headers.get('link')
  ctx.headers.set('link', existing ? `${existing}, ${value}` : value)
}

function shouldEmitResourceHintsHeader(): boolean {
  return resourceHintHeadersEnabled
}

function getReactMaxHeadersLength(): number {
  const configValue = getNextConfig().reactMaxHeadersLength
  if (typeof configValue === 'number' && Number.isFinite(configValue) && configValue >= 0) {
    return Math.floor(configValue)
  }
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const envValue = process.env.TEST_REACT_MAX_HEADERS_LENGTH
  if (typeof envValue === 'string' && envValue.trim() !== '') {
    const parsed = Number.parseInt(envValue, 10)
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed)
  }
  return DEFAULT_REACT_MAX_HEADERS_LENGTH
}

export function takeResourceHintHeader(): string | undefined {
  const hints = takeResourceHintsForResponse()
  if (hints.length === 0) return undefined

  const maxLength = getReactMaxHeadersLength()
  if (!(maxLength > 0)) return undefined

  const entries = hints.map(hint => formatLinkHeaderEntry(hint)).filter(Boolean)
  if (entries.length === 0) return undefined

  const values: string[] = []
  for (const entry of entries) {
    const candidate = values.length > 0 ? `${values.join(', ')}, ${entry}` : entry
    if (candidate.length > maxLength) break
    values.push(entry)
  }

  return values.length === 0 ? undefined : values.join(', ')
}

// React's Link-header entry shape (ReactFizz getPreloadAsHeader): the rel is
// unquoted, every other param is quoted, and crossorigin normalizes
// 'anonymous' to the empty string. The react-max-headers-length suite computes
// expected header lengths from React's exact per-entry size, so the format
// must match byte-for-byte.
function formatLinkHeaderEntry(hint: ResourceHint): string {
  const parts = [`<${hint.url}>`, `rel=${hint.rel}`]
  if (hint.as) parts.push(`as="${hint.as}"`)
  if (hint.crossOrigin !== undefined)
    parts.push(`crossorigin="${hint.crossOrigin === 'anonymous' ? '' : hint.crossOrigin}"`)
  if (hint.type) parts.push(`type="${hint.type}"`)
  if (hint.media) parts.push(`media="${hint.media}"`)
  if (hint.sizes) parts.push(`sizes="${hint.sizes}"`)
  if (hint.title) parts.push(`title="${hint.title}"`)
  if (hint.hrefLang) parts.push(`hreflang="${hint.hrefLang}"`)
  if (hint.fetchPriority) parts.push(`fetchpriority="${hint.fetchPriority}"`)
  if (hint.nonce) parts.push(`nonce="${hint.nonce}"`)
  return parts.join('; ')
}

function dedupeResourceHints(hints: ResourceHint[]): ResourceHint[] {
  if (hints.length <= 1) return hints
  const seen = new Set<string>()
  const next: ResourceHint[] = []
  for (const hint of hints) {
    const key = formatLinkHeaderEntry(hint)
    if (seen.has(key)) continue
    seen.add(key)
    next.push(hint)
  }
  return next
}
