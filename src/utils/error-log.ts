// Once-per-error server log guard. An SSR error can reach several log sites in one request (the renderer's
// inline report, then the top-level start/dev-server catch). Tag the error object the first time it is
// logged so the downstream catch skips its own `console.error` and each error surfaces once.
//
// The tag lives on the error itself (a non-enumerable symbol property), so it survives across log sites
// without a WeakSet keyed to a work unit - an error thrown outside any work-unit scope is still deduped. A
// non-Error throw cannot carry the tag; those are always logged.

const ERROR_LOGGED = Symbol.for('pnext.errorLogged')

/**
 * Mark `error` as logged. Returns true when this call was the FIRST to mark it (the caller should log), false
 * when it was already marked (skip the log). Non-object throws always return true - they cannot be tagged, so
 * they are never deduped.
 */
export function markErrorLogged(error: unknown): boolean {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) {
    return true
  }
  const holder = error as Record<symbol, unknown>
  if (holder[ERROR_LOGGED]) return false
  Object.defineProperty(error, ERROR_LOGGED, {
    value: true,
    enumerable: false,
    configurable: true,
    writable: true,
  })
  return true
}
