// Typed-array / ArrayBuffer wire markers. Binary values are not JSON-native, so
// serializeProps marker-encodes them (base64 payload, same $$pnext_* convention
// as the action wire's $$pnext_date) instead of throwing; the client/server
// revive the marker back into the original view. assertSerializable accepts
// them (they are "serializable" via the marker path) rather than rejecting.
const TYPED_ARRAY_MARKER = '$$pnext_typed_array'
const ARRAY_BUFFER_MARKER = '$$pnext_array_buffer'
// Map/Set are part of React's flight wire vocabulary (client components can receive them as props); pnext
// does not stream them as distinct RSC row types yet, so they ride as ordinary marker objects, entries
// encoded recursively like the binary markers above, instead of throwing "must be a plain object". Client
// code that only round-trips the value sees a marker object rather than a live Map/Set instance - a known
// gap, not a full flight-protocol Map/Set.
const MAP_MARKER = '$$pnext_map'
const SET_MARKER = '$$pnext_set'
// Cyclic props (a client component receiving `obj.self === obj`) are part of React's flight vocabulary:
// flight emits a BACK-REFERENCE to the row/path the value was first written at rather than expanding it
// forever. Same idea here, scoped to the ancestor chain: an object that reappears INSIDE ITSELF is written as
// `{$$pnext_ref: [...path from the props root]}` and the client patches the original object back in,
// restoring identity. Only true cycles are encoded this way - a value that merely appears twice in different
// branches is still expanded, so every acyclic payload is byte-identical to what it was before.
const REF_MARKER = '$$pnext_ref'
// Promise-valued island props ride as `{__pnextPromise: resolved}` so the value keeps its PROMISE
// IDENTITY across the wire - top level (page params) and nested in plain containers (a react-query
// dehydrated state carries its pending-query promise inside `state.queries[n].promise`). The render
// half writes the marker (render/slots promiseMarker); both revive halves live here so the
// preact-free client entry can import them.
export const PROMISE_MARKER_KEY = '__pnextPromise'

type TypedArray =
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array

function isTypedArray(value: unknown): value is TypedArray {
  return ArrayBuffer.isView(value) && !(value instanceof DataView)
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64')
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function encodeTypedArray(value: TypedArray) {
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return { [TYPED_ARRAY_MARKER]: { type: value.constructor.name, data: bytesToBase64(bytes) } }
}

function encodeArrayBuffer(value: ArrayBuffer) {
  return { [ARRAY_BUFFER_MARKER]: bytesToBase64(new Uint8Array(value)) }
}

/**
 * Deep-copy `value`, replacing typed arrays / ArrayBuffers with wire markers
 * and self-references (cycles) with `$$pnext_ref` back-references.
 *
 * `ancestors` maps every object on the CURRENT path to the path it was written
 * at; it is unwound on the way back out, so only a value that contains itself
 * becomes a reference.
 */
function encodeBinary(
  value: unknown,
  ancestors = new Map<object, string[]>(),
  path: string[] = [],
): unknown {
  if (value === null || typeof value !== 'object') return value
  if (isTypedArray(value)) return encodeTypedArray(value)
  if (value instanceof ArrayBuffer) return encodeArrayBuffer(value)
  const ancestorPath = ancestors.get(value)
  if (ancestorPath) return { [REF_MARKER]: ancestorPath }
  ancestors.set(value, path)
  const encoded = encodeContainer(value, ancestors, path)
  ancestors.delete(value)
  return encoded
}

function encodeContainer(value: object, ancestors: Map<object, string[]>, path: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => encodeBinary(item, ancestors, [...path, String(index)]))
  }
  if (value instanceof Map) {
    return {
      [MAP_MARKER]: [...value.entries()].map(([k, v]) => [
        encodeBinary(k, ancestors),
        encodeBinary(v, ancestors),
      ]),
    }
  }
  if (value instanceof Set) {
    return { [SET_MARKER]: [...value].map(item => encodeBinary(item, ancestors)) }
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = encodeBinary(item, ancestors, [...path, key])
  }
  return out
}

// Errors reach `error.tsx` as props and ride the same marker convention (the
// encoder for this one lives on the render side, with the boundary props).
const ERROR_MARKER = '$$pnextError'
// error.tsx's `reset`/`unstable_retry` are FUNCTIONS the framework supplies, so
// they cross as this marker (renderer serializeConventionProps) and come back as
// a re-run of the route. Compat's action runtime revives it first and identically;
// core has no action runtime, so the reviver below is the one that runs.
const ERROR_RESET_MARKER = '$$pnextErrorReset'

/**
 * Revive the wire markers `serializeProps` wrote, IN PLACE:
 *
 * - `$$pnext_ref` back-references, restoring the identity the server saw. Paths are relative to the root
 *   passed in - the same root serializeProps encoded - and always point at an ancestor, so the target is
 *   already materialized when the marker is hit.
 * - typed arrays / ArrayBuffers, back into the original view.
 * - Errors, via `extra` - see `reviveSerializedErrorRefs`.
 *
 * The action runtime revives all of these for apps that have it, but an app with no server actions never
 * loads it - and its islands would then hydrate with marker objects where the server rendered real values.
 */
export function reviveSerializedRefs<T>(
  root: T,
  extra?: (node: Record<string, unknown>) => unknown,
): T {
  if (root === null || typeof root !== 'object') return root
  const visit = (node: Record<string, unknown>): void => {
    for (const key of Object.keys(node)) {
      const item = node[key]
      if (item === null || typeof item !== 'object' || ArrayBuffer.isView(item)) continue
      const child = item as Record<string, unknown>
      const revived =
        refTarget(root, child) ?? extra?.(child) ?? binaryTarget(child) ?? errorResetTarget(child)
      if (revived !== undefined) {
        node[key] = revived
        continue
      }
      visit(child)
    }
  }
  visit(root as Record<string, unknown>)
  return root
}

/**
 * The above plus `$$pnextError`. Kept as its own export so the error branch
 * tree-shakes out of core/react client entries: `$$pnextError` is a
 * next-compat-only marker (the renderer's `serializeActionProps` returns props
 * untouched when compat is off), and only compat entries import this name.
 */
export function reviveSerializedErrorRefs<T>(root: T): T {
  return reviveSerializedRefs(root, errorTarget)
}

function errorResetTarget(node: Record<string, unknown>): (() => void) | undefined {
  return node[ERROR_RESET_MARKER] === true ? reloadRoute : undefined
}

function reloadRoute(): void {
  location.reload()
}

function errorTarget(node: Record<string, unknown>): Error | undefined {
  const marker = node[ERROR_MARKER]
  if (marker === null || typeof marker !== 'object') return undefined
  const data = marker as { name?: unknown; message?: unknown; digest?: unknown }
  const error = new Error(typeof data.message === 'string' ? data.message : '')
  if (typeof data.name === 'string') error.name = data.name
  if (typeof data.digest === 'string') (error as Error & { digest?: string }).digest = data.digest
  return error
}

// The wire carries the view's constructor NAME. Resolved off the global rather than a name-to-constructor
// table (the table is first-paint client code): `BYTES_PER_ELEMENT` exists only on typed-array constructors,
// so any other name - including one that resolves to something else entirely - resolves to undefined and the
// marker is left alone.
function typedArrayConstructor(name: string) {
  const constructor = (globalThis as unknown as Record<string, unknown>)[name]
  return typeof constructor === 'function' && 'BYTES_PER_ELEMENT' in constructor
    ? (constructor as unknown as new (buffer: ArrayBuffer) => TypedArray)
    : undefined
}

// Decode side is client-only (the encoder is what runs on the server), so no
// Buffer fast path — `atob` is global in every runtime that reaches this.
function base64ToBytes(data: string): Uint8Array {
  return Uint8Array.from(atob(data), character => character.charCodeAt(0))
}

function binaryTarget(node: Record<string, unknown>): TypedArray | ArrayBuffer | undefined {
  const buffer = node[ARRAY_BUFFER_MARKER]
  if (typeof buffer === 'string') return base64ToBytes(buffer).buffer as ArrayBuffer
  const typed = node[TYPED_ARRAY_MARKER]
  if (typed === null || typeof typed !== 'object') return undefined
  const { type, data } = typed as { type?: unknown; data?: unknown }
  if (typeof type !== 'string' || typeof data !== 'string') return undefined
  const Constructor = typedArrayConstructor(type)
  return Constructor ? new Constructor(base64ToBytes(data).buffer as ArrayBuffer) : undefined
}

function refTarget(root: unknown, node: Record<string, unknown>): unknown {
  const path = node[REF_MARKER]
  if (!Array.isArray(path)) return undefined
  let current: unknown = root
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[String(key)]
  }
  return current
}

/** Cheap gate: an island whose raw props carry no marker skips the revive walk entirely. */
export function hasPromiseProps(raw: string) {
  return raw.includes(PROMISE_MARKER_KEY)
}

/**
 * Revive every `promiseMarker` in `props` - top level and nested inside plain objects/arrays - into a
 * PRE-FULFILLED promise (React `use()` protocol: status/value readable synchronously). A bare
 * `Promise.resolve` would make `use()` suspend during hydration, and a suspended hydration re-render
 * appends fragment siblings instead of reusing the server DOM.
 *
 * Nested containers are rewritten in place (the client just parsed them; the server already
 * serialized the wire bytes before this runs), the root is not.
 */
export function revivePromiseMarkers<T>(props: T, sync?: SyncPropsRebuild): T {
  return reviveMarkers(props, new Set(), sync) as T
}

/**
 * Rebuild the legacy sync surface (`withSyncProps`) on a revived promise. The wire carries only the
 * resolved value, so a marker revives into a bare promise and every unawaited `params.creator` read
 * a Next-14-era component makes returns undefined - on the island SSR pass as well as on the client.
 */
export type SyncPropsRebuild = <T extends object>(
  promise: Promise<T>,
  kind: 'params' | 'searchParams',
  value: T,
) => Promise<T>

/** Exactly the props Next gives the transitional sync surface - the same scope as the server's. */
const SYNC_PROP_KEYS = new Set(['params', 'searchParams'])

function reviveMarkers(
  value: unknown,
  seen: Set<object>,
  sync?: SyncPropsRebuild,
  key?: string,
): unknown {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  if (PROMISE_MARKER_KEY in value) {
    const resolved = (value as Record<string, unknown>)[PROMISE_MARKER_KEY]
    const promise = fulfilledPromise(resolved)
    if (!sync || !key || !SYNC_PROP_KEYS.has(key)) return promise
    if (resolved === null || typeof resolved !== 'object') return promise
    return sync(promise as Promise<object>, key as 'params' | 'searchParams', resolved)
  }
  seen.add(value)
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      value[index] = reviveMarkers(value[index], seen, sync)
    }
    return value
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return value
  const target = value as Record<string, unknown>
  for (const name of Object.keys(target)) {
    target[name] = reviveMarkers(target[name], seen, sync, name)
  }
  return value
}

/**
 * Client half of `withSyncProps`: give the revived promise the resolved object's own keys, skipping
 * the ones the promise already answers for (then/status/value/...), exactly as the server does.
 */
export function rebuildSyncProps<T extends object>(
  promise: Promise<T>,
  _kind: 'params' | 'searchParams',
  value: T,
): Promise<T> {
  for (const key of Object.keys(value)) {
    if (key in promise) continue
    void Object.defineProperty(promise, key, {
      get: () => (value as Record<string, unknown>)[key],
      enumerable: true,
      configurable: true,
    })
  }
  return promise
}

function fulfilledPromise(value: unknown) {
  const promise = Promise.resolve(value) as Promise<unknown> & { status: string; value: unknown }
  promise.status = 'fulfilled'
  promise.value = value
  return promise
}

/** A preact vnode: `h` sets `constructor` to undefined on every one it makes. */
export function isElementLike(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  return (
    (value as { constructor?: unknown }).constructor === undefined &&
    'type' in value &&
    'props' in value
  )
}

export function assertSerializable(
  value: unknown,
  path = 'props',
  seen = new Set<unknown>(),
  // Island props only: element values are replaced by `$$pnext_slot` markers upstream (islands/
  // static-slots), so they are serializable there. Server-action args/returns keep throwing.
  allowElements = false,
) {
  if (value == null) return
  if (allowElements && isElementLike(value)) return
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean') return
  if (type === 'function' || type === 'symbol' || type === 'bigint' || type === 'undefined') {
    throw new Error(`${path} is not serializable: ${type}`)
  }
  // Typed arrays / ArrayBuffers are serializable via the binary marker path.
  if (isTypedArray(value) || value instanceof ArrayBuffer) return
  if (value instanceof Date || value instanceof URL) {
    throw new Error(`${path} must be a plain JSON value`)
  }
  // A promise the render half could not await: island props are awaited at the top level and inside
  // plain objects/arrays/Maps/Sets, so anything left here sits behind a class instance (or is a
  // server-action argument, where promises are never allowed). Say so instead of "plain object".
  if (typeof (value as { then?: unknown }).then === 'function') {
    throw new Error(
      `${path} is a Promise: a promise prop must be reachable at the top level of the props or nested in plain objects/arrays/Maps/Sets - one held by a class instance cannot be awaited or serialized, and server actions take no promises at all`,
    )
  }
  if (typeof value !== 'object') return
  // A value that contains ITSELF is serializable: encodeBinary writes it as a
  // `$$pnext_ref` back-reference (React flight does the same), so stop walking
  // rather than rejecting the props.
  if (seen.has(value)) return
  seen.add(value)

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertSerializable(item, `${path}[${index}]`, seen, allowElements),
    )
    return
  }

  // Elements stay illegal inside Map/Set: the slot walk (render/static-slots) does not enter
  // them, so allowing one would silently ship a JSON-mangled vnode instead of a `$$pnext_slot`.
  if (value instanceof Map) {
    let index = 0
    for (const [key, item] of value.entries()) {
      assertSerializable(key, `${path}<Map key ${index}>`, seen)
      assertSerializable(item, `${path}<Map value ${index}>`, seen)
      index++
    }
    return
  }

  if (value instanceof Set) {
    let index = 0
    for (const item of value) {
      assertSerializable(item, `${path}<Set item ${index}>`, seen)
      index++
    }
    return
  }

  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${path} must be a plain object`)
  }

  for (const [key, item] of Object.entries(value)) {
    assertSerializable(item, `${path}.${key}`, seen, allowElements)
  }
}

// ---------------------------------------------------------------------------
// Tainted object references (COMPAT `experimental.taint` opts in; the registry
// itself is inert until something registers a value).
//
// React's taint APIs (taintObjectReference) don't exist under preact, so the
// client-props serializer enforces the same contract with an IDENTITY check:
// compat registers `process.env` when `experimental.taint` is set, and any
// client-component prop that IS that object (at any depth) throws the
// registered message. The throw travels the normal render-error path, so dev
// shows the message in the nearest error.tsx boundary and prod shows React's
// redacted #441 text.
//
// The registry is anchored on globalThis: a module loaded twice (built copy vs
// original) must not split the tainted set.
// ---------------------------------------------------------------------------

const TAINT_REGISTRY_KEY = '__pnext_tainted_values__'

/** Dev message plus the redacted text prod shows in its place. */
export interface TaintMessages {
  dev: string
  prod: string
}

function taintRegistry(): Map<object, TaintMessages> {
  const host = globalThis as { [TAINT_REGISTRY_KEY]?: Map<object, TaintMessages> }
  const existing = host[TAINT_REGISTRY_KEY]
  if (existing) return existing
  const created = new Map<object, TaintMessages>()
  host[TAINT_REGISTRY_KEY] = created
  return created
}

/** Register `value` as unsafe to pass to a client component. */
export function taintObjectReference(messages: TaintMessages, value: object): void {
  taintRegistry().set(value, messages)
}

/**
 * Throw if a tainted object reference appears anywhere in `value`. Must run on
 * the RAW props (before any serializer copies plain objects and drops the
 * identity the check relies on).
 */
export function assertNotTainted(value: unknown, seen = new Set<unknown>()): void {
  const registry = taintRegistry()
  if (registry.size === 0) return
  if (value === null || typeof value !== 'object') return
  const messages = registry.get(value)
  if (messages !== undefined) {
    // Next surfaces the explanatory message in dev only; prod renders React's
    // redacted RSC error text in the nearest error boundary.
    throw new Error(
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      process.env.NODE_ENV === 'development' ? messages.dev : messages.prod,
    )
  }
  if (seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) assertNotTainted(item, seen)
    return
  }
  if (value instanceof Map) {
    for (const [key, item] of value.entries()) {
      assertNotTainted(key, seen)
      assertNotTainted(item, seen)
    }
    return
  }
  if (value instanceof Set) {
    for (const item of value) assertNotTainted(item, seen)
    return
  }
  const proto = Object.getPrototypeOf(value) as object | null
  if (proto !== Object.prototype && proto !== null) return
  for (const item of Object.values(value)) assertNotTainted(item, seen)
}

export function serializeProps(value: unknown, options?: { allowElements?: boolean }) {
  assertNotTainted(value)
  assertSerializable(value, 'props', new Set(), options?.allowElements)
  return JSON.stringify(encodeBinary(value)).replace(/[<>&\u2028\u2029]/g, char => {
    switch (char) {
      case '<':
        return '\\u003c'
      case '>':
        return '\\u003e'
      case '&':
        return '\\u0026'
      case '\u2028':
        return '\\u2028'
      case '\u2029':
        return '\\u2029'
      default:
        return char
    }
  })
}
