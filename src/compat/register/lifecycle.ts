// Request-lifecycle extension registration (COMPAT).
//
// Wires after()/onRequestError/instrumentation/testmode onto the core seams:
//   - initHooks (build + start): load instrumentation.ts and run its register() once; install the
//     testmode fetch patch once (a no-op until a request carries Next-Test-* headers).
//   - RequestExtensions.onRequestError: the error funnel (classify control-flow, dedupe, forward).
//   - a request interceptor: await the instrumentation register() gate so async register() completes
//     before the first request is served, and activate the testmode proxy for Next-Test-* requests.
//
// after() itself needs no registration - it is exported from the next/server alias and builds directly on
// the core work-unit after-queue.
//
// Split across the two registration tiers: the hooks core runs at server start register eagerly via
// registerLifecycleBootHooks(), while the request interceptor registers with the rest of the graph so its
// position in the interceptor chain is unchanged.

import type { ResolvedConfig } from '../../config'
import {
  registerInitHooks,
  registerRequestInterceptors,
  setRequestExtensions,
  type RequestInterceptor,
} from '../../extensions'
import { nextCompatEnabled } from '../aliases'
import { getNextConfig } from '../next/config-loader'
import { instrumentationReady, loadInstrumentation } from '../lifecycle/instrumentation'
import { installUnhandledRejectionGuard, reportRequestErrorToUser } from '../lifecycle/error-funnel'
import { activateTestProxy, installTestProxyFetch } from '../lifecycle/testmode'
import { recordRequestPath } from '../lifecycle/after-scope'
import { installNodeConsoleFormat } from '../lifecycle/node-console'

/** experimental.testProxy from the loaded next.config. */
function testProxyEnabled(): boolean {
  const experimental = getNextConfig().experimental as { testProxy?: boolean } | undefined
  return experimental?.testProxy === true
}

/** Boot tier: everything that must be installed before the server starts. */
export function registerLifecycleBootHooks(config: ResolvedConfig): void {
  if (!nextCompatEnabled(config)) return
  installNodeConsoleFormat()

  // The user's onRequestError hook (once instrumentation has loaded) receives
  // every real request error; control-flow errors are filtered in the funnel.
  setRequestExtensions({ onRequestError: reportRequestErrorToUser })

  // Keep the server alive when an SSR error escapes as an unhandled rejection
  // (a client component that throws during server render — preact resolves the
  // string pass to '' and floats the rejection). Without this the process
  // crashes and every later request in the shared harness server fails.
  installUnhandledRejectionGuard()

  // Load instrumentation and patch fetch at server start. The fetch patch is a no-op until a request
  // activates the test proxy. Instrumentation register() must NOT run during a build: Next only detects
  // the file at build and runs register() at server boot, so build prerenders see a noop tracer - a live
  // TracerProvider at build would bake real span ids into the static shell and 'use cache' entries.
  registerInitHooks((cfg, context) => {
    if (!context.build) loadInstrumentation(cfg)
    installTestProxyFetch()
  })
}

export function registerLifecycleExtensions(config: ResolvedConfig): void {
  if (!nextCompatEnabled(config)) return

  const lifecycleInterceptor: RequestInterceptor = async request => {
    // Block the very first requests until instrumentation register() settles.
    await instrumentationReady()
    // Remember the route pathname so an after() callback that runs detached
    // (after a page render) can name the route in its "used ... inside after()"
    // error, matching Next's message.
    try {
      recordRequestPath(new URL(request.url).pathname)
    } catch {
      // ignore malformed URLs
    }
    // Route this request's outgoing fetch through the test proxy when it carries
    // Next-Test-* headers (gated on experimental.testProxy in next.config).
    if (testProxyEnabled()) activateTestProxy(request.headers)
    return undefined
  }
  registerRequestInterceptors(lifecycleInterceptor)
}
