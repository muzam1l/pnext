/**
 * Client-bundle variant of next/cache. These APIs are server-only in Next;
 * client references exist mostly so modules shared with server code parse.
 * Revalidation calls throw (as in Next), unstable_cache degrades to a
 * pass-through, and the 'use cache' companions are no-ops.
 */

function serverOnly(name: string): never {
  throw new Error(`${name} can only be called from a Server Component or server function.`)
}

export function revalidatePath(_path: string, _type?: 'page' | 'layout') {
  serverOnly('revalidatePath')
}

export function revalidateTag(_tag: string) {
  serverOnly('revalidateTag')
}

export const unstable_expirePath = revalidatePath
export const unstable_expireTag = revalidateTag
export const expirePath = revalidatePath
export const expireTag = revalidateTag
export const updateTag = revalidateTag

export function refresh() {
  serverOnly('refresh')
}
export const unstable_refresh = refresh

export interface UnstableCacheOptions {
  revalidate?: number | false
  tags?: string[]
}

export function unstable_cache<Args extends unknown[], Result>(
  fn: (...args: Args) => Promise<Result>,
  _keyParts?: string[],
  _options: UnstableCacheOptions = {},
): (...args: Args) => Promise<Result> {
  return fn
}

export function unstable_noStore() {
  return undefined
}
export function io(): Promise<void> {
  return Promise.resolve()
}
export function cacheTag(..._tags: string[]) {
  return undefined
}
export function cacheLife(_profile: string | Record<string, unknown>) {
  return undefined
}
export const unstable_cacheTag = cacheTag
export const unstable_cacheLife = cacheLife
