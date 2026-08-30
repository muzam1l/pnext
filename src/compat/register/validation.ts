// Build-time validation registration (COMPAT - may import core freely).
//
// Registers a single build step that runs the Next-compatible validation pass over the scanned route
// table. A validation failure throws PnextBuildValidationError, aborting the build with Next's exact
// error string on stderr, which the Next e2e suites substring-match.
//
// The step is ordered FIRST among build steps (registered before action discovery) so validation fails
// fast, before any bundling or prerender work. Registration is idempotent and no-op for pure-core apps.

import type { ResolvedConfig } from '../../config'
import { nextCompatEnabled } from '../../compat/aliases'
import {
  onExtensionHostReset,
  registerBuildSteps,
  setBuildCompatExtensions,
  type BuildStep,
} from '../../extensions'
import type { RouteManifestEntry } from '../../types'
import { writeBuildFlags } from '../cache/build-flags'
import { validateBuild } from '../validation/validate'
import {
  diagnoseCacheComponentsPrerender,
  diagnosticLeadsWithErrorLine,
  prerenderFailureFooter,
} from '../validation/prerender-diagnostics'

let registered = false
// Host-scoped guard: a fresh host must be registered into again.
onExtensionHostReset(() => (registered = false))

export function registerValidationExtensions(config: ResolvedConfig): void {
  if (registered) return
  if (!nextCompatEnabled(config)) return
  registered = true

  const step: BuildStep = async ctx => {
    // Runtime compat gate: the extension registry is process-global, so once any compat.next build
    // registers this step it stays registered for every later buildProject() in the same process -
    // including pure-core fixtures that legitimately have no root layout. Re-check enablement per build so
    // validation only runs for the app that actually enabled compat.next.
    if (!nextCompatEnabled(ctx.config)) return
    await ctx.log.step('validate build', () =>
      Promise.resolve(validateBuild(ctx.config, ctx.routes as RouteManifestEntry[])),
    )
  }
  // Gate step: validation diagnostics must beat any error the invalid app would
  // otherwise raise first from bundling or the not-found prerender.
  step.gate = true
  registerBuildSteps(step)
  setBuildCompatExtensions({
    diagnoseCacheComponentsPrerender,
    diagnosticLeadsWithErrorLine,
    prerenderFailureFooter,
    recordBuildFlags: writeBuildFlags,
  })
}
