// `use cache` response-header registration (COMPAT - may import core freely).
//
// Wires the SWR cache-control headers Next emits for a `use cache` route into core via a
// responseFinalizer: `cache-control: s-maxage=<revalidate>, stale-while-revalidate=<expire-revalidate>`
// and `x-nextjs-stale-time: <stale>`.
//
// Mechanism mirrors the font runtime: as each `use cache` entry resolves during a render it stashes its
// effective cacheLife on the request work unit. This finalizer, running before the first flush inside the
// same work unit, reads the aggregate and sets the headers. A user-supplied Cache-Control survives - the
// header is only set when absent, matching the "merge, do not overwrite" finalizer discipline.
//
// LIMITATION: statically-served prerendered pages (a cache HIT from prebuilt bytes) do not re-run a
// render, so no cacheLife is stashed for them - the header is emitted only on dynamic renders and
// lazy-static MISS responses. Emitting it for pure static HITs needs the route's cacheLife persisted in
// the build manifest and read by the static-serve path in src/cli/start.ts.

import type { ResolvedConfig } from '../../config'
import { nextCompatEnabled } from '../../compat/aliases'
import {
  onExtensionHostReset,
  registerBuildCompleteHooks,
  registerBuildSteps,
  registerResponseFinalizers,
  type ResponseFinalizer,
  type ResponseFinalizerContext,
} from '../../extensions'
import {
  setUseCacheFillTimeout,
  setUseCacheRootParamNames,
  takeCacheLifeStash,
} from '../cache/use-cache'
import { scanRootParams } from '../ppr/root-params-scan'
import {
  beginPrerenderErrorCollection,
  endPrerenderErrorCollection,
} from '../cache/build-prerender-errors'
import { getNextConfig } from '../next/config-loader'

// Route kinds a `use cache` page/handler can be served as.
const CACHEABLE_ROUTE_KINDS = new Set<ResponseFinalizerContext['routeKind']>([
  'html',
  'data',
  'route-handler',
])

const useCacheHeaderFinalizer: ResponseFinalizer = ctx => {
  const life = takeCacheLifeStash()
  if (!life) return
  if (!CACHEABLE_ROUTE_KINDS.has(ctx.routeKind)) return

  const { revalidateSeconds, expireSeconds, staleSeconds } = life

  // SWR cache-control: s-maxage = revalidate, stale-while-revalidate =
  // expire − revalidate. Emitted only when a revalidate window is known and no
  // explicit Cache-Control was already set by the app/route.
  if (
    revalidateSeconds !== undefined &&
    expireSeconds !== undefined &&
    !ctx.headers.has('cache-control')
  ) {
    const swr = Math.max(0, expireSeconds - revalidateSeconds)
    ctx.headers.set('cache-control', `s-maxage=${revalidateSeconds}, stale-while-revalidate=${swr}`)
  }

  // x-nextjs-stale-time drives the client router's cache staleness window.
  // Set unconditionally: the segment finalizer runs earlier and stamps a
  // mode-derived default, but the live render's own cacheLife is authoritative
  // (the header is internal — never user-supplied — so overwriting is safe).
  if (staleSeconds !== undefined) {
    ctx.headers.set('x-nextjs-stale-time', String(staleSeconds))
  }
}

let registered = false
// Host-scoped guard: a fresh host must be registered into again.
onExtensionHostReset(() => (registered = false))

export function registerUseCacheExtensions(config: ResolvedConfig): void {
  if (registered) return
  if (!nextCompatEnabled(config)) return
  registered = true
  registerResponseFinalizers(useCacheHeaderFinalizer)

  // Seed the root-param NAME set for cache-key participation (Stage B-3): a
  // `use cache` entry's conservative first-call key may only discriminate by
  // root params, so the runtime needs the scanned names at build AND serve.
  setUseCacheRootParamNames(scanRootParams(config.appPath))

  // Arm `use cache` build-time validation for this build's prerender pass.
  // Registered as a build STEP so it runs before any page is prerendered; the
  // registry is process-global, so re-check enablement per build (a later
  // pure-core buildProject in the same process must stay unarmed).
  registerBuildSteps(ctx => {
    if (nextCompatEnabled(ctx.config)) {
      const config = getNextConfig() as {
        experimental?: { useCacheTimeout?: number }
        staticPageGenerationTimeout?: number
      }
      const configured = config.experimental?.useCacheTimeout
      const staticTimeout = config.staticPageGenerationTimeout
      // Next clamps the build-time `use cache` fill timeout to just under the
      // page-generation timeout (1s buffer before the build worker kills the
      // page), so a slow fill fails via the clamp rather than the worker.
      const baseMs = typeof configured === 'number' ? configured * 1000 : 50_000
      const clampMs =
        typeof staticTimeout === 'number' && staticTimeout > 1
          ? (staticTimeout - 1) * 1000
          : undefined
      const fillMs = clampMs !== undefined ? Math.min(baseMs, clampMs) : baseMs
      setUseCacheFillTimeout(fillMs)
      beginPrerenderErrorCollection()
    }
    return Promise.resolve()
  })

  // After prerendering, surface any recorded `use cache` violations. Each is
  // printed with Next's exact error text plus the "Error occurred prerendering
  // page" line the e2e suites grep for, then the build is aborted (exit 1).
  registerBuildCompleteHooks(ctx => {
    const errors = endPrerenderErrorCollection()
    if (!nextCompatEnabled(ctx.config) || errors.length === 0) return Promise.resolve()
    // Messages were already printed at detection time (see recordPrerenderError);
    // the hook only forces the non-zero exit for builds that otherwise completed
    // (a swallowed hanging timeout or a caught searchParams access).
    throw new Error(
      `pnext build: ${errors.length} "use cache" validation error${
        errors.length === 1 ? '' : 's'
      } (see above)`,
    )
  })
}
