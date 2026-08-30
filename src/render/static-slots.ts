import { h, type VNode } from 'preact'
import { isElementLike } from '../utils/serialize'
import { ISLAND_STATIC_SLOT_ATTRIBUTE, ISLAND_STATIC_SLOT_MARKER } from './static-slots-revive'

// The client half lives in ./static-slots-revive (preact-free); re-exported so importers keep one entry point.
export * from './static-slots-revive'

type Props = Record<string, unknown>

/**
 * Element-valued island props travel exactly like element children: the SSR pass wraps each one in a
 * `pnext-static-slot` host ('ssr') and the serialized props carry a `$$pnext_slot` id in its place
 * ('wire'). Both walks see the same prop shape, so the ids line up. Elements nested in arrays and
 * plain objects are covered; anything else (Map/Set values, class instances) is left alone.
 */
export function islandStaticSlotProps(id: string, props: Props, mode: 'ssr' | 'wire'): Props {
  return mapSlots(props, id, mode, [], new Set()) as Props
}

function mapSlots(
  value: unknown,
  id: string,
  mode: 'ssr' | 'wire',
  path: string[],
  seen: Set<object>,
): unknown {
  if (isElementLike(value)) {
    const slot = `${id}:${path.join('.')}`
    if (mode === 'wire') return { [ISLAND_STATIC_SLOT_MARKER]: slot }
    return h(
      'pnext-static-slot',
      { [ISLAND_STATIC_SLOT_ATTRIBUTE]: slot, style: { display: 'contents' } },
      value as VNode,
    )
  }
  if (value === null || typeof value !== 'object') return value
  // Cyclic props are supported by the serializer; never walk a container twice.
  if (seen.has(value)) return value
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return value
  seen.add(value)
  let changed = false
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value)
  const mapped = entries.map(([key, item]) => {
    const next = mapSlots(item, id, mode, [...path, key], seen)
    if (next !== item) changed = true
    return [key, next] as const
  })
  seen.delete(value)
  // Untouched branches keep their identity (the taint check compares by identity).
  if (!changed) return value
  if (Array.isArray(value)) return mapped.map(([, item]) => item)
  return Object.fromEntries(mapped)
}
