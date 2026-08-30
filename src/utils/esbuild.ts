// Lazy esbuild facade: importing 'esbuild' eagerly costs ~2.7 MB RSS and its
// first build()/transform() call spawns a resident ~10-45 MB service child, so
// the library must not load until something actually compiles.
import type * as Esbuild from 'esbuild'
import { loadNative } from './native-require'

let esbuild: typeof Esbuild | undefined

function load(): typeof Esbuild {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (esbuild ??= loadNative(() => require('esbuild') as typeof Esbuild))
}

// In-flight compiles, so a stop() never kills the service child out from under
// one: esbuild drops the pending call's promise and it never settles.
let inFlight = 0
let stopWhenIdle = false

function track<T>(promise: Promise<T>): Promise<T> {
  inFlight += 1
  return promise.finally(() => {
    inFlight -= 1
    if (inFlight === 0 && stopWhenIdle) {
      stopWhenIdle = false
      void esbuild?.stop()
    }
  })
}

// A service killed out from under an in-flight call (memory watchdog, crash) fails it with this
// exact message; the next call respawns the service, so one retry turns a user-visible 500 into
// a slightly slower response.
// "no longer running": issued against a dead cached service. "was stopped": in flight when a
// stop() (watchdog or the reset below) tore the service down.
const serviceDied = (error: unknown) =>
  error instanceof Error &&
  (error.message.includes('The service is no longer running') ||
    error.message.includes('The service was stopped'))

// esbuild caches the dead service until stop() resets it. The reset is epoch-guarded: every call
// that raced the same dead service shares one stop(), because a second stop() would kill the fresh
// child under the retries already running against it.
let resetEpoch = 0
let serviceReset: Promise<void> | undefined

async function withServiceRetry<T>(run: () => Promise<T>): Promise<T> {
  const epoch = resetEpoch
  try {
    return await track(run())
  } catch (error) {
    if (!serviceDied(error)) throw error
    if (epoch === resetEpoch) {
      serviceReset ??= Promise.resolve(esbuild?.stop())
        .catch(() => undefined)
        .then(() => {
          resetEpoch += 1
          serviceReset = undefined
        })
      await serviceReset
    }
    return track(run())
  }
}

export const build: typeof Esbuild.build = options => withServiceRetry(() => load().build(options))

export const transform: typeof Esbuild.transform = (input, options) =>
  withServiceRetry(() => load().transform(input, options))

/**
 * Spawn the resident service child ahead of the first real compile. Fire-and-forget: the spawn and
 * its handshake are subprocess work, so a caller holding wall-clock it does not control (a dev boot,
 * which compiles nothing before it listens) can absorb a cost the first compile would otherwise pay.
 */
export function warmEsbuildService(): void {
  void transform('', { loader: 'js' }).catch(() => undefined)
}

/**
 * Kill the resident esbuild service child (a prod server is done compiling
 * after its boot config build). No-op when esbuild never loaded; the service
 * respawns transparently on the next build()/transform() call. Deferred while a
 * compile is in flight — instrumentation register() bundles concurrently with
 * server boot, and killing the service mid-build hangs it forever.
 */
export function stopEsbuildService(): void {
  if (!esbuild) return
  if (inFlight > 0) {
    stopWhenIdle = true
    return
  }
  void esbuild.stop()
}
