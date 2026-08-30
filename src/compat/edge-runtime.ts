import { reinstallCustomCacheHandlerForEdge } from './cache/custom-handler'

type GlobalDescriptor = PropertyDescriptor | undefined

export function withEdgeRuntime<T>(callback: () => T): T {
  const globalObject = globalThis as typeof globalThis & {
    EdgeRuntime?: string
    process?: NodeJS.Process
  }
  const previousEdgeRuntime = Object.getOwnPropertyDescriptor(globalObject, 'EdgeRuntime')
  const previousProcess = Object.getOwnPropertyDescriptor(globalObject, 'process')
  const currentProcess = globalObject.process as NodeJS.Process | undefined
  const edgeProcess = currentProcess
    ? new Proxy(currentProcess, {
        get(target, property, receiver) {
          if (property === 'emit') return undefined
          // Next's Edge runtime exposes only a minimal `process` polyfill —
          // notably no Node `version`/`versions`. Code that branches on
          // `process.version` (to detect Node vs Edge) must see it absent.
          if (property === 'version' || property === 'versions') return undefined
          const value: unknown = Reflect.get(target, property, receiver)
          return typeof value === 'function' ? (value as () => unknown).bind(target) : value
        },
      })
    : undefined

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
    value: edgeProcess ?? { env: {} },
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
