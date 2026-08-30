// experimental.useLightningcss / lightningCssFeatures (COMPAT).
//
// When next.config enables `experimental.useLightningcss`, CSS chunk sources run through the APP's own
// `lightningcss` package (resolved from the project root - pnext ships no copy) with the
// include/exclude feature masks from `experimental.lightningCssFeatures`. Matching Next's
// lightningcss-loader: Nesting is always in the include mask; user `include` names add flags and user
// `exclude` names remove them. An included feature is transpiled regardless of browser targets - that
// forced transpilation is exactly what the suite asserts.
//
// Zero-cost when disabled or when the app has no lightningcss install: the source passes through.

import { createRequire } from 'node:module'
import path from 'node:path'
import { loadNative } from '../../utils/native-require'
import { getNextConfig } from '../next/config-loader'

interface LightningModule {
  transform(options: {
    filename: string
    code: Uint8Array
    include?: number
    exclude?: number
    errorRecovery?: boolean
  }): { code: Uint8Array }
  Features: Record<string, number>
}

interface LightningFeaturesConfig {
  include?: string[]
  exclude?: string[]
}

const moduleCache = new Map<string, LightningModule | null>()

function loadLightningcss(root: string): LightningModule | null {
  const cached = moduleCache.get(root)
  if (cached !== undefined) return cached
  let loaded: LightningModule | null = null
  try {
    const require = createRequire(path.join(root, 'package.json'))
    loaded = loadNative(() => require('lightningcss') as LightningModule)
  } catch {
    loaded = null
  }
  moduleCache.set(root, loaded)
  return loaded
}

/** `'light-dark'` -> `LightDark` (lightningcss `Features` enum key). */
function featureKey(name: string): string {
  return name.replace(/(?:^|-)([a-z0-9])/g, (_match, char: string) => char.toUpperCase())
}

function featureMask(features: Record<string, number>, names: string[] | undefined): number {
  let mask = 0
  for (const name of names ?? []) mask |= features[featureKey(name)] ?? 0
  return mask
}

/**
 * Transform CSS chunk source through the app's lightningcss when
 * `experimental.useLightningcss` is enabled; returns the source unchanged
 * otherwise (or when lightningcss is missing / the transform fails).
 */
export function maybeLightningcssTransform(css: string, file: string, root: string): string {
  const experimental = getNextConfig().experimental as
    { useLightningcss?: boolean; lightningCssFeatures?: LightningFeaturesConfig } | undefined
  if (experimental?.useLightningcss !== true) return css
  const lightning = loadLightningcss(root)
  if (!lightning) return css

  const features = experimental.lightningCssFeatures
  const userInclude = featureMask(lightning.Features, features?.include)
  const userExclude = featureMask(lightning.Features, features?.exclude)
  // Nesting always transpiles (Next hardcodes it), user excludes win.
  const include = ((lightning.Features.Nesting ?? 1) | userInclude) & ~userExclude

  try {
    const result = lightning.transform({
      filename: file,
      code: new TextEncoder().encode(css),
      include,
      exclude: userExclude,
      errorRecovery: true,
    })
    return new TextDecoder().decode(result.code)
  } catch {
    return css
  }
}
