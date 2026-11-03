// Build flags the SERVING runtime needs (COMPAT).
//
// `next build --debug-prerender` changes what a production server logs for an error that crosses the
// 'use cache' boundary (real frames + environmentName vs minified frames + a redacted error). The flag
// is a build-time input, so the build records it next to the other server artifacts and start reads it
// back.
//
// State is anchored on globalThis: the built compat-server bundle and the original module can both be
// loaded in one process, and a module-local cache would then be filled in one copy and empty in the other.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const BUILD_FLAG_GLOBALS = Symbol.for('pnext.compat.buildFlags')

export interface BuildFlags {
  debugPrerender: boolean
}

interface BuildFlagState {
  /** The serving root's output dir, recorded by the init hook. */
  outPath?: string
  /** Lazily read flags: `null` once a read found no build to serve. */
  flags?: BuildFlags | null
}

function state(): BuildFlagState {
  const root = globalThis as unknown as Record<PropertyKey, BuildFlagState | undefined>
  return (root[BUILD_FLAG_GLOBALS] ??= {})
}

function flagsFile(outPath: string): string {
  return path.join(outPath, 'server', 'pnext-build-flags.json')
}

/** Record the output dir at build/start init so the runtime can find the file. */
export function setBuildFlagsOutPath(outPath: string): void {
  const current = state()
  if (current.outPath !== outPath) {
    current.outPath = outPath
    current.flags = undefined
  }
}

/** Persist the build's `--debug-prerender` flag for the serving runtime. */
export function writeBuildFlags(outPath: string, debugPrerender: boolean): void {
  const file = flagsFile(outPath)
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ debugPrerender })}\n`)
  } catch {
    // A read-only/absent output dir only costs the runtime this hint.
  }
  const current = state()
  current.outPath = outPath
  current.flags = { debugPrerender }
}

/**
 * The flags of the build being served, or undefined when there is none to read
 * (a dev server, or a start against an output dir this process never built).
 * Callers use the absence to stay out of production-only behavior.
 */
export function servedBuildFlags(): BuildFlags | undefined {
  const current = state()
  if (current.flags !== undefined) return current.flags ?? undefined
  const outPath = current.outPath
  if (outPath === undefined) return undefined
  let flags: BuildFlags | null = null
  try {
    const file = flagsFile(outPath)
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { debugPrerender?: unknown }
      flags = { debugPrerender: parsed.debugPrerender === true }
    }
  } catch {
    flags = null
  }
  current.flags = flags
  return flags ?? undefined
}

// Centralized error factories for cached function and revalidation misuse. State the scope and constraint, explain non-obvious boundaries, give the immediate fix, then link to the relevant docs.

const NEXT_REQUEST_IN_USE_CACHE = 'https://nextjs.org/docs/messages/next-request-in-use-cache'

const UNSTABLE_CACHE_API_DOCS = 'https://nextjs.org/docs/app/api-reference/functions/unstable_cache'

const USE_CACHE_PRIVATE_COMPOSITION =
  'https://nextjs.org/docs/messages/use-cache-private-composition'

const REVALIDATE_IN_USE_CACHE = 'https://nextjs.org/docs/messages/revalidate-in-use-cache'

const NESTED_USE_CACHE_NO_EXPLICIT_CACHELIFE =
  'https://nextjs.org/docs/messages/nested-use-cache-no-explicit-cachelife'

// Request data accessed in caches

export function createCookiesInUseCacheError(route: string): Error {
  return new Error(
    `Route "${route}": \`cookies()\` can't be read inside \`"use cache"\`. Read it outside the cached function and pass what you need as an argument.\nLearn more: ${NEXT_REQUEST_IN_USE_CACHE}`,
  )
}

export function createCookiesInUnstableCacheError(route: string): Error {
  return new Error(
    `Route "${route}": \`cookies()\` can't be read inside \`unstable_cache()\`. Read it outside the cached function and pass what you need as an argument.\nLearn more: ${UNSTABLE_CACHE_API_DOCS}`,
  )
}

export function createHeadersInUseCacheError(route: string): Error {
  return new Error(
    `Route "${route}": \`headers()\` can't be read inside \`"use cache"\`. Read it outside the cached function and pass what you need as an argument.\nLearn more: ${NEXT_REQUEST_IN_USE_CACHE}`,
  )
}

export function createHeadersInUnstableCacheError(route: string): Error {
  return new Error(
    `Route "${route}": \`headers()\` can't be read inside \`unstable_cache()\`. Read it outside the cached function and pass what you need as an argument.\nLearn more: ${UNSTABLE_CACHE_API_DOCS}`,
  )
}

export function createSearchParamsInUseCacheError(route: string): Error {
  return new Error(
    `Route "${route}": \`searchParams\` can't be read inside \`"use cache"\`. Await it outside the cached function and pass what you need as an argument.\nLearn more: ${NEXT_REQUEST_IN_USE_CACHE}`,
  )
}

export function createConnectionInPublicUseCacheError(route: string): Error {
  return new Error(
    `Route "${route}": \`connection()\` can't be called inside \`"use cache"\` because cached functions may run during prerendering, without an incoming request. Call it outside the cached function.\nLearn more: ${NEXT_REQUEST_IN_USE_CACHE}`,
  )
}

export function createConnectionInUnstableCacheError(route: string): Error {
  return new Error(
    `Route "${route}": \`connection()\` can't be called inside \`unstable_cache()\` because cached functions may run during prerendering, without an incoming request. Call it outside the cached function.\nLearn more: ${UNSTABLE_CACHE_API_DOCS}`,
  )
}

// Mutations inside caches and render

// Used when `draftMode().enable()` or `.disable()` is called inside `"use cache"` or `"use cache: private"`. Reading `draftMode()` is fine inside a cached function, but toggling it is not.
export function createDraftModeMutationInUseCacheError(route: string, expression: string): Error {
  return new Error(
    `Route "${route}": \`${expression}\` can't be called inside \`"use cache"\`. Draft mode can be read inside a cached function, but enabling or disabling it must happen outside.\nLearn more: ${NEXT_REQUEST_IN_USE_CACHE}`,
  )
}

export function createRevalidateDuringRenderError(route: string, expression: string): Error {
  return new Error(
    `Route "${route}": \`${expression}\` can't be called during render. Call it from a Server Action or Route Handler instead.\nLearn more: ${REVALIDATE_IN_USE_CACHE}`,
  )
}

export function createRevalidateInCachedFunctionError(route: string, expression: string): Error {
  return new Error(
    `Route "${route}": \`${expression}\` can't be called inside a cached function. Call it from a Server Action or Route Handler instead.\nLearn more: ${REVALIDATE_IN_USE_CACHE}`,
  )
}

// Cache configuration and nesting

export function createNestedCacheZeroRevalidateError(
  route: string,
  cause: Error | undefined,
): Error {
  return new Error(
    `Route "${route}": A nested \`"use cache"\` with \`revalidate: 0\` is inside an outer \`"use cache"\` that has no \`cacheLife()\`. Add \`cacheLife()\` to the outer one to choose whether to prerender it with a non-zero \`revalidate\` or keep it dynamic with \`revalidate: 0\`.\nLearn more: ${NESTED_USE_CACHE_NO_EXPLICIT_CACHELIFE}`,
    { cause },
  )
}

export function createNestedCacheShortExpireError(route: string, cause: Error | undefined): Error {
  return new Error(
    `Route "${route}": A nested \`"use cache"\` with a short \`expire\` (under 5 minutes) is inside an outer \`"use cache"\` that has no \`cacheLife()\`. Add \`cacheLife()\` to the outer one to choose whether to prerender it with a longer \`expire\` or keep it dynamic with a short \`expire\`.\nLearn more: ${NESTED_USE_CACHE_NO_EXPLICIT_CACHELIFE}`,
    { cause },
  )
}

// Private cache composition and request context

export function createUseCachePrivateInsidePublicUseCacheError(route: string): Error {
  return new Error(
    `Route "${route}": \`"use cache: private"\` can't be nested inside \`"use cache"\` because a shared cached function can't depend on private request data. Nest it only inside another \`"use cache: private"\`.\nLearn more: ${USE_CACHE_PRIVATE_COMPOSITION}`,
  )
}

export function createUseCachePrivateInsideUnstableCacheError(route: string): Error {
  return new Error(
    `Route "${route}": \`"use cache: private"\` can't be used inside \`unstable_cache()\` because \`unstable_cache()\` uses a shared cache that can't contain private request data. Call the private cached function outside \`unstable_cache()\`.\nLearn more: ${USE_CACHE_PRIVATE_COMPOSITION}`,
  )
}

export function createUseCachePrivateOutsideRequestContextError(
  route: string,
  functionName: string,
): Error {
  const error = new Error(
    `Route "${route}": \`"use cache: private"\` needs an active request, so it can't be used during \`${functionName}\` or other build-time contexts. Move it to a request-time component or function.\nLearn more: ${USE_CACHE_PRIVATE_COMPOSITION}`,
  )
  error.name = 'PnextBuildValidationError'
  return error
}
