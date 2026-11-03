import ReactCompat from 'preact/compat'
import { useContext as readContext } from 'preact/hooks'
import { type ComponentChildren, type ComponentType, type Context, type VNode } from 'preact'
import { setSuspenseParity } from './parity'
import { startTransition } from './use'
import { useActionState } from './action-state'
import { useOptimistic, useTransition } from './hooks-extra'

// Full react shim: preact/compat plus the React 19 surface. The vnode parity pass lives in ./parity
// (compat-free, shared with the lite client shim); the suspense-dependent parity below registers into
// it here, so it only ships when this module (and preact/compat with it) is in the bundle.

setSuspenseParity({
  beforeThrowSafety: applyAsyncClientComponent,
  afterThrowSafety: applyThenableChildren,
})

export { setReactCompatActive } from './parity'
export {
  useActionState,
  consumeActionStateOverride,
  type FormStateDispatchMeta,
} from './action-state'
export { useOptimistic, useTransition } from './hooks-extra'

interface TrackedThenable<T> extends PromiseLike<T> {
  status?: 'pending' | 'fulfilled' | 'rejected'
  value?: T
  reason?: unknown
}

// Replay state for use() in server components: the renderer replays a component
// after a thrown thenable settles, and use() call N must resolve to the thenable
// recorded on the previous attempt (the rerun creates a fresh promise).
export interface UseThenableState {
  thenables: TrackedThenable<unknown>[]
}

// globalThis-anchored: the prebundled server entry inlines its own copy of this module;
// a replay in one copy must be visible to use() in the other or retries loop forever.
interface UseReplayState {
  active: UseThenableState | null
  index: number
}
// Read on use, so a bundle that never calls use() carries no module-level state.
const replayStateOf = () =>
  ((globalThis as Record<PropertyKey, unknown>)[Symbol.for('pnext.useReplayState')] ??= {
    active: null,
    index: 0,
  }) as UseReplayState

export function withUseThenableState<T>(state: UseThenableState, run: () => T): T {
  const replayState = replayStateOf()
  const previousState = replayState.active
  const previousIndex = replayState.index
  replayState.active = state
  replayState.index = 0
  try {
    return run()
  } finally {
    replayState.active = previousState
    replayState.index = previousIndex
  }
}

// React 19's use(): unwrap a thenable via suspense, or read a context.
export function use<T>(usable: PromiseLike<T> | Context<T>): T {
  if (usable && typeof (usable as PromiseLike<T>).then === 'function') {
    let thenable = usable as TrackedThenable<T>
    // Replays are a server render's; the browser build folds this away.
    const replayState = process.browser ? undefined : replayStateOf()
    if (replayState?.active) {
      const index = replayState.index++
      const existing = replayState.active.thenables[index]
      if (existing) thenable = existing as TrackedThenable<T>
      else replayState.active.thenables[index] = thenable
    }
    if (thenable.status === 'fulfilled') return thenable.value as T
    if (thenable.status === 'rejected') throw thenable.reason
    if (thenable.status !== 'pending') {
      thenable.status = 'pending'
      thenable.then(
        value => {
          thenable.status = 'fulfilled'
          thenable.value = value
        },
        reason => {
          thenable.status = 'rejected'
          thenable.reason = reason
        },
      )
    }
    // React use() protocol: suspend by throwing the thenable itself.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw thenable
  }
  return readContext(usable as Context<T>)
}

function applyThenableChildren(vnode: VNode) {
  const props = vnode.props as Record<string, unknown>
  const children = props.children
  const resolved = thenableChildren(children)
  if (resolved !== children) props.children = resolved
}

function thenableChildren(value: unknown): unknown {
  if (value && typeof (value as PromiseLike<unknown>).then === 'function') {
    return ReactCompat.createElement(
      ReactCompat.Suspense,
      { fallback: null },
      ReactCompat.createElement(ThenableChild, {
        value: value as PromiseLike<ComponentChildren>,
      }),
    )
  }
  if (!Array.isArray(value)) return value
  let changed = false
  const children = value.map(child => {
    const resolved = thenableChildren(child)
    if (resolved !== child) changed = true
    return resolved
  })
  return changed ? children : value
}

function ThenableChild({ value }: { value: PromiseLike<ComponentChildren> }) {
  return use(value)
}

const asyncClientComponents = new WeakMap<
  ComponentType<Record<string, unknown>>,
  ComponentType<Record<string, unknown>>
>()

function applyAsyncClientComponent(vnode: VNode) {
  if ((!process.browser && typeof window === 'undefined') || typeof vnode.type !== 'function')
    return
  const component = vnode.type as ComponentType<Record<string, unknown>>
  if (component.constructor.name !== 'AsyncFunction') return
  const renderComponent = component as (props: Record<string, unknown>) => ComponentChildren
  let wrapper = asyncClientComponents.get(component)
  if (!wrapper) {
    wrapper = props => {
      const [result] = ReactCompat.useState(() => Promise.resolve(renderComponent(props)))
      return ReactCompat.createElement(
        ReactCompat.Suspense,
        { fallback: null },
        ReactCompat.createElement(ThenableChild, { value: result }),
      )
    }
    asyncClientComponents.set(component, wrapper)
  }
  vnode.type = wrapper
}

// Captured before the augmentation below overwrites the key, or the wrapper would recurse.
const preactUseSyncExternalStore = ReactCompat.useSyncExternalStore

// preact/compat ignores getServerSnapshot; React uses it for every server render, so without this
// the client-SSR pass calls the browser snapshot (and app stores touch `window`).
function serverSnapshotAware<Snapshot>(
  subscribe: (onStoreChange: () => void) => () => void,
  getSnapshot: () => Snapshot,
  getServerSnapshot?: () => Snapshot,
): Snapshot {
  if (typeof window === 'undefined') {
    if (!getServerSnapshot)
      throw new Error(
        'Missing getServerSnapshot, which is required for server-rendered content. Will revert to client rendering.',
      )
    return getServerSnapshot()
  }
  return preactUseSyncExternalStore(subscribe, getSnapshot)
}

// The browser build folds `process.browser` to true, so it ships preact's function verbatim and
// tree-shakes the wrapper - the server-only text never reaches the client. Purely a size win: the
// wrapper is already correct in a browser, so an undefined `process.browser` only costs bytes.
export const useSyncExternalStore: typeof serverSnapshotAware = process.browser
  ? preactUseSyncExternalStore
  : serverSnapshotAware

// React 19 APIs preact/compat lacks - use(), useActionState, useOptimistic (imported above) - must ALSO
// live on the default export: app code does `import React from 'react'; React.use(...)`, not only named
// imports. server.ts spreads this default into ReactServer, so the augmentation covers both layers.
export default Object.assign(ReactCompat, {
  use,
  startTransition,
  useActionState,
  useOptimistic,
  useTransition,
})

// `React.useSyncExternalStore` needs the wrapper for the same reason the named export does. The
// browser folds this to `if (false)` and drops it: preact's own property is already correct there.
if (!process.browser) ReactCompat.useSyncExternalStore = useSyncExternalStore

// preact's lazy returns a bare function with no react.lazy $$typeof; tag it so
// validation (e.g. <Link legacyBehavior>) can recognize lazy components.
export const lazy: typeof ReactCompat.lazy = loader => {
  const component = ReactCompat.lazy(loader)
  ;(component as unknown as Record<symbol, boolean>)[Symbol.for('pnext.lazy')] = true
  return component
}
export { startTransition }
// Bound re-exports, so a bundle drops the ones it never imports.
export {
  Children,
  Component,
  Fragment,
  PureComponent,
  StrictMode,
  Suspense,
  SuspenseList,
  cloneElement,
  createContext,
  createElement,
  createFactory,
  createPortal,
  createRef,
  findDOMNode,
  flushSync,
  forwardRef,
  hydrate,
  isFragment,
  isMemo,
  isValidElement,
  memo,
  render,
  unmountComponentAtNode,
  unstable_batchedUpdates,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  version,
} from 'preact/compat'
