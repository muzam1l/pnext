/**
 * Description of one action module, as the discovery pass hands it to the stub
 * generator: the module's path (for reference/debug), the action export names,
 * and the precomputed wire id for each.
 */
export interface ClientStubModule {
  modulePath: string
  exports: readonly string[]
  actionIds: Record<string, string>
}

/**
 * Generate the CLIENT stub SOURCE for a server-action module. On the client, a `'use server'` import
 * is replaced by this module: each export becomes an async function that dispatches through the shared
 * pnext action runtime, installed on `window.__PNEXT_ACTIONS__` by the client entry before any user
 * interaction can call an action.
 *
 * The runtime owns argument encoding, the POST to the current page URL with the next-action header,
 * and redirect/refresh/error handling, keeping every stub tiny. The generated source is a
 * self-contained ES module with no imports, so it can be emitted to disk and bundled as-is.
 */
export function clientStubSource(module: ClientStubModule): string {
  const lines: string[] = []

  lines.push(`// Generated pnext server-action client stub.`)
  lines.push(`// Module: ${sanitizeComment(module.modulePath)}`)
  lines.push(RUNTIME)

  for (const name of module.exports) {
    const id = module.actionIds[name]
    if (!id) continue
    const decl = name === 'default' ? 'export default' : `export const ${name} =`
    lines.push(`${decl} __pnextAction(${JSON.stringify(id)});`)
  }

  return lines.join('\n') + '\n'
}

const RUNTIME = `
function __pnextAction(id) {
  const action = async function (...args) {
    const runtime = (process.browser || typeof window !== 'undefined') ? window.__PNEXT_ACTIONS__ : undefined;
    if (runtime) {
      return runtime.call(id, args);
    }
    // Called on the SERVER: a client-imported 'use server' function invoked during a server
    // render/action (a bound action a client page's useActionState registered, dispatched in the no-JS
    // progressive path). Route it through the endpoint's server-side dispatcher, which resolves the id
    // to the real compiled action and runs it in the active request scope, instead of throwing as if
    // the browser runtime were missing.
    const server =
      typeof globalThis !== 'undefined' ? globalThis.__PNEXT_SERVER_ACTIONS__ : undefined;
    if (server) {
      return server.call(id, args);
    }
    throw new Error('pnext action runtime is not installed (is Next compat enabled?)');
  };
  action.$$pnextActionId = id;
  return action;
}
`

function sanitizeComment(value: string): string {
  return value.replace(/\*\//g, '*\\/').replace(/[\r\n]/g, ' ')
}
