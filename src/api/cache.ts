import { currentCacheScope, type CacheNode } from '../request/cache'

export function cache<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Result {
  return (...args: Args) => {
    const scope = currentCacheScope()
    if (!scope) return fn(...args)

    let root = scope.functions.get(fn)
    if (!root) {
      root = cacheNode()
      scope.functions.set(fn, root)
    }

    const node = cacheNodeForArgs(root, args)
    const record = node.record
    if (record) {
      if (record.status === 'rejected') {
        if (record.async) {
          return Promise.resolve().then(() => {
            throw record.error
          }) as Result
        }
        throw record.error
      }
      if (record.status === 'resolved' && record.async)
        return Promise.resolve(record.value) as Result
      return record.value as Result
    }

    try {
      const value = fn(...args)
      if (isPromiseLike(value)) {
        const promise = Promise.resolve(value).then(
          result => {
            node.record = { status: 'resolved', value: result, async: true }
            return result
          },
          error => {
            node.record = { status: 'rejected', error, async: true }
            throw error
          },
        )
        node.record = { status: 'pending', value: promise }
        return promise as Result
      }

      node.record = { status: 'resolved', value, async: false }
      return value
    } catch (error) {
      node.record = { status: 'rejected', error, async: false }
      throw error
    }
  }
}

function cacheNode(): CacheNode {
  return { children: new Map() }
}

function cacheNodeForArgs(root: CacheNode, args: unknown[]) {
  let node = root
  for (const arg of args) {
    let child = node.children.get(arg)
    if (!child) {
      child = cacheNode()
      node.children.set(arg, child)
    }
    node = child
  }
  return node
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') && value !== null && 'then' in value
  )
}
