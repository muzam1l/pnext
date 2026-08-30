/**
 * The dispatch half of the client action runtime: argument encoding, the POST wire, redirect/refresh/
 * error semantics, action-return revival, and the route error.js overlay body. Nothing here can run
 * before an action actually fires, so client.ts reaches it through a dynamic import() and this
 * whole module lands in a deferred chunk.
 *
 * Wire shape (see compat/actions/protocol.ts): POST to the CURRENT page URL with the action id in the
 * `next-action` header. JSON-safe args go as a text/plain JSON array; a single FormData argument posts
 * as multipart; mixed args post as multipart with a JSON args field referencing file slots.
 *
 * Responses: `{ data }` JSON on success; `{ redirect }` JSON for framework redirects (soft-navigated
 * here); text/plain bodies are thrown as Errors (masked in prod, like Next); any other error
 * content-type throws the "unexpected response" error React shows; a 404 with the not-found marker
 * swaps in the server-rendered 404 page.
 */
import { h, render, type ComponentType } from 'preact'
import {
  blockJavascriptUrl,
  evictClientRouterCache,
  rearmVisiblePrefetches,
  softNavigate,
} from '../../client/router'
import { onNavigationStart } from '../../client/router/events'
import { UnrecognizedActionError } from './unrecognized-error'
import {
  ACTION_ID_FIELD,
  ARRAY_BUFFER_MARKER,
  FORM_STATE_FIELD,
  SUBMIT_ACTION_ID_FIELD,
  TYPED_ARRAY_MARKER,
  actionReturnClientReferences,
  reviveBinaryMarker,
  tagActionError,
  type ActionFunction,
} from './shared'

const ACTION_ID_HEADER = 'next-action'
const ACTION_REDIRECT_HEADER = 'x-action-redirect'
const ACTION_REFRESH_HEADER = 'x-pnext-action-refresh'
const NEXT_ACTION_REVALIDATED_HEADER = 'x-action-revalidated'
const ACTION_NOT_FOUND_HEADER = 'x-pnext-action-not-found'
const NEXT_ACTION_NOT_FOUND_HEADER = 'x-nextjs-action-not-found'
const ACTION_ERROR_DIGEST_HEADER = 'x-pnext-action-error-digest'
const ACTION_FLIGHT_CONTENT_TYPE = 'text/x-component'
const ACTION_ARGS_FIELD = '$pnext_args'
const ARG_FORMDATA_MARKER = '$$pnext_fd'
const ARG_FILE_MARKER = '$$pnext_file'
const ARG_FORMDATA_PREFIX = '$pnext_fd_'
const ARG_FILE_PREFIX = '$pnext_file_'
const ARG_ACTION_MARKER = '$$pnext_action_ref'
const REDIRECT_TYPE_HEADER = 'x-pnext-redirect-type'
const TEMP_REF_MARKER = '$$pnext_temp_ref'
const ACTION_STREAM_CONTENT_TYPE = 'x-component/pnext-stream'
const ACTION_ELEMENT_MARKER = '$$pnext_element'
const ACTION_ELEMENT_HTML_MARKER = '$$pnext_element_html'

const MASKED_ACTION_ERROR =
  'Minified React error #441; visit https://react.dev/errors/441 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.'
const UNEXPECTED_RESPONSE = 'An unexpected response was received from the server.'

// Only compared within a single dispatch, so starting the count when this
// module loads (rather than at page load) changes nothing.
let clientNavigationGeneration = 0
onNavigationStart(() => {
  clientNavigationGeneration += 1
})

interface ActionFlightPayload {
  a?: unknown
  f?: { kind?: string; html?: string; url?: string } | ''
}

// ---------------------------------------------------------------------------
// argument encoding
// ---------------------------------------------------------------------------

function isPlainSerializable(value: unknown, depth = 0): boolean {
  if (value === null || value === undefined) return true
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean') return true
  if (type !== 'object') return false
  if (depth > 32) return false
  if (isBinary(value)) return true // marker-encoded on the wire
  if (Array.isArray(value)) return value.every(item => isPlainSerializable(item, depth + 1))
  if (value instanceof FormData || isFileLike(value)) return false // handled by caller
  if (value instanceof Date) return true
  if (typeof (value as PromiseLike<unknown>).then === 'function') return true
  if (value instanceof Map) {
    return [...value.entries()].every(
      ([k, v]) => isPlainSerializable(k, depth + 1) && isPlainSerializable(v, depth + 1),
    )
  }
  if (value instanceof Set) return [...value].every(item => isPlainSerializable(item, depth + 1))
  const proto = Object.getPrototypeOf(value) as object | null
  if (proto !== Object.prototype && proto !== null) return false
  return Object.values(value as Record<string, unknown>).every(item =>
    isPlainSerializable(item, depth + 1),
  )
}

function isFileLike(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob
}

function isBinary(value: unknown): value is ArrayBufferView | ArrayBuffer {
  return value instanceof ArrayBuffer || (ArrayBuffer.isView(value) && !(value instanceof DataView))
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
  }
  return Buffer.from(bytes).toString('base64')
}

function encodeBinaryValue(value: ArrayBufferView | ArrayBuffer): unknown {
  if (value instanceof ArrayBuffer) {
    return { [ARRAY_BUFFER_MARKER]: bytesToBase64(new Uint8Array(value)) }
  }
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return { [TYPED_ARRAY_MARKER]: { type: value.constructor.name, data: bytesToBase64(bytes) } }
}

function containsSpecial(value: unknown): boolean {
  if (value instanceof FormData || isFileLike(value)) return true
  if (Array.isArray(value)) return value.some(containsSpecial)
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsSpecial)
  }
  return false
}

function isActionReference(value: unknown): value is ActionFunction {
  return (
    typeof value === 'function' && typeof (value as ActionFunction).$$pnextActionId === 'string'
  )
}

/**
 * Encode non-JSON argument values React's wire supports: server-action
 * references (fn identity travels as its wire id), Dates, Maps, Sets,
 * undefined, and promises (awaited, like React's encodeReply).
 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value) && typeof (value as PromiseLike<unknown>).then === 'function'
}

async function encodeSpecialValues(value: unknown): Promise<unknown> {
  if (isActionReference(value)) return { [ARG_ACTION_MARKER]: value.$$pnextActionId }
  if (value === undefined) return { $$pnext_undefined: true }
  if (isBinary(value)) return encodeBinaryValue(value)
  if (value instanceof Date) return { $$pnext_date: value.toISOString() }
  if (isThenable(value)) {
    return encodeSpecialValues(await value)
  }
  if (value instanceof Map) {
    return {
      $$pnext_map: await Promise.all(
        [...value.entries()].map(async ([k, v]) => [
          await encodeSpecialValues(k),
          await encodeSpecialValues(v),
        ]),
      ),
    }
  }
  if (value instanceof Set) {
    return { $$pnext_set: await Promise.all([...value].map(encodeSpecialValues)) }
  }
  if (Array.isArray(value)) return Promise.all(value.map(encodeSpecialValues))
  if (
    value !== null &&
    typeof value === 'object' &&
    !(value instanceof FormData) &&
    !isFileLike(value)
  ) {
    const proto = Object.getPrototypeOf(value) as object | null
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        out[key] = await encodeSpecialValues(item)
      }
      return out
    }
  }
  return value
}

function assertSerializableArg(value: unknown) {
  if (value instanceof FormData || isFileLike(value)) return
  if (isActionReference(value)) return
  if (isPlainSerializable(value)) return
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const dev = typeof process !== 'undefined' && process.env.NODE_ENV !== 'production'
  throw tagActionError(
    new Error(
      dev
        ? 'Cannot access value on the server. Only plain objects can be passed to Server Actions from Client Components.'
        : MASKED_ACTION_ERROR,
    ),
  )
}

interface EncodedBody {
  body: BodyInit | undefined
  contentType?: string
}

/**
 * Temporary references (Next compat): stamp each plain-object node in the args with a unique id and
 * remember id -> original object, so an action returning that same object serializes back to a marker
 * the client swaps for the IDENTICAL reference. Mutates a shallow marker key onto the wire objects
 * only, never the caller's originals, and the returned map resolves markers on the response.
 */
function tagTempRefs(originals: unknown[], encoded: unknown[]): Map<string, object> {
  const registry = new Map<string, object>()
  let counter = 0
  const seen = new Set<unknown>()
  const walk = (original: unknown, wire: unknown): void => {
    if (
      original === null ||
      typeof original !== 'object' ||
      wire === null ||
      typeof wire !== 'object'
    ) {
      return
    }
    if (seen.has(wire)) return
    seen.add(wire)
    if (Array.isArray(original) && Array.isArray(wire)) {
      for (let i = 0; i < wire.length; i++) walk(original[i], wire[i])
      return
    }
    const proto = Object.getPrototypeOf(original) as object | null
    if (proto !== Object.prototype && proto !== null) return
    const id = `t${counter++}`
    registry.set(id, original)
    ;(wire as Record<string, unknown>)[TEMP_REF_MARKER] = id
    for (const key of Object.keys(original)) {
      walk((original as Record<string, unknown>)[key], (wire as Record<string, unknown>)[key])
    }
  }
  for (let i = 0; i < encoded.length; i++) walk(originals[i], encoded[i])
  return registry
}

// Temp-ref revival is folded into reviveActionReturn's single walk: a marker
// hit must return the caller's ORIGINAL object untouched, so no later pass may
// clone it (a follow-up structural copy would silently break `===` identity —
// the temporary-references contract).

/**
 * Revive an action return in ONE walk: temporary references swap back to the caller's original objects
 * (returned as-is - any further cloning would break the `===` identity), client-component element
 * markers become live vnodes, and binary markers become typed arrays.
 */
function reviveActionReturn(value: unknown, tempRefs?: Map<string, object>): unknown {
  const walk = (input: unknown): unknown => {
    if (input === null || typeof input !== 'object') return input
    if (Array.isArray(input)) return input.map(walk)
    const record = input as Record<string, unknown>
    const tempId = record[TEMP_REF_MARKER]
    if (typeof tempId === 'string' && tempRefs?.has(tempId)) return tempRefs.get(tempId)
    const binary = reviveBinaryMarker(record)
    if (binary !== undefined) return binary
    // A server-rendered element tree the action returned (host elements / async
    // server components): revive it into a renderable node whose innerHTML is
    // the server markup, so useActionState can drop it straight into the tree.
    const elementHtml = record[ACTION_ELEMENT_HTML_MARKER]
    if (typeof elementHtml === 'string') {
      return h('span', { dangerouslySetInnerHTML: { __html: elementHtml } })
    }
    const encoded = record[ACTION_ELEMENT_MARKER]
    if (encoded && typeof encoded === 'object') {
      const { id, props, key } = encoded as { id?: unknown; props?: unknown; key?: unknown }
      const component = typeof id === 'string' ? actionReturnClientReferences.get(id) : undefined
      if (!component) {
        throw tagActionError(
          new Error(`Missing client component reference for action return: ${String(id)}`),
        )
      }
      const revivedProps = walk(props)
      const componentProps =
        revivedProps && typeof revivedProps === 'object'
          ? (revivedProps as Record<string, unknown>)
          : {}
      return h(component, key === undefined ? componentProps : { ...componentProps, key })
    }
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(record)) out[key] = walk(item)
    return out
  }
  return walk(value)
}

async function encodeArgs(
  rawArgs: unknown[],
): Promise<EncodedBody & { tempRefs?: Map<string, object> }> {
  if (rawArgs.length === 0) return { body: '[]', contentType: 'text/plain;charset=UTF-8' }
  for (const arg of rawArgs) assertSerializableArg(arg)
  const args = await Promise.all(rawArgs.map(encodeSpecialValues))

  // The common form shape: exactly one FormData argument posts as-is.
  if (args.length === 1 && args[0] instanceof FormData) {
    return { body: stripActionFields(args[0]) }
  }

  if (!args.some(containsSpecial)) {
    const tempRefs = tagTempRefs(rawArgs, args)
    return { body: JSON.stringify(args), contentType: 'text/plain;charset=UTF-8', tempRefs }
  }

  // Mixed args: multipart with a JSON descriptor referencing part slots.
  const form = new FormData()
  let formDataSlots = 0
  let fileSlots = 0
  const encoded = args.map(arg => {
    if (arg instanceof FormData) {
      const slot = formDataSlots++
      for (const [key, item] of stripActionFields(arg).entries()) {
        form.append(`${ARG_FORMDATA_PREFIX}${slot}:${key}`, item)
      }
      return { [ARG_FORMDATA_MARKER]: slot }
    }
    if (isFileLike(arg)) {
      const slot = fileSlots++
      form.append(`${ARG_FILE_PREFIX}${slot}`, arg)
      return { [ARG_FILE_MARKER]: slot }
    }
    return arg
  })
  form.append(ACTION_ARGS_FIELD, JSON.stringify(encoded))
  return { body: form }
}

function stripActionFields(form: FormData): FormData {
  if (
    !form.has(ACTION_ID_FIELD) &&
    !form.has(SUBMIT_ACTION_ID_FIELD) &&
    !form.has(FORM_STATE_FIELD)
  )
    return form
  const stripped = new FormData()
  for (const [key, item] of form.entries()) {
    if (key !== ACTION_ID_FIELD && key !== SUBMIT_ACTION_ID_FIELD && key !== FORM_STATE_FIELD)
      stripped.append(key, item)
  }
  return stripped
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

export async function callAction(id: string, args: unknown[]): Promise<unknown> {
  if (typeof Event !== 'undefined' && args.at(-1) instanceof Event) args = args.slice(0, -1)
  const navigationGenerationAtDispatch = clientNavigationGeneration
  const { body, contentType, tempRefs } = await encodeArgs(args)
  // accept mirrors Next's flight wire; app code observes it via headers().
  const headers: Record<string, string> = {
    [ACTION_ID_HEADER]: id,
    accept: 'text/x-component',
  }
  if (contentType) headers['content-type'] = contentType

  let response: Response
  try {
    response = await fetch(location.href, { method: 'POST', headers, body })
  } catch (error) {
    throw tagActionError(error)
  }

  // notFound() thrown inside the action: swap in the server-rendered 404 page.
  if (response.status === 404 && response.headers.get(ACTION_NOT_FOUND_HEADER)) {
    await swapDocument(response)
    return undefined
  }

  // Version skew: the server did not recognize the action id. React routes this
  // to the nearest error boundary as a typed UnrecognizedActionError (so
  // unstable_isUnrecognizedActionError catches it), NOT a page swap — the 404
  // body here is a plain text/plain message, not renderable HTML.
  if (response.status === 404 && response.headers.get(NEXT_ACTION_NOT_FOUND_HEADER) === '1') {
    const message = await response.text().catch(() => '')
    throw tagActionError(
      new UnrecognizedActionError(
        message ||
          `Server Action "${id}" was not found on the server. \nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action`,
      ),
    )
  }

  // Single-pass redirect: a 303 with no Location (fetch would have followed
  // one) carrying the destination page HTML. Push history and swap the
  // document — no follow-up request.
  if (response.status === 303) {
    const rearm = hasActionRevalidated(response) ? deferActionPrefetches() : undefined
    try {
      const target = response.headers.get(ACTION_REDIRECT_HEADER)
      if (target && blockJavascriptUrl(target)) return undefined
      const contentType = response.headers.get('content-type') ?? ''
      const replace = response.headers.get(REDIRECT_TYPE_HEADER) === 'replace'
      // Single-pass flight redirect: the 303 carries the destination page HTML in
      // the flight envelope. Push history and swap the document in one round trip.
      if (target && contentType.includes(ACTION_FLIGHT_CONTENT_TYPE)) {
        const payload = await readActionFlightPayload(response)
        const flightHtml = payloadHtml(payload)
        if (flightHtml) {
          await replaceDocument(flightHtml, target, replace, hasActionRevalidated(response))
          return undefined
        }
        await navigate(target, replace)
        return undefined
      }
      if (target && contentType.includes('text/html')) {
        const html = await response.text()
        await replaceDocument(html, target, replace, hasActionRevalidated(response))
        return undefined
      }
      if (target) {
        await navigate(target, replace)
        return undefined
      }
    } finally {
      rearm?.()
    }
  }

  if (!response.ok) {
    const responseContentType = response.headers.get('content-type') ?? ''
    if (responseContentType.startsWith('text/plain')) {
      const error = new Error(await response.text()) as Error & { digest?: string }
      // The masked prod body hides the message; the digest rides a header so a
      // caught action error still exposes `error.digest` (Next parity).
      const digest = response.headers.get(ACTION_ERROR_DIGEST_HEADER)
      if (digest) error.digest = digest
      throw tagActionError(error)
    }
    throw tagActionError(new Error(UNEXPECTED_RESPONSE))
  }

  const responseContentType = response.headers.get('content-type') ?? ''
  // A streamed action return (actions-streaming): the body IS a ReadableStream
  // the caller reads with getReader(). Return it live, unbuffered.
  if (responseContentType.includes(ACTION_STREAM_CONTENT_TYPE)) {
    if (hasActionRevalidated(response)) {
      const rearm = deferActionPrefetches()
      void refresh().finally(rearm)
    }
    return response.body
  }
  if (responseContentType.includes(ACTION_FLIGHT_CONTENT_TYPE)) {
    const payload = await readActionFlightPayload(response)
    const revalidated = hasActionRevalidated(response)
    const discarded = clientNavigationGeneration !== navigationGenerationAtDispatch
    const rearm = revalidated ? deferActionPrefetches() : undefined
    try {
      const target = response.headers.get(ACTION_REDIRECT_HEADER)
      if (target && blockJavascriptUrl(target)) return undefined
      const replace = response.headers.get(REDIRECT_TYPE_HEADER) === 'replace'
      const flightHtml = payloadHtml(payload)
      if (target && flightHtml) {
        await replaceDocument(flightHtml, target, replace, revalidated)
        return undefined
      }
      // A completed action's value must reach client state. If navigation
      // superseded it, that value is discarded, so refresh the now-current route.
      if (revalidated && discarded) {
        await refresh()
      } else if (revalidated && flightHtml && payload.a === undefined) {
        await replaceDocument(flightHtml)
      } else if (revalidated) {
        // Revalidation always re-renders the current route (Next applies the
        // revalidated flight even when the action returned a value). No
        // embedded HTML to swap in — refresh through the soft-nav pipeline so
        // every active parallel slot (intercepted modals included) refetches.
        await refresh()
      }
      return reviveActionReturn(payload.a, tempRefs)
    } finally {
      rearm?.()
    }
  }
  if (!responseContentType.includes('application/json')) {
    throw tagActionError(new Error(UNEXPECTED_RESPONSE))
  }

  const revalidated = hasActionRevalidated(response)
  const rearm = revalidated ? deferActionPrefetches() : undefined
  try {
    const payload = (await response.json()) as { data?: unknown; redirect?: string }
    if (typeof payload.redirect === 'string') {
      if (blockJavascriptUrl(payload.redirect)) return undefined
      await navigate(payload.redirect, response.headers.get(REDIRECT_TYPE_HEADER) === 'replace')
      return undefined
    }
    // Revive binary, temporary-reference, and client-component element markers.
    const data = reviveActionReturn(payload.data, tempRefs)
    // Revalidation always re-renders the current route, even when the action
    // returned a value (Next parity: revalidatePath/Tag in an action refreshes
    // every active parallel slot, intercepted modals included).
    if (revalidated) await refresh()
    return data
  } finally {
    rearm?.()
  }
}

function deferActionPrefetches(): () => void {
  // The eviction and the later re-arm both queue behind the router runtime's
  // single load promise, so they still land in this order.
  void evictClientRouterCache({ rearmVisiblePrefetches: false })
  return rearmVisiblePrefetches
}

/**
 * Count of action dispatches that ended in a framework redirect. The
 * useActionState shim uses it to restore initial state in a preserved layout.
 */
function markActionRedirected(): void {
  const holder = globalThis as { __pnextActionRedirects?: number }
  holder.__pnextActionRedirects = (holder.__pnextActionRedirects ?? 0) + 1
}

async function navigate(href: string, replace = false) {
  markActionRedirected()
  const url = new URL(href, location.href)
  if (url.origin !== location.origin) {
    location.assign(url.href)
    return
  }
  try {
    await softNavigate(url.href, replace ? { replace: true } : undefined)
  } catch (error) {
    // A router failure must never strand an action redirect on the old page —
    // fall back to a full browser navigation (Next's MPA fallback shape).
    console.error(error)
    if (replace) location.replace(url.href)
    else location.assign(url.href)
  }
}

async function refresh() {
  try {
    await softNavigate(location.href, { replace: true, scroll: false })
  } catch (error) {
    // A failed refresh must not reject the dispatch: the action's return value
    // still has to reach the caller (the refresh is a best-effort re-render).
    console.error(error)
  }
}

async function swapDocument(response: Response) {
  const html = await response.text()
  // Next renders an action's notFound() in place, so a robots meta the page
  // itself declared survives it. Our swap rewrites the document: carry the live
  // tag over, replacing the server's fallback noindex when one was injected.
  const robots = document.querySelector('meta[name="robots"]')?.outerHTML
  const pattern = /<meta[^>]+name=["']robots["'][^>]*\/?>/i
  const withRobots = robots
    ? pattern.test(html)
      ? html.replace(pattern, robots)
      : html.replace('</head>', `${robots}</head>`)
    : html
  await replaceDocument(withRobots)
}

/**
 * `freshSegments`: the action revalidated, so this HTML is the freshly rendered destination - its
 * layouts carry the write and must replace the live ones instead of being grafted over.
 */
async function replaceDocument(
  html: string,
  href?: string,
  replace = false,
  freshSegments = false,
) {
  if (href) {
    markActionRedirected()
    // Route the single-pass redirect's destination HTML through the normal
    // soft-nav pipeline (as a "cached page" so it skips the fetch) instead of
    // `document.write`-ing a whole new document. `document.write` resets the
    // document but NOT the JS module registry/global scope: in production
    // every route shares one router.ts module instance (see the file-top
    // comment), so a raw `history.pushState(null, ...)` here left the
    // in-memory history bookkeeping (entry ids, the entry-document cache used
    // to restore back/forward without a round trip) out of sync with the new
    // entry, breaking back navigation after an action redirect. softNavigate
    // keeps that bookkeeping consistent and still swaps the whole page (no
    // rootLayoutChanged bailout expected here since the target is
    // same-origin/same-app, per the single-pass redirect's own guarantee).
    try {
      await softNavigate(href, {
        replace,
        cachedPage: { html: actionRedirectPage(html), finalUrl: href, ok: true },
        ...(freshSegments ? { freshSegments: true } : {}),
      })
    } catch (error) {
      // Single-pass redirect swap failed in the router: land on the target
      // with a full navigation rather than stranding the user (and the test's
      // waitForElementByCss) on the origin page.
      console.error(error)
      if (replace) location.replace(new URL(href, location.href).href)
      else location.assign(new URL(href, location.href).href)
    }
    return
  }
  document.open()
  document.write(html)
  document.close()
}

function actionRedirectPage(html: string): string {
  // A server-only destination does not need its route entry. Avoid importing
  // it so the inline action flight remains the redirect's only request.
  if (/<pnext-client(?:\s|>)/.test(html) || html.includes('<!--pnext-client:')) return html
  const entryScript =
    /\s*<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["'][^"']*-pnext-client\.js["'][^>]*><\/script>/gi
  return html.replace(entryScript, '')
}

async function readActionFlightPayload(response: Response): Promise<ActionFlightPayload> {
  try {
    const parsed = JSON.parse(await response.text()) as unknown
    return isActionFlightPayload(parsed) ? parsed : {}
  } catch {
    throw tagActionError(new Error(UNEXPECTED_RESPONSE))
  }
}

function isActionFlightPayload(value: unknown): value is ActionFlightPayload {
  return value !== null && typeof value === 'object'
}

function payloadHtml(payload: ActionFlightPayload): string | undefined {
  const flight = payload.f
  if (!flight || typeof flight !== 'object') return undefined
  return flight.kind === 'pnext-html' && typeof flight.html === 'string' ? flight.html : undefined
}

function hasActionRevalidated(response: Response): boolean {
  return (
    response.headers.has(ACTION_REFRESH_HEADER) ||
    response.headers.has(NEXT_ACTION_REVALIDATED_HEADER)
  )
}

// ---------------------------------------------------------------------------
// error boundary overlay body (route error.js support for action failures)
// ---------------------------------------------------------------------------

type ErrorComponentType = ComponentType<{ error: Error; reset: () => void }>

interface HiddenElement extends HTMLElement {
  __pnextPrevDisplay?: string
}

let overlayRoot: HTMLElement | null = null

/**
 * Hide the page and render the route's error component over it. Callers
 * serialize their calls (client.ts chains them), so the `overlayRoot` guard
 * still holds across the dynamic import that reaches this module.
 */
export function showActionErrorOverlay(Component: ErrorComponentType, reason: unknown) {
  if (overlayRoot) return
  const error = reason instanceof Error ? reason : new Error(String(reason))
  const hidden: HiddenElement[] = []
  overlayRoot = document.createElement('div')
  for (const child of [...document.body.children]) {
    if (!(child instanceof HTMLElement)) continue
    if (child.tagName === 'SCRIPT') continue
    const element = child as HiddenElement
    element.__pnextPrevDisplay = element.style.display
    element.style.display = 'none'
    hidden.push(element)
  }
  document.body.appendChild(overlayRoot)
  const reset = () => {
    if (!overlayRoot) return
    render(null, overlayRoot)
    overlayRoot.remove()
    overlayRoot = null
    for (const element of hidden) element.style.display = element.__pnextPrevDisplay ?? ''
    void refresh()
  }
  render(h(Component, { error, reset }), overlayRoot)
}
