/**
 * Buffered sink for PNEXT_TRACE=server lines. A warm request emits many phase lines, and writing each
 * straight to stdout inflated every enclosing span it sat inside - the measurement changed what it
 * measured. Lines accumulate here and the request handler flushes them in one write.
 */
const SINK = Symbol.for('pnext.devProfileSink')

function sink(): string[] {
  const store = globalThis as Record<PropertyKey, unknown>
  return (store[SINK] ??= []) as string[]
}

export function recordDevProfileLine(line: string) {
  sink().push(line)
}

/** Emit and clear everything buffered so far (one write per request). */
export function flushDevProfileLines() {
  const lines = sink()
  if (lines.length === 0) return
  const out = lines.join('\n')
  lines.length = 0
  console.log(out)
}

export function formatProfileDuration(durationMs: number) {
  const ms = Math.max(0, durationMs)
  if (ms < 10) return `${ms.toFixed(2)}ms`
  if (ms < 1000) return `${ms.toFixed(1)}ms`
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`
}
