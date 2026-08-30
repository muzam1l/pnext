// Installs the client-side server-action machinery for Next-compat entries:
// - `window.__PNEXT_ROUTER__`: minimal navigate/refresh global bridging the soft-navigation runtime,
//   used after action redirects and refresh signals.
// - `window.__PNEXT_ACTIONS__`: the action RPC runtime - argument encoding, the POST wire,
//   redirect/refresh/error semantics, island prop revival, and <form action={fn}> interception.
// Only imported into client entries when Next compat is enabled.

import { softNavigate } from '../../client/router'
import { installActionRuntime } from './client'

interface PNextRouterGlobal {
  navigate: (href: string) => Promise<void>
  refresh: () => Promise<void>
}

declare global {
  interface Window {
    __PNEXT_ROUTER__?: PNextRouterGlobal
  }
}

export function installActionRouter() {
  if (!process.browser && typeof window === 'undefined') return
  installActionRuntime()
  const existing = window.__PNEXT_ROUTER__
  if (
    existing &&
    typeof existing.navigate === 'function' &&
    typeof existing.refresh === 'function'
  ) {
    return
  }
  window.__PNEXT_ROUTER__ = {
    navigate: (href: string) => softNavigate(href),
    // A refresh re-fetches the current URL and swaps the body in place, which
    // re-runs the server render (picking up any revalidated data). replace:true
    // keeps history intact; scroll:false avoids jumping to the top.
    refresh: () => softNavigate(location.href, { replace: true, scroll: false }),
  }
}
