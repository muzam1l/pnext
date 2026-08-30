// MDX extension registration (COMPAT).
//
// Wires the MDX esbuild plugin into the client and server build graphs so `.mdx`/`.md` modules compile
// via the JS pipeline. Two integration points:
//
// 1. BUNDLER: the MDX plugin is appended to clientEsbuildPlugins and serverEsbuildPlugins.
//    `setBundlerExtensions` REPLACES the factory and register-actions already sets clientEsbuildPlugins,
//    so this COMPOSES with any previously-registered factory rather than clobbering it. Note that
//    `serverEsbuildPlugins` is defined but not yet applied at every server compile site, so until that
//    seam is threaded MDX compiles in the CLIENT graph only; the server factory is registered here so it
//    activates for free once it lands.
//
// 2. PAGE EXTENSIONS: core derives its page/convention extension list lazily from a base plus whatever
//    compat registers, so the route scanner discovers `page.mdx` and top-level `.mdx` pages once `mdx`/
//    `md` are registered. `pageExtensions` in next.config (as set by @next/mdx's createMDX) is the single
//    source of truth: when the app sets it, exactly the listed extensions core does not already carry are
//    registered, so `.mdx` routes only when the app opted in - matching Next. When none is configured,
//    nothing extra is registered.
//
//    The seam is additive-only, so core's base `mjs` cannot be removed even if a configured
//    `pageExtensions` omits it - a documented, harmless divergence. The route scanner needs these
//    extensions at boot, so the registration itself lives in register-boot.ts; only the compilation
//    wiring is here.

import type { Plugin } from 'esbuild'
import type { ResolvedConfig } from '../../config'
import { getBundlerExtensions, setBundlerExtensions } from '../../extensions'
import { nextCompatEnabled } from '../../render/hooks'
import { mdxEsbuildPlugin } from '../mdx/plugin'

export function registerMdxExtensions(config: ResolvedConfig): void {
  if (!nextCompatEnabled(config)) return

  const existing = getBundlerExtensions()
  const priorClient = existing.clientEsbuildPlugins
  const priorServer = existing.serverEsbuildPlugins

  setBundlerExtensions({
    clientEsbuildPlugins: (cfg: ResolvedConfig): Plugin[] => [
      ...priorClient(cfg),
      mdxEsbuildPlugin(config.root),
    ],
    serverEsbuildPlugins: (cfg: ResolvedConfig, opts?): Plugin[] => [
      ...priorServer(cfg, opts),
      mdxEsbuildPlugin(config.root),
    ],
  })
}
