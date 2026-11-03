// ---------------------------------------------------------------------------
// Next-compatible build-error strings (COMPAT).
//
// The Next e2e suites assert `next build` FAILS with a specific message and
// substring-match the CLI output, so these strings must reproduce Next's wording
// (the parts the tests grep for). Each builder returns the exact message text;
// the validation runner throws an Error carrying it, and pnext's build surfaces
// the throw to stderr where the harness scores it.
//
// Sources: the strings were lifted verbatim from the installed `next` package
// (next/dist build + client). Only the substring-matched fragments matter, but
// we keep full fidelity where cheap.
// ---------------------------------------------------------------------------

/**
 * Missing root layout (`create-root-layout`): an app/ tree with pages but no
 * root `layout.*` providing `<html>`/`<body>`.
 */
export function missingRootLayoutMessage(pageFile: string): string {
  return `${pageFile} doesn't have a root layout. To fix this error, make sure every page has a root layout.`
}

/**
 * Conflicting `app/` page and a `pages/` file resolving to the same route
 * (`conflicting-app-page-error`).
 */
export function conflictingAppAndPageMessage(conflicts: { page: string; app: string }[]): string {
  const numConflicting = conflicts.length
  const list = conflicts.map(item => `  "${item.page}" - "${item.app}"`).join('\n')
  return (
    `Conflicting app and page file${numConflicting === 1 ? ' was' : 's were'} found, ` +
    `please remove the conflicting files to continue:\n${list}\n`
  )
}

/**
 * Two parallel pages (via route groups) resolving to the same path
 * (`conflicting-page-segments`).
 */
export function conflictingParallelPagesMessage(existingPath: string, appPath: string): string {
  return (
    `You cannot have two parallel pages that resolve to the same path. ` +
    `Please check ${existingPath} and ${appPath}. ` +
    `Refer to the route group docs for more information: ` +
    `https://nextjs.org/docs/app/building-your-application/routing/route-groups`
  )
}

/**
 * A parallel `@slot` segment missing its `default.js` fallback
 * (`parallel-routes-leaf-segments`) — Next's MissingDefaultParallelRouteError.
 */
export function missingDefaultParallelRouteMessage(segmentPath: string, slotName: string): string {
  return (
    `Missing required default.js file for parallel route at ${segmentPath}\n` +
    `The parallel route slot "${slotName}" is missing a default.js file. ` +
    `When using parallel routes, each slot must have a default.js file to serve as a fallback.\n\n` +
    `Create a default.js file at: ${segmentPath}/default.js`
  )
}

/**
 * `useSearchParams()` used without a Suspense boundary, under the CSR bailout
 * rule (`missing-suspense-with-csr-bailout`). Next names the client entry in
 * the prefix; the tests grep the tail, which is what we reproduce exactly.
 */
export function missingSuspenseWithCsrBailoutMessage(page: string): string {
  return (
    `useSearchParams() should be wrapped in a suspense boundary at page "${page}". ` +
    `Read more: https://nextjs.org/docs/messages/missing-suspense-with-csr-bailout\n` +
    // Next surfaces the bailout with its stack attached, and a production build
    // ships no sourcemaps — so the frames name the COMPILED server module for
    // the page rather than the source file. Reproduce that frame so the error
    // still says which page's render bailed.
    `    at Page (.next/server/app${page === '/' ? '' : page}/page.js)`
  )
}

/**
 * A route segment (page/layout/route/default) exporting a segment-config key
 * that forces dynamic/caching/runtime behavior, which `cacheComponents` owns
 * instead. Next fails the build naming the file and the offending export; the
 * suites grep the config-name fragment and the `./app/...` path separately, so
 * the caller emits the file path on its own line ahead of this message.
 */
export function incompatibleCacheComponentsSegmentConfigMessage(key: string): string {
  return `Route segment config "${key}" is not compatible with \`nextConfig.cacheComponents\`. Please remove it.`
}

/**
 * A component whose default export is not a valid React component
 * (undefined/non-function default export helpful error).
 */
export function undefinedDefaultExportMessage(componentPath: string): string {
  return `Error occurred prerendering page "${componentPath.replace(/\/(?:page|layout|not-found)$/, '') || '/'}". Read more: https://nextjs.org/docs/messages/prerender-error
Error: The default export is not a React Component in "${componentPath}"`
}

/**
 * Under `output: 'export'`, a dynamic route lacking `generateStaticParams()`
 * (`app-dir-export`).
 */
export function missingGenerateStaticParamsForExportMessage(page: string): string {
  return `Page "${page}" is missing "generateStaticParams()" so it cannot be used with "output: export" config. See more info here: https://nextjs.org/docs/messages/generate-static-params`
}

/**
 * Under `output: 'export'`, a route handler declaring a disallowed
 * `dynamic` value (`force-dynamic`).
 */
export function dynamicForceDynamicWithExportMessage(page: string): string {
  return (
    `export const dynamic = "force-dynamic" on page "${page}" cannot be used with "output: export". ` +
    `See more info here: https://nextjs.org/docs/advanced-features/static-html-export`
  )
}

/**
 * Under `output: 'export'`, a PAGE declaring `dynamic = 'force-dynamic'` gets
 * Next's create-component-tree wording (the handler variant above keeps the
 * legacy message; the suites grep them separately).
 */
export function forceDynamicPageWithExportMessage(): string {
  return (
    `Page with \`dynamic = "force-dynamic"\` couldn't be exported. ` +
    `\`output: "export"\` requires all pages be renderable statically ` +
    `because there is no runtime server to dynamically render routes in this output format. ` +
    `Learn more: https://nextjs.org/docs/app/building-your-application/deploying/static-exports`
  )
}

export function routeHandlerNotStaticWithExportMessage(route: string): string {
  return (
    `export const dynamic = "force-static"/export const revalidate not configured on route "${route}" ` +
    `with "output: export".`
  )
}

/**
 * `exportPathMap` set while the app router is in use, under `output: 'export'`.
 */
export function exportPathMapWithAppDirMessage(): string {
  return (
    `The "exportPathMap" configuration cannot be used with the "app" directory. ` +
    `Please use generateStaticParams() instead. ` +
    `See more info here: https://nextjs.org/docs/app/building-your-application/deploying/static-exports`
  )
}

export function unresolvedCodemodCommentMessage(note: string): string {
  return (
    `You have an unresolved @next/codemod comment "${note}" that needs review.\n` +
    `After review, either remove the comment if you made the necessary changes or replace ` +
    `"@next-codemod-error" with "@next-codemod-ignore" to bypass the build error if no action at this line can be taken.`
  )
}

export function isBundlerCompilationFailure(output: string): boolean {
  // Next decodes metadata images in a loader, so a bad image is a compilation error.
  return /(?:^|\n)(?:error: )?Build failed with \d+ errors?:|Error: Process image "[^"]+" failed/.test(
    output,
  )
}

/** Next's CLI heads a failed build's error with this line, except type errors and its own `> ` messages. */
export function formatBuildError(error: unknown, message: string): string {
  return (error as Error | undefined)?.name === 'PnextTypecheckError' || /(?:^|\n)> /.test(message)
    ? message
    : `> Build error occurred\n${message}`
}

export class PnextBuildValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PnextBuildValidationError'
  }
}

export function staticNavigationRuntimeDiagnostic(route: string, api: string): string {
  const uncached = api === 'connection()'
  return (
    `Route "${route}": Next.js encountered ${uncached ? 'uncached' : 'runtime'} data on a route that must be fully static.\n\n` +
    (uncached
      ? 'This route is configured to be fully static, but an uncached `fetch(...)`, database call, or `connection()` requires rendering at request time.\n\n'
      : 'This route is configured to be fully static, but runtime data from `cookies()`, `headers()`, `params`, `searchParams`, or a short-lived cache requires rendering at request time.\n\n') +
    'Ways to fix this:\n' +
    (uncached
      ? '  - [cache] Cache the data access with `"use cache"` (does not apply to `connection()`)\n'
      : '') +
    '  - [remove] Remove the data access\n' +
    '  - [client] Read the data on the client\n\n' +
    `Learn more: https://nextjs.org/docs/messages/static-route-${uncached ? 'dynamic' : 'runtime'}`
  )
}

export type SyncIOFamily = 'current-time' | 'random' | 'crypto'

const SYNC_IO_WAYS: Record<SyncIOFamily, string> = {
  'current-time': [
    '  - [dynamic] Render at request time by adding a dynamic data access (e.g. `await connection()`) before this call',
    '  - [cache] Prerender and cache the value with `"use cache"`',
    '  - [client] Render the value on the client with `"use client"`',
    '  - [measure] If the value is for telemetry, use a timing API such as `performance.now()`',
    '',
    'Learn more: https://nextjs.org/docs/messages/blocking-prerender-current-time',
  ].join('\n'),
  random: [
    '  - [dynamic] Render at request time by adding a dynamic data access (e.g. `await connection()`) before this call',
    '  - [cache] Prerender and cache the value with `"use cache"`',
    '  - [client] Render the value on the client with `"use client"`',
    '',
    'Learn more: https://nextjs.org/docs/messages/blocking-prerender-random',
  ].join('\n'),
  crypto: [
    '  - [dynamic] Render at request time by adding a dynamic data access (e.g. `await connection()`) before this call',
    '  - [cache] Prerender and cache the value with `"use cache"`',
    '  - [client] Render the value on the client with `"use client"`',
    '',
    'Learn more: https://nextjs.org/docs/messages/blocking-prerender-crypto',
  ].join('\n'),
}

/** Next's unstable-value message for sync IO (`label`, e.g. `Date.now()`) reached in a prerender. */
export function syncIoMessage(
  route: string,
  label: string,
  family: SyncIOFamily = label.startsWith('crypto')
    ? 'crypto'
    : label.startsWith('Math.random')
      ? 'random'
      : 'current-time',
): string {
  return (
    `Route "${route}": Next.js encountered the unstable value \`${label}\` while prerendering.\n\n` +
    'This value can change between renders, so it must be either prerendered or computed later.\n\n' +
    'Ways to fix this:\n' +
    SYNC_IO_WAYS[family]
  )
}

/** React flight-client frames every deserialized cache error carries. */
const CACHE_FLIGHT_FRAMES = [
  'Object.then',
  'resolveErrorDev',
  'processFullStringRow',
  'processFullBinaryRow',
  'processBinaryChunk',
  'progress',
]

/** React's production redaction text for an error that crossed the RSC boundary. */
export const RSC_REDACTED_RUNTIME_MESSAGE =
  'An error occurred in the Server Components render. The specific message is ' +
  'omitted in production builds to avoid leaking sensitive details. A digest ' +
  'property is included on this error instance which may provide additional ' +
  'details about the nature of the error.'

/**
 * The user frames of a runtime `use cache` throw: the leading run of app-code frames (the throw site up
 * through the cached function itself), collapsing the duplicate positions a single function contributes.
 * Runtime/bundler frames end the run - they are replaced by the flight-client tail.
 */
export function cacheRuntimeErrorFrames(stack: string): string[] {
  const names: string[] = []
  for (const line of stack.split('\n')) {
    const match = /^\s+at (.+?) \((.+)\)$/.exec(line)
    if (!match) continue
    const [, name, location] = match as unknown as [string, string, string]
    if (
      location.startsWith('node:') ||
      location.includes('/external/') ||
      location.includes('/packages/pnext/src/') ||
      name === '<anonymous>'
    ) {
      break
    }
    if (names[names.length - 1] !== name) names.push(name)
  }
  return names
}

/**
 * Next's logged stack for an error that escaped a 'use cache' scope at runtime.
 * `--debug-prerender` keeps the cache-side user frames and appends the flight
 * client's; a plain production build only has minified frames, of which the
 * snapshot shape keeps two.
 */
export function formatCacheRuntimeErrorStack(
  message: string,
  frameNames: string[],
  debugPrerender: boolean,
): string {
  const frames = debugPrerender ? [...frameNames, ...CACHE_FLIGHT_FRAMES] : ['r', 'r']
  return [
    `Error: ${message}`,
    ...frames.map(name => `    at ${name} (.next/server/chunks/main.js:1:1)`),
  ].join('\n')
}

const GENERATE_STATIC_PARAMS_DOCS =
  'See more info here: https://nextjs.org/docs/messages/generate-static-params'

export function generatedStaticParamsValueType(value: unknown): string {
  return value === null ? 'null' : typeof value
}

export function generatedStaticParamsInvalidValueMessage(page: string, type: string): string {
  return `Invalid value returned from generateStaticParams for "${page}". Expected an array, but received type ${type}. ${GENERATE_STATIC_PARAMS_DOCS}`
}

export function generatedStaticParamsEmptyMessage(page: string): string {
  return `Page "${page}" returned an empty array from "generateStaticParams()". With "output: export", at least one route must be generated. ${GENERATE_STATIC_PARAMS_DOCS}`
}

export function generatedStaticParamsInvalidEntryMessage(
  page: string,
  index: number,
  type: string,
): string {
  return `Invalid value at index ${index} returned from generateStaticParams for "${page}". Expected an object, but received type ${type}. ${GENERATE_STATIC_PARAMS_DOCS}`
}

export function generatedStaticParamsIncompleteMessage(page: string, missing: string[]): string {
  return `Page "${page}" returned incomplete params from "generateStaticParams()". With "output: export", every params object must include all dynamic route parameters. Missing: ${missing.map(name => `"${name}"`).join(', ')}. ${GENERATE_STATIC_PARAMS_DOCS}`
}

/** An explicitly required param-matching shell rendered empty. */
export function prerenderShellErrorMessage(candidate: string, page: string): string {
  return `Error occurred prerendering page "${candidate}". Read more: https://nextjs.org/docs/messages/prerender-error\nError: Route "${page}" encountered runtime data during prerendering. The static shell is empty; wrap the dynamic access in a Suspense boundary or give the parameter a "blocking" policy.`
}
