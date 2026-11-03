import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { ResolvedConfig } from '../../config'
import { productionRelease } from '../../runtime/production'
import { reinstallCustomCacheHandlerForEdge } from '../cache/custom-handler'
import { findInstrumentation } from '../lifecycle/instrumentation'
import { getOtelApi } from '../otel/api'

type GlobalDescriptor = PropertyDescriptor | undefined

export function withEdgeRuntime<T>(callback: () => T): T {
  const globalObject = globalThis as typeof globalThis & {
    EdgeRuntime?: string
    process?: NodeJS.Process
  }
  const previousEdgeRuntime = Object.getOwnPropertyDescriptor(globalObject, 'EdgeRuntime')
  const previousProcess = Object.getOwnPropertyDescriptor(globalObject, 'process')

  Object.defineProperty(globalObject, 'EdgeRuntime', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: 'edge-runtime',
  })
  Object.defineProperty(globalObject, 'process', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: edgeProcess(globalObject.process) ?? { env: {} },
  })

  try {
    reinstallCustomCacheHandlerForEdge()
    const result = callback()
    if (isThenable(result)) {
      return Promise.resolve(result).finally(() =>
        restore(previousEdgeRuntime, previousProcess),
      ) as T
    }
    restore(previousEdgeRuntime, previousProcess)
    return result
  } catch (error) {
    restore(previousEdgeRuntime, previousProcess)
    throw error
  }
}

/** Next's Edge runtime exposes a minimal `process`: no `emit`, and no Node `version`/`versions`. */
export function edgeProcess(current: NodeJS.Process | undefined, env?: NodeJS.ProcessEnv) {
  if (!current) return undefined
  return new Proxy(current, {
    get(target, property, receiver) {
      if (property === 'emit' || property === 'version' || property === 'versions') return undefined
      if (property === 'env' && env) return env
      const value: unknown = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value
    },
  })
}

function restore(edgeRuntime: GlobalDescriptor, process: GlobalDescriptor): void {
  restoreProperty('EdgeRuntime', edgeRuntime)
  restoreProperty('process', process)
}

function restoreProperty(name: 'EdgeRuntime' | 'process', descriptor: GlobalDescriptor): void {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor)
  } else {
    delete (globalThis as Record<string, unknown>)[name]
  }
}

function isThenable<T>(value: T): value is T & PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function'
}

/** Whether `file` is edge middleware run in its own realm (Next's sandbox): only OTel needs its separate registry. */
export function isSandboxedMiddleware(config: ResolvedConfig, file: string): boolean {
  const release = productionRelease(config)
  if (release) return release.compat?.edgeSandbox !== undefined
  if (
    path.basename(file).startsWith('proxy.') ||
    !getOtelApi(config.root) ||
    !findInstrumentation(config)
  )
    return false
  try {
    // Lazy: the parser stays out of a production server's graph.
    const { staticProxyConfig } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../../routing/proxy-config') as typeof import('../../routing/proxy-config')
    const literal = staticProxyConfig(file, readFileSync(file, 'utf8')) as
      { runtime?: unknown } | undefined
    return literal?.runtime !== 'nodejs'
  } catch {
    return true
  }
}
