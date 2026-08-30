// Missing-root-params build validation (COMPAT, cacheComponents).
//
// Under cacheComponents, a ROOT param (a dynamic segment at or above a root layout) MUST be enumerated
// by generateStaticParams: the root layout / document shell is built ahead of the request, so its
// params cannot hang like an ordinary dynamic hole. A route that carries a root param with no value
// provided is a hard build error, with a distinct message for one vs several missing params.
//
// The message string embeds the leading `Error: ` because the CLI prints the thrown error's raw
// `.message`, and the Next e2e suite substring-matches it verbatim off cliOutput. Runs as a build step
// gated on cacheComponents, ordered before the prerender pass so the build aborts before any shell work.

import type { ResolvedConfig } from '../../config'
import type { RouteManifestEntry } from '../../types'
import { staticParamsFor } from '../../render/renderer'
import { PnextBuildValidationError } from '../validation/validate'
import { scanRootParams } from './root-params-scan'

/**
 * Convert a colon route pattern (`/:lang/blog/:slug`) to the bracket form Next
 * prints in build errors (`/[lang]/blog/[slug]`). A `*`/`+` suffix marks a
 * catch-all (`:slug*` -> `[...slug]`); a trailing `?` marks it optional
 * (`[[...slug]]`).
 */
function toBracketPattern(pattern: string): string {
  return pattern
    .split('/')
    .map(segment => {
      if (!segment.startsWith(':')) return segment
      let name = segment.slice(1)
      let optional = false
      let catchAll = false
      if (name.endsWith('?')) {
        optional = true
        name = name.slice(0, -1)
      }
      if (name.endsWith('*') || name.endsWith('+')) {
        catchAll = true
        name = name.slice(0, -1)
      }
      if (catchAll) return optional ? `[[...${name}]]` : `[...${name}]`
      return `[${name}]`
    })
    .join('/')
}

/** The keys generateStaticParams actually enumerated for this route. */
function providedParamKeys(allSets: Record<string, unknown>[]): Set<string> {
  const provided = new Set<string>()
  for (const set of allSets) {
    for (const [key, value] of Object.entries(set)) {
      if (value !== undefined) provided.add(key)
    }
  }
  return provided
}

/**
 * Throw PnextBuildValidationError for the first page route that carries a root
 * param with no generateStaticParams value. Root params are validated in route
 * order (route.params order), so the message lists them the way they appear in
 * the path pattern. No-op when the app defines no root params.
 */
export async function validateRootParamsProvided(
  config: ResolvedConfig,
  routes: RouteManifestEntry[],
): Promise<void> {
  const rootParams = scanRootParams(config.appPath)
  if (rootParams.size === 0) return

  const pageRoutes = routes.filter(route => route.kind === 'page' && !route.interception)

  for (const route of pageRoutes) {
    const routeRootParams = route.params.filter(name => rootParams.has(name))
    if (routeRootParams.length === 0) continue

    let provided: Set<string>
    try {
      const staticParams = await staticParamsFor(config, route)
      provided = providedParamKeys(staticParams.allSets)
    } catch {
      // A generateStaticParams that throws provides nothing — treat every root
      // param as missing rather than masking the (more relevant) config error.
      provided = new Set<string>()
    }

    const missing = routeRootParams.filter(name => !provided.has(name))
    if (missing.length === 0) continue

    const routePattern = toBracketPattern(route.route || '/')
    if (missing.length === 1) {
      throw new PnextBuildValidationError(
        `Error: A required root parameter (${missing[0]}) was not provided in ` +
          `generateStaticParams for ${routePattern}, please provide at least one value.`,
      )
    }
    throw new PnextBuildValidationError(
      `Error: Required root params (${missing.join(', ')}) were not provided in ` +
        `generateStaticParams for ${routePattern}, please provide at least one value for each.`,
    )
  }
}
