// Native-binding loader guard.
//
// The lazy `require('esbuild' | 'oxc-*' | 'lightningcss')` facades defer a native binding until
// something actually compiles/parses/resolves - which means the FIRST load can land anywhere, including
// inside a render the compat edge runtime is wrapping. That runtime swaps a `process` proxy onto
// globalThis which hides `version`/`versions` (Next parity: user code must not detect Node there), and
// these loaders read `process.versions.node` / `process.versions.pnp` while initializing - so the
// require throws. Load them against the real process instead; the module cache then holds a good copy
// for every later call.
import realProcess from 'node:process'

export function loadNative<T>(load: () => T): T {
  const globalObject = globalThis as typeof globalThis & { process?: NodeJS.Process }
  if (globalObject.process === realProcess) return load()
  const previous = Object.getOwnPropertyDescriptor(globalObject, 'process')
  Object.defineProperty(globalObject, 'process', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: realProcess,
  })
  try {
    return load()
  } finally {
    if (previous) Object.defineProperty(globalObject, 'process', previous)
    else delete (globalObject as { process?: NodeJS.Process }).process
  }
}
