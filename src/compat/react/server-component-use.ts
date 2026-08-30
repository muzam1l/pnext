// use() replay for server components (COMPAT - react).
//
// React 19's use() suspends a synchronous component by throwing a thenable; once the thenable settles
// the renderer replays the component from the top, and use() call N must resolve to the thenable it
// recorded on the previous attempt, since the rerun creates fresh promises. preact has no such
// machinery, so this wraps a single server-component invocation with that replay loop:
//
//   - a fresh UseThenableState tracks the thenables use() sees, indexed by call order.
//   - the invocation runs inside that state scope. If a synchronous component throws the thenable use()
//     suspended on, it is awaited and the component replays with the SAME state, so the next attempt's
//     use() call reads the now-settled tracked thenable and returns its value.
//   - a non-thenable throw propagates unchanged.
//   - an async component returns a promise and awaits its own use() promises, so it needs no replay.
//
// Registered onto renderExtensions.wrapServerComponentInvoke; a pure-core app keeps the pass-through
// default and never loads this module.

import { withUseThenableState, type UseThenableState } from './preact'

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value != null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  )
}

/**
 * Run a server-component invocation with use()-replay support. Synchronous
 * components that suspend via use() are awaited and replayed against the same
 * thenable state; async components (and plain returns) pass through.
 */
export function invokeServerComponentWithUse<T>(invoke: () => T): T {
  const state: UseThenableState = { thenables: [] }

  const attempt = (): T => {
    try {
      return withUseThenableState(state, invoke)
    } catch (error) {
      // A pending use() thenable suspends the component: await it, then replay
      // with the same state so the settled thenable resolves in place.
      if (isThenable(error)) return Promise.resolve(error).then(attempt, attempt) as T
      throw error
    }
  }

  return attempt()
}
