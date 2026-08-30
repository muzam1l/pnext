import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { freePort, median, sweepPort, treeRss } from './util'

export interface Fixture {
  name: string
  dir: string
  /**
   * Per-framework source root, for the one fixture that cannot be a single
   * shared tree (see bench/fixtures/visible/README.md). Everything else runs
   * the identical source under both frameworks via `compat.next`.
   */
  dirs?: Partial<Record<Framework, string>>
  /** Source file the HMR probe edits, relative to the fixture root. */
  hmrFile: string
  /** Text present in both that file and the served HTML; the probe appends a marker to it. */
  hmrAnchor: string
  /** Optional route that must ship zero client JS (no island anywhere in its tree). */
  zeroJsRoute?: string
}

export type Framework = 'pnext' | 'next'

export interface Run {
  devReadyMs: number
  firstHtmlMs: number
  warmMs: number
  hmrMs?: number
  devServerRssMb: number
  buildMs: number
  warmBuildMs: number
  buildPeakRssMb: number
  startReadyMs: number
  startWarmMs: number
  serverRssMb: number
}

export interface FixtureResult {
  devReadyMs: number
  firstHtmlMs: number
  warmMs: number
  hmrMs?: number
  devServerRssMb: number
  buildMs: number
  warmBuildMs: number
  buildPeakRssMb: number
  startReadyMs: number
  startWarmMs: number
  serverRssMb: number
  frameworkInstallMb: number
  jsRaw: number
  jsGzip: number
  jsFiles: number
  jsDeferredRaw: number
  jsDeferredGzip: number
  jsDeferredFiles: number
  zeroJsRaw?: number
  runs: number
}

const REPO = path.resolve(import.meta.dirname, '../..')
const WARM_HITS = 7
const READY_TIMEOUT_MS = 120_000
const HMR_TIMEOUT_MS = 120_000

/** Source root this framework runs; the same tree for every fixture but `visible`. */
export const dirOf = (fixture: Fixture, framework: Framework) =>
  fixture.dirs?.[framework] ?? fixture.dir

const nextBin = (fixture: Fixture) =>
  path.join(dirOf(fixture, 'next'), 'node_modules/next/dist/bin/next')

export const outDirOf = (framework: Framework) => (framework === 'next' ? '.next' : '.pnext')

function argv(
  framework: Framework,
  fixture: Fixture,
  command: 'dev' | 'build' | 'start',
  port?: number,
) {
  const dir = dirOf(fixture, framework)
  if (framework === 'next') {
    const base = ['node', nextBin(fixture), command, dir]
    return command === 'build' ? base : [...base, '-p', String(port)]
  }
  const base = [path.join(REPO, 'bin/pnext'), command, dir]
  return command === 'build' ? base : [...base, '--port', String(port)]
}

const spawnEnv = { ...process.env, BROWSER: 'none', NO_COLOR: '1', FORCE_COLOR: '0' }

export function ensureInstalled(fixture: Fixture, framework: Framework) {
  const dir = dirOf(fixture, framework)
  // A core-pnext source tree has no fixture dependencies of its own.
  if (!existsSync(path.join(dir, 'package.json'))) return
  if (existsSync(path.join(dir, 'node_modules/next'))) return
  console.log(`  installing ${fixture.name} fixture dependencies...`)
  const install = Bun.spawnSync(['bun', 'install'], {
    cwd: dir,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (install.exitCode !== 0) throw new Error(`bun install failed in ${dir}`)
}

function cleanOutDir(fixture: Fixture, framework: Framework) {
  rmSync(path.join(dirOf(fixture, framework), outDirOf(framework)), {
    recursive: true,
    force: true,
  })
}

/** Spawn a server and resolve once it announces readiness; caller must stop it. */
async function startServer(command: 'dev' | 'start', fixture: Fixture, framework: Framework) {
  const port = await freePort()
  sweepPort(port)
  const started = performance.now()
  const proc = Bun.spawn(argv(framework, fixture, command, port), {
    stdout: 'pipe',
    stderr: 'pipe',
    env: spawnEnv,
  })
  let log = ''
  let readyMs = Number.NaN
  let signalReady!: () => void
  const ready = new Promise<void>(resolve => (signalReady = resolve))
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      log += decoder.decode(value, { stream: true })
      if (Number.isNaN(readyMs) && /\bready\b/i.test(log)) {
        readyMs = performance.now() - started
        signalReady()
      }
    }
  }
  // The quiet stream never ends until the kill, so these are never awaited.
  pump(proc.stdout).catch(() => undefined)
  pump(proc.stderr).catch(() => undefined)

  const stop = async () => {
    proc.kill('SIGKILL')
    await proc.exited.catch(() => undefined)
    sweepPort(port)
  }

  await Promise.race([ready, Bun.sleep(READY_TIMEOUT_MS)])
  if (Number.isNaN(readyMs)) {
    await stop()
    throw new Error(`${framework} ${command} never reported ready\n${log.slice(-2000)}`)
  }
  return { port, readyMs, url: `http://localhost:${port}`, stop, log: () => log, pid: proc.pid }
}

async function get(url: string) {
  const started = performance.now()
  const response = await fetch(url, { headers: { accept: 'text/html' } })
  const body = await response.text()
  return { ms: performance.now() - started, status: response.status, body }
}

/**
 * Save -> visible: append a marker to a rendered string in a source file and
 * poll the page until the marker is served back. A 200 with stale HTML does not
 * count.
 */
async function measureHmr(fixture: Fixture, framework: Framework, url: string) {
  const file = path.join(dirOf(fixture, framework), fixture.hmrFile)
  const original = readFileSync(file, 'utf8')
  if (!original.includes(fixture.hmrAnchor))
    throw new Error(`HMR anchor missing in ${fixture.hmrFile}`)
  const marker = `HmrProbe${Math.round(performance.now())}`
  writeFileSync(file, original.replace(fixture.hmrAnchor, `${fixture.hmrAnchor} ${marker}`))
  const started = performance.now()
  try {
    const deadline = started + HMR_TIMEOUT_MS
    for (;;) {
      const body = await fetch(url).then(
        r => r.text(),
        () => '',
      )
      if (body.includes(marker)) return performance.now() - started
      if (performance.now() > deadline) return undefined
      await Bun.sleep(10)
    }
  } finally {
    writeFileSync(file, original)
    const settle = performance.now() + 30_000
    while (performance.now() < settle) {
      const body = await fetch(url).then(
        r => r.text(),
        () => '',
      )
      if (!body.includes(marker)) break
      await Bun.sleep(20)
    }
  }
}

type DevRunResult = Omit<
  Run,
  'buildMs' | 'warmBuildMs' | 'buildPeakRssMb' | 'startReadyMs' | 'startWarmMs' | 'serverRssMb'
>

/**
 * One dev session: cold start, first HTML, warm median, HMR. RSS is read once,
 * right after ready + the warm hits — the only point in the run with a
 * predictable, comparable process tree (never sampled at a random time).
 */
async function devRun(fixture: Fixture, framework: Framework): Promise<DevRunResult> {
  cleanOutDir(fixture, framework)
  const server = await startServer('dev', fixture, framework)
  try {
    const first = await get(`${server.url}/`)
    if (first.status !== 200)
      throw new Error(`${framework} dev GET / -> ${first.status}\n${server.log().slice(-2000)}`)
    const warm: number[] = []
    for (let index = 0; index < WARM_HITS; index += 1) warm.push((await get(`${server.url}/`)).ms)
    const devServerRssMb = treeRss(server.pid)
    const hmrMs = await measureHmr(fixture, framework, `${server.url}/`)
    return {
      devReadyMs: server.readyMs,
      firstHtmlMs: first.ms,
      warmMs: median(warm),
      hmrMs,
      devServerRssMb,
    }
  } finally {
    await server.stop()
  }
}

/** macOS `/usr/bin/time -l` reports bytes; Linux `-v` reports kbytes. Both write to stderr. */
function parsePeakRssMb(output: string): number {
  const mac = output.match(/(\d+)\s+maximum resident set size/)
  if (mac) return Number(mac[1]) / 1024 / 1024
  const linux = output.match(/Maximum resident set size \(kbytes\):\s*(\d+)/i)
  if (linux) return Number(linux[1]) / 1024
  return Number.NaN
}

async function buildRun(fixture: Fixture, framework: Framework, cold = true) {
  if (cold) cleanOutDir(fixture, framework)
  const timeFlag = process.platform === 'darwin' ? '-l' : '-v'
  // stderr goes to a file, not a pipe: Bun's spawn pipes are non-blocking, and
  // GNU time's summary write at exit hits EAGAIN on Linux ("Resource
  // temporarily unavailable"), making time itself exit 1 after a clean build.
  const errFile = path.join(os.tmpdir(), `pnext-bench-time-${process.pid}.log`)
  const started = performance.now()
  const proc = Bun.spawn(['/usr/bin/time', timeFlag, ...argv(framework, fixture, 'build')], {
    stdout: 'pipe',
    stderr: Bun.file(errFile),
    env: spawnEnv,
  })
  const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
  const wall = performance.now() - started
  const err = await Bun.file(errFile)
    .text()
    .catch(() => '')
  if (code !== 0) throw new Error(`${framework} build exit ${code}\n${out.slice(-2000)}${err}`)
  return { buildMs: wall, buildPeakRssMb: parsePeakRssMb(err) }
}

/** One production session: ready, warm median, RSS at that fixed point. */
async function startRun(fixture: Fixture, framework: Framework) {
  const server = await startServer('start', fixture, framework)
  try {
    const first = await get(`${server.url}/`)
    if (first.status !== 200)
      throw new Error(`${framework} start GET / -> ${first.status}\n${server.log().slice(-2000)}`)
    const warm: number[] = []
    for (let index = 0; index < WARM_HITS; index += 1) warm.push((await get(`${server.url}/`)).ms)
    const serverRssMb = treeRss(server.pid)
    return { startReadyMs: server.readyMs, startWarmMs: median(warm), serverRssMb }
  } finally {
    await server.stop()
  }
}

/** Node resolution walk-up: pnext isn't a fixture dependency, it's hoisted to the workspace root. */
function resolveNodeModule(fromDir: string, pkg: string): string | undefined {
  let dir = fromDir
  for (;;) {
    const candidate = path.join(dir, 'node_modules', pkg)
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Content bytes, not disk usage. `du` reports ALLOCATED BLOCKS, so a package of several hundred
 * small files measures differently on every filesystem and checkout layout — the same file set
 * scored 1.90 MB on one CI runner, 7.50 MB on another and 7.20 MB locally, which made this an
 * unusable exact-match baseline. Summing file sizes is portable, and it is also the number worth
 * publishing: what a user downloads, not what their filesystem rounds it up to.
 * Symlinks count as zero — following them would double-count linked workspace packages.
 */
function duMb(target: string) {
  if (!existsSync(target)) return 0
  return contentBytes(realpathSync(target)) / (1024 * 1024)
}

function contentBytes(target: string): number {
  const info = lstatSync(target)
  if (info.isSymbolicLink()) return 0
  if (!info.isDirectory()) return info.size
  let total = 0
  for (const entry of readdirSync(target)) total += contentBytes(path.join(target, entry))
  return total
}

/** pnext resolves to the repo's own source (a workspace symlink, not a built package) — its "files" manifest is the npm-publish footprint, not the whole working tree (bench/, .git, dev fixtures...). */
function pnextInstallMb(pnextDir: string) {
  const manifest = JSON.parse(readFileSync(path.join(pnextDir, 'package.json'), 'utf8')) as {
    files?: string[]
  }
  return (manifest.files ?? []).reduce((sum, entry) => sum + duMb(path.join(pnextDir, entry)), 0)
}

/** Framework's own install cost, not the fixture's shared `node_modules`: next + its platform swc binary, or @wular/pnext + preact. */
function frameworkInstallMb(fixture: Fixture, framework: Framework) {
  const dir = dirOf(fixture, framework)
  if (framework === 'next') {
    const paths: string[] = []
    const next = resolveNodeModule(dir, 'next')
    if (next) paths.push(next)
    const scopedNext = resolveNodeModule(dir, '@next')
    if (scopedNext) {
      for (const entry of readdirSync(scopedNext)) {
        if (entry.startsWith('swc-')) paths.push(path.join(scopedNext, entry))
      }
    }
    return paths.reduce((sum, p) => sum + duMb(p), 0)
  }
  const pnext = resolveNodeModule(dir, '@wular/pnext')
  const preact = resolveNodeModule(dir, 'preact')
  return (pnext ? pnextInstallMb(realpathSync(pnext)) : 0) + (preact ? duMb(preact) : 0)
}

/**
 * JS the given route actually executes, measured off the production server:
 * `<script src>` plus `rel="modulepreload"` (the module graph those scripts
 * pull in). Legacy `noModule` scripts and speculative `rel="preload"` hints for
 * *other* routes are excluded from both arms.
 */
async function routeJs(url: string, route: string) {
  const html = await fetch(`${url}${route}`).then(r => r.text())
  const sources = new Set<string>()
  for (const match of html.matchAll(/<script[^>]*>/g)) {
    const tag = match[0]
    if (tag.includes(' noModule')) continue
    const src = tag.match(/\ssrc="([^"]+)"/)?.[1]
    if (src) sources.add(src)
  }
  for (const match of html.matchAll(/<link[^>]+>/g)) {
    const tag = match[0]
    if (!tag.includes('rel="modulepreload"')) continue
    const href = tag.match(/href="([^"]+)"/)?.[1]
    if (href) sources.add(href)
  }
  let raw = 0
  let gzip = 0
  let files = 0
  const bodies: { source: string; text: string }[] = []
  for (const source of sources) {
    if (!source.startsWith('/')) continue
    const response = await fetch(`${url}${source}`)
    if (!response.ok) continue
    const body = new Uint8Array(await response.arrayBuffer())
    raw += body.byteLength
    gzip += gzipSync(body, { level: 9 }).byteLength
    files += 1
    bodies.push({ source, text: new TextDecoder().decode(body) })
  }
  return { raw, gzip, files, sources, bodies }
}

/** Asset paths a chunk names as string literals — how both bundlers record their on-demand chunks. */
const CHUNK_REFERENCE = /["'`]([^"'`\s<>]+\.js)["'`]/g
const DEFERRED_FETCH_LIMIT = 400

/** A literal can be server-absolute, relative to the chunk, or (turbopack) relative to the output root. */
function chunkCandidates(specifier: string, from: string) {
  if (specifier.startsWith('/')) return [specifier]
  if (/^[a-z]+:/i.test(specifier)) return []
  return [...new Set([new URL(specifier, `http://x${from}`).pathname, `/_next/${specifier}`])]
}

/**
 * JS the first page fetches only on demand, after first paint: the chunk graph
 * reachable from the initial chunks by following the asset paths they name
 * (visibility islands, lazy router/runtime chunks). Measured identically for
 * both frameworks, off each one's own production server; anything already
 * counted as initial JS is excluded.
 */
async function deferredJs(url: string, initial: Awaited<ReturnType<typeof routeJs>>) {
  const seen = new Set(initial.sources)
  const queue = [...initial.bodies]
  let raw = 0
  let gzip = 0
  let files = 0
  let fetches = 0
  while (queue.length) {
    const chunk = queue.shift()!
    for (const match of chunk.text.matchAll(CHUNK_REFERENCE)) {
      const candidates = chunkCandidates(match[1]!, chunk.source)
      if (candidates.some(candidate => seen.has(candidate))) continue
      for (const candidate of candidates) {
        seen.add(candidate)
        if (fetches >= DEFERRED_FETCH_LIMIT) break
        fetches += 1
        const response = await fetch(`${url}${candidate}`)
        if (!response.ok) continue
        if (!/javascript|ecmascript/i.test(response.headers.get('content-type') ?? '')) continue
        const body = new Uint8Array(await response.arrayBuffer())
        raw += body.byteLength
        gzip += gzipSync(body, { level: 9 }).byteLength
        files += 1
        queue.push({ source: candidate, text: new TextDecoder().decode(body) })
        break
      }
    }
  }
  return { raw, gzip, files }
}

async function bundleRun(fixture: Fixture, framework: Framework) {
  const server = await startServer('start', fixture, framework)
  try {
    const home = await routeJs(server.url, '/')
    const deferred = await deferredJs(server.url, home)
    const zero = fixture.zeroJsRoute ? await routeJs(server.url, fixture.zeroJsRoute) : undefined
    return { home, deferred, zero }
  } finally {
    await server.stop()
  }
}

/**
 * Full protocol for one fixture/framework pair: `runs` sequential runs, the
 * first discarded once there are three or more, medians over what is left.
 * Bundle sizes are deterministic and measured once, off the last build.
 */
export async function measureFixture(
  fixture: Fixture,
  framework: Framework,
  runs: number,
  onRun?: (index: number) => void,
): Promise<FixtureResult> {
  ensureInstalled(fixture, framework)
  const collected: Run[] = []
  for (let index = 0; index < runs; index += 1) {
    onRun?.(index)
    const dev = await devRun(fixture, framework)
    const build = await buildRun(fixture, framework)
    const warmBuild = await buildRun(fixture, framework, false)
    const start = await startRun(fixture, framework)
    collected.push({ ...dev, ...build, warmBuildMs: warmBuild.buildMs, ...start })
  }
  // `runs: 0` is the bundles-only path (`--bundles`): build once, untimed, and
  // measure the payload. Every timed metric stays NaN and reports as "—".
  if (!runs) await buildRun(fixture, framework)
  const kept = runs >= 3 ? collected.slice(1) : collected
  const hmr = kept.map(run => run.hmrMs).filter((value): value is number => value !== undefined)
  const { home, deferred, zero } = await bundleRun(fixture, framework)
  return {
    devReadyMs: median(kept.map(run => run.devReadyMs)),
    firstHtmlMs: median(kept.map(run => run.firstHtmlMs)),
    warmMs: median(kept.map(run => run.warmMs)),
    hmrMs: hmr.length ? median(hmr) : undefined,
    devServerRssMb: median(kept.map(run => run.devServerRssMb)),
    buildMs: median(kept.map(run => run.buildMs)),
    warmBuildMs: median(kept.map(run => run.warmBuildMs)),
    buildPeakRssMb: median(kept.map(run => run.buildPeakRssMb)),
    startReadyMs: median(kept.map(run => run.startReadyMs)),
    startWarmMs: median(kept.map(run => run.startWarmMs)),
    serverRssMb: median(kept.map(run => run.serverRssMb)),
    frameworkInstallMb: frameworkInstallMb(fixture, framework),
    jsRaw: home.raw,
    jsGzip: home.gzip,
    jsFiles: home.files,
    jsDeferredRaw: deferred.raw,
    jsDeferredGzip: deferred.gzip,
    jsDeferredFiles: deferred.files,
    zeroJsRaw: zero?.raw,
    runs: kept.length,
  }
}
