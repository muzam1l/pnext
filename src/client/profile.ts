// Phase decomposition for the client stage (read / transform / react-compiler /
// esbuild / write), off unless PNEXT_TRACE=client. The bench needs the
// split to prove where the residual sits; a build must not pay for it.
import { traceEnabled } from '../utils/trace-flags'

const enabled = traceEnabled('client')

const totals = new Map<string, number>()
const spans = new Map<string, [number, number][]>()

/** Total wall covered by at least one span (overlaps counted once). */
function unionMs(intervals: [number, number][]) {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0])
  let total = 0
  let [openStart, openEnd] = sorted[0] ?? [0, 0]
  for (const [start, end] of sorted.slice(1)) {
    if (start > openEnd) {
      total += openEnd - openStart
      ;[openStart, openEnd] = [start, end]
    } else if (end > openEnd) {
      openEnd = end
    }
  }
  return total + (openEnd - openStart)
}

export const clientProfile = {
  enabled,
  /** Time `task` under `phase`. Returns the task's value untouched. */
  time<T>(phase: string, task: () => T): T {
    if (!enabled) return task()
    const start = performance.now()
    try {
      return task()
    } finally {
      totals.set(phase, (totals.get(phase) ?? 0) + (performance.now() - start))
    }
  },
  /**
   * Async phases overlap (esbuild runs onLoad concurrently), so summing each call's wall would count
   * the same second many times. Record spans and report the union - the wall the phase occupies.
   */
  async timeAsync<T>(phase: string, task: () => Promise<T>): Promise<T> {
    if (!enabled) return task()
    const start = performance.now()
    try {
      return await task()
    } finally {
      ;(spans.get(phase) ?? spans.set(phase, []).get(phase)!).push([start, performance.now()])
    }
  },
  count(key: string, by = 1) {
    if (!enabled) return
    totals.set(key, (totals.get(key) ?? 0) + by)
  },
  reset() {
    totals.clear()
    spans.clear()
  },
  snapshot(): Record<string, number> {
    return {
      ...Object.fromEntries(totals),
      ...Object.fromEntries([...spans].map(([phase, list]) => [phase, unionMs(list)])),
    }
  },
  /** Print the snapshot and clear it, so a second stage starts from zero. */
  report(label: string) {
    if (!enabled) return
    const snap = this.snapshot()
    const line = Object.entries(snap)
      .map(([phase, value]) => `${phase} ${value < 100 ? value.toFixed(1) : Math.round(value)}`)
      .join(' · ')
    console.log(`pnext client profile [${label}] ${line}`)
    this.reset()
  },
}
