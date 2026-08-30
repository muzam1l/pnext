import { h, type ComponentChildren } from 'preact'

export const ISLAND_STATIC_CHILDREN_ATTRIBUTE = 'data-pnext-static-children'

export function islandStaticChildren(id: string, children: ComponentChildren) {
  if (!hasIslandStaticChildren(children)) return undefined
  return h(
    'pnext-static-children',
    { [ISLAND_STATIC_CHILDREN_ATTRIBUTE]: id, style: { display: 'contents' } },
    children,
  )
}

function hasIslandStaticChildren(children: ComponentChildren) {
  return Array.isArray(children) ? children.length > 0 : children != null && children !== false
}

/**
 * Children that can cross the server-to-client island boundary INSIDE the serialized props (strings and
 * numbers, or arrays of them). Element children return undefined and travel via DOM adoption instead.
 */
export function plainIslandChildren(
  children: ComponentChildren,
): string | number | (string | number)[] | undefined {
  if (typeof children === 'string' || typeof children === 'number') return children
  if (
    Array.isArray(children) &&
    children.length > 0 &&
    children.every(child => typeof child === 'string' || typeof child === 'number')
  ) {
    return children as (string | number)[]
  }
  return undefined
}
