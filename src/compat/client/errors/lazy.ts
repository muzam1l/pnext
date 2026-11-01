// FIRST-PAINT half of the client error runtime. Everything ./install does only ever runs once
// something has already thrown, so it loads on idle instead of at first paint. The in-tree
// ClientErrorBoundary stays eager: it renders.
//
// What DOES stay eager is a pair of capture-only listeners: an error thrown during hydration or in
// a first-paint effect fires before the idle load lands, and Next still shows global-error for it.
// They buffer the value, pull ./install right away, and hand it over.
import { options } from 'preact'
import type { InstallOptions } from './install'
import { registerDeferredInstall } from '../../../client/router'

declare const __PNEXT_DEFER_LINKLESS_ROUTER__: boolean | undefined

// Same key ./install reads (Symbol.for crosses the chunk boundary): only values the preact
// boundary walk rethrew — a ROOT RENDER failure, Next's global-error case — may replace the
// document. Every other uncaught window value (event handlers, third-party noise, ResizeObserver
// loop events) is buffered for triage but the page survives, as it does under Next.
const RENDER_ESCAPE = Symbol.for('pnext.renderEscape')

/** Tag boundary-walk escapes before the deferred runtime exists (a hydration throw fires first). */
function tagRenderEscapes(): void {
  const hooks = options as unknown as Record<string, unknown>
  const key = (['_catchError', '__e'] as const).find(name => typeof hooks[name] === 'function')
  if (!key) return
  const walkBoundaries = hooks[key] as (...args: unknown[]) => unknown
  hooks[key] = function taggedCatchError(this: unknown, ...args: unknown[]) {
    try {
      return walkBoundaries.apply(this, args)
    } catch (error) {
      if (error !== null && typeof error === 'object') {
        try {
          ;(error as Record<symbol, unknown>)[RENDER_ESCAPE] = true
        } catch {
          // frozen throw value: the runtime's own escalation still mounts post-install
        }
      }
      throw error
    }
  }
}

type ErrorRuntime = typeof import('./install')

let installedRuntime: (() => Promise<ErrorRuntime>) | undefined

/**
 * The error runtime, installed with this page's options first: an escalation must see the app's
 * global-error component even when no idle load ever ran the install.
 */
export function errorRuntime(): Promise<ErrorRuntime> {
  return installedRuntime?.() ?? import('./install')
}

export function installClientErrors(installOptions: InstallOptions = {}): void {
  if (!process.browser && typeof window === 'undefined') return
  tagRenderEscapes()

  let runtime: Promise<ErrorRuntime> | undefined
  const load = () =>
    (runtime ??= import('./install').then(module => {
      // Drop the capture listeners before the runtime's own go in, so a later
      // error is triaged once rather than by both paths.
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
      module.installClientErrors(installOptions)
      return module
    }))

  const escaped: unknown[] = []
  const seen = new WeakSet<object>()
  const capture = (error: unknown) => {
    // The replay itself can throw (control-flow handling, a global-error
    // render), which surfaces as another rejection here. Capturing the same
    // value twice would loop, so object throws are only ever queued once and
    // the chain swallows its own failures.
    if (error !== null && typeof error === 'object') {
      if (seen.has(error)) return
      seen.add(error)
    }
    escaped.push(error)
    void load()
      .then(module => module.drainEscapedErrors(escaped.splice(0)))
      .catch(() => undefined)
  }
  // Resource-load failures carry no `error` object; only script throws do.
  const onError = (event: ErrorEvent) => {
    if (event.error !== undefined) capture(event.error)
  }
  const onRejection = (event: PromiseRejectionEvent) => capture(event.reason)
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)

  installedRuntime = load
  // A streamed server error has already thrown: Next shows its boundary while hydrating, not on idle.
  const pullForStreamError = () => {
    if (document.querySelector('pnext-error')) void load()
  }
  pullForStreamError()
  document.addEventListener('DOMContentLoaded', pullForStreamError)
  // Idle, not with the router: a page without links never loads that, yet errors must still reach
  // error.js and global-error synchronously once the page is interactive.
  if (typeof __PNEXT_DEFER_LINKLESS_ROUTER__ !== 'undefined' && __PNEXT_DEFER_LINKLESS_ROUTER__) {
    if (typeof requestIdleCallback === 'function')
      requestIdleCallback(() => void load().catch(() => undefined), { timeout: 1000 })
    else setTimeout(() => void load().catch(() => undefined), 1)
  } else registerDeferredInstall(() => load().then(() => undefined))
}
