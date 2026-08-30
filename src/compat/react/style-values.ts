// React's dangerousStyleValue, which preact does not implement: a numeric 0 is unitless for EVERY
// property, booleans render nothing at all, and React's unitless set is wider than preact's (aspect
// ratio, columns, grid placement, scale, font weight). preact appends `px` in each of those cases, so
// the same style object serializes differently from React's - `width:0px` where React writes `width:0`.
// Numbers are resolved to React's exact string in the vnode pass, before preact (DOM setStyle or
// render-to-string) ever formats them, so both the served markup and the hydrated DOM match React.
//
// Not gated on the react-compat flag like ./parity's passes: this changes how a value the app already
// wrote is spelled, never what it means, and pnext's own render API is React-shaped either way.
import { options, type VNode } from 'preact'

// A space-delimited string rather than a Set: same lookup for a list this size, no construction at
// module init, and fewer bytes in every client bundle that ships the shim.
const UNITLESS =
  ' animationIterationCount aspectRatio borderImageOutset borderImageSlice borderImageWidth boxFlex' +
  ' boxFlexGroup boxOrdinalGroup columnCount columns flex flexGrow flexPositive flexShrink flexNegative' +
  ' flexOrder fontWeight gridArea gridColumn gridColumnEnd gridColumnSpan gridColumnStart gridRow' +
  ' gridRowEnd gridRowSpan gridRowStart lineClamp lineHeight opacity order orphans scale tabSize widows' +
  ' zIndex zoom fillOpacity floodOpacity stopOpacity strokeDasharray strokeDashoffset strokeMiterlimit' +
  ' strokeOpacity strokeWidth '

// React registers a vendor-prefixed twin of every unitless property; unprefixing the name keeps the
// list at one entry per property instead of five.
const VENDOR_PREFIX = /^(?:Webkit|Moz|ms|O)(?=[A-Z])/

function unitless(name: string) {
  if (UNITLESS.includes(` ${name} `)) return true
  const base = name.replace(VENDOR_PREFIX, '')
  return base !== name && UNITLESS.includes(` ${base[0]!.toLowerCase()}${base.slice(1)} `)
}

/** React's spelling of one style value, or undefined when preact already agrees. */
export function reactStyleValue(name: string, value: unknown): string | undefined {
  // React drops boolean declarations entirely; an empty string is what drops them in preact.
  if (typeof value === 'boolean') return ''
  if (typeof value !== 'number') return undefined
  if (value !== 0 && !name.startsWith('--') && !unitless(name)) return undefined
  return String(value)
}

export function applyReactStyleValues(vnode: VNode): void {
  if (typeof vnode.type !== 'string') return
  const props = vnode.props as Record<string, unknown> | null
  const style = props?.style
  if (!style || typeof style !== 'object' || Array.isArray(style)) return

  // The app's object is never mutated - it may be a module-level constant reused across renders.
  let normalized: Record<string, unknown> | undefined
  for (const name in style) {
    const resolved = reactStyleValue(name, (style as Record<string, unknown>)[name])
    if (resolved === undefined) continue
    normalized ??= { ...style }
    normalized[name] = resolved
  }
  if (normalized) props.style = normalized
}

const installed = Symbol.for('pnext.react-style-values-installed')
const styleOptions = options as typeof options & { [installed]?: true }

if (!styleOptions[installed]) {
  const previousVNode = options.vnode?.bind(options)
  options.vnode = vnode => {
    previousVNode?.(vnode)
    applyReactStyleValues(vnode)
  }
  styleOptions[installed] = true
}
