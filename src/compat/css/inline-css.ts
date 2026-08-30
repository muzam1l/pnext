// Inline CSS (COMPAT - `experimental.inlineCss`, prod-only).
//
// When the flag is on, Next inlines a route's built CSS into a `<style>` in the document instead of
// shipping a `<link rel=stylesheet>`. This module owns the FLAG read plus the inliner (read the built
// asset bytes, wrap in a `<style data-pnext-inline-css>` tag). The DECISION of link-vs-style at head
// assembly is renderer territory: the renderer calls inlineCssEnabled(config) and, when true and not
// dev, replaces each route/global stylesheet link with inlineCssTag(...).

import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import type { ResolvedConfig } from '../../config'
import { getNextConfig } from '../next/config-loader'

// Inlining is a DOCUMENT optimization: Next inlines a route's CSS into the HTML
// it serves for a navigation to the URL, but a flight (`RSC: 1`) response for
// the same route carries stylesheet references, never the CSS bytes (the
// inline-css suite asserts the RSC payload of `/a` does NOT contain the page's
// `font-size` rule while the HTML does). The full-route RSC responder wraps its
// render in `withoutInlineCss`, which switches head assembly back to `<link>`.
//
// A scope (not a module flag) because renders are concurrent: a plain document
// render running alongside a flight render must keep inlining.
const INLINE_CSS_SUPPRESSED = Symbol.for('pnext.compat.inlineCssSuppressed')
const suppressed = ((globalThis as Record<PropertyKey, unknown>)[INLINE_CSS_SUPPRESSED] ??=
  new AsyncLocalStorage<true>()) as AsyncLocalStorage<true>

/** Run `render` with CSS inlining disabled (flight responses — see above). */
export function withoutInlineCss<T>(render: () => T): T {
  return suppressed.run(true, render)
}

/** True when `experimental.inlineCss` is set in next.config. */
export function inlineCssEnabled(_config: ResolvedConfig): boolean {
  const config = getNextConfig()
  const experimental = config.experimental as { inlineCss?: unknown } | undefined
  return experimental?.inlineCss === true
}

/**
 * Wrap a built CSS file's bytes in an inline `<style>` tag. `nonce` (when the
 * request carries a CSP nonce) is stamped so a strict CSP admits the style.
 * Returns '' if the file can't be read (never fail the page over inlining).
 */
export function inlineCssTag(assetFile: string, nonce?: string): string {
  const css = readCss(assetFile)
  return css === undefined ? '' : inlineStyleTag(css, nonce)
}

function readCss(assetFile: string): string | undefined {
  try {
    return readFileSync(assetFile, 'utf8')
  } catch {
    return undefined
  }
}

function inlineStyleTag(css: string, nonce?: string): string {
  const nonceAttr = nonce ? ` nonce="${nonce}"` : ''
  return `<style data-pnext-inline-css${nonceAttr}>${css}</style>`
}

export function inlineCssStylesheets(
  config: ResolvedConfig,
  options: { assetNames: string[]; dev: boolean; nonce?: string; prependCss?: string },
): string[] | undefined {
  if (options.dev || suppressed.getStore() === true || !inlineCssEnabled(config)) return undefined
  const assets = options.assetNames.map(asset =>
    readCss(`${config.outPath}/public/assets/${asset}`),
  )
  if (assets.some(css => css === undefined)) return undefined
  const css = [options.prependCss, ...assets].filter(Boolean).join('\n')
  return css ? [inlineStyleTag(css, options.nonce)] : []
}
