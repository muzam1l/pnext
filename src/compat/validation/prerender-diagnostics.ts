// Next-parity cacheComponents PRERENDER DIAGNOSTICS (COMPAT).
//
// A generate-mode build fails a cacheComponents route whose prerender would block (uncached/runtime data
// outside <Suspense>, a dynamic generateMetadata() on an otherwise prerenderable route, a dynamic
// generateViewport() without the opt-in), printing Next's exact diagnostic block: the E1290/E1292/E1289
// message, a synthesized React owner stack whose frames resolve to app-relative file:line:col positions,
// and - with `--debug-prerender` - a source codeframe of the offending line. The cache-components-errors
// e2e suites inline-snapshot these blocks byte-for-byte, so every space in the templates below is
// deliberate.
//
// The owner stack is synthesized statically from the page source (pnext renders with Preact, so React's
// captureOwnerStack does not exist): the violating dynamic `await` is located, the enclosing
// helper/component chain is resolved through local callsites, and ancestors are mapped to their JSX
// callsite positions - the same shape React's owner stack produces for these trees.

import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

export interface PrerenderDiagnosticInput {
  /** App-router pathname, e.g. '/dynamic-root'. */
  route: string
  /** Absolute path of the route's page file. */
  pageFile: string
  /** Absolute path of the app/ directory (for app-relative display paths). */
  appPath: string
  /** `--debug-prerender`: unminified stacks + codeframes. */
  debugPrerender: boolean
}

/** A single owner-stack frame within the page file. */
interface Frame {
  name: string
  line: number
  col: number
}

interface Violation {
  frames: Frame[]
  /** Codeframe anchor (the top frame's position). */
  anchor: Frame
  /**
   * How many component elements wrap the violating JSX usage inside the page. Each wrapper adds one React
   * internal frame to the minified component stack.
   */
  wrapperDepth: number
}

/**
 * Diagnose one cacheComponents page route. Returns the full printable
 * diagnostic text (blocks + per-block trailer, WITHOUT the shared
 * "Error occurred prerendering page" footer) when the route must fail the
 * generate pass, undefined when it prerenders fine.
 */
export function diagnoseCacheComponentsPrerender(
  input: PrerenderDiagnosticInput,
): string | undefined {
  const source = readSource(input.pageFile)
  if (!source) return undefined
  const displayPath = appRelativeDisplayPath(input.appPath, input.pageFile)
  const layouts = layoutChainSources(input.appPath, input.pageFile)

  // `use cache: private` nesting misuse fails the build before any other
  // analysis — the nesting IS the violation.
  const privateInUnstable = detectPrivateInUnstableCache(
    source,
    displayPath,
    input.route,
    input.debugPrerender,
  )
  if (privateInUnstable) return privateInUnstable
  const privateInCache = detectPrivateInUseCache(
    source,
    displayPath,
    input.route,
    input.debugPrerender,
  )
  if (privateInCache) return privateInCache
  const nestedCache = detectNestedShortCacheLife(
    source,
    displayPath,
    input.route,
    input.debugPrerender,
  )
  if (nestedCache) return nestedCache

  // Request APIs inside a `use cache` scope fail the prerender with their own
  // dedicated message (next-request-in-use-cache) before any blocking-dynamic
  // analysis — the cache scope IS the violation, Suspense can't excuse it.
  const useCache = detectUseCacheViolation(source)
  if (useCache) {
    return useCacheBlock(input.route, displayPath, source, useCache, input.debugPrerender)
  }
  // Same violation, but the offending `use cache` component is imported from
  // another module (third-party / ignore-listed code).
  const importedUseCache = detectImportedUseCacheViolation(
    source,
    input.pageFile,
    displayPath,
    input.route,
    input.debugPrerender,
  )
  if (importedUseCache) return importedUseCache

  // The page's own cache scope is an uncoverable dynamic hole (short-lived
  // cache / fallback params) — the generic blocking-dynamic diagnostic.
  const pageHole = detectPageDynamicHole(
    source,
    displayPath,
    input.route,
    layouts,
    input.debugPrerender,
  )
  if (pageHole) return pageHole

  // An unguarded Client Component reading a current-time value wins over an
  // unguarded server dynamic access (sync-attribution precedence).
  const clientSyncIO = detectClientSyncIO(
    source,
    input.pageFile,
    input.appPath,
    input.route,
    input.debugPrerender,
  )
  if (clientSyncIO) return clientSyncIO

  // A request API read synchronously during the prerender throws a real
  // TypeError (the un-awaited promise has no such method) — reported as a
  // runtime prerender error rather than a blocking-prerender diagnostic.
  const syncRequestApi = detectSyncRequestApi(
    source,
    displayPath,
    input.route,
    input.debugPrerender,
  )
  if (syncRequestApi) return syncRequestApi

  const analysis = analyzePage(source)
  const suspenseAboveBody = layouts.some(layoutWrapsBodyInSuspense)

  // Precedence mirrors Next: a blocking dynamic access outside <Suspense> wins
  // over the metadata/viewport variants; viewport wins over metadata.
  if (analysis.violations.length > 0) {
    return analysis.violations
      .map(violation =>
        blockingDynamicBlock(input.route, displayPath, source, violation, input.debugPrerender),
      )
      .join('\n')
  }
  // Sync IO (Date/Math.random/crypto randomness) during a prerender fails the
  // route with the unstable-value diagnostic regardless of Suspense wrapping.
  const syncIO = detectSyncIO(source)
  if (syncIO) {
    return syncIOBlock(input.route, displayPath, source, syncIO, input.debugPrerender)
  }
  if (analysis.dynamicViewport && !suspenseAboveBody && !analysis.instantFalse) {
    return viewportBlock(input.route)
  }
  if (analysis.dynamicMetadata && !analysis.hasSuspendedDynamic) {
    return metadataBlock(input.route)
  }
  return undefined
}

function prerenderErrorLine(route: string): string {
  return `Error occurred prerendering page "${route}". Read more: https://nextjs.org/docs/messages/prerender-error`
}

/**
 * Whether a diagnostic block already opens with the prerender-error line - the runtime-error classes (a
 * thrown TypeError) print it before the serialized error, so the footer must not repeat it.
 */
export function diagnosticLeadsWithErrorLine(diagnostic: string): boolean {
  return diagnostic.startsWith('Error occurred prerendering page "')
}

/** The shared footer after the diagnostic blocks (debug vs minified variant). */
export function prerenderFailureFooter(
  route: string,
  debugPrerender: boolean,
  omitErrorLine = false,
): string {
  const pagePath = `${route}/page`
  const summary = debugPrerender
    ? `> Export encountered errors on 1 path:\n\t${pagePath}: ${route}`
    : `Export encountered an error on ${pagePath}: ${route}, exiting the build.`
  // Debug mode separates the error line from the export summary with a blank
  // line; that blank line survives when the diagnostic already printed the
  // error line itself.
  if (omitErrorLine) return debugPrerender ? `\n${summary}` : summary
  const errorLine = prerenderErrorLine(route)
  return debugPrerender ? `${errorLine}\n\n${summary}` : `${errorLine}\n${summary}`
}

// --- message templates ------------------------------------------------------

const BLOCKING_DYNAMIC_WAYS = [
  'Ways to fix this:',
  '  - [cache] Cache the data access with `"use cache"`',
  '    https://nextjs.org/docs/messages/blocking-prerender-dynamic#cache-the-component-or-data',
  '  - [stream] Provide a placeholder with `<Suspense fallback={...}>` around the data access',
  '    https://nextjs.org/docs/messages/blocking-prerender-dynamic#wrap-in-or-move-into-suspense',
  "  - [cache] If the runtime data is `params` and they're known, prerender them with `generateStaticParams`",
  '    https://nextjs.org/docs/messages/blocking-prerender-runtime#for-known-params-prerender',
  '  - [block] Set `export const unstable_instant = false` to silence this warning and allow a blocking route',
  '    https://nextjs.org/docs/messages/blocking-prerender-dynamic#allow-blocking-route',
].join('\n')

function blockingDynamicIntro(route: string): string {
  return (
    `Error: Route "${route}": Next.js encountered uncached or runtime data during prerendering.\n\n` +
    '`fetch(...)`, `cookies()`, `headers()`, `params`, `searchParams`, or `connection()` accessed outside of `<Suspense>` prevents the route from being prerendered, blocking the page load and leading to a slower user experience.\n\n' +
    BLOCKING_DYNAMIC_WAYS
  )
}

function debugTrailer(route: string): string {
  return `To debug the issue, start the app in development mode by running \`next dev\`, then open "${route}" in your browser to investigate the error.`
}

function minifiedTrailer(route: string): string {
  return (
    'To get a more detailed stack trace and pinpoint the issue, try one of the following:\n' +
    `  - Start the app in development mode by running \`next dev\`, then open "${route}" in your browser to investigate the error.\n` +
    '  - Rerun the production build with `next build --debug-prerender` to generate better stack traces.'
  )
}

function metadataBlock(route: string): string {
  return (
    `Route "${route}": Next.js encountered uncached or runtime data in \`generateMetadata()\`.\n\n` +
    "This route's metadata is blocked, but the rest of its content can be prerendered.\n\n" +
    'Ways to fix this:\n' +
    '  - [static] Use a static metadata export instead of `generateMetadata()`\n' +
    '    https://nextjs.org/docs/messages/blocking-prerender-metadata-runtime#use-static-metadata\n' +
    '  - [cache] Cache the metadata with `"use cache"` in `generateMetadata()`\n' +
    '    https://nextjs.org/docs/messages/blocking-prerender-metadata-dynamic#cache-the-metadata\n' +
    '  - [dynamic] Render a marker component that calls `await connection()` inside `<Suspense>` on the page\n' +
    '    https://nextjs.org/docs/messages/blocking-prerender-metadata-dynamic#mark-the-route-as-dynamic'
  )
}

function viewportBlock(route: string): string {
  return (
    `Route "${route}": Next.js encountered uncached or runtime data in \`generateViewport()\`.\n\n` +
    'This prevents the page from being prerendered, leading to a slower user experience.\n\n' +
    'Ways to fix this:\n' +
    '  - [static] Use a static viewport export instead of `generateViewport()`\n' +
    '    https://nextjs.org/docs/messages/blocking-prerender-viewport-runtime#use-static-viewport\n' +
    '  - [cache] Cache the viewport data with `"use cache"` in `generateViewport()`\n' +
    '    https://nextjs.org/docs/messages/blocking-prerender-viewport-dynamic#cache-the-viewport-data\n' +
    '  - [block] Set `export const unstable_instant = false` to silence this warning and allow a blocking route\n' +
    '    https://nextjs.org/docs/messages/blocking-prerender-viewport-dynamic#allow-blocking-route'
  )
}

/**
 * One blocking-prerender-dynamic block. Debug mode: real synthesized frames
 * (`webpack:///`-prefixed, matching the harness's webpack branch) + a codeframe
 * anchored at the top frame + the dev-mode advisory. Minified mode: React's
 * minified component stack is approximated as N `.next`-dir frames around the
 * host-element chain (the suite normalizer letters the names; only counts and
 * the host frames survive normalization).
 */
function blockingDynamicBlock(
  route: string,
  displayPath: string,
  source: string,
  violation: Violation,
  debugPrerender: boolean,
): string {
  const parts: string[] = [blockingDynamicIntro(route)]
  if (debugPrerender) {
    for (const frame of violation.frames) {
      parts.push(`    at ${frame.name} (webpack:///${displayPath}:${frame.line}:${frame.col})`)
    }
    parts.push(codeFrame(source, violation.anchor.line, violation.anchor.col))
    parts.push(debugTrailer(route))
  } else {
    const dist = (count: number) =>
      Array.from({ length: count }, () => '    at r (.next/server/chunks/main.js:1:1)')
    parts.push(
      ...dist(10 + violation.wrapperDepth),
      '    at main (<anonymous>)',
      '    at body (<anonymous>)',
      '    at html (<anonymous>)',
      ...dist(11),
    )
    parts.push(minifiedTrailer(route))
  }
  return parts.join('\n')
}

// --- sync IO (unstable values) ---------------------------------------------

type SyncIOFamily = 'current-time' | 'random' | 'crypto'

interface SyncIOFinding {
  /** Message label, e.g. `Math.random()` or `require('node:crypto').randomBytes(size)`. */
  label: string
  family: SyncIOFamily
  frames: Frame[]
  anchor: Frame
}

const SYNC_IO_WAYS: Record<SyncIOFamily, string> = {
  'current-time': [
    '  - [dynamic] Render at request time by adding a dynamic data access (e.g. `await connection()`) before this call',
    '    https://nextjs.org/docs/messages/blocking-prerender-current-time#generate-on-every-request',
    '  - [cache] Prerender and cache the value with `"use cache"`',
    '    https://nextjs.org/docs/messages/blocking-prerender-current-time#cache-the-timestamp',
    '  - [client] Render the value on the client with `"use client"`',
    '    https://nextjs.org/docs/messages/blocking-prerender-current-time#render-on-the-client',
    '  - [measure] If the value is for telemetry, use a timing API such as `performance.now()`',
    '    https://nextjs.org/docs/messages/blocking-prerender-current-time#for-telemetry-use-a-timing-api',
  ].join('\n'),
  random: [
    '  - [dynamic] Render at request time by adding a dynamic data access (e.g. `await connection()`) before this call',
    '    https://nextjs.org/docs/messages/blocking-prerender-random#generate-on-every-request',
    '  - [cache] Prerender and cache the value with `"use cache"`',
    '    https://nextjs.org/docs/messages/blocking-prerender-random#cache-the-random-value',
    '  - [client] Render the value on the client with `"use client"`',
    '    https://nextjs.org/docs/messages/blocking-prerender-random#render-on-the-client',
  ].join('\n'),
  crypto: [
    '  - [dynamic] Render at request time by adding a dynamic data access (e.g. `await connection()`) before this call',
    '    https://nextjs.org/docs/messages/blocking-prerender-crypto#generate-on-every-request',
    '  - [cache] Prerender and cache the value with `"use cache"`',
    '    https://nextjs.org/docs/messages/blocking-prerender-crypto#cache-the-generated-value',
    '  - [client] Render the value on the client with `"use client"`',
    '    https://nextjs.org/docs/messages/blocking-prerender-crypto#render-on-the-client',
  ].join('\n'),
}

/** Node crypto member -> message label ('' keeps the default `(...)` form). */
const NODE_CRYPTO_LABELS: Record<string, string> = {
  getRandomValues: 'crypto.getRandomValues()',
  randomBytes: "require('node:crypto').randomBytes(size)",
  randomInt: "require('node:crypto').randomInt(min, max)",
  randomUUID: "require('node:crypto').randomUUID()",
  generateKeyPairSync: "require('node:crypto').generateKeyPairSync(...)",
  generateKeySync: "require('node:crypto').generateKeySync(...)",
  generatePrimeSync: "require('node:crypto').generatePrimeSync(...)",
  randomFillSync: "require('node:crypto').randomFillSync(...)",
}

interface SyncIOSite {
  /** 0-based offset of the frame/caret anchor within the searched body. */
  index: number
  label: string
  family: SyncIOFamily
}

/**
 * Earliest sync-IO call site in a function body. Anchor rules mirror the
 * positions Next's stack captures resolve to: property calls anchor the METHOD
 * name (`Date.now`, `Math.random`, global web-crypto members), `new Date`
 * anchors the `new`, bare `Date()` anchors the identifier, and node:crypto
 * member calls anchor the RECEIVER (`crypto`) since the local module binding
 * owns the frame.
 */
function findSyncIOSite(body: string, nodeCrypto: boolean): SyncIOSite | undefined {
  const sites: SyncIOSite[] = []
  const add = (index: number, label: string, family: SyncIOFamily) =>
    sites.push({ index, label, family })
  for (const m of body.matchAll(/\bDate\s*\.\s*(now)\s*\(/g)) {
    add((m.index ?? 0) + m[0].lastIndexOf('now'), 'Date.now()', 'current-time')
  }
  for (const m of body.matchAll(/\bnew\s+Date\s*\(/g))
    add(m.index ?? 0, 'new Date()', 'current-time')
  for (const m of body.matchAll(/(?<![.\w$])Date\s*\(/g)) {
    const before = body.slice(0, m.index ?? 0)
    if (/\bnew\s*$/.test(before)) continue
    add(m.index ?? 0, 'Date()', 'current-time')
  }
  for (const m of body.matchAll(/\bMath\s*\.\s*(random)\s*\(/g)) {
    add((m.index ?? 0) + m[0].lastIndexOf('random'), 'Math.random()', 'random')
  }
  const cryptoMembers = Object.keys(NODE_CRYPTO_LABELS).join('|')
  for (const m of body.matchAll(new RegExp(`\\bcrypto\\s*\\.\\s*(${cryptoMembers})\\s*\\(`, 'g'))) {
    const member = m[1]!
    if (nodeCrypto) {
      const family: SyncIOFamily = member === 'getRandomValues' ? 'crypto' : 'random'
      add(m.index ?? 0, NODE_CRYPTO_LABELS[member]!, family)
    } else if (member === 'getRandomValues' || member === 'randomUUID') {
      add(
        (m.index ?? 0) + m[0].lastIndexOf(member),
        member === 'getRandomValues' ? 'crypto.getRandomValues()' : 'crypto.randomUUID()',
        'crypto',
      )
    }
  }
  // Date.now() also matches the bare-Date scan guard above; the earliest anchor
  // is the one Next reports. Dedupe overlapping candidates by taking the first.
  sites.sort((a, b) => a.index - b.index)
  return sites[0]
}

/** Body has an awaited request/dynamic API BEFORE `index` (allows sync IO). */
function dynamicAccessBefore(body: string, index: number): boolean {
  const before = body.slice(0, index)
  return /\bawait\s+(?:connection|cookies|headers)\s*\(/.test(before)
}

function hasUseCachePrologue(body: string): boolean {
  return /^\s*(['"])use cache(?:\s*:\s*[\w-]+)?\1/.test(body)
}

/** A `use cache: private` directive prologue (private caches are dynamic holes). */
function hasPrivateCachePrologue(body: string): boolean {
  return /^\s*(['"])use cache\s*:\s*private\1/.test(body)
}

/** A plain (non-private) `use cache` / `use cache: remote` prologue. */
function hasSharedCachePrologue(body: string): boolean {
  return hasUseCachePrologue(body) && !hasPrivateCachePrologue(body)
}

/**
 * A `cacheLife({ ... })` in this body whose window is too short to prerender: `expire` under 5 minutes or
 * `revalidate: 0`. Next excludes such a cache from the prerender, turning it into a dynamic hole. Returns
 * which option triggered it, or undefined when the cache is prerenderable.
 */
function shortCacheLifeKind(body: string): 'expire' | 'revalidate' | undefined {
  const call = /\bcacheLife\s*\(\s*\{([^}]*)\}\s*\)/.exec(body)
  if (!call) return undefined
  const options = call[1]!
  const expire = /\bexpire\s*:\s*(\d+)/.exec(options)
  if (expire && Number(expire[1]) < 300) return 'expire'
  const revalidate = /\brevalidate\s*:\s*(\d+)/.exec(options)
  if (revalidate && Number(revalidate[1]) === 0) return 'revalidate'
  return undefined
}

/**
 * Detect a sync-IO unstable-value access reachable from the page: directly in
 * a component, or in a lowercase helper called from a component. Suspense does
 * NOT excuse these (unlike blocking dynamic data).
 */
function detectSyncIO(source: string): SyncIOFinding | undefined {
  if (/^\s*(['"])use client\1/.test(source)) return undefined
  const functions = collectFunctions(source)
  const byName = new Map(functions.map(fn => [fn.name, fn]))
  const page = byName.get('Page') ?? functions.find(fn => isComponentName(fn.name))
  if (!page) return undefined
  const nodeCrypto = /['"]node:crypto['"]/.test(source)
  for (const fn of functions) {
    if (fn === page) continue
    const body = source.slice(fn.bodyStart, fn.bodyEnd)
    if (hasUseCachePrologue(body)) continue
    const site = findSyncIOSite(body, nodeCrypto)
    if (!site || dynamicAccessBefore(body, site.index)) continue
    const anchorIndex = fn.bodyStart + site.index
    const frames: Frame[] = [frameAt(source, anchorIndex, fn.name)]
    let component = fn
    if (!isComponentName(fn.name)) {
      // Helper: resolve the calling component for the middle frame.
      const caller = functions.find(candidate => {
        if (!isComponentName(candidate.name)) return false
        const callerBody = source.slice(candidate.bodyStart, candidate.bodyEnd)
        return new RegExp(`\\b${fn.name}\\s*\\(`).test(callerBody)
      })
      if (!caller) continue
      const callerBody = source.slice(caller.bodyStart, caller.bodyEnd)
      const callsite = new RegExp(`\\b${fn.name}\\s*\\(`).exec(callerBody)
      frames.push(frameAt(source, caller.bodyStart + (callsite?.index ?? 0), caller.name))
      component = caller
    }
    // Page frame: the JSX usage of the (calling) component.
    const pageBody = source.slice(page.bodyStart, page.bodyEnd)
    const usage = new RegExp(`<${component.name}\\b`).exec(pageBody)
    if (usage) frames.push(frameAt(source, page.bodyStart + usage.index, page.name))
    return { label: site.label, family: site.family, frames, anchor: frames[0]! }
  }
  return undefined
}

// --- sync IO in an unguarded Client Component -------------------------------

const CLIENT_CURRENT_TIME_WAYS = [
  '  - [stream] Wrap the Client Component in `<Suspense fallback={...}>`',
  '    https://nextjs.org/docs/messages/blocking-prerender-current-time-client#wrap-in-or-move-into-suspense',
  '  - [defer] Move the read into a `useEffect` or event handler',
  '    https://nextjs.org/docs/messages/blocking-prerender-current-time-client#move-into-effect-or-event-handler',
  '  - [measure] If the value is for telemetry, use a timing API such as `performance.now()`',
  '    https://nextjs.org/docs/messages/blocking-prerender-current-time-client#for-telemetry-use-a-timing-api',
].join('\n')

/**
 * A Client Component that reads a current-time value (`new Date()`/`Date.now()`)
 * during its render and is used on the page OUTSIDE a <Suspense> boundary. Next
 * evaluates it once during the prerender, so it fails the build with the
 * "in a Client Component" diagnostic. This takes precedence over an unguarded
 * server-side dynamic access (sync-attribution). A read deferred into a
 * microtask/effect is NOT attributed (it is not at render top-level).
 */
function detectClientSyncIO(
  source: string,
  pageFile: string,
  appPath: string,
  route: string,
  debugPrerender: boolean,
): string | undefined {
  const functions = collectFunctions(source)
  const page =
    functions.find(fn => fn.name === 'Page') ?? functions.find(fn => isComponentName(fn.name))
  if (!page) return undefined
  const pageBody = source.slice(page.bodyStart, page.bodyEnd)
  for (const imp of source.matchAll(
    /import\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*(['"])([^'"]+)\3/g,
  )) {
    const specifier = imp[4]!
    const names: string[] = []
    if (imp[1]) names.push(imp[1].trim())
    if (imp[2])
      for (const part of imp[2].split(',')) {
        const local = part
          .split(/\bas\b/)
          .pop()!
          .trim()
        if (local) names.push(local)
      }
    for (const name of names) {
      if (!isComponentName(name)) continue
      const usage = new RegExp(`<${name}\\b`).exec(pageBody)
      if (!usage || insideSuspense(pageBody, usage.index)) continue
      const moduleFile = resolveModule(pageFile, specifier)
      if (!moduleFile) continue
      const clientSource = readSource(moduleFile)
      if (!clientSource || !/^\s*(['"])use client\1/.test(clientSource)) continue
      const fn = collectFunctions(clientSource).find(candidate => candidate.name === name)
      if (!fn) continue
      const site = renderTimeSyncIO(clientSource, fn)
      if (!site) continue
      const clientDisplay = appRelativeDisplayPath(appPath, moduleFile)
      const pageDisplay = appRelativeDisplayPath(appPath, pageFile)
      const clientFrame = frameAt(clientSource, fn.bodyStart + site.index, name)
      const pageFrame = frameAt(source, page.bodyStart + usage.index, page.name)
      const intro =
        `Error: Route "${route}": Next.js encountered the unstable value \`${site.label}\` in a Client Component.\n\n` +
        'This value would be evaluated during the prerender, instead of recomputed on each visit.\n\n' +
        'Ways to fix this:\n' +
        CLIENT_CURRENT_TIME_WAYS
      if (debugPrerender) {
        return [
          intro,
          `    at ${clientFrame.name} (webpack:///${clientDisplay}:${clientFrame.line}:${clientFrame.col})`,
          `    at ${pageFrame.name} (webpack:///${pageDisplay}:${pageFrame.line}:${pageFrame.col})`,
          codeFrame(clientSource, clientFrame.line, clientFrame.col),
          debugTrailer(route),
        ].join('\n')
      }
      return [intro, '    at r (.next/server/chunks/main.js:1:1)', minifiedTrailer(route)].join(
        '\n',
      )
    }
  }
  return undefined
}

/**
 * A current-time sync-IO read at the render top-level of a client function
 * (brace depth 0 — not inside a microtask/effect/event-handler callback).
 */
function renderTimeSyncIO(source: string, fn: FunctionInfo): SyncIOSite | undefined {
  const body = source.slice(fn.bodyStart, fn.bodyEnd)
  const site = findSyncIOSite(body, /['"]node:crypto['"]/.test(source))
  if (site?.family !== 'current-time') return undefined
  const before = body.slice(0, site.index)
  const depth = (before.match(/\{/g)?.length ?? 0) - (before.match(/\}/g)?.length ?? 0)
  return depth > 0 ? undefined : site
}

function syncIOBlock(
  route: string,
  displayPath: string,
  source: string,
  finding: SyncIOFinding,
  debugPrerender: boolean,
): string {
  const parts: string[] = [
    `Error: Route "${route}": Next.js encountered the unstable value \`${finding.label}\` while prerendering.\n\n` +
      'This value can change between renders, so it must be either prerendered or computed later.\n\n' +
      'Ways to fix this:\n' +
      SYNC_IO_WAYS[finding.family],
  ]
  if (debugPrerender) {
    for (const frame of finding.frames) {
      parts.push(`    at ${frame.name} (webpack:///${displayPath}:${frame.line}:${frame.col})`)
    }
    parts.push(codeFrame(source, finding.anchor.line, finding.anchor.col))
    parts.push(debugTrailer(route))
  } else {
    parts.push('    at r (.next/server/chunks/main.js:1:1)')
    parts.push(minifiedTrailer(route))
  }
  return parts.join('\n')
}

// --- request APIs read synchronously ----------------------------------------

/**
 * `(cookies() as any).get('token')` during a prerender: `cookies()` returns a promise, so the member call
 * throws a TypeError while rendering. Next surfaces it as a runtime prerender failure - the "Error occurred
 * prerendering page" line, then the serialized error with its owner stack and digest - rather than as a
 * blocking-prerender diagnostic, so the block leads with that line and the footer contributes only the
 * export summary.
 *
 * A dynamic access before the read moves the render to request time, where the same mistake throws at
 * runtime instead of failing the build, so those routes are left alone.
 */
function detectSyncRequestApi(
  source: string,
  displayPath: string,
  route: string,
  debugPrerender: boolean,
): string | undefined {
  const apis = 'cookies|headers|draftMode'
  // `(<api>() as any).member(` — the optional parens/cast are how the fixtures
  // (and real apps) silence the type error around the sync read.
  const pattern = new RegExp(
    `\\(?\\s*\\b(${apis})\\s*\\(\\s*\\)(?:\\s+as\\s+[\\w<>[\\]|]+)?\\s*\\)?\\s*\\.\\s*(\\w+)\\s*\\(`,
    'g',
  )
  for (const fn of collectFunctions(source)) {
    const body = source.slice(fn.bodyStart, fn.bodyEnd)
    if (hasUseCachePrologue(body)) continue
    for (const match of body.matchAll(pattern)) {
      const index = match.index ?? 0
      // `await cookies()` resolves the promise first — the member call is fine.
      if (/\bawait\s*\(?\s*$/.test(body.slice(0, index))) continue
      if (dynamicAccessBefore(body, index)) continue
      const api = match[1]!
      const member = match[2]!
      const frame = frameAt(source, fn.bodyStart + index + match[0].lastIndexOf(member), fn.name)
      // Webpack's module-namespace call form — the suites normalize it to
      // `<module-function>()`, so only its shape matters.
      const message = `TypeError: (0 , ${debugPrerender ? '_headers' : 'e'}.${api})(...).${member} is not a function`
      if (debugPrerender) {
        return [
          prerenderErrorLine(route),
          message,
          `    at ${frame.name} (webpack:///${displayPath}:${frame.line}:${frame.col})`,
          codeFrame(source, frame.line, frame.col) + digestTrailer(),
        ].join('\n')
      }
      // Minified: the throwing frame lives in a dist chunk (no codeframe), with
      // the owner component as the anonymous frame above it.
      return [
        prerenderErrorLine(route),
        message,
        '    at r (.next/server/chunks/main.js:1:1)',
        `    at ${frame.name} (<anonymous>)${digestTrailer()}`,
      ].join('\n')
    }
  }
  return undefined
}

// --- request APIs inside `use cache` ---------------------------------------

type UseCacheApi = 'cookies' | 'headers' | 'connection' | 'draftMode'

interface UseCacheFinding {
  api: UseCacheApi
  frames: Frame[]
  anchor: Frame
}

function useCacheMessage(route: string, api: UseCacheApi): string {
  const seeMore = 'See more info here: https://nextjs.org/docs/messages/next-request-in-use-cache'
  switch (api) {
    case 'cookies':
    case 'headers':
      return (
        `Error: Route ${route} used \`${api}()\` inside "use cache". ` +
        'Accessing Dynamic data sources inside a cache scope is not supported. ' +
        `If you need this data inside a cached function use \`${api}()\` outside of the cached function and pass the required dynamic data in as an argument. ` +
        seeMore
      )
    case 'connection':
      return (
        `Error: Route ${route} used \`connection()\` inside "use cache". ` +
        'The `connection()` function is used to indicate the subsequent code must only run when there is an actual request, but caches must be able to be produced before a request, so this function is not allowed in this scope. ' +
        seeMore
      )
    case 'draftMode':
      return (
        `Error: Route ${route} used "draftMode().enable()" inside "use cache". ` +
        'The enabled status of `draftMode()` can be read in caches but you must not enable or disable `draftMode()` inside a cache. ' +
        seeMore
      )
  }
}

/** A request API awaited inside a function body carrying a `use cache` prologue. */
function detectUseCacheViolation(source: string): UseCacheFinding | undefined {
  const functions = collectFunctions(source)
  const byName = new Map(functions.map(fn => [fn.name, fn]))
  const page = byName.get('Page') ?? functions.find(fn => isComponentName(fn.name))
  if (!page) return undefined
  for (const fn of functions) {
    if (fn === page) continue
    const body = source.slice(fn.bodyStart, fn.bodyEnd)
    if (!hasUseCachePrologue(body)) continue
    // `use cache: private` scopes run per-request and MAY read request data.
    if (/^\s*(['"])use cache\s*:\s*private\1/.test(body)) continue
    let api: UseCacheApi | undefined
    let anchorIndex: number | undefined
    const enable = /draftMode\s*\(\s*\)\s*\)?\s*\.\s*(enable)\s*\(/.exec(body)
    if (enable) {
      api = 'draftMode'
      anchorIndex = enable.index + enable[0].lastIndexOf('enable')
    } else {
      const request = /\bawait\s+(cookies|headers|connection)\s*(\()/.exec(body)
      if (request) {
        api = request[1] as UseCacheApi
        anchorIndex = request.index + request[0].length - 1
      }
    }
    if (api === undefined || anchorIndex === undefined) continue
    const frames: Frame[] = [frameAt(source, fn.bodyStart + anchorIndex, fn.name)]
    const pageBody = source.slice(page.bodyStart, page.bodyEnd)
    const usage = new RegExp(`<${fn.name}\\b`).exec(pageBody)
    if (usage) frames.push(frameAt(source, page.bodyStart + usage.index, page.name))
    return { api, frames, anchor: frames[0]! }
  }
  return undefined
}

function useCacheBlock(
  route: string,
  displayPath: string,
  source: string,
  finding: UseCacheFinding,
  debugPrerender: boolean,
): string {
  const parts: string[] = [useCacheMessage(route, finding.api)]
  if (debugPrerender) {
    for (const frame of finding.frames) {
      parts.push(`    at ${frame.name} (webpack:///${displayPath}:${frame.line}:${frame.col})`)
    }
    parts.push(codeFrame(source, finding.anchor.line, finding.anchor.col))
    parts.push(debugTrailer(route))
  } else {
    // Next's minified use-cache stack keeps two dist frames for the request
    // APIs but only one for the draftMode().enable() variant.
    const count = finding.api === 'draftMode' ? 1 : 2
    for (let i = 0; i < count; i++) parts.push('    at r (.next/server/chunks/main.js:1:1)')
    parts.push(minifiedTrailer(route))
  }
  return parts.join('\n')
}

// --- `use cache: private` nesting misuse ------------------------------------

/**
 * Serialized-error trailer (` {\n  digest: '...'\n}`) appended to a runtime
 * error's stack. The suite normalizes the numeric digest to `<error-digest>`.
 */
function digestTrailer(): string {
  return " {\n  digest: '3491756801'\n}"
}

/**
 * A `use cache: private` scope rendered inside a non-private `use cache` scope - Next fails the build,
 * since private caches may only nest inside another private cache. The stack shows the private function's
 * declaration line plus the serialized error digest.
 */
const PRIVATE_IN_USE_CACHE_MESSAGE =
  'Error: "use cache: private" must not be used within "use cache". It can only be nested inside of another "use cache: private".'

function detectPrivateInUseCache(
  source: string,
  displayPath: string,
  route: string,
  debugPrerender: boolean,
): string | undefined {
  const functions = collectFunctions(source)
  const privateFn = functions.find(fn =>
    hasPrivateCachePrologue(source.slice(fn.bodyStart, fn.bodyEnd)),
  )
  if (!privateFn) return undefined
  const parent = functions.find(
    fn =>
      fn !== privateFn &&
      hasSharedCachePrologue(source.slice(fn.bodyStart, fn.bodyEnd)) &&
      new RegExp(`<${privateFn.name}\\b`).test(source.slice(fn.bodyStart, fn.bodyEnd)),
  )
  if (!parent) return undefined
  if (debugPrerender) {
    const frame = frameAt(source, privateFn.declIndex, privateFn.name)
    return [
      PRIVATE_IN_USE_CACHE_MESSAGE,
      `    at ${frame.name} (webpack:///${displayPath}:${frame.line}:${frame.col})`,
      codeFrame(source, frame.line, frame.col) + digestTrailer(),
      debugTrailer(route),
    ].join('\n')
  }
  // Minified: the runtime error is logged twice (Next's known double-log), each
  // with a dist frame + a host-anonymous frame carrying the serialized digest.
  const loggedError = [
    PRIVATE_IN_USE_CACHE_MESSAGE,
    '    at r (.next/server/chunks/main.js:1:1)',
    `    at ${privateFn.name} (<anonymous>)${digestTrailer()}`,
  ].join('\n')
  return [`⨯ ${loggedError}`, loggedError, minifiedTrailer(route)].join('\n')
}

/**
 * A `use cache: private` scope nested inside `unstable_cache()` - Next fails the build. The stack anchors
 * the `unstable_cache()` callback plus the awaiting component.
 */
function detectPrivateInUnstableCache(
  source: string,
  displayPath: string,
  route: string,
  debugPrerender: boolean,
): string | undefined {
  const decl = /\bconst\s+(\w+)\s*=\s*unstable_cache\s*\(\s*/.exec(source)
  if (!decl) return undefined
  const callbackIndex = decl.index + decl[0].length
  const callbackBody = source.slice(callbackIndex, callbackIndex + 400)
  if (!/(['"])use cache\s*:\s*private\1/.test(callbackBody)) return undefined
  const cacheName = decl[1]!
  const message = 'Error: "use cache: private" must not be used within `unstable_cache()`.'
  if (!debugPrerender) {
    // Minified: three dist frames, no codeframe.
    return [
      message,
      '    at r (.next/server/chunks/main.js:1:1)',
      '    at r (.next/server/chunks/main.js:1:1)',
      '    at r (.next/server/chunks/main.js:1:1)',
      minifiedTrailer(route),
    ].join('\n')
  }

  const frames: Frame[] = [frameAt(source, callbackIndex, '<unknown>')]
  // The component that awaits the cached function (owner frame above it).
  const functions = collectFunctions(source)
  for (const fn of functions) {
    const body = source.slice(fn.bodyStart, fn.bodyEnd)
    const call = new RegExp(`\\bawait\\s+${cacheName}\\s*\\(`).exec(body)
    if (call) {
      frames.push(frameAt(source, fn.bodyStart + call.index, `async ${fn.name}`))
      break
    }
  }
  const anchor = frames[0]!
  return [
    message,
    ...frames.map(f => `    at ${f.name} (webpack:///${displayPath}:${f.line}:${f.col})`),
    codeFrame(source, anchor.line, anchor.col),
    debugTrailer(route),
  ].join('\n')
}

// --- nested short-lived `use cache` without explicit outer cacheLife ---------

/**
 * A `use cache` with a short `expire` or zero `revalidate` nested inside another `use cache` that sets no
 * explicit `cacheLife` - Next fails the build with a `nested-use-cache-no-explicit-cachelife` error
 * carrying a `[cause]` stack.
 */
function detectNestedShortCacheLife(
  source: string,
  displayPath: string,
  route: string,
  debugPrerender: boolean,
): string | undefined {
  const functions = collectFunctions(source)
  const inner = functions.find(fn => {
    const body = source.slice(fn.bodyStart, fn.bodyEnd)
    return hasSharedCachePrologue(body) && shortCacheLifeKind(body) !== undefined
  })
  if (!inner) return undefined
  const kind = shortCacheLifeKind(source.slice(inner.bodyStart, inner.bodyEnd))!
  const outer = functions.find(fn => {
    if (fn === inner) return false
    const body = source.slice(fn.bodyStart, fn.bodyEnd)
    return (
      hasSharedCachePrologue(body) &&
      !/\bcacheLife\s*\(/.test(body) &&
      new RegExp(`\\b${inner.name}\\s*\\(`).test(body)
    )
  })
  if (!outer) return undefined
  const page = functions.find(fn =>
    new RegExp(`\\bawait\\s+${outer.name}\\s*\\(`).test(source.slice(fn.bodyStart, fn.bodyEnd)),
  )
  if (!page) return undefined

  const message =
    kind === 'expire'
      ? 'Error: A "use cache" with short `expire` (under 5 minutes) is nested inside another "use cache" that has no explicit `cacheLife`, which is not allowed during prerendering. Add `cacheLife()` to the outer "use cache" to choose whether it should be prerendered (with longer `expire`) or remain dynamic (with short `expire`). Read more: https://nextjs.org/docs/messages/nested-use-cache-no-explicit-cachelife'
      : 'Error: A "use cache" with zero `revalidate` is nested inside another "use cache" that has no explicit `cacheLife`, which is not allowed during prerendering. Add `cacheLife()` to the outer "use cache" to choose whether it should be prerendered (with non-zero `revalidate`) or remain dynamic (with zero `revalidate`). Read more: https://nextjs.org/docs/messages/nested-use-cache-no-explicit-cachelife'
  const causeLine =
    '  [cause]: Nested dynamic "use cache": This "use cache" has a dynamic cache life that was propagated to its parent.'

  if (!debugPrerender) {
    return [
      message,
      '    at r (.next/server/chunks/main.js:1:1) {',
      causeLine,
      '      at r (.next/server/chunks/main.js:1:1)',
      '      at r (.next/server/chunks/main.js:1:1)',
      '      at r (.next/server/chunks/main.js:1:1)',
      '}',
      minifiedTrailer(route),
    ].join('\n')
  }

  const pageBody = source.slice(page.bodyStart, page.bodyEnd)
  const awaitCall = new RegExp(`\\bawait\\s+${outer.name}\\s*\\(`).exec(pageBody)!
  const pageFrame = frameAt(source, page.bodyStart + awaitCall.index, `async ${page.name}`)
  const innerFrame = frameAt(source, inner.declIndex, inner.name)
  const outerBody = source.slice(outer.bodyStart, outer.bodyEnd)
  const innerCall = new RegExp(`\\b${inner.name}\\s*\\(`).exec(outerBody)!
  const outerFrame = frameAt(source, outer.bodyStart + innerCall.index, outer.name)

  return [
    message,
    `    at ${pageFrame.name} (webpack:///${displayPath}:${pageFrame.line}:${pageFrame.col})`,
    codeFrame(source, pageFrame.line, pageFrame.col) + ' {',
    causeLine,
    `      at ${inner.name} (webpack:///${displayPath}:${innerFrame.line}:${innerFrame.col})`,
    `      at ${outer.name} (webpack:///${displayPath}:${outerFrame.line}:${outerFrame.col})`,
    `      at ${page.name} (<anonymous>)`,
    indentLines(codeFrame(source, innerFrame.line, innerFrame.col), '  '),
    '}',
    debugTrailer(route),
  ].join('\n')
}

/** Prefix every line of `text` with `pad` (for the nested `[cause]` codeframe). */
function indentLines(text: string, pad: string): string {
  return text
    .split('\n')
    .map(line => pad + line)
    .join('\n')
}

// --- request APIs inside a `use cache` imported from another module ----------

/**
 * A component imported from another module (e.g. a third-party package) that
 * reads a request API inside `use cache`. The violation lives in ignore-listed
 * code, so Next's owner stack shows only the page's JSX callsite. Resolves the
 * import, scans the exported function, and emits the single Page frame.
 */
function detectImportedUseCacheViolation(
  source: string,
  pageFile: string,
  displayPath: string,
  route: string,
  debugPrerender: boolean,
): string | undefined {
  const functions = collectFunctions(source)
  const page =
    functions.find(fn => fn.name === 'Page') ?? functions.find(fn => isComponentName(fn.name))
  if (!page) return undefined
  const pageBody = source.slice(page.bodyStart, page.bodyEnd)
  // Imported bindings: `import { A, B } from 'spec'` / `import Default from 'spec'`.
  for (const imp of source.matchAll(
    /import\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*(['"])([^'"]+)\3/g,
  )) {
    const specifier = imp[4]!
    const names: string[] = []
    if (imp[1]) names.push(imp[1].trim())
    if (imp[2])
      for (const part of imp[2].split(',')) {
        const local = part
          .split(/\bas\b/)
          .pop()!
          .trim()
        if (local) names.push(local)
      }
    for (const name of names) {
      if (!isComponentName(name)) continue
      const usage = new RegExp(`<${name}\\b`).exec(pageBody)
      if (!usage) continue
      const finding = resolveImportedUseCacheApi(pageFile, specifier, name)
      if (!finding) continue
      const frame = frameAt(source, page.bodyStart + usage.index, page.name)
      return useCacheBlock(
        route,
        displayPath,
        source,
        { api: finding, frames: [frame], anchor: frame },
        debugPrerender,
      )
    }
  }
  return undefined
}

/** Resolve `specifier` from `pageFile` and detect a request API used inside a
 * `use cache` export named `name`. */
function resolveImportedUseCacheApi(
  pageFile: string,
  specifier: string,
  name: string,
): UseCacheApi | undefined {
  const moduleFile = resolveModule(pageFile, specifier)
  if (!moduleFile) return undefined
  const moduleSource = readSource(moduleFile)
  if (!moduleSource) return undefined
  const fn = collectFunctions(moduleSource).find(candidate => candidate.name === name)
  if (!fn) return undefined
  const body = moduleSource.slice(fn.bodyStart, fn.bodyEnd)
  if (!hasUseCachePrologue(body) || hasPrivateCachePrologue(body)) return undefined
  if (/draftMode\s*\(\s*\)\s*\)?\s*\.\s*enable\s*\(/.test(body)) return 'draftMode'
  const request = /\bawait\s+(cookies|headers|connection)\s*\(/.exec(body)
  return request ? (request[1] as UseCacheApi) : undefined
}

/** Minimal module resolution: relative paths + bare packages via node_modules. */
function resolveModule(fromFile: string, specifier: string): string | undefined {
  const exts = ['tsx', 'ts', 'jsx', 'js', 'mjs', 'cjs']
  const tryFile = (base: string): string | undefined => {
    if (existsSync(base) && !isDirectory(base)) return base
    for (const ext of exts) if (existsSync(`${base}.${ext}`)) return `${base}.${ext}`
    for (const ext of exts) {
      const index = path.join(base, `index.${ext}`)
      if (existsSync(index)) return index
    }
    return undefined
  }
  if (specifier.startsWith('.')) {
    return tryFile(path.resolve(path.dirname(fromFile), specifier))
  }
  // Bare specifier: walk up looking for node_modules/<pkg>.
  const [scope, sub] = specifier.startsWith('@')
    ? [specifier.split('/').slice(0, 2).join('/'), specifier.split('/').slice(2).join('/')]
    : [specifier.split('/')[0]!, specifier.split('/').slice(1).join('/')]
  let dir = path.dirname(fromFile)
  for (;;) {
    const pkgDir = path.join(dir, 'node_modules', scope)
    if (existsSync(pkgDir)) {
      if (sub) return tryFile(path.join(pkgDir, sub))
      const entry = packageEntry(pkgDir)
      if (entry) return tryFile(path.join(pkgDir, entry)) ?? tryFile(path.join(pkgDir, 'index'))
      return tryFile(path.join(pkgDir, 'index'))
    }
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function packageEntry(pkgDir: string): string | undefined {
  const source = readSource(path.join(pkgDir, 'package.json'))
  if (!source) return undefined
  try {
    const pkg = JSON.parse(source) as { exports?: unknown; main?: string; module?: string }
    const dot = (pkg.exports as Record<string, unknown> | undefined)?.['.']
    if (typeof dot === 'string') return dot
    if (dot && typeof dot === 'object') {
      const cond = dot as Record<string, unknown>
      for (const key of ['import', 'default', 'require', 'node']) {
        if (typeof cond[key] === 'string') return cond[key]
      }
    }
    return pkg.module ?? pkg.main
  } catch {
    return undefined
  }
}

// --- page-level dynamic holes (short-lived cache / fallback params) ----------

/**
 * The page's own `use cache` scope is a dynamic hole that escapes every
 * <Suspense> boundary: a short-lived cache (`expire` < 5min / `revalidate: 0`),
 * or an uncached `params` read on a route without `generateStaticParams`. Next
 * fails the prerender with the generic blocking-dynamic diagnostic.
 */
function detectPageDynamicHole(
  source: string,
  displayPath: string,
  route: string,
  layouts: string[],
  debugPrerender: boolean,
): string | undefined {
  if (layouts.some(layoutWrapsChildrenInSuspense)) return undefined
  const functions = collectFunctions(source)
  const page =
    functions.find(fn => fn.name === 'Page') ?? functions.find(fn => isComponentName(fn.name))
  if (!page) return undefined
  const body = source.slice(page.bodyStart, page.bodyEnd)
  if (!hasSharedCachePrologue(body)) return undefined
  const shortCache = shortCacheLifeKind(body) !== undefined
  const fallbackParams =
    /\bawait\s+params\b/.test(body) &&
    /\[[^\]]+\]/.test(route) &&
    !/\bgenerateStaticParams\b/.test(source)
  if (!shortCache && !fallbackParams) return undefined
  const anchor = frameAt(source, page.declIndex, page.name)
  const violation: Violation = { frames: [anchor], anchor, wrapperDepth: 0 }
  return blockingDynamicBlock(route, displayPath, source, violation, debugPrerender)
}

/** A layout wraps `{children}` inside <Suspense> (the dynamic hole is covered). */
function layoutWrapsChildrenInSuspense(source: string): boolean {
  const suspense = source.indexOf('<Suspense')
  const children = source.indexOf('{children}')
  return suspense !== -1 && children !== -1 && suspense < children
}

// --- codeframe --------------------------------------------------------------

/**
 * Next's codeframe renderer clamps each rendered row (gutter included) to a
 * `maxWidth`; with a piped stdout `process.stdout.columns` is undefined and the
 * native renderer's 100-column default applies, ellipsizing longer rows.
 */
const CODE_FRAME_MAX_WIDTH = 100

function clampCodeFrameRow(row: string): string {
  return row.length <= CODE_FRAME_MAX_WIDTH ? row : `${row.slice(0, CODE_FRAME_MAX_WIDTH - 3)}...`
}

/** Babel-style codeframe: 2 context lines above, 3 below, `>` cursor + caret. */
function codeFrame(source: string, line: number, col: number): string {
  const lines = source.split('\n')
  const first = Math.max(1, line - 2)
  const last = Math.min(lines.length, line + 3)
  const width = String(last).length
  const out: string[] = []
  for (let n = first; n <= last; n += 1) {
    const cursor = n === line ? '>' : ' '
    const text = lines[n - 1] ?? ''
    // Empty source lines keep a bare `|` gutter (no trailing space), matching
    // Next's babel-style codeframe output that the snapshots encode.
    out.push(clampCodeFrameRow(`${cursor} ${String(n).padStart(width)} |${text ? ` ${text}` : ''}`))
    if (n === line) {
      out.push(`${' '.repeat(width + 2)} | ${' '.repeat(col - 1)}^`)
    }
  }
  return out.join('\n')
}

// --- static page analysis ---------------------------------------------------

interface PageAnalysis {
  dynamicMetadata: boolean
  dynamicViewport: boolean
  instantFalse: boolean
  /** The page renders dynamic content, but wrapped in <Suspense> (partial). */
  hasSuspendedDynamic: boolean
  violations: Violation[]
}

interface FunctionInfo {
  name: string
  /** 0-based index of the declaration START (the `export`/`async`/`function`/`const`). */
  declIndex: number
  /** 0-based index of the function NAME token in the source. */
  nameIndex: number
  /** 0-based index just past the body's opening brace. */
  bodyStart: number
  /** 0-based index of the body's closing brace. */
  bodyEnd: number
}

const DYNAMIC_APIS = ['cookies', 'headers', 'connection', 'draftMode'] as const

function analyzePage(source: string): PageAnalysis {
  const functions = collectFunctions(source)
  const byName = new Map(functions.map(fn => [fn.name, fn]))
  const instantFalse = /\bexport\s+const\s+unstable_instant\s*=\s*false\b/.test(source)
  const dynamicMetadata = generatorIsDynamic(source, byName.get('generateMetadata'))
  const dynamicViewport = generatorIsDynamic(source, byName.get('generateViewport'))

  const page = byName.get('Page') ?? functions.find(fn => isComponentName(fn.name))
  const violations: Violation[] = []
  let hasSuspendedDynamic = false
  if (page) {
    const body = source.slice(page.bodyStart, page.bodyEnd)
    // Direct dynamic await in the page body itself (outside any JSX child).
    for (const fn of functions) {
      if (!isComponentName(fn.name) || fn === page) continue
      const usageState = componentDynamicState(source, fn, byName)
      if (usageState === 'static') continue
      // Every JSX usage of this component inside the page body.
      const usagePattern = new RegExp(`<${fn.name}\\b[^>]*>`, 'g')
      for (const usage of body.matchAll(usagePattern)) {
        const usageIndex = page.bodyStart + (usage.index ?? 0)
        if (usageState === 'conditional' && /\bcached(?:=\{true\}|\b(?!=))/.test(usage[0])) {
          continue
        }
        if (insideSuspense(body, usage.index ?? 0)) {
          hasSuspendedDynamic = true
          continue
        }
        violations.push(buildViolation(source, fn, byName, page, usageIndex))
      }
    }
  }
  return { dynamicMetadata, dynamicViewport, instantFalse, hasSuspendedDynamic, violations }
}

/** generateMetadata/generateViewport is dynamic: awaits without 'use cache'. */
function generatorIsDynamic(source: string, fn: FunctionInfo | undefined): boolean {
  if (!fn) return false
  const body = source.slice(fn.bodyStart, fn.bodyEnd)
  if (/(['"])use cache(?:\s*:\s*[\w-]+)?\1/.test(body)) return false
  return /\bawait\b/.test(body)
}

/**
 * Whether a component renders dynamic (uncached) data: 'dynamic' always, 'conditional' when gated behind a
 * `cached ? cachedPath : dynamicPath` ternary on a prop (a usage passing `cached={true}` takes the cached
 * branch), 'static' otherwise.
 */
function componentDynamicState(
  source: string,
  fn: FunctionInfo,
  byName: Map<string, FunctionInfo>,
): 'static' | 'dynamic' | 'conditional' {
  const body = source.slice(fn.bodyStart, fn.bodyEnd)
  // A `use cache: private` scope is treated as dynamic during prerendering, so
  // it must sit under a <Suspense> boundary — an unguarded usage is a blocking
  // dynamic hole (use-cache-private-without-suspense).
  if (hasPrivateCachePrologue(body)) return 'dynamic'
  // A `use cache` scope resolves at buildtime — its awaits are never blocking
  // dynamic data (the use-cache request-API check catches the illegal ones).
  if (hasUseCachePrologue(body)) return 'static'
  const conditional = /\bcached\s*\?/.test(body)
  if (directDynamicAwait(body) !== undefined) return 'dynamic'
  for (const call of body.matchAll(/\bawait\s+([a-z][\w$]*)\s*\(/g)) {
    const helper = byName.get(call[1]!)
    if (
      helper &&
      directDynamicAwait(source.slice(helper.bodyStart, helper.bodyEnd)) !== undefined
    ) {
      return conditional ? 'conditional' : 'dynamic'
    }
  }
  return 'static'
}

/**
 * The 0-based body offset of the first dynamic await in a function body:
 * a request API call, an uncached fetch, or an awaited constructed promise.
 * Returns the offset used for frame positions (see frame column rules below).
 */
function directDynamicAwait(body: string): { index: number; kind: 'api' | 'promise' } | undefined {
  const api = new RegExp(`\\bawait\\s+(?:${DYNAMIC_APIS.join('|')})\\s*(\\()`).exec(body)
  const fetchCall = /\bawait\s+fetch\s*(\()/.exec(body)
  const uncachedFetch =
    fetchCall && !body.slice(fetchCall.index, fetchCall.index + 300).includes('force-cache')
      ? fetchCall
      : null
  const promise = /\bawait\s+(new\s+Promise)/.exec(body)
  const candidates = [
    ...(api ? [{ index: api.index + api[0].length - 1, kind: 'api' as const }] : []),
    ...(uncachedFetch
      ? [{ index: uncachedFetch.index + uncachedFetch[0].length - 1, kind: 'api' as const }]
      : []),
    ...(promise
      ? [{ index: promise.index + promise[0].indexOf('new'), kind: 'promise' as const }]
      : []),
  ]
  candidates.sort((a, b) => a.index - b.index)
  return candidates[0]
}

/**
 * Build the owner-stack for one violating usage. Two shapes: helper-mediated, where the frames run
 * helper -> component -> page and the codeframe anchors the helper's await site; and direct-in-component,
 * where they run component -> page and the codeframe anchors the declaration.
 */
function buildViolation(
  source: string,
  component: FunctionInfo,
  byName: Map<string, FunctionInfo>,
  page: FunctionInfo,
  usageIndex: number,
): Violation {
  const frames: Frame[] = []
  const body = source.slice(component.bodyStart, component.bodyEnd)
  const direct = directDynamicAwait(body)
  const helperCall = [...body.matchAll(/\bawait\s+([a-z][\w$]*)\s*\(/g)].find(call => {
    const helper = byName.get(call[1]!)
    return (
      helper && directDynamicAwait(source.slice(helper.bodyStart, helper.bodyEnd)) !== undefined
    )
  })
  if (helperCall && !direct) {
    const helper = byName.get(helperCall[1]!)!
    const helperBody = source.slice(helper.bodyStart, helper.bodyEnd)
    const site = directDynamicAwait(helperBody)!
    frames.push(frameAt(source, helper.bodyStart + site.index, helper.name))
    // Callsite frame: position of the callee NAME within the component body.
    const calleeIndex =
      component.bodyStart + (helperCall.index ?? 0) + helperCall[0].indexOf(helperCall[1]!)
    frames.push(frameAt(source, calleeIndex, component.name))
  } else if (direct?.kind === 'api') {
    // A direct request-API await (`(await cookies())...`) anchors the await
    // call site — Next's owner stack captures the throwing access, not the
    // enclosing declaration.
    frames.push(frameAt(source, component.bodyStart + direct.index, component.name))
  } else {
    // A direct constructed-promise/fetch await anchors the component's
    // function-name declaration (metadata-error-route shape).
    frames.push(frameAt(source, component.nameIndex, component.name))
  }
  frames.push(frameAt(source, usageIndex, page.name))
  return {
    frames,
    anchor: frames[0]!,
    wrapperDepth: componentWrapperDepth(
      source.slice(page.bodyStart, page.bodyEnd),
      usageIndex - page.bodyStart,
    ),
  }
}

/**
 * Open component elements enclosing a body offset. Host elements and <Suspense> are excluded: the host
 * chain is printed verbatim in the stack, and a Suspense boundary means the usage never reaches this path.
 */
function componentWrapperDepth(body: string, index: number): number {
  let depth = 0
  for (const tag of body.slice(0, index).matchAll(/<(\/?)([A-Z][\w$.]*)\b([^>]*)>/g)) {
    if (tag[2] === 'Suspense') continue
    if (tag[1] === '/') depth -= 1
    else if (!tag[3]!.trimEnd().endsWith('/')) depth += 1
  }
  return Math.max(0, depth)
}

function frameAt(source: string, index: number, name: string): Frame {
  const before = source.slice(0, index)
  const line = before.split('\n').length
  const col = index - before.lastIndexOf('\n')
  return { name, line, col }
}

/** Whether a body offset sits inside an open <Suspense> element. */
function insideSuspense(body: string, index: number): boolean {
  const before = body.slice(0, index)
  const opens = (before.match(/<Suspense[\s>]/g) ?? []).length
  const closes = (before.match(/<\/Suspense>/g) ?? []).length
  return opens > closes
}

function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name) && name !== 'Fallback'
}

/** All named function declarations + const arrow/function initializers. */
function collectFunctions(source: string): FunctionInfo[] {
  const out: FunctionInfo[] = []
  const patterns = [
    /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{/g,
    /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\s*)?\([^)]*\)\s*(?::[^={]+)?=>?\s*\{/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const name = match[1]!
      const matchIndex = match.index ?? 0
      const nameIndex = matchIndex + match[0].indexOf(name)
      const bodyStart = matchIndex + match[0].length
      out.push({
        name,
        declIndex: matchIndex,
        nameIndex,
        bodyStart,
        bodyEnd: bodyEndFrom(source, bodyStart),
      })
    }
  }
  return out
}

/** Index of the `}` closing the body whose content starts at `offset`. */
function bodyEndFrom(source: string, offset: number): number {
  let depth = 1
  let quote: string | undefined
  for (let cursor = offset; cursor < source.length; cursor++) {
    const current = source[cursor]!
    if (quote) {
      if (current === '\\') cursor++
      else if (current === quote) quote = undefined
      continue
    }
    if (current === '/' && source[cursor + 1] === '/') {
      const newline = source.indexOf('\n', cursor + 2)
      if (newline === -1) return source.length
      cursor = newline
      continue
    }
    if (current === '/' && source[cursor + 1] === '*') {
      const end = source.indexOf('*/', cursor + 2)
      if (end === -1) return source.length
      cursor = end + 1
      continue
    }
    if (current === '"' || current === "'" || current === '`') {
      quote = current
      continue
    }
    if (current === '{') depth++
    else if (current === '}' && --depth === 0) return cursor
  }
  return source.length
}

// --- layout chain -----------------------------------------------------------

function layoutChainSources(appPath: string, pageFile: string): string[] {
  const sources: string[] = []
  let dir = path.dirname(pageFile)
  while (dir.startsWith(appPath)) {
    for (const ext of ['tsx', 'ts', 'jsx', 'js']) {
      const candidate = path.join(dir, `layout.${ext}`)
      if (existsSync(candidate)) {
        const source = readSource(candidate)
        if (source) sources.push(source)
      }
    }
    if (dir === appPath) break
    dir = path.dirname(dir)
  }
  return sources
}

/** A layout wraps <body> inside <Suspense> (the dynamic-shell opt-in). */
function layoutWrapsBodyInSuspense(source: string): boolean {
  const suspense = source.indexOf('<Suspense')
  const body = source.indexOf('<body')
  return suspense !== -1 && body !== -1 && suspense < body
}

function readSource(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

function isDirectory(file: string): boolean {
  try {
    return statSync(file).isDirectory()
  } catch {
    return false
  }
}

function appRelativeDisplayPath(appPath: string, file: string): string {
  const relative = path.relative(appPath, file).split(path.sep).join('/')
  return `app/${relative}`
}

// --- runtime `use cache` error funnel ---------------------------------------
//
// An error thrown inside a 'use cache' scope at RUNTIME crosses Next's cache
// flight boundary before it reaches the render, so its logged stack is not the
// raw throw site: the cache-side user frames survive, followed by the flight
// client's deserialization frames, and the whole error is tagged with the
// `Cache` environment. Without `--debug-prerender` the production build ships
// minified frames and a redacted error instead. The cache-components-errors
// suite inline-snapshots both shapes (normalized by its utils.ts: any frame
// whose path contains `.next` collapses to `<next-dist-dir>`).

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
