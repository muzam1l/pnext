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

export default function dynamic<Props extends object = object>(
  loader: DynamicLoader<Props>,
  options: DynamicOptions<Props> = {},
  // Injected by the server compile; see rewriteDynamicCallTargets.
  target?: DynamicTarget,
) {
  const coreDynamic = pnextDynamic(loader, options, target) as DynamicWithReference<Props>
  // Core's component server-renders and hydrates like Next, waiting for a chunk still loading.
  if (typeof loader === 'string' || options.ssr !== false) return coreDynamic

  // ssr:false renders nothing on the server; the client renders `loading`, then the component.
  const DynamicComponent = ((props: Props) =>
    h(
      'pnext-dynamic',
      { style: { display: 'contents' } },
      !process.browser && typeof window === 'undefined' ? null : h(coreDynamic, props),
    )) as DynamicWithReference<Props>

  DynamicComponent[dynamicReferenceSymbol] = coreDynamic[dynamicReferenceSymbol]
  return DynamicComponent
}

export { dynamic }

type DynamicWithReference<Props extends object> = ComponentType<Props> & {
  [dynamicReferenceSymbol]?: DynamicReference<Props>
}
