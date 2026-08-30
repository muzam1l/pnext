import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
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
}

const MODERN_CACHE_HANDLER_STATE = Symbol.for('pnext.compat.modernCacheHandler')

function state(): ModernCacheHandlerState {
  const global = globalThis as typeof globalThis & {
    [MODERN_CACHE_HANDLER_STATE]?: ModernCacheHandlerState
  }
  return (global[MODERN_CACHE_HANDLER_STATE] ??= {})
}

export function installModernCacheHandlers(root: string): void {
  const configured = defaultCacheHandlerPath()
  const current = state()
  if (!configured) {
    current.handler = undefined
    current.installedFor = undefined
    return
  }
  const filePath = resolveHandlerPath(configured, root)
  if (current.installedFor === filePath) return
  const loaded = loadHandler(filePath, root)
  if (!loaded) return
  current.handler = loaded
  current.installedFor = filePath
}

export function hasModernCacheHandler(): boolean {
  return state().handler !== undefined
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
  } catch {
    return undefined
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
  } catch {
    // best-effort
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
  return JSON.stringify([buildId, hash, JSON.parse(argsJson)])
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
  if (path.isAbsolute(resolved)) return resolved
  return path.resolve(root, resolved)
}

function loadHandler(filePath: string, root: string): ModernCacheHandler | undefined {
  if (!existsSync(filePath)) return undefined
  try {
    const require = createRequire(pathToFileURL(`${root}/index.js`).href)
    try {
      return pickHandler(require(filePath))
    } catch (error) {
      if (!isNextDistMissing(error)) return undefined
      return loadCommonJsHandlerWithNextStubs(filePath, require)
    }
  } catch {
    return undefined
  }
}

function loadCommonJsHandlerWithNextStubs(
  filePath: string,
  rootRequire: NodeRequire,
): ModernCacheHandler | undefined {
  try {
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
  } catch {
    return undefined
  }
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

function createDefaultExternalHandler(): ModernCacheHandler {
  const entries = new Map<string, ModernCacheEntry>()
  const tagExpirations = new Map<string, number>()
  return {
    get(cacheKey) {
      return entries.get(cacheKey)
    },
    async set(cacheKey, pendingEntry) {
      entries.set(cacheKey, await pendingEntry)
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

function implicitSoftTags(): string[] {
  const pathname = new URL(currentRequest()?.url ?? 'http://pnext.local/').pathname || '/'
  const leaf = pathname === '/' ? '/index' : pathname
  return ['_N_T_/layout', '_N_T_/page', '_N_T_/', `_N_T_${leaf}`]
}
