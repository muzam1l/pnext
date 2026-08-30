import { nextCompatEnabled } from '../../compat/aliases'
import { onExtensionHostReset, registerBuildCompleteHooks } from '../../extensions'
import type { ResolvedConfig } from '../../config'
import { emitMetadataRouteArtifacts } from '../metadata-artifacts'
import { emitStaticExport } from '../export/emit'
import { emitCustomServerShim } from '../next/custom-server'

let registered = false
// Host-scoped guard: a fresh host must be registered into again.
onExtensionHostReset(() => (registered = false))

export function registerExportExtensions(config: ResolvedConfig): void {
  if (registered) return
  if (!nextCompatEnabled(config)) return
  registered = true

  registerBuildCompleteHooks(async ctx => {
    if (!nextCompatEnabled(ctx.config)) return
    await emitStaticExport(ctx)
    await emitMetadataRouteArtifacts(ctx)
    await emitCustomServerShim(ctx.config)
  })
}
