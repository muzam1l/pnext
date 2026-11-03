// The vm realm Next's edge middleware runs in. Loaded on the first sandboxed middleware import or
// release emit, so a server without edge middleware never pays for it.
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { types } from 'node:util'
import vm from 'node:vm'
import type { Plugin } from 'esbuild'
import type { ResolvedConfig } from '../../config'
import { getBundlerExtensions, serverDefineOptions } from '../../extensions'
import { productionRelease, type CompatReleaseFacts } from '../../runtime/production'
import { findInstrumentation } from '../lifecycle/instrumentation'
import { edgeSandbox, type OtelApi } from '../otel/api'
import { edgeProcess } from './index'

interface SandboxBundle {
  code: string
  /** The source (dev) or artifact (release) the bundle's relative host links resolve from. */
  file: string
  inputs: Map<string, number>
}

interface Sandbox {
  file: string
  context: vm.Context
  instrumentation?: SandboxBundle
  proxy: SandboxBundle
  module: Record<string, unknown>
  otel?: OtelApi
}

const sandboxes = new WeakMap<ResolvedConfig, Promise<Sandbox>>()

export async function importEdgeMiddleware(
  config: ResolvedConfig,
  file: string,
): Promise<Record<string, unknown>> {
  const previous = sandboxes.get(config)?.catch(() => undefined)
  const sandbox = Promise.resolve(previous).then(last => refreshSandbox(config, file, last))
  sandboxes.set(config, sandbox)
  const { module, otel } = await sandbox
  edgeSandbox.otel = otel
  return module
}

async function refreshSandbox(
  config: ResolvedConfig,
  file: string,
  previous: Sandbox | undefined,
): Promise<Sandbox> {
  const prebuilt = productionRelease(config)?.compat?.edgeSandbox
  if (prebuilt) {
    if (previous) return previous
    const read = (artifact: string): SandboxBundle => {
      const out = path.resolve(config.outPath, artifact)
      return { code: readFileSync(out, 'utf8'), file: out, inputs: new Map() }
    }
    return createSandbox(
      config,
      file,
      read(prebuilt.proxy),
      prebuilt.instrumentation ? read(prebuilt.instrumentation) : undefined,
    )
  }
  const instrumentation = findInstrumentation(config)
  const same = previous?.file === file ? previous : undefined
  const realm =
    same?.instrumentation?.file === instrumentation && isFresh(same?.instrumentation)
      ? same
      : undefined
  const proxy = same && isFresh(same.proxy) ? same.proxy : undefined
  if (realm && proxy) return realm
  const [proxyBundle, instrumentationBundle] = await Promise.all([
    proxy ?? bundleSandboxEntry(config, file, true),
    !realm && instrumentation ? bundleSandboxEntry(config, instrumentation) : undefined,
  ])
  if (!realm) return createSandbox(config, file, proxyBundle, instrumentationBundle)
  return { ...realm, proxy: proxyBundle, ...(await evaluateProxy(realm.context, proxyBundle)) }
}

function isFresh(bundle: SandboxBundle | undefined) {
  for (const [input, mtime] of bundle?.inputs ?? [])
    if (statSync(input, { throwIfNoEntry: false })?.mtimeMs !== mtime) return false
  return true
}

/** A new realm: the app's instrumentation registers in it (Next's edge pass), then the middleware evaluates. */
async function createSandbox(
  config: ResolvedConfig,
  file: string,
  proxy: SandboxBundle,
  instrumentation: SandboxBundle | undefined,
): Promise<Sandbox> {
  const context = createRealm(config)
  if (instrumentation) {
    try {
      const { module } = (await evaluateInSandbox(context, instrumentation)) as {
        module: { register?: () => unknown }
      }
      await module.register?.()
    } catch (error) {
      console.error('instrumentation register() (edge pass) failed:', hostError(error))
    }
  }
  return { file, context, proxy, instrumentation, ...(await evaluateProxy(context, proxy)) }
}

async function evaluateProxy(context: vm.Context, proxy: SandboxBundle) {
  const { module: namespace, otel } = (await evaluateInSandbox(context, proxy)) as {
    module: Record<string, unknown>
    otel: Partial<OtelApi>
  }
  // The handlers rethrow the realm's errors as host errors.
  const module = { ...namespace }
  for (const name of ['proxy', 'default', 'middleware']) {
    const handler = module[name]
    if (typeof handler !== 'function') continue
    module[name] = async (...args: unknown[]) => {
      try {
        return await (handler as (...args: unknown[]) => unknown)(...args)
      } catch (error) {
        throw hostError(error)
      }
    }
  }
  return { module, otel: otel.trace ? (otel as OtelApi) : undefined }
}

/** An error built by the realm's own `Error` intrinsic, as a host `Error` (`instanceof` holds again). */
function hostError(error: unknown): unknown {
  if (error instanceof Error || !types.isNativeError(error)) return error
  const host = Object.assign(new Error(error.message, { cause: error.cause }), error)
  host.name = error.name
  host.stack = error.stack
  return host
}

export async function emitEdgeSandbox(
  config: ResolvedConfig,
  file: string,
  outDir: string,
): Promise<CompatReleaseFacts['edgeSandbox']> {
  const instrumentation = findInstrumentation(config)
  const [proxy, instrumentationBundle] = await Promise.all([
    bundleSandboxEntry(config, file, true),
    instrumentation ? bundleSandboxEntry(config, instrumentation) : undefined,
  ])
  const { relocateReleaseBundle } = await import('../../runtime/modules')
  await mkdir(outDir, { recursive: true })
  const emit = async (name: string, bundle: SandboxBundle) => {
    const relocated = relocateReleaseBundle(config, path.join(outDir, `${name}.mjs`), bundle.code)
    const out = path.join(outDir, `${name}.${Bun.hash(relocated).toString(36)}.mjs`)
    await writeFile(out, relocated)
    return path.relative(config.outPath, out).split(path.sep).join('/')
  }
  return {
    proxy: await emit('middleware.edge', proxy),
    instrumentation:
      instrumentationBundle && (await emit('instrumentation.sandbox', instrumentationBundle)),
  }
}

/** Bundle `file` for the sandbox: packages inlined with the edge conditions, host modules external. */
async function bundleSandboxEntry(
  config: ResolvedConfig,
  file: string,
  middleware = false,
): Promise<SandboxBundle> {
  // Build-side modules load here, never in a production server's static graph.
  const [{ build }, loader] = await Promise.all([
    import('../../utils/esbuild'),
    import('../../runtime/loader'),
  ])
  const tsconfig = path.join(config.root, 'tsconfig.json')
  const result = await build({
    stdin: {
      // Sandboxing requires the app's `@opentelemetry/api`; the realm gets its own instance.
      contents:
        `import * as __module from ${JSON.stringify(file)};\nexport { __module as module };\n` +
        (middleware ? `export * as otel from '@opentelemetry/api';\n` : ''),
      resolveDir: path.dirname(file),
      sourcefile: `${file}.sandbox.ts`,
      loader: 'ts',
    },
    absWorkingDir: config.root,
    bundle: true,
    write: false,
    metafile: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    conditions: loader.serverBundleConditions('edge'),
    mainFields: ['module', 'main'],
    loader: loader.packageJsxLoaders,
    jsx: 'automatic',
    jsxImportSource: 'preact',
    logLevel: 'silent',
    ...(existsSync(tsconfig) ? { tsconfig } : {}),
    ...serverDefineOptions(),
    plugins: [
      loader.serverAssetPlugin(config),
      loader.runtimeAliasBuildPlugin(config, 'server', { reactServerLayer: true }),
      ...getBundlerExtensions().serverEsbuildPlugins(config),
      sandboxResolvePlugin,
    ],
  })
  const inputs = new Map<string, number>()
  for (const input of Object.keys(result.metafile.inputs)) {
    if (input.includes('node_modules/')) continue
    const absolute = path.resolve(config.root, input)
    const stat = statSync(absolute, { throwIfNoEntry: false })
    if (stat) inputs.set(absolute, stat.mtimeMs)
  }
  return { code: result.outputFiles[0]?.text ?? '', file, inputs }
}

const RESOLVE_PROBE = Symbol('pnext-edge-sandbox-probe')

/** Node builtins stay host modules; an unresolvable package throws when evaluated, as webpack's missing modules do. */
const sandboxResolvePlugin: Plugin = {
  name: 'pnext-edge-sandbox-resolve',
  setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, async args => {
      if (isBuiltin(args.path)) return { path: args.path, external: true }
      if (args.pluginData === RESOLVE_PROBE) return undefined
      const resolved = await builder.resolve(args.path, {
        importer: args.importer,
        resolveDir: args.resolveDir,
        kind: args.kind,
        pluginData: RESOLVE_PROBE,
      })
      return resolved.errors.length
        ? { path: args.path, namespace: 'pnext-missing-module' }
        : resolved
    })
    builder.onLoad({ filter: /.*/, namespace: 'pnext-missing-module' }, args => ({
      contents: `throw new Error(${JSON.stringify(`Cannot find module '${args.path}'`)})`,
      loader: 'js',
    }))
  },
}

/** Evaluate an ESM bundle in `context`, linking its externals to the host's module instances. */
async function evaluateInSandbox(context: vm.Context, bundle: SandboxBundle): Promise<unknown> {
  const url = pathToFileURL(bundle.file).href
  const module = new vm.SourceTextModule(bundle.code, {
    context,
    identifier: url,
    initializeImportMeta(meta) {
      meta.url = url
    },
    importModuleDynamically: async specifier => {
      const linked = await linkHost(specifier, url, context)
      await linked.link(() => linked)
      await linked.evaluate()
      return linked
    },
  })
  await module.link(specifier => linkHost(specifier, url, context))
  await module.evaluate()
  return module.namespace
}

/** A host module (a `next/*` alias, a Node builtin) as a module of the realm. */
async function linkHost(specifier: string, url: string, context: vm.Context) {
  const target =
    isBuiltin(specifier) || /^[a-z]+:/.test(specifier) ? specifier : new URL(specifier, url).href
  const namespace = (await import(target)) as Record<string, unknown>
  const names = Object.keys(namespace)
  return new vm.SyntheticModule(
    names,
    function () {
      for (const name of names) this.setExport(name, namespace[name])
    },
    { context },
  )
}

// The Edge runtime's globals (Next's `edge-runtime` primitives), taken from the host where it has them.
const EDGE_GLOBALS =
  `AbortController AbortSignal Blob BroadcastChannel Buffer ByteLengthQueuingStrategy
  CompressionStream CountQueuingStrategy Crypto CryptoKey CustomEvent DecompressionStream DOMException
  Event EventTarget File FormData Headers MessageChannel MessageEvent MessagePort Performance
  PerformanceEntry PerformanceMark PerformanceMeasure PerformanceObserver PerformanceObserverEntryList
  PerformanceResourceTiming ReadableByteStreamController ReadableStream ReadableStreamBYOBReader
  ReadableStreamBYOBRequest ReadableStreamDefaultController ReadableStreamDefaultReader Request Response
  SubtleCrypto TextDecoder TextDecoderStream TextEncoder TextEncoderStream TransformStream
  TransformStreamDefaultController URL URLPattern URLSearchParams WebSocket WritableStream
  WritableStreamDefaultController WritableStreamDefaultWriter atob btoa clearImmediate clearInterval
  clearTimeout console crypto fetch navigator performance queueMicrotask reportError setImmediate
  setInterval setTimeout structuredClone`.split(/\s+/)

// Next's EdgeVM lets host values pass the realm's `instanceof` (a TextEncoder's Uint8Array, a fetch's Error).
const TRANSFERABLE_CONSTRUCTORS =
  'Object Array RegExp Uint8Array ArrayBuffer Error SyntaxError TypeError'.split(' ')

const PATCH_REALM = `(hosts) => {
  globalThis.self = globalThis
  const ordinary = Function.prototype[Symbol.hasInstance]
  for (const [name, host] of Object.entries(hosts)) {
    const own = globalThis[name]
    Object.defineProperty(own, Symbol.hasInstance, {
      value(value) { return ordinary.call(this, value) || (this === own && value instanceof host) },
    })
  }
}`

function createRealm(config: ResolvedConfig): vm.Context {
  const host = globalThis as Record<string, unknown>
  const pick = (names: string[]) => Object.fromEntries(names.map(name => [name, host[name]]))
  const context = vm.createContext({
    ...pick(EDGE_GLOBALS),
    EdgeRuntime: 'edge-runtime',
    AsyncLocalStorage,
    // Packages bundled from CommonJS reach Node builtins through esbuild's `require` fallback.
    require: createRequire(path.join(config.root, 'package.json')),
    // A snapshot, as in Next's sandbox: the realm's own env writes never reach the host.
    process: edgeProcess(process, { ...process.env, NEXT_RUNTIME: 'edge' }),
  })
  ;(vm.runInContext(PATCH_REALM, context) as (hosts: Record<string, unknown>) => void)(
    pick(TRANSFERABLE_CONSTRUCTORS),
  )
  return context
}
