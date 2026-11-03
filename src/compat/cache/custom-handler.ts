// ---------------------------------------------------------------------------
// Custom cache-handler loader (COMPAT).
//
// Reads the `cacheHandler` path from next.config, loads it in every supported
// module shape, instantiates the class once, and installs the instance into the
// core cache seam (src/cache/handler.ts). Runs from a build/start init hook.
//
// The config value is one of:
//   - an absolute filesystem path  (`process.cwd() + '/' + env`)
//   - a `require.resolve(...)` path (absolute)
//   - a `file://` URL              (`import.meta.resolve('./x.js')`)
// and the module exports the handler class as `module.exports`, `.default`, or
// an ESM `export default`, including modules with top-level await.
// ---------------------------------------------------------------------------

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getNextConfig } from '../next/config-loader'
import { setCacheHandler, type CacheHandler } from './handler'

type CacheHandlerCtor = new (options: { maxMemoryCacheSize?: number }) => CacheHandler

let installedFor: string | undefined
let installedCtor: CacheHandlerCtor | undefined

/**
 * Load + instantiate the configured `cacheHandler` and install it into core.
 * Idempotent per resolved path; no-op when unconfigured. Instantiation logs
 * ("initialized custom cache-handler") are what the suites assert.
 */
export async function installCustomCacheHandler(root: string): Promise<void> {
  const configured = getNextConfig().cacheHandler
  if (typeof configured !== 'string' || configured.length === 0) {
    if (installedFor !== undefined) {
      setCacheHandler(undefined)
      installedFor = undefined
      installedCtor = undefined
    }
    return
  }
  const resolved = configured.startsWith('file:') ? fileURLToPath(configured) : configured
  // `import.meta.resolve('./x.js')` in next.config resolves against the bundled
  // config location (`.pnext/config/`), not the project — fall back to the same
  // basename at the project root so the handler still loads.
  const filePath =
    existsSync(resolved) || !path.isAbsolute(resolved)
      ? resolved
      : existsSync(path.join(root, path.basename(resolved)))
        ? path.join(root, path.basename(resolved))
        : resolved
  if (installedFor === filePath) return

  const Ctor = await loadHandlerCtor(filePath, root)
  if (!Ctor) throw new TypeError(`Cache handler ${filePath} must export a handler class`)
  const instance = new Ctor({})
  setCacheHandler(instance)
  installedFor = filePath
  installedCtor = Ctor
}

export function reinstallCustomCacheHandlerForEdge(): void {
  if (installedCtor) setCacheHandler(new installedCtor({}))
}

async function loadHandlerCtor(
  filePath: string,
  root: string,
): Promise<CacheHandlerCtor | undefined> {
  const require = createRequire(pathToFileURL(`${root}/index.js`).href)
  const resolved = path.isAbsolute(filePath) ? filePath : require.resolve(filePath)
  try {
    return pickCtor(await import(pathToFileURL(resolved).href))
  } catch (error) {
    if (resolved.endsWith('.mjs') || !isNextDistMissing(error)) throw error
    return loadCommonJsCtorWithNextStubs(resolved, require)
  }
}

function loadCommonJsCtorWithNextStubs(
  filePath: string,
  rootRequire: NodeRequire,
): CacheHandlerCtor | undefined {
  const module = { exports: {} as unknown }
  const localRequire = (specifier: string): unknown => {
    if (specifier.startsWith('next/dist/')) return nextDistStubModule()
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
  return pickCtor(module.exports)
}

function isNextDistMissing(error: unknown): boolean {
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && message.includes('next/dist/')
}

/**
 * Inert stand-in for a `next/dist/*` module a classic cache handler extends.
 * The base class carries tolerant no-op cache methods so a subclass's
 * `super.get/set(...)` calls work; the Proxy serves it for both
 * `module.exports` and `.default` interop shapes.
 */
function nextDistStubModule(): unknown {
  class NextDistStub {
    get(): Promise<null> {
      return Promise.resolve(null)
    }
    set(): Promise<void> {
      return Promise.resolve()
    }
    revalidateTag(): Promise<void> {
      return Promise.resolve()
    }
    resetRequestCache(): null {
      return null
    }
  }
  return new Proxy(NextDistStub, {
    get: (target, key) =>
      key === 'default'
        ? NextDistStub
        : ((target as unknown as Record<string | symbol, unknown>)[key] ?? NextDistStub),
  })
}

function pickCtor(mod: unknown): CacheHandlerCtor | undefined {
  if (typeof mod === 'function') return mod as CacheHandlerCtor
  if (mod && typeof mod === 'object') {
    const record = mod as Record<string, unknown>
    if (typeof record.default === 'function') return record.default as CacheHandlerCtor
  }
  return undefined
}
