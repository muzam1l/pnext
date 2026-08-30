/** @jsxImportSource preact */
import { h, type ComponentType } from 'preact'
import { lazy, Suspense } from 'preact/compat'
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

export default function dynamic<Props extends object = object>(
  loader: DynamicLoader<Props>,
  options: DynamicOptions<Props> = {},
  // Injected by the server compile; see rewriteDynamicCallTargets.
  target?: DynamicTarget,
) {
  if (typeof loader === 'string') return pnextDynamic(loader, options, target)

  const coreDynamic = pnextDynamic(loader, options, target) as DynamicWithReference<Props>
  const Lazy = lazy(() => loader().then(module => ({ default: componentFromModule(module) })))
  const DynamicComponent = ((props: Props) => {
    const Loading = options.loading
    // ssr:false renders nothing on the server, so the client mount is a *hydration* whose only child
    // suspends. preact/compat nulls a hydrating vnode's type when it unmounts, and Suspense reuses the
    // same props.children vnode on its resolve re-render - the poisoned element then renders as text.
    // The hooks-based core component loads without suspending, so that boundary is never entered.
    if (options.ssr === false) {
      return h(
        'pnext-dynamic',
        { style: { display: 'contents' } },
        !process.browser && typeof window === 'undefined' ? null : h(coreDynamic, props),
      )
    }
    return h(Suspense, { fallback: Loading ? h(Loading, props) : null }, h(Lazy, props))
  }) as DynamicWithReference<Props>

  DynamicComponent[dynamicReferenceSymbol] = coreDynamic[dynamicReferenceSymbol]
  return DynamicComponent
}

export { dynamic }

type DynamicWithReference<Props extends object> = ComponentType<Props> & {
  [dynamicReferenceSymbol]?: DynamicReference<Props>
}

function componentFromModule<Props>(module: DynamicModule<Props>) {
  return typeof module === 'function' ? module : module.default
}
