/**
 * The sliver of the client action runtime both tiers need: the install-time half (client.ts)
 * and the dispatch half (dispatch.ts, loaded on the first action call). Keep this module small
 * - every byte here ships at first paint on any page that uses a server action.
 */
import type { ComponentType } from 'preact'

// Progressive-enhancement form fields: written by the server renderer, read by
// the submit listener (initial) and stripped off the wire by the encoder.
export const ACTION_ID_FIELD = '$pnext_action_id'
export const SUBMIT_ACTION_ID_FIELD = '$pnext_submit_action_id'
export const FORM_STATE_FIELD = '$pnext_form_state'

// Binary wire markers: encoded by the dispatch half, revived by both (island
// props can carry typed arrays before any action has run).
export const TYPED_ARRAY_MARKER = '$$pnext_typed_array'
export const ARRAY_BUFFER_MARKER = '$$pnext_array_buffer'

export interface ActionFunction {
  (...args: unknown[]): Promise<unknown>
  $$pnextActionId?: string
}

export interface ActionRuntime {
  call(id: string, args: unknown[]): Promise<unknown>
  createAction(id: string): ActionFunction
  registerClientReference(id: string, component: ComponentType<Record<string, unknown>>): void
  reviveProps<T>(value: T): T
  /** Fetch the dispatch chunk ahead of the first call. */
  warm(): void
}

declare global {
  interface Window {
    __PNEXT_ACTIONS__?: ActionRuntime
    /** Set once any action reference exists on the page (a client stub or a revived prop). */
    __PNEXT_ACTIONS_BOUND__?: boolean
  }
}

interface PNextActionError extends Error {
  $$pnextActionError?: boolean
}

export function tagActionError(error: unknown): unknown {
  if (error instanceof Error) (error as PNextActionError).$$pnextActionError = true
  return error
}

/** True for errors produced by an action dispatch (boundary channel filter). */
export function isActionError(error: unknown): boolean {
  return Boolean(error instanceof Error && (error as PNextActionError).$$pnextActionError)
}

/** Client components an action return may reference by id (element markers). */
export const actionReturnClientReferences = new Map<
  string,
  ComponentType<Record<string, unknown>>
>()

const TYPED_ARRAY_CTORS: Record<string, new (buffer: ArrayBuffer) => ArrayBufferView> = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  if (typeof atob === 'function') {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes.buffer
  }
  const buf = Buffer.from(base64, 'base64')
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

/** Revive a typed-array / ArrayBuffer wire marker, else undefined. */
export function reviveBinaryMarker(record: Record<string, unknown>): unknown {
  const typed = record[TYPED_ARRAY_MARKER]
  if (typed && typeof typed === 'object') {
    const { type, data } = typed as { type?: string; data?: string }
    const Ctor = type ? TYPED_ARRAY_CTORS[type] : undefined
    if (Ctor && typeof data === 'string') {
      return new Ctor(base64ToArrayBuffer(data))
    }
  }
  const buffer = record[ARRAY_BUFFER_MARKER]
  if (typeof buffer === 'string') return base64ToArrayBuffer(buffer)
  return undefined
}

declare const __PNEXT_CONCURRENT_ROUTER_QUEUE__: boolean

/** `experimental.concurrentRouterQueue` swaps in Next's unfinished router queue, whose entry points all throw. */
export function assertRouterQueueImplemented(): void {
  if (typeof __PNEXT_CONCURRENT_ROUTER_QUEUE__ === 'boolean' && __PNEXT_CONCURRENT_ROUTER_QUEUE__)
    throw new Error(
      'Not implemented: this behavior is not yet supported when `experimental.concurrentRouterQueue` is enabled.',
    )
}
