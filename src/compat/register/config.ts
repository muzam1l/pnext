// Config-source registration (COMPAT - may import core freely).
//
// registerConfigSource() wires the next.config.* loader into the core configSources seam. It runs earlier
// than the other compat sub-registrars: loadConfig invokes it lazily, before bootstrapCompat, so the
// next.config values feed pnext's resolved config for build AND start/dev. The orchestrator must call
// this from register.ts too, so a single registerCompatExtensions() pass leaves the source installed.

import { registerConfigSource as registerCoreConfigSource } from '../../config'
import type { ConfigSourceOverrides } from '../../config'
import { loadNextConfig } from '../next/config-loader'

export function registerConfigSource(): void {
  registerCoreConfigSource(async (root, options): Promise<ConfigSourceOverrides> => {
    const { overrides } = await loadNextConfig(root, options)
    return overrides
  })
}
