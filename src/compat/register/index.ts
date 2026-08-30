// Compat registration entry point (COMPAT - may import core freely).
//
// registerCompatExtensions(config) is invoked exactly once, from the single core seam
// (src/compat-bootstrap.ts), when compat is enabled. It fans out to the per-domain sub-registrars, each
// in its OWN file. Each imports the real compat implementations and assigns them into the core
// registries in src/extensions.ts.
//
// Importing this module IS the expensive part of compat (the whole implementation graph), so the handful
// of facts core needs before its first compile live in ./register-boot, which the boot tier loads on its
// own. This file re-runs that registrar (idempotent) so calling it alone still yields a fully wired
// compat layer.

import type { ResolvedConfig } from '../../config'
import { registerCompatBootExtensions } from './boot'
import type * as BuildTier from './build-tier'
import { registerCacheExtensions } from './cache'
import { registerActionExtensions } from './actions'
import { registerRenderExtensions } from './render'
import { registerProxyExtensions } from './proxy'
import { registerConfigSource } from './config'
import { registerProtocolExtensions, registerProtocolRequestValidation } from './protocol'
import { registerLifecycleExtensions } from './lifecycle'
import { registerImageExtensions } from './image'
import { registerErrorExtensions } from './errors'
import { registerFontExtensions } from './font'
import { registerStaticImageExtensions } from './static-image'
import { registerUseCacheExtensions } from './use-cache'
import { registerClientErrorExtensions } from './client-errors'
import { registerPprExtensions } from './ppr'
import { registerMdxExtensions } from './mdx'
import { registerOtelExtensions, registerOtelRootInterceptor } from './otel'
import { registerInstrumentationClientExtensions } from './instrumentation-client'
import { registerMiscExtensions } from './taint'
import { registerCssExtrasExtensions } from './css-extras'
import { registerSegmentExtensions } from './segment'
import { registerBundlerExtensions } from './bundler'
import { registerPagesApiExtensions } from './pages-api'
import { registerEdgeRuntimeExtensions } from './edge-runtime'

export interface RegisterCompatOptions {
  /**
   * Serving only (the dev server). Skips the build-only domains — nothing on a
   * request path reads what they register — so their module graphs never load.
   */
  serve?: boolean
}

export async function registerCompatExtensions(
  config: ResolvedConfig,
  options: RegisterCompatOptions = {},
): Promise<void> {
  // Loaded up front so the calls below stay in their original order; skipped
  // outright when only serving (see RegisterCompatOptions.serve).
  const build: typeof BuildTier | undefined = options.serve
    ? undefined
    : await import('./build-tier')
  // Route conventions, page/CSS extensions, module aliases, proxy names and the
  // lifecycle init hooks — already done when the boot tier ran first.
  registerCompatBootExtensions(config)
  build?.registerBuildCompatExtensions()
  registerConfigSource()
  // The otel ROOT-span interceptor must run before every short-circuiting
  // interceptor (segment prefetch, RSC protocol, action dispatch) so those
  // responses are traced too; the rest of otel registers last (below).
  registerOtelRootInterceptor(config)
  // Protocol validation next: an invalid next-router-state-tree must 500 before
  // the segment/action interceptors answer the request.
  registerProtocolRequestValidation(config)
  // Typed-routes typegen and typecheck run before structural validation so a type error surfaces ahead of
  // runtime checks, matching `next build`, which runs tsc before its own validations. The typecheck only
  // covers .ts/.tsx pages/layouts/handlers via the generated validator, so JS-only fixtures still fall
  // through to the structural validation below with their runtime error message.
  build?.registerTypedRoutesExtensions(config)
  // Build validation fails fast before the remaining build steps run.
  build?.registerValidationExtensions(config)
  registerCacheExtensions(config)
  // Before actions: the /_tree prefetch responder must intercept ahead of the
  // action dispatch interceptor.
  registerSegmentExtensions(config)
  registerActionExtensions(config)
  registerPagesApiExtensions(config)
  registerEdgeRuntimeExtensions()
  registerRenderExtensions(config)
  registerProxyExtensions(config)
  registerProtocolExtensions(config)
  registerLifecycleExtensions(config)
  registerImageExtensions(config)
  registerErrorExtensions(config)
  registerFontExtensions(config)
  build?.registerMiddlewareExtensions()
  build?.registerExportExtensions(config)
  registerStaticImageExtensions()
  registerUseCacheExtensions(config)
  registerClientErrorExtensions(config)
  registerPprExtensions(config)
  registerMiscExtensions(config)
  registerBundlerExtensions(config)
  // After registerActionExtensions: composes (not clobbers) clientEsbuildPlugins.
  registerCssExtrasExtensions(config)
  // MDX last: it composes (not clobbers) clientEsbuildPlugins, so it must
  // capture every previously-registered plugin factory.
  registerMdxExtensions(config)
  // Otel after everything: its route re-stamp interceptor must observe the
  // post-rewrite request (the root span opens in the EARLY interceptor above).
  registerOtelExtensions(config)
  // After otel: composes (not clobbers) the documentHeadTags extension.
  registerInstrumentationClientExtensions(config)
}
