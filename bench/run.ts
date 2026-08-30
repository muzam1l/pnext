#!/usr/bin/env bun
/**
 * pnext benchmark: the same fixtures rendered by pnext and by Next.js.
 *
 *   bun bench/run.ts [ssr|dashboard|visible|all] [--framework=both|pnext|next] [--runs=N|--bundles]
 *
 * Prints results; reference docs are updated by hand. See bench/README.md.
 */
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  dirOf,
  measureFixture,
  type Fixture,
  type FixtureResult,
  type Framework,
} from './lib/measure'
import {
  consoleTable,
  fixtureRows,
  runtimeRows,
  type Target,
  type TargetContext,
} from './lib/report'
import { measureRuntimeSizes } from './lib/runtime'
import { bytes } from './lib/util'

const REPO = path.resolve(import.meta.dirname, '..')

const FIXTURES: Fixture[] = [
  {
    name: 'hello-world',
    dir: path.join(REPO, 'bench/fixtures/hello-world'),
    hmrFile: 'app/page.tsx',
    hmrAnchor: 'Hello, world',
    zeroJsRoute: '/',
  },
  {
    name: 'ssr',
    dir: path.join(REPO, 'bench/fixtures/ssr'),
    hmrFile: 'app/page.tsx',
    hmrAnchor: 'Server-rendered list',
    zeroJsRoute: '/about',
  },
  {
    name: 'dashboard',
    dir: path.join(REPO, 'bench/fixtures/dashboard'),
    hmrFile: 'app/page.tsx',
    hmrAnchor: 'Revenue, orders and account health at a glance.',
  },
  {
    // The one fixture with a tree per framework — compat.next cannot exercise
    // core pnext's dynamic(load: 'visible'). See its README for the rule.
    name: 'visible',
    dir: path.join(REPO, 'bench/fixtures/visible'),
    dirs: {
      pnext: path.join(REPO, 'bench/fixtures/visible/pnext'),
      next: path.join(REPO, 'bench/fixtures/visible/next'),
    },
    hmrFile: 'app/page.tsx',
    hmrAnchor: 'Ship the interface, not the bundle',
  },
]

/** Budgets the project holds itself to; the report's Targets table is generated from these. */
const TARGETS = {
  devReadyMs: 100,
  routerGzip: 1024,
  hydratedRouteGzip: 5 * 1024,
  zeroIslandBytes: 0,
}

const verdict = (value: number, limit: number) => (value <= limit ? 'PASS' : 'FAIL')

const targets: Target[] = [
  {
    label: 'Dev cold start, ssr fixture (pnext)',
    limit: `<= ${TARGETS.devReadyMs} ms`,
    measured: ({ results }) => {
      const value = results.get('ssr')?.pnext?.devReadyMs
      if (value === undefined || Number.isNaN(value)) return undefined
      return { text: `${value.toFixed(1)} ms`, status: verdict(value, TARGETS.devReadyMs) }
    },
  },
  {
    label: 'Router runtime',
    limit: `<= ${bytes(TARGETS.routerGzip)} gzip`,
    measured: ({ runtime }) => {
      const value = runtime.find(size => size.name === 'router-prefetch-only')?.gzip
      if (value === undefined) return undefined
      return { text: `${bytes(value)} gzip`, status: verdict(value, TARGETS.routerGzip) }
    },
  },
  {
    label: 'Hydrated-route framework tax',
    limit: `<= ${bytes(TARGETS.hydratedRouteGzip)} gzip`,
    measured: ({ runtime }) => {
      const value = runtime.find(size => size.name === 'combined-router-hydrator')?.gzip
      if (value === undefined) return undefined
      return { text: `${bytes(value)} gzip`, status: verdict(value, TARGETS.hydratedRouteGzip) }
    },
  },
  {
    // The fixtures run in compat.next, which ships the Next-compat navigation
    // client; the 0 B budget is a core-pnext invariant (see Notes).
    label: 'Zero-island route client JS (ssr `/about`)',
    limit: `${bytes(TARGETS.zeroIslandBytes)} (core pnext)`,
    measured: ({ results }) => {
      const value = results.get('ssr')?.pnext?.zeroJsRaw
      if (value === undefined || Number.isNaN(value)) return undefined
      return { text: `${bytes(value)} (compat.next)`, status: 'not exercised' }
    },
  },
]

const args = process.argv.slice(2)
const option = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.split('=')[1]
const selector = args.find(arg => !arg.startsWith('--')) ?? 'all'
const frameworkOption = (option('framework') ?? 'both') as Framework | 'both'
// --bundles: skip every timed run and measure the payload off one untimed build.
const bundlesOnly = args.includes('--bundles')
const runs = bundlesOnly ? 0 : Math.max(1, Number(option('runs') ?? 3))
const runsLabel = bundlesOnly
  ? 'bundle sizes only, no timed runs'
  : `runs ${runs} per metric${runs >= 3 ? ' (first discarded)' : ''}, medians reported`

const selected =
  selector === 'all' ? FIXTURES : FIXTURES.filter(fixture => fixture.name === selector)
if (!selected.length) {
  console.error(
    `Unknown fixture "${selector}". Available: ${FIXTURES.map(f => f.name).join(', ')}, all.`,
  )
  process.exit(1)
}
const frameworks: Framework[] = frameworkOption === 'both' ? ['pnext', 'next'] : [frameworkOption]

const results = new Map<string, Partial<Record<Framework, FixtureResult>>>()
for (const fixture of selected) {
  const perFramework: Partial<Record<Framework, FixtureResult>> = {}
  for (const framework of frameworks) {
    process.stdout.write(`\n${fixture.name} / ${framework}: `)
    perFramework[framework] = await measureFixture(fixture, framework, runs, index =>
      process.stdout.write(`run ${index + 1}/${runs} `),
    )
    process.stdout.write('done')
  }
  results.set(fixture.name, perFramework)
}

const runtime = await measureRuntimeSizes()

console.log('\n')
console.log(
  `Date ${new Date().toISOString().slice(0, 10)} · ${os.type()} ${os.release()} (${os.arch()}), ` +
    `${os.cpus()[0]?.model ?? 'unknown'} x${os.cpus().length} · Bun ${Bun.version} · Next.js ${nextVersion()} · ` +
    runsLabel,
)
console.log()
for (const fixture of selected) {
  console.log(`Fixture: ${fixture.name}`)
  console.log(
    consoleTable(['Metric', 'pnext', 'Next.js', 'Ratio'], fixtureRows(results.get(fixture.name)!)),
  )
  console.log()
}
console.log('Client runtime bundles')
console.log(consoleTable(['Runtime', 'Raw', 'Gzip', 'Brotli'], runtimeRows(runtime)))
console.log()

const context: TargetContext = { results, runtime }
console.log('Targets')
console.log(
  consoleTable(
    ['Target', 'Limit', 'Measured', 'Status'],
    targets.map(target => {
      const measured = target.measured?.(context)
      return [target.label, target.limit, measured?.text ?? '—', measured?.status ?? '—']
    }),
  ),
)
console.log()

// Docs data file JSON (reference/data/bench.json schema) for the CI artifact.
const { siteBenchJson } = await import('./lib/site-json')
await Bun.write(
  path.join(REPO, '.tmp/bench.json'),
  JSON.stringify(
    siteBenchJson(results, runtime, {
      machine: `${os.type()} ${os.release()} (${os.arch()}), ${os.cpus()[0]?.model ?? 'unknown'} x${os.cpus().length}`,
      bun: Bun.version,
      next: nextVersion(),
      runs: runsLabel,
    }),
    null,
    2,
  ) + '\n',
)
console.log('.tmp/bench.json written (reference/data/bench.json schema)')

// A stray server child or esbuild service can keep the event loop alive; everything is done.
process.exit(0)

function nextVersion(): string {
  for (const fixture of FIXTURES) {
    try {
      const manifest = path.join(dirOf(fixture, 'next'), 'node_modules/next/package.json')
      return (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version
    } catch {
      // Fixture not installed; try the next one.
    }
  }
  return 'not installed'
}
