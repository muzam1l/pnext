// Segment-prefetch responder registration (COMPAT - may import core freely).
// The implementation (request interceptor, response finalizers, all serving
// helpers) lives in ../segment/serve; this module just wires it into the
// extension registries.

import type { ResolvedConfig } from '../../config'
import { nextCompatEnabled } from '../../compat/aliases'
import {
  onExtensionHostReset,
  registerRequestInterceptors,
  registerResponseFinalizers,
} from '../../extensions'
import {
  prefetchStaleTimeFinalizer,
  rscContentTypeFinalizer,
  rscDeploymentFinalizer,
  segmentPrefetchInterceptor,
} from '../segment/serve'

let registered = false
// Host-scoped guard: a fresh host must be registered into again.
onExtensionHostReset(() => (registered = false))

export function registerSegmentExtensions(config: ResolvedConfig): void {
  if (registered) return
  if (!nextCompatEnabled(config)) return
  registered = true
  // Register the responder FIRST so `/_tree` is handled before action dispatch.
  registerRequestInterceptors(segmentPrefetchInterceptor)
  registerResponseFinalizers(
    prefetchStaleTimeFinalizer,
    rscContentTypeFinalizer,
    rscDeploymentFinalizer,
  )
}
