import type { ComponentChildren } from 'preact'

export interface SuspenseProps {
  fallback?: ComponentChildren
  children?: ComponentChildren
}

/**
 * Server streaming boundary for core PNext apps. The renderer resolves these
 * boundaries itself (streaming, PPR, loading.tsx), so no preact/compat
 * suspension machinery is involved. Rendered directly (client trees, tests),
 * it passes children through.
 */
export function Suspense(props: SuspenseProps): ComponentChildren {
  return props.children ?? null
}
