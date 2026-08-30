// React Compiler runtime shim (COMPAT).
//
// React Compiler-compiled code - both the app's own source and pre-compiled node_modules libraries -
// imports the memo-cache helper `c` from `react/compiler-runtime` (React 19 built-in) or the standalone
// `react-compiler-runtime` npm package (React 17/18 target).
//
// The npm `react-compiler-runtime` does `require('react')` and calls `React.useMemo`. Under pnext that
// bare require resolves to the REAL react package, whose `useMemo` reads a null dispatcher during
// preact's SSR and throws. So BOTH runtime specifiers are aliased to this shim, which implements the
// identical memo-cache over preact's own `useMemo` - no real-react dependency, works in SSR and in the
// browser.
//
// `c(size)` returns a per-render array seeded with a sentinel, exactly the fallback path in the upstream
// runtime. The remaining exports are only emitted in development/validation builds; pnext ships the
// production runtime, so they are minimal stubs to keep any stray import resolvable.

import { useMemo } from 'preact/compat'

const $empty = Symbol.for('react.memo_cache_sentinel')

/** React Compiler memo-cache allocator (production fallback over preact useMemo). */
export function c(size: number): unknown[] {
  return useMemo<unknown[]>(() => {
    const cache: unknown[] = new Array<unknown>(size)
    for (let index = 0; index < size; index++) cache[index] = $empty
    ;(cache as unknown as Record<symbol, boolean>)[$empty] = true
    return cache
  }, [])
}

/** Reset a memo-cache array back to sentinels (dev-only in upstream). */
export function $reset(cache: unknown[]): void {
  for (let index = 0; index < cache.length; index++) cache[index] = $empty
}

export function $makeReadOnly<T>(value: T): T {
  return value
}

// Dispatcher guards / structural check are dev-only validation hooks; ship as
// no-ops so a stray import in a mixed build stays resolvable.
export function $dispatcherGuard(_kind: number): void {
  /* no-op: dev-only dispatcher guard */
}

export function $structuralCheck(): void {
  /* no-op: dev-only structural equality check */
}

export const renderCounterRegistry = new Map<string, Set<{ count: number }>>()

export function clearRenderCounterRegistry(): void {
  for (const counters of renderCounterRegistry.values()) {
    for (const counter of counters) counter.count = 0
  }
}

export function useRenderCounter(_name: string): void {
  /* no-op: dev-only render counter */
}
