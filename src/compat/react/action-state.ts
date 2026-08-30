import { useCallback, useRef, useState } from 'preact/hooks'
import { hooksUsable } from './hooks-extra'

/**
 * React 19's useActionState, on preact hooks. Returns [state, dispatch, isPending]; dispatch(payload)
 * runs `action(prevState, payload)` (async ok) and swaps the state when it settles. The returned dispatch
 * is also valid as a `<form action={...}>` value - the pnext client runtime intercepts function form
 * actions and calls them with the form's FormData. Queueing follows React: concurrent dispatches chain
 * in order against the latest settled state rather than racing.
 */
export function useActionState<State, Payload = FormData>(
  action: (state: Awaited<State>, payload: Payload) => State | Promise<State>,
  initialState: Awaited<State>,
  _permalink?: string,
): [state: Awaited<State>, dispatch: (payload: Payload) => void, isPending: boolean] {
  // Server resolve may invoke a client component as a plain function (no
  // preact render context, so hooks throw). SSR output for useActionState is
  // always the (possibly progressively-updated) initial state with a dispatch
  // that only works after hydration; fall back to exactly that. The dispatch
  // carries form-state metadata so SSR can progressively enhance
  // <form action={dispatch}>.
  if (!hooksUsable()) {
    const staticInitial = (consumeActionStateOverride() ?? { value: initialState })
      .value as Awaited<State>
    const staticDispatch = (payload: Payload) =>
      void Promise.resolve(action(staticInitial, payload))
    tagFormStateDispatch(staticDispatch, action, staticInitial, _permalink)
    return [staticInitial, staticDispatch, false]
  }
  const initialRef = useRef<{ value: Awaited<State> } | null>(null)
  if (!initialRef.current) {
    // A progressive (no-JS) submission re-renders the page with the action's
    // result as the form state; the server (and the inline hydration script)
    // publish it via a consumed-once global override.
    initialRef.current = {
      value: (consumeActionStateOverride() ?? { value: initialState }).value as Awaited<State>,
    }
  }
  const [state, setState] = useState<Awaited<State>>(initialRef.current.value)
  const [pending, setPending] = useState(0)
  const lastSettled = useRef<Awaited<State>>(initialRef.current.value)
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  // A rejected action must surface to the nearest error boundary during an actual preact render (only
  // diff() wraps component calls in the getDerivedStateFromError/componentDidCatch try/catch).
  // preact/hooks' setState invokes a functional updater EAGERLY at call time, to bail out on an unchanged
  // value, rather than deferring it to the render - so `setState(() => { throw error })` from inside an
  // async .catch handler throws immediately in that microtask, outside any render call stack and outside
  // any try/catch, producing an unhandled rejection instead of reaching the boundary. Stash the error in
  // a ref and force a re-render instead; the throw then happens inside this hook's own render call.
  const pendingError = useRef<{ error: unknown } | null>(null)
  const [, forceRender] = useState(0)

  const dispatch = useCallback(
    (payload: Payload) => {
      setPending(count => count + 1)
      // Chain in dispatch order against the latest settled state. A rejected
      // action leaves the previous state in place (matching React, where the
      // error propagates to the nearest error boundary via the transition) and
      // must not poison the queue for later dispatches.
      chain.current = chain.current.then(async () => {
        try {
          const redirectsBefore = actionRedirectCount()
          const next = await action(lastSettled.current, payload)
          // A redirect renders the destination's initial form state even when
          // the shared layout island itself survives the navigation.
          if (next === undefined && actionRedirectCount() !== redirectsBefore) {
            lastSettled.current = initialRef.current!.value
            setState(() => initialRef.current!.value)
            return
          }
          lastSettled.current = next
          setState(() => next)
        } finally {
          setPending(count => count - 1)
        }
      })
      // React propagates action errors to the nearest error boundary (they
      // are not catchable at the dispatch site). Stash it and force a render:
      // a class error boundary in the tree catches the throw below; without
      // one the uncaught render error reaches the window 'error' event, where
      // the compat entry's error.js overlay picks it up.
      chain.current = chain.current.catch(error => {
        if (!process.browser && typeof window === 'undefined') return
        pendingError.current = { error }
        forceRender(count => count + 1)
      })
    },
    [action],
  )

  if (pendingError.current) {
    const { error } = pendingError.current
    pendingError.current = null
    throw error
  }

  tagFormStateDispatch(dispatch, action, state, _permalink)
  return [state, dispatch, pending > 0]
}

/**
 * Form-state metadata attached to a useActionState dispatch so the server
 * renderer can progressively enhance <form action={dispatch}>: the underlying
 * action (for its wire id), the state at render time (posted back in a hidden
 * field so the server can run `action(state, formData)` without JS), and the
 * optional permalink target.
 */
export interface FormStateDispatchMeta {
  action: (state: never, payload: never) => unknown
  state: unknown
  permalink?: string
}

function tagFormStateDispatch(
  dispatch: (payload: never) => void,
  action: (state: never, payload: never) => unknown,
  state: unknown,
  permalink?: string,
) {
  ;(dispatch as unknown as { $$pnextFormState?: FormStateDispatchMeta }).$$pnextFormState = {
    action: action,
    state,
    ...(permalink !== undefined ? { permalink } : {}),
  }
}

/**
 * Consumed-once initial-state override for useActionState, published either by
 * the server before re-rendering a page for a progressive form submission, or
 * by the inline hydration script that mirrors it to the client.
 */
/** Redirect counter the action-client runtime bumps (see markActionRedirected). */
function actionRedirectCount(): number {
  return (globalThis as { __pnextActionRedirects?: number }).__pnextActionRedirects ?? 0
}

export function consumeActionStateOverride(): { value: unknown } | undefined {
  const holder = globalThis as { __PNEXT_ACTION_STATE__?: unknown }
  if (!('__PNEXT_ACTION_STATE__' in holder)) return undefined
  const override = holder.__PNEXT_ACTION_STATE__
  if (
    override !== null &&
    typeof override === 'object' &&
    'skip' in override &&
    typeof override.skip === 'number' &&
    override.skip > 0
  ) {
    override.skip--
    return undefined
  }
  delete holder.__PNEXT_ACTION_STATE__
  return {
    value:
      override !== null && typeof override === 'object' && 'value' in override
        ? override.value
        : override,
  }
}
