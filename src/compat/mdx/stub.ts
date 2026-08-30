// `@next/mdx` config-time stub (COMPAT).
//
// `createMDX(pluginOptions)(nextConfig)` embeds the user's remark/rehype/recma plugin options ONLY
// inside a webpack/turbopack loader config it attaches to the returned next.config - it never exposes
// them on a readable top-level field. pnext has no webpack, so those options would be lost and every
// configured MDX plugin would silently not run.
//
// During config bundling, `@next/mdx` resolves to this stub instead of the real package. The stub
// reproduces the wrapper's signature but stashes the plugin options on `config.mdxOptions`, exactly
// where pnext's MDX compile pipeline reads them. It also removes the need for `@next/mdx` itself to be
// installed for the config to load. The wrapped config's own webpack/turbopack/pageExtensions are
// irrelevant to pnext, so the stub only needs to merge `mdxOptions`.

import type { Plugin } from 'esbuild'

// CJS so esbuild's default-import interop yields the wrapper factory for both
// `import nextMDX from '@next/mdx'` and `require('@next/mdx')` config authors.
const NEXT_MDX_STUB_CONTENTS = `
const createMDX = (pluginOptions = {}) => (nextConfig = {}) => ({
  ...nextConfig,
  mdxOptions: (pluginOptions && pluginOptions.options) || {},
});
module.exports = createMDX;
module.exports.default = createMDX;
`

/**
 * esbuild plugin (config-load only) that replaces `@next/mdx` (and its
 * `@next/mdx/*` deep specifiers) with a stub capturing the plugin options onto
 * `config.mdxOptions`.
 */
export function nextMdxConfigStubPlugin(): Plugin {
  return {
    name: 'pnext-next-mdx-config-stub',
    setup(build) {
      build.onResolve({ filter: /^@next\/mdx(?:\/|$)/ }, args => ({
        path: args.path,
        namespace: 'pnext-next-mdx-stub',
      }))
      build.onLoad({ filter: /.*/, namespace: 'pnext-next-mdx-stub' }, () => ({
        contents: NEXT_MDX_STUB_CONTENTS,
        loader: 'js',
      }))
    },
  }
}
