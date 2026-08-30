// HTTP protocol finalizer registration (COMPAT - may import core freely). registerProtocolExtensions()
// appends the compat responseFinalizers (Vary merge, x-nextjs-rewritten-path/query) into the core
// registry. No-op when compat.next is off.

import type { ResolvedConfig } from '../../config'
import {
  registerRequestInterceptors,
  registerResponseFinalizers,
  setRouterProtocolExtensions,
} from '../../extensions'
import { cacheControlFinalizers } from '../cache-control'
import { protocolFinalizers, protocolInterceptors } from '../protocol'
import { registerResourceHintFinalizer } from '../next/resource-hints'

/**
 * The router-state-tree validation interceptor, registered on its own so the
 * orchestrator can put it AHEAD of every short-circuiting interceptor (segment
 * prefetch, action dispatch): a malformed tree must fail the request before any
 * of them answers it.
 */
export function registerProtocolRequestValidation(config: ResolvedConfig): void {
  registerRequestInterceptors(...protocolInterceptors(config))
}

export function registerProtocolExtensions(config: ResolvedConfig): void {
  setRouterProtocolExtensions({
    prefetchRequestHeaders: () => ['next-router-prefetch'],
    // Next's partial prefetch: a default (`next-router-prefetch: 1`) router prefetch never runs dynamic
    // data - it gets the static shell with the loading/Suspense fallbacks in place. A route opting into
    // runtime prefetching serves its runtime-prefetchable content on prefetch instead, and a full prefetch
    // (`prefetch={true}`, which Next issues WITHOUT the prefetch header) is a complete fetch - neither is
    // shell-only.
    shellOnlyRequest: (request, route) => {
      if (request.method.toUpperCase() !== 'GET') return false
      if (request.headers.get('rsc') !== '1') return false
      if (request.headers.get('next-router-prefetch') !== '1') return false
      const segmentConfig = route.segmentConfig as
        { prefetch?: unknown; dynamic?: unknown } | undefined
      if (
        segmentConfig?.prefetch === 'allow-runtime' ||
        segmentConfig?.prefetch === 'unstable_eager'
      ) {
        return false
      }
      // Static-capable content belongs in a prefetch (Next inlines static
      // data — and lazy-static persistence must never cache a truncated
      // body). Only a truly dynamic render, or a PPR shell with holes, is cut
      // at the shell.
      if (route.mode !== 'dynamic' && !route.ppr) return false
      if (segmentConfig?.dynamic === 'force-static') return false
      return true
    },
  })
  registerResponseFinalizers(...protocolFinalizers(config), ...cacheControlFinalizers(config))
  registerResourceHintFinalizer()
}
