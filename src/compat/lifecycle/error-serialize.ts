// Error serialization for boundaries (COMPAT).
//
// Implements RenderExtensions.serializeError: Next's digest protocol plus prod message redaction for
// the `{ name, message, digest }` object handed to an error.js / global-error.js boundary.
//
//   - A user-supplied `.digest` string passes through unchanged.
//   - A real server error without a digest gets a stable hash digest.
//   - In production the message is redacted to React's minified #441 text; in dev the original message
//     survives (non-Error throws arrive as 'undefined' / 'null' upstream).
//
// NOTE: this function must NOT log the error to the server console. Core's renderer already logs the
// render error exactly once right before it calls serializeError(); logging here too double-prints it.

import type { SerializeErrorContext, SerializedError } from '../../extensions'
import {
  isTaggedPrimitiveThrow,
  tagPrimitiveThrow,
  untagPrimitiveThrow,
} from '../client/errors/primitive-throw'

// React's production redaction text for RSC render errors (#441). Boundary
// suites assert this verbatim in prod.
const REDACTED_MESSAGE =
  'Minified React error #441; visit https://react.dev/errors/441 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.'

// Next uses next/dist/compiled/string-hash; any stable non-negative hash whose
// decimal string matches /\w+/ satisfies the compat assertions.
function stableDigest(input: string): string {
  let hash = 5381
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i)
  }
  return (hash >>> 0).toString()
}

function customDigest(error: Error): string | undefined {
  const digest = (error as { digest?: unknown }).digest
  return typeof digest === 'string' && digest.length > 0 ? digest : undefined
}

// Next appends an error-code suffix to the hash digest when the thrown value
// was not an Error: prod RSC wraps a nullish throw and reports `@E394`
// (test/e2e/app-dir/errors asserts `digest: '<hash>@E394'` in the prod log).
function digestSuffix(error: Error): string {
  if (!isTaggedPrimitiveThrow(error)) return ''
  const raw = untagPrimitiveThrow(error)
  return raw === null || raw === undefined ? '@E394' : ''
}

/**
 * RenderExtensions.wrapThrownValue: wrap a non-Error server throw the way Next's RSC transport does -
 * `Error: <String(value)>` with the synthetic `at stringify (<anonymous>)` stack frame the prod log
 * snapshot asserts, and the raw value tagged so the digest picks up the nullish suffix.
 */
export function wrapThrownValue(value: unknown): Error {
  const error = tagPrimitiveThrow(value)
  error.stack = `Error: ${error.message}\n    at stringify (<anonymous>)`
  return error
}

/**
 * RenderExtensions.formatErrorLog: Next's prod server-log shape for a render error - the error's
 * inspected form with the digest as an own property, asserted byte-exact by the errors suite's inline
 * snapshots.
 */
export function formatErrorLog(trace: string, digest: string, error?: Error): string {
  // An error funneled out of a 'use cache' scope carries Next's environment tag;
  // util.inspect prints it before the digest, so the log must too.
  const environmentName = (error as { environmentName?: unknown } | undefined)?.environmentName
  const environment =
    typeof environmentName === 'string' ? `  environmentName: '${environmentName}',\n` : ''
  return `⨯ ${trace} {\n${environment}  digest: '${digest}'\n}`
}

export function serializeBoundaryError(ctx: SerializeErrorContext): SerializedError {
  const { error, dev } = ctx
  const custom = customDigest(error)
  const digest =
    custom ?? stableDigest(`${error.message}${error.stack ?? ''}`) + digestSuffix(error)

  // Boundary components render `${error}` (e.g. `Global error: ${error}`), so
  // the prop must stringify as `Error: <message>` like React's transported
  // error. Return a real Error carrying the (possibly redacted) message + digest.
  const boundaryError = new Error(dev ? error.message : REDACTED_MESSAGE) as Error & {
    digest?: string
  }
  boundaryError.name = error.name || 'Error'
  boundaryError.digest = digest
  boundaryError.stack = undefined
  return boundaryError
}
