import {
  currentRequest,
  currentResponseHeaders,
  getWorkUnit,
  legacyRequestAPIs,
  requireRequest,
  requestApiPromise as coreRequestApiPromise,
} from '../../request/context'
import { currentPrerenderScope, isHangingPromise, RUNTIME_SESSION } from '../../render/ppr'
import { withSyncAccess } from './legacy-request-apis'
import type { NextRequestCookies } from '../../types'
import {
  assertDraftModeToggleAllowedInAfter,
  assertRequestApiAllowedInAfter,
  lifecycleError,
} from '../lifecycle/after-scope'
import {
  assertNoDynamicApiInsideCache,
  currentRenderCacheMeta,
  recordDynamicUsage,
} from '../cache/revalidate'
import { assertNavigationPrerenderAccess } from '../cache/build-prerender-errors'

const COOKIE_MUTATION_ERROR =
  'Cookies can only be modified in a Server Action or Route Handler. ' +
  'Read more: https://nextjs.org/docs/app/api-reference/functions/cookies#options'

function requestApiPromise<T>(api: string, produce: () => T): Promise<T> {
  const promise = coreRequestApiPromise(api, produce, RUNTIME_SESSION)
  if (!isHangingPromise(promise)) return promise
  // Next's tracked session-data promises follow the underlying rejection in a second microtask.
  let delayed: Promise<T> | undefined
  const observe = () =>
    (delayed ??= new Promise<T>((_resolve, reject) => {
      void promise.catch(reject)
    }))
  return new Proxy(promise, {
    get(target, property) {
      if (property === 'then') {
        return (...args: Parameters<typeof target.then>) => {
          // A bare `.then(fn)` derives a promise; only consuming that one postpones.
          if (typeof args[0] === 'function' && typeof args[1] !== 'function')
            return target.then(...args)
          const shared = observe()
          if (typeof args[0] === 'function')
            void target.then(
              () => undefined,
              () => undefined,
            )
          return shared.then(...args)
        }
      }
      if (property === 'catch') {
        return (...args: Parameters<typeof target.catch>) => observe().catch(...args)
      }
      if (property === 'finally') {
        return (...args: Parameters<typeof target.finally>) => observe().finally(...args)
      }
      return Reflect.get(target, property, target) as unknown
    },
  })
}

/**
 * Cookie writes are only legal while the request is executing a Server Action or a Route Handler. Every
 * other phase - a page render, an after() callback, or middleware - throws Next's exact message. The
 * check reads the LIVE work-unit phase at call time, so a cookie store captured during an action still
 * throws when its .set() runs later inside after(), where the phase has flipped.
 *
 * Core does not set a dedicated 'handler' phase, so a route handler is detected via its routeKind
 * instead; an action sets phase 'action' explicitly. Outside any work unit mutation is left alone.
 */
function assertCookieMutationAllowed(): void {
  const unit = getWorkUnit()
  if (!unit) return
  if (unit.phase === 'action') return
  if (unit.phase !== 'after' && unit.routeKind === 'route-handler') return
  throw new Error(COOKIE_MUTATION_ERROR)
}

const HEADERS_MUTATION_ERROR =
  'Headers cannot be modified. Read more: https://nextjs.org/docs/app/api-reference/functions/headers'

const HIDDEN_REQUEST_HEADERS = new Set([
  'rsc',
  'next-router-state-tree',
  'next-router-prefetch',
  'next-hmr-refresh',
  'next-router-segment-prefetch',
  'x-nextjs-request-id',
  'x-nextjs-html-request-id',
])
const readonlyHeaderViews = new WeakMap<object, Headers>()

/**
 * headers() exposes the REQUEST headers, which Next makes read-only: append(), set() and delete() throw
 * instead of mutating. The cached view stays live while hiding framework-only headers.
 */
function readonlyHeaders(source: Headers): Headers {
  // One view per render pass, so identity-keyed memos never cross a prerender into the dynamic render.
  const pass = currentPrerenderScope() ?? source
  const cached = readonlyHeaderViews.get(pass)
  if (cached) return cached

  const visibleEntries = function* () {
    for (const entry of source.entries()) {
      if (!HIDDEN_REQUEST_HEADERS.has(entry[0].toLowerCase())) yield entry
    }
  }
  let view: Headers
  view = new Proxy(source, {
    get(target, prop, _receiver) {
      if (prop === 'append' || prop === 'set' || prop === 'delete') {
        return () => {
          throw new Error(HEADERS_MUTATION_ERROR)
        }
      }
      if (prop === 'get') {
        return (name: string) =>
          HIDDEN_REQUEST_HEADERS.has(name.toLowerCase()) ? null : target.get(name)
      }
      if (prop === 'has') {
        return (name: string) => !HIDDEN_REQUEST_HEADERS.has(name.toLowerCase()) && target.has(name)
      }
      if (prop === 'getSetCookie') return () => []
      if (prop === 'entries' || prop === Symbol.iterator) return visibleEntries
      if (prop === 'keys')
        return function* () {
          for (const [name] of visibleEntries()) yield name
        }
      if (prop === 'values')
        return function* () {
          for (const [, value] of visibleEntries()) yield value
        }
      if (prop === 'forEach') {
        return (
          callback: (value: string, name: string, parent: Headers) => void,
          thisArg?: unknown,
        ) => {
          for (const [name, value] of visibleEntries()) callback.call(thisArg, value, name, view)
        }
      }
      const value: unknown = Reflect.get(target, prop, target)
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value
    },
  })
  readonlyHeaderViews.set(pass, view)
  return view
}

export function headers() {
  assertRequestApiAllowedInAfter('headers()')
  assertDynamicErrorRequestApi('headers()')
  assertNoDynamicApiInsideCache('headers()')
  const produce = () => readonlyHeaders(requireRequest('headers()').headers)
  const promise = requestApiPromise('headers()', produce)
  return legacyRequestAPIs() ? withSyncAccess(promise, 'headers', produce) : promise
}

export interface CookieSetOptions {
  name?: string
  value?: string
  path?: string
  maxAge?: number
  expires?: Date | number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'strict' | 'lax' | 'none' | boolean
  domain?: string
}

/**
 * Next's cookies(): reads come from the request jar; writes (allowed in Server
 * Actions and Route Handlers) update the jar for subsequent reads in the same
 * request AND append a set-cookie onto the response-headers channel so the
 * browser persists them. Supports both set(name, value, options) and
 * set({ name, value, ...options }).
 */
export function cookies() {
  assertRequestApiAllowedInAfter('cookies()')
  assertDynamicErrorRequestApi('cookies()')
  assertNoDynamicApiInsideCache('cookies()')
  const produce = () => wrapCookieJar(requireRequest('cookies()').cookies)
  const promise = requestApiPromise('cookies()', produce)
  return legacyRequestAPIs() ? withSyncAccess(promise, 'cookies', produce) : promise
}

export function assertDynamicErrorRequestApi(
  api: 'headers()' | 'cookies()' | 'connection()',
): void {
  const meta = currentRenderCacheMeta()
  if (meta?.prerender) assertNavigationPrerenderAccess(meta.route ?? '/', api)
  recordDynamicUsage(meta, api.slice(0, -2))
  if (!meta?.dynamicError) return
  throw lifecycleError(
    `Route ${meta.route ?? ''} with \`dynamic = "error"\` couldn't be rendered statically because it used \`${api}\`.`,
  )
}

function wrapCookieJar(jar: NextRequestCookies) {
  return {
    get: (name: CookieNameArg) => jar.get(cookieName(name)),
    getAll: (name?: CookieNameArg) =>
      name === undefined ? jar.getAll() : jar.getAll(cookieName(name)),
    has: (name: CookieNameArg) => jar.has(cookieName(name)),
    get size() {
      return jar.getAll().length
    },
    [Symbol.iterator]() {
      return jar
        .getAll()
        .map(cookie => [cookie.name, cookie] as const)
        [Symbol.iterator]()
    },
    set(nameOrOptions: string | CookieSetOptions, value?: unknown, options?: CookieSetOptions) {
      assertCookieMutationAllowed()
      const parsed = normalizeSetArgs(nameOrOptions, value, options)
      jar.set(parsed.name, parsed.value)
      currentResponseHeaders()?.append('set-cookie', serializeSetCookie(parsed))
      return this
    },
    delete(name: CookieNameArg) {
      assertCookieMutationAllowed()
      const resolved = cookieName(name)
      const existed = jar.delete(resolved)
      currentResponseHeaders()?.append(
        'set-cookie',
        serializeSetCookie({ name: resolved, value: '', path: '/', maxAge: 0 }),
      )
      return existed
    },
    clear() {
      for (const cookie of jar.getAll()) this.delete(cookie.name)
      return this
    },
    toString() {
      return jar
        .getAll()
        .map(cookie => `${cookie.name}=${encodeURIComponent(cookie.value)}`)
        .join('; ')
    },
  }
}

interface NormalizedCookie extends CookieSetOptions {
  name: string
  value: string
}

/**
 * Next's RequestCookies accessors take a name OR a cookie-shaped object, so
 * `cookies().get({ name: 'x', value: undefined })` reads the same entry as `cookies().get('x')`.
 */
type CookieNameArg = string | { name?: string }

function cookieName(arg: CookieNameArg): string {
  if (typeof arg === 'string') return arg
  return typeof arg?.name === 'string' ? arg.name : ''
}

function normalizeSetArgs(
  nameOrOptions: string | CookieSetOptions,
  value?: unknown,
  options?: CookieSetOptions,
): NormalizedCookie {
  if (typeof nameOrOptions === 'string') {
    return { ...(options ?? {}), name: nameOrOptions, value: stringifyCookieValue(value) }
  }
  return {
    ...nameOrOptions,
    name: String(nameOrOptions.name ?? ''),
    value: String(nameOrOptions.value ?? ''),
  }
}

function stringifyCookieValue(raw: unknown): string {
  if (raw === undefined || raw === null) return ''
  if (typeof raw === 'string') return raw
  if (typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'bigint') {
    return String(raw)
  }
  return JSON.stringify(raw) ?? ''
}

function serializeSetCookie(cookie: NormalizedCookie): string {
  const parts = [`${cookie.name}=${encodeURIComponent(cookie.value)}`]
  parts.push(`Path=${cookie.path ?? '/'}`)
  if (cookie.maxAge !== undefined) parts.push(`Max-Age=${cookie.maxAge}`)
  if (cookie.expires !== undefined) {
    const date = cookie.expires instanceof Date ? cookie.expires : new Date(cookie.expires)
    parts.push(`Expires=${date.toUTCString()}`)
  }
  if (cookie.domain) parts.push(`Domain=${cookie.domain}`)
  if (cookie.httpOnly) parts.push('HttpOnly')
  if (cookie.secure) parts.push('Secure')
  if (cookie.sameSite) {
    const value = cookie.sameSite === true ? 'Strict' : capitalize(cookie.sameSite)
    parts.push(`SameSite=${value}`)
  }
  return parts.join('; ')
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

const draftCookieName = '__prerender_bypass'

export interface DraftMode {
  readonly isEnabled: boolean
  enable(): void
  disable(): void
}

export function draftMode(): Promise<DraftMode> {
  // Unlike cookies()/headers(), draftMode() never opts a page into dynamic
  // rendering: during build/partial prerender there is no (real) request and
  // draft is simply off, so reading isEnabled must not postpone or throw.
  const request = currentRequest()
  const requestCookies = request?.cookies
  const draft: DraftMode = {
    get isEnabled() {
      return requestCookies?.has(draftCookieName) ?? false
    },
    enable() {
      assertDraftModeToggleAllowedInAfter('enable')
      const cookies = requireRequest('draftMode().enable()').cookies
      const value = cookies.get(draftCookieName)?.value || bypassToken()
      cookies.set(draftCookieName, value)
      currentResponseHeaders()?.append(
        'set-cookie',
        `${draftCookieName}=${value}; Path=/; HttpOnly; SameSite=None; Secure`,
      )
    },
    disable() {
      assertDraftModeToggleAllowedInAfter('disable')
      requireRequest('draftMode().disable()').cookies.delete(draftCookieName)
      currentResponseHeaders()?.append(
        'set-cookie',
        `${draftCookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=None; Secure`,
      )
    },
  }
  const promise = Promise.resolve(draft)
  return legacyRequestAPIs() ? withSyncAccess(promise, 'draftMode', () => draft) : promise
}

function bypassToken() {
  return globalThis.crypto?.randomUUID?.().replace(/-/g, '') ?? Math.random().toString(36).slice(2)
}
