// MDX esbuild plugin (COMPAT).
//
// Intercepts `.mdx` (and `.md`) loads across every build graph - client bundle, dev RSC route bundle,
// and prod server compile - and replaces the file contents with the JSX compiled from MDX. Returned as
// `loader: 'jsx'` so esbuild does the final JSX-to-preact-runtime transform.
//
// The same factory is registered on both the client and server esbuild plugin lists. It resolves the
// project root from the build's `absWorkingDir` (all pnext esbuild builds set it to the project root)
// so the optional mdx-components provider is located correctly.

import { readFile } from 'node:fs/promises'
import type { Plugin } from 'esbuild'
import { applyClientSourceTransforms } from '../../extensions'
import { compileMdx } from './compile'

const MDX_FILTER = /\.mdx?$/

/**
 * esbuild plugin that compiles `.md`/`.mdx` modules through the JS MDX pipeline.
 * `rootOverride` pins the project root; when omitted the plugin uses the build's
 * `absWorkingDir` (falling back to `process.cwd()`).
 */
export function mdxEsbuildPlugin(rootOverride?: string): Plugin {
  return {
    name: 'pnext-mdx',
    setup(build) {
      const root = rootOverride ?? build.initialOptions.absWorkingDir ?? process.cwd()
      build.onLoad({ filter: MDX_FILTER }, async args => {
        const source = await readFile(args.path, 'utf8')
        const { code } = await compileMdx(source, args.path, root)
        // Compiled MDX must still pass through registered source transforms
        // (e.g. modularizeImports) — raw compileMdx output bypasses them.
        return { contents: applyClientSourceTransforms(code, args.path, root), loader: 'jsx' }
      })
    },
  }
}
