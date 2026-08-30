// Client-safe postpone primitives (CORE).
//
// PostponeError + isPostpone are pure, browser-safe values: a client control-
// flow module (compat/client/errors/control-flow.ts) needs isPostpone to skip
// postpone errors during hydration. They used to live in ppr.ts, but ppr.ts
// imports `node:async_hooks` at module scope (AsyncLocalStorage prerender
// storage), so importing isPostpone from there dragged node:async_hooks into
// the browser client bundle and broke `Could not resolve "node:async_hooks"`.
// Splitting them out keeps ppr.ts as the single source (it re-exports these) so
// server callers are unaffected, while client callers import only this file.

const postponeSymbol = Symbol.for('pnext.postpone')

export class PostponeError extends Error {
  readonly [postponeSymbol] = true
  constructor(readonly api: string) {
    super(`${api} postponed for partial prerendering`)
    this.name = 'PostponeError'
  }
}

export function isPostpone(error: unknown): error is PostponeError {
  return typeof error === 'object' && error !== null && postponeSymbol in error
}
