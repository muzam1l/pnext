// Pages-router surface for the server layers (pages islands SSR with the
// pages/pages-edge condition targets — see serverRequireAlias). The
// materialized page wrapper stashes the request's router state (route pattern,
// canonical asPath, merged query) on the globalThis-anchored request scope;
// useRouter() here returns it so pages components SSR the same values Next's
// pages router would. isReady stays false during SSR (Next semantics).
const noop = () => undefined
const events = { on: noop, off: noop, emit: noop }

function state() {
  try {
    const anchored = /** @type {Record<PropertyKey, any>} */ (globalThis)
    const storage = anchored[Symbol.for('pnext.requestStorage')]
    const scope = storage && storage.getStore ? storage.getStore() : undefined
    return (scope && scope[Symbol.for('pnext.pagesRouterState')]) || undefined
  } catch {
    return undefined
  }
}

function currentRouter() {
  const s = state()
  const pathname = (s && s.pathname) || '/'
  return {
    pathname,
    route: pathname,
    query: (s && s.query) || {},
    asPath: (s && s.asPath) || '/',
    basePath: '',
    isReady: false,
    isFallback: false,
    isPreview: false,
    events,
    push: async () => true,
    replace: async () => true,
    prefetch: async () => {},
    back: noop,
    forward: noop,
    reload: noop,
  }
}

exports.Router = { events }
exports.default = exports.Router
exports.useRouter = () => currentRouter()
/** @param {(props: object) => unknown} Component */
exports.withRouter =
  Component =>
  /** @param {object} props */
  props =>
    Component({ ...props, router: currentRouter() })
