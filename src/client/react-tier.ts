import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * Conservative static scan of a compat app's client graph deciding whether the client bundle can ship
 * the lite react tier (preact core + hooks, no preact/compat, no Suspense island wrapper). Walks the
 * seed files' relative-import closure; ANY signal it cannot prove safe - an unresolvable import, a bare
 * package, a non-lite react name, a compat-only DOM prop, an async component shape - keeps the full
 * tier. False negatives cost bytes, never correctness.
 */

/** react named imports the lite client shim (compat/react/client-lite.ts) serves. */
const LITE_REACT_NAMES = new Set([
  'Component',
  'Fragment',
  'StrictMode',
  'cache',
  'cacheSignal',
  'cloneElement',
  'createContext',
  'createElement',
  'createRef',
  'isValidElement',
  'startTransition',
  'useActionState',
  'useCallback',
  'useContext',
  'useDebugValue',
  'useDeferredValue',
  'useEffect',
  'useId',
  'useImperativeHandle',
  'useInsertionEffect',
  'useLayoutEffect',
  'useMemo',
  'useOptimistic',
  'useReducer',
  'useRef',
  'useState',
  'useTransition',
  'version',
  'ViewTransition',
  'addTransitionType',
])

// Framework client modules known not to pull preact/compat. Every other bare specifier (npm packages,
// next/dynamic, next/image, ...) disqualifies the lite tier.
const SAFE_BARE_SPECIFIERS = new Set([
  'next/link',
  'next/navigation',
  'preact',
  'preact/hooks',
  'preact/jsx-runtime',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
])

// Compat-only semantics preact core lacks: React's onChange/onDoubleClick synthetic mapping,
// default* form props, string refs, legacy class lifecycles - plus async component shapes (they
// suspend). Matching anywhere in a file (even a comment) just falls back to the full tier.
const UNSAFE_TOKENS =
  /\bonChange\b|\bonDoubleClick\b|\bdefaultProps\b|\bgetSnapshotBeforeUpdate\b|\bcomponentWillReceiveProps\b|\bUNSAFE_\w+|\bref\s*=\s*["']|async\s+function\s+[A-Z]|(?:const|let|var)\s+[A-Z][\w$]*\s*=\s*async\b|export\s+default\s+async\b/

// defaultValue/defaultChecked are native DOM properties preact core assigns correctly on
// input/textarea; only <select defaultValue> needs preact/compat's special handling.
function unsafeDefaultValue(source: string) {
  return source.includes('defaultValue') && source.includes('<select')
}

const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)\s+([^;'"]*?)\s*from\s*(['"])([^'"]+)\2/g
const BARE_IMPORT = /(?:^|\n)\s*import\s*(['"])([^'"]+)\1/g
const DYNAMIC_IMPORT = /\bimport\(\s*(['"])([^'"]+)\1/g

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
const SOURCE_EXTENSION = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/

export function clientSuspenseFree(seeds: Iterable<string>): boolean {
  const queue: string[] = []
  const visited = new Set<string>()
  for (const seed of seeds) {
    if (!seed || visited.has(seed)) continue
    visited.add(seed)
    queue.push(seed)
  }
  while (queue.length > 0) {
    const file = queue.pop()!
    if (!SOURCE_EXTENSION.test(file) || !existsSync(file)) return false
    let source: string
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      return false
    }
    if (UNSAFE_TOKENS.test(source) || unsafeDefaultValue(source)) return false
    for (const [clause, specifier] of importsOf(source)) {
      if (specifier === 'react') {
        if (!liteReactClause(clause)) return false
        continue
      }
      if (SAFE_BARE_SPECIFIERS.has(specifier)) continue
      if (specifier.startsWith('.')) {
        if (clause !== undefined && typeOnlyClause(clause)) continue
        const resolved = resolveRelative(path.dirname(file), specifier)
        if (resolved === ASSET) continue
        if (!resolved) return false
        if (!visited.has(resolved)) {
          visited.add(resolved)
          queue.push(resolved)
        }
        continue
      }
      // Unknown bare package or framework module that may pull preact/compat.
      if (clause === undefined || !typeOnlyClause(clause)) return false
    }
  }
  return true
}

function* importsOf(source: string): Generator<[clause: string | undefined, specifier: string]> {
  for (const match of source.matchAll(STATIC_IMPORT)) yield [match[1], match[3] ?? '']
  for (const match of source.matchAll(BARE_IMPORT)) yield [undefined, match[2] ?? '']
  for (const match of source.matchAll(DYNAMIC_IMPORT)) yield [undefined, match[2] ?? '']
}

function typeOnlyClause(clause: string) {
  return /^type\s/.test(clause.trim())
}

function liteReactClause(clause: string | undefined): boolean {
  if (clause === undefined) return true
  const trimmed = clause.trim()
  if (typeOnlyClause(trimmed)) return true
  // Default or namespace import: the whole surface is reachable - full tier.
  const braceStart = trimmed.indexOf('{')
  if (braceStart !== 0) return false
  const braceEnd = trimmed.indexOf('}')
  if (braceEnd === -1) return false
  for (const entry of trimmed.slice(braceStart + 1, braceEnd).split(',')) {
    const name = entry.trim()
    if (!name || name.startsWith('type ')) continue
    const imported = (name.split(/\s+as\s+/)[0] ?? '').trim()
    if (!LITE_REACT_NAMES.has(imported)) return false
  }
  return true
}

const ASSET = Symbol('pnext.compat-surface.asset')

function resolveRelative(dir: string, specifier: string): string | typeof ASSET | undefined {
  let base = path.resolve(dir, specifier)
  const direct = fileAt(base)
  if (direct) return direct
  // NodeNext-style `./x.js` pointing at `./x.ts(x)`.
  if (/\.(?:js|jsx|mjs|cjs)$/.test(base)) base = base.replace(/\.[^.]+$/, '')
  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = fileAt(base + extension)
    if (candidate) return candidate
  }
  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = fileAt(path.join(base, `index${extension}`))
    if (candidate) return candidate
  }
  return undefined
}

function fileAt(candidate: string): string | typeof ASSET | undefined {
  if (!existsSync(candidate)) return undefined
  try {
    if (!statSync(candidate).isFile()) return undefined
  } catch {
    return undefined
  }
  // Styles/assets never carry react surface.
  return SOURCE_EXTENSION.test(candidate) ? candidate : ASSET
}
