// Action extension registration (COMPAT - may import core freely).
//
// Wires next/actions compat behavior into the core extension registries so core never statically imports
// compat/actions/* or compat/next/rewrites:
//   - buildExtensions.steps                      <- action discovery/bundling + server-reference manifest
//   - requestExtensions.interceptors             <- action dispatch, then next.config rewrites
//   - renderExtensions.serializeServerActionProp <- action id policy
//   - bundlerExtensions.clientEsbuildPlugins     <- action client-stub plugin
//
// The request interceptors read the live per-server routing state core publishes via
// routing/request-environment.ts and call core render/import helpers directly (compat to core is allowed),
// so the thin `{ config }` interceptor context stays unchanged.
//
// The implementation (build step, interceptors, render extension, dev/prod registry arming) lives in
// ../actions/extensions; this module just wires it into the extension registries.

import type { ResolvedConfig } from '../../config'
import {
  registerBuildSteps,
  registerInitHooks,
  registerOutsideBasePathInterceptors,
  registerRequestInterceptors,
  registerServerSourceTransforms,
  setBundlerExtensions,
  setRenderExtensions,
  withSniff,
} from '../../extensions'
import { setActionModuleExtensions } from '../../render/hooks'
import { getRequestRuntime } from '../../routing/request-environment'
import { setClientActionBundler } from '../../dev/client-actions'
import {
  actionClientStubPlugin,
  actionStubSourceFor,
  clientActionModulesRoot,
  isClientActionModule,
  loadClientActionSource,
} from '../actions/client-plugin'
import { validateServerActionsConfigSync } from '../actions/config'
import { hoistNonCapturingInlineActions } from '../actions/hoist'
import { rewriteAnonymousInlineActionMarks, rewriteInlineActionTags } from '../actions/rewrite'
import {
  actionDispatchInterceptor,
  ensureActionsRegistered,
  redirectInterceptor,
  rewriteInterceptor,
  runActionBuildStep,
  serializeServerActionProp,
  tagActionModuleExports,
  tagActionModulesForRender,
} from '../actions/extensions'

export function registerActionExtensions(_config: ResolvedConfig): void {
  // Discovery reads config + source text only, so it runs under the route-facts
  // scan; the client bundle is the one thing that waits on its stub set.
  runActionBuildStep.early = true
  registerBuildSteps(runActionBuildStep)
  // Validate serverActions.bodySizeLimit at build + start startup (Next fails
  // the CLI with the exact size-limit error before serving), rather than only
  // lazily on the first action request.
  registerInitHooks(config => validateServerActionsConfigSync(config.root))
  // Ordering matches the old servers: action dispatch first (on the requested
  // pathname), then next.config redirects (short-circuit before routing), then
  // rewrites swap the request for downstream matching / static-lookup /
  // staleness.
  registerRequestInterceptors(actionDispatchInterceptor, redirectInterceptor, rewriteInterceptor)
  // The same two rules also serve requests from outside the basePath, where only
  // their `basePath: false` entries apply (both interceptors partition their
  // rules on ctx.outsideBasePath).
  registerOutsideBasePathInterceptors(redirectInterceptor, rewriteInterceptor)
  // Tag MODULE-SCOPE inline 'use server' functions with React-compatible `$$id` metadata at module-eval
  // time. Without this, top-level inline actions that module-scope code introspects - Next's version-skew
  // fixtures read and override `fn.$$id` - throw at import. Runs on the server graph only; module-level
  // 'use server' files are skipped by the transform. Anonymous inline actions get no id, only a mark: the
  // compiled function loses its directive, so this is what tells serialization it is an action and not a
  // client handler. Hoisting runs FIRST: it lifts capture-free anonymous inline actions to module-scope
  // declarations, which the tag pass then gives stable `if:` ids, taking the whole-route recovery render
  // off the action's critical path for pages served from prebuilt HTML.
  const inlineActionSniff = ['use server']
  registerServerSourceTransforms(
    withSniff(inlineActionSniff, source => hoistNonCapturingInlineActions(source)),
    withSniff(inlineActionSniff, (source, file, root) =>
      rewriteInlineActionTags(source, file, root),
    ),
    withSniff(inlineActionSniff, source => rewriteAnonymousInlineActionMarks(source)),
  )
  setRenderExtensions({ serializeServerActionProp })
  // Tag imported action-module function exports with their stable wire id so a
  // <form action={serverAction}> imported straight into a page (same module
  // singleton) serializes to that module id instead of a per-render inline id.
  setActionModuleExtensions({ tagActionModuleExports, tagActionModulesForRender })
  // Prod/plain client builds swap 'use server' imports for the RPC stub via
  // the standalone esbuild plugin (client/build.ts appends these). No-op for
  // pure-core / non-next apps.
  setBundlerExtensions({ clientEsbuildPlugins: () => [actionClientStubPlugin()] })
  // The dev route-client bundle resolves modules into its own esbuild namespace
  // that a standalone plugin can't intercept, so dev/imports reads this holder
  // instead. ensureArmed runs the discovery dev startup/reload used to run
  // inline, lazily per dev import version.
  setClientActionBundler({
    ensureArmed: async () => {
      const runtime = getRequestRuntime()
      if (runtime?.dev) await ensureActionsRegistered(runtime)
    },
    isClientActionModule,
    stubSource: file => actionStubSourceFor(file, clientActionModulesRoot() ?? undefined),
    loadClientSource: (file, root) => loadClientActionSource(file, root),
  })
}
