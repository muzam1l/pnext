// Compat shim for the deep Next internal
// `next/dist/server/app-render/work-unit-async-storage.external`.
//
// Some libraries (and app code, e.g. the app-external / segment-cache e2e
// fixtures) import this module directly to reach the SAME work-unit store the
// framework populates during a render. Next backs that with an
// AsyncLocalStorage whose store carries `type` ('request' | 'prerender' |
// 'prerender-runtime') plus, for a request work unit, `cookies`/`headers`.
// pnext keeps that state in core (src/request/context.ts, src/render/ppr.ts) and
// publishes a getter onto globalThis, which this module reflects — so a direct
// import observes the live store rather than a separate, empty instance.
//
// CommonJS on purpose: apps `require()` this specifier, and the server
// runtime's onLoad transform only intercepts `[jt]sx?` (see rootFilter), so a
// `.cjs` external is left to Bun's native loader and stays synchronously
// requirable. The same module as a `.ts` external is forced through that
// transform, becomes an async module, and `require()` throws
// "require() async module ... is unsupported". Same rule as constants.cjs /
// navigation.cjs — see the note in src/compat/aliases.ts.
const WORK_UNIT_EXTERNAL = Symbol.for('pnext.workUnitExternal')
/** @type {Record<PropertyKey, unknown>} */
const root = globalThis

const workUnitAsyncStorage = {
  // Never undefined: fixtures do `getStore().type` during build prerenders as
  // well as live requests. Core's getter always answers with a store.
  getStore: () => /** @type {(() => unknown) | undefined} */ (root[WORK_UNIT_EXTERNAL])?.(),
  /**
   * @param {unknown} _store
   * @param {(...args: unknown[]) => unknown} callback
   * @param {unknown[]} args
   */
  run: (_store, callback, ...args) => callback(...args),
}

exports.workUnitAsyncStorage = workUnitAsyncStorage
exports.default = workUnitAsyncStorage
