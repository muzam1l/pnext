import { useEffect, useState } from 'preact/hooks'
import { blockJavascriptUrl } from '../../client/router'

/**
 * Pages-router surface, present so shared components importing next/router
 * still build. pnext is app-router only; navigation maps to the pnext router
 * where it can and no-ops where pages-router concepts don't exist.
 */

type RouterEventHandler = (...args: unknown[]) => void

const noop = () => undefined

const routerEvents = {
  on: noop as (event: string, handler: RouterEventHandler) => void,
  off: noop as (event: string, handler: RouterEventHandler) => void,
  emit: noop as (event: string, ...args: unknown[]) => void,
}

export interface PagesRouter {
  pathname: string
  route: string
  query: Record<string, string | string[]>
  asPath: string
  basePath: string
  isReady: boolean
  isFallback: boolean
  isPreview: boolean
  events: typeof routerEvents
  push(url: string): Promise<boolean>
  replace(url: string): Promise<boolean>
  prefetch(url: string): Promise<void>
  back(): void
  forward(): void
  reload(): void
}

interface PagesRouterState {
  pathname?: string
  asPath?: string
  query?: Record<string, string | string[]>
}

// The pages-router state the materialized page wrapper emits: SSR reads the
// per-request scope (anchored on globalThis — this module is bundled per
// layer), the browser reads the inline __PNEXT_PAGES_DATA__ JSON node that
// ships with (and is swapped along with) the page HTML.
function pagesRouterState(browser: boolean): PagesRouterState | undefined {
  if (!browser) {
    const storage = (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for('pnext.requestStorage')
    ] as { getStore(): Record<PropertyKey, unknown> | undefined } | undefined
    return storage?.getStore?.()?.[Symbol.for('pnext.pagesRouterState')] as
      PagesRouterState | undefined
  }
  const node = document.getElementById('__PNEXT_PAGES_DATA__')
  if (!node?.textContent) return undefined
  try {
    return JSON.parse(node.textContent) as PagesRouterState
  } catch {
    return undefined
  }
}

function browserQuery(url: URL): Record<string, string> {
  const query: Record<string, string> = {}
  for (const [key, value] of url.searchParams) {
    if (key !== '_rsc') query[key] = value
  }
  return query
}

function currentRouter(ready: boolean): PagesRouter {
  const browser = process.browser || typeof window !== 'undefined'
  const url = browser ? new URL(window.location.href) : undefined
  const state = pagesRouterState(browser)
  const pathname = state?.pathname ?? url?.pathname ?? '/'
  return {
    pathname,
    route: pathname,
    // In the browser the address bar's own search params overlay the
    // server-computed query (they are the live values after shallow/query-only
    // history updates); on the server the state already merged them. The
    // router-fetch cache key (`_rsc`) is never part of the page's query.
    query: url ? { ...(state?.query ?? {}), ...browserQuery(url) } : (state?.query ?? {}),
    asPath: url ? `${url.pathname}${url.search}` : (state?.asPath ?? '/'),
    basePath: '',
    isReady: browser && ready,
    isFallback: false,
    isPreview: false,
    events: routerEvents,
    push(target: string) {
      if (blockJavascriptUrl(target)) return Promise.resolve(false)
      if (browser) window.location.href = target
      return Promise.resolve(true)
    },
    replace(target: string) {
      if (blockJavascriptUrl(target)) return Promise.resolve(false)
      if (browser) window.location.replace(target)
      return Promise.resolve(true)
    },
    prefetch(target: string) {
      blockJavascriptUrl(target)
      return Promise.resolve()
    },
    back() {
      if (browser) window.history.back()
    },
    forward() {
      if (browser) window.history.forward()
    },
    reload() {
      if (browser) window.location.reload()
    },
  }
}

// Next semantics: isReady is FALSE during the hydration render (matching the SSR markup - preact
// hydrate adopts DOM without patching mismatches, so a true-at-hydration value would never reach
// attributes) and flips via a post-hydration re-render. Once flipped, later mounts see true immediately.
let pagesRouterReady = false

export function useRouter(): PagesRouter {
  const [ready, setReady] = useState(pagesRouterReady)
  useEffect(() => {
    pagesRouterReady = true
    setReady(true)
  }, [])
  return currentRouter(ready)
}

export const Router = { events: routerEvents }
export default Router

export function withRouter<Props extends { router?: PagesRouter }>(
  Component: (props: Props) => unknown,
) {
  return (props: Omit<Props, 'router'>) =>
    Component({ ...props, router: currentRouter(pagesRouterReady) } as Props)
}
