// Error/404 pipeline registration (COMPAT).
//
// Wires the Next error-boundary behaviors into the core render/routing registries at the gated bootstrap
// seam: serializeError gets the digest protocol plus prod message redaction, and routeConventions gets
// global-error / global-not-found boundary discovery. A pure-core app registers none of these, keeping
// the compact core error UI and no digest/redaction.

import type { ResolvedConfig } from '../../config'
import { setRenderExtensions } from '../../extensions'
import { nextCompatEnabled } from '../../compat/aliases'
import {
  serializeBoundaryError,
  wrapThrownValue,
  formatErrorLog,
} from '../lifecycle/error-serialize'
import {
  httpAccessFallbackUi,
  defaultGlobalErrorUi,
  globalErrorReportScript,
} from '../lifecycle/error-ui'
import { getNextConfig } from '../next/config-loader'

// global-error / global-not-found are CORE document conventions (discovered by
// src/routing/routes.ts findGlobalError + src/render renderGlobalNotFoundResponse);
// compat only skins the Next-pixel-exact default UI strings/markup and the
// digest protocol here. forbidden/unauthorized stay compat conventions
// (registered in register-routing.ts).
export function registerErrorExtensions(config: ResolvedConfig): void {
  if (!nextCompatEnabled(config)) return

  setRenderExtensions({
    serializeError: serializeBoundaryError,
    httpAccessFallbackUi,
    defaultGlobalErrorUi,
    globalErrorReportScript,
    wrapThrownValue,
    formatErrorLog,
    // Read lazily per call: next.config loads after registration.
    globalNotFoundEnabled: () => {
      const experimental = getNextConfig().experimental as { globalNotFound?: boolean } | undefined
      return experimental?.globalNotFound === true
    },
  })
}
