/** @jsxImportSource preact */
import { Component, h, type ComponentChildren, type ComponentType } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'

export type DynamicModule<Props> = ComponentType<Props> | { default: ComponentType<Props> }
export type DynamicLoader<Props> = string | (() => Promise<DynamicModule<Props>>)
export const dynamicReferenceSymbol = Symbol.for('pnext.dynamic')

export interface DynamicTarget {
  file: string
  exportName: string
  /** The client-reference id the build derived, so a moved build matches without the path. */
  id?: string
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
  let failed = false
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

  // Rendered on the server and hydrated from its markup: suspends until the module loads.
  function Loaded(props: Props) {
    const ref = useRef<HTMLElement>(null)
    const [remounts, setRemounts] = useState(0)
    // The server sent `loading` because its load failed: replace that markup, never hydrate it.
    useLayoutEffect(() => {
      if (ref.current?.hasAttribute('data-pnext-loading')) setRemounts(1)
    }, [])
    if (loaded)
      return h('pnext-dynamic', { key: remounts, ref, style: HOST_STYLE }, h(loaded, props))
    const Loading = options.loading
    if (failed) {
      return h(
        'pnext-dynamic',
        { ref, style: HOST_STYLE, 'data-pnext-loading': '' },
        Loading ? h(Loading, props) : null,
      )
    }
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw typeof window === 'undefined'
      ? load().then(
          () => undefined,
          () => {
            failed = true
          },
        )
      : load()
  }

  function ClientDynamic(props: Props) {
    const [Component, setComponent] = useState<ComponentType<Props> | null>(null)
    const [shouldLoad, setShouldLoad] = useState(() => options.load !== 'visible')
    const visibleRef = useRef<HTMLDivElement>(null)

    // The server sent `loading`: hydrate it, then swap in a module that is already loaded.
    useLayoutEffect(() => {
      if (loaded) setComponent(() => loaded)
    }, [])

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

  const DynamicComponent =
    options.ssr === false || options.load === 'visible'
      ? ClientDynamic
      : (props: Props) =>
          typeof window === 'undefined'
            ? h(Loaded, props)
            : h(
                DynamicBoundary,
                { fallback: options.loading ? h(options.loading, props) : null },
                h(Loaded, props),
              )

  ;(
    DynamicComponent as typeof DynamicComponent & {
      [dynamicReferenceSymbol]: DynamicReference<Props>
    }
  )[dynamicReferenceSymbol] = { load, target }

  return DynamicComponent
}

const HOST_STYLE = { display: 'contents' }
// preact's mangled MODE_HYDRATE flag on a vnode's `__u`.
const MODE_HYDRATE = 32

interface SuspendedVNode {
  __u: number
}

// Suspense for one dynamic(): hydration keeps the server markup until the chunk loads, a fresh render
// shows `fallback`. `__c` is compat's mangled `_childDidSuspend`, so compat suspends here too.
class DynamicBoundary extends Component<
  { fallback: ComponentChildren; children?: ComponentChildren },
  { waiting?: boolean; held?: boolean }
> {
  __c(promise: Promise<unknown>, vnode: SuspendedVNode) {
    this.setState({ waiting: true, held: (vnode.__u & MODE_HYDRATE) !== 0 })
    void promise.then(() => this.setState({ waiting: false }))
  }

  componentDidCatch(error: unknown) {
    if (!(error instanceof Promise)) throw error
    this.__c(error, (this as unknown as { __v: { __k: SuspendedVNode[] } }).__v.__k[0]!)
  }

  shouldComponentUpdate(_props: unknown, state: { waiting?: boolean; held?: boolean }) {
    return !(state.waiting && state.held)
  }

  render() {
    return this.state.waiting && !this.state.held ? this.props.fallback : this.props.children
  }
}
