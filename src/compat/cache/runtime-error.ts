// Runtime `use cache` error funnel (COMPAT).
//
// In Next a cached function runs in its own `Cache` environment: an error it throws is serialized
// across the cache flight boundary and only reaches the render as a DESERIALIZED error. That changes
// what the server logs and what the calling component catches, and the cache-components-errors suite
// inline-snapshots both:
//
//   --debug-prerender  the real error survives, with the cache-side user frames plus the flight
//                      client's, `environmentName: 'Cache'` and a digest. Nothing is logged at the throw
//                      site: whoever observes it logs it.
//   plain production   the real error is logged AT the cache boundary (Next's prod shape, minified
//                      frames), and the caller only sees React's redacted "An error occurred in the
//                      Server Components render." error carrying the same digest. That redacted error
//                      is pre-marked as logged so an escape does not print a second block.
//
// Dev keeps the raw error untouched, so the redbox can map it back to source.

import {
  isForbiddenError,
  isNotFoundError,
  isRedirectError,
  isUnauthorizedError,
} from '../../api/navigation'
import { isPostpone } from '../../render/postpone'
import { markErrorLogged } from '../../utils/error-log'
import {
  cacheRuntimeErrorFrames,
  formatCacheRuntimeErrorStack,
  RSC_REDACTED_RUNTIME_MESSAGE,
} from '../validation/prerender-diagnostics'
import { servedBuildFlags } from './build-flags'

/** Already-funneled errors carry this tag: a nested cache scope reshapes once. */
const SHAPED = Symbol.for('pnext.compat.cacheRuntimeErrorShaped')

/**
 * Signals that only LOOK like a throw: a postpone (a request API or cacheLife hanging inside the cache
 * scope during a partial prerender), a navigation intent (redirect/notFound/forbidden/unauthorized), a
 * dynamic bailout. They are protocol, not failure - the renderer matches on their identity, so
 * reshaping one into a redacted Error breaks the render it was steering.
 */
function isControlFlowSignal(error: unknown): boolean {
  if (
    isPostpone(error) ||
    isRedirectError(error) ||
    isNotFoundError(error) ||
    isForbiddenError(error) ||
    isUnauthorizedError(error)
  ) {
    return true
  }
  const digest = (error as { digest?: unknown }).digest
  return typeof digest === 'string' && digest.startsWith('DYNAMIC_SERVER_USAGE')
}

/**
 * Reshape an error thrown inside a 'use cache' scope at runtime into the error
 * Next's cache flight boundary hands back, logging the production form at the
 * boundary. Returns the value to rethrow (unchanged outside compat/production).
 */
export function funnelCacheRuntimeError(error: unknown): unknown {
  if (!(error instanceof Error)) return error
  if (isControlFlowSignal(error)) return error
  // Only a served production build funnels errors: a dev server has no build
  // flags to read and keeps the raw error so the redbox can map it to source.
  const flags = servedBuildFlags()
  if (!flags) return error
  const holder = error as Error & Record<symbol, unknown>
  if (holder[SHAPED]) return error
  Object.defineProperty(error, SHAPED, { value: true, configurable: true })

  const digest = cacheErrorDigest(error)
  if (flags.debugPrerender) {
    error.stack = formatCacheRuntimeErrorStack(
      error.message,
      cacheRuntimeErrorFrames(error.stack ?? ''),
      true,
    )
    // Enumerable so util.inspect (the console format Next's snapshots capture)
    // prints them in this order: environmentName first, then digest.
    define(error, 'environmentName', 'Cache')
    define(error, 'digest', digest)
    return error
  }

  console.error(
    `⨯ ${formatCacheRuntimeErrorStack(error.message, [], false)} {\n  digest: '${digest}'\n}`,
  )
  const redacted = new Error(RSC_REDACTED_RUNTIME_MESSAGE)
  // No frames: React's transported error has none, and util.inspect then prints
  // the `[Error: …] { digest }` form the suite snapshots.
  redacted.stack = `Error: ${RSC_REDACTED_RUNTIME_MESSAGE}`
  define(redacted, 'digest', digest)
  Object.defineProperty(redacted, SHAPED, { value: true, configurable: true })
  // The real error was just logged; an escape of the redacted one must not add
  // a second `⨯` block to the server output.
  markErrorLogged(redacted)
  return redacted
}

function define(error: Error, key: string, value: string): void {
  Object.defineProperty(error, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

/**
 * Next's digest is a string-hash of the error, printed as decimal digits (the
 * suite normalizes the value but asserts the shape). A user-supplied digest
 * wins, mirroring the boundary serializer.
 */
function cacheErrorDigest(error: Error): string {
  const custom = (error as { digest?: unknown }).digest
  if (typeof custom === 'string' && custom.length > 0) return custom
  const input = `${error.message}${error.stack ?? ''}`
  let hash = 5381
  for (let index = 0; index < input.length; index++) {
    hash = (hash * 33) ^ input.charCodeAt(index)
  }
  return (hash >>> 0).toString()
}
