// Pages-router API/data serving registration (COMPAT - may import core freely).
// The implementation (Node req/res shims, API-route and data-fetch dispatch)
// lives in ../pages/api; this module just wires it into the extension registries.

import type { ResolvedConfig } from '../../config'
import { nextCompatEnabled } from '../../compat/aliases'
import { registerRequestInterceptors, registerRevalidateBypassToken } from '../../extensions'
import { PREVIEW_MODE_ID, pagesApiInterceptor, pagesDataInterceptor } from '../pages/api'

export function registerPagesApiExtensions(config: ResolvedConfig): void {
  if (!nextCompatEnabled(config)) return
  // Registered after the action/rewrite interceptors (register.ts order), so a
  // data request rewritten by middleware or next.config lands here with its
  // destination URL already resolved.
  registerRequestInterceptors(pagesApiInterceptor, pagesDataInterceptor)
  // The preview-mode id written into prerender-manifest.json: requests carrying
  // it in x-prerender-revalidate are on-demand revalidations (middleware skip +
  // x-nextjs-cache: REVALIDATED — see cli/start.ts).
  registerRevalidateBypassToken(() => PREVIEW_MODE_ID)
}
