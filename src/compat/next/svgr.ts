// SVGR-style `.svg`-as-component detection + inline SVG component generation (COMPAT).
//
// Projects commonly wire `@svgr/webpack` into next.config's `webpack()` to import `.svg` files as
// React/Preact components instead of static asset URLs. pnext has no webpack graph to run that loader
// against, but the overwhelming majority of configurations use its stock defaults, so detect the
// reference and reproduce the import-as-component semantics directly against core's `staticAssetModule`
// seam (see image/static-metadata.ts) instead of executing the loader.

let svgAsComponent = false

/** Derived per config load (see config-loader's setNextConfig) — never a process one-shot. */
export function setSvgAsComponentEnabled(enabled: boolean): void {
  svgAsComponent = enabled
}

export function isSvgAsComponentEnabled(): boolean {
  return svgAsComponent
}

/** True when next.config's `webpack()` references `@svgr/webpack` (the common custom-loader use). */
export function webpackReferencesSvgr(config: { webpack?: unknown }): boolean {
  return typeof config.webpack === 'function' && String(config.webpack).includes('@svgr/webpack')
}

const XML_PROLOGUE = /^\uFEFF?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!DOCTYPE[^>]*>\s*)?/i
const SVG_TAG = /^<svg([^>]*)>([\s\S]*)<\/svg>\s*$/i
const ATTR =
  /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"|([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*'([^']*)'/g

function parseRootAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const match of raw.matchAll(ATTR)) {
    const name = match[1] ?? match[3]
    const value = match[2] ?? match[4] ?? ''
    if (name) attrs[name] = value
  }
  return attrs
}

/**
 * Generate the ESM module text an SVGR-mode `.svg` import evaluates to: a Preact component rendering the
 * SVG inline. Root attributes spread first so a caller's `className`/`width`/`height`/etc. props override
 * them — matching `@svgr/webpack`'s default output semantics. Identical for server and client bundles, so
 * hydration sees the same markup the server rendered.
 */
export function svgComponentModule(bytes: Uint8Array): string {
  const text = new TextDecoder().decode(bytes).replace(XML_PROLOGUE, '').trim()
  const match = SVG_TAG.exec(text)
  const rootAttrs = match ? parseRootAttrs(match[1] ?? '') : {}
  const inner = match ? match[2] : text
  return `import { h } from 'preact';
const __pnextSvgAttrs = ${JSON.stringify(rootAttrs)};
const __pnextSvgInner = ${JSON.stringify(inner)};
function SvgComponent(props) {
  return h('svg', { ...__pnextSvgAttrs, ...props, dangerouslySetInnerHTML: { __html: __pnextSvgInner } });
}
export default SvgComponent;
`
}
