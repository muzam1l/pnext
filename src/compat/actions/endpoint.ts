import { isNotFoundError, isRedirectError, type PNextRedirectError } from '../../api/navigation'
import { runWithRequest, setPhase } from '../../request/context'
import { toNextRequest } from '../../api/server'
import { revalidationEventCount } from '../cache/revalidate'
import { serializeBoundaryError } from '../lifecycle/error-serialize'
import { lookupAction } from './registry'
import { instanceActionRouteId, isInstanceActionId, lookupActionInstance } from './instances'
import { inlineActionModuleKey, isInlineActionId } from './rewrite'
import {
  ACTION_STREAM_CONTENT_TYPE,
  createTempRefScope,
  extractTempRefs,
  isReadableStreamReturn,
  serializeReturnWithTempRefs,
} from './return'
import {
  ACTION_ARGS_FIELD,
  ACTION_ID_FIELD,
  FORM_STATE_FIELD,
  ACTION_ID_HEADER,
  ACTION_NOT_FOUND_HEADER,
  NEXT_ACTION_NOT_FOUND_HEADER,
  ACTION_REDIRECT_HEADER,
  ACTION_REFRESH_HEADER,
  NEXT_ACTION_REVALIDATED_HEADER,
  ARG_ACTION_MARKER,
  ARG_FILE_MARKER,
  ARG_FILE_PREFIX,
  ARG_FORMDATA_MARKER,
  ARG_FORMDATA_PREFIX,
  REDIRECT_TYPE_HEADER,
  ACTION_ERROR_DIGEST_HEADER,
  MASKED_ACTION_ERROR,
  MAX_ACTION_ARGS,
  tooManyArgsMessage,
  type ActionSuccessBody,
} from './protocol'

/**
 * Framework-agnostic runtime handler for a server-action RPC. It reads the action id header, decodes
 * the arguments (JSON args as text/plain, or multipart/urlencoded FormData for form submissions),
 * resolves the action via the module registry or the live-instance registry, and invokes it inside a
 * request scope so headers()/cookies() work and cookie mutations propagate to the response.
 * redirect()/notFound() thrown by the action are translated to the right HTTP responses; other throws
 * become masked (prod) or detailed (dev) text/plain errors; successes become { data } JSON.
 *
 * This module never imports build/dev machinery - `importModule` and `rerenderRoute` are the only
 * bridges to real module loading/rendering, which keeps the endpoint portable across runtimes.
 */
export interface RunActionOptions {
  /** Load an action module by its registered modulePath. Injected by the caller. */
  importModule: (modulePath: string) => Promise<Record<string, unknown>>
  /**
   * Re-render a route server-side to re-register live inline-action instances
   * (see instances.ts) after a process restart. Optional; without it a cold
   * instance id fails with unknown-action.
   */
  rerenderRoute?: (routeId: string, request: Request) => Promise<void>
  /**
   * Import an app module by its workspace-relative source key so its
   * compile-injected inline-action registrations run (cold 'if:' id lookups).
   */
  importSourceModule?: (moduleKey: string) => Promise<void>
  /** Dev mode: error bodies carry real messages instead of the masked text. */
  dev?: boolean
  /** Body size limit in bytes (Next default 1mb). */
  maxBodyBytes?: number
  /**
   * Report a thrown action error to the app's onRequestError instrumentation.
   * Injected by the caller (compat glue) so this module stays portable; called
   * once for a real (non control-flow) throw before the masked 500 is returned.
   */
  onError?: (error: unknown, request: Request) => void | Promise<void>
  /**
   * Server-render a React element tree an action RETURNED to island wire HTML
   * (the JSON return serializer cannot carry vnode Symbols). Injected by the
   * caller (register-actions) so this module never imports the renderer; when
   * absent, element returns fall through the JSON serializer unchanged.
   */
  renderActionElement?: (element: unknown) => Promise<string>
}

export const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024

/**
 * Server-side fallback for client-action stubs. A `'use server'` function imported into a client
 * component compiles, in the CLIENT bundle, to a stub that dispatches over `window.__PNEXT_ACTIONS__`.
 * That same bundle server-renders the client component, so when such an action is *called* on the
 * server the stub has no window and would throw. Expose the endpoint's own id-to-module resolution on
 * a global the stub can reach, so it instead runs the real compiled action, inheriting the request
 * scope already active around it.
 */
function installServerActionDispatch(
  importModule: (modulePath: string) => Promise<Record<string, unknown>>,
): void {
  ;(
    globalThis as {
      __PNEXT_SERVER_ACTIONS__?: { call(id: string, args: unknown[]): Promise<unknown> }
    }
  ).__PNEXT_SERVER_ACTIONS__ = {
    async call(dispatchId: string, dispatchArgs: unknown[]): Promise<unknown> {
      const target = lookupAction(dispatchId)
      if (!target) {
        throw new Error(
          `Failed to find Server Action "${dispatchId}". This request might be from an older or newer deployment.`,
        )
      }
      const module = await importModule(target.modulePath)
      const fn = module[target.exportName]
      if (typeof fn !== 'function') {
        throw new Error(`Failed to find Server Action "${dispatchId}".`)
      }
      return (fn as (...a: unknown[]) => unknown)(...dispatchArgs)
    },
  }
}

export async function runAction(request: Request, options: RunActionOptions): Promise<Response> {
  const id = request.headers.get(ACTION_ID_HEADER)
  if (!id) {
    return errorResponse(`Missing ${ACTION_ID_HEADER} header`, 400)
  }
  // Arm the server-side stub dispatcher for this request's module loader before
  // resolving/running the action (a client-imported action may re-render the
  // route, whose SSR captures client stubs that dispatch back through here).
  installServerActionDispatch(options.importModule)

  // A resolution failure (a compiled action module that fails to import, a route re-render that
  // throws) must surface as the recognizable 404 not-found wire - never an unhandled 500 the client
  // reads as "unexpected response". A forwarded action dispatched from another page hits the same
  // global resolution and needs the same graceful degradation.
  let action: ((...args: unknown[]) => unknown) | undefined
  try {
    action = await resolveAction(id, request, options)
  } catch (error) {
    console.error(error)
    action = undefined
  }
  if (!action) {
    // Wire + log shape asserted by the actions-unrecognized suite: the log is
    // the two-line "Failed to find" text; the RPC body is the exact message
    // React's flight client throws for a missing action (unmasked even in
    // prod — version skew is actionable for users).
    console.error(
      `Failed to find Server Action "${id}". This request might be from an older or newer deployment.\n` +
        'Read more: https://nextjs.org/docs/messages/failed-to-find-server-action',
    )
    return new Response(`Server Action "${id}" was not found on the server.`, {
      status: 404,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        [NEXT_ACTION_NOT_FOUND_HEADER]: '1',
      },
    })
  }

  const limit = options.maxBodyBytes ?? DEFAULT_BODY_LIMIT_BYTES
  let args: unknown[]
  try {
    args = await decodeArgs(request, limit)
  } catch (error) {
    if (error instanceof BodyLimitError) {
      console.error(`Error: ${error.message}`)
      console.error(
        'To configure the body size limit for Server Actions, see: https://nextjs.org/docs/app/api-reference/next-config-js/serverActions#bodysizelimit',
      )
      return errorResponse(options.dev ? error.message : MASKED_ACTION_ERROR, 500)
    }
    return errorResponse(`Invalid action payload: ${messageOf(error)}`, 400)
  }

  try {
    args = await reviveActionRefs(args, id => resolveAction(id, request, options))
  } catch (error) {
    if (error instanceof UnknownActionReferenceError) {
      return errorResponse(error.message, 404)
    }
    return errorResponse(`Invalid action payload: ${messageOf(error)}`, 400)
  }

  if (args.length > MAX_ACTION_ARGS) {
    const message = tooManyArgsMessage(args.length)
    console.error(`Error: ${message}`)
    return errorResponse(options.dev ? message : MASKED_ACTION_ERROR, 500)
  }

  // Temporary-reference scope: strip the client's temp-ref tags off the decoded
  // args (so the action sees clean objects) and remember object -> id, so a
  // returned arg object serializes back to the identical client reference.
  const tempRefs = createTempRefScope()
  args = args.map(arg => extractTempRefs(arg, tempRefs))

  // Run inside a request scope with a response-headers channel: headers() and
  // cookies() read the RPC request (which carries the browser's live cookies),
  // and cookies().set()/delete() append set-cookie onto the channel.
  const responseHeaders = new Headers()
  const revalidationsBefore = revalidationEventCount()
  const nextRequest = toNextRequest(request)
  try {
    // The action body runs under the 'action' phase so cookies().set() is legal
    // here (and illegal once the phase flips to 'render'/'after' — phase-changes
    // suite). Restored to 'render' once the action settles so a follow-up
    // redirect-target render is treated as a render.
    setPhase('action')
    const data = await runWithRequest(
      nextRequest,
      () => Promise.resolve(action(...args)),
      {},
      { responseHeaders },
    ).finally(() => setPhase('render'))
    const refresh =
      revalidationEventCount() !== revalidationsBefore || hasSetCookie(responseHeaders)
    // A ReadableStream return streams the raw bytes to the client unbuffered
    // (actions-streaming): JSON can't carry a stream, so the body IS the stream
    // under a marker content-type the client detects.
    if (isReadableStreamReturn(data)) {
      const headers = new Headers({ 'content-type': ACTION_STREAM_CONTENT_TYPE })
      setRefreshHeaders(headers, refresh)
      return withResponseHeaders(new Response(data, { status: 200, headers }), responseHeaders)
    }
    const serialized = await serializeReturnWithTempRefs(
      data,
      tempRefs,
      options.renderActionElement,
    )
    const body: ActionSuccessBody = {
      data: encodeBinaryReturn(serialized),
    }
    const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' })
    setRefreshHeaders(headers, refresh)
    return withResponseHeaders(
      new Response(JSON.stringify(body), { status: 200, headers }),
      responseHeaders,
    )
  } catch (error) {
    if (isRedirectError(error)) {
      return withResponseHeaders(
        redirectResponse(
          error,
          revalidationEventCount() !== revalidationsBefore || hasSetCookie(responseHeaders),
        ),
        responseHeaders,
      )
    }
    if (isNotFoundError(error)) {
      return withResponseHeaders(
        new Response('Not found', {
          status: 404,
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            [ACTION_NOT_FOUND_HEADER]: '1',
          },
        }),
        responseHeaders,
      )
    }
    const message = messageOf(error)
    // Compute the boundary digest with the same deterministic scheme the render
    // path uses (error-serialize.ts) so the client-visible digest and the server
    // log agree. Next's prod server log prints the ORIGINAL error trace followed
    // by `digest: '<digest>'` so operators can correlate the redacted client
    // digest with the full server-side stack.
    let digest: string | undefined
    if (error instanceof Error) {
      digest = serializeBoundaryError({ error, dev: Boolean(options.dev) }).digest
      const trace = error.stack ?? error.message
      console.error(typeof digest === 'string' ? `${trace}\n  digest: '${digest}'` : trace)
    } else {
      console.error(error)
    }
    await options.onError?.(error, request)
    const masked = errorResponse(options.dev ? message : MASKED_ACTION_ERROR, 500)
    if (typeof digest === 'string') masked.headers.set(ACTION_ERROR_DIGEST_HEADER, digest)
    return withResponseHeaders(masked, responseHeaders)
  }
}

async function resolveAction(
  id: string,
  request: Request,
  options: RunActionOptions,
): Promise<((...args: unknown[]) => unknown) | undefined> {
  if (isInlineActionId(id)) {
    let instance = lookupActionInstance(id)
    if (!instance && options.importSourceModule) {
      const moduleKey = inlineActionModuleKey(id)
      if (moduleKey) {
        try {
          await options.importSourceModule(moduleKey)
        } catch {
          // fall through to the unknown-action error
        }
        instance = lookupActionInstance(id)
      }
    }
    return instance
  }
  if (isInstanceActionId(id)) {
    let instance = lookupActionInstance(id)
    if (!instance && options.rerenderRoute) {
      const routeId = instanceActionRouteId(id)
      if (routeId) {
        try {
          await options.rerenderRoute(routeId, request)
        } catch {
          // fall through to the unknown-action error below
        }
        instance = lookupActionInstance(id)
      }
    }
    return instance
  }

  const target = lookupAction(id)
  if (!target) return undefined
  const module = await options.importModule(target.modulePath)
  const action = module[target.exportName]
  return typeof action === 'function' ? (action as (...args: unknown[]) => unknown) : undefined
}

class BodyLimitError extends Error {}

/**
 * Drain the request body ONCE into bytes and enforce the size limit. All decoding then happens off
 * this buffer: the text path decodes the bytes directly (a single whole-buffer UTF-8 decode, so
 * multi-byte characters can never split across chunk boundaries), and the multipart path parses a
 * reconstructed Request whose stale content-length header is dropped - the upstream request may have
 * been rewrapped by forwarding/middleware bridges, and a mismatched declared length must not truncate
 * the buffered body.
 */
async function readBodyBytesWithLimit(request: Request, limit: number): Promise<ArrayBuffer> {
  const bytes = await request.arrayBuffer()
  if (bytes.byteLength > limit) {
    throw new BodyLimitError(`Body exceeded ${formatLimit(limit)} limit`)
  }
  return bytes
}

function bufferedFormRequest(request: Request, bytes: ArrayBuffer): Request {
  const headers = new Headers(request.headers)
  headers.delete('content-length')
  return new Request(request.url, {
    method: request.method,
    headers,
    body: bytes.byteLength === 0 ? undefined : bytes,
  })
}

function formatLimit(limit: number) {
  if (limit % (1024 * 1024) === 0) return `${limit / (1024 * 1024)}mb`
  if (limit % 1024 === 0) return `${limit / 1024}kb`
  return `${limit} bytes`
}

/**
 * Decode the request body into an argument array.
 * - multipart/form-data or urlencoded without ACTION_ARGS_FIELD -> a single
 *   FormData argument (form submissions; the action id field is stripped).
 * - multipart with ACTION_ARGS_FIELD -> the JSON arg list with FormData/File
 *   slots re-materialized from the other parts (bound args ahead of a form).
 * - anything else (the client runtime sends text/plain) -> JSON args array.
 * - empty body -> no args.
 */
async function decodeArgs(request: Request, limit: number): Promise<unknown[]> {
  const bytes = await readBodyBytesWithLimit(request, limit)
  const contentType = request.headers.get('content-type') ?? ''

  if (contentType.includes('multipart/form-data') || contentType.includes('form-urlencoded')) {
    const form = await bufferedFormRequest(request, bytes).formData()
    const argsField = form.get(ACTION_ARGS_FIELD)
    form.delete(ACTION_ID_FIELD)
    if (typeof argsField === 'string') {
      form.delete(ACTION_ARGS_FIELD)
      return decodeStructuredArgs(argsField, form)
    }
    // Progressive useActionState submission: the form carries its current
    // state; the action signature is (state, formData).
    const stateField = form.get(FORM_STATE_FIELD)
    if (typeof stateField === 'string') {
      form.delete(FORM_STATE_FIELD)
      let state: unknown = null
      try {
        state = JSON.parse(stateField)
      } catch {
        state = stateField
      }
      return [state, form]
    }
    return [form]
  }

  // Decode the buffered bytes in one shot (never per-chunk): a streaming or
  // rewrapped body can otherwise split a multi-byte UTF-8 character across
  // chunk boundaries (decode-req-body suite, 100k あ ≈ 300KB).
  const text = new TextDecoder('utf-8').decode(bytes)
  if (text.trim() === '') return []

  const parsed = JSON.parse(text) as unknown
  return Array.isArray(parsed) ? (parsed as unknown[]) : [parsed]
}

/**
 * Revive server-action references passed as arguments: the client encodes a
 * function arg that is itself an action as its wire id; the server swaps the
 * marker back for the live server-side function, preserving identity (an
 * action passed through the wire compares === to the module/instance action).
 */
async function reviveActionRefs(
  args: unknown[],
  resolve: (id: string) => Promise<((...a: unknown[]) => unknown) | undefined>,
): Promise<unknown[]> {
  const reviveValue = async (value: unknown): Promise<unknown> => {
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return Promise.all(value.map(reviveValue))
    const record = value as Record<string, unknown>
    if (typeof record[ARG_ACTION_MARKER] === 'string') {
      const fn = await resolve(record[ARG_ACTION_MARKER])
      if (!fn) {
        const id = String(record[ARG_ACTION_MARKER])
        console.error(
          `Failed to find Server Action "${id}". This request might be from an older or newer deployment.\n` +
            'Read more: https://nextjs.org/docs/messages/failed-to-find-server-action',
        )
        throw new UnknownActionReferenceError(id)
      }
      return fn
    }
    if (record.$$pnext_undefined === true) return undefined
    const binary = reviveBinaryMarker(record)
    if (binary !== undefined) return binary
    if (typeof record.$$pnext_date === 'string') return new Date(record.$$pnext_date)
    if (Array.isArray(record.$$pnext_map)) {
      const entries = await Promise.all(
        (record.$$pnext_map as [unknown, unknown][]).map(
          async ([k, v]) => [await reviveValue(k), await reviveValue(v)] as [unknown, unknown],
        ),
      )
      return new Map(entries)
    }
    if (Array.isArray(record.$$pnext_set)) {
      return new Set(await Promise.all((record.$$pnext_set as unknown[]).map(reviveValue)))
    }
    if (value instanceof FormData || value instanceof Blob) return value
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      return value
    }
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(record)) out[key] = await reviveValue(item)
    return out
  }
  return Promise.all(args.map(reviveValue))
}

const TYPED_ARRAY_MARKER = '$$pnext_typed_array'
const ARRAY_BUFFER_MARKER = '$$pnext_array_buffer'

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

function isTypedArrayView(value: unknown): value is ArrayBufferView {
  return ArrayBuffer.isView(value) && !(value instanceof DataView)
}

/** Deep-copy a return value, marker-encoding typed arrays / ArrayBuffers. */
function encodeBinaryReturn(value: unknown, seen = new Set<unknown>()): unknown {
  if (value === null || typeof value !== 'object') return value
  if (value instanceof ArrayBuffer) {
    return { [ARRAY_BUFFER_MARKER]: Buffer.from(new Uint8Array(value)).toString('base64') }
  }
  if (isTypedArrayView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    return {
      [TYPED_ARRAY_MARKER]: {
        type: value.constructor.name,
        data: Buffer.from(bytes).toString('base64'),
      },
    }
  }
  if (seen.has(value)) return value
  seen.add(value)
  if (Array.isArray(value)) return value.map(item => encodeBinaryReturn(item, seen))
  const proto = Object.getPrototypeOf(value) as object | null
  if (proto !== Object.prototype && proto !== null) return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = encodeBinaryReturn(item, seen)
  }
  return out
}

/** Revive a typed-array / ArrayBuffer wire marker back into a live view, else undefined. */
function reviveBinaryMarker(record: Record<string, unknown>): unknown {
  const typed = record[TYPED_ARRAY_MARKER]
  if (typed && typeof typed === 'object') {
    const { type, data } = typed as { type?: string; data?: string }
    const Ctor = type ? TYPED_ARRAY_CTORS[type] : undefined
    if (Ctor && typeof data === 'string') {
      const bytes = Buffer.from(data, 'base64')
      return new Ctor(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    }
  }
  const buffer = record[ARRAY_BUFFER_MARKER]
  if (typeof buffer === 'string') {
    const bytes = Buffer.from(buffer, 'base64')
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  }
  return undefined
}

class UnknownActionReferenceError extends Error {
  constructor(public actionId: string) {
    super(`Server Action "${actionId}" was not found on the server.`)
  }
}

function decodeStructuredArgs(argsJson: string, form: FormData): unknown[] {
  const parsed = JSON.parse(argsJson) as unknown
  const list = Array.isArray(parsed) ? (parsed as unknown[]) : [parsed]
  return list.map(item => reviveArg(item, form))
}

function reviveArg(value: unknown, form: FormData): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(item => reviveArg(item, form))

  const record = value as Record<string, unknown>
  if (typeof record[ARG_FORMDATA_MARKER] === 'number') {
    const slot = record[ARG_FORMDATA_MARKER]
    const prefix = `${ARG_FORMDATA_PREFIX}${slot}:`
    const data = new FormData()
    for (const [key, item] of form.entries()) {
      if (key.startsWith(prefix)) data.append(key.slice(prefix.length), item as string | Blob)
    }
    return data
  }
  if (typeof record[ARG_FILE_MARKER] === 'number') {
    const slot = record[ARG_FILE_MARKER]
    return form.get(`${ARG_FILE_PREFIX}${slot}`)
  }

  const revived: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(record)) revived[key] = reviveArg(item, form)
  return revived
}

function redirectResponse(error: PNextRedirectError, refresh: boolean): Response {
  const redirectType = (error as PNextRedirectError & { redirectType?: string }).redirectType
  // 303: fetch() does not follow 307/308 the way a browser follows a nav, and
  // a no-JS form submit needs the browser to follow with a GET. The redirect
  // marker header lets the client runtime treat this as a framework redirect
  // (soft-navigable) rather than an opaque HTTP redirect.
  const headers = new Headers({
    location: error.location,
    [ACTION_REDIRECT_HEADER]: error.location,
  })
  if (redirectType === 'replace') headers.set(REDIRECT_TYPE_HEADER, 'replace')
  setRefreshHeaders(headers, refresh)
  return new Response(null, { status: 303, headers })
}

function setRefreshHeaders(headers: Headers, refresh: boolean): void {
  if (!refresh) return
  headers.set(ACTION_REFRESH_HEADER, '1')
  headers.set(NEXT_ACTION_REVALIDATED_HEADER, '1')
}

function errorResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

/** Merge scope-collected headers (set-cookie appends) onto the response. */
function withResponseHeaders(response: Response, extra: Headers): Response {
  const setCookies = (extra as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
  if (setCookies.length === 0) return response
  for (const cookie of setCookies) response.headers.append('set-cookie', cookie)
  return response
}

function hasSetCookie(headers: Headers): boolean {
  return headers.has('set-cookie')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
