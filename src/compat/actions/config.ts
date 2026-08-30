import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileHref } from '../../config'
import { DEFAULT_BODY_LIMIT_BYTES } from './endpoint'

/**
 * Server-actions options read from the app's next.config in compat mode:
 * `experimental.serverActions.bodySizeLimit` (also accepted at the top-level `serverActions` key,
 * where newer Next versions moved it). Invalid limits fail server startup with Next's exact error
 * message - the size-limit e2e suite asserts the text.
 */
export const SIZE_LIMIT_ERROR =
  'Server Actions Size Limit must be a valid number or filesize format larger than 1MB'

export interface ServerActionsConfig {
  bodySizeLimitBytes: number
}

export interface NextConfigShape {
  serverActions?: { bodySizeLimit?: unknown }
  experimental?: { serverActions?: { bodySizeLimit?: unknown } | boolean }
  rewrites?: () => unknown
  redirects?: () => unknown
  headers?: () => unknown
  poweredByHeader?: boolean
}

export async function loadServerActionsConfig(root: string): Promise<ServerActionsConfig> {
  const config = await loadResolvedNextConfig(root)
  const experimental = config?.experimental
  const limit =
    config?.serverActions?.bodySizeLimit ??
    (experimental && typeof experimental === 'object' && experimental.serverActions
      ? (experimental.serverActions as { bodySizeLimit?: unknown }).bodySizeLimit
      : undefined)
  if (limit === undefined) return { bodySizeLimitBytes: DEFAULT_BODY_LIMIT_BYTES }
  return { bodySizeLimitBytes: parseBodySizeLimit(limit) }
}

export async function loadResolvedNextConfig(root: string): Promise<NextConfigShape | undefined> {
  return (await loadNextConfigFromStore()) ?? (await loadNextConfig(root))
}

/**
 * Read the next.config already loaded by the compat config-loader. At runtime that loader has bundled
 * the app's config with esbuild and stored the fully-evaluated object, so it reflects every authoring
 * style (CJS/ESM/TS) correctly. Prefer it over re-importing next.config.js here: a bare import() of a
 * CommonJS config runs through pnext's runtime module hooks and comes back as an empty object, which
 * silently dropped the configured bodySizeLimit. Returns undefined when the store is empty so the
 * caller falls back to a direct file read.
 */
async function loadNextConfigFromStore(): Promise<NextConfigShape | undefined> {
  try {
    const { getNextConfig } = await import('../next/config-loader')
    const store: NextConfigShape = getNextConfig()
    return store && Object.keys(store).length > 0 ? store : undefined
  } catch {
    return undefined
  }
}

export async function loadNextConfig(root: string): Promise<NextConfigShape | undefined> {
  for (const name of ['next.config.js', 'next.config.mjs', 'next.config.cjs']) {
    const file = path.join(root, name)
    if (!existsSync(file)) continue
    try {
      if (name.endsWith('.js') || name.endsWith('.cjs')) {
        const requireFrom = createRequire(path.join(root, 'noop.js'))
        delete requireFrom.cache[requireFrom.resolve(file)]
        const required: unknown = requireFrom(file)
        let value =
          required && typeof required === 'object' && 'default' in required
            ? required.default
            : required
        if (typeof value === 'function') {
          value = await (value as (phase: string, ctx: { defaultConfig: object }) => unknown)(
            'phase-production-server',
            { defaultConfig: {} },
          )
        }
        return value ?? undefined
      }
      const loaded = (await import(`${pathToFileHref(file)}?v=${Date.now()}`)) as {
        default?: unknown
      }
      let value: unknown = loaded.default ?? loaded
      if (typeof value === 'function') {
        value = await (value as (phase: string, ctx: { defaultConfig: object }) => unknown)(
          'phase-production-server',
          { defaultConfig: {} },
        )
      }
      return value ?? undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Startup validation of `serverActions.bodySizeLimit`, matching Next's behavior of failing start (and
 * build) with the exact size-limit error when the configured limit is malformed - the suite asserts
 * the message on cliOutput, before any action request is made.
 *
 * Loads the app's CommonJS next.config synchronously (createRequire) so an invalid limit throws inline
 * from the init hook. ESM-only configs and configs that fail to load for any unrelated reason are
 * skipped here - the lazy per-request path still validates.
 */
export function validateServerActionsConfigSync(root: string): void {
  let config: NextConfigShape | undefined
  const requireFrom = createRequire(path.join(root, 'noop.js'))
  for (const name of ['next.config.js', 'next.config.cjs']) {
    const file = path.join(root, name)
    if (!existsSync(file)) continue
    try {
      delete requireFrom.cache[requireFrom.resolve(file)]
      let value: unknown = requireFrom(file)
      if (value && typeof value === 'object' && 'default' in value) {
        value = (value as { default?: unknown }).default
      }
      if (typeof value === 'function') {
        value = (value as (phase: string, ctx: { defaultConfig: object }) => unknown)(
          'phase-production-server',
          { defaultConfig: {} },
        )
      }
      config = value as NextConfigShape | undefined
    } catch (error) {
      // A malformed limit surfaced synchronously from require's module eval is
      // unlikely; any load failure means we can't validate here — defer.
      if (error instanceof Error && error.message === SIZE_LIMIT_ERROR) throw error
      return
    }
    break
  }
  if (!config) return
  const experimental = config.experimental
  const limit =
    config.serverActions?.bodySizeLimit ??
    (experimental && typeof experimental === 'object' && experimental.serverActions
      ? (experimental.serverActions as { bodySizeLimit?: unknown }).bodySizeLimit
      : undefined)
  if (limit === undefined) return
  parseBodySizeLimit(limit)
}

/** Parse '2mb' / '500kb' / bytes number into bytes; throw SIZE_LIMIT_ERROR. */
export function parseBodySizeLimit(value: unknown): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) throw new Error(SIZE_LIMIT_ERROR)
    return Math.floor(value)
  }
  if (typeof value === 'string') {
    const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(value.trim())
    if (!match) throw new Error(SIZE_LIMIT_ERROR)
    const amount = Number(match[1])
    if (!Number.isFinite(amount) || amount <= 0) throw new Error(SIZE_LIMIT_ERROR)
    const unit = (match[2] ?? 'b').toLowerCase()
    const factor = unit === 'gb' ? 1024 ** 3 : unit === 'mb' ? 1024 ** 2 : unit === 'kb' ? 1024 : 1
    return Math.floor(amount * factor)
  }
  throw new Error(SIZE_LIMIT_ERROR)
}
