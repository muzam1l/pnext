// instrumentation.ts loader (COMPAT).
//
// Loads the app's instrumentation module (root or src/), calls its async register() exactly once at
// server start, and exposes its onRequestError export to the error funnel. The module is bundled with
// esbuild (node_modules kept external) so TypeScript and ESM imports inside it work, then imported once.
// The register() promise is awaited before the first request via a gate the compat request interceptor
// consults.
//
// EDGE PASS: Next boots a SECOND instrumentation instance inside the edge sandbox whenever the app has
// any edge-runtime entity - middleware/proxy, or a route declaring an edge runtime. pnext runs one Bun
// process, so it emulates the pass by importing a FRESH module instance (a separate bundle file, so
// separate module state) and calling its register() with NEXT_RUNTIME='edge' set for the duration.
// Apps without edge entities never get the pass.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import type { Plugin } from 'esbuild'
import { build } from '../../utils/esbuild'
import type { ResolvedConfig } from '../../config'
import { resolveExternalLoadTarget } from '../../resolve/imports'
import { compatAliases, reactServerLayerAliases } from '../aliases'
import { productionRelease } from '../../runtime/production'

const INSTRUMENTATION_BASENAMES = [
  'instrumentation.ts',
  'instrumentation.mts',
  'instrumentation.js',
  'instrumentation.mjs',
  'instrumentation.tsx',
]

/**
 * The instrumentation bundle keeps node_modules external, so every bare specifier it emits is resolved
 * by Bun against the APP directory at import time - where `react`/`next/*` do not exist. Resolve the
 * compat alias map here and hand esbuild an external `file://` URL for each hit, so the emitted import
 * points straight at pnext's own module, loaded once and shared with the running server.
 *
 * `react`/`react-dom` take the react-server-layer overrides: Next compiles instrumentation in the
 * server layer, so register() must observe the hook-free React.
 */
function instrumentationAliases(config: ResolvedConfig): Record<string, string> {
  return { ...compatAliases(config, 'server'), ...reactServerLayerAliases(config) }
}

function instrumentationPlugin(root: string, config?: ResolvedConfig): Plugin {
  const appRequire = createRequire(path.join(root, 'package.json'))
  const aliases = config ? instrumentationAliases(config) : {}
  return {
    name: 'pnext-instrumentation',
    setup(builder) {
      builder.onResolve({ filter: /^[^./]/ }, args => {
        const alias = aliases[args.path]
        if (!alias) return undefined
        return {
          path: path.isAbsolute(alias) ? pathToFileURL(alias).href : alias,
          external: true,
        }
      })
      builder.onResolve({ filter: /^server-only$/ }, () => ({
        path: 'server-only',
        namespace: 'pnext',
      }))
      builder.onLoad({ filter: /^server-only$/, namespace: 'pnext' }, () => ({ contents: '' }))
      builder.onResolve({ filter: /^@vercel\/otel$/ }, () => {
        try {
          appRequire.resolve('@vercel/otel')
          return undefined
        } catch {
          return { path: '@vercel/otel', namespace: 'pnext' }
        }
      })
      builder.onLoad({ filter: /^@vercel\/otel$/, namespace: 'pnext' }, () => ({
        contents: 'export function registerOTel() {}',
      }))
      builder.onResolve({ filter: /^[^./]/ }, args => {
        const target = resolveExternalLoadTarget({
          root,
          fromFile: args.importer || path.join(root, 'instrumentation.ts'),
          specifier: args.path,
          target: 'server',
        })
        return target ? { path: target } : undefined
      })
    },
  }
}

export type OnRequestErrorHook = (
  error: unknown,
  request: { path: string; method: string; headers: Record<string, string> },
  context: Record<string, unknown>,
) => void | Promise<void>

interface InstrumentationModule {
  register?: () => void | Promise<void>
  onRequestError?: OnRequestErrorHook
}

let loaded: InstrumentationModule | undefined
let readyGate: Promise<void> | undefined

/** The user onRequestError export, once instrumentation has loaded. */
export function getUserOnRequestError(): OnRequestErrorHook | undefined {
  return loaded?.onRequestError
}

/** Resolve once instrumentation register() has completed (or there is none). */
export function instrumentationReady(): Promise<void> {
  return readyGate ?? Promise.resolve()
}

function findInstrumentation(config: ResolvedConfig): string | undefined {
  for (const root of instrumentationLookupRoots(config)) {
    for (const name of INSTRUMENTATION_BASENAMES) {
      const candidate = path.join(root, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Next colocates instrumentation with the source folder: when app/pages live
 * under `src/`, only `src/instrumentation.*` is honored (a root file is
 * ignored). Apps without a `src/` source tree read from the project root.
 */
export function instrumentationLookupRoots(config: ResolvedConfig): string[] {
  const src = path.join(config.root, 'src')
  const usesSrc = existsSync(path.join(src, 'app')) || existsSync(path.join(src, 'pages'))
  return usesSrc ? [src] : [config.root]
}

async function importInstrumentation(
  file: string,
  config: ResolvedConfig,
  suffix = '',
): Promise<InstrumentationModule> {
  // Under config.outPath, so a dev server's scratch bundle lives in its own
  // subtree and a concurrent build never removes it mid-import.
  const outDir = path.join(config.outPath, 'instrumentation')
  mkdirSync(outDir, { recursive: true })
  const outfile = path.join(outDir, `instrumentation.${Date.now()}${suffix}.mjs`)
  try {
    await bundleInstrumentation(file, config, outfile)
    return (await import(pathToFileURL(outfile).href)) as InstrumentationModule
  } finally {
    rmSync(outfile, { force: true })
  }
}

/**
 * Bundle instrumentation for a production release: the node instance, plus a separate edge instance
 * file when the app has edge entities. Out-relative paths, or undefined when the app has none.
 */
export async function emitReleaseInstrumentation(config: ResolvedConfig, outDir: string) {
  const file = findInstrumentation(config)
  if (!file) return undefined
  const node = await releaseInstrumentation(file, config, outDir, 'instrumentation')
  if (!appHasEdgeEntities(config)) return { file: path.relative(config.outPath, node) }
  const edge = await releaseInstrumentation(file, config, outDir, 'instrumentation.edge')
  return { file: path.relative(config.outPath, node), edge: path.relative(config.outPath, edge) }
}

/** One release instance: located relative to itself, named by its content (a new generation never reuses a module). */
async function releaseInstrumentation(
  file: string,
  config: ResolvedConfig,
  outDir: string,
  name: string,
) {
  const temporary = path.join(outDir, `${name}.${process.pid}.tmp.mjs`)
  await bundleInstrumentation(file, config, temporary, outDir)
  const { relocateReleaseBundle } = await import('../../runtime/modules')
  const contents = relocateReleaseBundle(config, temporary, readFileSync(temporary, 'utf8'))
  rmSync(temporary, { force: true })
  const outfile = path.join(outDir, `${name}.${Bun.hash(contents).toString(36)}.mjs`)
  writeFileSync(outfile, contents)
  return outfile
}

async function bundleInstrumentation(
  file: string,
  config: ResolvedConfig,
  outfile: string,
  releaseDir?: string,
) {
  const root = config.root
  const tsconfig = path.join(root, 'tsconfig.json')
  // A release instance finds its source relative to itself, never at the build machine's path.
  const sourceUrl = releaseDir
    ? `new URL(${JSON.stringify(path.relative(releaseDir, file).split(path.sep).join('/'))}, import.meta.url).href`
    : JSON.stringify(pathToFileURL(file).href)
  await build({
    entryPoints: [file],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'esnext',
    packages: 'external',
    plugins: [instrumentationPlugin(root, config)],
    ...(existsSync(tsconfig) ? { tsconfig } : {}),
    banner: {
      js:
        'import { fileURLToPath as __pnextFileURLToPath } from "node:url";\n' +
        'import { dirname as __pnextDirname } from "node:path";\n' +
        `const __pnextSourceUrl = ${sourceUrl};\n` +
        'const __pnextSourceFile = __pnextFileURLToPath(__pnextSourceUrl);\n' +
        'const __pnextSourceDir = __pnextDirname(__pnextSourceFile);',
    },
    define: {
      __dirname: '__pnextSourceDir',
      __filename: '__pnextSourceFile',
      'import.meta.url': '__pnextSourceUrl',
    },
    logLevel: 'silent',
    sourcemap: false,
  })
}

/**
 * Load instrumentation and run register() once. Idempotent: repeated calls
 * (build + start both run init hooks) reuse the first load. Returns immediately;
 * the register() completion is tracked by instrumentationReady().
 */
export function loadInstrumentation(config: ResolvedConfig): void {
  if (readyGate) return
  const released = productionRelease(config)
  if (released) {
    readyGate = registerReleased(released.instrumentation)
    return
  }
  const file = findInstrumentation(config)
  if (!file) {
    readyGate = Promise.resolve()
    return
  }
  readyGate = (async () => {
    try {
      // Next exposes the active runtime to register()/onRequestError via
      // NEXT_RUNTIME. pnext serves everything from a single Node process, so the
      // baseline runtime is 'nodejs' (edge-only fixtures still run here).

      // eslint-disable-next-line turbo/no-undeclared-env-vars
      if (!process.env.NEXT_RUNTIME) process.env.NEXT_RUNTIME = 'nodejs'
      loaded = await importInstrumentation(file, config)
      await loaded.register?.()
      if (appHasEdgeEntities(config)) await runEdgeRegisterPass(file, config)
    } catch (error) {
      console.error('instrumentation register() failed:', error)
    }
  })()
}

/** A release's prebuilt instrumentation: register() on the node instance, then the edge instance. */
async function registerReleased(instrumentation: { file?: string; edge?: string } | undefined) {
  if (!instrumentation?.file) return
  try {
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    if (!process.env.NEXT_RUNTIME) process.env.NEXT_RUNTIME = 'nodejs'
    loaded = (await import(pathToFileURL(instrumentation.file).href)) as InstrumentationModule
    await loaded.register?.()
    if (instrumentation.edge) {
      await withEdgeRuntime(async () => {
        const edgeInstance = (await import(
          pathToFileURL(instrumentation.edge!).href
        )) as InstrumentationModule
        await edgeInstance.register?.()
      }, 'instrumentation register() (edge pass) failed:')
    }
  } catch (error) {
    console.error('instrumentation register() failed:', error)
  }
}

/**
 * The edge boot pass: a fresh instrumentation instance registered with NEXT_RUNTIME='edge' for the
 * duration of the call. A double provider registration is harmless - @opentelemetry/api rejects a second
 * global registration and keeps the first.
 */
async function runEdgeRegisterPass(file: string, config: ResolvedConfig): Promise<void> {
  await withEdgeRuntime(async () => {
    const edgeInstance = await importInstrumentation(file, config, '.edge')
    await edgeInstance.register?.()
  }, 'instrumentation register() (edge pass) failed:')
}

/** Run `task` with NEXT_RUNTIME='edge', restoring the previous value. */
async function withEdgeRuntime(task: () => Promise<void>, failure: string): Promise<void> {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const previous = process.env.NEXT_RUNTIME
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  process.env.NEXT_RUNTIME = 'edge'
  try {
    await task()
  } catch (error) {
    console.error(failure, error)
  } finally {
    if (previous === undefined) {
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      delete process.env.NEXT_RUNTIME
    } else {
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      process.env.NEXT_RUNTIME = previous
    }
  }
}

const SOURCE_FILE_RE = /\.(?:ts|tsx|js|jsx|mjs|mts|cjs|cts)$/
// `export const runtime = 'edge'` (app router) or `config = { runtime:
// 'edge' | 'experimental-edge' }` (pages router / API routes).
const EDGE_RUNTIME_RE = /\bruntime\b\s*[:=]\s*['"](?:experimental-)?edge['"]/

/**
 * Whether the app contains anything Next would boot the edge runtime for:
 * a middleware/proxy file, or any app/pages source declaring an edge runtime.
 * Only evaluated when an instrumentation file exists (a bounded one-time scan
 * at boot; apps without instrumentation never pay).
 */
function appHasEdgeEntities(config: ResolvedConfig): boolean {
  const roots = [config.root, path.join(config.root, 'src')]
  for (const root of roots) {
    for (const name of ['middleware', 'proxy']) {
      for (const ext of ['ts', 'js', 'mts', 'mjs']) {
        if (existsSync(path.join(root, `${name}.${ext}`))) return true
      }
    }
    for (const dir of ['app', 'pages']) {
      if (sourceTreeDeclaresEdgeRuntime(path.join(root, dir))) return true
    }
  }
  return false
}

function sourceTreeDeclaresEdgeRuntime(dir: string): boolean {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return false
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = path.join(dir, entry)
    let stats
    try {
      stats = statSync(full)
    } catch {
      continue
    }
    if (stats.isDirectory()) {
      if (sourceTreeDeclaresEdgeRuntime(full)) return true
      continue
    }
    if (!SOURCE_FILE_RE.test(entry)) continue
    try {
      if (EDGE_RUNTIME_RE.test(readFileSync(full, 'utf8'))) return true
    } catch {
      // unreadable file — skip
    }
  }
  return false
}
