import ReactCompat from 'preact/compat'
import { type ComponentChildren, type ComponentType, type VNode } from 'preact'
import { setSuspenseParity } from './parity'
import { use } from './use'
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
export { use, withUseThenableState, type UseThenableState } from './use'
export {
  useActionState,
  consumeActionStateOverride,
  type FormStateDispatchMeta,
} from './action-state'
export { useOptimistic, useTransition } from './hooks-extra'

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
export default Object.assign(ReactCompat, { use, useActionState, useOptimistic, useTransition })

// `React.useSyncExternalStore` needs the wrapper for the same reason the named export does. The
// browser folds this to `if (false)` and drops it: preact's own property is already correct there.
if (!process.browser) ReactCompat.useSyncExternalStore = useSyncExternalStore

export const Children = ReactCompat.Children
export const Component = ReactCompat.Component
export const Fragment = ReactCompat.Fragment
export const PureComponent = ReactCompat.PureComponent
export const StrictMode = ReactCompat.StrictMode
export const Suspense = ReactCompat.Suspense
export const SuspenseList = ReactCompat.SuspenseList
export const cloneElement = ReactCompat.cloneElement
export const createContext = ReactCompat.createContext
export const createElement = ReactCompat.createElement
export const createFactory = ReactCompat.createFactory
export const createPortal = ReactCompat.createPortal
export const createRef = ReactCompat.createRef
export const findDOMNode = ReactCompat.findDOMNode
export const flushSync = ReactCompat.flushSync
export const forwardRef = ReactCompat.forwardRef
export const hydrate = ReactCompat.hydrate
export const isFragment = ReactCompat.isFragment
export const isMemo = ReactCompat.isMemo
export const isValidElement = ReactCompat.isValidElement
// preact's lazy returns a bare function with no react.lazy $$typeof; tag it so
// validation (e.g. <Link legacyBehavior>) can recognize lazy components.
export const lazy: typeof ReactCompat.lazy = loader => {
  const component = ReactCompat.lazy(loader)
  ;(component as unknown as Record<symbol, boolean>)[Symbol.for('pnext.lazy')] = true
  return component
}
export const memo = ReactCompat.memo
export const render = ReactCompat.render
export const startTransition = ReactCompat.startTransition
export const unmountComponentAtNode = ReactCompat.unmountComponentAtNode
export const unstable_batchedUpdates = ReactCompat.unstable_batchedUpdates
export const useCallback = ReactCompat.useCallback
export const useContext = ReactCompat.useContext
export const useDebugValue = ReactCompat.useDebugValue
export const useDeferredValue = ReactCompat.useDeferredValue
export const useEffect = ReactCompat.useEffect
export const useId = ReactCompat.useId
export const useImperativeHandle = ReactCompat.useImperativeHandle
export const useInsertionEffect = ReactCompat.useInsertionEffect
export const useLayoutEffect = ReactCompat.useLayoutEffect
export const useMemo = ReactCompat.useMemo
export const useReducer = ReactCompat.useReducer
export const useRef = ReactCompat.useRef
export const useState = ReactCompat.useState
export const version = ReactCompat.version
