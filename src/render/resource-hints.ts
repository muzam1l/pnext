import type { ResourceHint } from '../types'

// Optional server-side observer for every registered hint (compat's Link response-header emission).
// Anchored on globalThis because react-dom's preload()/preinit() shims are compiled into app bundles as
// separate module instances - only a global slot lets the runtime-registered listener see the
// bundle-registered hints. No-op for pure-core apps.
const HINT_LISTENER = Symbol.for('pnext.resourceHintListener')

// The buffers a render fills and the renderer drains at document assembly: resource hints, the
// beforeInteractive head scripts and the deferred script runtime. One global array per kind is not
// enough - two renders alive at once in one process (a build prerendering a route beside the
// not-found document, or two concurrent requests) then share it, and whichever assembles first
// drains the other's preloads and head scripts. So a render gets a FRAME, and the buffers live in
// it; outside a render they stay on globalThis, where the next render start drops them.
//
// The frame store is created by the renderer (server-only, it owns node:async_hooks) and read here
// through the same globalThis anchor as the work unit: this module is compiled into client bundles
// and into every compat bundle's own copy, and only a shared slot lets those copies write into the
// frame the renderer reads.
export const RENDER_BUFFER_SCOPE = Symbol.for('pnext.renderBufferScope')
const RENDER_BUFFER_STRAYS = Symbol.for('pnext.renderBufferStrays')

export type RenderBufferKind = 'hints' | 'head' | 'deferred'
export type RenderBufferFrame = Record<RenderBufferKind, unknown[]>

export const newRenderBufferFrame = (): RenderBufferFrame => ({ hints: [], head: [], deferred: [] })

const globals = globalThis as Record<PropertyKey, unknown>

/** Duck-typed store read, so this module never pulls node:async_hooks into a client bundle. */
function frame(): RenderBufferFrame {
  const scope = globals[RENDER_BUFFER_SCOPE] as
    { getStore(): RenderBufferFrame | undefined } | undefined
  return (
    scope?.getStore() ??
    ((globals[RENDER_BUFFER_STRAYS] ??= newRenderBufferFrame()) as RenderBufferFrame)
  )
}

/** The current render's buffer, or the process-wide stray one outside a render. */
export function renderBuffer<T>(kind: RenderBufferKind): T[] {
  return frame()[kind] as T[]
}

/** Hand the buffer to the document being assembled and leave a fresh one behind. */
export function takeRenderBuffer<T>(kind: RenderBufferKind): T[] {
  const active = frame()
  const buffer = active[kind]
  active[kind] = []
  return buffer as T[]
}

/** Drop the frame's buffer AND the stray one, so out-of-render writes never accumulate. */
export function clearRenderBuffer(kind: RenderBufferKind): void {
  frame()[kind] = []
  const strays = globals[RENDER_BUFFER_STRAYS] as RenderBufferFrame | undefined
  if (strays) strays[kind] = []
}

export function setResourceHintListener(listener: ((hint: ResourceHint) => void) | undefined) {
  ;(globalThis as Record<PropertyKey, unknown>)[HINT_LISTENER] = listener
}

export function registerResourceHint(hint: ResourceHint): void {
  // `process.browser` is a client-bundle define (true) and undefined on the
  // server, so the whole server-side body folds away in browser builds; the
  // `typeof window` twin keeps the runtime check for unbundled consumers.
  if (process.browser || typeof window !== 'undefined') return
  const listener = (globalThis as Record<PropertyKey, unknown>)[HINT_LISTENER] as
    ((hint: ResourceHint) => void) | undefined
  listener?.(hint)
  const hints = renderBuffer<ResourceHint>('hints')
  if (hints.some(existing => resourceHintKey(existing) === resourceHintKey(hint))) return
  hints.push(hint)
}

export function clearResourceHints(): void {
  clearRenderBuffer('hints')
}

export function takeResourceHints(): ResourceHint[] {
  return takeRenderBuffer<ResourceHint>('hints')
}

function resourceHintKey(hint: ResourceHint): string {
  // React Float dedupes image preloads by the image URL, not the full attribute
  // set. next/image may register the same optimized candidate more than once
  // while a shared layout renders, and the first registration owns its shape.
  if (hint.rel === 'preload' && hint.as === 'image') {
    const srcSet = hint.attributes?.imagesrcset
    const first = typeof srcSet === 'string' ? srcSet.split(/[\s,]+/)[0] : undefined
    return `image:${first || hint.url || ''}`
  }
  const attributes = Object.entries(hint.attributes ?? {}).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify({ ...hint, attributes })
}
