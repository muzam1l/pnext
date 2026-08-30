/** @jsxImportSource preact */
import { registerResourceHint } from '../../render/resource-hints'
import { forwardRef } from 'preact/compat'
import ClientImage from './image/client'
import { getImagesConfig, resolveImageProps } from './image/props'
import type { ImageProps } from './image/props'

const Image = forwardRef<HTMLImageElement, ImageProps>(function Image(imageProps, forwardedRef) {
  const config = getImagesConfig()
  const { props, meta } = resolveImageProps(imageProps, config)
  const extra = imageProps as ImageProps & {
    crossOrigin?: string
    referrerPolicy?: string
    fetchPriority?: string
  }

  if (meta.preload) {
    registerResourceHint({
      rel: 'preload',
      as: 'image',
      ...(meta.imgAttributes.srcSet ? {} : { url: meta.imgAttributes.src }),
      attributes: {
        ...(meta.imgAttributes.srcSet ? { imagesrcset: meta.imgAttributes.srcSet } : {}),
        ...(meta.imgAttributes.sizes ? { imagesizes: meta.imgAttributes.sizes } : {}),
        ...(extra.crossOrigin ? { crossorigin: extra.crossOrigin } : {}),
        ...(extra.referrerPolicy ? { referrerpolicy: extra.referrerPolicy } : {}),
        ...(extra.fetchPriority ? { fetchpriority: extra.fetchPriority } : {}),
      },
    })
  }

  if (!process.browser && typeof window === 'undefined') {
    // `data-nimg-ph` carries the loaded (placeholder-free) style so the inline
    // placeholder script (register-image) can restore it on load for images
    // that never hydrate (next/image used directly in a server component).
    // Hydrating islands strip/ignore it — ClientImage owns the placeholder there.
    return (
      <img
        {...props}
        data-nimg={meta.fill ? 'fill' : '1'}
        {...(meta.loadedStyle !== undefined ? { 'data-nimg-ph': meta.loadedStyle } : {})}
        ref={forwardedRef}
      />
    )
  }

  return <ClientImage {...imageProps} ref={forwardedRef} __pnextConfig={config} />
})

export default Image
export { Image }
export { findClosestQuality, getImageProps, unstable_getImgProps } from './image/props'
export type { ImageLoader, ImageProps, StaticImageData } from './image/props'
