// `next/offline` - the useOffline() hook. Reports whether the app is currently offline: false on the
// server and during hydration; in the browser it tracks the native online/offline events. The router's
// own offline handling (soft-nav retry on reconnect) lives in client/router/index.ts; this hook is only the
// UI-facing subscription.

import { useEffect, useState } from 'preact/hooks'

type Listener = () => void

const listeners = new Set<Listener>()
let installed = false
let offline = false

function currentOffline(): boolean {
  if (typeof navigator === 'undefined') return false
  return navigator.onLine === false
}

function install() {
  if (installed || (!process.browser && typeof window === 'undefined')) return
  installed = true
  offline = currentOffline()
  const update = () => {
    const next = currentOffline()
    if (next === offline) return
    offline = next
    for (const listener of [...listeners]) listener()
  }
  window.addEventListener('offline', update)
  window.addEventListener('online', update)
}

/**
 * True while the browser reports no connectivity. Server-rendered and
 * hydrating trees always see `false` (matching Next: the offline state is a
 * client-side signal only).
 */
export function useOffline(): boolean {
  const [value, setValue] = useState(false)
  useEffect(() => {
    install()
    const listener = () => setValue(offline)
    listeners.add(listener)
    // The state may have flipped between render and subscription.
    listener()
    return () => {
      listeners.delete(listener)
    }
  }, [])
  return value
}
