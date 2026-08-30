// Server-action RETURN-value handling (COMPAT).
//
// Two Next behaviors the e2e suite asserts about what an action sends back:
//
// 1. temporary-references: a client passes a plain object to an action and the action returns that SAME
//    object; the client must receive the IDENTICAL object it sent (referential ===), not a structural
//    copy. Next threads a "temporary reference" through the flight wire. This mirrors it with a
//    lightweight tag protocol: the client stamps each top-level object arg with a temp-ref id and
//    remembers id -> object; the server keeps that id associated with the decoded arg object (a
//    WeakMap), and when it serializes the return value it emits a bare marker for any object the client
//    originally sent. The client swaps the marker back for its original object.
//
// 2. actions-streaming: an action may return a ReadableStream; the response must stream it to the
//    client unbuffered. JSON cannot carry a stream, so the server responds with the raw stream body
//    under a marker header/content type and the client returns a live ReadableStream from the call.
//
// These helpers are pure and node-safe. The client counterparts live inline in actions/client.ts.

/** Marker key naming a temporary-reference id in the args / return wire. */
export const TEMP_REF_MARKER = '$$pnext_temp_ref'
export const ACTION_ELEMENT_MARKER = '$$pnext_element'
/**
 * Marker carrying the SERVER-RENDERED HTML of a React element tree an action returned (host elements /
 * async server components - NOT a client-reference element, which uses ACTION_ELEMENT_MARKER). The
 * client revives it into a renderable node for useActionState.
 */
export const ACTION_ELEMENT_HTML_MARKER = '$$pnext_element_html'

const clientReferenceSymbol = Symbol.for('pnext.clientReference')

/**
 * Response content-type/marker for a streamed action return. The client detects
 * this and returns the response body as a ReadableStream from the call instead
 * of parsing JSON.
 */
export const ACTION_STREAM_CONTENT_TYPE = 'x-component/pnext-stream'

/**
 * Per-request association of a decoded arg object -> the temp-ref id the client
 * stamped on it. A WeakMap keyed by the live object preserves identity across
 * the action call (the action returns the same reference it received).
 */
export interface TempRefScope {
  /** Record that a decoded arg object carries the client's temp-ref id. */
  track(object: object, id: string): void
  /** The temp-ref id the client sent for this object, if any. */
  idFor(value: unknown): string | undefined
  /** True once any temp-ref arg has been seen (skip serialization walk otherwise). */
  readonly active: boolean
}

export function createTempRefScope(): TempRefScope {
  const ids = new WeakMap<object, string>()
  let active = false
  return {
    track(object, id) {
      ids.set(object, id)
      active = true
    },
    idFor(value) {
      if (value === null || typeof value !== 'object') return undefined
      return ids.get(value)
    },
    get active() {
      return active
    },
  }
}

/**
 * Strip and record temp-ref markers from a decoded argument tree in place.
 * A `{ [TEMP_REF_MARKER]: id, ...rest }` object is unwrapped to `rest` and the
 * resulting object is tracked under `id`, so the action sees a clean object and
 * a later return of that same object serializes back to the marker.
 */
export function extractTempRefs(
  value: unknown,
  scope: TempRefScope,
  seen = new Set<unknown>(),
): unknown {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return value
  seen.add(value)
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = extractTempRefs(value[i], scope, seen)
    return value
  }
  const record = value as Record<string, unknown>
  const id = record[TEMP_REF_MARKER]
  if (typeof id === 'string') {
    delete record[TEMP_REF_MARKER]
    scope.track(record, id)
  }
  for (const key of Object.keys(record)) {
    record[key] = extractTempRefs(record[key], scope, seen)
  }
  return record
}

/**
 * Serialize temporary references and elements in an action return.
 * - A client-reference element carries only its client-reference id, props and key.
 * - A server element tree is server-rendered to island wire HTML via the injected `renderElement`;
 *   JSON cannot carry vnode $$typeof Symbols, so without this the tree dumps as raw vnode internals and
 *   useActionState never gets a node. Async because rendering resolves async server components; when no
 *   renderer is injected, element trees fall through unchanged.
 */
export async function serializeReturnWithTempRefs(
  value: unknown,
  scope: TempRefScope,
  renderElement?: (element: unknown) => Promise<string>,
): Promise<unknown> {
  const walk = async (input: unknown, seen: Set<unknown>): Promise<unknown> => {
    if (input === null || typeof input !== 'object') return input
    const marker = scope.active ? scope.idFor(input) : undefined
    if (marker !== undefined) return { [TEMP_REF_MARKER]: marker }
    if (seen.has(input)) return input
    seen.add(input)
    const element = clientReferenceElement(input)
    if (element) {
      return {
        [ACTION_ELEMENT_MARKER]: {
          id: element.id,
          props: await walk(element.props, seen),
          ...(element.key !== undefined ? { key: element.key } : {}),
        },
      }
    }
    if (renderElement && isServerElement(input)) {
      return { [ACTION_ELEMENT_HTML_MARKER]: await renderElement(input) }
    }
    if (Array.isArray(input)) return Promise.all(input.map(item => walk(item, seen)))
    const proto = Object.getPrototypeOf(input) as object | null
    if (proto !== Object.prototype && proto !== null) return input
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
      out[key] = await walk(item, seen)
    }
    return out
  }
  return walk(value, new Set())
}

/**
 * True for a React element / preact vnode that is NOT a client-reference element
 * (those are handled by clientReferenceElement first). Detects the preact vnode
 * brand (own `constructor === undefined`) or the react.element `$$typeof`, so a
 * plain data object that merely has `type`/`props` keys is never mistaken for an
 * element (it stays JSON-serialized).
 */
function isServerElement(value: object): boolean {
  const vnode = value as { type?: unknown; props?: unknown; $$typeof?: unknown }
  if (!('type' in vnode) || !('props' in vnode)) return false
  if (vnode.$$typeof === Symbol.for('react.element')) return true
  return (
    Object.prototype.hasOwnProperty.call(value, 'constructor') &&
    (value as { constructor?: unknown }).constructor === undefined
  )
}

function clientReferenceElement(
  value: object,
): { id: string; props: unknown; key?: string | number } | undefined {
  const vnode = value as { type?: unknown; props?: unknown; key?: unknown }
  if (typeof vnode.type !== 'function') return undefined
  const reference = (vnode.type as unknown as Record<symbol, unknown>)[clientReferenceSymbol] as
    { id?: unknown } | undefined
  if (typeof reference?.id !== 'string') return undefined
  const key = typeof vnode.key === 'string' || typeof vnode.key === 'number' ? vnode.key : undefined
  return { id: reference.id, props: vnode.props ?? {}, ...(key !== undefined ? { key } : {}) }
}

/** True for a value the streaming action path must send as a raw stream body. */
export function isReadableStreamReturn(value: unknown): value is ReadableStream {
  return typeof ReadableStream !== 'undefined' && value instanceof ReadableStream
}
