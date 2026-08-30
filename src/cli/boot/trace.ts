/**
 * Boot phase timings for `pnext dev`, printed only under `PNEXT_TRACE=boot` (or `=1`).
 *
 * Timestamps are `performance.now()`, whose origin is process start, so the
 * first mark's absolute value is everything before it: the bun runtime coming
 * up plus this module graph evaluating. Off, a mark costs one clock read and
 * one rss read; nothing is ever printed.
 */
import { loadavg, cpus, arch, platform } from 'node:os'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { traceEnabled } from '../../utils/trace-flags'

const enabled = traceEnabled('boot')
const marks: [string, number, number][] = []
// Snapshotted at import: boot creates the cache directory long before the trace prints, so reading
// it at print time always reported "warm" - including on a run that had just wiped it.
const cacheAtStart = enabled ? cacheState() : 'cold'

function cacheState() {
  return countTopLevel(path.join('.pnext', 'dev', 'cache')) > 0 ? 'warm' : 'cold'
}

// Bun (<=1.3.x) lacks the memoryUsage.rss fast path Node has.
const rss = () =>
  typeof process.memoryUsage.rss === 'function'
    ? process.memoryUsage.rss()
    : process.memoryUsage().rss

export function markBoot(name: string) {
  if (enabled) marks.push([name, performance.now(), rss()])
}

// Environment facts a slow-boot report needs alongside the stage timings: the same trace on a
// loaded box, a cold cache, or a huge node_modules reads completely differently.
function traceHeader(): string[] {
  const load = loadavg()
    .map(value => value.toFixed(1))
    .join(' ')
  const packages = countTopLevel('node_modules')
  return [
    `  runtime          ${typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`} · ${platform()} ${arch()} · ${cpus().length} cpus · load ${load}`,
    `  app              ${packages} node_modules entries · .pnext/dev cache ${cacheAtStart}`,
  ]
}

function countTopLevel(dir: string): number {
  try {
    return readdirSync(path.resolve(dir)).length
  } catch {
    return 0
  }
}

export function printBootTrace() {
  if (!enabled || marks.length === 0) return
  const lines = ['boot trace (ms since process start):', ...traceHeader()]
  let previous = 0
  for (const [name, at, rss] of marks) {
    const mb = (rss / 1048576).toFixed(0).padStart(5)
    lines.push(
      `  ${name.padEnd(16)} +${(at - previous).toFixed(1).padStart(7)}  @${at.toFixed(1)}  rss ${mb} MB`,
    )
    previous = at
  }
  lines.push(`  total            @${performance.now().toFixed(1)}`)
  console.log(lines.join('\n'))
}
