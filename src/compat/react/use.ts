import { options } from 'preact'

type CatchError = (
  error: unknown,
  vnode: SuspenseVNode,
  oldVNode?: SuspenseVNode,
  info?: unknown,
) => void
// Preact's mangled internals: vnode `_parent`/`_dom`/`_component`, component `_childDidSuspend`/`_dirty`.
export interface SuspenseVNode {
  __?: SuspenseVNode
  __e?: unknown
  __c?: { __c?: unknown; __d: boolean; forceUpdate(): void }
}

let transitionDepth = 0
let suspenseCatch: CatchError | undefined
let suspendHook: ((error: unknown, vnode: SuspenseVNode) => void) | undefined
// Set by the first transition, so a bundle that never starts one drops keepCommitted.
let keepHook: typeof keepCommitted | undefined

/** Sees each throw a transition did not keep; set by the navigation runtime. */
export function setSuspendHook(hook: typeof suspendHook) {
  suspendHook = hook
}

// Preact kept the old DOM for the throwing component; skipping the boundary walk keeps it on screen.
function keepCommitted(error: unknown, vnode: SuspenseVNode, oldVNode?: SuspenseVNode) {
  const thenable = error as PromiseLike<unknown> | null
  const component = vnode.__c
  if (!transitionDepth || typeof thenable?.then !== 'function' || !component || !oldVNode?.__e)
    return false
  const retry = () => {
    component.__d = false
    component.forceUpdate()
  }
  thenable.then(retry, retry)
  return true
}

/** React's startTransition: an update that re-suspends already-committed UI keeps it until the data settles. */
export function startTransition<T>(callback: () => T): T {
  keepHook = keepCommitted
  installSuspenseCatch()
  // eslint-disable-next-line @typescript-eslint/unbound-method -- restored onto options below
  const previous = options.debounceRendering
  let flush: (() => void) | undefined
  // The callback's updates render once, synchronously, inside the transition.
  options.debounceRendering = render => void (flush = render)
  transitionDepth++
  try {
    return callback()
  } finally {
    options.debounceRendering = previous
    try {
      flush?.()
    } finally {
      transitionDepth--
    }
  }
}

// Read by the client error runtime (Symbol.for crosses the chunk boundary): only values the boundary
// walk rethrew - a ROOT RENDER failure, Next's global-error case - may replace the document.
const RENDER_ESCAPE = Symbol.for('pnext.renderEscape')

/**
 * Wrap preact's catch hook outermost: preact/compat's Suspense, loaded later, wraps whatever is there.
 * Every copy also tags what the boundary walk rethrows.
 */
export function installSuspenseCatch(): void {
  // `_catchError`, mangled in preact's published build.
  const hooks = options as unknown as { __e?: CatchError }
  const walk = hooks.__e
  if (!walk || walk === suspenseCatch) return
  const self: CatchError = (error, vnode, oldVNode, info) => {
    // Only the outermost copy acts; one a later wrapper buried passes through.
    if (self === suspenseCatch) {
      if (keepHook?.(error, vnode, oldVNode)) return
      suspendHook?.(error, vnode)
    }
    try {
      walk(error, vnode, oldVNode, info)
    } catch (escaped) {
      try {
        ;(escaped as Record<symbol, unknown>)[RENDER_ESCAPE] = true
      } catch {
        // A primitive or frozen throw: the runtime's own escalation still mounts post-install.
      }
      throw escaped
    }
  }
  hooks.__e = suspenseCatch = self
}

// Thenables pre-tagged with use()'s tracked state, so use() reads them without suspending.
export function fulfilledThenable(): Promise<void> {
  return Object.assign(Promise.resolve(), { status: 'fulfilled' as const, value: undefined })
}

export function rejectedThenable(reason: Error): Promise<never> {
  const promise = Promise.reject(reason)
  promise.catch(() => undefined)
  return Object.assign(promise, { status: 'rejected' as const, reason })
}
