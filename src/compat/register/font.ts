// next/font extension registration (COMPAT - may import core freely).
//
// Wires next/font preload delivery into core: requestExtensions.responseFinalizers gets the `Link`
// response header carrying the font preloads collected during the render.
//
// The font runtime stashes the render's preloadable font links on the request work unit. The registered
// finalizer, which runs before the first flush inside the same work unit, reads them back and emits a
// single `Link` header - matching Next, which delivers font preloads via a response header rather than
// HTML link tags.
//
// Registration is idempotent and also happens lazily on the first font-collection scope, so it is safe
// to call in a pure-core app and works before the orchestrator wires it in.

import type { ResolvedConfig } from '../../config'
import {
  registerClientSourceTransforms,
  registerServerSourceTransforms,
  withSniff,
} from '../../extensions'
import { rewriteNextFontSource } from '../aliases'
import { registerFontFinalizerOnce } from '../next/font/runtime'

const fontSourceTransformRoots = new Set<string>()

export function registerFontExtensions(config: ResolvedConfig): void {
  registerFontFinalizerOnce()
  if (!config.compat?.next || fontSourceTransformRoots.has(config.root)) return
  fontSourceTransformRoots.add(config.root)
  const sniff = ['next/font', 'next/root-params']
  registerServerSourceTransforms(
    withSniff(sniff, (source, file) => rewriteNextFontSource(source, file, 'server', config.root)),
  )
  registerClientSourceTransforms(
    withSniff(sniff, (source, file) => rewriteNextFontSource(source, file, 'client', config.root)),
  )
}
