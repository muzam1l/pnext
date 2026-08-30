import { AsyncLocalStorage } from 'node:async_hooks'

// globalThis-anchored (this module can be loaded twice — original + built copy
// — and both must observe the same scope; see the use-cache module-duplication
// incident).
const GSP_SCOPE = Symbol.for('pnext.generateStaticParamsScope')
interface GspScope {
  /** Params provided by parent generateStaticParams calls. */
  provided: Record<string, unknown>
}
const globals = globalThis as { [GSP_SCOPE]?: AsyncLocalStorage<GspScope> }
const gspScope = (globals[GSP_SCOPE] ??= new AsyncLocalStorage<GspScope>())

/** The active generateStaticParams scope, or undefined outside one. */
export function generateStaticParamsScope(): GspScope | undefined {
  return gspScope.getStore()
}

export function aliasGenerateStaticParams(
  module: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof module.params === 'function' || typeof module.generateStaticParams !== 'function') {
    return module
  }
  const generate = module.generateStaticParams as (args?: {
    params?: Record<string, unknown>
  }) => unknown
  // Wrap so root-params getters can tell they are running inside a
  // generateStaticParams call (and which parent params are available) —
  // reading a root param inside the generateStaticParams that defines it is a
  // build error (app-root-params-getters/generate-static-params-error).
  const params = (args?: { params?: Record<string, unknown> }) =>
    gspScope.run({ provided: args?.params ?? {} }, () => generate(args))
  return { ...module, params }
}
