import type { NavigationScrollAction, NavigationScrollOptions } from '../../client/router'

const RECT_PROPERTIES = ['bottom', 'height', 'left', 'right', 'top', 'width', 'x', 'y'] as const

export type NextScrollPlan = 'hash' | 'preserve' | 'restore' | 'top' | 'top-then-target'

export function nextScrollPlan(
  url: URL,
  options: NavigationScrollOptions,
  targetInViewport: boolean | undefined,
): NextScrollPlan {
  if (options.pop) return 'restore'
  if (options.scroll === false) return 'preserve'
  if (url.hash) return 'hash'
  if (targetInViewport === undefined) return 'top'
  return targetInViewport ? 'preserve' : 'top-then-target'
}

export function topOnlyScrollPosition(scrollX: number): [number, number] {
  return [scrollX, 0]
}

// A pop restore fires right after the body swap, when the incoming tree can still be shorter
// than the saved offset — the browser clamps scrollTo against the live height and the position
// is lost even though a reapply comes a frame later. Reserving the departing document's
// recorded height keeps the restore un-clamped; released once content is tall enough (the
// reapply) or on the next navigation of any kind. The attribute both marks the reservation as
// pnext's own and preserves an app-authored inline min-height for the release.
const SCROLL_RESERVE_ATTR = 'data-pnext-scroll-reserve'

function releaseScrollHeightReservation() {
  const root = document.documentElement
  const original = root.getAttribute(SCROLL_RESERVE_ATTR)
  if (original === null) return
  root.removeAttribute(SCROLL_RESERVE_ATTR)
  root.style.minHeight = original
}

function restoreScrollWithReservedHeight(x: number, y: number, height: number | undefined) {
  const root = document.documentElement
  if (height && root.scrollHeight < y + root.clientHeight) {
    root.setAttribute(SCROLL_RESERVE_ATTR, root.style.minHeight)
    root.style.minHeight = `${height}px`
  }
  window.scrollTo(x, y)
}

export const applyNextNavigationScroll: NavigationScrollAction = (url, options) => {
  releaseScrollHeightReservation()
  const segmentElements = changedSegmentElements()
  const target = scrollFocusTarget(segmentElements)
  const plan = nextScrollPlan(
    url,
    options,
    target ? targetTopInViewport(target, document.documentElement.clientHeight) : undefined,
  )
  if (plan === 'restore') {
    const state = history.state as { __pnextScroll?: [number, number, number?] } | null
    const [x, y, height] = state?.__pnextScroll ?? [0, 0]
    restoreScrollWithReservedHeight(x, y, height)
    return
  }
  // React hoists a rendered <style precedence>/<link rel=stylesheet>/metadata element out of the segment
  // and into <head>. Next resolves its scroll target with findDOMNode() on the changed segment, so when
  // the segment's FIRST host element is one of those the walk starts inside <head>, skips every
  // zero-rect sibling there and runs out - the navigation scrolls nowhere and focuses nothing. pnext
  // renders those elements in place, so recognize the leading hoisted element and reproduce the same
  // no-op. Placed after `restore` so history traversal still restores its saved position.
  if (segmentLeadsWithHoistedElement(segmentElements)) return
  if (plan === 'hash') {
    scrollToHash(url.hash)
    return
  }
  if (plan === 'preserve') {
    if (target && options.scroll !== false) focusSegment(target)
    return
  }
  if (plan === 'top') {
    window.scrollTo(...topOnlyScrollPosition(window.scrollX))
    return
  }
  if (!target) return
  window.scrollTo(...topOnlyScrollPosition(window.scrollX))
  if (!targetTopInViewport(target, document.documentElement.clientHeight)) target.scrollIntoView()
  focusSegment(target)
}

function shouldSkipScrollElement(element: HTMLElement) {
  const position = getComputedStyle(element).position
  if (position === 'sticky' || position === 'fixed') return true
  const rect = element.getBoundingClientRect()
  return RECT_PROPERTIES.every(item => rect[item] === 0)
}

function targetTopInViewport(element: HTMLElement, viewportHeight: number) {
  const rects = element.getClientRects()
  if (rects.length === 0) return false
  let top = Number.POSITIVE_INFINITY
  for (const rect of rects) top = Math.min(top, rect.top)
  return top >= 0 && top <= viewportHeight
}

function scrollFocusTarget(nodes: HTMLElement[]): HTMLElement | null {
  // Next resolves the target with findDOMNode() on the changed segment: the
  // FIRST host element the segment rendered, never a descendant of it. The page
  // container IS that segment, so its first element child is the target as-is.
  // The fallback roots below wrap the segment in pnext's own chrome, so there
  // the single-child chain is walked down to the content that segment rendered.
  return nodes.find(node => !shouldSkipScrollElement(node)) ?? null
}

/** The renderer's page-slot wrapper — the segment a navigation replaced. */
const PAGE_CONTAINER_ID = 'pnext-page'

// Elements React relocates into <head> when a component renders them.
const HOISTED_TAGS = new Set(['style', 'link', 'title', 'meta', 'base'])

/**
 * Whether the changed segment's first rendered element is one React would have hoisted into <head> -
 * the state in which Next's scroll walk never reaches the page content (see the call site).
 */
function segmentLeadsWithHoistedElement(elements: HTMLElement[]): boolean {
  return elements[0] !== undefined && HOISTED_TAGS.has(elements[0].localName)
}

function changedSegmentElements(): HTMLElement[] {
  const page = document.getElementById(PAGE_CONTAINER_ID)
  if (page instanceof HTMLElement) return Array.from(page.children).filter(isHtmlElement)

  const walker = document.createTreeWalker(document.body, 128 /* NodeFilter.SHOW_COMMENT */)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.nodeValue?.startsWith('pnext-page:')) continue
    const elements: HTMLElement[] = []
    for (let sibling = node.nextSibling; sibling; sibling = sibling.nextSibling) {
      if (sibling.nodeType === 8 /* Node.COMMENT_NODE */ && sibling.nodeValue === '/pnext-page')
        return elements
      if (sibling instanceof HTMLElement) elements.push(sibling)
    }
    break
  }

  const root = document.querySelector('[data-pnext-root]')
  const segment = root instanceof HTMLElement ? root : document.body
  let first = segment.firstElementChild instanceof HTMLElement ? segment.firstElementChild : null
  while (first?.nextElementSibling === null && first.firstElementChild instanceof HTMLElement)
    first = first.firstElementChild
  const elements: HTMLElement[] = []
  for (let node = first; node;) {
    elements.push(node)
    node = node.nextElementSibling instanceof HTMLElement ? node.nextElementSibling : null
  }
  return elements
}

function isHtmlElement(element: Element): element is HTMLElement {
  return element instanceof HTMLElement
}

function scrollToHash(hash: string) {
  const id = decodeURIComponent(hash.slice(1))
  const target = id === 'top' ? document.body : (document.getElementById(id) ?? namedTarget(id))
  target?.scrollIntoView()
}

function namedTarget(name: string): HTMLElement | null {
  const named = document.getElementsByName(name)[0]
  return named instanceof HTMLElement ? named : null
}

function focusSegment(target: HTMLElement) {
  try {
    target.focus({ preventScroll: true })
  } catch {
    // A swap can detach the target before focus runs.
  }
}
