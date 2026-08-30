import { currentParams, currentRequest, getWorkUnit } from '../../request/context'
import {
  cacheComponents,
  hangingPromise,
  isPrerendering,
  isRuntimePrefetchPrerender,
} from '../../render/ppr'
import { currentRenderCacheMeta, insideUnstableCacheProducer } from '../cache/revalidate'
import { insideUseCacheProducer, recordUseCacheRootParamRead } from '../cache/use-cache'
import { generateStaticParamsScope } from '../static-params'
import { accumulateRootVaryParam } from '../segment/vary-params'

function currentRoutePattern(): string {
  let pathname: string
  try {
    pathname = new URL(currentRequest()?.url ?? '').pathname
  } catch {
    return ''
  }
  const paramNamesByValue = new Map<string, string>()
  for (const [name, value] of Object.entries(currentParams())) {
    if (typeof value === 'string') paramNamesByValue.set(value, name)
  }
  return pathname
    .split('/')
    .map(segment => {
      try {
        const name = paramNamesByValue.get(decodeURIComponent(segment))
        return name ? `[${name}]` : segment
      } catch {
        return segment
      }
    })
    .join('/')
}

function rootParamContextError(name: string): Error | undefined {
  const unit = getWorkUnit()
  // Keep the module specifier out of a literal source string: the static
  // compat-import rewrite must not rewrite this user-facing diagnostic.
  const specifier = ['next', 'root-params'].join('/')
  const call = `\`import('${specifier}').${name}()\``
  const route = currentRoutePattern()

  const inUseCache = insideUseCacheProducer()
  const inUnstableCache = insideUnstableCacheProducer()

  if (inUseCache && inUnstableCache) {
    return Object.assign(
      new Error(
        `Route ${route} used ${call} inside \`"use cache"\` nested within \`unstable_cache\`. Root params are not available in this context.`,
      ),
      { digest: 'E1140' },
    )
  }

  if (inUseCache) {
    recordUseCacheRootParamRead(name)
    return undefined
  }

  if (inUnstableCache) {
    return Object.assign(
      new Error(
        `Route ${route} used ${call} inside \`unstable_cache\`. This is not supported. Use \`"use cache"\` instead.`,
      ),
      { digest: 'E1141' },
    )
  }

  if (!unit) return undefined

  if (unit.phase === 'action') {
    return new Error(
      `${call} was used inside a Server Action. This is not supported. ` +
        `Functions from '${specifier}' can only be called in the context of a route.`,
    )
  }

  if (unit.phase !== 'after' && unit.routeKind === 'route-handler') {
    return new Error(
      `Route ${route} used ${call} inside a Route Handler. ` +
        `Support for this API in Route Handlers is planned for a future version of Next.js.`,
    )
  }

  return undefined
}

export function rootParam<T = string | string[] | undefined>(name: string): Promise<T> {
  // Inside generateStaticParams, a root param resolves only when a PARENT
  // generateStaticParams already provided it; reading the param in the very
  // call that defines it is a build error (Next E394).
  const gsp = generateStaticParamsScope()
  if (gsp) {
    if (name in gsp.provided) return Promise.resolve(gsp.provided[name] as T)
    const route = (currentRenderCacheMeta()?.route ?? '')
      .replace(/:\.\.\.([^/*]+)\*?/g, '[...$1]')
      .replace(/:([^/*]+)\*/g, '[...$1]')
      .replace(/:([^/*]+)/g, '[$1]')
    return Promise.reject(
      new Error(
        `Route ${route} used \`import('${['next', 'root-params'].join('/')}').${name}()\` inside \`generateStaticParams\`, ` +
          `but the \`${name}\` parameter was not provided by a parent \`generateStaticParams\`. ` +
          `In \`generateStaticParams\`, root params are only available for segments nested below the segment that provides them.`,
      ),
    )
  }
  // Segment-M2: a root param read varies EVERY segment of the response (Next
  // merges the rootParams set into each segment accumulator).
  accumulateRootVaryParam(name)
  const error = rootParamContextError(name)
  if (error) return Promise.reject(error)
  // A runtime-prefetch prerender renders against the REAL sampled request, so root params are concrete
  // there (root params are always available in a static prerender, so a runtime prefetch has them too).
  // Hanging them would postpone the ROOT LAYOUT itself - the whole document, not a boundary - so the
  // render would produce no shell at all.
  if (
    !insideUseCacheProducer() &&
    cacheComponents() &&
    isPrerendering() &&
    !isRuntimePrefetchPrerender()
  ) {
    return hangingPromise<T>(`rootParam(${name})`)
  }
  const value = currentParams()[name]
  return Promise.resolve((Array.isArray(value) && value.length === 0 ? undefined : value) as T)
}

const rootParamsModule = new Proxy(
  {},
  {
    get(_target, prop: string | symbol): unknown {
      if (typeof prop !== 'string') return undefined
      if (prop === '__esModule') return true
      if (prop === 'default') return undefined
      return () => rootParam(prop)
    },
  },
) as Record<string, () => Promise<unknown>>

export default rootParamsModule
