import { bytes, mb, ms, ratio } from './util'
import type { FixtureResult, Framework } from './measure'
import type { RuntimeSize } from './runtime'

export interface Target {
  label: string
  limit: string
  /** Measured value for the target, or undefined when this run did not cover it. */
  measured?: (context: TargetContext) => { text: string; status: string } | undefined
}

export interface TargetContext {
  results: Map<string, Partial<Record<Framework, FixtureResult>>>
  runtime: RuntimeSize[]
}

export function fixtureRows(result: Partial<Record<Framework, FixtureResult>>) {
  const p = result.pnext
  const n = result.next
  const row = (
    label: string,
    pick: (value: FixtureResult) => number | undefined,
    format: (value: number | undefined) => string,
  ) => [label, format(p && pick(p)), format(n && pick(n)), ratio(p && pick(p), n && pick(n))]

  const rows = [
    row('Dev cold start (ready)', r => r.devReadyMs, ms),
    row('Dev first page HTML', r => r.firstHtmlMs, ms),
    row('Dev warm request (p50 of 7)', r => r.warmMs, ms),
    row('Dev server RSS (ready + 7 warm)', r => r.devServerRssMb, mb),
    row('HMR save → visible', r => r.hmrMs, ms),
    row('Prod build cold (wall)', r => r.buildMs, ms),
    row('Prod build warm (wall)', r => r.warmBuildMs, ms),
    row('Prod build peak RSS', r => r.buildPeakRssMb, mb),
    row('Prod start (ready)', r => r.startReadyMs, ms),
    row('Prod warm request (p50 of 7)', r => r.startWarmMs, ms),
    row('Prod server RSS (ready + 7 warm)', r => r.serverRssMb, mb),
    row('Framework install size', r => r.frameworkInstallMb, mb),
    row('First-page client JS (raw)', r => r.jsRaw, bytes),
    row('First-page client JS (gzip)', r => r.jsGzip, bytes),
    row(
      'First-page JS files',
      r => r.jsFiles,
      v => (v === undefined ? '—' : String(v)),
    ),
    row('Deferred client JS (raw)', r => r.jsDeferredRaw, bytes),
    row('Deferred client JS (gzip)', r => r.jsDeferredGzip, bytes),
    row(
      'Deferred JS files',
      r => r.jsDeferredFiles,
      v => (v === undefined ? '—' : String(v)),
    ),
  ]
  if (p?.zeroJsRaw !== undefined || n?.zeroJsRaw !== undefined) {
    rows.push(row('Zero-island route client JS', r => r.zeroJsRaw, bytes))
  }
  return rows
}

export function runtimeRows(sizes: RuntimeSize[]) {
  return sizes.map(size => [size.name, bytes(size.raw), bytes(size.gzip), bytes(size.brotli)])
}

export function consoleTable(headers: string[], rows: string[][]) {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map(row => (row[index] ?? '').length)),
  )
  const line = (cells: string[]) =>
    cells
      .map((cell, index) => (index ? cell.padStart(widths[index]!) : cell.padEnd(widths[index]!)))
      .join('  ')
  return [line(headers), widths.map(width => '-'.repeat(width)).join('  '), ...rows.map(line)].join(
    '\n',
  )
}
