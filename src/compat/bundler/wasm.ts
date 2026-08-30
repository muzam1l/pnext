import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Plugin } from 'esbuild'
import type { ResolvedConfig } from '../../config'

interface WasmManifestBinding {
  name: string
  filePath: string
}

const WASM_MODULE_FILTER = /\.wasm\?module(?:[?#].*)?$/

// Keep one normalized binding list per build output root, so middleware manifest
// emission can include the same `wasm` entries Next’s real middleware manifest
// emits.
const manifestWasmBindings = new Map<string, Map<string, WasmManifestBinding>>()

function outPathKey(outPath: string): string {
  return path.resolve(outPath)
}

function sourcePathFromSpecifier(specifier: string, resolveDir: string): string | undefined {
  const [sourcePath] = specifier.split(/[?#]/, 1)
  if (!sourcePath) return undefined
  return path.isAbsolute(sourcePath) ? sourcePath : path.resolve(resolveDir, sourcePath)
}

function assetFileName(bytes: Uint8Array) {
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
  return `wasm_${hash}.wasm`
}

function registerManifestBinding(outPath: string, sourcePath: string, name: string) {
  const key = outPathKey(outPath)
  const bySource = manifestWasmBindings.get(key) ?? new Map<string, WasmManifestBinding>()
  bySource.set(sourcePath, { name, filePath: `server/edge-chunks/${name}` })
  manifestWasmBindings.set(key, bySource)
}

export function readMiddlewareWasmBindingsForOutPath(outPath: string): WasmManifestBinding[] {
  const key = outPathKey(outPath)
  const bindings = manifestWasmBindings.get(key)
  if (!bindings || bindings.size === 0) return []
  return [...bindings.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Compile-time support for `import wasm from './file.wasm?module'` in server/edge
 * graphs:
 *   - emits a compiled `.wasm` file under `server/edge-chunks/` (Next-shaped
 *     output location),
 *   - returns a module exporting a precompiled `WebAssembly.Module`,
 *   - records the emitted wasm binding for middleware manifest emission.
 *
 * This avoids runtime dynamic compile for middleware/edge modules and keeps
 * `.wasm` usable when imported with `?module` (the legacy semantics expected by
 * Next tests).
 */
// The bare form (`import { add } from './add.wasm'`) is turbopack's default
// wasm semantics: the module's own exports become the module's named exports.
const WASM_FILTER = /\.wasm(?:[?#].*)?$/
const WASM_INSTANCE_NAMESPACE = 'pnext-wasm-instance'
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * ESM source instantiating `bytes` and re-exporting the wasm module's own exports by name (plus the
 * exports object as `default`). Instantiation is synchronous - the same shape turbopack emits, and what
 * lets a consumer call an export at module scope.
 */
function wasmInstanceModuleSource(bytes: Uint8Array): string {
  const names = WebAssembly.Module.exports(new WebAssembly.Module(bytes.buffer as ArrayBuffer))
    .map(entry => entry.name)
    .filter(name => IDENTIFIER.test(name))
  return [
    `const bytes = Uint8Array.from(atob(${JSON.stringify(Buffer.from(bytes).toString('base64'))}), c => c.charCodeAt(0));`,
    'const wasmExports = new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports;',
    ...names.map(name => `export const ${name} = wasmExports[${JSON.stringify(name)}];`),
    'export default wasmExports;',
  ].join('\n')
}

/**
 * Bun runtime hook for bare `.wasm` imports in the SERVER runtime's own module loading - the graph a
 * loader's `this.importModule()` target pulls in, which never passes through an esbuild build. Bun's
 * native `.wasm` loader exposes no named exports, so a named import would bind undefined. Idempotent
 * per project root.
 */
export function registerWasmModuleRuntime(config: ResolvedConfig): void {
  const root = path.resolve(config.root)
  if (wasmRuntimeRoots.has(root)) return
  wasmRuntimeRoots.add(root)
  Bun.plugin({
    name: `pnext-compat-wasm-runtime-${root}`,
    setup(plugin) {
      plugin.onLoad({ filter: /\.wasm$/ }, async ({ path: file }) => ({
        contents: wasmInstanceModuleSource(new Uint8Array(await readFile(file))),
        loader: 'js',
      }))
    },
  })
}

const wasmRuntimeRoots = new Set<string>()

export function wasmModulePlugin(config: ResolvedConfig): Plugin {
  const edgeChunkDir = path.join(config.outPath, 'server', 'edge-chunks')
  return {
    name: 'pnext-compat-wasm-module',
    setup(build) {
      build.onResolve({ filter: WASM_MODULE_FILTER }, args => {
        const sourcePath = sourcePathFromSpecifier(args.path, args.resolveDir)
        if (!sourcePath) return undefined
        return { path: sourcePath, namespace: 'pnext-wasm-module' }
      })

      build.onLoad({ filter: /.*/, namespace: 'pnext-wasm-module' }, async args => {
        const sourcePath = path.resolve(args.path)
        const bytes = new Uint8Array(await readFile(sourcePath))
        const name = assetFileName(bytes)
        const outFile = path.join(edgeChunkDir, name)
        if (!existsSync(outFile)) {
          await mkdir(path.dirname(outFile), { recursive: true })
          await writeFile(outFile, bytes)
        }
        registerManifestBinding(config.outPath, sourcePath, name)
        const moduleBytes = JSON.stringify([...bytes])
        return {
          contents: [
            `const bytes = new Uint8Array(${moduleBytes});`,
            'const module = new WebAssembly.Module(bytes.buffer);',
            'export default module;',
          ].join('\n'),
          loader: 'js',
        }
      })

      // Bare `.wasm` (no `?module`): the instance's exports ARE the module's.
      build.onResolve({ filter: WASM_FILTER }, args => {
        if (WASM_MODULE_FILTER.test(args.path)) return undefined
        const sourcePath = sourcePathFromSpecifier(args.path, args.resolveDir)
        return sourcePath ? { path: sourcePath, namespace: WASM_INSTANCE_NAMESPACE } : undefined
      })
      build.onLoad({ filter: /.*/, namespace: WASM_INSTANCE_NAMESPACE }, async args => ({
        contents: wasmInstanceModuleSource(new Uint8Array(await readFile(path.resolve(args.path)))),
        loader: 'js',
      }))
    },
  }
}
