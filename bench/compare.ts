#!/usr/bin/env bun
/**
 * The PR bench card: the site's headline numbers for a PR against its base, both measured in one job.
 *
 *   bun bench/compare.ts <base-dir> <head-dir> [--base=<ref>] [--base-sha=<sha>] [--head-sha=<sha>]
 *                        [--verdict=<file>]
 *
 * Each dir holds `bun bench/run.ts --raw` dumps: one per fixture, plus the `runtime` ladder. Prints markdown.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { FixtureResult, Framework } from './lib/measure'
import type { RuntimeSize } from './lib/runtime'
import { bytes, mb, ms } from './lib/util'

interface Raw {
  results: Record<string, Partial<Record<Framework, FixtureResult>>>
  runtime: RuntimeSize[]
}

interface Metric {
  label: string
  pick: (result: FixtureResult) => number | undefined
  format: (value: number | undefined) => string
  /** Run-to-run noise on one runner, in percent; a bigger move is called out. */
  noise: number
  /** How the Next.js ratio reads: "4x faster", "3x less". */
  versus: string
}

const FIXTURES = ['hello-world', 'ssr', 'dashboard']
const time = (label: string, pick: Metric['pick']): Metric => ({
  label,
  pick,
  format: ms,
  noise: 10,
  versus: 'faster',
})
const METRICS: Metric[] = [
  time('Dev server ready', r => r.devReadyMs),
  time('First page, cold', r => r.firstHtmlMs),
  time('Warm request (dev)', r => r.warmMs),
  time('Hot reload', r => r.hmrMs),
  time('Production build', r => r.buildMs),
  time('Production server start', r => r.startReadyMs),
  time('Warm request (prod)', r => r.startWarmMs),
  {
    label: 'Dev server memory',
    pick: r => r.devServerRssMb,
    format: mb,
    noise: 10,
    versus: 'less',
  },
  {
    label: 'JS on first page (gzip)',
    pick: r => r.jsGzip,
    format: bytes,
    noise: 1,
    versus: 'less',
  },
  {
    label: 'JS loaded after first paint (gzip)',
    pick: r => r.jsDeferredGzip,
    format: bytes,
    noise: 1,
    versus: 'less',
  },
  {
    label: 'Framework install size',
    pick: r => r.frameworkInstallMb,
    format: mb,
    noise: 1,
    versus: 'smaller',
  },
]

const load = (dir: string): Raw => {
  const raw: Raw = { results: {}, runtime: [] }
  for (const file of readdirSync(dir).filter(name => name.endsWith('.json'))) {
    const part = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as Raw
    Object.assign(raw.results, part.results)
    raw.runtime.push(...part.runtime)
  }
  return raw
}

const known = (value: number | undefined): value is number =>
  value !== undefined && !Number.isNaN(value)

/** "51.0–54.2 ms": one unit, low to high across fixtures. */
const range = (values: (number | undefined)[], format: Metric['format']) => {
  const present = values.filter(known)
  if (!present.length) return '—'
  const [low, high] = [format(Math.min(...present)), format(Math.max(...present))]
  if (low === high) return high
  const unit = high.split(' ')[1]
  return unit && low.endsWith(` ${unit}`)
    ? `${low.slice(0, -unit.length - 1)}–${high}`
    : `${low}–${high}`
}

const delta = (from: number | undefined, to: number | undefined) => {
  if (!known(from) || !known(to)) return undefined
  if (from === 0) return to === 0 ? 0 : Infinity
  return ((to - from) / from) * 100
}

const percent = (value: number | undefined) => {
  if (value === undefined) return '—'
  if (value === Infinity) return 'new'
  if (Math.abs(value) < 0.05) return '0%'
  return `${value > 0 ? '+' : ''}${value.toFixed(Math.abs(value) < 10 ? 1 : 0)}%`
}

/** Worse than base by more than run-to-run noise; every metric here is lower-is-better. */
const regressed = (deltas: (number | undefined)[], noise: number) =>
  deltas.some(value => known(value) && value >= noise)

const deltaCell = (deltas: (number | undefined)[], noise: number) => {
  const text = deltas.map(percent).join(' / ')
  return regressed(deltas, noise) ? `**${text}**` : text
}

/** ✅ within noise or better, ⚠️ regressed, ❔ not measured. */
const mark = (deltas: (number | undefined)[], noise: number) =>
  !deltas.some(known) ? '❔' : regressed(deltas, noise) ? '⚠️' : '✅'

const OPPOSITE: Record<string, string> = { faster: 'slower', less: 'more', smaller: 'larger' }

/** Next.js over pnext per fixture; behind Next.js reads as the inverse ("1.3× slower"). */
const versusCell = (ratios: (number | undefined)[], word: string) => {
  const present = ratios.filter(known)
  if (!present.length) return '—'
  const span = (values: number[]) => {
    const [low, high] = [Math.min(...values).toFixed(1), Math.max(...values).toFixed(1)]
    return low === high ? high : `${low}–${high}`
  }
  if (present.every(value => value >= 1)) return `${span(present)}× ${word}`
  if (present.every(value => value < 1))
    return `${span(present.map(value => 1 / value))}× ${OPPOSITE[word]}`
  return `${span(present)}× vs Next.js`
}

const args = process.argv.slice(2)
const flag = (name: string) =>
  args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) || undefined
const [baseDir, headDir] = args.filter(arg => !arg.startsWith('--'))
if (!baseDir || !headDir) {
  console.error(
    'usage: bun bench/compare.ts <base-dir> <head-dir> [--base=<ref>] [--base-sha=<sha>] [--head-sha=<sha>]',
  )
  process.exit(1)
}
const base = load(baseDir)
const head = load(headDir)
const baseName = flag('base') ?? 'main'
const pnextOf = (raw: Raw, fixture: string) => raw.results[fixture]?.pnext
const nextOf = (fixture: string) => head.results[fixture]?.next

const headline: string[][] = []
const perFixture: string[][] = []
for (const metric of METRICS) {
  const before = FIXTURES.map(fixture => {
    const result = pnextOf(base, fixture)
    return result && metric.pick(result)
  })
  const after = FIXTURES.map(fixture => {
    const result = pnextOf(head, fixture)
    return result && metric.pick(result)
  })
  const versusNext = FIXTURES.map((fixture, index) => {
    const result = nextOf(fixture)
    const theirs = result && metric.pick(result)
    const ours = after[index]
    return known(theirs) && known(ours) && theirs > 0 && ours > 0 ? theirs / ours : undefined
  })
  const deltas = FIXTURES.map((_, index) => delta(before[index], after[index]))
  headline.push([
    `${mark(deltas, metric.noise)} ${metric.label}`,
    range(before, metric.format),
    range(after, metric.format),
    deltaCell(deltas, metric.noise),
    versusCell(versusNext, metric.versus),
  ])
  FIXTURES.forEach((fixture, index) =>
    perFixture.push([
      metric.label,
      fixture,
      metric.format(before[index]),
      metric.format(after[index]),
      deltaCell([deltas[index]], metric.noise),
      versusCell([versusNext[index]], metric.versus),
    ]),
  )
}

// The site's home-page wording for each step of the client JS ladder.
const RUNG_LABELS: Record<string, string> = {
  'server page': 'JS: server-rendered page',
  'server page + Link': 'JS: + client navigation',
  'island (Preact)': 'JS: whole framework (Preact)',
  'island (compat.react)': 'JS: with React compatibility',
  'island (compat.next)': 'JS: with Next.js compatibility',
}

const ladder: string[][] = []
for (const rung of head.runtime) {
  const before = base.runtime.find(item => item.name === rung.name)
  const deltas = [delta(before?.gzip, rung.gzip)]
  headline.push([
    `${mark(deltas, 1)} ${RUNG_LABELS[rung.name] ?? rung.name}`,
    bytes(before?.gzip),
    bytes(rung.gzip),
    deltaCell(deltas, 1),
    '—',
  ])
  ladder.push([
    RUNG_LABELS[rung.name] ?? rung.name,
    `${bytes(before?.gzip)} / ${bytes(rung.gzip)}`,
    deltaCell([delta(before?.gzip, rung.gzip)], 1),
    `${bytes(before?.deferredGzip)} / ${bytes(rung.deferredGzip)}`,
    deltaCell([delta(before?.deferredGzip, rung.deferredGzip)], 1),
  ])
}

const table = (headers: string[], rows: string[][]) => [
  `| ${headers.join(' | ')} |`,
  `|${headers.map(() => '---').join('|')}|`,
  ...rows.map(row => `| ${row.join(' | ')} |`),
]
const short = (sha: string | undefined) => (sha ? `\`${sha.slice(0, 7)}\`` : 'this PR')
const runs = pnextOf(head, 'ssr')?.runs
const flagged = headline.filter(row => !row[0]!.startsWith('✅'))
const verdict = flagged.length
  ? {
      conclusion: 'neutral',
      title: `${flagged.length} of ${headline.length} worse than ${baseName} or not measured`,
    }
  : { conclusion: 'success', title: `same or better than ${baseName}` }
const verdictFile = flag('verdict')
if (verdictFile) writeFileSync(verdictFile, `${JSON.stringify(verdict)}\n`)
const markdown = [
  `### Bench ${flagged.length ? '➖' : '✅'} ${verdict.title}`,
  '',
  `${short(flag('head-sha'))} vs \`${baseName}\` ${short(flag('base-sha'))}` +
    `${runs ? `, ${runs} run${runs === 1 ? '' : 's'} each` : ''}. Change per app: hello-world / ssr / dashboard.`,
  '',
  ...table([' ', baseName, 'PR', 'change', 'vs Next.js'], headline),
  '',
  '<details><summary>Per app</summary>',
  '',
  ...table([' ', 'app', baseName, 'PR', 'change', 'vs Next.js'], perFixture),
  '',
  ...table(
    [
      ' ',
      `first page gzip (${baseName} / PR)`,
      'change',
      `loaded later gzip (${baseName} / PR)`,
      'change',
    ],
    ladder,
  ),
  '',
  '</details>',
].join('\n')

console.log(markdown)
