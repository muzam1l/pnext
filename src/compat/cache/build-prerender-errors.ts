// Build-time `use cache` validation error collection (COMPAT).
//
// Three classes of `use cache` misuse must FAIL the build with Next's exact error text (the e2e suites
// substring-match on the build output): a cache fill that never resolves during a prerender (E236
// timeout), a `use cache` closure capturing a non-serializable function, and awaiting `searchParams`
// inside a `use cache` scope (E842).
//
// The core build wraps each page prerender in try/catch and DEGRADES a failing page to dynamic, so a
// thrown render error alone does not fail the build, and the caught search-params variant swallows the
// throw entirely. Both cases are handled by RECORDING the violation here at the moment of detection
// (inside the cache runtime, during a prerender) and surfacing them from a build-complete hook that
// prints Next's messages and aborts. Collection is armed only for a compat build's prerender pass, so
// the serving runtime and pure-core builds are unaffected.

export type PrerenderErrorKind =
  'hanging' | 'close-over' | 'search-params' | 'use-cache-dynamic' | 'unstable-cache-dynamic'

export interface PrerenderError {
  kind: PrerenderErrorKind
  route: string
  /** The error detail printed to stderr (Next's `Error: …` block). */
  consoleBlock: string
}

// The build process (which calls begin/end) and the built compat-server bundle (which runs the
// prerender and records violations) each load their OWN copy of this module, so a module-local
// armed/collected set by one copy is invisible to the other and detection would silently never fire.
// Anchor the state on globalThis so every copy shares one collection window.
const PRERENDER_ERROR_GLOBALS = Symbol.for('pnext.compat.prerenderErrorGlobals')

interface PrerenderErrorState {
  collected: PrerenderError[]
  armed: boolean
}

function state(): PrerenderErrorState {
  const root = globalThis as Record<PropertyKey, unknown>
  return (root[PRERENDER_ERROR_GLOBALS] ??= { collected: [], armed: false }) as PrerenderErrorState
}

/** Arm collection at the start of a compat build's prerender pass. */
export function beginPrerenderErrorCollection(): void {
  const s = state()
  s.collected.length = 0
  s.armed = true
}

/** Disarm collection and drain the recorded violations (build-complete hook). */
export function endPrerenderErrorCollection(): PrerenderError[] {
  const s = state()
  s.armed = false
  const out = s.collected.slice()
  s.collected.length = 0
  return out
}

/**
 * True while a compat build prerender is in progress. The cache-runtime
 * detectors gate on this so their throwing/timeout behavior is confined to
 * `pnext build` and never affects `pnext start`/dev or pure-core builds.
 */
export function prerenderErrorCollectionActive(): boolean {
  return state().armed
}

export function recordPrerenderError(error: PrerenderError): void {
  const s = state()
  if (!s.armed) return
  const collected = s.collected
  if (collected.some(e => e.kind === error.kind && e.route === error.route)) return
  collected.push(error)
  // Print at detection time (not only from the build-complete hook): a
  // close-over violation rethrows out of the cache-components shell render and
  // aborts the build BEFORE the complete hook runs, so the hook would never get
  // to print it. Printing here guarantees the message reaches the build output
  // (stderr) in every abort path; the hook only needs to force the non-zero
  // exit for the swallowed cases (hanging / caught search-params).
  console.error(error.consoleBlock)
  if (error.route) {
    console.error(`Error occurred prerendering page "${error.route}".`)
  }
}

/**
 * Derive the app-router pathname from a `use cache` function id (`<relative-file>#<name>`). Route
 * groups and the trailing `page`/`route` segment are stripped. Returns '' when the id is not a
 * recognizable app-router file.
 */
export function routeFromCacheId(id: string): string {
  const file = id.split('#', 1)[0] ?? ''
  const withoutExt = file.replace(/\.[jt]sx?$/, '')
  const segments = withoutExt.split('/')
  if (segments[0] === 'app' || segments[0] === 'src') segments.shift()
  if (segments[0] === 'app') segments.shift()
  const last = segments[segments.length - 1]
  if (last === 'page' || last === 'route' || last === 'default') segments.pop()
  const routeSegments = segments.filter(seg => !/^\(.*\)$/.test(seg))
  return `/${routeSegments.join('/')}`.replace(/\/+$/, '') || '/'
}

// --- Next's exact error strings -------------------------------------------

export const USE_CACHE_HANGING_MESSAGE =
  'Filling a cache during prerender timed out, likely because request-specific ' +
  'arguments such as params, searchParams, cookies() or dynamic data were used ' +
  'inside "use cache".'

export const USE_CACHE_CLOSE_OVER_FUNCTION_MESSAGE =
  'Functions cannot be passed directly to Client Components unless you ' +
  'explicitly expose it by marking it with "use server". Or maybe you meant to ' +
  'call this function rather than return it.'

/** The `[function]` / caret block Next prints under the close-over error. */
export const USE_CACHE_CLOSE_OVER_FUNCTION_BLOCK =
  `\nError: ${USE_CACHE_CLOSE_OVER_FUNCTION_MESSAGE}` + '\n  [function]' + '\n   ^^^^^^^^'

/**
 * Next's E838 message: a dynamic request API (`cookies()`/`headers()`/
 * `connection()`) invoked inside a function cached with `unstable_cache()`. The
 * e2e build suite substring-matches the first sentence
 * (`Route <route> used \`<api>\` inside a function cached with \`unstable_cache()\`.`);
 * the remainder mirrors Next's full runtime text.
 */
export function unstableCacheDynamicApiMessage(
  route: string,
  api: 'cookies()' | 'headers()' | 'connection()',
): string {
  return (
    `Route ${route} used \`${api}\` inside a function cached with ` +
    '`unstable_cache()`. Accessing Dynamic data sources inside a cache scope is ' +
    `not supported. If you need this data inside a cached function use \`${api}\` ` +
    'outside of the cached function and pass the required dynamic data in as an ' +
    'argument. See more info here: ' +
    'https://nextjs.org/docs/app/api-reference/functions/unstable_cache'
  )
}

export function useCacheDynamicApiMessage(
  route: string,
  api: 'cookies()' | 'headers()' | 'connection()',
): string {
  return (
    `Route ${route} used \`${api}\` inside "use cache". Accessing Dynamic data ` +
    'sources inside a cache scope is not supported. If you need this data inside ' +
    `a cached function use \`${api}\` outside of the cached function and pass the ` +
    'required dynamic data in as an argument. See more info here: ' +
    'https://nextjs.org/docs/messages/next-request-in-use-cache'
  )
}

export function useCacheSearchParamsMessage(route: string): string {
  return (
    `Route ${route} used \`searchParams\` inside "use cache". Accessing dynamic ` +
    'request data inside a cache scope is not supported. If you need some search ' +
    'params inside a cached function await `searchParams` outside of the cached ' +
    'function and pass only the required search params as arguments to the cached ' +
    'function. See more info here: https://nextjs.org/docs/messages/next-request-in-use-cache'
  )
}
