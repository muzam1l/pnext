// instrumentation-client registration (COMPAT).
//
// Wires the client instrumentation emulation onto the core seams:
//   - a BUILD STEP bundles the app's instrumentation-client.(ts|js), plus next.config
//     `instrumentationClientInject` entries in order, into `<out>/public/assets/instrumentation-client.js`.
//     Steps run before prerendering, so statically generated documents carry the tag too.
//   - documentHeadTags injects the `<script type="module">` loader tag - COMPOSED with whatever a previous
//     registrar installed, since setDocumentScriptExtensions overwrites per key. The orchestrator calls
//     this AFTER registerOtelExtensions.
//
// The router-side hook is surfaced through the `window.__PNEXT_ON_ROUTER_TRANSITION_START__` global the
// bundle registers; the client router calls it at the start of push/replace/traverse navigations.

import type { ResolvedConfig } from '../../config'
import { registerBuildSteps } from '../../extensions'
import { getDocumentScriptExtensions, setDocumentScriptExtensions } from '../../render/hooks'
import { nextCompatEnabled } from '../aliases'
import {
  buildInstrumentationClient,
  instrumentationClientHeadTag,
} from '../lifecycle/instrumentation-client'

export function registerInstrumentationClientExtensions(config: ResolvedConfig): void {
  if (!nextCompatEnabled(config)) return

  registerBuildSteps(async ctx => {
    await buildInstrumentationClient(ctx.config)
  })

  const previousHeadTags = getDocumentScriptExtensions().documentHeadTags
  setDocumentScriptExtensions({
    documentHeadTags: (cfg, ctx) =>
      `${previousHeadTags?.(cfg, ctx) ?? ''}${instrumentationClientHeadTag(cfg)}`,
  })
}
