// React `<ViewTransition>` + `addTransitionType` shim (COMPAT).
//
// React's experimental View Transitions API exports a `ViewTransition` component and
// `addTransitionType` from the `react` entry. Apps import them directly from 'react', so without these
// exports every render of such a page throws `type is invalid` and the route 500s.
//
// React's ViewTransition renders NO DOM of its own - it annotates its single host child so the browser's
// View Transition API can pair it across an update. Preact has no scheduler hook to drive
// `document.startViewTransition`, so this shim keeps the same DOM shape (pure passthrough) and records
// the declared names/types; the router applies the actual transition when the browser supports it.

import { Fragment, h, type ComponentChildren, type VNode } from 'preact'

/**
 * The class/name a ViewTransition applies for a given trigger. React accepts a
 * string (a single view-transition-class) or a record keyed by transition type.
 */
export type ViewTransitionClass = string | Record<string, string>

export interface ViewTransitionProps {
  /** view-transition-name for the child; 'auto' lets React derive one. */
  name?: string
  /** Fallback class applied when no more specific trigger prop matches. */
  default?: ViewTransitionClass
  enter?: ViewTransitionClass
  exit?: ViewTransitionClass
  update?: ViewTransitionClass
  share?: ViewTransitionClass
  onEnter?: (element: Element, types: string[]) => void
  onExit?: (element: Element, types: string[]) => void
  onUpdate?: (element: Element, types: string[]) => void
  onShare?: (element: Element, types: string[]) => void
  ref?: unknown
  children?: ComponentChildren
}

export function ViewTransition({ children }: ViewTransitionProps): VNode {
  // Pure passthrough: React's ViewTransition adds no element to the tree, and
  // any wrapper here would change every consuming app's DOM/CSS selectors.
  return h(Fragment, null, children)
}
ViewTransition.displayName = 'ViewTransition'

// Transition types declared during the current update (React clears them once
// the transition commits). `startViewTransition({ types })` consumes them.
const pendingTransitionTypes: string[] = []

/**
 * Declare a view-transition type for the in-flight transition, so
 * `:active-view-transition-type(...)` CSS rules match while it runs.
 */
export function addTransitionType(type: string): void {
  if (typeof type !== 'string' || pendingTransitionTypes.includes(type)) return
  pendingTransitionTypes.push(type)
}

/** Drain the declared types (the navigation that starts the transition owns them). */
export function takeTransitionTypes(): string[] {
  return pendingTransitionTypes.splice(0, pendingTransitionTypes.length)
}
