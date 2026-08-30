import type { FixtureResult, Framework } from './measure'
import type { RuntimeSize } from './runtime'
import { bytes } from './util'

// Emits the exact schema of reference/data/bench.json so a CI run's artifact
// can be pasted (or copied verbatim) into the docs data file (reference/data/bench.json).

type Results = Map<string, Partial<Record<Framework, FixtureResult>>>

const FIXTURE_META = [
  { name: 'hello-world', id: 'hello', label: 'hello-world', blurb: 'A single page.' },
  { name: 'ssr', id: 'ssr', label: 'ssr', blurb: 'A server-rendered site.' },
  {
    name: 'dashboard',
    id: 'dashboard',
    label: 'dashboard',
    blurb: 'A mid-size admin app — 30 routes, 18 client islands.',
  },
  {
    name: 'visible',
    id: 'visible',
    label: 'visible',
    blurb: 'A landing page whose one island loads when it scrolls into view.',
  },
] as const

const msText = (v: number) => `${v.toFixed(1)} ms`
const mbText = (v: number) => `${v.toFixed(1)} MB`
const kb = (v: number) => Number((v / 1024).toFixed(2))
const kbText = (v: number) => `${(v / 1024).toFixed(2)} KB`
const countText = (v: number) => String(v)

interface MetricSpec {
  id: string
  label: string
  category: 'dev' | 'build' | 'memory' | 'payload'
  phase: 'cold' | 'warm' | 'static'
  pick: (r: FixtureResult) => number | undefined
  value?: (v: number) => number
  text: (v: number) => string
  headline?: { label: string; direction: string }
}

const METRICS: MetricSpec[] = [
  {
    id: 'dev-ready',
    label: 'Dev server ready',
    category: 'dev',
    phase: 'cold',
    pick: r => r.devReadyMs,
    text: msText,
    headline: { label: 'Dev server ready', direction: 'faster' },
  },
  {
    id: 'dev-first-page',
    label: 'Dev first page HTML',
    category: 'dev',
    phase: 'cold',
    pick: r => r.firstHtmlMs,
    text: msText,
    headline: { label: 'First page, cold', direction: 'faster' },
  },
  {
    id: 'dev-warm',
    label: 'Dev warm request (p50 of 7)',
    category: 'dev',
    phase: 'warm',
    pick: r => r.warmMs,
    text: msText,
    headline: { label: 'Warm request (dev)', direction: 'faster' },
  },
  {
    id: 'hmr',
    label: 'HMR save → visible',
    category: 'dev',
    phase: 'warm',
    pick: r => r.hmrMs,
    text: msText,
    headline: { label: 'HMR save → visible', direction: 'faster' },
  },
  {
    id: 'build-wall',
    label: 'Production build cold (wall)',
    category: 'build',
    phase: 'cold',
    pick: r => r.buildMs,
    text: msText,
    headline: { label: 'Production build', direction: 'faster' },
  },
  {
    id: 'build-warm',
    label: 'Production build warm (wall)',
    category: 'build',
    phase: 'warm',
    pick: r => r.warmBuildMs,
    text: msText,
  },
  {
    id: 'prod-start',
    label: 'Prod start (ready)',
    category: 'build',
    phase: 'cold',
    pick: r => r.startReadyMs,
    text: msText,
  },
  {
    id: 'prod-warm',
    label: 'Prod warm request (p50 of 7)',
    category: 'build',
    phase: 'warm',
    pick: r => r.startWarmMs,
    text: msText,
    headline: { label: 'Warm request (prod)', direction: 'faster' },
  },
  {
    id: 'dev-rss',
    label: 'Dev server RSS (ready + 7 warm)',
    category: 'memory',
    phase: 'warm',
    pick: r => r.devServerRssMb,
    text: mbText,
    headline: { label: 'Dev server memory', direction: 'less' },
  },
  {
    id: 'build-rss',
    label: 'Prod build peak RSS',
    category: 'memory',
    phase: 'cold',
    pick: r => r.buildPeakRssMb,
    text: mbText,
  },
  {
    id: 'prod-rss',
    label: 'Prod server RSS (ready + 7 warm)',
    category: 'memory',
    phase: 'warm',
    pick: r => r.serverRssMb,
    text: mbText,
  },
  {
    id: 'install',
    label: 'Framework install size',
    category: 'payload',
    phase: 'static',
    pick: r => r.frameworkInstallMb,
    text: mbText,
  },
  {
    id: 'js-gzip',
    label: 'First-page client JS (gzip)',
    category: 'payload',
    phase: 'static',
    pick: r => r.jsGzip,
    value: kb,
    text: kbText,
    headline: { label: 'First-page client JS (gzip)', direction: 'less' },
  },
  {
    id: 'js-raw',
    label: 'First-page client JS (raw)',
    category: 'payload',
    phase: 'static',
    pick: r => r.jsRaw,
    value: kb,
    text: kbText,
  },
  {
    id: 'js-deferred-gzip',
    label: 'Deferred client JS (gzip)',
    category: 'payload',
    phase: 'static',
    pick: r => r.jsDeferredGzip,
    value: kb,
    text: kbText,
  },
  {
    id: 'js-files',
    label: 'First-page JS files',
    category: 'payload',
    phase: 'static',
    pick: r => r.jsFiles,
    text: countText,
  },
  {
    id: 'zero-island',
    label: 'Zero-island route client JS',
    category: 'payload',
    phase: 'static',
    pick: r => r.zeroJsRaw,
    value: kb,
    text: kbText,
  },
]

const round1 = (v: number) => Number(v.toFixed(v >= 10 ? 0 : 1))

export function siteBenchJson(
  results: Results,
  runtime: RuntimeSize[],
  meta: { machine: string; bun: string; next: string; runs: string },
) {
  const metrics = METRICS.map(spec => {
    const rows: Record<string, unknown[]> = {}
    for (const fixture of FIXTURE_META) {
      const result = results.get(fixture.name)
      const p = result?.pnext && spec.pick(result.pnext)
      const n = result?.next && spec.pick(result.next)
      if (p === undefined || n === undefined || Number.isNaN(p) || Number.isNaN(n)) continue
      const ratio = p > 0 ? Number((n / p).toFixed(2)) : 0
      const toValue =
        spec.value ?? ((v: number) => Number(v.toFixed(spec.text === countText ? 0 : 1)))
      rows[fixture.id] = [toValue(p), spec.text(p), toValue(n), spec.text(n), ratio]
    }
    return { id: spec.id, label: spec.label, category: spec.category, phase: spec.phase, rows }
  }).filter(metric => Object.keys(metric.rows).length > 0)

  // A cell only headlines while it wins on every fixture; a losing cell drops out.
  const headlines = METRICS.filter(spec => spec.headline)
    .map(spec => {
      const metric = metrics.find(m => m.id === spec.id)
      if (!metric) return undefined
      const ratios = Object.values(metric.rows).map(row => row[4] as number)
      if (!ratios.length || Math.min(...ratios) < 1.05) return undefined
      const lo = round1(Math.min(...ratios))
      const hi = round1(Math.max(...ratios))
      return { ...spec.headline!, value: lo === hi ? `${lo}×` : `${lo}–${hi}×` }
    })
    .filter(Boolean)
  // Install size is constant per run and always headlines (also guarantees the
  // docs data file's non-empty-headlines assert can never trip).
  const install = metrics.find(m => m.id === 'install')
  const installRow = install && Object.values(install.rows)[0]
  if (installRow) {
    headlines.push({
      label: 'Framework install size',
      direction: 'smaller',
      value: `${round1(installRow[4] as number)}×`,
      detail: `${String(installRow[1])} vs ${String(installRow[3])}`,
    } as never)
  }

  return {
    run: {
      date: new Date().toISOString().slice(0, 10),
      machine: meta.machine,
      bun: meta.bun,
      next: meta.next,
      runs: meta.runs,
    },
    fixtures: FIXTURE_META.filter(f => results.has(f.name)).map(({ id, label, blurb }) => ({
      id,
      label,
      blurb,
    })),
    metrics,
    headlines,
    clientRuntimes: runtime.map(size => ({
      name: size.name,
      raw: bytes(size.raw),
      gzip: bytes(size.gzip),
      brotli: bytes(size.brotli),
    })),
  }
}
