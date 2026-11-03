// Client-side navigation compat, installed once per compat entry.
//
// FIRST PAINT holds only what a click can hit before the navigation runtime lands: Next's
// javascript:-URL block message (a static Link click reports it with no runtime at all) and
// `window.next.router`, which app code can call at any time. Everything else here is a POLICY the
// runtime alone reads, so it rides the runtime's own chunk via registerDeferredInstall and never costs
// a page that never navigates.
import {
  prefetchRoute,
  registerDeferredInstall,
  setBlockedJavascriptUrlReporter,
  softNavigate,
} from '../../client/router'
import { linkClickTarget } from '../../client/router/hub'

declare const __PNEXT_CONCURRENT_ROUTER_QUEUE__: boolean

/** `experimental.concurrentRouterQueue` swaps in Next's unfinished router queue, whose entry points all throw. */
export function assertRouterQueueImplemented(): void {
  if (typeof __PNEXT_CONCURRENT_ROUTER_QUEUE__ === 'boolean' && __PNEXT_CONCURRENT_ROUTER_QUEUE__)
    throw new Error(
      'Not implemented: this behavior is not yet supported when `experimental.concurrentRouterQueue` is enabled.',
    )
}

/** The harness's interaction gate (`__NEXT_HYDRATED`): the visible route is interactive. */
export function markRouteHydrated() {
  const gate = window as {
    __NEXT_HYDRATED?: boolean
    __NEXT_HYDRATED_AT?: number
    __NEXT_HYDRATED_CB?: unknown
  }
  gate.__NEXT_HYDRATED = true
  gate.__NEXT_HYDRATED_AT ??= performance.now()
  if (typeof gate.__NEXT_HYDRATED_CB === 'function') (gate.__NEXT_HYDRATED_CB as () => void)()
  window.dispatchEvent(new Event('pnext:hydrated'))
}

export function installNavCompat() {
  if (!process.browser && typeof window === 'undefined') return
  setBlockedJavascriptUrlReporter(() =>
    console.error('Next.js has blocked a javascript: URL as a security precaution.'),
  )
  installNextRouterGlobal()
  if (typeof __PNEXT_CONCURRENT_ROUTER_QUEUE__ === 'boolean' && __PNEXT_CONCURRENT_ROUTER_QUEUE__)
    document.addEventListener('click', failConcurrentQueueNavigation, true)
  registerDeferredInstall(router =>
    import('./nav-runtime').then(m => m.installNavPolicies(router.policySetters!)),
  )
}

// The click is the router's, so it must not fall back to a browser navigation either.
function failConcurrentQueueNavigation(event: MouseEvent) {
  if (!linkClickTarget(event)) return
  event.preventDefault()
  assertRouterQueueImplemented()
}

// `window.next.router` — Next's own global handle. Pure-core apps have no such
// namespace, so it installs from compat rather than from the router hub.
function installNextRouterGlobal() {
  const go = (href: string, options?: Parameters<typeof softNavigate>[1]) => {
    assertRouterQueueImplemented()
    void softNavigate(String(href), options)
  }
  window.next ??= {}
  window.next.router = {
    ...window.next.router,
    push: href => go(href),
    replace: href => go(href, { replace: true }),
    refresh: () => go(location.href, { replace: true, scroll: false, refresh: true }),
    prefetch: href => void prefetchRoute(String(href), { strict: true }),
  }
}
