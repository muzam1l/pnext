/** @jsxImportSource preact */
import { forwardRef } from 'preact/compat'
import { registerResourceHint } from '../../render/resource-hints'
import { getImagesConfig, resolveImageProps } from './image/props'
import type { ImageProps } from './image/props'

// next/legacy/image (the pre-13 component).
//
// Same optimizer/loader pipeline as next/image (resolveImageProps), with the one behavioral difference
// the legacy component is defined by: a LAZY image server-renders a blank 1x1 gif as `src` (no
// srcSet/sizes) and only swaps in the real, optimized attributes once it scrolls near the viewport.
// `priority` / `loading="eager"` images render their real attributes straight away.
//
// The legacy component did that swap from its own client bundle; a pnext page need not hydrate at all,
// so the swap rides on a small idempotent inline script emitted next to the image. Without JS the
// `<noscript>` copy carries the real image, exactly like Next's.
//
// Deliberately minimal: the legacy wrapper/sizer span layout scaffolding is not reproduced - `layout`
// still maps to the same styles next/image applies and lands in `data-nimg`.

const EMPTY_DATA_URL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

const LEGACY_SRC_ATTR = 'data-pnext-legacy-src'

// Swaps every blanked legacy image to its real attributes when it nears the
// viewport (falling back to an immediate swap without IntersectionObserver).
// Guarded by a window flag so N images on a page still install it once, and
// wrapped in try/catch so it can never throw into the document.
const LAZY_SWAP_SCRIPT =
  `window.__pnextLegacyImg||(window.__pnextLegacyImg=1,function(){try{` +
  `function s(i){var a=i.getAttribute("${LEGACY_SRC_ATTR}set"),z=i.getAttribute("${LEGACY_SRC_ATTR}sizes"),u=i.getAttribute("${LEGACY_SRC_ATTR}");` +
  `if(z)i.sizes=z;if(a)i.srcset=a;if(u)i.src=u;` +
  `i.removeAttribute("${LEGACY_SRC_ATTR}");i.removeAttribute("${LEGACY_SRC_ATTR}set");i.removeAttribute("${LEGACY_SRC_ATTR}sizes")}` +
  `function b(){var l=document.querySelectorAll("img[${LEGACY_SRC_ATTR}]"),i;` +
  `if(!("IntersectionObserver"in window)){for(i=0;i<l.length;i++)s(l[i]);return}` +
  `var o=new IntersectionObserver(function(es){for(var k=0;k<es.length;k++){if(es[k].isIntersecting){s(es[k].target);o.unobserve(es[k].target)}}},{rootMargin:"200px"});` +
  `for(i=0;i<l.length;i++)o.observe(l[i])}` +
  `if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",b);else b()}catch(e){}}());`

const LegacyImage = forwardRef<HTMLImageElement, ImageProps>(
  function LegacyImage(imageProps, forwardedRef) {
    const config = getImagesConfig()
    // `intrinsic` is the legacy default layout (next/image has no default).
    const layout = imageProps.layout ?? 'intrinsic'
    const { props, meta } = resolveImageProps({ ...imageProps, layout }, config)

    if (meta.preload) {
      registerResourceHint({
        rel: 'preload',
        as: 'image',
        ...(meta.imgAttributes.srcSet ? {} : { url: meta.imgAttributes.src }),
        attributes: {
          ...(meta.imgAttributes.srcSet ? { imagesrcset: meta.imgAttributes.srcSet } : {}),
          ...(meta.imgAttributes.sizes ? { imagesizes: meta.imgAttributes.sizes } : {}),
        },
      })
    }

    const eager = props.loading === 'eager' || Boolean(imageProps.priority)
    const nimgAttrs = {
      'data-nimg': layout,
      ...(meta.loadedStyle !== undefined ? { 'data-nimg-ph': meta.loadedStyle } : {}),
    }

    // On the client the component renders its real attributes directly — the
    // browser's own `loading="lazy"` covers deferral there.
    if (eager || process.browser || typeof window !== 'undefined') {
      return <img {...props} {...nimgAttrs} ref={forwardedRef} />
    }

    const { src, srcSet, sizes, ...blanked } = props
    return (
      <>
        <img
          {...blanked}
          src={EMPTY_DATA_URL}
          loading="lazy"
          {...nimgAttrs}
          {...(typeof src === 'string' ? { [LEGACY_SRC_ATTR]: src } : {})}
          {...(typeof srcSet === 'string' ? { [`${LEGACY_SRC_ATTR}set`]: srcSet } : {})}
          {...(typeof sizes === 'string' ? { [`${LEGACY_SRC_ATTR}sizes`]: sizes } : {})}
          ref={forwardedRef}
        />
        <noscript>
          <img {...props} loading="lazy" {...nimgAttrs} />
        </noscript>
        <script dangerouslySetInnerHTML={{ __html: LAZY_SWAP_SCRIPT }} />
      </>
    )
  },
)

export default LegacyImage
export { LegacyImage as Image }
export { getImageProps, unstable_getImgProps } from './image/props'
export type { ImageLoader, ImageProps, StaticImageData } from './image/props'
