/** @jsxImportSource preact */
import type { ComponentChildren } from 'preact'

/**
 * Pages-router head hoisting is not supported (Next's own app router rejects
 * it too); metadata exports are the supported path. Render nothing so shared
 * components that still carry a <Head> don't break.
 */
export default function Head(_props: { children?: ComponentChildren }) {
  return null
}
