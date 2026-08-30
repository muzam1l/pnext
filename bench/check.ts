#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

interface Ratio {
  ratio: number
  fail: number
  pnext?: number
  mode?: 'pnext-ms'
}
interface Fixture {
  ratios: Record<string, Ratio | null>
  bytes: Record<string, number>
}
interface Row {
  cell: string
  measured?: number
  baseline?: number
  limit?: string
  status: string
  suffix?: string
  record?: () => void
}

const root = path.resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const value = (name: string) => args.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1)
const record = args.includes('--record')
const baselineFile = value('--baselines') ?? path.join(root, 'bench/baselines.json')
const resultsFile = value('--bench') ?? path.join(root, '.tmp/bench.json')
const baselines = JSON.parse(readFileSync(baselineFile, 'utf8')) as Record<string, Fixture>
const report = JSON.parse(readFileSync(resultsFile, 'utf8')) as {
  fixtures: { id: string; label: string }[]
  metrics: { id: string; rows: Record<string, [number, string, number, string, number]> }[]
}
const metric = new Map(report.metrics.map(item => [item.id, item]))
const fixtureIds = new Map(report.fixtures.map(item => [item.label, item.id]))
const fixed = new Set(['js-files'])
// Ceilings, not targets. Install size is measured differently depending on how the framework was
// materialized (workspace symlink vs published package vs unresolved), so pinning it to one value
// fails a repo for measuring a legitimately different thing. Only growth past the budget is a bug.
const budget = new Set(['install'])
const rows: Row[] = []
const fmt = (value: number | undefined, suffix = '') =>
  value === undefined ? '—' : `${value.toFixed(2).replace(/\.00$/, '')}${suffix}`

for (const [name, fixture] of Object.entries(baselines)) {
  const id = fixtureIds.get(name)
  for (const [cell, base] of Object.entries(fixture.ratios)) {
    const source = id && metric.get(cell)?.rows[id]
    if (!base || !source) {
      rows.push({ cell: `${name} ${cell}`, status: 'skip' })
      continue
    }
    const measured = base.mode === 'pnext-ms' ? source[0] : source[4]
    const baseline = base.mode === 'pnext-ms' ? base.pnext! : base.ratio
    const status =
      base.mode === 'pnext-ms'
        ? measured > base.fail
          ? 'FAIL'
          : measured > baseline
            ? 'drift'
            : 'ok'
        : measured < base.fail
          ? 'FAIL'
          : measured < baseline
            ? 'drift'
            : 'ok'
    rows.push({
      cell: `${name} ${cell}`,
      measured,
      baseline,
      limit: fmt(base.fail, base.mode === 'pnext-ms' ? ' ms' : 'x'),
      status,
      suffix: base.mode === 'pnext-ms' ? ' ms' : 'x',
      record: () => {
        base.ratio = source[4]
        if (base.mode === 'pnext-ms') base.pnext = source[0]
      },
    })
  }
  for (const [cell, baseline] of Object.entries(fixture.bytes)) {
    const source = id && metric.get(cell)?.rows[id]
    if (!source) {
      rows.push({ cell: `${name} ${cell}`, status: 'skip' })
      continue
    }
    const measured = source[0]
    const exact = fixed.has(cell)
    const isBudget = budget.has(cell)
    const low = isBudget ? 0 : exact ? baseline : baseline * 0.99
    const high = exact ? baseline : baseline * 1.01
    const status =
      measured < low || measured > high ? 'FAIL' : measured === baseline ? 'ok' : 'drift'
    rows.push({
      cell: `${name} ${cell}`,
      measured,
      baseline,
      limit: exact ? fmt(baseline) : `${fmt(low)}–${fmt(high)}`,
      status,
      suffix:
        cell.includes('js-') || cell === 'zero-island' ? ' KB' : cell === 'install' ? ' MB' : '',
      record: () => {
        fixture.bytes[cell] = measured
      },
    })
  }
}

const width = (text: string, size: number) => text.padEnd(size)
console.log(
  `\n${width('cell', 31)}${width('measured', 13)}${width('baseline', 13)}${width('limit', 13)}status`,
)
console.log('-'.repeat(82))
for (const row of rows) {
  console.log(
    `${width(row.cell, 31)}${width(fmt(row.measured, row.suffix), 13)}${width(fmt(row.baseline, row.suffix), 13)}${width(row.limit ?? '—', 13)}${row.status}`,
  )
}

const failed = rows.filter(row => row.status === 'FAIL')
if (record) {
  if (failed.length) {
    console.error(`\n--record refused: ${failed.map(row => row.cell).join(', ')} failed`)
    process.exit(1)
  }
  for (const row of rows) row.record?.()
  writeFileSync(baselineFile, `${JSON.stringify(baselines, null, 2)}\n`)
  console.log(`\nrecorded ${rows.filter(row => row.record).length} cell(s) into ${baselineFile}`)
}
if (failed.length) {
  console.error(`\n${failed.length} cell(s) failed: ${failed.map(row => row.cell).join(', ')}`)
  process.exit(1)
}
