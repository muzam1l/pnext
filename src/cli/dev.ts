import { createRequire } from 'node:module'
import path from 'node:path'
import { dim } from '../utils/ansi'
import { moduleGenerationStats } from '../runtime/module-generations'
import { markBoot, printBootTrace } from './boot/trace'
import { browserHost, ensurePortFree, openBrowser, printServerReady } from './serve/ui'

export const devProcessTitle = 'pnext-dev'
export const devRestartEnv = 'PNEXT_DEV_RESTART'

const defaultMaxDevRssMb = 2048
const defaultMaxEsbuildRssMb = 1024
// A leaf edit supersedes a couple of generations, so this caps stale mass at roughly 300 MB -
// about one recycle per 75 leaf edits, and one per ~30 on wide-shared-module edits that rename
// most of a route graph.
const defaultMaxStaleModules = 150
/** How long a recycle waits for in-flight responses before replacing the image. */
const drainTimeoutMs = 5_000

export function nameDevProcess() {
  process.title = devProcessTitle
}

export interface DevOptions {
  root?: string
  port?: number
  hostname?: string
}

/**
 * The dev server, running directly in the process bin/pnext exec'd - there is no supervisor.
 * Resilience comes from self-replacement instead: a memory watchdog trip re-execs this process in
 * place, which frees the module graph without paying a second process spawn on every boot.
 */
export async function dev(options: DevOptions = {}) {
  nameDevProcess()
  // Loaded lazily so config resolution and the server graph start in parallel.
  const [{ loadConfig }, { startDevServer }] = await Promise.all([
    import('../config'),
    import('../dev/server'),
  ])
  markBoot('dev:imports')
  const config = await loadConfig(options.root, { dev: true })
  markBoot('dev:config')
  warnDuplicateSass(config.root, Boolean(config.compat?.next))
  const port = options.port ?? 3000
  // Next's documented default. Bun resolves 'localhost' to ::1 only, refusing IPv4 clients.
  const hostname = options.hostname ?? '0.0.0.0'
  // A memory-triggered restart can briefly race the previous listener's
  // shutdown, so give the port a moment to free before failing.
  await ensurePortFree(port, hostname, { attempts: 10 })
  markBoot('dev:port')
  const start = Date.now()
  // Bisect switch, same role `PNEXT_DEV_RESTART_CACHE=0` plays for the restart
  // caches: turns the boot warm-up off so a measurement can price it.
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const warm = process.env.PNEXT_DEV_WARM !== '0'
  const server = await startDevServer({ config, port, hostname, warm })
  markBoot('dev:server')
  const elapsedMs = Date.now() - start
  const url = `http://${browserHost(hostname)}:${server.port ?? port}`
  printServerReady({ mode: 'dev', hostname, port: server.port ?? port, elapsedMs })
  printBootTrace()
  // Boot compiles nothing (config loads natively), so the first compile would pay esbuild's service
  // spawn. Warm it here, after the banner - readiness must not wait on it. PNEXT_DEV_ESBUILD_WARM=0 opts out.
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  if (process.env.PNEXT_DEV_ESBUILD_WARM !== '0') {
    void import('../utils/esbuild').then(module => module.warmEsbuildService())
  }
  registerShutdown(server)
  watchServerMemory(server)
  watchStaleModules(server)
  watchEsbuildMemory()
  // Hold the browser until the entry route has compiled, so it opens onto an
  // already-built page instead of a multi-second cold compile.
  if (server.warmup) console.log(dim('Warming up and opening the browser...'))
  await server.warmup
  // A memory-triggered restart should refresh silently, not open another tab.
  if (process.env[devRestartEnv] !== '1') openBrowser(url)
  return server
}

/** Next's dev-only preflight warning for projects carrying both Sass implementations. */
function warnDuplicateSass(root: string, nextCompat: boolean): void {
  if (!nextCompat) return
  const appRequire = createRequire(path.join(root, 'package.json'))
  const installed = (name: string) => {
    try {
      appRequire.resolve(name)
      return true
    } catch {
      return false
    }
  }
  if (!installed('sass') || !installed('node-sass')) return
  console.warn(
    'Your project has both `sass` and `node-sass` installed as dependencies, but should only use one or the other. ' +
      'Please remove the `node-sass` dependency from your project. ' +
      ' Read more: https://nextjs.org/docs/messages/duplicate-sass',
  )
}

// Every dev reload imports changed modules under fresh URLs, and the ES module
// registry never evicts, so a long session pins every stale graph in memory.
// Once RSS crosses the limit, trade a seconds-long restart (vendor bundles are
// preserved on disk) for getting the memory back.
function watchServerMemory(server: DevServerHandle) {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const limitMb = Number(process.env.PNEXT_DEV_MAX_RSS_MB || defaultMaxDevRssMb)
  if (!Number.isFinite(limitMb) || limitMb <= 0) return
  const limitBytes = limitMb * 1024 * 1024
  const timer = setInterval(() => {
    // Bun (<=1.3.x) lacks the `process.memoryUsage.rss` fast path Node provides.
    const rss =
      typeof process.memoryUsage.rss === 'function'
        ? process.memoryUsage.rss()
        : process.memoryUsage().rss
    if (rss < limitBytes) return
    clearInterval(timer)
    const usedMb = Math.round(rss / (1024 * 1024))
    console.log(
      dim(
        `Dev server reached ${usedMb}MB of memory (limit ${limitMb}MB, set PNEXT_DEV_MAX_RSS_MB to change); restarting to release stale modules...`,
      ),
    )
    void restartDevProcess(server)
  }, 15_000)
  timer.unref()
}

// The esbuild Go service self-drains its heap when idle, so two consecutive readings above the
// limit mean it is genuinely parked high. Stopping it is lossless - pnext only issues one-shot
// builds, never incremental contexts. A stop that races an in-flight build fails that one build;
// dev asset caches drop failed builds, so the next request retries.
function watchEsbuildMemory() {
  if (process.platform === 'win32') return
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const limitMb = Number(process.env.PNEXT_DEV_MAX_ESBUILD_RSS_MB || defaultMaxEsbuildRssMb)
  if (!Number.isFinite(limitMb) || limitMb <= 0) return
  let highTicks = 0
  const timer = setInterval(() => {
    const rssMb = esbuildServiceRssMb()
    highTicks = rssMb > limitMb ? highTicks + 1 : 0
    if (highTicks < 2) return
    highTicks = 0
    console.log(
      dim(
        `esbuild reached ${Math.round(rssMb)}MB of memory (limit ${limitMb}MB, set PNEXT_DEV_MAX_ESBUILD_RSS_MB to change); restarting it to release the heap...`,
      ),
    )
    void (async () => {
      // The idle-guarded stop: a raw esbuild.stop() under an in-flight compile
      // fails that request with a 500, so a busy service drains first. In-flight
      // builds are untouched, so their waiters must not be failed here.
      const { stopEsbuildService } = await import('../utils/esbuild')
      stopEsbuildService()
    })()
  }, 15_000)
  timer.unref()
}

/**
 * Recycle on stale registry mass rather than on RSS. Every save renames the modules it changes and
 * Bun's registry never unlinks the old ones, so a session accumulates superseded generations at a
 * fixed rate that nothing in-process can free. RSS is a lagging proxy: it trips only after the
 * growth has already cost save latency, and it also trips on a warm route set that is entirely
 * live. The replacement re-warms from the content-keyed disk cache, so the cost is a restart, not
 * a cold build.
 */
function watchStaleModules(server: DevServerHandle) {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const limit = Number(process.env.PNEXT_DEV_MAX_STALE_MODULES || defaultMaxStaleModules)
  if (!Number.isFinite(limit) || limit <= 0) return
  const timer = setInterval(() => {
    const { stale } = moduleGenerationStats()
    if (stale < limit) return
    clearInterval(timer)
    console.log(
      dim(
        `Dev server is holding ${stale} superseded module generations (limit ${limit}, set PNEXT_DEV_MAX_STALE_MODULES to change); restarting to release them...`,
      ),
    )
    void restartDevProcess(server)
  }, 15_000)
  timer.unref()
}

// Our esbuild service children: [pid, RSS in MB] per process.
function esbuildServices(): [number, number][] {
  const found: [number, number][] = []
  try {
    const stdout = Bun.spawnSync(['ps', '-ax', '-o', 'pid=,ppid=,rss=,ucomm=']).stdout.toString()
    for (const line of stdout.split('\n')) {
      const [pid, ppid, rss, ...name] = line.trim().split(/\s+/)
      if (Number(ppid) === process.pid && name.join(' ').includes('esbuild')) {
        found.push([Number(pid), Number(rss) / 1024])
      }
    }
  } catch {
    // ignore: no ps available means no monitoring, not a broken dev server
  }
  return found
}

// RSS of our esbuild service, in MB (0 when not running).
function esbuildServiceRssMb() {
  return esbuildServices().reduce((total, [, rssMb]) => total + rssMb, 0)
}

interface DevServerHandle {
  stop(closeActiveConnections?: boolean): unknown
  /** Resolves once nothing is being served (or the timeout elapses). */
  drain?(timeoutMs: number): Promise<boolean>
}

/**
 * Replace this process with a fresh dev server. A real execve keeps the pid, the stdio and the
 * shell's job control intact, so the restart is invisible from the terminal - and because the image
 * is replaced, every byte of the stale module graph goes away. Bun exposes no exec, so libc's is
 * called directly; where that is unavailable (Windows) the replacement is spawned instead, which
 * frees the same memory but detaches the server from the shell's foreground job.
 */
async function restartDevProcess(server: DevServerHandle): Promise<void> {
  try {
    // Stop accepting, then let what is already being served finish: an exec
    // mid-response would leave the browser with a truncated page and no error.
    server.stop(false)
    await server.drain?.(drainTimeoutMs)
    server.stop(true)
  } catch {
    // ignore: we are being replaced regardless
  }
  // The esbuild service keeps its pipes across an exec, so it would outlive the
  // image that owned it — with exactly the heap this restart is reclaiming.
  for (const [pid] of esbuildServices()) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // ignore: already gone
    }
  }
  const argv = [process.execPath, '--conditions=react-server', ...process.argv.slice(1)]
  const env = { ...process.env, [devRestartEnv]: '1' }
  try {
    await execSelf(argv, env)
  } catch {
    // ignore: fall through to the spawn path
  }
  // Only reached when exec is unavailable or failed.
  Bun.spawn(argv, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', env })
  process.exit(0)
}

// execve(2) via libc. argv/envp are NUL-terminated C string arrays, and the
// pointer array must stay reachable until the call returns (it never does on
// success).
async function execSelf(argv: string[], env: Record<string, string | undefined>): Promise<void> {
  if (process.platform === 'win32') return
  const { dlopen, FFIType, ptr, suffix } = await import('bun:ffi')
  const libc = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : `libc.${suffix}.6`
  const { symbols } = dlopen(libc, {
    execve: {
      args: [FFIType.cstring, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
  })
  const encoder = new TextEncoder()
  const cString = (value: string) => encoder.encode(`${value}\0`)
  const cArray = (values: string[]) => {
    const cells = values.map(cString)
    const array = new BigInt64Array(cells.length + 1)
    cells.forEach((cell, index) => {
      array[index] = BigInt(ptr(cell))
    })
    return { array, cells }
  }
  const args = cArray(argv)
  const envp = cArray(
    Object.entries(env)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${value}`),
  )
  symbols.execve(cString(argv[0]!), ptr(args.array), ptr(envp.array))
  // execve only returns on failure; keep the buffers alive until then.
  void [args.cells, envp.cells]
}

// Stop the server and run process `exit` handlers on a terminating signal,
// so killing the dev server never leaves orphaned subprocesses behind.
function registerShutdown(server: DevServerHandle) {
  let closing = false
  const shutdown = () => {
    if (closing) return
    closing = true
    try {
      server.stop(true)
    } catch {
      // ignore: process is exiting regardless
    }
    process.exit(0)
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, shutdown)
  }
}
