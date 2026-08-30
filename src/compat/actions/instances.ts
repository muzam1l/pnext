import { createHash } from 'node:crypto'

/**
 * Runtime registry for INLINE server actions: functions with a 'use server' body directive that cross
 * the server->client boundary as live closures - inline functions in server components, `.bind()`
 * results, and HOC-wrapped actions. These cannot be resolved to a stable module export, so pnext (which
 * has no compiler pass to hoist them) registers the live function instance at render time.
 *
 * Id scheme: `i:<routeId>:<hash>:<n>` where `hash` fingerprints the function source and `n`
 * disambiguates same-source occurrences in tree order within one render. The id is deterministic for a
 * deterministic render, so ids baked into static HTML can be re-materialized at runtime: on a registry
 * miss the server re-renders the route, which re-registers the same ids, then retries the lookup.
 *
 * DIVERGENCE from Next: Next serializes the closure's captured variables into the page (encrypted) and
 * re-hydrates them per request. pnext instead holds the live closure from the most recent render of the
 * route in this process. Captured constants behave identically; closures over per-request state see the
 * values of the most recent render rather than the exact render the user saw. Multi-process deployments
 * only work because of the re-render path.
 */

const instances = new Map<string, (...args: unknown[]) => unknown>()

/** Per-render dedup state; create one per page render and thread it through. */
export interface InstanceScope {
  routeId: string
  counts: Map<string, number>
}

export function createInstanceScope(routeId: string): InstanceScope {
  return { routeId, counts: new Map() }
}

/**
 * Register a live action function for the scope's route. Returns the wire id.
 * Calling again with the same scope position (same source hash, same
 * occurrence index) overwrites the previous render's instance.
 */
export function registerActionInstance(scope: InstanceScope, fn: unknown): string {
  const callable = fn as (...args: unknown[]) => unknown
  const hash = sourceHash(callable)
  const index = scope.counts.get(hash) ?? 0
  scope.counts.set(hash, index + 1)
  const id = `i:${scope.routeId}:${hash}:${index}`
  instances.set(id, callable)
  return id
}

/** Live instance for an id, if this process has rendered it. */
export function lookupActionInstance(id: string) {
  return instances.get(id)
}

export function isInstanceActionId(id: string) {
  return id.startsWith('i:')
}

/** Route id encoded in an instance action id, for the re-render fallback. */
export function instanceActionRouteId(id: string): string | undefined {
  if (!isInstanceActionId(id)) return undefined
  // i:<routeId>:<hash>:<n> — routeId may itself contain ':'? Route ids are
  // path-derived and never contain ':', so a simple split is safe; hash and n
  // are the last two segments.
  const parts = id.split(':')
  if (parts.length < 4) return undefined
  return parts.slice(1, -2).join(':')
}

export function clearActionInstances() {
  instances.clear()
}

/**
 * Compile-time-injected registration for MODULE-SCOPE inline actions (a `'use server'` body directive
 * on a top-level function that is not part of a module-level 'use server' file). The server compile
 * pipeline appends a tagging call after each such declaration, which registers the live function under
 * a stable id and mirrors React's registerServerReference metadata by defining `$$id` - real-world code
 * introspects and even overrides it to simulate version skew. A caller-overridden `$$id` wins as the
 * wire id, so skewed ids produce the failed-to-find flow exactly like Next.
 */
export interface TaggedActionFunction {
  (...args: unknown[]): unknown
  $$id?: string
  $$pnextAssignedId?: string
  $$pnextInlineAction?: true
}

declare global {
  var __pnextTagInlineAction: ((fn: unknown, id: string) => void) | undefined
  var __pnextMarkInlineAction: (<T>(fn: T) => T) | undefined
}

/**
 * Compile-time-injected mark for ANONYMOUS inline server actions - a function expression whose body
 * opens with `'use server'` and that is passed straight to a prop/argument. Such a function has no name
 * to hang a stable id on, and the runtime cannot recover the directive from String(fn): the loader that
 * evaluates the compiled module strips directive prologues. The mark is the only thing left that
 * separates it from a plain client handler at serialization time.
 */
globalThis.__pnextMarkInlineAction = <T>(fn: T): T => {
  if (typeof fn === 'function') (fn as TaggedActionFunction).$$pnextInlineAction = true
  return fn
}

/** True for a compile-marked anonymous inline 'use server' function. */
export function isMarkedInlineAction(fn: unknown): boolean {
  return typeof fn === 'function' && (fn as TaggedActionFunction).$$pnextInlineAction === true
}

globalThis.__pnextTagInlineAction = (fn: unknown, id: string) => {
  if (typeof fn !== 'function') return
  const tagged = fn as TaggedActionFunction
  instances.set(id, tagged)
  tagged.$$pnextAssignedId = id
  if (!('$$id' in tagged)) {
    Object.defineProperty(tagged, '$$id', { value: id, configurable: true, writable: true })
  }
}

/** Caller-overridden $$id (version-skew simulation) wins as the wire id. */
export function overriddenActionId(fn: unknown): string | undefined {
  if (typeof fn !== 'function') return undefined
  const tagged = fn as TaggedActionFunction
  if (typeof tagged.$$id === 'string' && tagged.$$id !== tagged.$$pnextAssignedId) {
    return tagged.$$id
  }
  return undefined
}

/** Stable assigned id for a compile-tagged module-scope inline action. */
export function assignedInlineActionId(fn: unknown): string | undefined {
  if (typeof fn !== 'function') return undefined
  const tagged = fn as TaggedActionFunction
  return typeof tagged.$$pnextAssignedId === 'string' ? tagged.$$pnextAssignedId : undefined
}

function sourceHash(fn: (...args: unknown[]) => unknown) {
  let source = ''
  try {
    source = String(fn)
  } catch {
    source = 'opaque'
  }
  return createHash('sha256').update(source).digest('hex').slice(0, 10)
}
