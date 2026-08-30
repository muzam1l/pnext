// THE SINGLE COMPAT SEAM (CORE). The ONLY core module permitted a reference to the compat layer,
// and it does so through gated dynamic imports. Every other core file imports ZERO compat; they
// read behavior from the extension registry (src/extensions.ts) which compat populates here.
//
// Registration comes in two tiers, because importing the compat implementation graph costs far
// more than running the registrars themselves:
//
//   bootstrapCompatBoot(config) - loads ./compat/register/boot ONLY: the facts core reads before
//     it compiles anything (route conventions, page/CSS extensions, bare-specifier aliases, proxy
//     file names, lifecycle hooks).
//   bootstrapCompat(config)     - loads ./compat/register/index: the full graph and every remaining
//     registrar. Chains the boot tier first. `{ serve: true }` drops the build-only domains.
//
// Composition roots: build() and start() take the full tier; dev takes the boot tier at startup and
// the full tier on the first request. Both are idempotent under repeated and concurrent calls.
//
// The enablement gate is inlined here (a pure read of config.compat) rather than imported from
// compat, so this file carries no static edge into compat. It must stay in sync with
// compat/aliases.ts reactCompatEnabled/nextCompatEnabled.

import type { ResolvedConfig } from './config'
import { onExtensionHostReset } from './extensions'
import { installFetchHostNormalization } from './runtime/fetch-host'

/** True when either Next or React compatibility (or the React compiler) is on. */
function compatEnabled(config: ResolvedConfig): boolean {
  const compat = config.compat
  return Boolean(compat?.next || compat?.react || compat?.reactCompiler)
}

let bootRegistration: Promise<void> | undefined
let registration: Promise<void> | undefined

// A fresh host has none of compat's registrations, so the "already registered"
// memo has to go with it — otherwise the next bootstrap call is a no-op and the
// host stays empty for the rest of the process.
onExtensionHostReset(() => {
  bootRegistration = undefined
  registration = undefined
})

/**
 * Register the boot tier: the compat facts core consults before the first
 * compile. No-op (and no compat code loaded) for a pure-core app.
 */
export function bootstrapCompatBoot(config: ResolvedConfig): Promise<void> {
  // Core Bun-vs-undici runtime shim, not compat: every app needs it, gated or not.
  installFetchHostNormalization()
  if (!compatEnabled(config)) return Promise.resolve()
  bootRegistration ??= import('./compat/register/boot').then(module =>
    module.registerCompatBootExtensions(config),
  )
  return bootRegistration
}

/**
 * Populate the core extension registries with compat behavior when compat is enabled. No-op, and no compat
 * code loaded, for a pure-core app. Idempotent - the underlying dynamic import and registration run at most
 * once per process.
 */
export function bootstrapCompat(
  config: ResolvedConfig,
  options: { serve?: boolean } = {},
): Promise<void> {
  installFetchHostNormalization()
  if (!compatEnabled(config)) return Promise.resolve()
  registration ??= bootstrapCompatBoot(config)
    .then(() => import('./compat/register/index'))
    .then(module => module.registerCompatExtensions(config, options))
  return registration
}
