// Preact-core interop: a component that throws a bare non-object value (undefined/null/a string/a
// number) crashes BEFORE any error boundary - or even `options._catchError` - ever sees it.
//
// Preact's diff.js catches the thrown value in a local try/catch and immediately does `if (e.then)` to
// detect a suspending thenable. When `e` is null/undefined, `e.then` itself throws a TypeError, which
// escapes diff() entirely - no boundary, no options hook. This is a genuine Preact-core limitation, not
// fixable from an options hook alone, because the crash happens inside preact's own catch block ahead
// of `options._catchError`.
//
// Fix: intercept the primitive throw ONE LEVEL BELOW preact's diff try/catch, at the component-function
// call site (wrapped via the `options.vnode` hook), and re-throw a tagged Error instead. A tagged Error
// has no `.then`, so preact proceeds normally into `options._catchError` and the normal boundary walk
// runs. Boundaries unwrap the tag to recover the original raw value before handing it to the error UI.

const RAW_VALUE = Symbol('pnext.primitiveThrowValue')

export interface TaggedPrimitiveThrow extends Error {
  [RAW_VALUE]: unknown
}

export function tagPrimitiveThrow(value: unknown): TaggedPrimitiveThrow {
  const message = typeof value === 'string' ? value : String(value)
  const error = new Error(message) as TaggedPrimitiveThrow
  error[RAW_VALUE] = value
  return error
}

export function isTaggedPrimitiveThrow(error: unknown): error is TaggedPrimitiveThrow {
  return error instanceof Error && RAW_VALUE in error
}

/** Unwrap a tagged primitive-throw Error back to the raw value; pass through anything else. */
export function untagPrimitiveThrow(error: unknown): unknown {
  return isTaggedPrimitiveThrow(error) ? error[RAW_VALUE] : error
}

/**
 * What a boundary hands its error UI: the raw value behind a tagged primitive
 * throw, with a message-shaped fallback for a crash that slipped through untagged.
 * Lives here rather than in a boundary so both boundary tiers share it without
 * the bare one pulling in the full cluster.
 */
export function normalizeBoundaryError(error: unknown): unknown {
  const untagged = untagPrimitiveThrow(error)
  if (untagged !== error) return untagged
  if (error instanceof Error) {
    if (error.message === "Cannot read properties of undefined (reading 'then')") return undefined
    if (error.message === "Cannot read properties of null (reading 'then')") return null
  }
  return error
}

/**
 * A value preact's diff.js catch block would crash on when narrowing for a suspending thenable
 * (`e.then`): null and undefined - the only two JS values where the property access itself throws.
 */
function crashesPreactThenCheck(value: unknown): boolean {
  return value === null || value === undefined
}

/**
 * Wrap a function/class component so a thrown value that would crash preact's own `e.then` suspense
 * check is re-thrown as a tagged Error instead. Safe to call repeatedly on the same component type -
 * the wrapper is cached.
 */
const wrapped = new WeakMap<object, unknown>()

// Marks a value this function already produced, so re-wrapping is a no-op. REQUIRED for idempotency
// across preact's own vnode clone-and-re-render path: a component that re-renders IN PLACE
// shallow-clones its existing vnode and fires `options.vnode` again on that clone - whose `.type` is
// already OUR wrapper from the previous pass. Without this marker the cache (keyed by the ORIGINAL
// function) misses and we wrap the wrapper again into a brand-new function object. That second wrapper
// becomes the vnode's stored type going forward, while any LATER vnode preact creates fresh for the
// same component position resolves back to the first, singly-wrapped value. Two different function
// references at the same tree position make preact treat it as a different component type - a full
// unmount and remount of that subtree instead of an update.
const ALREADY_WRAPPED = Symbol('pnext.primitiveThrowWrapped')

function copyMetadata(from: object, to: object): void {
  for (const key of Object.getOwnPropertyNames(from)) {
    if (key === 'length' || key === 'name' || key === 'prototype') continue
    const descriptor = Object.getOwnPropertyDescriptor(from, key)
    if (descriptor) Object.defineProperty(to, key, descriptor)
  }
  for (const symbol of Object.getOwnPropertySymbols(from)) {
    const descriptor = Object.getOwnPropertyDescriptor(from, symbol)
    if (descriptor) Object.defineProperty(to, symbol, descriptor)
  }
}

export function wrapComponentForPrimitiveThrows<T extends object>(type: T): T {
  if ((type as { [ALREADY_WRAPPED]?: true })[ALREADY_WRAPPED]) return type
  const cached = wrapped.get(type)
  if (cached) return cached as T
  if (typeof type !== 'function') return type

  const isClassComponent = Boolean((type as { prototype?: { render?: unknown } }).prototype?.render)
  let result: unknown

  if (isClassComponent) {
    // Class components: preact does `new Type(props, context)` then calls
    // `.render()`. Subclass so `render()` is wrapped; static lifecycle methods
    // (getDerivedStateFromError, etc.) and everything else pass through
    // untouched via normal prototype-chain inheritance.
    const Base = type as unknown as new (...args: unknown[]) => {
      render(...args: unknown[]): unknown
    }
    class PrimitiveThrowSafe extends Base {
      render(...args: unknown[]) {
        try {
          return super.render(...args)
        } catch (e) {
          if (crashesPreactThenCheck(e)) throw tagPrimitiveThrow(e)
          throw e
        }
      }
    }
    Object.defineProperty(PrimitiveThrowSafe, 'name', { value: Base.name })
    // Copy static properties AND symbol-keyed metadata (displayName, getDerivedStateFromError,
    // contextType, defaultProps, plus the framework's own client-reference/dynamic-reference/params-
    // scope symbol markers stashed directly on component function objects). resolveServerTree branches
    // on those, so losing them mis-routes a client-reference class through the server-component call
    // path instead of the island path.
    copyMetadata(Base, PrimitiveThrowSafe)
    result = PrimitiveThrowSafe
  } else {
    const fn = type as unknown as (...args: unknown[]) => unknown
    const wrappedFn = function pnextPrimitiveThrowSafe(this: unknown, ...args: unknown[]) {
      try {
        return fn.apply(this, args)
      } catch (e) {
        if (crashesPreactThenCheck(e)) throw tagPrimitiveThrow(e)
        throw e
      }
    }
    Object.defineProperty(wrappedFn, 'name', { value: fn.name })
    copyMetadata(fn, wrappedFn)
    result = wrappedFn
  }

  Object.defineProperty(result as object, ALREADY_WRAPPED, { value: true })
  wrapped.set(type, result)
  return result as T
}
