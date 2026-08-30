// Next-pixel-exact default error UI (COMPAT). The built-in HTTP-access fallback
// (not-found/forbidden/unauthorized) and the default global-error document, copied byte-for-byte from
// Next so suites that select `.next-error-h1`, the h1/h2 text and computed styles match. Core renders
// these through the httpAccessFallbackUi / defaultGlobalErrorUi render extensions; a pure-core app
// keeps its own compact fallback.

import { h } from 'preact'
import type { SerializedError } from '../../extensions'

// Next's HTTPAccessErrorFallback inline styles (access-error-styles.ts).
const styles = {
  error: {
    fontFamily:
      'system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif,"Apple Color Emoji","Segoe UI Emoji"',
    height: '100vh',
    textAlign: 'center',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
  },
  desc: { display: 'inline-block' },
  h1: {
    display: 'inline-block',
    margin: '0 20px 0 0',
    padding: '0 23px 0 0',
    fontSize: 24,
    fontWeight: 500,
    verticalAlign: 'top',
    lineHeight: '49px',
  },
  h2: { fontSize: 14, fontWeight: 400, lineHeight: '49px', margin: 0 },
} as const

const httpFallbackCss = `body{color:#000;background:#fff;margin:0}.next-error-h1{border-right:1px solid rgba(0,0,0,.3)}@media (prefers-color-scheme:dark){body{color:#fff;background:#000}.next-error-h1{border-right:1px solid rgba(255,255,255,.3)}}`

export function httpAccessFallbackUi(status: number, message: string): unknown {
  return h(
    'div',
    { style: styles.error },
    h(
      'div',
      null,
      h('style', { dangerouslySetInnerHTML: { __html: httpFallbackCss } }),
      h('h1', { className: 'next-error-h1', style: styles.h1 }, String(status)),
      h('div', { style: styles.desc }, h('h2', { style: styles.h2 }, message)),
    ),
  )
}

// Next's DefaultGlobalError (builtin/global-error.tsx + error-styles.tsx). The
// whole document, used when an error escapes the root layout and no
// global-error.* file exists. `error.digest` marks a server error.
const errorStyles = {
  container: {
    fontFamily:
      'system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif,"Apple Color Emoji","Segoe UI Emoji"',
    height: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: { marginTop: '-32px', maxWidth: '325px', padding: '32px 28px', textAlign: 'left' },
  title: {
    fontSize: '24px',
    fontWeight: 500,
    letterSpacing: '-0.02em',
    lineHeight: '32px',
    margin: '0 0 12px 0',
    color: 'var(--next-error-title)',
  },
  message: {
    fontSize: '14px',
    fontWeight: 400,
    lineHeight: '21px',
    margin: '0 0 20px 0',
    color: 'var(--next-error-message)',
  },
  icon: { marginBottom: '24px' },
  form: { margin: 0 },
  buttonGroup: { display: 'flex', gap: '8px', alignItems: 'center' },
  button: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '32px',
    padding: '0 12px',
    fontSize: '14px',
    fontWeight: 500,
    lineHeight: '20px',
    borderRadius: '6px',
    cursor: 'pointer',
    color: 'var(--next-error-btn-text)',
    background: 'var(--next-error-btn-bg)',
    border: 'var(--next-error-btn-border)',
  },
  buttonSecondary: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '32px',
    padding: '0 12px',
    fontSize: '14px',
    fontWeight: 500,
    lineHeight: '20px',
    borderRadius: '6px',
    cursor: 'pointer',
    color: 'var(--next-error-btn-secondary-text)',
    background: 'var(--next-error-btn-secondary-bg)',
    border: 'var(--next-error-btn-secondary-border)',
  },
  digestFooter: {
    position: 'fixed',
    bottom: '32px',
    left: '0',
    right: '0',
    textAlign: 'center',
    fontFamily: 'ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace',
    fontSize: '12px',
    lineHeight: '18px',
    fontWeight: 400,
    margin: '0',
    color: 'var(--next-error-digest)',
  },
} as const

const errorThemeCss = `:root{--next-error-bg:#fff;--next-error-text:#171717;--next-error-title:#171717;--next-error-message:#171717;--next-error-digest:#666666;--next-error-btn-text:#fff;--next-error-btn-bg:#171717;--next-error-btn-border:none;--next-error-btn-secondary-text:#171717;--next-error-btn-secondary-bg:transparent;--next-error-btn-secondary-border:1px solid rgba(0,0,0,.08)}@media (prefers-color-scheme:dark){:root{--next-error-bg:#0a0a0a;--next-error-text:#ededed;--next-error-title:#ededed;--next-error-message:#ededed;--next-error-digest:#a0a0a0;--next-error-btn-text:#0a0a0a;--next-error-btn-bg:#ededed;--next-error-btn-border:none;--next-error-btn-secondary-text:#ededed;--next-error-btn-secondary-bg:transparent;--next-error-btn-secondary-border:1px solid rgba(255,255,255,.14)}}body{margin:0;color:var(--next-error-text);background:var(--next-error-bg);}`

function warningIcon() {
  return h(
    'svg',
    {
      width: '32',
      height: '32',
      viewBox: '-0.2 -1.5 32 32',
      fill: 'none',
      style: errorStyles.icon,
    },
    h('path', {
      d: 'M16.9328 0C18.0839.000116771 19.1334.658832 19.634 1.69531L31.4299 26.1309C32.0708 27.4588 31.1036 28.9999 29.6291 29H2.00215C.527541 29-.439628 27.4588.201371 26.1309L11.9973 1.69531C12.4979.658823 13.5474 7.75066e-05 14.6984 0H16.9328ZM3.59493 26H28.0363L16.9328 3H14.6984L3.59493 26ZM15.8156 19C16.9202 19.0001 17.8156 19.8955 17.8156 21C17.8156 22.1045 16.9202 22.9999 15.8156 23C14.7111 23 13.8156 22.1046 13.8156 21C13.8156 19.8954 14.7111 19 15.8156 19ZM17.3156 16.5H14.3156V8.5H17.3156V16.5Z',
      fill: 'var(--next-error-title)',
    }),
  )
}

// The default/global-error document is served as a fully static document with no page-hydration
// bootstrap script - but Next still surfaces the original error to the client as an uncaught exception
// once the client "hydrates" the escaped-error tree and replays the throw at the root. pnext serves this
// document without a live Preact root, so nothing would ever naturally re-throw; emit a small inline
// bootstrap that reports the same message/digest via `reportError` (falling back to a synthetic error
// event) so the client observes the same uncaught signal. Never runs in dev, where the redbox owns it.
export function globalErrorReportScript(error: SerializedError): string {
  const message = JSON.stringify(error.message ?? '')
  const digest = JSON.stringify(error.digest ?? '')
  return `<script>(function(){try{var e=new Error(${message});if(${digest})e.digest=${digest};if(typeof reportError==='function'){reportError(e);}else{window.dispatchEvent(new ErrorEvent('error',{error:e,message:e.message}));}}catch(_){}})();</script>`
}

export function defaultGlobalErrorUi(error: SerializedError): unknown {
  const digest = error.digest
  const isServerError = Boolean(digest)
  const message = isServerError
    ? 'A server error occurred. Reload to try again.'
    : 'Reload to try again, or go back.'
  return h(
    'html',
    { id: '__next_error__' },
    h(
      'head',
      null,
      h('title', null, '500: This page couldn’t load'),
      h('style', { dangerouslySetInnerHTML: { __html: errorThemeCss } }),
    ),
    h(
      'body',
      null,
      h(
        'div',
        { style: errorStyles.container },
        h(
          'div',
          { style: errorStyles.card },
          warningIcon(),
          h('h1', { style: errorStyles.title }, 'This page couldn’t load'),
          h('p', { style: errorStyles.message }, message),
          h(
            'div',
            { style: errorStyles.buttonGroup },
            h(
              'form',
              { style: errorStyles.form },
              h('button', { type: 'submit', style: errorStyles.button }, 'Reload'),
            ),
            !isServerError
              ? h('button', { type: 'button', style: errorStyles.buttonSecondary }, 'Back')
              : null,
          ),
        ),
      ),
      digest ? h('p', { style: errorStyles.digestFooter }, `ERROR ${digest}`) : null,
    ),
  )
}
