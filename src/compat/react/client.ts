import './style-values'
import ReactCompat from './preact'
import { attachReactInternals } from './internals'

attachReactInternals(ReactCompat)

export {
  ReactSharedInternals as __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED,
  ReactClientInternals as __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
} from './internals'

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
  default,
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
  use,
  useActionState,
  useOptimistic,
  useSyncExternalStore,
  useTransition,
  version,
} from './preact'
export { ViewTransition, addTransitionType } from './view-transition'

export function cache<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Result {
  return (...args: Args) => fn(...args)
}

export function cacheSignal() {
  return null
}
