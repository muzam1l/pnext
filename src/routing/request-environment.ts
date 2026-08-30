// Per-server request runtime environment (CORE - imports ZERO compat).
//
// Core request handlers publish the small slice of their per-handler state that request interceptors
// (populated by compat via the extension registry) need to service a request, without core statically
// importing compat.
//
// Interceptors receive only `{ config }`; this holder is how they reach the live route table and mode flags.
// Compat's action-dispatch interceptor reads it to build its serve options, then calls core render/import
// helpers it imports directly.
//
// A single module-global mirrors the previous closure semantics exactly: start sets it once after loading
// the manifest; dev resets it on every reload. Reads always observe the latest published value.

import type { ResolvedConfig } from '../config'
import type { RouteManifestEntry } from '../types'

/** The live request environment a server handler exposes to interceptors. */
export interface RequestRuntime {
  config: ResolvedConfig
  /** Current route table (dev reassigns on reload; start loads once). */
  routes: RouteManifestEntry[]
  /** Dev server (on-demand compile) vs prod start (prebuilt output). */
  dev: boolean
  /**
   * Dev compile version passed to devServerModuleHref; bumped on reload. In
   * prod the compat interceptor uses 'build'/fixed hrefs and ignores this.
   */
  devImportVersion?: string
  /** serverActions.bodySizeLimit resolved from next.config, when configured. */
  maxBodyBytes?: number
}

let current: RequestRuntime | undefined

/** Publish (or refresh, on dev reload) the active request runtime. */
export function setRequestRuntime(runtime: RequestRuntime): void {
  current = runtime
}

/** The active request runtime, or undefined before a handler has set one. */
export function getRequestRuntime(): RequestRuntime | undefined {
  return current
}
