import { dim } from './ansi'

export interface VerboseLogger {
  readonly enabled: boolean
  log(message: string): void
  step<T>(label: string, task: () => Promise<T>): Promise<T>
}

export function createVerboseLogger(enabled: boolean, scope: string): VerboseLogger {
  const prefix = dim(`pnext ${scope}`)
  // Stamp every line with time-since-process-start: once stages run in
  // parallel their lines interleave, and only the stamps say what overlapped.
  const write = (message: string) =>
    console.log(`${prefix} ${dim(`@${(performance.now() / 1000).toFixed(2)}s`)} ${message}`)

  return {
    enabled,
    log(message) {
      if (enabled) write(message)
    },
    async step(label, task) {
      if (!enabled) return task()
      write(label)
      const start = performance.now()
      try {
        return await task()
      } finally {
        write(`  ${dim(`↳ ${label} ${formatDuration(performance.now() - start)}`)}`)
      }
    },
  }
}

export function formatDuration(durationMs: number) {
  const ms = Math.max(0, durationMs)
  if (ms < 10) return `${ms.toFixed(1)}ms`
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`
}
