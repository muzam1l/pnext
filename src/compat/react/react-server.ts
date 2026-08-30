// True `react-server` condition entry - used ONLY for modules Next compiles under the react-server layer
// proper: proxy/middleware and RSC/server-action graphs. Unlike ./server.ts, which keeps no-op hook stubs
// as NAMED exports for pages/api backward compatibility, this module must NOT expose client hook APIs at
// all: real React's react-server entry has no hook dispatcher, so useState/useEffect are absent from the
// module's export list entirely, not merely undefined on the default object.
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
  useContext,
  // React's own react-server entry exports these three alongside useId/use, so
  // mirror it — a server component may legitimately call them.
  useMemo,
  useCallback,
  useDebugValue,
  use,
  useActionState,
  useOptimistic,
  version,
} from './preact'
export { cache } from '../../api/cache'
export {
  ReactSharedInternals as __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED,
  ReactClientInternals as __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
} from './internals'

import { ViewTransition, addTransitionType } from './view-transition'
export { ViewTransition, addTransitionType }

import { currentPrerenderScope } from '../../render/ppr'
import { currentCacheSignal } from '../../request/cache'

// React.cacheSignal(): the AbortSignal for the current render. During a build
// prerender it is the prerender scope's signal; during a request/dynamic render
// it is the cache scope's. Null outside any render. Slow cache components bound
// their polling on it (see cache-components ppr-partial-hydration).
export function cacheSignal(): AbortSignal | null {
  const prerender = currentPrerenderScope()
  if (prerender) return prerender.signal
  return currentCacheSignal()
}

import './style-values'
import ReactCompat from './preact'
import { attachReactInternals } from './internals'
import { cache as serverCache } from '../../api/cache'

const ReactServer = { ...ReactCompat } as typeof ReactCompat & {
  cache: typeof serverCache
  cacheSignal: typeof cacheSignal
}
delete (ReactServer as { useState?: unknown }).useState
delete (ReactServer as { useEffect?: unknown }).useEffect
delete (ReactServer as { useLayoutEffect?: unknown }).useLayoutEffect
delete (ReactServer as { useInsertionEffect?: unknown }).useInsertionEffect
delete (ReactServer as { useImperativeHandle?: unknown }).useImperativeHandle
delete (ReactServer as { useReducer?: unknown }).useReducer
delete (ReactServer as { useRef?: unknown }).useRef
delete (ReactServer as { useDeferredValue?: unknown }).useDeferredValue
delete (ReactServer as { useTransition?: unknown }).useTransition
delete (ReactServer as { useSyncExternalStore?: unknown }).useSyncExternalStore
ReactServer.cache = serverCache
ReactServer.cacheSignal = cacheSignal
Object.assign(ReactServer, { ViewTransition, addTransitionType })
attachReactInternals(ReactServer)

export default ReactServer
