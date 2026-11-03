import { readFileSync } from 'node:fs'
import { createRequire, SourceMap } from 'node:module'
import path from 'node:path'
import { format } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { currentRequest } from '../../request/context'
import { realNow } from '../../render/ppr'
import { getNextConfig } from '../next/config-loader'

interface ModernCacheEntry {
  value: ReadableStream<Uint8Array>
  tags: string[]
  stale: number
  timestamp: number
  expire: number
  revalidate: number
}

interface ModernCacheHandler {
  get?: (
    cacheKey: string,
    softTags: string[],
  ) => Promise<ModernCacheEntry | undefined> | ModernCacheEntry | undefined
  set?: (cacheKey: string, pendingEntry: Promise<ModernCacheEntry>) => Promise<void> | void
  refreshTags?: () => Promise<void> | void
  getExpiration?: (tags: string[]) => Promise<number> | number
  updateTags?: (tags: string[], durations?: { expire?: number }) => Promise<void> | void
}

interface ModernCacheHandlerState {
  handler?: ModernCacheHandler
  installedFor?: string
  sourceMap?: SourceMap
  installing?: Promise<undefined>
}

const MODERN_CACHE_HANDLER_STATE = Symbol.for('pnext.compat.modernCacheHandler')
const DEFAULT_HANDLER_ID = '<default>'

function state(): ModernCacheHandlerState {
  const global = globalThis as typeof globalThis & {
    [MODERN_CACHE_HANDLER_STATE]?: ModernCacheHandlerState
  }
  return (global[MODERN_CACHE_HANDLER_STATE] ??= {})
}

export function installModernCacheHandlers(root: string): Promise<void> {
  const installing = (state().installing = installHandlers(root))
  // Like Next's entry preload, a failed load is logged once; requests and cache calls then reject.
  return installing.then(
    () => {
      if (state().installing === installing) state().installing = undefined
    },
    error => console.error('Failed to preload entries:', error),
  )
}

export function pendingModernCacheInstall(): Promise<undefined> | undefined {
  return state().installing
}

async function installHandlers(root: string): Promise<undefined> {
  const configured = defaultCacheHandlerPath()
  const current = state()
  if (!configured) {
    if (current.installedFor === DEFAULT_HANDLER_ID) return
    current.handler = createDefaultExternalHandler()
    current.installedFor = DEFAULT_HANDLER_ID
    current.sourceMap = undefined
    return
  }
  const filePath = resolveHandlerPath(configured, root)
  if (current.installedFor === filePath) return
  const loaded = await loadHandler(filePath, root)
  if (!loaded) {
    current.handler = undefined
    current.installedFor = undefined
    throw new TypeError(`Cache handler ${filePath} must export a handler object`)
  }
  current.handler = loaded
  current.installedFor = filePath
  const encodedMap = /\/\/# sourceMappingURL=data:application\/json;base64,(\S+)/.exec(
    readFileSync(filePath, 'utf8'),
  )?.[1]
  current.sourceMap = encodedMap
    ? new SourceMap(
        JSON.parse(Buffer.from(encodedMap, 'base64').toString()) as ConstructorParameters<
          typeof SourceMap
        >[0],
      )
    : undefined
}

export function hasModernCacheHandler(): boolean {
  return state().handler !== undefined
}

export function hasCustomModernCacheHandler(): boolean {
  return (state().installedFor ?? DEFAULT_HANDLER_ID) !== DEFAULT_HANDLER_ID
}

export async function modernCacheRefreshTags(): Promise<void> {
  const refreshTags = state().handler?.refreshTags
  const handler = state().handler
  if (!handler || !refreshTags) return
  try {
    await withNodeConsoleFormat(() => refreshTags.call(handler))
  } catch {
    // best-effort
  }
}

export async function modernCacheGet(
  key: string,
  softTags = implicitSoftTags(),
): Promise<ModernCacheEntry | undefined> {
  const handler = state().handler
  const get = handler?.get
  if (!handler || !get) return undefined
  try {
    return await withNodeConsoleFormat(() => get.call(handler, key, softTags))
  } catch (error) {
    throw normalizeHandlerError(error, 'get')
  }
}

export async function modernCacheSet(
  key: string,
  pendingEntry: Promise<ModernCacheEntry>,
): Promise<void> {
  const handler = state().handler
  const set = handler?.set
  if (!handler || !set) return
  try {
    await withNodeConsoleFormat(() => set.call(handler, key, pendingEntry))
  } catch (error) {
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    if (!process.env.__NEXT_DEV_SERVER) console.error(normalizeHandlerError(error, 'set'))
  }
}

function normalizeHandlerError(error: unknown, method: 'get' | 'set'): unknown {
  const handlerPath = state().installedFor
  if (
    !(error instanceof Error) ||
    !error.stack ||
    !handlerPath ||
    handlerPath === DEFAULT_HANDLER_ID
  ) {
    return error
  }
  const escaped = handlerPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const frame = new RegExp(`\\s+at ${method} \\((?:file://)?${escaped}:(\\d+):(\\d+)\\)`)
  error.stack = error.stack
    .replace(frame, (_match, line: string, column: string) => {
      const entry = state().sourceMap?.findEntry(Number(line) - 1, Number(column) - 1)
      if (entry && 'originalSource' in entry && entry.originalSource) {
        let originalColumn = entry.originalColumn
        // JSC anchors a `new X()` frame on the callee; Node (what Next's logs show) anchors it on `new`.
        const text = originalSourceLine(handlerPath, entry.originalSource, entry.originalLine)
        if (text?.slice(0, originalColumn).endsWith('new ')) originalColumn -= 4
        return `\n    at Object.${method} (${path.basename(entry.originalSource)}:${entry.originalLine + 1}:${originalColumn + 1})`
      }
      return `\n    at Object.${method} (${path.basename(handlerPath)}:${line}:${Math.max(1, Number(column) - 4)})`
    })
    .replace(/\n\s+at withNodeConsoleFormat \(/, '\n    at <unknown> (')
  return error
}

function originalSourceLine(handlerPath: string, source: string, line: number): string | undefined {
  const { sources, sourcesContent } = state().sourceMap!.payload
  try {
    return (
      sourcesContent?.[sources.indexOf(source)] ??
      readFileSync(path.resolve(path.dirname(handlerPath), source), 'utf8')
    ).split('\n')[line]
  } catch {
    return undefined
  }
}

export async function modernCacheGetExpiration(
  tags = implicitSoftTags(),
): Promise<number | undefined> {
  const handler = state().handler
  const getExpiration = handler?.getExpiration
  if (!handler || !getExpiration) return undefined
  try {
    return await withNodeConsoleFormat(() => getExpiration.call(handler, tags))
  } catch {
    return undefined
  }
}

export async function modernCacheUpdateTags(
  tags: string[],
  durations?: { expire?: number },
): Promise<void> {
  const handler = state().handler
  const updateTags = handler?.updateTags
  if (!handler || !updateTags) return
  try {
    await withNodeConsoleFormat(() => updateTags.call(handler, tags, durations))
  } catch {
    // best-effort
  }
}

/**
 * Run a user cache-handler method with Node-style console formatting. Bun's
 * console.log inspects arguments with double quotes and a narrow wrap width;
 * handlers log their raw arguments and the Next e2e suites match Node's
 * single-quoted util.inspect output verbatim.
 */
async function withNodeConsoleFormat<T>(fn: () => Promise<T> | T): Promise<T> {
  const original = console.log.bind(console)
  console.log = (...args: unknown[]) => {
    original(format(...args))
  }
  try {
    return await fn()
  } finally {
    console.log = original
  }
}

export function modernCacheKey(id: string, argsJson: string): string {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const buildId = process.env.NODE_ENV === 'development' ? 'development' : 'pnext'
  // Fixed-width hex: Next's cache keys are whole-byte hex strings and the e2e
  // suites match them with `([0-9a-f]{2})+` — an odd-length (leading-zero
  // trimmed) hash would never match.
  const hash = Bun.hash.wyhash(`${id}:${argsJson}`).toString(16).padStart(16, '0')
  return JSON.stringify([hash, JSON.parse(argsJson), [buildId]])
}

export function modernCacheEntry(input: {
  value: unknown
  tags: string[]
  staleSeconds?: number
  expireSeconds?: number
  revalidateSeconds?: number
  storedAt: number
}): ModernCacheEntry {
  return {
    value: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(input.value)))
        controller.close()
      },
    }),
    tags: input.tags,
    stale: input.staleSeconds ?? 300,
    timestamp: input.storedAt,
    expire: input.expireSeconds ?? 31536000,
    revalidate: input.revalidateSeconds ?? 900,
  }
}

export function clearModernCacheHandlerForTest(): void {
  const current = state()
  current.handler = undefined
  current.installedFor = undefined
  current.sourceMap = undefined
  current.installing = undefined
}

function defaultCacheHandlerPath(): string | undefined {
  const cacheHandlers = getNextConfig().cacheHandlers
  if (!cacheHandlers || typeof cacheHandlers !== 'object' || Array.isArray(cacheHandlers))
    return undefined
  const configured = (cacheHandlers as Record<string, unknown>).default
  return typeof configured === 'string' && configured.length > 0 ? configured : undefined
}

function resolveHandlerPath(configured: string, root: string): string {
  const resolved = configured.startsWith('file:') ? fileURLToPath(configured) : configured
  const filePath = path.resolve(root, resolved)
  try {
    return createRequire(pathToFileURL(`${root}/index.js`).href).resolve(filePath)
  } catch {
    return filePath
  }
}

async function loadHandler(
  filePath: string,
  root: string,
): Promise<ModernCacheHandler | undefined> {
  try {
    return pickHandler(await import(pathToFileURL(filePath).href))
  } catch (error) {
    if (filePath.endsWith('.mjs') || !isNextDistMissing(error)) throw error
    const require = createRequire(pathToFileURL(`${root}/index.js`).href)
    return loadCommonJsHandlerWithNextStubs(filePath, require)
  }
}

function loadCommonJsHandlerWithNextStubs(
  filePath: string,
  rootRequire: NodeRequire,
): ModernCacheHandler | undefined {
  const module = { exports: {} as unknown }
  const localRequire = (specifier: string): unknown => {
    if (specifier === 'next/dist/server/lib/cache-handlers/default.external') {
      return { default: createDefaultExternalHandler() }
    }
    if (specifier.startsWith('next/dist/')) return {}
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      return rootRequire(path.resolve(path.dirname(filePath), specifier))
    }
    return rootRequire(specifier)
  }
  const source = readFileSync(filePath, 'utf8')
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const evaluate = new Function(
    'require',
    'module',
    'exports',
    '__filename',
    '__dirname',
    source,
  ) as (
    require: (specifier: string) => unknown,
    module: { exports: unknown },
    exports: unknown,
    filename: string,
    dirname: string,
  ) => void
  evaluate(localRequire, module, module.exports, filePath, path.dirname(filePath))
  return pickHandler(module.exports)
}

function isNextDistMissing(error: unknown): boolean {
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && message.includes('next/dist/')
}

function pickHandler(mod: unknown): ModernCacheHandler | undefined {
  const candidate =
    mod && typeof mod === 'object' && 'default' in mod
      ? (mod as { default?: unknown }).default
      : mod
  return candidate && typeof candidate === 'object' ? candidate : undefined
}

/** Next's `cacheMaxMemorySize` default: the default handler's byte budget. */
const DEFAULT_MAX_MEMORY_SIZE = 50 * 1024 * 1024

export function createDefaultExternalHandler(): ModernCacheHandler {
  // Map insertion order doubles as LRU order: a hit re-inserts at the back, eviction pops the front.
  const entries = new Map<string, ModernCacheEntry & { size: number }>()
  let totalSize = 0
  const pendingSets = new Map<string, Promise<void>>()
  const tagExpirations = new Map<string, number>()
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const debug = process.env.NEXT_PRIVATE_DEBUG_CACHE
    ? console.debug.bind(console, 'DefaultCacheHandler:')
    : undefined
  const remove = (cacheKey: string) => {
    totalSize -= entries.get(cacheKey)?.size ?? 0
    entries.delete(cacheKey)
  }
  return {
    async get(cacheKey) {
      const pending = pendingSets.get(cacheKey)
      if (pending) {
        debug?.('get', cacheKey, 'pending')
        await pending
      }
      const entry = entries.get(cacheKey)
      if (!entry) {
        debug?.('get', cacheKey, 'not found')
        return undefined
      }
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      const maxAge = process.env.__NEXT_DEV_SERVER ? Math.max(entry.expire, 300) : entry.revalidate
      if (realNow() >= entry.timestamp + maxAge * 1000) {
        debug?.('get', cacheKey, 'expired')
        remove(cacheKey)
        return undefined
      }
      entries.delete(cacheKey)
      entries.set(cacheKey, entry)
      const [value, saved] = entry.value.tee()
      entry.value = saved
      debug?.('get', cacheKey, 'found')
      return { ...entry, value }
    },
    async set(cacheKey, pendingEntry) {
      debug?.('set', cacheKey, 'start')
      let settle: (() => void) | undefined
      const pending = new Promise<void>(resolve => {
        settle = resolve
      })
      pendingSets.set(cacheKey, pending)
      try {
        const entry = await pendingEntry
        // eslint-disable-next-line turbo/no-undeclared-env-vars
        if (!process.env.__NEXT_DEV_SERVER && entry.expire === 0) {
          debug?.('set', cacheKey, 'skipped dynamic entry')
          return
        }
        const configured = (getNextConfig() as { cacheMaxMemorySize?: number }).cacheMaxMemorySize
        // Like Next: size 0 disables the handler, except in dev where reloads still need hits.
        const limit =
          // eslint-disable-next-line turbo/no-undeclared-env-vars
          configured === 0 && !process.env.__NEXT_DEV_SERVER
            ? 0
            : configured || DEFAULT_MAX_MEMORY_SIZE
        const [value, saved] = entry.value.tee()
        entry.value = saved
        const size = (await drainStream(value)) + cacheKey.length
        if (size > limit) {
          debug?.('set', cacheKey, 'skipped oversized entry')
          return
        }
        remove(cacheKey)
        entries.set(cacheKey, { ...entry, size })
        totalSize += size
        while (totalSize > limit) remove(entries.keys().next().value!)
        debug?.('set', cacheKey, 'done')
      } catch (error) {
        debug?.('set', cacheKey, 'failed', error)
      } finally {
        settle?.()
        pendingSets.delete(cacheKey)
      }
    },
    refreshTags() {
      return undefined
    },
    getExpiration(tags) {
      let value = 0
      for (const tag of tags) value = Math.max(value, tagExpirations.get(tag) ?? 0)
      return value
    },
    updateTags(tags) {
      const now = realNow()
      for (const tag of tags) tagExpirations.set(tag, now)
    },
  }
}

async function drainStream(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader()
  let bytes = 0
  let read
  while (!(read = await reader.read()).done) bytes += read.value.byteLength
  return bytes
}

function implicitSoftTags(): string[] {
  const pathname = new URL(currentRequest()?.url ?? 'http://pnext.local/').pathname || '/'
  const leaf = pathname === '/' ? '/index' : pathname
  return ['_N_T_/layout', '_N_T_/page', '_N_T_/', `_N_T_${leaf}`]
}
