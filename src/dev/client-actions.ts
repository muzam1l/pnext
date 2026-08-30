// Client-action bundler seam (CORE - imports ZERO compat).
//
// The dev route-client bundle resolves every module into its own `pnext-route-client` esbuild namespace, so
// a standalone esbuild plugin cannot intercept that graph the way it can a plain client build. This holder
// is the extension point runtime/modules reads to turn a client-side import of a `'use server'` module into the
// RPC stub, without core statically importing compat/actions.
//
// Compat populates it; a pure-core app leaves it unset, and runtime/modules treats every module as a normal
// source module. Mirrors the routing/request-environment.ts holder pattern.

/** Compat client-action bundler surface runtime/modules consults. */
export interface ClientActionBundler {
  /**
   * Ensure the client-action module set is discovered for the active dev import version (a dev reload bumps
   * it). Awaited before a route-client build so the stub check below sees the current set - the discovery
   * that used to run inline at startup/reload now happens lazily here. Idempotent per version.
   */
  ensureArmed: () => Promise<void>
  /** True when `file` is a discovered `'use server'` module (stub it on the client). */
  isClientActionModule: (file: string) => boolean
  /** Generate the client fetch-stub source for an action module file. */
  stubSource: (file: string) => Promise<string>
  /** Read a client-layer source and replace an undiscovered action module with its RPC stub. */
  loadClientSource: (file: string, root: string) => Promise<{ source: string; stubSource?: string }>
}

let bundler: ClientActionBundler | undefined

/** Publish the compat client-action bundler (register-actions). */
export function setClientActionBundler(next: ClientActionBundler): void {
  bundler = next
}

/** The compat client-action bundler, or undefined for a pure-core app. */
export function getClientActionBundler(): ClientActionBundler | undefined {
  return bundler
}
