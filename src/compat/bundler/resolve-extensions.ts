// next.config `resolveExtensions` for the CLIENT esbuild graph (COMPAT).
//
// The server resolver already honors the configured extension probe order. The client graph is bundled
// by esbuild, whose native `resolveExtensions` option cannot express two things the Next option allows:
// an `''` entry ("try the bare name with no extension"), and asset extensions like `.png` whose
// resolution must still flow through the static-asset onResolve plugin, keyed on the extensioned
// specifier. So instead of setting the esbuild option, this plugin probes relative specifiers in the
// configured order and re-dispatches the extensioned specifier through build.resolve(), so every
// downstream plugin sees the same path it would for an explicit extension. Only registered when the app
// configures resolveExtensions.

import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'esbuild'

const resolvedMarker = Symbol('pnext-resolve-extensions')

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * Client esbuild plugin applying the configured `resolveExtensions` probe
 * order to relative imports (user extension order replaces esbuild's default,
 * matching the server resolver's semantics: first hit wins, `''` = bare name).
 */
export function clientResolveExtensionsPlugin(extensions: readonly string[]): Plugin {
  return {
    name: 'pnext-resolve-extensions',
    setup(build) {
      build.onResolve({ filter: /^\.\.?\// }, async args => {
        if ((args.pluginData as Record<PropertyKey, unknown> | undefined)?.[resolvedMarker]) {
          return undefined
        }
        if (!args.resolveDir) return undefined
        const base = path.resolve(args.resolveDir, args.path)
        // An import that already names an existing file resolves as-is.
        if (isFile(base)) return undefined
        for (const extension of extensions) {
          const candidate = `${base}${extension}`
          if (!isFile(candidate)) continue
          // Re-dispatch with the extension made explicit so downstream
          // onResolve plugins (static assets, css) match on it.
          return build.resolve(`${args.path}${extension}`, {
            kind: args.kind,
            importer: args.importer,
            namespace: args.namespace,
            resolveDir: args.resolveDir,
            pluginData: { ...(args.pluginData as object | undefined), [resolvedMarker]: true },
          })
        }
        // Directory (index probe) or genuinely missing: preserve the probe
        // order for index files too, then fall back to esbuild's resolution.
        if (existsSync(base)) {
          for (const extension of extensions) {
            if (extension === '') continue
            if (!isFile(path.join(base, `index${extension}`))) continue
            return build.resolve(`${args.path.replace(/\/$/, '')}/index${extension}`, {
              kind: args.kind,
              importer: args.importer,
              namespace: args.namespace,
              resolveDir: args.resolveDir,
              pluginData: { ...(args.pluginData as object | undefined), [resolvedMarker]: true },
            })
          }
        }
        return undefined
      })
    },
  }
}
