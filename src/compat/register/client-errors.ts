// Client error runtime registration (COMPAT, client half).
//
// The client error runtime (src/compat/client/errors/*) is a BROWSER module bundled into each compat
// client entry - like nav-compat and action-router it is imported and installed by the generated entry,
// not wired into a server render registry. There is therefore no server-side extension to assign here:
// this registrar exists as the single server-bootstrap wiring point and documents the entry-append
// contract. The compat entry already imports the route's nearest error.js and installs the action-error
// overlay; to activate the general client error pipeline it additionally calls installClientErrors.

import type { ResolvedConfig } from '../../config'
import { nextCompatEnabled } from '../../compat/aliases'

export function registerClientErrorExtensions(config: ResolvedConfig): void {
  if (!nextCompatEnabled(config)) return
  // No server-side render/routing extension: the client runtime installs in the
  // browser from the generated entry (seam 5, clientEntryModules). Kept as the
  // stable registration seam so the orchestrator can wire it uniformly.
}
