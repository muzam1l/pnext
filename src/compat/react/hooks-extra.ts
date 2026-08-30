import { options, type VNode } from 'preact'
import { useCallback, useRef, useState } from 'preact/hooks'

// React 19 hooks (use, useActionState, useOptimistic, useTransition) implemented directly on
// preact/hooks so a suspense-free client bundle can ship them without preact/compat. The full shim
// re-exports these same functions - one implementation, both surfaces.

// True when a preact hooks call would succeed (a component render is in flight). preact fires
// options._render just before invoking a component and options.diffed after it commits; between the two,
// hooks have a current component. Server-side tree resolution invokes some client components as plain
// functions, outside any preact render, where hooks would throw - useActionState/useOptimistic fall back
// to SSR-equivalent static values there instead.
let renderInFlight = false

export function hooksUsable(): boolean {
  return renderInFlight
}

{
  const anyOptions = options as unknown as Record<string, unknown>
  const previousRender = anyOptions.__r as ((vnode: VNode) => void) | undefined
  anyOptions.__r = (vnode: VNode) => {
    renderInFlight = true
    previousRender?.(vnode)
  }
  const previousDiffed = options.diffed?.bind(options)
  options.diffed = vnode => {
    renderInFlight = false
    previousDiffed?.(vnode)
  }
}

/**
 * React 19's useTransition, on preact hooks. preact/compat's own useTransition is a no-op stub that never
 * tracks pending state, so an async transition callback's in-flight window is invisible. Track it with a
 * counter: startTransition(cb) runs cb, and when cb returns a thenable holds `isPending` true until it
 * settles. Concurrent transitions overlap, each incrementing and decrementing, so isPending stays true
 * while ANY is in flight - matching React.
 */
export function useTransition(): [boolean, (callback: () => void | Promise<void>) => void] {
  if (!hooksUsable()) return [false, callback => void callback()]
  const [pending, setPending] = useState(0)
  const startTransition = useCallback((callback: () => void | Promise<void>) => {
    const mpaBefore = (globalThis as { __pnextMpaNavigation?: number }).__pnextMpaNavigation ?? 0
    let result: void | Promise<void>
    try {
      result = callback()
    } catch {
      return
    }
    const mpaAfter = (globalThis as { __pnextMpaNavigation?: number }).__pnextMpaNavigation ?? 0
    if (mpaAfter !== mpaBefore) {
      setPending(count => count + 1)
      return
    }
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
      setPending(count => count + 1)
      void Promise.resolve(result).finally(() => setPending(count => count - 1))
    }
  }, [])
  return [pending > 0, startTransition]
}

/**
 * React 19's useOptimistic, on preact hooks (simplified: the optimistic value
 * resets whenever the passthrough (base) value changes on a rerender, which is
 * when the real state has caught up).
 */
export function useOptimistic<State, Payload = State>(
  passthrough: State,
  reducer?: (state: State, payload: Payload) => State,
): [State, (payload: Payload) => void] {
  if (!hooksUsable()) return [passthrough, () => undefined]
  const [optimistic, setOptimistic] = useState<{ value: State } | null>(null)
  const lastBase = useRef(passthrough)
  if (lastBase.current !== passthrough) {
    lastBase.current = passthrough
    if (optimistic) setOptimistic(null)
  }
  const dispatch = useCallback(
    (payload: Payload) => {
      setOptimistic(current => ({
        value: reducer
          ? reducer(current ? current.value : lastBase.current, payload)
          : (payload as unknown as State),
      }))
    },
    [reducer],
  )
  return [optimistic ? optimistic.value : passthrough, dispatch]
}
