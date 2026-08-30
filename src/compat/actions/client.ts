/**
 * Client-side server-action runtime (Next compat) - the INITIAL half. Installed once per page by the
 * client entry as `window.__PNEXT_ACTIONS__`; the per-module generated stubs and the form-submit
 * interception below both dispatch through it.
 *
 * Only what must exist before the user can interact lives here: the DOM listeners, the
 * `<form action={fn}>` vnode hook, progressive-form enhancement, and synchronous island-prop revival.
 * Everything that can only run once an action has fired - argument encoding, the POST wire,
 * redirect/refresh/error semantics, action-return revival, the error overlay body - lives in
 * dispatch.ts and is reached through import(), so it rides a deferred chunk whose fetch
 * overlaps the action's own round trip.
 */
import { options as preactOptions, type ComponentType, type VNode } from 'preact'
import { __pnextPushFormStatus } from '../react/dom'
import {
  ACTION_ID_FIELD,
  FORM_STATE_FIELD,
  SUBMIT_ACTION_ID_FIELD,
  actionReturnClientReferences,
  isActionError,
  reviveBinaryMarker,
  type ActionFunction,
} from './shared'

// Out-of-band carrier for a plain server-action form's id once the client
// runtime is up. React strips the progressive `$ACTION_ID` hidden inputs from a
// form's DOM on hydration; a SERVER-component form (not preact-managed) keeps
// its SSR hidden input forever, so after a soft-nav commit the committed
// `form.innerHTML` leaks `<input name="$pnext_action_id" ...>`. We move the id
// to this attribute and drop the hidden input (see stripProgressiveActionIds),
// keeping submission working via the fallbacks that read it.
const ACTION_ID_ATTR = 'data-pnext-action-id'
const PROP_ACTION_MARKER = '$$pnextAction'
const ACTION_CLICK_ID_ATTR = 'data-pnext-action-click'
const PROP_ERROR_RESET_MARKER = '$$pnextErrorReset'

export { isActionError }

// ---------------------------------------------------------------------------
// dispatch entry point (the wire itself is deferred)
// ---------------------------------------------------------------------------

// Deferring the dispatch chunk is the point of this split, but deferring it to the CLICK puts its
// `import()` between the click and the POST - a task hop, not a microtask, so even a
// fetched-and-evaluated chunk lands behind the frame and a driver reading the DOM the instant
// `click()` resolves sees no request. Warm on `pnext:hydrated` and remember the entry point, so the
// warm call is a microtask that drains in the click's own task.
const dispatchRuntime = () => import('./dispatch')

let warmDispatch: ((id: string, args: unknown[]) => Promise<unknown>) | undefined

const loadDispatch = () => dispatchRuntime().then(module => (warmDispatch = module.callAction))

// Warming is speculative: offline (or any failed chunk fetch) must not surface as an unhandled
// rejection, which the client error last-resort escalates to the global-error document. A real
// action call still awaits - and rejects through - loadDispatch.
const warmDispatchChunk = () => {
  void loadDispatch().catch(() => undefined)
}

function callAction(id: string, args: unknown[]): Promise<unknown> {
  return warmDispatch ? warmDispatch(id, args) : loadDispatch().then(call => call(id, args))
}

function registerClientReference(
  id: string,
  component: ComponentType<Record<string, unknown>>,
): void {
  actionReturnClientReferences.set(id, component)
}

// ---------------------------------------------------------------------------
// props revival (server-action references serialized into island props)
// ---------------------------------------------------------------------------

function reviveProps<T>(value: T): T {
  return reviveValue(value) as T
}

function reviveValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(reviveValue)
  const record = value as Record<string, unknown>
  const error = reviveErrorMarker(record)
  if (error) return error
  if (record[PROP_ERROR_RESET_MARKER] === true) return refreshCurrentRoute
  if (typeof record[PROP_ACTION_MARKER] === 'string') {
    return createAction(record[PROP_ACTION_MARKER])
  }
  const binary = reviveBinaryMarker(record)
  if (binary !== undefined) return binary
  const revived: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(record)) revived[key] = reviveValue(item)
  return revived
}

function reviveErrorMarker(record: Record<string, unknown>): Error | undefined {
  const marker = record.$$pnextError
  if (marker === null || typeof marker !== 'object') return undefined
  const data = marker as Record<string, unknown>
  const error = new Error(typeof data.message === 'string' ? data.message : '')
  if (typeof data.name === 'string') error.name = data.name
  if (typeof data.digest === 'string') (error as Error & { digest?: string }).digest = data.digest
  return error
}

function refreshCurrentRoute(): void {
  location.reload()
}

function createAction(id: string): ActionFunction {
  const action: ActionFunction = async (...args: unknown[]) => callAction(id, args)
  action.$$pnextActionId = id
  return action
}

// ---------------------------------------------------------------------------
// <form action={fn}> interception (preact has no function-action support)
// ---------------------------------------------------------------------------

interface ActionDomNode extends Element {
  __pnextFormAction?: (formData: FormData) => unknown
}

// ---------------------------------------------------------------------------
// pre-hydration submit replay
// ---------------------------------------------------------------------------

/**
 * A submission the inline early-capture script (compat/actions/early-submit.ts)
 * queued before this runtime loaded: the FormData snapshot taken at submit
 * time (including the submitter's pair) parked on the form node.
 */
interface QueuedSubmission {
  data: FormData
  submitter: ActionDomNode | null
}

interface QueuedForm extends HTMLFormElement {
  __pnextQueuedSubmit?: QueuedSubmission
}

function takeQueuedSubmission(form: HTMLFormElement): QueuedSubmission | undefined {
  const queued = (form as QueuedForm).__pnextQueuedSubmit
  if (queued) delete (form as QueuedForm).__pnextQueuedSubmit
  return queued
}

/** Dispatch a captured submission with form-status + post-action reset (the
 * same tail the live submit listener runs). */
function runFormSubmission(
  form: HTMLFormElement,
  formData: FormData,
  dispatch: (formData: FormData) => unknown,
): void {
  const pop = pushFormStatus(form, formData)
  void Promise.resolve(dispatch(formData))
    .then(() => {
      // React resets uncontrolled fields after a completed form action.
      form.reset()
    })
    .catch(error => {
      if (!throwActionErrorAt(form, error)) throw error
    })
    .finally(pop)
}

function throwActionErrorAt(node: Element, error: unknown): boolean {
  const root = node.closest('pnext-client')
  const rootVNode = (root as unknown as { __k?: VNode } | null)?.__k
  const vnode = rootVNode ? findVNodeForElement(rootVNode, node) : undefined
  const handler = (
    preactOptions as typeof preactOptions & {
      __e?: (error: unknown, vnode: VNode, oldVNode: VNode) => void
    }
  ).__e
  if (!vnode || !handler) return false
  handler(error, vnode, vnode)
  return true
}

function findVNodeForElement(vnode: VNode, element: Element): VNode | undefined {
  if ((vnode as VNode & { __e?: unknown }).__e === element) return vnode
  const children = (vnode as VNode & { __k?: (VNode | null)[] }).__k
  if (!children) return undefined
  for (const child of children) {
    if (!child) continue
    const found = findVNodeForElement(child, element)
    if (found) return found
  }
  return undefined
}

/** Replay a pre-hydration submission the moment the form's function action
 * hydrates (called from the stashed ref below). */
function replayQueuedSubmission(form: HTMLFormElement, fn: (formData: FormData) => unknown): void {
  const queued = takeQueuedSubmission(form)
  if (queued) runFormSubmission(form, queued.data, fn)
}

/**
 * Take over from the inline early-capture script: stop capturing (the live submit listener is
 * installed now) and, after hydration has had a chance to claim queued forms via their refs, dispatch
 * whatever remains - server-only progressive forms via the id fields, and anything unclaimed falls
 * back to the native submit the capture prevented.
 */
function adoptEarlySubmissions(): void {
  const holder = window as typeof window & {
    __pnextEarlySubmits?: HTMLFormElement[]
    __pnextRemoveEarlySubmit?: () => void
  }
  holder.__pnextRemoveEarlySubmit?.()
  const forms = holder.__pnextEarlySubmits
  if (!forms?.length) return
  const flush = () => {
    for (const form of forms.splice(0)) {
      const queued = takeQueuedSubmission(form)
      if (!queued) continue // hydration replayed it already
      const stashed =
        queued.submitter?.__pnextFormAction ?? (form as unknown as ActionDomNode).__pnextFormAction
      if (stashed) {
        runFormSubmission(form, queued.data, stashed)
        continue
      }
      const submitterId =
        queued.submitter?.getAttribute('name') === SUBMIT_ACTION_ID_FIELD
          ? queued.submitter.getAttribute('value')
          : null
      const id =
        submitterId ??
        form.querySelector<HTMLInputElement>(`input[name="${cssEscape(ACTION_ID_FIELD)}"]`)
          ?.value ??
        form.getAttribute(ACTION_ID_ATTR) ??
        undefined
      const hasFormState = Boolean(
        form.querySelector(`input[name="${cssEscape(FORM_STATE_FIELD)}"]`),
      )
      if (id && !hasFormState) {
        // Server-only progressive form (no live state to update): dispatch the
        // RPC directly, like the live listener's unhydrated-form branch.
        runFormSubmission(form, queued.data, formData => callAction(id, [formData]))
      } else if (form.isConnected) {
        // A useActionState form whose island never hydrated (or an unknown
        // shape): give it the native progressive POST the capture prevented.
        form.submit()
      }
    }
  }
  // Islands hydrate asynchronously after this runtime installs; give their
  // refs (replayQueuedSubmission) first claim before falling back.
  setTimeout(flush, 300)
}

type FunctionActionProps = Record<string, unknown> & {
  action?: unknown
  formAction?: unknown
  ref?: unknown
}

function installVNodeHook() {
  const previous = preactOptions.vnode?.bind(preactOptions)
  preactOptions.vnode = (vnode: VNode) => {
    previous?.(vnode)
    if (typeof vnode.type !== 'string') return
    const props = vnode.props as FunctionActionProps
    if (vnode.type === 'form' && typeof props.action === 'function') {
      stashFunctionAction(vnode, props, 'action')
    }
    if (
      (vnode.type === 'button' || vnode.type === 'input') &&
      typeof props.formAction === 'function'
    ) {
      stashFunctionAction(vnode, props, 'formAction')
    }
  }
}

/**
 * Replace a function action/formAction prop with a ref that stashes the function on the DOM node for
 * the document-level submit listener. The attribute itself is dropped (a function is not a valid URL)
 * - the listener preventDefaults, so the browser never uses the missing attribute.
 *
 * The ref must go on vnode.ref: preact extracts `ref` from props at createElement time, so adding
 * props.ref inside options.vnode is ignored for DOM elements.
 */
function stashFunctionAction(
  vnode: VNode,
  props: FunctionActionProps,
  key: 'action' | 'formAction',
) {
  const fn = props[key] as (formData: FormData) => unknown
  delete props[key]
  const existingRef = (vnode as { ref?: unknown }).ref
  ;(vnode as { ref?: unknown }).ref = (node: ActionDomNode | null) => {
    if (node) {
      node.__pnextFormAction = fn
      if (key === 'action' && node instanceof HTMLFormElement) {
        enhanceProgressiveForm(node, fn)
        replayQueuedSubmission(node, fn)
      }
      if (key === 'formAction' && node instanceof HTMLElement) {
        const form = (node as { form?: HTMLFormElement | null }).form ?? null
        const queued = form && (form as QueuedForm).__pnextQueuedSubmit
        if (form && queued?.submitter === node) {
          delete (form as QueuedForm).__pnextQueuedSubmit
          runFormSubmission(form, queued.data, fn)
        }
      }
    }
    applyRef(existingRef, node)
  }
}

interface FormStateMeta {
  action?: { $$pnextActionId?: string }
  state?: unknown
  permalink?: string
}

/**
 * useActionState forms rendered on the client: mirror the server's progressive enhancement onto the
 * live DOM (method/enctype/hidden id + state fields) so a NATIVE submit - form.submit() fires no
 * submit event our listener could intercept - still posts the multipart action wire. Refreshed on
 * every render, keeping the state field current.
 */
function enhanceProgressiveForm(form: HTMLFormElement, fn: unknown) {
  const meta = (fn as { $$pnextFormState?: FormStateMeta }).$$pnextFormState
  if (!meta) return
  const id = meta.action?.$$pnextActionId
  if (!id) return
  form.setAttribute('method', 'post')
  form.setAttribute('enctype', 'multipart/form-data')
  if (meta.permalink) form.setAttribute('action', meta.permalink)
  setHiddenField(form, ACTION_ID_FIELD, id)
  // Non-JSON-serializable state (an action can return React elements, Maps,
  // circular structures, ...) cannot ride the progressive wire; fall back to
  // null rather than throwing inside the render's ref (which would take the
  // whole island down with it).
  let serializedState = 'null'
  try {
    serializedState = JSON.stringify(meta.state ?? null) ?? 'null'
  } catch {
    serializedState = 'null'
  }
  setHiddenField(form, FORM_STATE_FIELD, serializedState)
}

function setHiddenField(form: HTMLFormElement, name: string, value: string) {
  let input = form.querySelector<HTMLInputElement>(
    `input[type="hidden"][name="${cssEscape(name)}"]`,
  )
  if (!input) {
    input = document.createElement('input')
    input.type = 'hidden'
    input.name = name
    form.appendChild(input)
  }
  input.value = value
}

function applyRef(ref: unknown, node: Element | null) {
  if (typeof ref === 'function') (ref as (node: Element | null) => void)(node)
  else if (ref && typeof ref === 'object') (ref as { current: Element | null }).current = node
}

function installSubmitListener() {
  document.addEventListener(
    'submit',
    event => {
      const form = event.target as HTMLFormElement | null
      if (!form || !(form instanceof HTMLFormElement)) return
      const submitter = event.submitter as ActionDomNode | null

      const fn =
        submitter?.__pnextFormAction || (form as unknown as ActionDomNode).__pnextFormAction

      let dispatch: ((formData: FormData) => unknown) | undefined = fn
      if (!dispatch) {
        // A useActionState form that never hydrated (rendered by a server
        // component or an unhydrated client layout) has no live state to
        // update — let the native progressive POST run so the server
        // re-renders the page with the new form state.
        if (form.querySelector(`input[name="${cssEscape(FORM_STATE_FIELD)}"]`)) return
        // Server-rendered progressive form: the id travels in a hidden field
        // (or the submitter button's own name/value pair under its distinct
        // field name, which overrides the form-level default).
        const submitterId =
          submitter?.getAttribute('name') === SUBMIT_ACTION_ID_FIELD
            ? submitter.getAttribute('value')
            : null
        const field = form.querySelector<HTMLInputElement>(
          `input[name="${cssEscape(ACTION_ID_FIELD)}"]`,
        )
        // The hidden id may have been moved out-of-band (stripProgressiveActionIds).
        const id = submitterId ?? field?.value ?? form.getAttribute(ACTION_ID_ATTR)
        if (!id) return // not an action form; let the browser submit it
        dispatch = formData => callAction(id, [formData])
      }

      event.preventDefault()
      const formData = new FormData(form, (submitter ?? undefined) as HTMLElement | undefined)
      runFormSubmission(form, formData, dispatch)
    },
    // Bubble phase, so app-level onSubmit handlers that preventDefault
    // themselves run first and can opt out of the default action behavior.
    false,
  )
  adoptEarlySubmissions()
}

/**
 * React parity: a hydrated `<form action={serverAction}>` carries no visible
 * `$ACTION_ID` hidden inputs. A preact ISLAND form already loses its SSR hidden
 * input on hydration (the client vnode never renders one), but a SERVER-COMPONENT
 * form is raw HTML preact never manages, so its progressive-enhancement hidden id
 * survives every soft-nav commit and leaks into `form.innerHTML`. Once the client
 * runtime is up (submissions run through it, not the native POST), move each such
 * form's id out-of-band onto `data-pnext-action-id` and drop the hidden input.
 *
 * useActionState forms (`$pnext_form_state` present) are left untouched: a
 * server-rendered one still relies on its hidden id for the NATIVE progressive
 * POST fallback (installSubmitListener bails to native for form-state forms).
 */
function stripProgressiveActionIds() {
  if (typeof document === 'undefined') return
  const inputs = document.querySelectorAll<HTMLInputElement>(
    `input[type="hidden"][name="${cssEscape(ACTION_ID_FIELD)}"]`,
  )
  for (const input of inputs) {
    const form = input.form
    if (!form) continue
    if (form.querySelector(`input[name="${cssEscape(FORM_STATE_FIELD)}"]`)) continue
    if (input.value && !form.hasAttribute(ACTION_ID_ATTR)) {
      form.setAttribute(ACTION_ID_ATTR, input.value)
    }
    input.remove()
  }
}

function installClickActionListener() {
  document.addEventListener('click', event => {
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>(`[${ACTION_CLICK_ID_ATTR}]`)
        : null
    if (!target || (target instanceof HTMLButtonElement && target.disabled)) return
    const id = target.getAttribute(ACTION_CLICK_ID_ATTR)
    if (!id) return
    event.preventDefault()
    void callAction(id, [])
  })
}

function cssEscape(value: string) {
  const escape = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS?.escape
  return escape ? escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, match => `\\${match}`)
}

// Form-status feed for useFormStatus (react-dom compat).
function pushFormStatus(form: HTMLFormElement, data: FormData): () => void {
  try {
    return __pnextPushFormStatus({
      pending: true,
      data,
      method: (form.getAttribute('method') || 'get').toLowerCase(),
      action: form.getAttribute('action') ?? '',
    })
  } catch {
    return () => undefined
  }
}

// ---------------------------------------------------------------------------
// error boundary overlay (route error.js support for action failures)
// ---------------------------------------------------------------------------

// React routes action errors (uncatchable transition/dispatch failures) to the nearest error boundary.
// pnext's server-rendered pages have no client-side boundary components, so the compat entry installs
// the route's error.js as an overlay. Only the listeners are initial - the overlay body, which needs
// preact's renderer and the refresh path, rides the deferred dispatch chunk.
type ErrorComponentType = ComponentType<{ error: Error; reset: () => void }>

let overlayInstalled = false

export function installActionErrorOverlay(Component: ErrorComponentType) {
  if ((!process.browser && typeof window === 'undefined') || overlayInstalled) return
  overlayInstalled = true

  // Chained, not concurrent: two errors arriving before the chunk lands must
  // still see each other's effect on the overlay's "already showing" guard.
  let chain: Promise<unknown> = Promise.resolve()
  const show = (reason: unknown) => {
    chain = chain.then(async () => {
      const { showActionErrorOverlay } = await dispatchRuntime()
      showActionErrorOverlay(Component, reason)
    })
  }

  window.addEventListener('unhandledrejection', event => {
    if (isActionError(event.reason)) show(event.reason)
  })
  // useActionState rethrows action errors during render; without a class
  // error boundary in the tree the uncaught render error lands here.
  window.addEventListener('error', event => {
    if (isActionError(event.error)) show(event.error)
  })
  window.addEventListener('pnext:action-error', event => {
    show((event as CustomEvent).detail)
  })
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

export function installActionRuntime() {
  if (!process.browser && typeof window === 'undefined') return
  if (!window.__PNEXT_ACTIONS__) {
    window.__PNEXT_ACTIONS__ = {
      call: callAction,
      createAction,
      registerClientReference,
      reviveProps,
    }
    installSubmitListener()
    installClickActionListener()
    // Every mountRoute (initial hydration + each soft-nav commit) fires
    // `pnext:hydrated`; strip leaked progressive action-id inputs from the
    // freshly committed DOM so a hydrated form matches React (no `$ACTION_ID`).
    // Hydration is also where the dispatch chunk gets warmed (see loadDispatch):
    // past first paint, before any click, and `import()` dedups the repeats.
    window.addEventListener('pnext:hydrated', stripProgressiveActionIds)
    window.addEventListener('pnext:hydrated', warmDispatchChunk)
    stripProgressiveActionIds()
  }
  installVNodeHook()
}

export { createAction, callAction, registerClientReference, reviveProps }
