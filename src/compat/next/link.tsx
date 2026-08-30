/** @jsxImportSource preact */
// preact core + hooks only (no preact/compat): this module rides in every compat app's first-page
// bundle, and the lite client tier must not pull compat through it. Children.only/count are replaced
// with toChildArray below; the ref arrives React-19-style as a prop (the parity vnode pass moves
// vnode.ref into props for function components).
import { cloneElement, h as createElement, toChildArray, type JSX } from 'preact'
import { useContext, useEffect, useRef, useState } from 'preact/hooks'
import type { MutableRefObject, ReactElement, ReactNode, Ref } from 'react'
import { usePrefetchLifecycle } from '../../api/link'
import { blockJavascriptUrl, isJavascriptUrl } from '../../client/router'
import { applyTrailingSlash, routeHref, type SearchInput } from '../../routing/href'
import { skipTrailingSlashRedirect } from '../client/trailing-slash'
import type { PrefetchMode } from '../../types'
import {
  LinkStatusContext,
  linkPending,
  navigateWithStatus,
  subscribeLinkStatus,
} from '../client/link-status'
import { addBasePath } from '../client/base-path'
import { addTransitionType } from '../react/view-transition'

const reactClientReferenceSymbol = Symbol.for('react.client.reference')

// Client-graph bundler define (compat/register/bundler.ts): false drops the
// whole legacy child path from a bundle whose app provably never renders
// `<Link legacyBehavior>`. Undefined (server render, unbundled consumer) keeps
// it, so the gate can only ever remove bytes an app proved it cannot use.
declare const __PNEXT_LINK_LEGACY__: boolean
type LegacyChildKind =
  'server-sync' | 'server-async' | 'server-async-through-client' | 'lazy' | 'client-lazy'

export interface UrlObject {
  pathname?: string
  query?: SearchInput
  hash?: string
}

export interface NavigateEvent {
  preventDefault(): void
}

export type LinkProps = Omit<JSX.HTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick' | 'ref'> & {
  href: string | URL | UrlObject
  as?: string | URL | UrlObject
  replace?: boolean
  scroll?: boolean
  prefetch?: boolean | 'auto' | 'unstable_forceStale' | null
  /** Hovering the link upgrades its prefetch to include the dynamic data. */
  unstable_dynamicOnHover?: boolean
  locale?: string | false
  legacyBehavior?: boolean
  passHref?: boolean
  onClick?: JSX.MouseEventHandler<HTMLAnchorElement>
  onNavigate?: (event: NavigateEvent) => void
  /**
   * View-transition types declared for the navigation this Link starts, so
   * `:active-view-transition-type(...)` rules match while it runs. Consumed
   * here (never forwarded to the anchor as an attribute).
   */
  transitionTypes?: string[]
  onPrefetchStart?: () => void
  onPrefetchFinish?: () => void
  /** @internal Preserves legacy child classification across server resolution. */
  __pnextLegacyChildKind?: LegacyChildKind
  ref?: Ref<HTMLAnchorElement>
  children?: ReactNode
}

// Ref arrives as a prop (React 19 style): the parity vnode pass moves vnode.ref into props for plain
// function components, on both server and client, so forwardRef is unnecessary.
function Link({
  href,
  as,
  prefetch = null,
  unstable_dynamicOnHover,
  replace,
  scroll,
  locale: _locale,
  legacyBehavior,
  passHref,
  onClick,
  onNavigate,
  transitionTypes,
  onPrefetchStart,
  onPrefetchFinish,
  __pnextLegacyChildKind,
  children,
  ref: forwardedRef,
  ...anchorProps
}: LinkProps) {
  // `as` supersedes `href` for what the anchor actually points at (app router).
  const target = as == null ? href : as
  // basePath: prefix in-app hrefs so the rendered anchor (and the soft-nav it
  // drives) points under the configured basePath, matching Next. addBasePath
  // leaves external/absolute/already-prefixed hrefs untouched, and is a no-op
  // when no basePath is configured.
  // skipTrailingSlashRedirect preserves the author's exact trailing slash (both
  // the rendered anchor and the soft-nav it drives); otherwise normalize per
  // the trailingSlash config so the anchor matches the canonical URL.
  const hrefBase = hrefString(target)
  const resolvedHref = addBasePath(
    skipTrailingSlashRedirect() ? hrefBase : applyTrailingSlash(hrefBase),
  )
  const blocked = isJavascriptUrl(resolvedHref)
  const prefetchMode = nextPrefetchMode(prefetch)
  const lifecycleRef = usePrefetchLifecycle(onPrefetchStart, onPrefetchFinish)
  const anchorRef = useComposedRef(lifecycleRef, forwardedRef)
  const statusToken = useLinkToken()

  const handleClick = (event: JSX.TargetedMouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (event.defaultPrevented) return

    if (blocked) {
      // Same guard the runtime applies to static links; a hydrated Link cancels
      // its own default so the javascript: URL never runs.
      if (blockJavascriptUrl(resolvedHref)) event.preventDefault()
      return
    }

    // Modifier/middle clicks, target, download: let the browser handle it;
    // onNavigate does not fire (matches Next).
    if (!isPlainLeftClick(event)) return

    if (isExternalHref(resolvedHref)) {
      // External hrefs never soft-navigate and never fire onNavigate. `replace`
      // still swaps history rather than pushing.
      if (replace) {
        event.preventDefault()
        window.location.replace(resolvedHref)
      }
      return
    }

    // Internal soft navigation: onNavigate can cancel, and this Link drives the
    // navigation itself so useLinkStatus tracks it. preventDefault keeps the
    // router's document-level handler from navigating a second time.
    if (onNavigate) {
      const navEvent = navigationEvent()
      onNavigate(navEvent)
      if (navEvent.defaultPrevented) {
        event.preventDefault()
        return
      }
    }

    event.preventDefault()
    for (const type of transitionTypes ?? []) addTransitionType(type)
    const url = new URL(resolvedHref, window.location.href)
    const samePage =
      url.pathname === window.location.pathname && url.search === window.location.search
    if (samePage && url.hash) {
      window.location.hash = url.hash
      return
    }
    navigateWithStatus(statusToken, url.href, { replace, scroll })
  }

  const anchorAttributes: Record<string, unknown> = {
    ...anchorProps,
    ref: anchorRef,
    href: resolvedHref,
    'data-pnext-link': true,
    'data-prefetch': prefetchMode === false ? 'false' : prefetchMode,
    // prefetch={true} requests a FULL prefetch (5-min static window) vs the
    // default partial/dynamic 30s window; the router reads this attribute.
    // 'unstable_forceStale' is Next 16's alias for the full prefetch mode.
    'data-prefetch-full':
      prefetch === true || prefetch === 'unstable_forceStale' ? 'true' : undefined,
    // unstable_dynamicOnHover: hover intent upgrades the (viewport, partial)
    // prefetch to a full one that includes the dynamic data.
    'data-prefetch-hover-full': unstable_dynamicOnHover ? 'true' : undefined,
    'data-pnext-replace': replace ? 'true' : undefined,
    'data-pnext-scroll': scroll === false ? 'false' : undefined,
    onClick: handleClick,
  }
  if (blocked) anchorAttributes['data-pnext-blocked-href'] = resolvedHref

  if (
    (typeof __PNEXT_LINK_LEGACY__ === 'boolean' ? __PNEXT_LINK_LEGACY__ : true) &&
    legacyBehavior
  ) {
    return renderLegacyChild(
      children,
      resolvedHref,
      passHref,
      handleClick,
      anchorAttributes,
      __pnextLegacyChildKind,
    )
  }

  return createElement(
    'a',
    anchorAttributes,
    createElement(
      LinkStatusContext.Provider,
      { value: { pending: linkPending(statusToken) } },
      children,
    ),
  ) as ReactElement
}

export default Link
export { Link }

export function useLinkStatus() {
  return useContext(LinkStatusContext)
}

// A stable per-Link identity used to key the pending navigation, plus a
// re-render on pending change so useLinkStatus consumers update.
function useLinkToken() {
  const tokenRef = useRef<symbol | null>(null)
  tokenRef.current ??= Symbol('pnext-link')
  const token = tokenRef.current
  const [, force] = useState(0)
  useEffect(() => subscribeLinkStatus(token, () => force(n => n + 1)), [token])
  return token
}

// `legacyBehavior`: the single child element becomes the interactive element;
// with passHref it receives the resolved href. Validates child count like Next.
function renderLegacyChild(
  children: ReactNode,
  resolvedHref: string,
  passHref: boolean | undefined,
  onClick: (event: JSX.TargetedMouseEvent<HTMLAnchorElement>) => void,
  anchorAttributes: Record<string, unknown>,
  annotatedKind?: LegacyChildKind,
): ReactElement {
  reportLegacyDeprecation()
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const isDev = process.env.NODE_ENV !== 'production'
  const isServer = !process.browser && typeof window === 'undefined'

  // A React.lazy payload passed directly (not wrapped in JSX) never resolves to
  // a single element child; Next reports it specifically instead of Children.only.
  if (isLazyComponent(children)) throw unsupportedLegacyChildError()

  if (children == null || children === false) {
    if (isDev) {
      throw validationError(
        `No children were passed to <Link> with \`href\` of \`${resolvedHref}\` but one child is required https://nextjs.org/docs/messages/link-no-children`,
        'E320',
      )
    }
    return childrenOnlyOrThrow(children)
  }

  // A bare string/number child renders its own <a> (Next's legacy behavior).
  if (typeof children === 'string' || typeof children === 'number') {
    return createElement(
      'a',
      { ...anchorAttributes, href: resolvedHref },
      children,
    ) as unknown as ReactElement
  }

  const count = toChildArray(children as JSX.Element).length
  if (count > 1) {
    if (isDev) {
      throw validationError(
        `Multiple children were passed to <Link> with \`href\` of \`${resolvedHref}\` but only one child is supported https://nextjs.org/docs/messages/link-multiple-children`,
        'E266',
      )
    }
    return childrenOnlyOrThrow(children)
  }

  const child = childrenOnlyOrThrow(children) as ReactElement<Record<string, unknown>>
  const kind =
    annotatedKind ??
    (isAsyncFunctionComponent(child.type)
      ? 'server-async'
      : isLazyComponent(child.type)
        ? 'lazy'
        : undefined)
  if (isServer && (kind === 'server-sync' || kind === 'server-async' || kind === 'lazy')) {
    reportUnsupportedServerChild(kind, isDev)
  }
  if (kind && kind !== 'server-sync') {
    const error = unsupportedLegacyChildError()
    if (isServer && kind === 'server-async-through-client') {
      // Print the full trace, not just the message: the thrown error is
      // swallowed downstream in this path, so without the `    at` frame lines
      // the server log for this case would end at the message and the console
      // snapshot (which slices up to the first `   at` line) would pick up the
      // trailing blank line instead of terminating at the stack.
      console.error(`⨯ ${error.stack ?? `Error: ${error.message}`}`)
    }
    throw error
  }

  if (isServer && isDev && isServerComponent(child.type)) {
    reportUnsupportedServerChild('server-sync', isDev)
  }

  const childProps: Record<string, unknown> = {
    onClick: (event: JSX.TargetedMouseEvent<HTMLAnchorElement>) => {
      ;(child.props as { onClick?: (event: unknown) => void }).onClick?.(event)
      onClick(event)
    },
  }
  if (passHref || (child.type as unknown) === 'a') {
    // The child becomes the anchor: give it the href plus the runtime's
    // soft-nav markers, so navigation/prefetch work even when the child is a
    // static (unhydrated) element and the onClick prop never runs.
    childProps.href = resolvedHref
    childProps['data-pnext-link'] = anchorAttributes['data-pnext-link']
    childProps['data-prefetch'] = anchorAttributes['data-prefetch']
    childProps['data-prefetch-full'] = anchorAttributes['data-prefetch-full']
    childProps['data-prefetch-hover-full'] = anchorAttributes['data-prefetch-hover-full']
    childProps['data-pnext-replace'] = anchorAttributes['data-pnext-replace']
    childProps['data-pnext-scroll'] = anchorAttributes['data-pnext-scroll']
  }
  return cloneElement(child as never, childProps) as ReactElement
}

function reportUnsupportedServerChild(kind: LegacyChildKind, isDev: boolean) {
  const message =
    kind === 'lazy'
      ? "Using a Lazy Component as a direct child of `<Link legacyBehavior>` from a Server Component is not supported. If you need legacyBehavior, wrap your Lazy Component in a Client Component that renders the Link's `<a>` tag."
      : "Using a Server Component as a direct child of `<Link legacyBehavior>` is not supported. If you need legacyBehavior, wrap your Server Component in a Client Component that renders the Link's `<a>` tag."
  console.error(isDev ? validationError(message, 'E394') : message)
}

function unsupportedLegacyChildError() {
  return validationError(
    "`<Link legacyBehavior>` received a direct child that is either a Server Component, or JSX that was loaded with React.lazy(). This is not supported. Either remove legacyBehavior, or make the direct child a Client Component that renders the Link's `<a>` tag.",
    'E863',
  )
}

let deprecationWarned = false
function reportLegacyDeprecation() {
  if (
    deprecationWarned ||
    (!process.browser && typeof window === 'undefined') ||
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    process.env.NODE_ENV === 'production'
  ) {
    return
  }
  deprecationWarned = true
  console.error(
    '`legacyBehavior` is deprecated and will be removed in a future release. A codemod is available to upgrade your components:\n\n' +
      'npx @next/codemod@latest new-link .\n\n' +
      'Learn more: https://nextjs.org/docs/app/building-your-application/upgrading/codemods#remove-a-tags-from-link-components',
  )
}

function validationError(message: string, digest: string) {
  return Object.assign(new Error(message), { digest })
}

// React.Children.only semantics on preact core: exactly one element child, with
// React's exact error wording for the no-children/multiple-children cases.
function childrenOnlyOrThrow(children: ReactNode): ReactElement {
  const array = toChildArray(children as JSX.Element)
  if (array.length === 1 && isValidElementLike(array[0])) return array[0] as ReactElement
  throw new Error('React.Children.only expected to receive a single React element child.')
}

function isValidElementLike(value: unknown) {
  return value !== null && typeof value === 'object' && 'type' in value
}

function isAsyncFunctionComponent(type: unknown) {
  if (typeof type !== 'function') return false
  const asyncFunctionName = Object.prototype.toString.call(type)
  return asyncFunctionName === '[object AsyncFunction]'
}

function isLazyComponent(type: unknown) {
  if (type === null || (typeof type !== 'object' && typeof type !== 'function')) return false
  const marked = type as { $$typeof?: unknown } & Record<symbol, unknown>
  return marked.$$typeof === Symbol.for('react.lazy') || marked[Symbol.for('pnext.lazy')] === true
}

function isServerComponent(type: unknown) {
  if (isClientComponent(type)) return false
  return typeof type === 'function' && (type as { $$typeof?: unknown }).$$typeof === undefined
}

function isClientComponent(type: unknown) {
  return (
    (typeof type === 'object' || typeof type === 'function') &&
    (type as { $$typeof?: unknown }).$$typeof === reactClientReferenceSymbol
  )
}

function useComposedRef(
  internalRef: MutableRefObject<HTMLAnchorElement | null>,
  userRef: Ref<HTMLAnchorElement> | undefined,
) {
  return (node: HTMLAnchorElement | null) => {
    internalRef.current = node
    assignRef(userRef, node)
  }
}

function assignRef(ref: Ref<HTMLAnchorElement> | undefined, node: HTMLAnchorElement | null) {
  if (!ref) return
  if (typeof ref === 'function') {
    // Callback refs may return a cleanup; Preact ignores it, which is fine —
    // the ref is re-run with null on unmount, matching the manual-cleanup path.
    ref(node)
    return
  }
  ref.current = node
}

function hrefString(href: string | URL | UrlObject) {
  if (typeof href === 'string') return href
  if (href instanceof URL) return href.toString()
  return routeHref(href.pathname ?? '', { search: href.query, hash: href.hash })
}

function nextPrefetchMode(prefetch: boolean | 'auto' | 'unstable_forceStale' | null): PrefetchMode {
  // Next's default prefetches when the link enters the viewport; `false` opts
  // out entirely. (`true`/'auto'/'unstable_forceStale' also map to viewport
  // prefetch here — 'auto' is an explicit alias for the default.)
  return prefetch === false ? false : 'visible'
}

function isExternalHref(href: string) {
  if (!process.browser && typeof window === 'undefined') return false
  try {
    return new URL(href, window.location.href).origin !== window.location.origin
  } catch {
    return true
  }
}

function navigationEvent() {
  return {
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true
    },
  }
}

function isPlainLeftClick(event: JSX.TargetedMouseEvent<HTMLAnchorElement>) {
  return (
    event.button === 0 &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    isSelfTarget(event.currentTarget.target) &&
    !event.currentTarget.hasAttribute('download')
  )
}

function isSelfTarget(target: string) {
  return target === '' || target === '_self'
}
