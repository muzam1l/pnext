// Next 15's transitional sync request APIs, behind compat.next.legacyRequestAPIs. cookies()/headers()/
// draftMode() still return a Promise, but that promise also carries the resolved value's surface, so
// Next-14-era code (`cookies().get('x')`) keeps working while it migrates to `await`. `params` and
// `searchParams` get the same treatment (`params.creator` without `await`). Each sync access logs
// Next's sync-dynamic-apis deprecation warning, deduped by userland callsite.
//
// Nothing here is reachable — or even allocated — when the option is off.

import { legacyRequestAPIs } from '../../request/context'
import { currentRenderCacheMeta } from '../cache/revalidate'

const PROMISE_PROPS = new Set<PropertyKey>(['then', 'catch', 'finally', 'constructor'])
const warned = new Set<string>()

/**
 * Wrap a request-API promise so unawaited property reads hit the produced value. The value is produced
 * lazily (and once), so a promise nobody touches synchronously costs a single Proxy.
 */
export function withSyncAccess<T extends object>(
  promise: Promise<T>,
  api: 'cookies' | 'headers' | 'draftMode',
  produce: () => T,
): Promise<T> {
  let value: T | undefined
  const resolve = () => (value ??= produce())
  return new Proxy(promise, {
    get(target, prop) {
      if (PROMISE_PROPS.has(prop) || prop === Symbol.toStringTag) {
        const own: unknown = Reflect.get(target, prop, target)
        return typeof own === 'function'
          ? (own as (...args: unknown[]) => unknown).bind(target)
          : own
      }
      warnSyncApiAccess(api, prop)
      const source = resolve() as object
      const read: unknown = Reflect.get(source, prop, source)
      return typeof read === 'function'
        ? (read as (...args: unknown[]) => unknown).bind(source)
        : read
    },
  })
}

/**
 * Give a settled `params`/`searchParams` promise the resolved object's own keys, so Next-14 code
 * (`function Layout({ params }) { params.creator }`) reads them without `await`. Keys the promise
 * already answers for (then/catch/status/value/constructor/...) stay the promise's — Next skips them
 * too — and the promise itself is returned, never a copy or a Proxy: callers hand it to `use()`.
 */
export function withSyncProps<T extends object>(
  promise: Promise<T>,
  kind: 'params' | 'searchParams',
  value: T,
): Promise<T> {
  if (!legacyRequestAPIs()) return promise
  for (const key of Object.keys(value)) {
    if (key in promise) continue
    void Object.defineProperty(promise, key, {
      get() {
        warnSyncPropAccess(kind, key)
        return (value as Record<string, unknown>)[key]
      },
      enumerable: true,
      configurable: true,
    })
  }
  return promise
}

function warnSyncApiAccess(api: string, prop: PropertyKey): void {
  const expression =
    prop === Symbol.iterator
      ? `\`...${api}()\` or similar iteration`
      : `\`${api}().${String(prop)}\``
  warnSyncAccess(expression, `${api}()`, 'value')
}

function warnSyncPropAccess(kind: string, key: string): void {
  warnSyncAccess(`\`${kind}.${key}\``, kind, 'properties')
}

function warnSyncAccess(expression: string, subject: string, noun: 'value' | 'properties'): void {
  const route = currentRenderCacheMeta()?.route
  const key = `${route ?? ''}|${expression}|${callsite()}`
  if (warned.has(key)) return
  warned.add(key)
  console.warn(
    `${route ? `Route "${route}" ` : 'This route '}used ${expression}. ` +
      `\`${subject}\` should be awaited before using its ${noun}. ` +
      'Learn more: https://nextjs.org/docs/messages/sync-dynamic-apis',
  )
}

/** First stack frame outside this module — the userland call site Next dedupes on. */
function callsite(): string {
  const frames = new Error().stack?.split('\n').slice(1) ?? []
  return frames.find(frame => !frame.includes('legacy-request-apis')) ?? ''
}
