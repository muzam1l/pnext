// next/image static-import extension registration (COMPAT - may import core).
//
// Registers the Next static-image module producer into core's `staticAssetModule` seam so
// `import img from './pic.png'` in the server module pipeline evaluates to the full
// `{src,width,height,blurDataURL,blurWidth,blurHeight}` descriptor next/image consumes, with the asset
// emitted under `/_next/static/media/<name>.<hash>.<ext>`.
//
// Safe in a pure-core app: the seam only overrides core's generic asset module for recognized image
// extensions; everything else falls through.

import { setAssetExtensions } from '../../extensions'
import { staticImageModule } from '../next/image/static-metadata'

export function registerStaticImageExtensions(): void {
  setAssetExtensions({
    staticAssetPublicPrefixes: () => ['/__pnext/static/media/', '/_next/static/media/'],
    staticAssetRelativePath: ({ base, hash, ext }) =>
      ['_next', 'static', 'media', `${base}.${hash}${ext}`].join('/'),
    staticAssetModule: staticImageModule,
  })
}
