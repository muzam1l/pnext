// core-js polyfill injection (COMPAT - experimental.swcEnvOptions).
//
// When an app enables `experimental.swcEnvOptions`, SWC ships core-js polyfills for the JS features the
// targeted browsers lack. pnext does not run SWC's feature analysis; it mirrors the user-visible outcome
// by adding the matching `core-js/modules/*` import to the client module that uses the feature - the
// same placement SWC's usage mode picks, so the polyfill runs ahead of that module and ships in its
// chunk. Gated on swcEnvOptions being configured, so a pure app pays nothing.

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { ResolvedConfig } from '../../config'

// No-module polyfills chunk (COMPAT - Next parity).
//
// Next ships a `polyfills-<hash>.js` chunk referenced by a `<script noModule>` tag: legacy browsers with
// no ES-module support load it, module-capable browsers skip every `noModule` script. pnext only ever
// targets module-capable runtimes, so the chunk's body is inert - it exists so the served document
// carries the same `noModule` script tag Next emits, which some suites assert on.

/** Inert body for the no-module polyfills chunk (never runs in module browsers). */
export const POLYFILLS_NOMODULE_SOURCE = '!function(){"use strict"}();\n'

let cachedPolyfillsFileName: string | undefined

/** Content-hashed filename for the emitted no-module polyfills chunk. */
export function polyfillsChunkFileName(): string {
  if (cachedPolyfillsFileName) return cachedPolyfillsFileName
  const hash = createHash('sha256').update(POLYFILLS_NOMODULE_SOURCE).digest('hex').slice(0, 16)
  return (cachedPolyfillsFileName = `polyfills-${hash}.js`)
}

/** App-absolute served path of the polyfills chunk (before assetPrefix). */
export function polyfillsChunkPath(): string {
  return `/_next/static/chunks/${polyfillsChunkFileName()}`
}

// The core-js module SWC's usage mode emits per feature, keyed by the syntax
// that pulls it in. Extend as more features are needed.
const POLYFILL_FEATURES: { usage: RegExp; module: string }[] = [
  { usage: /\.replaceAll\s*\(/, module: 'core-js/modules/es.string.replace-all.js' },
]

/** Sniff tokens for the client transform below (one per feature usage). */
export const POLYFILL_USAGE_TOKENS = POLYFILL_FEATURES.map(feature => feature.usage)

// core-js resolves from the app, not from pnext. One require per root, reused
// across the transform's per-module calls.
const polyfillRequires = new Map<string, NodeJS.Require>()

function polyfillRequire(config: ResolvedConfig) {
  const existing = polyfillRequires.get(config.root)
  if (existing) return existing
  const created = createRequire(path.join(config.root, 'pnext-polyfill-resolve.cjs'))
  polyfillRequires.set(config.root, created)
  return created
}

/**
 * Prepend the core-js imports for the features `source` uses, mirroring SWC's usage mode: the polyfill
 * belongs to the MODULE that needs it, so it lands in that module's chunk (an `inject` into every entry
 * would instead be hoisted into a shared chunk of its own, away from the user code). A module core-js
 * does not ship - or that is not installed - is skipped, never a build failure.
 *
 * Only app sources, like SWC: polyfilling a dependency (or pnext's own client runtime) would make
 * core-js shared across entries and split back out into the very standalone chunk this placement avoids.
 */
export function rewriteUsagePolyfillImports(
  source: string,
  file: string,
  config: ResolvedConfig,
): string {
  const inApp = file.startsWith(`${config.root}${path.sep}`)
  if (!inApp || file.includes(`${path.sep}node_modules${path.sep}`)) return source
  const require = polyfillRequire(config)
  const imports = POLYFILL_FEATURES.flatMap(feature => {
    if (!feature.usage.test(source)) return []
    try {
      return [`import ${JSON.stringify(require.resolve(feature.module))};`]
    } catch {
      return []
    }
  })
  if (imports.length === 0) return source
  // After the directive prologue: a `'use client'` module must keep it first.
  const directive = /^(?:\s*['"][^'"]+['"];?\s*)*/.exec(source)?.[0] ?? ''
  return `${directive}${imports.join('\n')}\n${source.slice(directive.length)}`
}
