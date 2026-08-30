// Misc long-tail compat cluster registration (COMPAT).
//
// The misc singletons in this cluster (temporary-references, actions-streaming) hook the server-action
// return path directly through the shared action endpoint, and their client counterparts live inline in
// the action-client runtime bundle - there is no core registry seam to populate for them. The rest of the
// cluster is satisfied by existing core/compat behavior, so this registrar is a stable no-op hook.
//
// Kept as an explicit registrar rather than nothing, so future misc features that DO need a registry
// have an owned place to register without touching another file.

import type { ResolvedConfig } from '../../config'
import { taintObjectReference } from '../../utils/serialize'
import { getNextConfig } from '../next/config-loader'

// Next's `experimental.taint` message for a `process.env` reference reaching a
// client component (asserted verbatim by test/e2e/app-dir/taint in dev; prod
// sees the redacted React #441 text via the normal boundary error path).
const PROCESS_ENV_TAINT_MESSAGE =
  'Do not pass process.env to Client Components since it will leak sensitive data'

// Prod redacts every RSC serialization error to React's minified #441 text
// (test/e2e/app-dir/taint asserts this verbatim for a production build).
const REDACTED_RSC_ERROR_MESSAGE =
  'Minified React error #441; visit https://react.dev/errors/441 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.'

export function registerMiscExtensions(_config: ResolvedConfig): void {
  // No registry wiring required for the current misc cluster; behavior is
  // activated via direct imports in the action endpoint + client runtime.
  registerTaintedReferences()
}

/**
 * `experimental.taint`: React's taint APIs do not exist under preact, so the client-props serializer
 * enforces the same contract by identity - registering `process.env` makes any client-component prop that
 * IS that object throw.
 */
function registerTaintedReferences(): void {
  const experimental = getNextConfig().experimental as { taint?: unknown } | undefined
  if (experimental?.taint !== true) return
  taintObjectReference(
    { dev: PROCESS_ENV_TAINT_MESSAGE, prod: REDACTED_RSC_ERROR_MESSAGE },
    process.env,
  )
}
