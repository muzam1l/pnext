/** @jsxImportSource preact */
import type { JSX } from 'preact'
import { escapeHtml } from '../../utils/html'
import { getNextConfig } from './config-loader'
import {
  clearRenderBuffer,
  registerResourceHint,
  renderBuffer,
  takeRenderBuffer,
} from '../../render/resource-hints'

export type ScriptStrategy = 'beforeInteractive' | 'afterInteractive' | 'lazyOnload' | 'worker'

export type ScriptProps = Omit<JSX.ScriptHTMLAttributes<HTMLScriptElement>, 'src'> & {
  src?: string
  strategy?: ScriptStrategy
  onLoad?: (event: Event) => void
  onReady?: () => void
  onError?: (event: Event) => void
  children?: string
  /** Stylesheets the script depends on; Next preloads these alongside the script itself. */
  stylesheets?: string[]
}

/**
 * Server-renderable approximation of next/script. onLoad/onReady/onError are unserializable across a
 * Server-to-Client boundary (this module has no 'use client' pragma of its own) and never fire from
 * here; they land in `scriptProps` and are filtered out wherever attrs get serialized. A `<Script>`
 * rendered from an actual client component hydrates through client-script.tsx instead, where those
 * callbacks do fire.
 */
export default function Script({
  strategy = 'afterInteractive',
  children,
  stylesheets,
  ...scriptProps
}: ScriptProps) {
  const src = typeof scriptProps.src === 'string' ? scriptProps.src : undefined

  // Dedup on Next's cache key (`id ?? src`): two `<Script id="x">` must be serialized to the document
  // exactly once. The executed-set is scoped to the current render (tied to the per-request
  // resource-hints buffer) so it never leaks across requests.
  const dedupKey = (typeof scriptProps.id === 'string' && scriptProps.id) || src
  if (dedupKey) {
    const keys = executedScriptKeys()
    if (keys.has(dedupKey)) return null
    keys.add(dedupKey)
  }

  // A manually-passed `nonce` prop always wins, matching Next. The CSP-detected case has no per-Script
  // signal to read here - it is stamped uniformly, after the whole document is assembled, by the
  // renderer's stampDocumentNonce - so only the explicit override needs threading through this module.
  const manualNonce = typeof scriptProps.nonce === 'string' ? scriptProps.nonce : undefined

  // lazyOnload scripts load well after hydration on a browser idle callback;
  // Next doesn't preload them (a preload hint for something fetched minutes
  // later just wastes bandwidth budget), so skip the hint for that strategy.
  if (src && strategy !== 'lazyOnload') {
    registerResourceHint({
      rel: 'preload',
      url: src,
      as: 'script',
      ...(manualNonce ? { nonce: manualNonce } : {}),
      ...(typeof scriptProps.crossOrigin === 'string'
        ? { crossOrigin: scriptProps.crossOrigin }
        : {}),
    })
  }

  if (stylesheets) {
    for (const url of stylesheets) {
      registerResourceHint({ rel: 'stylesheet', url })
    }
  }

  if (strategy === 'beforeInteractive') {
    // Next injects beforeInteractive scripts straight into the SSR document
    // `<head>` (or the very top of `<body>`) with a `data-nscript` marker so its
    // client bootstrapper can skip re-executing them. We collect into the shared
    // head-script buffer the renderer flushes into `<head>`; the marker rides
    // along as a normal prop so the core head-script serializer emits it.
    headScripts().push({
      props: { 'data-nscript': 'beforeInteractive', ...scriptProps },
      content: inlineScriptContent(scriptProps, children),
    })
    return null
  }

  if (strategy === 'worker' && nextScriptWorkersEnabled()) {
    // experimental.nextScriptWorkers: run the script off-main-thread via
    // Partytown. Next rewrites the tag to `type="text/partytown"` (Partytown's
    // library, served under /_next/static/~partytown/, hijacks these on load).
    const partytownProps: Record<string, unknown> = {
      ...scriptProps,
      type: 'text/partytown',
      'data-nscript': 'worker',
    }
    const workerInline =
      typeof children === 'string' ? { dangerouslySetInnerHTML: { __html: children } } : {}
    return <script {...partytownProps} {...workerInline} />
  }

  // afterInteractive / lazyOnload: Next never SSRs the actual tag for these - only the preload hint
  // above - because the real element is inserted client-side once its own hydration bootstrap has run,
  // so a script that mutates shared state lands after earlier client-component effects rather than
  // racing them. A bare `<Script>` usage inside a Server Component tree hydrates nothing here, so SSRing
  // the tag inline would execute it immediately during HTML parse. Queue a descriptor instead; the
  // renderer flushes one shared bootstrap that creates and appends the real elements at the right time.
  const deferredContent = inlineScriptContent(scriptProps, children)
  deferredScripts().push({
    strategy: strategy === 'lazyOnload' ? 'lazyOnload' : 'afterInteractive',
    attrs: deferredAttrs({ ...scriptProps, ...(manualNonce ? { nonce: manualNonce } : {}) }),
    ...(typeof scriptProps.id === 'string' ? { id: scriptProps.id } : {}),
    ...(src ? { src } : {}),
    ...(deferredContent !== undefined ? { content: deferredContent } : {}),
  })
  return null
}

export { Script }

/**
 * `experimental.nextScriptWorkers` gate. When on, `strategy="worker"` scripts
 * are rewritten to Partytown (`type="text/partytown"`).
 */
function nextScriptWorkersEnabled(): boolean {
  const experimental = getNextConfig().experimental as { nextScriptWorkers?: boolean } | undefined
  return experimental?.nextScriptWorkers === true
}

/**
 * The Partytown loader path Next serves the library from. Copied verbatim by the
 * asset pipeline; the injected snippet points the worker sandbox here.
 */
export const PARTYTOWN_LIB_PATH = '/_next/static/~partytown/'

/**
 * Partytown config plus the inline snippet Next injects into <head> once when any `worker` script is
 * present. `partytownSnippet()` returns the loader IIFE; users override config via a
 * `data-partytown-config` block, mirrored here as a `window.partytown` seed.
 */
export function partytownHeadScripts(): HeadScript[] {
  const config = getNextConfig() as {
    experimental?: { nextScriptWorkers?: boolean }
    partytown?: Record<string, unknown>
  }
  if (config.experimental?.nextScriptWorkers !== true) return []
  const partytownConfig = {
    lib: PARTYTOWN_LIB_PATH,
    ...(config.partytown ?? {}),
  }
  return [
    {
      props: { 'data-partytown-config': '' },
      content: `partytown = ${JSON.stringify(partytownConfig)};`,
    },
    {
      props: { 'data-partytown': '' },
      content: partytownSnippet(partytownConfig.lib),
    },
  ]
}

/**
 * Render the Partytown head scripts (config seed + loader snippet) to an HTML string for injection via
 * the render seam. Returns '' when nextScriptWorkers is disabled - a no-op for every other app.
 */
export function renderPartytownHeadScripts(): string {
  return partytownHeadScripts().map(renderHeadScript).join('')
}

/**
 * Minimal Partytown bootstrap snippet: registers the forwarding queue and lazily
 * loads `partytown.js` from the configured lib path. Matches the shape Next
 * emits closely enough for the `type="text/partytown"` rewrite + lib-path
 * assertions; the full vendored snippet is copied by the asset pipeline.
 */
function partytownSnippet(lib: string): string {
  return (
    `!(function(w,p,f,c){` +
    `c=w[p]=Object.assign(w[p]||{},{lib:${JSON.stringify(lib)}});` +
    `c.forward=c.forward||[];` +
    `f=document.createElement('script');` +
    `f.async=!0;f.src=c.lib+'partytown.js';` +
    `document.head.appendChild(f);` +
    `})(window,'partytown');`
  )
}

// afterInteractive/lazyOnload descriptors (§ deferred bootstrap). Consumed by
// src/render/renderer.ts's renderDeferredScriptRuntime, which owns its own
// copy of this shape (core may not import compat) keyed off the same global —
// mirrors the ResourceHint/HeadScript protocol above.
export interface DeferredScript {
  strategy: 'afterInteractive' | 'lazyOnload'
  attrs: Record<string, string>
  id?: string
  src?: string
  content?: string
}

function deferredScripts() {
  return renderBuffer<DeferredScript>('deferred')
}

export function clearDeferredScripts() {
  clearRenderBuffer('deferred')
}

export function takeDeferredScripts() {
  return takeRenderBuffer<DeferredScript>('deferred')
}

// Like scriptAttrs, but building a raw name -> value map (for
// `element.setAttribute(name, value)` client-side) instead of an
// HTML-escaped string — the deferred bootstrap reconstructs real elements via
// the DOM, never via innerHTML.
const DEFERRED_SKIP_PROPS = new Set(['src', 'strategy', 'dangerouslysetinnerhtml', 'id'])

function deferredAttrs(props: Record<string, unknown>): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const [key, value] of Object.entries(props)) {
    const name = attrName(key)
    if (!isAttrName(name) || DEFERRED_SKIP_PROPS.has(name) || name.startsWith('on')) continue
    if (value == null || value === false || typeof value === 'function') continue
    if (value === true) {
      attrs[name] = ''
      continue
    }
    if (name === 'class' && Array.isArray(value)) {
      const className = value
        .filter(
          (item): item is string | number => typeof item === 'string' || typeof item === 'number',
        )
        .join(' ')
      if (className) attrs[name] = className
      continue
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
      attrs[name] = String(value)
    }
  }
  return attrs
}

export interface HeadScript {
  props: Record<string, unknown>
  content?: string
}

// The resource-hints buffer is per render (render/resource-hints). Keying the executed-set off that
// array via a WeakMap gives us a dedup scope that lives exactly one render and is garbage-collected
// with it — no cross-request leakage.
const scriptDedupRegistry = new WeakMap<object, Set<string>>()

function executedScriptKeys(): Set<string> {
  const arr = renderBuffer<unknown>('hints')
  let keys = scriptDedupRegistry.get(arr)
  if (!keys) {
    keys = new Set<string>()
    scriptDedupRegistry.set(arr, keys)
  }
  return keys
}

function headScripts() {
  return renderBuffer<HeadScript>('head')
}

export function clearHeadScripts() {
  clearRenderBuffer('head')
}

export function takeHeadScripts() {
  return takeRenderBuffer<HeadScript>('head')
}

export function renderHeadScripts() {
  return takeHeadScripts().map(renderHeadScript).join('\n    ')
}

function renderHeadScript(script: HeadScript) {
  const attrs = scriptAttrs(script.props)
  const open = attrs ? `<script ${attrs}>` : '<script>'
  return script.content === undefined
    ? `${open}</script>`
    : `${open}${escapeScriptText(script.content)}</script>`
}

function inlineScriptContent(
  props: Record<string, unknown>,
  children: string | undefined,
): string | undefined {
  if (typeof children === 'string') return children
  const dangerous = props.dangerouslySetInnerHTML
  if (
    dangerous &&
    typeof dangerous === 'object' &&
    typeof (dangerous as { __html?: unknown }).__html === 'string'
  ) {
    return (dangerous as { __html: string }).__html
  }
  return undefined
}

function scriptAttrs(props: Record<string, unknown>) {
  const attrs = Object.entries(props).flatMap(([key, value]) => scriptAttr(attrName(key), value))
  return attrs.join(' ')
}

function scriptAttr(name: string, value: unknown): string[] {
  if (!isAttrName(name)) return []
  if (value == null || value === false || typeof value === 'function') return []
  if (name === 'strategy' || name === 'dangerouslysetinnerhtml' || name.startsWith('on')) return []
  if (value === true) return [name]
  if (name === 'class' && Array.isArray(value)) {
    const className = value
      .filter(
        (item): item is string | number => typeof item === 'string' || typeof item === 'number',
      )
      .join(' ')
    return className ? [`class="${escapeHtml(className)}"`] : []
  }
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    return []
  }
  return [`${name}="${escapeHtml(value)}"`]
}

function attrName(key: string) {
  if (key === 'className') return 'class'
  if (key === 'htmlFor') return 'for'
  return key.toLowerCase()
}

function isAttrName(name: string) {
  return /^[a-zA-Z_:][a-zA-Z0-9:._-]*$/.test(name)
}

const scriptTerminator = /(<\/|<)(s)(cript)/gi

function escapeScriptText(text: string) {
  return text.replace(
    scriptTerminator,
    (_, prefix: string, s: string, suffix: string) =>
      `${prefix}${s === 's' ? '\\u0073' : '\\u0053'}${suffix}`,
  )
}
