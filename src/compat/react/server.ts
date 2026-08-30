import './style-values'
import ReactCompat from './preact'
import { attachReactInternals } from './internals'
import { cache as serverCache } from '../../api/cache'

attachReactInternals(ReactCompat)

export {
  ReactSharedInternals as __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED,
  ReactClientInternals as __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
} from './internals'
import { currentPrerenderScope } from '../../render/ppr'
import { currentCacheSignal } from '../../request/cache'

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
  lazy,
  memo,
  render,
  startTransition,
  unmountComponentAtNode,
  unstable_batchedUpdates,
  useId,
  use,
  useActionState,
  useOptimistic,
  version,
} from './preact'
export { cache } from '../../api/cache'
import { ViewTransition, addTransitionType } from './view-transition'
export { ViewTransition, addTransitionType }

type EffectHook = typeof ReactCompat.useEffect
type StateSetter<State> = (value: State | ((previous: State) => State)) => void
type Reducer<Action> = (action: Action) => void

const useEffect: EffectHook = () => undefined
const useLayoutEffect: EffectHook = () => undefined
const useInsertionEffect: EffectHook = () => undefined
const useDebugValue: typeof ReactCompat.useDebugValue = () => undefined
const useImperativeHandle: typeof ReactCompat.useImperativeHandle = () => undefined

function useState<State = undefined>(
  initialState?: State | (() => State),
): [State | undefined, StateSetter<State | undefined>] {
  return [
    typeof initialState === 'function' ? (initialState as () => State)() : initialState,
    () => undefined,
  ]
}

function useReducer<State, Action>(
  reducer: (state: State, action: Action) => State,
  initialArg: State,
  init?: (value: State) => State,
): [State, Reducer<Action>] {
  void reducer
  return [init ? init(initialArg) : initialArg, () => undefined]
}

function useRef<Value = undefined>(initialValue?: Value): { current: Value | undefined } {
  return { current: initialValue }
}

function useMemo<Value>(factory: () => Value): Value {
  return factory()
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- must mirror preact's `<T extends Function>` useCallback signature
function useCallback<Callback extends Function>(callback: Callback): Callback {
  return callback
}

function useDeferredValue<Value>(value: Value): Value {
  return value
}

function useTransition(): [false, (callback: () => void) => void] {
  return [false, callback => callback()]
}

function useSyncExternalStore<Snapshot>(
  _subscribe: (onStoreChange: () => void) => () => void,
  _getSnapshot: () => Snapshot,
  getServerSnapshot?: () => Snapshot,
): Snapshot {
  // Falling back to getSnapshot here is the same hazard: this layer only ever renders on the server.
  if (!getServerSnapshot)
    throw new Error(
      'Missing getServerSnapshot, which is required for server-rendered content. Will revert to client rendering.',
    )
  return getServerSnapshot()
}

function useContext<Value>(context: Parameters<typeof ReactCompat.useContext<Value>>[0]): Value {
  return ReactCompat.useContext(context)
}

// Re-export the server stubs as named exports too. Client-component libraries
// compiled to CJS (e.g. @next/third-parties) do `const react = require('react')`
// then `react.useEffect(...)`; when their bundle aliases `react` to this module
// under the react-server condition, esbuild's `__toCommonJS` only surfaces named
// exports, so hooks that live solely on the default export read back undefined.
export {
  useEffect,
  useLayoutEffect,
  useInsertionEffect,
  useDebugValue,
  useImperativeHandle,
  useState,
  useReducer,
  useRef,
  useMemo,
  useCallback,
  useDeferredValue,
  useTransition,
  useSyncExternalStore,
  useContext,
}

export function cacheSignal(): AbortSignal | null {
  const prerender = currentPrerenderScope()
  if (prerender) return prerender.signal
  return currentCacheSignal()
}

const ReactServer = { ...ReactCompat } as typeof ReactCompat & {
  cache: typeof serverCache
  cacheSignal: typeof cacheSignal
}
delete (ReactServer as { useState?: unknown }).useState
ReactServer.cache = serverCache
ReactServer.cacheSignal = cacheSignal
ReactServer.useEffect = useEffect
ReactServer.useLayoutEffect = useLayoutEffect
ReactServer.useInsertionEffect = useInsertionEffect
ReactServer.useDebugValue = useDebugValue
ReactServer.useImperativeHandle = useImperativeHandle
ReactServer.useReducer = useReducer
ReactServer.useRef = useRef
ReactServer.useMemo = useMemo
ReactServer.useCallback = useCallback
ReactServer.useDeferredValue = useDeferredValue
ReactServer.useTransition = useTransition
ReactServer.useSyncExternalStore = useSyncExternalStore
ReactServer.useContext = useContext as typeof ReactCompat.useContext
Object.assign(ReactServer, { ViewTransition, addTransitionType })

export default ReactServer
