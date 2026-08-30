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

const BLOCKED_JS_URL_MESSAGE = 'Next.js has blocked a javascript: URL as a security precaution.'

export function installNavCompat() {
  if (!process.browser && typeof window === 'undefined') return
  setBlockedJavascriptUrlReporter(() => console.error(BLOCKED_JS_URL_MESSAGE))
  const windowWithReporter = window as typeof window & { __PNEXT_JS_URL_REPORTER__?: boolean }
  if (!windowWithReporter.__PNEXT_JS_URL_REPORTER__) {
    windowWithReporter.__PNEXT_JS_URL_REPORTER__ = true
    window.addEventListener('pnext:blocked-javascript-url', () => {
      console.error(BLOCKED_JS_URL_MESSAGE)
    })
  }
  installNextRouterGlobal()
  registerDeferredInstall(() => import('./nav-runtime').then(m => m.installNavPolicies()))
}

// `window.next.router` — Next's own global handle. Pure-core apps have no such
// namespace, so it installs from compat rather than from the router hub.
function installNextRouterGlobal() {
  window.next ??= {}
  window.next.router = {
    ...window.next.router,
    push: href => softNavigate(String(href)),
    replace: href => softNavigate(String(href), { replace: true }),
    prefetch: href => prefetchRoute(String(href), { strict: true }),
  }
}
