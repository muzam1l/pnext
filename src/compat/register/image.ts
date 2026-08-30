// next/image extension registration (COMPAT - may import core freely).
//
// Wires the next/image pipeline into core: requestExtensions.interceptors gets the /_next/image optimizer
// endpoint, and buildExtensions.steps gets images-manifest.json emission. Safe to call in a pure-core
// app: the interceptor and build step no-op unless compat.next is enabled.

import path from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import type { ResolvedConfig } from '../../config'
import { nextCompatEnabled } from '../../compat/aliases'
import {
  registerBuildCompleteHooks,
  registerBuildSteps,
  registerRequestInterceptors,
  type BuildStepContext,
  type RequestInterceptor,
} from '../../extensions'
import { getImagesConfig, type ResolvedImagesConfig } from '../next/image/config'
import { isImageOptimizerRequest, serveImageOptimizer } from '../next/image/optimizer'
import { manifestLocalPatterns } from '../next/image/patterns'
import { getDocumentScriptExtensions, setDocumentScriptExtensions } from '../../render/hooks'
import { setWorkUnitRoute } from '../../request/context'

export function registerImageExtensions(config: ResolvedConfig): void {
  globalThis.__PNEXT_IMAGE_CONFIG__ = getImagesConfig()
  registerRequestInterceptors(imageOptimizerInterceptor)
  registerBuildSteps(writeImagesManifestStep)
  registerBuildCompleteHooks(async ctx => {
    if (nextCompatEnabled(ctx.config)) await mirrorStaticMedia(ctx.config)
  })

  if (nextCompatEnabled(config)) {
    const previousHeadTags = getDocumentScriptExtensions().documentHeadTags
    setDocumentScriptExtensions({
      documentHeadTags: (cfg, ctx) =>
        `${previousHeadTags?.(cfg, ctx) ?? ''}${PLACEHOLDER_SCRIPT_TAG}`,
    })
  }
}

// Placeholder removal for images that never hydrate (a next/image rendered by a server component has no
// island, so no ClientImage effect runs). The server img carries `data-nimg-ph` = the loaded,
// placeholder-free style; once it settles we decode() then restore it, matching ClientImage's
// handleLoading. Images inside hydrating islands are skipped - their ClientImage owns the lifecycle.
//
// Fully self-contained and defensive: a single try/catch so it can never throw into the document, and
// per-element load/error handlers only (no global capture listener) so it cannot interfere with
// hydration. Binds on DOMContentLoaded - placeholder imgs live in the body, below this head script - and
// also settles images already complete by then.
//
// Conflict-free with ClientImage: the loaded style is re-read from the live `data-nimg-ph` attribute
// INSIDE the post-decode callback, not at bind time. A hydrating route's ClientImage vdom carries no
// `data-nimg-ph`, so preact's hydration strips the SSR attribute; by the time this callback fires the
// attribute is gone on any hydrated image, the check bails, and ClientImage stays the sole owner.
const PLACEHOLDER_SCRIPT_TAG = `<script>(function(){try{function b(){var l=document.querySelectorAll("img[data-nimg-ph]");for(var i=0;i<l.length;i++){(function(img){if(img.closest("[data-pnext-client]"))return;var done=false;function r(){if(done)return;done=true;("decode"in img?img.decode():Promise.resolve()).catch(function(){}).then(function(){var t=img.getAttribute("data-nimg-ph");if(t==null||!img.isConnected)return;img.style.cssText=t;img.removeAttribute("data-nimg-ph")})}if(img.complete&&img.naturalWidth>0)r();else{img.addEventListener("load",r);img.addEventListener("error",r)}})(l[i])}}if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",b);else b()}catch(e){}})();</script>`

declare global {
  var __PNEXT_IMAGE_CONFIG__: ResolvedImagesConfig | undefined
}

const imageOptimizerInterceptor: RequestInterceptor = async (request, ctx) => {
  const config = ctx.config
  if (!nextCompatEnabled(config)) return undefined
  const url = new URL(request.url)
  const images = getImagesConfig()
  if (!isImageOptimizerRequest(url, images)) return undefined
  if (request.method !== 'GET' && request.method !== 'HEAD') return undefined
  // Optimizer responses own their headers outright — classify as a static
  // asset so the app-router finalizers (Vary token merge, x-nextjs-* stamps)
  // leave them untouched. Next serves /_next/image outside the router too.
  setWorkUnitRoute('static-asset')
  return serveImageOptimizer(request, config)
}

// Next-compatible images-manifest.json (.next/): the qualities/localpatterns
// e2e suites read it in production to assert the resolved images config.
async function writeImagesManifestStep(ctx: BuildStepContext): Promise<void> {
  const config = ctx.config
  if (!nextCompatEnabled(config)) return
  const images = getImagesConfig()

  // normalizeLocalPatterns already appends the internal media patterns when
  // localPatterns is configured, so manifest and runtime share one source.
  const localPatterns = manifestLocalPatterns(images.localPatterns)

  const manifest = {
    version: 1,
    images: {
      contentDispositionType: images.contentDispositionType,
      contentSecurityPolicy: images.contentSecurityPolicy,
      dangerouslyAllowLocalIP: images.dangerouslyAllowLocalIP,
      dangerouslyAllowSVG: images.dangerouslyAllowSVG,
      deviceSizes: images.deviceSizes,
      disableStaticImages: images.disableStaticImages,
      domains: images.domains,
      formats: images.formats,
      imageSizes: images.imageSizes,
      loader: images.loader,
      loaderFile: images.loaderFile,
      remotePatterns: images.remotePatterns,
      localPatterns,
      maximumRedirects: images.maximumRedirects,
      maximumResponseBody: images.maximumResponseBody,
      minimumCacheTTL: images.minimumCacheTTL,
      path: images.path,
      qualities: images.qualities,
      sizes: [...images.deviceSizes, ...images.imageSizes],
      unoptimized: images.unoptimized,
      customCacheHandler: images.customCacheHandler,
    },
  }

  const outDir = path.join(config.root, '.next')
  await mkdir(outDir, { recursive: true })
  await writeFile(path.join(outDir, 'images-manifest.json'), JSON.stringify(manifest, null, 2))
}

// Tooling (and Next's e2e suites) discover fingerprinted static-import images
// by scanning <distDir>/static/media; pnext emits them under
// outPath/public/_next/static/media. Mirror them into .next so both layouts
// hold the same files.
async function mirrorStaticMedia(config: ResolvedConfig): Promise<void> {
  const { cp } = await import('node:fs/promises')
  for (const dir of ['media', 'immutable/media']) {
    const source = path.join(config.outPath, 'public', '_next', 'static', dir)
    const target = path.join(config.root, '.next', 'static', dir)
    try {
      await cp(source, target, { recursive: true, force: true })
    } catch {
      // no static media emitted for this build
    }
  }
}
