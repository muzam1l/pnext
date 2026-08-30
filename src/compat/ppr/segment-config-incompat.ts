// Legacy segment-config incompatibility under cacheComponents (COMPAT). Under `cacheComponents: true`
// the legacy per-segment route config exports are incompatible and must error at build. This module
// produces the exact Next message for a given offending key and file path; it is delivered ready-to-wire
// rather than wired into build validation here.

/** The legacy segment-config exports that cacheComponents rejects. */
export const INCOMPATIBLE_SEGMENT_KEYS = [
  'revalidate',
  'dynamicParams',
  'dynamic',
  'fetchCache',
] as const

export type IncompatibleSegmentKey = (typeof INCOMPATIBLE_SEGMENT_KEYS)[number]

/** Next's exact incompat message for an offending segment-config export. */
export function segmentConfigIncompatMessage(key: IncompatibleSegmentKey, file: string): string {
  return `"${key}" is not compatible with \`nextConfig.cacheComponents\`. Please remove it. Used in ${file}`
}

const EXPORT_RE = (key: string) => new RegExp(`\\bexport\\s+const\\s+${key}\\b`)

/**
 * Scan a page/layout source for an incompatible segment-config export, returning
 * the first offending key (or undefined). Layout configs propagate to child
 * pages, so callers should scan the layout chain too.
 */
export function findIncompatibleSegmentKey(source: string): IncompatibleSegmentKey | undefined {
  for (const key of INCOMPATIBLE_SEGMENT_KEYS) {
    if (EXPORT_RE(key).test(source)) return key
  }
  return undefined
}
