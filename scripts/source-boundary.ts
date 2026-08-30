// Which files under src/ are pnext's OWN source — the ones Bun loads out of the installed package
// and pnext's tsconfig/eslint compile. A directory carrying its own package.json/tsconfig.json is a
// vendored standalone project (today: the CLI scaffold template): its files are payload copied into
// a user app and compiled by THAT project's config, so package-level source rules (jsx pragma,
// core -> compat boundary) stop at its root instead of leaking into generated user code.

import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

const PROJECT_MARKERS = ['package.json', 'tsconfig.json']

export function isNestedProjectRoot(dir: string): boolean {
  return PROJECT_MARKERS.some(marker => existsSync(path.join(dir, marker)))
}

export function internalSourceFiles(
  dir: string,
  match = /\.tsx?$/,
  found: string[] = [],
): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!isNestedProjectRoot(full)) internalSourceFiles(full, match, found)
    } else if (match.test(entry.name)) {
      found.push(full)
    }
  }
  return found
}
