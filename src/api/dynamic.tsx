/** @jsxImportSource preact */
import { h, type ComponentType } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'

export type DynamicModule<Props> = ComponentType<Props> | { default: ComponentType<Props> }
export type DynamicLoader<Props> = string | (() => Promise<DynamicModule<Props>>)
export const dynamicReferenceSymbol = Symbol.for('pnext.dynamic')

export interface DynamicTarget {
  file: string
  exportName: string
}

export interface DynamicReference<Props extends object = object> {
  load: () => Promise<ComponentType<Props>>
  target?: DynamicTarget
}

export interface DynamicOptions<Props> {
  loading?: ComponentType<Props>
  load?: 'render' | 'visible'
  rootMargin?: string
  ssr?: boolean
  threshold?: number | number[]
}

export function dynamic<Props extends object = object>(
  loader: DynamicLoader<Props>,
  options: DynamicOptions<Props> = {},
  // Injected by the server compile (rewriteDynamicCallTargets); app code
  // never passes this.
  target?: DynamicTarget,
) {
  let loaded: ComponentType<Props> | null = null
  let pending: Promise<ComponentType<Props>> | null = null
  const loadModule =
    typeof loader === 'string'
      ? () => {
          throw new Error(`dynamic(${JSON.stringify(loader)}) was not compiled by PNext.`)
        }
      : loader

  const load = () => {
    pending ??= Promise.resolve(loadModule()).then(module => {
      loaded = typeof module === 'function' ? module : module.default
      return loaded
    })
    return pending
  }

  function DynamicComponent(props: Props) {
    const [Component, setComponent] = useState<ComponentType<Props> | null>(() => loaded)
    const [shouldLoad, setShouldLoad] = useState(() => options.load !== 'visible')
    const visibleRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
      if (Component || shouldLoad) return
      const node = visibleRef.current
      if (!node || typeof IntersectionObserver === 'undefined') {
        setShouldLoad(true)
        return
      }

      const observer = new IntersectionObserver(
        entries => {
          if (!entries.some(entry => entry.isIntersecting)) return
          observer.disconnect()
          setShouldLoad(true)
        },
        {
          rootMargin: options.rootMargin,
          threshold: options.threshold,
        },
      )

      observer.observe(node)
      return () => observer.disconnect()
    }, [Component, shouldLoad])

    useEffect(() => {
      if (Component || !shouldLoad) return
      let cancelled = false
      void load().then(next => {
        if (!cancelled) setComponent(() => next)
      })
      return () => {
        cancelled = true
      }
    }, [Component, shouldLoad])

    if (Component) return h(Component, props)
    const Loading = options.loading
    if (options.load === 'visible') {
      return h('div', { ref: visibleRef }, Loading ? h(Loading, props) : null)
    }
    return Loading ? h(Loading, props) : null
  }

  ;(
    DynamicComponent as typeof DynamicComponent & {
      [dynamicReferenceSymbol]: DynamicReference<Props>
    }
  )[dynamicReferenceSymbol] = { load, target }

  return DynamicComponent
}
