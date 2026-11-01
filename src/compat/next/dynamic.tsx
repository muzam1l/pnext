/** @jsxImportSource preact */
import { h, type ComponentType } from 'preact'
import {
  dynamic as pnextDynamic,
  dynamicReferenceSymbol,
  type DynamicLoader,
  type DynamicModule,
  type DynamicOptions,
  type DynamicReference,
  type DynamicTarget,
} from '../../api/dynamic'

export type { DynamicLoader, DynamicModule, DynamicOptions }

const LOADING_PROPS = { isLoading: true, pastDelay: true, error: null }

export default function dynamic<Props extends object = object>(
  loader: DynamicLoader<Props>,
  options: DynamicOptions<Props> = {},
  // Injected by the server compile; see rewriteDynamicCallTargets.
  target?: DynamicTarget,
) {
  if (typeof loader === 'string') return pnextDynamic(loader, options, target)
  // Next calls `loading` with its load state, not the component's props.
  const Loading = options.loading as ComponentType<typeof LOADING_PROPS> | undefined
  const fallback = () => (Loading ? h(Loading, LOADING_PROPS) : null)
  const coreDynamic = pnextDynamic(
    loader,
    { ...options, loading: Loading && fallback },
    target,
  ) as DynamicWithReference<Props>
  // Core's component server-renders and hydrates like Next, waiting for a chunk still loading.
  if (options.ssr !== false) return coreDynamic

  // ssr:false server-renders `loading`; the client hydrates it, then swaps in the component.
  const DynamicComponent = ((props: Props) =>
    h(
      'pnext-dynamic',
      { style: { display: 'contents' } },
      !process.browser && typeof window === 'undefined' ? fallback() : h(coreDynamic, props),
    )) as DynamicWithReference<Props>

  DynamicComponent[dynamicReferenceSymbol] = coreDynamic[dynamicReferenceSymbol]
  return DynamicComponent
}

export { dynamic }

type DynamicWithReference<Props extends object> = ComponentType<Props> & {
  [dynamicReferenceSymbol]?: DynamicReference<Props>
}
