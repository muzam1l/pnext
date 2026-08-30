'use client'
/** @jsxImportSource preact */

import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'preact/compat'
import type { Ref } from 'preact/compat'
import type { JSX } from 'preact'
import { getImagesConfig, resolveImageProps } from './props'
import type { ImageProps, ResolvedImagesConfig } from './props'

const useSettleEffect =
  !process.browser && typeof window === 'undefined' ? useEffect : useLayoutEffect

// The initial hydration pass, before the entry flips __NEXT_HYDRATED (a
// microtask after the island mounts). Layout effects run inside it, so an image
// seen here came from the server document — one rendered by a later client
// update (a click) did not.
function hydrating(): boolean {
  return (
    (process.browser || typeof window !== 'undefined') &&
    !(window as { __NEXT_HYDRATED?: boolean }).__NEXT_HYDRATED
  )
}

type OnLoad = NonNullable<ImageProps['onLoad']>
type OnLoadingComplete = NonNullable<ImageProps['onLoadingComplete']>
type ImageClientProps = ImageProps & { __pnextConfig?: ResolvedImagesConfig }

function handleLoading(
  img: HTMLImageElement | null,
  placeholder: string,
  onLoadRef: { current: OnLoad | undefined },
  onLoadingCompleteRef: { current: OnLoadingComplete | undefined },
  setBlurComplete: (b: boolean) => void,
): void {
  if (!img) return
  const src = img.src
  const marker = img as HTMLImageElement & { 'data-loaded-src'?: string }
  if (marker['data-loaded-src'] === src) return
  marker['data-loaded-src'] = src
  const p = 'decode' in img ? img.decode() : Promise.resolve()
  void p
    .catch(() => undefined)
    .then(() => {
      if (!img.parentElement || !img.isConnected) return
      if (placeholder !== 'empty') setBlurComplete(true)
      if (onLoadRef.current) {
        const event = new Event('load')
        Object.defineProperty(event, 'target', { writable: false, value: img })
        let prevented = false
        let stopped = false
        onLoadRef.current({
          ...(event as unknown as Record<string, unknown>),
          nativeEvent: event,
          currentTarget: img,
          target: img,
          isDefaultPrevented: () => prevented,
          isPropagationStopped: () => stopped,
          persist: () => undefined,
          preventDefault: () => {
            prevented = true
            event.preventDefault()
          },
          stopPropagation: () => {
            stopped = true
            event.stopPropagation()
          },
        } as unknown as JSX.TargetedEvent<HTMLImageElement, Event>)
      }
      if (onLoadingCompleteRef.current) onLoadingCompleteRef.current(img)
    })
}

function useMergedRef<T>(
  refA: Ref<T> | undefined,
  refB: Ref<T> | undefined,
): (el: T | null) => void {
  const cleanupA = useRef<(() => void) | null>(null)
  const cleanupB = useRef<(() => void) | null>(null)
  return useCallback(
    (current: T | null) => {
      if (current === null) {
        cleanupA.current?.()
        cleanupA.current = null
        cleanupB.current?.()
        cleanupB.current = null
      } else {
        if (refA) cleanupA.current = applyRef(refA, current)
        if (refB) cleanupB.current = applyRef(refB, current)
      }
    },
    [refA, refB],
  )
}

function applyRef<T>(ref: NonNullable<Ref<T>>, current: T): () => void {
  if (typeof ref === 'function') {
    const cleanup = ref(current)
    return typeof cleanup === 'function' ? cleanup : () => (ref as (v: T | null) => void)(null)
  }
  ;(ref as { current: T | null }).current = current
  return () => {
    ;(ref as { current: T | null }).current = null
  }
}

const Image = forwardRef<HTMLImageElement, ImageClientProps>(function Image(
  { __pnextConfig, ...imageProps },
  forwardedRef,
) {
  const config = __pnextConfig ?? getImagesConfig()
  const [blurComplete, setBlurComplete] = useState(false)
  const [showAltText, setShowAltText] = useState(false)
  const { props, meta } = resolveImageProps(imageProps, config, blurComplete, showAltText)

  const { onLoad, onError, onLoadingComplete } = imageProps
  const onLoadRef = useRef(onLoad)
  useEffect(() => {
    onLoadRef.current = onLoad
  }, [onLoad])
  const onLoadingCompleteRef = useRef(onLoadingComplete)
  useEffect(() => {
    onLoadingCompleteRef.current = onLoadingComplete
  }, [onLoadingComplete])

  const placeholder = meta.placeholder
  const renderedSrc = typeof props.src === 'string' ? props.src : ''
  const insertedImgRef = useRef<HTMLImageElement | null>(null)
  const settledSrcRef = useRef<string | undefined>(undefined)
  // True while an error the app must not see is outstanding: the server-rendered
  // request that was already in flight when this component mounted. See below.
  const swallowErrorRef = useRef(false)
  useSettleEffect(() => {
    const img = insertedImgRef.current
    if (img === null || settledSrcRef.current === renderedSrc) return
    settledSrcRef.current = renderedSrc
    // An error on a server-rendered image happens before onError is attached,
    // so it is lost — Next re-issues the request once at mount to surface it.
    if (onError) {
      if (img.complete) {
        const currentSrc = img.src
        img.src = currentSrc
      } else if (hydrating()) {
        // Same situation, mid-flight: the request started with the document,
        // so its outcome still predates this mount. Swallow it and re-issue
        // once it lands, so onError sees an error raised against this mount.
        swallowErrorRef.current = true
        img.addEventListener(
          'error',
          () => {
            swallowErrorRef.current = false
            const failedSrc = img.src
            img.src = failedSrc
          },
          { once: true },
        )
      }
    }
    const settle = () =>
      handleLoading(img, placeholder, onLoadRef, onLoadingCompleteRef, setBlurComplete)
    if (img.complete) settle()
  }, [renderedSrc, placeholder, onError])

  const ref = useMergedRef<HTMLImageElement>(forwardedRef, insertedImgRef)
  const extra = imageProps as unknown as {
    crossOrigin?: string
    referrerPolicy?: string
    fetchPriority?: string
  }
  const preloadLink = meta.preload ? (
    <link
      rel="preload"
      as="image"
      href={meta.imgAttributes.srcSet ? undefined : meta.imgAttributes.src}
      {...({
        imagesrcset: meta.imgAttributes.srcSet,
        imagesizes: meta.imgAttributes.sizes,
        crossOrigin: extra.crossOrigin,
        referrerPolicy: extra.referrerPolicy,
        fetchpriority: extra.fetchPriority,
      } as Record<string, unknown>)}
    />
  ) : null

  return (
    <>
      {preloadLink}
      <img
        {...props}
        data-nimg={meta.fill ? 'fill' : '1'}
        ref={ref}
        onLoad={event => {
          handleLoading(
            event.currentTarget,
            placeholder,
            onLoadRef,
            onLoadingCompleteRef,
            setBlurComplete,
          )
        }}
        onError={event => {
          setShowAltText(true)
          if (placeholder !== 'empty') setBlurComplete(true)
          // The pre-mount failure is re-issued by the settle effect; the app
          // hears about the retry, not the request that predated its handler.
          if (swallowErrorRef.current) return
          onError?.(event)
        }}
      />
    </>
  )
})

export default Image
export { Image }
