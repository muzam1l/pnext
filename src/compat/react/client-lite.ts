// Lite client `react` alias for compat apps whose client graph provably never suspends and only uses
// the core-preact-equivalent React surface (see clientCompatSurface in src/client/react-tier.ts).
// Everything here is backed by preact core + preact/hooks, so the bundle ships no preact/compat. The
// parity import wires the same vnode pass (React 19 ref prop, primitive-throw safety) as the full shim.
import './parity'
import './style-values'
import {
  Component,
  Fragment,
  cloneElement,
  createContext,
  createElement,
  createRef,
  isValidElement,
} from 'preact'
import {
  useCallback,
  useContext,
  useDebugValue,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'preact/hooks'
import { useOptimistic, useTransition } from './hooks-extra'
import { useActionState } from './action-state'

export {
  Component,
  Fragment,
  cloneElement,
  createContext,
  createElement,
  createRef,
  isValidElement,
  useCallback,
  useContext,
  useDebugValue,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useActionState,
  useOptimistic,
  useTransition,
}
export { ViewTransition, addTransitionType } from './view-transition'

// Same passthrough semantics preact/compat gives these.
export const StrictMode = Fragment
export const startTransition = (callback: () => void) => callback()
export const useDeferredValue = <T>(value: T): T => value
export const useInsertionEffect = useLayoutEffect
export const version = '19.0.0'

export function cache<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Result {
  return (...args: Args) => fn(...args)
}

export function cacheSignal() {
  return null
}

// No default export: the surface scan already forces the full tier for any app doing
// `import React from 'react'`, and a default object here would pin every export against treeshaking.
