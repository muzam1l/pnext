// Pluggable CacheHandler (COMPAT - Next's classic cacheHandler config).
//
// Next's classic `cacheHandler` config points at a module exporting a class (CJS `module.exports =`,
// CJS `.default`, or ESM default) with `get(key, ctx)` / `set(key, data, ctx)` methods, backing the
// fetch data cache and the ISR page cache. pnext keeps an in-memory store of its own; when a handler is
// configured the store defers to it so the handler observes every get/set and can persist across the
// SWR window.
//
// Core owns the instance and the get/set/revalidate seams; compat loads the configured module and
// installs it via setCacheHandler, so core never imports compat.

export interface CacheHandlerEntry {
  value: unknown
  lastModified: number
  tags?: readonly string[]
}

export interface CacheHandlerGetContext {
  tags?: readonly string[]
  softTags?: readonly string[]
  kind?: string
}

export interface CacheHandlerSetContext {
  tags?: readonly string[]
  revalidate?: number | false
  kind?: string
  /** Set for fetch data-cache writes (Next's incremental-cache fetch ctx). */
  fetchCache?: boolean
  fetchUrl?: string
}

/** The subset of Next's IncrementalCacheHandler contract pnext drives. */
export interface CacheHandler {
  get(
    key: string,
    ctx?: CacheHandlerGetContext,
  ): Promise<CacheHandlerEntry | undefined | null> | CacheHandlerEntry | undefined | null
  set(key: string, data: unknown, ctx?: CacheHandlerSetContext): Promise<void> | void
  revalidateTag?(tag: string | string[]): Promise<void> | void
  resetRequestCache?(): void
}

let handler: CacheHandler | undefined

/** Install the configured handler (compat calls this from an init hook). */
export function setCacheHandler(instance: CacheHandler | undefined): void {
  handler = instance
}

export function getCacheHandler(): CacheHandler | undefined {
  return handler
}

export function hasCacheHandler(): boolean {
  return handler !== undefined
}

/** Read an entry from the configured handler, tolerating sync/async + throws. */
export async function cacheHandlerGet(
  key: string,
  ctx?: CacheHandlerGetContext,
): Promise<CacheHandlerEntry | undefined> {
  if (!handler) return undefined
  try {
    const entry = await handler.get(key, ctx)
    return entry ?? undefined
  } catch {
    return undefined
  }
}

/** Write an entry to the configured handler, tolerating sync/async + throws. */
export async function cacheHandlerSet(
  key: string,
  data: unknown,
  ctx?: CacheHandlerSetContext,
): Promise<void> {
  if (!handler) return
  try {
    await handler.set(key, data, ctx)
  } catch {
    // A handler failure must not break the response; the in-memory store is
    // authoritative for correctness, the handler is a persistence layer.
  }
}

/** Forward on-demand tag invalidation to the handler if it supports it. */
export async function cacheHandlerRevalidateTag(tag: string): Promise<void> {
  if (!handler?.revalidateTag) return
  try {
    await handler.revalidateTag(tag)
  } catch {
    // best-effort
  }
}
