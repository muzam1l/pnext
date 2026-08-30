import { setRuntimeExtensions } from '../../extensions'
import { withEdgeRuntime } from '../edge-runtime'

export function registerEdgeRuntimeExtensions(): void {
  setRuntimeExtensions({ withEdgeRuntime })
}
