// @opentelemetry/api loader + thin typed surface (COMPAT).
//
// pnext emits Next's span taxonomy through the GLOBAL OpenTelemetry API the app's instrumentation.ts
// registers. Only `@opentelemetry/api` (the stable facade) is ever touched; the app supplies the SDK.
// The api package is an OPTIONAL runtime dependency: absent, every helper is an inert no-op so a
// pure-core app is byte-identical.
//
// Resolution: `@opentelemetry/api` is not vendored into pnext (it would pin a version and duplicate the
// singleton the app registered). It is resolved from the app's own node_modules, so pnext and the app
// share ONE api singleton - the same module instance the app's provider.register() mutated. A bare
// import would resolve against pnext's location and never see the registered provider.

import { createRequire } from 'node:module'
import path from 'node:path'

// Structural subset of @opentelemetry/api we use. Kept local so pnext carries no
// type dependency on the package (it may be absent).
export interface OtelSpanContext {
  traceId: string
  spanId: string
  traceFlags: number
}

export interface OtelSpan {
  setAttribute(key: string, value: unknown): OtelSpan
  setAttributes(attrs: Record<string, unknown>): OtelSpan
  setStatus(status: { code: number; message?: string }): OtelSpan
  recordException(error: unknown): void
  updateName(name: string): OtelSpan
  end(endTime?: number): void
  spanContext(): OtelSpanContext
  isRecording(): boolean
}

export interface OtelContext {
  // opaque
  readonly __brand?: 'otel-context'
}

export interface OtelTracer {
  startSpan(
    name: string,
    options?: { kind?: number; attributes?: Record<string, unknown>; startTime?: number },
    context?: OtelContext,
  ): OtelSpan
}

export interface OtelApi {
  trace: {
    getTracer(name: string, version?: string): OtelTracer
    getSpan(context: OtelContext): OtelSpan | undefined
    getSpanContext(context: OtelContext): OtelSpanContext | undefined
    setSpan(context: OtelContext, span: OtelSpan): OtelContext
    setSpanContext(context: OtelContext, sc: OtelSpanContext): OtelContext
  }
  context: {
    active(): OtelContext
    with<T>(context: OtelContext, fn: () => T): T
  }
  propagation: {
    extract(context: OtelContext, carrier: unknown, getter?: unknown): OtelContext
    inject(context: OtelContext, carrier: unknown, setter?: unknown): void
    fields(): string[]
  }
  ROOT_CONTEXT: OtelContext
  SpanKind: { INTERNAL: number; SERVER: number; CLIENT: number; PRODUCER: number; CONSUMER: number }
  SpanStatusCode: { UNSET: number; OK: number; ERROR: number }
  TraceFlags: { NONE: number; SAMPLED: number }
}

let resolved: OtelApi | null | undefined

/**
 * Load `@opentelemetry/api` from the app root (once). Returns null when the
 * package is not installed — callers then no-op. Never throws.
 */
export function getOtelApi(appRoot: string): OtelApi | null {
  if (resolved !== undefined) return resolved
  resolved = null
  try {
    // Resolve against a file inside the app root so Node walks the app's
    // node_modules (where instrumentation.ts's @opentelemetry/api lives).
    const req = createRequire(path.join(appRoot, 'package.json'))
    const api = req('@opentelemetry/api') as OtelApi
    if (api?.trace && api.context) resolved = api
  } catch {
    resolved = null
  }
  return resolved
}

/** Test/bootstrap reset. */
export function resetOtelApi(): void {
  resolved = undefined
}
