// `export const preferredRegion` extraction (COMPAT). Next records a route segment's preferredRegion in
// its build manifests as a normalized string[]. It is read straight off the route's source files via
// regex - the value is a static export, so a scan matches how `maxDuration` is already collected in core.

import { readFileSync } from 'node:fs'
import type { RouteManifestEntry } from '../../types'

const PREFERRED_REGION_RE = /\bexport\s+const\s+preferredRegion\s*=\s*(\[[^\]]*\]|['"][^'"]*['"])/

/**
 * Resolve the route's `preferredRegion`, normalized to a string[] (Next accepts
 * a single string or an array). Returns undefined when no segment declares it.
 */
export function preferredRegionForRoute(route: RouteManifestEntry): string[] | undefined {
  for (const file of routeSources(route)) {
    let source: string
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const match = PREFERRED_REGION_RE.exec(source)
    if (!match?.[1]) continue
    return parsePreferredRegion(match[1])
  }
  return undefined
}

function routeSources(route: RouteManifestEntry): string[] {
  return [...new Set([route.file, ...route.sourceFiles])].filter(Boolean)
}

function parsePreferredRegion(literal: string): string[] {
  if (literal.startsWith('[')) {
    return Array.from(literal.matchAll(/['"]([^'"]*)['"]/g), m => m[1] ?? '')
  }
  return [literal.slice(1, -1)]
}
