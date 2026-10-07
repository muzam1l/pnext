// Client-side global-error mounting (COMPAT).
//
// When a client-side error escapes the root (no error.js boundary caught it, or the root boundary
// re-threw), Next replaces the ENTIRE document with the app's `global-error.js` component - or, when
// none exists (or global-error itself throws), a built-in fallback document.
//
// pnext hydrates a server-rendered document rather than owning a client render root, so "replace the
// document" here means rendering the global-error component (or the built-in fallback) into a fresh
// <body>, in place, client-side. Its reset() soft-refreshes to re-render from the server, and
// next/navigation hooks used inside the component keep working.
//
// Client-escaped errors carry NO digest, so the built-in fallback shows the no-digest message.

import { h, render, type ComponentType } from 'preact'
import { softNavigate } from '../../../client/router'

export type GlobalErrorComponent = ComponentType<{ error: unknown; reset: () => void }>

// Mounted PER DOCUMENT, not per process: idempotence is a property of the document being
// replaced. Identical in a browser (one document per page lifetime); differs in multi-document
// hosts (jsdom embedders, the test process), where a process boolean wrongly suppresses mounts.
let globalErrorMountedIn: Document | undefined
const globalErrorMounted = () =>
  typeof document !== 'undefined' && globalErrorMountedIn === document

// The app-root global-error.js component, registered by installClientErrors so the in-tree
// ClientErrorBoundary can escalate straight to it WITHOUT bouncing a re-throw through the window
// `error` channel - that channel drops the value for a thrown undefined/null (the ErrorEvent's `.error`
// is undefined), so a primitive escape would be lost.
let registeredGlobalError: GlobalErrorComponent | undefined

export function registerGlobalErrorComponent(component?: GlobalErrorComponent): void {
  registeredGlobalError = component
}

/**
 * Escalate a boundary error with no local error.js to the global-error UI,
 * using the registered app-root global-error.js when present. Passes the RAW
 * thrown value through (matching Next: a client `throw undefined`/`null` reaches
 * global-error.js unwrapped, so `${error}` renders 'undefined'/'null').
 */
export function escalateToGlobalError(error: unknown): void {
  mountGlobalError(error, registeredGlobalError)
  // A client error that escapes every route boundary is, to the page, an UNCAUGHT error: Next still
  // reports it to the window so window.onerror and Playwright's pageerror observe the original.
  // mountGlobalError swaps the document silently, so surface the throw explicitly here. Skip
  // primitive-sentinel escapes and anything non-Error - only a real Error carries a meaningful pageerror.
  if ((process.browser || typeof window !== 'undefined') && error instanceof Error) {
    reportUncaught(error)
  }
}

// Errors already surfaced via reportUncaught: the later natural unhandled
// rejection of the same value is a duplicate and gets suppressed (install.ts).
const reportedUncaught = new WeakSet<Error>()

export function wasReportedUncaught(error: unknown): boolean {
  return error instanceof Error && reportedUncaught.has(error)
}

// Report an escaped error to the window as an uncaught exception. Prefer the
// standard `reportError`; fall back to a synthetic 'error' event for engines
// without it. Wrapped so a reporting failure never masks the global-error UI.
function reportUncaught(error: Error): void {
  reportedUncaught.add(error)
  try {
    if (typeof reportError === 'function') {
      reportError(error)
      return
    }
    window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }))
  } catch {
    // ignore — the global-error document is already shown.
  }
}

/**
 * Replace the document body with the global-error UI. Idempotent: once mounted,
 * a second escaping error does not stack another document (matches a single
 * top-level replacement). A soft refresh via reset() clears the flag.
 */
export function mountGlobalError(error: unknown, component?: GlobalErrorComponent): void {
  if (typeof document === 'undefined' || globalErrorMounted()) return
  globalErrorMountedIn = document

  document.documentElement.id = '__next_error__'
  const root = document.createElement('div')
  document.body.replaceChildren(root)

  const reset = () => {
    globalErrorMountedIn = undefined
    render(null, root)
    // Re-render the current URL from the server (recovers server + client errors).
    void softNavigate(location.href, { replace: true, scroll: false }).catch(() => {
      location.reload()
    })
  }

  if (component) {
    try {
      // A user global-error.js owns the whole document (<html>/<body>); render its
      // subtree in place. If it THROWS during render, fall back to the built-in.
      render(h(component, { error, reset }), root)
      return
    } catch {
      globalErrorMountedIn = document // keep mounted; render the fallback below.
    }
  }

  renderBuiltinFallback(root, error)
}

// Next's DefaultGlobalError document text/markup. A client-escaped error has no
// digest, so it always shows the non-server "Reload to try again, or go back."
// message and no ERROR <digest> footer.
function renderBuiltinFallback(root: HTMLElement, error: unknown): void {
  const digest = (error as { digest?: unknown } | null | undefined)?.digest
  const isServerError = typeof digest === 'string' && digest.length > 0
  const message = isServerError
    ? 'A server error occurred. Reload to try again.'
    : 'Reload to try again, or go back.'

  ensureThemeStyle()
  root.style.cssText =
    'font-family:system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif,"Apple Color Emoji","Segoe UI Emoji";height:100vh;display:flex;align-items:center;justify-content:center'

  const card = styled('div', 'margin-top:-32px;max-width:325px;padding:32px 28px;text-align:left')

  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  icon.setAttribute('width', '32')
  icon.setAttribute('height', '32')
  icon.setAttribute('viewBox', '-0.2 -1.5 32 32')
  icon.setAttribute('fill', 'none')
  icon.style.marginBottom = '24px'
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute(
    'd',
    'M16.9328 0C18.0839.000116771 19.1334.658832 19.634 1.69531L31.4299 26.1309C32.0708 27.4588 31.1036 28.9999 29.6291 29H2.00215C.527541 29-.439628 27.4588.201371 26.1309L11.9973 1.69531C12.4979.658823 13.5474 7.75066e-05 14.6984 0H16.9328ZM3.59493 26H28.0363L16.9328 3H14.6984L3.59493 26ZM15.8156 19C16.9202 19.0001 17.8156 19.8955 17.8156 21C17.8156 22.1045 16.9202 22.9999 15.8156 23C14.7111 23 13.8156 22.1046 13.8156 21C13.8156 19.8954 14.7111 19 15.8156 19ZM17.3156 16.5H14.3156V8.5H17.3156V16.5Z',
  )
  path.setAttribute('fill', 'var(--next-error-title)')
  icon.append(path)

  const title = styled(
    'h1',
    'font-size:24px;font-weight:500;letter-spacing:-0.02em;line-height:32px;margin:0 0 12px 0;color:var(--next-error-title)',
    'This page couldn’t load',
  )
  const body = styled(
    'p',
    'font-size:14px;font-weight:400;line-height:21px;margin:0 0 20px 0;color:var(--next-error-message)',
    message,
  )

  const buttonGroup = styled('div', 'display:flex;gap:8px;align-items:center')
  const reloadForm = styled('form', 'margin:0')
  reloadForm.addEventListener('submit', event => {
    event.preventDefault()
    location.reload()
  })
  const reload = styled('button', buttonStyle(''), 'Reload')
  reload.type = 'submit'
  reloadForm.append(reload)
  buttonGroup.append(reloadForm)
  if (!isServerError) {
    const back = styled('button', buttonStyle('secondary-'), 'Back')
    back.type = 'button'
    back.addEventListener('click', () => {
      if (window.history.length > 1) window.history.back()
      else window.location.href = '/'
    })
    buttonGroup.append(back)
  }
  card.append(icon, title, body, buttonGroup)
  root.append(card)
  if (isServerError) {
    // Next's DefaultGlobalError digest footer (`ERROR <digest>`), fixed to the
    // bottom so operators can correlate the redacted UI with server logs.
    root.append(
      styled(
        'p',
        'position:fixed;bottom:32px;left:0;right:0;text-align:center;font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;font-size:12px;line-height:18px;font-weight:400;margin:0;color:var(--next-error-digest)',
        `ERROR ${digest}`,
      ),
    )
  }
  if (typeof document.title !== 'undefined') document.title = '500: This page couldn’t load'
}

// Styles go through CSSOM (style.cssText), never style attributes, so a strict style-src CSP allows them.
function styled<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  css: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  element.style.cssText = css
  if (text !== undefined) element.textContent = text
  return element
}

function buttonStyle(variant: string): string {
  return `display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 12px;font-size:14px;font-weight:500;line-height:20px;border-radius:6px;cursor:pointer;color:var(--next-error-btn-${variant}text);background:var(--next-error-btn-${variant}bg);border:var(--next-error-btn-${variant}border)`
}

const THEME_STYLE_ID = '__pnext_global_error_theme__'

function ensureThemeStyle(): void {
  if (document.getElementById(THEME_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = THEME_STYLE_ID
  style.textContent =
    ':root{--next-error-bg:#fff;--next-error-text:#171717;--next-error-title:#171717;--next-error-message:#171717;--next-error-digest:#666666;--next-error-btn-text:#fff;--next-error-btn-bg:#171717;--next-error-btn-border:none;--next-error-btn-secondary-text:#171717;--next-error-btn-secondary-bg:transparent;--next-error-btn-secondary-border:1px solid rgba(0,0,0,.08)}@media (prefers-color-scheme:dark){:root{--next-error-bg:#0a0a0a;--next-error-text:#ededed;--next-error-title:#ededed;--next-error-message:#ededed;--next-error-digest:#a0a0a0;--next-error-btn-text:#0a0a0a;--next-error-btn-bg:#ededed;--next-error-btn-border:none;--next-error-btn-secondary-text:#ededed;--next-error-btn-secondary-bg:transparent;--next-error-btn-secondary-border:1px solid rgba(255,255,255,.14)}}body{margin:0;color:var(--next-error-text);background:var(--next-error-bg);}'
  document.head.append(style)
}
