/** @jsxImportSource preact */
import type { JSX } from 'preact'
import { useEffect } from 'preact/compat'
import { registerResourceHint } from '../../render/resource-hints'

export type ScriptStrategy = 'beforeInteractive' | 'afterInteractive' | 'lazyOnload' | 'worker'

export type ScriptProps = Omit<JSX.ScriptHTMLAttributes<HTMLScriptElement>, 'src'> & {
  src?: string
  strategy?: ScriptStrategy
  onLoad?: (event: Event) => void
  onReady?: () => void
  onError?: (event: Event) => void
  children?: string
}

/**
 * Client runtime for next/script. Mirrors Next's imperative loader: scripts are created and appended to
 * the document rather than rendered inline so that load ordering, onLoad/onReady callbacks and -
 * crucially - deduplication all behave like the real thing.
 *
 * `LoadCache` is keyed by `id ?? src` (Next's cache key), so two `<Script id="x">` execute the
 * underlying script exactly once, and the cache survives soft navigations so the same src/id is never
 * re-run.
 */
const LoadCache = new Set<string>()
const ScriptCache = new Map<string, Promise<void>>()

const SKIP_PROPS = new Set([
  'src',
  'strategy',
  'onLoad',
  'onReady',
  'onError',
  'children',
  'dangerouslySetInnerHTML',
])

function applyAttrs(el: HTMLScriptElement, props: ScriptProps) {
  for (const [key, value] of Object.entries(props)) {
    if (SKIP_PROPS.has(key) || key.startsWith('on')) continue
    if (value == null || value === false || typeof value === 'function') continue
    const name = key === 'className' ? 'class' : key === 'htmlFor' ? 'for' : key.toLowerCase()
    el.setAttribute(name, value === true ? '' : String(value))
  }
}

function inlineHtml(props: ScriptProps): string | undefined {
  if (typeof props.children === 'string') return props.children
  const dangerous = props.dangerouslySetInnerHTML as { __html?: unknown } | undefined
  if (dangerous && typeof dangerous.__html === 'string') return dangerous.__html
  return undefined
}

/**
 * Imperatively load/execute a script, deduping on `id ?? src`. `onReady` fires *after* the script has
 * finished loading (for src) or executing (inline) - never on mere ref-mount - and re-fires for a cached
 * script without re-running it, matching Next.
 */
function loadScript(props: ScriptProps): void {
  const { src, id, onLoad, onReady, onError } = props
  const cacheKey = (typeof id === 'string' && id) || src

  if (cacheKey && LoadCache.has(cacheKey)) {
    const pending = ScriptCache.get(cacheKey)
    if (pending) pending.then(() => onReady?.()).catch(() => undefined)
    else onReady?.()
    return
  }
  if (cacheKey) LoadCache.add(cacheKey)

  const el = document.createElement('script')
  applyAttrs(el, props)
  if (typeof id === 'string') el.id = id

  if (src) {
    const promise = new Promise<void>((resolve, reject) => {
      el.addEventListener('load', event => {
        onLoad?.(event)
        resolve()
      })
      el.addEventListener('error', event => {
        onError?.(event)
        reject(event instanceof Error ? event : new Error('next/script failed to load'))
      })
    })
    if (cacheKey) ScriptCache.set(cacheKey, promise)
    promise.then(() => onReady?.()).catch(() => undefined)
    el.src = src
    // Append the executing tag only once the resource is warm (Next appends from its mount effect AFTER
    // ReactDOM.preload has resolved the src). Then the tag's own fetch is a cache hit and it executes
    // within a tick of entering the DOM, so a consumer that reads the script's side effects right after
    // observing the tag sees the executed state. Appending eagerly makes the tag observable while the
    // script is still downloading, so that read races ahead of execution. The document already carries an
    // SSR preload link for this src, so the download is already in flight regardless of when hydration
    // runs - this warm-up link just yields a load event to gate on and dedupes onto that same fetch.
    warmThenAppend(el, src, props)
    return
  }

  const html = inlineHtml(props)
  if (html !== undefined) {
    el.innerHTML = html
    // A script element created via createElement + appended to the document
    // executes synchronously here, so onReady is safe to fire immediately after.
    document.body.appendChild(el)
    onReady?.()
  }
}

/**
 * Append `el` (a `<script src>`) only after `src` is downloaded, so the tag is
 * observable in the DOM only once its execution is a cache hit (a tick away).
 * Mirrors Next's preload-then-append ordering. A throwaway `<link rel=preload>`
 * gives us the load signal and dedupes onto the resource's existing fetch (the
 * SSR preload / the script's own fetch); on any failure we append anyway so a
 * blocked-preload environment still runs the script.
 */
function warmThenAppend(el: HTMLScriptElement, src: string, props: ScriptProps): void {
  const append = () => {
    if (el.isConnected) return
    document.body.appendChild(el)
  }
  let warm: HTMLLinkElement
  try {
    warm = document.createElement('link')
    warm.rel = 'preload'
    warm.as = 'script'
    warm.href = src
    if (typeof props.crossOrigin === 'string') warm.crossOrigin = props.crossOrigin
    if (typeof props.nonce === 'string') warm.nonce = props.nonce
  } catch {
    append()
    return
  }
  const done = () => {
    warm.remove()
    append()
  }
  warm.addEventListener('load', done, { once: true })
  warm.addEventListener('error', done, { once: true })
  document.head.appendChild(warm)
  // Safety net: never leave the script unappended if the link never settles
  // (some browsers do not fire load for an already-cached preload).
  setTimeout(append, 1500)
}

export default function Script(props: ScriptProps) {
  const strategy = props.strategy ?? 'afterInteractive'

  // Next's app-router Script preloads an EXTERNAL before/afterInteractive script while the document
  // renders (ReactDOM.preload) and only appends the executing tag from its mount effect. Without the
  // preload the browser starts fetching only once the effect runs, so third-party code the page is
  // expected to have already run lands too late. registerResourceHint is server-only, so this is exactly
  // the SSR-side half of Next's behavior; the mount effect below still owns execution and dedup.
  // lazyOnload is deliberately excluded - Next does not preload something fetched minutes later either.
  if (
    !process.browser &&
    typeof window === 'undefined' &&
    props.src &&
    (strategy === 'afterInteractive' || strategy === 'beforeInteractive')
  ) {
    registerResourceHint({
      rel: 'preload',
      as: 'script',
      url: props.src,
      ...(typeof props.nonce === 'string' || typeof props.crossOrigin === 'string'
        ? {
            attributes: {
              ...(typeof props.nonce === 'string' ? { nonce: props.nonce } : {}),
              ...(typeof props.crossOrigin === 'string' ? { crossorigin: props.crossOrigin } : {}),
            },
          }
        : {}),
    })
  }

  useEffect(() => {
    if (strategy === 'worker') return

    if (strategy === 'lazyOnload') {
      let cancelled = false
      const run = () => {
        if (!cancelled) loadScript(props)
      }
      if (typeof requestIdleCallback === 'function') {
        const handle = requestIdleCallback(run)
        return () => {
          cancelled = true
          if (typeof cancelIdleCallback === 'function') cancelIdleCallback(handle)
        }
      }
      const timer = setTimeout(run, 1)
      return () => {
        cancelled = true
        clearTimeout(timer)
      }
    }

    // afterInteractive + beforeInteractive: load as soon as the island mounts.
    loadScript(props)
    return undefined
  }, [strategy, props.src, props.id])

  if (strategy === 'worker') {
    const {
      onLoad: _onLoad,
      onReady: _onReady,
      onError: _onError,
      children,
      strategy: _s,
      ...rest
    } = props
    const html = typeof children === 'string' ? children : inlineHtml(props)
    const inline = html !== undefined ? { dangerouslySetInnerHTML: { __html: html } } : {}
    return <script {...rest} type="text/partytown" data-nscript="worker" {...inline} />
  }

  return null
}

export { Script }
