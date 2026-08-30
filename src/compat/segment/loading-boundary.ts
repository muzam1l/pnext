// In-page loading-boundary detection (COMPAT).
//
// A route serves a truncated loading shell on a default (partial) prefetch when its render is GUARANTEED
// to stop at a boundary. The `loading` convention file is one such marker; an in-page `<Suspense>` around
// the params-dependent subtree is the other - Next's vary-params suites prefetch exactly that shape and
// expect the shared fallback shell rather than a segment miss.
//
// Detection is a static source scan (no bundling, no evaluation), deliberately narrow: the identifier
// must be imported from `react` AND used as JSX in the scanned source. Missing a boundary only leaves the
// route on today's segment-miss path, so false negatives are the safe direction.

import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { escapeRegex as escapeRegExp, stripComments } from '../../utils/code'

/**
 * True when the route's PAGE file wraps content in a React `<Suspense>`.
 *
 * The manifest's page file is not always the author's source: the hybrid
 * pages+app materializer shims every app convention as `export * from
 * '<relative source>'`, so a text scan of the shim sees no JSX at all. Follow
 * relative re-exports (one shim hop is all the materializer emits; the depth
 * bound keeps a cyclic re-export from looping) before scanning.
 */
export function pageHasInPageSuspense(file: string): boolean {
  return scanSourceOf(file, 2).some(sourceHasInPageSuspense)
}

/** `file`'s source plus the sources of its relative re-export targets. */
function scanSourceOf(file: string, depth: number, seen = new Set<string>()): string[] {
  const resolved = resolveSourceFile(file)
  if (resolved === null || seen.has(resolved)) return []
  seen.add(resolved)
  let source: string
  try {
    source = readFileSync(resolved, 'utf8')
  } catch {
    return []
  }
  const sources = [source]
  if (depth <= 0) return sources
  const pattern =
    /(?:export|import)\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s*['"](\.[^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) {
    const specifier = match[1]
    if (!specifier) continue
    sources.push(...scanSourceOf(path.resolve(path.dirname(resolved), specifier), depth - 1, seen))
  }
  return sources
}

/** `file` itself, or the first existing extension/index candidate for it. */
function resolveSourceFile(file: string): string | null {
  if (existsSync(file) && statSync(file).isFile()) return file
  for (const extension of SOURCE_EXTENSIONS) {
    for (const candidate of [`${file}${extension}`, path.join(file, `index${extension}`)]) {
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

const SOURCE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs']

/**
 * True when `source` imports `Suspense` from React and uses it as a JSX element. Comments are stripped
 * first (fixtures routinely describe the shape they do NOT have in prose above the component). Both the
 * named import and the namespace/default form are recognized.
 */
export function sourceHasInPageSuspense(source: string): boolean {
  const stripped = stripComments(source)
  const clauses = reactImportClauses(stripped)
  if (clauses.length === 0) return false
  const named = clauses.some(clause => /\bSuspense\b/.test(clause))
  if (named && /<\s*Suspense[\s/>]/.test(stripped)) return true
  // `<React.Suspense>` / `<Foo.Suspense>` needs a default or namespace binding
  // of the react module under that name.
  return namespaceBindings(clauses).some(name =>
    new RegExp(`<\\s*${escapeRegExp(name)}\\.Suspense[\\s/>]`).test(stripped),
  )
}

/** The import clauses of every `... from 'react'` statement in `source`. */
function reactImportClauses(source: string): string[] {
  const clauses: string[] = []
  const pattern = /import\s+([^'"]*?)\s+from\s*['"]react['"]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) clauses.push(match[1] ?? '')
  // `const React = require('react')` — the CJS form app code still uses.
  const cjs = /(?:const|let|var)\s+([\w$]+)\s*=\s*require\(\s*['"]react['"]\s*\)/g
  while ((match = cjs.exec(source)) !== null) clauses.push(`* as ${match[1] ?? ''}`)
  return clauses
}

/** Names bound to the whole react module by an import clause (default/namespace). */
function namespaceBindings(clauses: readonly string[]): string[] {
  const names: string[] = []
  for (const clause of clauses) {
    const namespace = /\*\s+as\s+([\w$]+)/.exec(clause)
    if (namespace?.[1]) names.push(namespace[1])
    // A default binding precedes any `{ ... }` named list.
    const fallback = /^\s*([\w$]+)\s*(?:,|$)/.exec(clause.split('{')[0] ?? '')
    if (fallback?.[1] && fallback[1] !== '*') names.push(fallback[1])
  }
  return names
}
