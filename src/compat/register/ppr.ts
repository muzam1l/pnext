// PPR / cacheComponents / root-params registration (COMPAT).
//
// Wires the PPR-stack compat behavior into core: the core cacheComponents flag is set per config load,
// and routingExtensions.usageDetection learns that io() usage marks a route dynamic.
//
// The global `cacheComponents` flag turns the existing shell+resume path into the default for every
// route, and switches request APIs (cookies/headers/connection/params/searchParams/io) to hanging
// promises that postpone at the first await inside a boundary. Idempotent.

import type { ResolvedConfig } from '../../config'
import { nextCompatEnabled } from '../../compat/aliases'
import { onExtensionHostReset, registerBuildSteps, registerUsageDetectors } from '../../extensions'
import type { RouteManifestEntry } from '../../types'
import { cacheComponents } from '../../render/ppr'
import { validateRootParamsProvided } from '../ppr/missing-root-params'

let registered = false
// Host-scoped guard: a fresh host must be registered into again.
onExtensionHostReset(() => (registered = false))

export function registerPprExtensions(config: ResolvedConfig): void {
  if (registered) return
  if (!nextCompatEnabled(config)) return
  registered = true

  // The core cacheComponents flag is NOT set here: registration is a process
  // one-shot, so it is derived per config load in next/config-loader's
  // setNextConfig() instead.

  // next/root-params named imports -> default-Proxy member reads: run by the
  // next/font pre-transform (compat/aliases.ts), which is registered for the same
  // `compat.next` apps and fires ahead of the static-import alias rewrite. A
  // second registration here would only ever re-scan an already-rewritten
  // source, so this file registers none.

  // `io()` (from next/server) makes a route request-dependent under
  // cacheComponents, so a route awaiting it is a PPR candidate rather than a
  // pure static build. Reuses the generic usage-detection seam.
  registerUsageDetectors(
    source =>
      cacheComponents() &&
      /\bio\s*\(\s*\)/.test(source) &&
      (source.includes('next/server') || source.includes('next/cache')),
  )

  // cacheComponents build guard: a root param (a dynamic segment at/above a
  // root layout) with no generateStaticParams value is a hard build error. The
  // registry is process-global, so re-check enablement per build (a later
  // pure-core buildProject in the same process must not run this).
  registerBuildSteps(async ctx => {
    if (!cacheComponents()) return
    await ctx.log.step('validate root params', () =>
      validateRootParamsProvided(ctx.config, ctx.routes as RouteManifestEntry[]),
    )
  })
}
