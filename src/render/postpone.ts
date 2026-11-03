// Client-safe postpone primitives (CORE), apart from ppr.ts so client code never pulls node:async_hooks.

const postponeSymbol = Symbol.for('pnext.postpone')

/** Runtime data a postpone waits on, as bits: what a runtime request fills that a static prerender cannot. */
export const RUNTIME_SESSION = 1 // cookies, headers, private or omitted caches: a runtime shell fills it
export const RUNTIME_URL = 2 // searchParams: only a runtime prefetch fills it
export const RUNTIME_PARAMS = 4 // fallback params: URL data unless ISR upgrades the shell
export const RUNTIME_SHELL = 8 // session data the App Shell stage read

export class PostponeError extends Error {
  readonly [postponeSymbol] = true
  constructor(
    readonly api: string,
    readonly runtime = 0,
  ) {
    super(`${api} postponed for partial prerendering`)
    this.name = 'PostponeError'
  }
}

export function isPostpone(error: unknown): error is PostponeError {
  return typeof error === 'object' && error !== null && postponeSymbol in error
}
