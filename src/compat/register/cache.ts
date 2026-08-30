// Cache extension registration (COMPAT - may import core freely).
//
// Wires the next/cache compat behavior into the core extension registries so core never statically
// imports compat/cache/*:
//   - renderExtensions.collectRenderMeta       <- collectRenderCacheMeta
//   - requestExtensions.staticStaleness        <- pathRevalidatedSince + tagsRevalidatedSince
//   - buildExtensions.initHooks                <- installCompatFetchCache (next only)
//   - bundlerExtensions.serverSourceTransforms <- rewriteUseCacheSource
//
// Ordering: registerCompatExtensions runs cache BEFORE actions, so the use-cache source transform is
// registered ahead of the inline-action-tag transform, matching the old rewriteServerSource order.

import type { ResolvedConfig } from '../../config'
import { nextCompatEnabled } from '../../compat/aliases'
import {
  registerBundledSourceTransforms,
  registerInitHooks,
  registerServerSourceTransforms,
  setRenderExtensions,
  setRequestExtensions,
  withSniff,
} from '../../extensions'
import {
  collectRenderCacheMeta,
  currentRenderCacheMeta,
  pathRevalidatedSince,
  pathRevalidationReasonSince,
  tagsRevalidatedSince,
  tagsRevalidationReasonSince,
  tagsStaleSince,
} from '../cache/revalidate'
import { setBuildFlagsOutPath } from '../cache/build-flags'
import { installCompatFetchCache } from '../cache/fetch-patch'
import { installCustomCacheHandler } from '../cache/custom-handler'
import { installModernCacheHandlers } from '../cache/modern-handler'
import { rewriteUseCacheSource } from '../cache/use-cache-transform'
import { resumeDataCacheExtension } from '../cache/resume-data-cache'

export function registerCacheExtensions(config: ResolvedConfig): void {
  // Render cache-meta collection scope (tags/revalidate/no-store) wrapped
  // around every prerender + dynamic render; signature matches the registry.
  setRenderExtensions({
    collectRenderMeta: collectRenderCacheMeta,
    // Peek (never consume) the render's aggregated cacheLife stale window, so
    // the document can inline its own reuse window for hard loads.
    currentCacheStaleSeconds: () => currentRenderCacheMeta()?.staleSeconds,
    prerenderSidecar: resumeDataCacheExtension,
  })

  // ISR on-demand staleness: fold the path + tag revalidation checks start.ts
  // used to OR together into the single registry predicate.
  setRequestExtensions({
    staticStaleness: (pathname, mtimeMs, tags) =>
      pathRevalidatedSince(pathname, mtimeMs) || tagsRevalidatedSince(tags, mtimeMs),
    staticStalenessReason: (pathname, mtimeMs, tags) =>
      pathRevalidationReasonSince(pathname, mtimeMs) ??
      tagsRevalidationReasonSince(tags, mtimeMs) ??
      (tagsStaleSince(tags, mtimeMs) ? 'soft' : undefined),
  })

  // 'use cache' source rewrite (server bundles): registered first so it runs
  // before the inline-action-tag transform, exactly as before. Also registered
  // over bundled vendor output — a package can ship 'use cache' functions, and
  // the directive is the one trigger in the chain that survives bundling.
  const useCache = withSniff(['use cache'], (source, file, root) =>
    rewriteUseCacheSource(source, file, root),
  )
  registerServerSourceTransforms(useCache)
  registerBundledSourceTransforms(useCache)

  // Prerenders + runtime renders must observe Next fetch-cache options
  // (force-cache, next: { revalidate, tags }). Idempotent; next-compat only.
  if (nextCompatEnabled(config)) {
    registerInitHooks(cfg => {
      installCompatFetchCache()
      // Where `pnext start` reads the build's --debug-prerender flag back from
      // (the runtime 'use cache' error funnel shapes its log around it).
      setBuildFlagsOutPath(cfg.outPath)
      // Load + instantiate the configured `cacheHandler` (next.config) and
      // install it into the core cache seam so the data cache defers to it.
      installCustomCacheHandler(cfg.root)
      installModernCacheHandlers(cfg.root)
    })
  }
}
