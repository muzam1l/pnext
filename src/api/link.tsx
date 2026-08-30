/** @jsxImportSource preact */
import { h, type ComponentChildren, type JSX } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react'
import { getDefaultPrefetchMode, routeHref, type SearchInput } from '../routing/href'
import type { PrefetchMode, RouteParams, RoutePath } from '../types'

export interface NavigateEvent {
  preventDefault(): void
}

type LinkMouseEvent = MouseEvent<HTMLAnchorElement>

type BaseLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'> & {
  prefetch?: PrefetchMode
  replace?: boolean
  scroll?: boolean
  search?: SearchInput
  hash?: string
  onClick?: (event: LinkMouseEvent) => void
  onNavigate?: (event: NavigateEvent) => void
  onPrefetchStart?: () => void
  onPrefetchFinish?: () => void
  children?: ReactNode
}

type ParamsProp<Route extends RoutePath> =
  RouteParams<Route> extends Record<string, never>
    ? { params?: never }
    : { params: RouteParams<Route> }

export type LinkProps<Route extends RoutePath = RoutePath> = BaseLinkProps &
  ParamsProp<Route> & {
    href: Route
  }

export function Link<Route extends RoutePath>({
  href,
  params,
  prefetch,
  replace,
  scroll,
  search,
  hash,
  onClick,
  onNavigate,
  onPrefetchStart,
  onPrefetchFinish,
  children,
  ...anchorProps
}: LinkProps<Route>): ReactNode {
  const resolvedHref = routeHref(href, { params: params ?? {}, search, hash })
  // A link's own prefetch prop wins; otherwise the app-wide config default.
  const prefetchMode = prefetch ?? getDefaultPrefetchMode()
  const anchorRef = usePrefetchLifecycle(onPrefetchStart, onPrefetchFinish)
  return h(
    'a',
    {
      ...anchorProps,
      ref: anchorRef,
      href: resolvedHref,
      'data-pnext-link': true,
      'data-prefetch': prefetchMode === false ? 'false' : prefetchMode,
      'data-pnext-replace': replace ? 'true' : undefined,
      'data-pnext-scroll': scroll === false ? 'false' : undefined,
      onClick: event => {
        const clickEvent = event as unknown as LinkMouseEvent
        onClick?.(clickEvent)
        if (clickEvent.defaultPrevented || !onNavigate || !isPlainLeftClick(clickEvent)) return
        const navEvent = navigationEvent()
        onNavigate(navEvent)
        if (navEvent.defaultPrevented) clickEvent.preventDefault()
      },
    } as JSX.HTMLAttributes<HTMLAnchorElement>,
    children as ComponentChildren,
  ) as unknown as ReactNode
}

// The prefetch runtime dispatches lifecycle events on the anchor that
// triggered a prefetch, for every mode (intent, visible, load).
export function usePrefetchLifecycle(onStart?: () => void, onFinish?: () => void) {
  const anchorRef = useRef<HTMLAnchorElement | null>(null)

  useEffect(() => {
    const node = anchorRef.current
    if (!node || (!onStart && !onFinish)) return
    const handleStart = () => onStart?.()
    const handleFinish = () => onFinish?.()
    node.addEventListener('pnext:prefetchstart', handleStart)
    node.addEventListener('pnext:prefetchfinish', handleFinish)
    return () => {
      node.removeEventListener('pnext:prefetchstart', handleStart)
      node.removeEventListener('pnext:prefetchfinish', handleFinish)
    }
  }, [onStart, onFinish])

  return anchorRef
}

function navigationEvent() {
  return {
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true
    },
  }
}

function isPlainLeftClick(event: LinkMouseEvent) {
  return (
    event.button === 0 &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.currentTarget.target &&
    !event.currentTarget.download
  )
}
