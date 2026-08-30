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
 * A non-leaf parallel `@slot` segment missing its `default.js` fallback
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
  return `Page "${page}" is missing "generateStaticParams()" so it cannot be used with "output: export" config.`
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
