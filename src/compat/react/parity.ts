import { options, type ComponentType, type VNode } from 'preact'
import { wrapComponentForPrimitiveThrows } from '../client/errors/primitive-throw'

const reactForwardRefSymbol = Symbol.for('react.forward_ref')
const react19RefCompatInstalled = Symbol.for('pnext.react19-ref-compat-installed')
const reactTextSeparatorSymbol = Symbol.for('pnext.react-text-separator')

type PNextPreactOptions = typeof options & {
  [react19RefCompatInstalled]?: true
}

type RefCompatibleComponent = ComponentType<Record<string, unknown>> & {
  $$typeof?: symbol
  prototype?: { render?: unknown }
}

// preact's `options.vnode` is process-global and cannot be uninstalled, so its BEHAVIOR follows the
// active extension host instead: one server process can serve a compat app and then a pure-core one, and
// the core app must not inherit React parity it never asked for. Defaults to on - importing this module
// IS compat being wired, and the client never resets.
let reactCompatActive = true

/** Enable/disable the react-compat vnode parity pass (see reactCompatActive). */
export function setReactCompatActive(active: boolean): void {
  reactCompatActive = active
}

// Suspense-dependent parity (thenable children, async client components) needs preact/compat, which a
// suspense-free client bundle never ships. The full shim registers it on import; the lite path leaves
// the slot empty and its bundle drops preact/compat entirely. Two phases: async-component wrapping must
// see the raw component (before primitive-throw wraps it); thenable children run after.
interface SuspenseParity {
  beforeThrowSafety(vnode: VNode): void
  afterThrowSafety(vnode: VNode): void
}

let suspenseParity: SuspenseParity | undefined

export function setSuspenseParity(pass: SuspenseParity): void {
  suspenseParity = pass
}

const pnextOptions = options as PNextPreactOptions
if (!pnextOptions[react19RefCompatInstalled]) {
  const previousVNode = options.vnode?.bind(options)
  options.vnode = vnode => {
    previousVNode?.(vnode)
    if (!reactCompatActive) return
    applyReact19RefProp(vnode)
    suspenseParity?.beforeThrowSafety(vnode)
    applyPrimitiveThrowSafety(vnode)
    suspenseParity?.afterThrowSafety(vnode)
    applyStrayDocumentChildren(vnode)
    applyReactTextSeparators(vnode)
  }
  pnextOptions[react19RefCompatInstalled] = true

  // Effect scheduling parity with React: preact/hooks flushes passive effects
  // via requestAnimationFrame + setTimeout(35) (afterNextFrame), both governed
  // by the page clock. React flushes them through its scheduler's
  // MessageChannel, which fake-timer installations (Playwright's CDP clock in
  // Next's own e2e suites) never intercept. Under an installed fake clock the
  // rAF path loses its "before the next idle callback" ordering and
  // Suspense-boundary promotions land after a test's post-drain DOM sample.
  // Route the flush through a MessageChannel task so effect timing is
  // clock-independent, like React's.
  if ((process.browser || typeof window !== 'undefined') && typeof MessageChannel !== 'undefined') {
    const queue: (() => void)[] = []
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      for (const callback of queue.splice(0)) callback()
    }
    ;(options as { requestAnimationFrame?: (cb: () => void) => void }).requestAnimationFrame =
      callback => {
        queue.push(callback)
        channel.port2.postMessage(null)
      }
  }
}

// A root layout may render children directly under `<html>` alongside `<body>` - `<GoogleAnalytics/>`,
// a `<Script>`, an analytics island. React renders them in place and the browser's parser hoists the
// result into `<body>`; pnext's document reader keeps only the `<head>`/`<body>` children, so anything
// else was dropped and never ran (no resource hints, no hydration). Relocate strays to the front of
// `<body>` - the position the parser would have given them - so the component renders exactly once.
function applyStrayDocumentChildren(vnode: VNode) {
  // Server-only: the client never re-reads the document layout (see applyReactTextSeparators).
  if (process.browser || typeof window !== 'undefined') return
  if (vnode.type !== 'html') return
  const props = vnode.props as Record<string, unknown>
  const children = props.children
  if (!Array.isArray(children)) return

  const kept: unknown[] = []
  const stray: unknown[] = []
  let body: VNode | undefined
  for (const child of children as unknown[]) {
    const type = isElementVNode(child) ? child.type : undefined
    if (type === 'body') body = child as VNode
    if (type === 'head' || type === 'body' || !mayRenderContent(child)) {
      kept.push(child)
      continue
    }
    stray.push(child)
  }
  if (!body || stray.length === 0) return

  const bodyProps = body.props as Record<string, unknown>
  const bodyChildren: unknown = bodyProps.children
  bodyProps.children = [
    ...stray,
    ...(Array.isArray(bodyChildren) ? (bodyChildren as unknown[]) : [bodyChildren]),
  ]
  props.children = kept
}

function isElementVNode(value: unknown): value is VNode {
  return typeof value === 'object' && value !== null && 'type' in value
}

// Nullish/boolean children and JSX whitespace render nothing, so leaving them under `<html>` is free.
function mayRenderContent(child: unknown) {
  if (child == null || typeof child === 'boolean') return false
  return typeof child === 'string' ? child.trim() !== '' : true
}

function applyReactTextSeparators(vnode: VNode) {
  // Server-only. `process.browser` is a client-bundle define (true) and
  // undefined on the server, so this body folds out of browser builds; the
  // `typeof window` twin keeps the runtime check for unbundled consumers.
  if (process.browser || typeof window !== 'undefined') return
  const props = vnode.props as Record<string, unknown>
  const children = props.children
  if (!Array.isArray(children) || children.length < 2) return
  const values = children as unknown[]

  const separated: unknown[] = []
  let changed = false
  for (let index = 0; index < values.length; index += 1) {
    const child = values[index]
    separated.push(child)
    if (!mayRenderText(child) || !mayRenderText(values[index + 1])) continue
    separated.push({
      type: reactTextSeparatorSymbol,
      props: { UNSTABLE_comment: ' ' },
    })
    changed = true
  }
  if (changed) props.children = separated
}

function mayRenderText(value: unknown) {
  if (typeof value === 'string' || typeof value === 'number') return true
  if (!value || typeof value !== 'object' || !('type' in value)) return false
  return typeof (value as VNode).type !== 'string'
}

function applyPrimitiveThrowSafety(vnode: VNode) {
  // Client-only: this exists to stop a thrown undefined/null from crashing preact's OWN diff.js `e.then`
  // suspense check during real preact diffing. The server's resolveServerTree is a custom RSC-style tree
  // walker, not preact's diff - it never hits that crash, and wrapping component references there risks
  // losing the symbol-keyed metadata resolveServerTree branches on.
  if (!process.browser && typeof window === 'undefined') return
  if (typeof vnode.type !== 'function') return
  vnode.type = wrapComponentForPrimitiveThrows(vnode.type)
}

function applyReact19RefProp(vnode: VNode) {
  if (!vnode.ref || typeof vnode.type !== 'function') return
  const component = vnode.type as RefCompatibleComponent
  if (component.prototype?.render || component.$$typeof === reactForwardRefSymbol) return

  vnode.props = {
    ...(vnode.props as Record<string, unknown>),
    ref: vnode.ref,
  } as unknown as typeof vnode.props
  vnode.ref = null
}
