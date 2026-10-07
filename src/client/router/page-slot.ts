type PageSlotRange = [start: Element | Comment, end: Comment | undefined, nodes: ChildNode[]]

/** Resolve either wire form of a page slot inside a preserved server segment. */
export function pageSlotRange(segment: Element): PageSlotRange | null {
  const element = segment.querySelector('#pnext-page')
  if (element) return [element, undefined, [...element.childNodes]]
  const walker = document.createTreeWalker(segment, 128 /* NodeFilter.SHOW_COMMENT */)
  while (walker.nextNode()) {
    const start = walker.currentNode as Comment
    if (!start.data.startsWith('pnext-page:')) continue
    const nodes: ChildNode[] = []
    let end = start.nextSibling
    while (end && !(end.nodeType === 8 && end.nodeValue === '/pnext-page')) {
      nodes.push(end)
      end = end.nextSibling
    }
    return end ? [start, end as Comment, nodes] : null
  }
  return null
}

/** Whether an element belongs to the page slot in either DOM form. */
export function elementInPageSlot(element: Element): boolean {
  return !!(
    element.closest('#pnext-page') ||
    pageSlotRange(document.body)?.[2].some(node => node.contains(element))
  )
}

const SEGMENT = 'pnext-layout[data-pnext-segment]'

/** A server layout's identity and the URL prefix it rendered for. */
export function segmentKey(segment: Element): string {
  return `${segment.getAttribute('data-pnext-segment')}\u0001${segment.getAttribute('data-pnext-scope')}`
}

/** The server layout directly below `segment`, outside parallel-route slots. */
export function childSegment(segment: Element): Element | null {
  for (const child of segment.querySelectorAll(SEGMENT))
    if (!segment.contains(child.closest('[data-pnext-slot]'))) return child
  return null
}

/**
 * The live layout below the deepest layout `boundary` shares with `slot` (null when that layout
 * holds `slot`), and the incoming node that replaces it: the boundary, or the new layout holding
 * it. Null when either sits in an island.
 */
export function divergingLayout(slot: Node, boundary: Element): [Element | null, Element] | null {
  let paint = boundary
  let owner = boundary.closest(SEGMENT)
  let below: Element | null
  for (;;) {
    const key = owner && segmentKey(owner)
    below = null
    let layout = slot.parentElement?.closest(SEGMENT)
    for (; layout && segmentKey(layout) !== key; layout = layout.parentElement?.closest(SEGMENT))
      below = layout
    if (layout || !owner) break
    paint = owner
    owner = owner.parentElement!.closest(SEGMENT)
  }
  return !boundary.closest('pnext-client') &&
    !(below ?? slot).parentElement?.closest('pnext-client')
    ? [below, paint]
    : null
}

function childNodes(segment: Element): ChildNode[] | null {
  const child = childSegment(segment)
  if (child) return [child]
  const range = pageSlotRange(segment)
  return range && (range[1] ? [range[0], ...range[2], range[1]] : [range[0]])
}

/** Replace a kept layout's children (its child layout or page slot) with the incoming ones. */
export function graftSegmentChildren(liveSegment: Element, incomingSegment: Element): boolean {
  if (!childSegment(liveSegment) && !childSegment(incomingSegment))
    return graftPageSlot(liveSegment, incomingSegment)
  const live = childNodes(liveSegment)
  const incoming = childNodes(incomingSegment)
  if (!live || !incoming) return false
  live[0]!.before(...incoming)
  for (const stale of live) stale.remove()
  return true
}

/**
 * Graft a destination page into a preserved layout without changing the destination's mount shape.
 * Client pages need the real `#pnext-page` element; server/island-only pages need the marker range.
 */
export function graftPageSlot(liveSegment: Element, incomingSegment: Element): boolean {
  const live = pageSlotRange(liveSegment)
  const incoming = pageSlotRange(incomingSegment)
  if (!live || !incoming) return false
  const nodes = reusePageNodes(live[2], incoming[2])
  for (const stale of live[2]) stale.remove()
  const end = incoming[1]
  if (!end) (incoming[0] as Element).replaceChildren(...nodes)
  else {
    for (const stale of incoming[2]) stale.remove()
  }
  live[0].replaceWith(incoming[0])
  if (end) incoming[0].after(...nodes, end)
  live[1]?.remove()
  return true
}

// Next re-renders a page in place, so unchanged DOM keeps its node identity.
function reusePageNodes(live: readonly ChildNode[], incoming: readonly Node[]): Node[] {
  const candidates = live.filter(
    (node): node is Element =>
      node instanceof Element &&
      !node.matches('script, pnext-client, #pnext-page') &&
      !node.querySelector('pnext-client, #pnext-page, [data-pnext-preserve]'),
  )
  return incoming.map(node => {
    if (!(node instanceof Element)) return node
    const index = candidates.findIndex(candidate => candidate.outerHTML === node.outerHTML)
    return index === -1 ? node : candidates.splice(index, 1)[0]!
  })
}

export interface LoadingShellTarget {
  container: HTMLElement
  markerRange?: PageSlotRange
}

/** Resolve a safe loading-shell target without falling through a dissolved page to the body. */
export function loadingShellTarget(): LoadingShellTarget {
  const page = document.getElementById('pnext-page')
  if (page) return { container: page }
  const markerRange = pageSlotRange(document.body)
  if (markerRange?.[1]) {
    return { container: markerRange[0].parentElement!, markerRange }
  }
  const root = document.querySelector<HTMLElement>('[data-pnext-root]')
  return { container: root ?? document.body }
}
