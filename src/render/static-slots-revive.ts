import type { h, VNode } from 'preact'

// Client half of the static-slot protocol, split out of ./static-slots so it stays PREACT-FREE:
// entries import it eagerly, and a visible-dynamic entry must not pull preact into its static graph
// (preact declares no `sideEffects: false`, so even an unused binding keeps the chunk import alive).
// `createElement` is therefore threaded in from the island mount, where preact is lazily imported.

export const ISLAND_STATIC_SLOT_ATTRIBUTE = 'data-pnext-static-slot'
export const ISLAND_STATIC_SLOT_MARKER = '$$pnext_slot'

type Props = Record<string, unknown>

/** Cheap gate on the raw props attribute so islands with no element props skip the revive walk. */
export function hasIslandStaticSlots(raw: string) {
  return raw.includes(ISLAND_STATIC_SLOT_MARKER)
}

/**
 * Client mount: swap each `$$pnext_slot` marker for a `pnext-static-slot` host holding the matching
 * server-rendered DOM, converted to vnodes by the entry's DOM walker (so nested islands inside the
 * adopted subtree become real island vnodes and hydrate on their own). The content is static server
 * markup - it never re-renders, same as element children.
 */
export async function reviveIslandStaticSlots(
  props: Props,
  root: ParentNode,
  toChildren: (node: ParentNode) => unknown,
  createElement: typeof h,
): Promise<Props> {
  return (await reviveSlots(props, root, toChildren, createElement, new Set())) as Props
}

async function reviveSlots(
  value: unknown,
  root: ParentNode,
  toChildren: (node: ParentNode) => unknown,
  createElement: typeof h,
  seen: Set<object>,
): Promise<unknown> {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  const marker = (value as Props)[ISLAND_STATIC_SLOT_MARKER]
  if (typeof marker === 'string') {
    const node = root.querySelector(`[${ISLAND_STATIC_SLOT_ATTRIBUTE}="${cssEscape(marker)}"]`)
    // No server markup for this slot (the island never rendered the prop, or it was skipped for
    // SSR): nothing to adopt, so the prop arrives null rather than as an empty host.
    if (!node) return null
    return createElement(
      'pnext-static-slot',
      { [ISLAND_STATIC_SLOT_ATTRIBUTE]: marker, style: { display: 'contents' } },
      (await toChildren(node)) as VNode,
    )
  }
  const proto = Object.getPrototypeOf(value) as object | null
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return value
  seen.add(value)
  const target = value as Props
  for (const key of Object.keys(target)) {
    target[key] = await reviveSlots(target[key], root, toChildren, createElement, seen)
  }
  return value
}

function cssEscape(value: string) {
  return value.replace(/["\\]/g, '\\$&')
}
