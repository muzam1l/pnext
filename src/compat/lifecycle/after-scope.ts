// after() request-API phase rules (COMPAT).
//
// When a page render schedules after() work, the callback runs detached: there is no request scope, so
// headers()/cookies()/connection() must throw Next's exact "Route <path> used `<api>()` inside
// `after()`. This is not supported." message. In a route handler or server action, the same APIs called
// inside after() work because the async context captured a live request scope, so those cases never
// reach this guard.
//
// The route pathname is stashed on the work unit at request start so the detached callback can name it.

import { AsyncLocalStorage } from 'node:async_hooks'
import { currentRequest, getWorkUnit } from '../../request/context'

const REQUEST_PATH_KEY = Symbol.for('pnext.requestPath')
const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom')
const requestApiScope = new AsyncLocalStorage<boolean>()

/** Run one after() task with its request-API capability. */
export function runWithAfterRequestApiScope<T>(allowed: boolean, callback: () => T): T {
  return requestApiScope.run(allowed, callback)
}

/** Whether the current after() task may use request APIs. */
export function afterRequestApisAllowed(): boolean {
  return requestApiScope.getStore() === true
}

/** Stash the request pathname on the active work unit for after() diagnostics. */
export function recordRequestPath(pathname: string): void {
  const unit = getWorkUnit()
  if (unit) (unit.compat ??= {})[REQUEST_PATH_KEY] = pathname
}

function currentRoutePath(): string {
  const recorded = getWorkUnit()?.compat?.[REQUEST_PATH_KEY] as string | undefined
  if (recorded) return recorded
  try {
    const request = currentRequest()
    return request ? new URL(request.url).pathname : ''
  } catch {
    return ''
  }
}

// Returns an Error-shaped object rather than a real `new Error`: the app's
// `catch (err) { console.error(..., err) }` prints it as `Error: <message>`
// with no misleading pnext-internal stack frame (the suite matches the message
// text exactly). Typed as Error so throw sites satisfy `only-throw-error`.
export function lifecycleError(message: string): Error {
  const formatted = `Error: ${message}`
  return {
    name: 'Error',
    message,
    stack: formatted,
    toString: () => formatted,
    [INSPECT_CUSTOM]: () => formatted,
  } as unknown as Error
}

const stageSuffix = (api: string, purpose: string) =>
  ` The \`${api}\` function is used to indicate the subsequent code ${purpose}, but \`after()\` executes after the request, so this function is not allowed in this scope. See more info here: https://nextjs.org/docs/app/api-reference/functions/after`
const AFTER_SUFFIX: Partial<Record<string, string>> = {
  'headers()': ' This is not supported.',
  'cookies()': ' This is not supported.',
  'navigation()': stageSuffix('navigation()', 'must only run during an actual navigation'),
  'prefetch()': stageSuffix('prefetch()', 'must not run in the app shell'),
}

/**
 * Throw Next's "used inside after()" error when a request API is accessed from a
 * detached after() callback (render phase, no live request scope). Returns
 * without throwing in every legal case so callers proceed to the normal path.
 */
export function assertRequestApiAllowedInAfter(
  api: 'headers()' | 'cookies()' | 'connection()' | 'io()' | 'navigation()' | 'prefetch()',
): void {
  const unit = getWorkUnit()
  if (unit?.phase !== 'after') return
  // Rendering keeps a synthetic request context during prerendering, so the
  // explicit after-task capability—not merely currentRequest()—defines this.
  if (afterRequestApisAllowed() && currentRequest()) return
  const suffix = AFTER_SUFFIX[api] ?? ''
  throw lifecycleError(
    `Route ${currentRoutePath()} used \`${api}\` inside \`after()\` while rendering.${suffix}`,
  )
}

/**
 * draftMode() stays readable inside after(), but .enable()/.disable() throw in
 * every context (Next's exact message names the route + method).
 */
export function assertDraftModeToggleAllowedInAfter(method: 'enable' | 'disable'): void {
  if (getWorkUnit()?.phase !== 'after') return
  throw lifecycleError(
    `Route ${currentRoutePath()} used "draftMode().${method}()" inside \`after()\``,
  )
}
