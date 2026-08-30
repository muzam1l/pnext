// `new URL('./asset.png', import.meta.url)` asset references (COMPAT).
//
// Next/webpack rewrites this so it evaluates to the emitted client asset URL - the same URL an
// `import img from './asset.png'` produces - rather than a runtime file:// URL relative to the compiled
// bundle. Left intact, the literal resolves against the built bundle location, a path that never gets
// served.
//
// This reuses the static-image import pipeline: rewrite each matched call to `(<binding>.src)` and
// inject a top-level `import <binding> from '<spec>'`. That import flows through core's
// staticAssetModule seam, which emits the asset and yields the client URL. The `.src` string is what
// `.toString()` and `fileURLToPath()` (which then throws, as in Next's webpack path) observe.
//
// Applied to both graphs as a registered source transform.

import { rewriteReactProfilerServerSource } from './react-compiler'

// A `new URL('<image>', import.meta.url)` call whose first argument is a string
// literal ending in a static-image extension (optional ?query/#hash) and whose
// second argument is exactly `import.meta.url`. Non-asset `new URL(...)` calls
// (e.g. `new URL(request.url)`) never match.
const IMAGE_EXT = 'png|jpe?g|gif|webp|avif|svg|ico|bmp'
const newUrlAssetPattern = () =>
  new RegExp(
    `new\\s+URL\\(\\s*(['"])([^'"]+?\\.(?:${IMAGE_EXT})(?:[?#][^'"]*)?)\\1\\s*,\\s*import\\.meta\\.url\\s*\\)`,
    'g',
  )

/** Cheap gate: does the source contain any candidate `new URL(...import.meta.url)`? */
export function sourceHasNewUrlAsset(source: string): boolean {
  return source.includes('import.meta.url') && newUrlAssetPattern().test(source)
}

/**
 * Rewrite `new URL('<image>', import.meta.url)` occurrences to the emitted
 * static-image URL by threading them through the static-asset import pipeline.
 * Returns the source unchanged when there is nothing to rewrite.
 */
export function rewriteNewUrlAssetSource(source: string, filePath?: string): string {
  const rewritten = rewriteReactProfilerServerSource(source, filePath)
  return rewriteNewUrlAssets(
    rewritten,
    typeof filePath === 'string' && filePath.includes('middleware'),
  )
}

/**
 * Client-graph variant: no middleware form (a browser module never runs on the edge, and a client file
 * merely living under an `app/middleware/...` path must not get the blob: rewrite) and no Profiler pass
 * - that one is registered as its own client transform.
 */
export function rewriteNewUrlAssetClientSource(source: string): string {
  return rewriteNewUrlAssets(source, false)
}

function rewriteNewUrlAssets(source: string, isMiddleware: boolean): string {
  if (!source.includes('import.meta.url')) return source
  const bindings = new Map<string, string>()
  const replaced = source.replace(newUrlAssetPattern(), (_match, _quote, spec: string) => {
    let binding = bindings.get(spec)
    if (!binding) {
      binding = `__pnext_new_url_${bindings.size}`
      bindings.set(spec, binding)
    }
    if (isMiddleware) {
      return `('blob:' + ${binding}.src.split('/').pop())`
    }
    return `(${binding}.src)`
  })
  if (bindings.size === 0) return source
  const imports = [...bindings]
    .map(([spec, binding]) => `import ${binding} from ${JSON.stringify(spec)};`)
    .join('\n')
  return injectAfterDirectives(replaced, imports)
}

// Insert injected imports after any leading directive prologue ('use client' /
// 'use server' / 'use strict') and optional shebang, so a client module's
// `'use client'` stays the first statement (otherwise the directive is demoted
// to a plain expression and the module is treated as server-only).
function injectAfterDirectives(source: string, injection: string): string {
  const prologue =
    /^(\uFEFF?(?:#![^\n]*\n)?(?:[ \t]*(['"])use [\w-]+\2[ \t]*;?[ \t]*(?:\r?\n|$))*)/.exec(source)
  const index = prologue ? prologue[0].length : 0
  return `${source.slice(0, index)}${injection}\n${source.slice(index)}`
}
