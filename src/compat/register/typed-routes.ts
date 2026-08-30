// Typed-routes codegen registration (COMPAT - may import core freely). Wires a build step into
// buildExtensions.steps that emits Next-shaped route type definitions under
// `<root>/.next/types/{routes.d.ts,link.d.ts,validator.ts}`. Runs during a build under compat.next;
// pure-core apps register nothing.

import type { ResolvedConfig } from '../../config'
import {
  registerBuildParallelPhases,
  registerBuildSteps,
  type BuildStepContext,
} from '../../extensions'
import { legacyRequestAPIs } from '../../request/context'
import type { RouteManifestEntry } from '../../types'
import { nextCompatEnabled } from '../aliases'
import { writeTsconfigDefaults } from '../tsconfig-defaults'
import { typecheckDisabled, validateTypesOffThread } from '../typecheck/check'
import { generateTypedRoutes } from '../typed-routes/generate'

export function registerTypedRoutesExtensions(_config: ResolvedConfig): void {
  registerBuildSteps(runTypedRoutesBuildStep)
}

async function runTypedRoutesBuildStep(ctx: BuildStepContext): Promise<void> {
  if (!nextCompatEnabled(ctx.config)) return
  // Legacy (Next-14 era) apps keep their tsconfig untouched; current apps get Next's defaults.
  if (!legacyRequestAPIs()) await writeTsconfigDefaults(ctx.config)
  await generateTypedRoutes(ctx.config, ctx.routes as RouteManifestEntry[])
  // The typecheck reads only files that already exist on disk, so it runs on a worker thread
  // alongside client bundling and prerendering rather than ahead of them; the CLI awaits it before
  // the summary. A build that disables it reports no line at all.
  if (typecheckDisabled()) return
  const startedAt = performance.now()
  registerBuildParallelPhases({
    name: 'Typecheck',
    run: validateTypesOffThread(ctx.config).then(() => performance.now() - startedAt),
  })
}
