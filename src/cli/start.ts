/**
 * `pnext start`: the listen path only. Everything a request needs — renderer,
 * routing, server runtime — lives in `./serve/pipeline` and is imported
 * dynamically once the port is bound, so neither the listen syscall nor the
 * ready banner waits on parsing it (it is ~700 KB of the prebundled entry).
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { loadConfig } from '../config'
import type { ResolvedConfig } from '../config'
import { bootstrapCompat } from '../compat-bootstrap'
import { getBuildExtensions } from '../extensions'
import { drainWorkUnits } from '../request/context'
import { markErrorLogged } from '../utils/error-log'
import { isPostpone } from '../render/postpone'
import { browserHost, ensurePortFree, openBrowser, printServerReady } from './serve/ui'
import type { BuildManifest } from '../types'
import type { PeerAddressSource } from '../routing/forwarded'

interface StartOptions {
  root?: string
  port?: number
  hostname?: string
}

type RequestHandler = (request: Request, server?: PeerAddressSource) => Promise<Response>

/**
 * The production request handler `pnext start` serves with. Exposed on its own
 * so deployment adapters (e.g. Vercel) can serve the exact same pipeline
 * without the Bun.serve wrapper.
 */
export async function createRequestHandler(
  options: { root?: string; config?: ResolvedConfig; manifest?: BuildManifest } = {},
): Promise<RequestHandler> {
  const { createRequestHandler: create } = await import('./serve/pipeline')
  return create(options)
}

export async function maybeBuiltFile(
  ...args: Parameters<typeof import('./serve/pipeline').maybeBuiltFile>
) {
  const { maybeBuiltFile: impl } = await import('./serve/pipeline')
  return impl(...args)
}

export async function start(options: StartOptions = {}) {
  const startedAt = Date.now()
  const port = options.port ?? 3000
  // Next's documented default. Bun resolves 'localhost' to ::1 only, refusing IPv4 clients.
  const hostname = options.hostname ?? '0.0.0.0'
  // Export builds are not served; pnext serves its standalone output directly.
  const config = await guardUnservableOutputMode(options.root)
  const manifest = await readProductionManifest(config)
  await ensurePortFree(port, hostname)

  // The pipeline import starts right after listen; a request that beats it
  // simply awaits the same promise instead of racing a second import.
  let handler: RequestHandler | undefined
  let pending: Promise<RequestHandler> | undefined
  const ensureHandler = () =>
    (pending ??= createRequestHandler({ root: options.root, config, manifest }).then(ready => {
      handler = ready
      return ready
    }))

  const server = Bun.serve({
    hostname,
    port,
    fetch: (request, server) =>
      handler ? handler(request, server) : ensureHandler().then(ready => ready(request, server)),
  })

  printServerReady({
    mode: 'production',
    hostname,
    port: server.port ?? port,
    elapsedMs: Date.now() - startedAt,
  })
  void ensureHandler().catch(() => undefined) // a real failure resurfaces on the request
  openBrowser(`http://${browserHost(hostname)}:${server.port ?? port}`)
  installShutdownHandlers(server)
  installProcessErrorHandlers()
  return server
}

// Next deliberately overrides the runtime's fatal-by-default handling of unhandled rejections and
// uncaught exceptions: an RSC server routinely starts promises it may never await, and a background
// job that rejects - an ISR revalidation whose fetch fails, an after() callback, a stream aborted by
// a client that navigated away - must never take the whole server down. Without a handler an error
// thrown outside any request scope exits the process, which in a long e2e run reads as the server
// silently disappearing mid-suite. Mirror Next: log and keep serving. Postpones are render control
// flow, not errors, so they stay silent; markErrorLogged keeps an error already reported at its
// render site from being printed twice.
function installProcessErrorHandlers(): void {
  const globalWithFlag = globalThis as typeof globalThis & {
    __pnextProcessErrorHandlers?: boolean
  }
  if (globalWithFlag.__pnextProcessErrorHandlers) return
  globalWithFlag.__pnextProcessErrorHandlers = true
  const report = (reason: unknown) => {
    if (isPostpone(reason)) return
    if (markErrorLogged(reason)) console.error(reason)
  }
  process.on('unhandledRejection', report)
  process.on('uncaughtException', report)
}

export async function readProductionManifest(config: ResolvedConfig): Promise<BuildManifest> {
  try {
    return JSON.parse(
      await readFile(path.join(config.outPath, 'manifest.json'), 'utf8'),
    ) as BuildManifest
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error("No production build found. Run 'pnext build' first.")
    }
    throw error
  }
}

// Export output is unservable; pnext production output remains serveable for standalone apps.
async function guardUnservableOutputMode(root?: string): Promise<ResolvedConfig> {
  const config = await loadConfig(root, { serve: true })
  await bootstrapCompat(config)
  const mode = getBuildExtensions().compat.nextOutputMode()
  if (mode === 'export') {
    console.error(
      '"next start" does not work with "output: export" configuration. ' +
        'Use "npx serve@latest out" instead.',
    )
    process.exit(1)
  }
  // Next warns on `next start` with standalone output; its standalone launcher re-execs this path
  // with __NEXT_PRIVATE_STANDALONE_CONFIG set to suppress the warning. Mirror both.
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  if (mode === 'standalone' && !process.env.__NEXT_PRIVATE_STANDALONE_CONFIG) {
    console.warn(
      '"next start" does not work with "output: standalone" configuration. ' +
        'Use "node .next/standalone/server.js" instead.',
    )
  }
  return config
}

// Graceful stop: quit accepting connections, wait for in-flight after() flushes (bounded), then exit
// so pending work is never dropped. Registered with `on` plus an in-progress guard, not `once`: the
// e2e harness tree-kills the whole process group AND the CLI wrapper forwards the same signal, so the
// server receives it twice - with `once` the second delivery hit the default disposition and killed
// the process mid-drain.
function installShutdownHandlers(server: { stop(closeActiveConnections?: boolean): void }) {
  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    server.stop()
    await drainWorkUnits()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
