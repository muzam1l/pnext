/**
 * Prebundled production server entry: `pnext build` bundles the framework's server graph into one JS
 * file (entry point IS src/cli/start.ts, so the identical `start()` runs) and `pnext start` parses
 * that instead of walking hundreds of source modules - the dominant share of spawn->first-200.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Plugin as EsbuildPlugin } from 'esbuild'
import { frameworkFingerprint } from '../../runtime/fingerprint'

const frameworkRoot = path.resolve(import.meta.dirname, '..', '..', '..')

/** Stamped into the filename so an upgraded framework never runs a stale bundle. */
function frameworkVersion(): string {
  try {
    const pkg = readFileSync(path.join(frameworkRoot, 'package.json'), 'utf8')
    return (JSON.parse(pkg) as { version?: string }).version ?? '0'
  } catch {
    return '0'
  }
}

/**
 * Version AND framework fingerprint: the version alone let an edited `src` keep serving the bundle
 * built from the previous source, so a fix appeared to have no effect until the app was rebuilt.
 * The fingerprint is the same one every other compiled artifact is keyed on, taken through the
 * cache-root record so a restart pays one stat per file rather than re-reading the tree.
 */
export function serverEntryDir(outPath: string): string {
  // Cache root spelled inline, not imported: this module is parsed before anything else on the
  // start path, and pulling in the module cache for one path.join would drag its whole graph along.
  const generation = frameworkFingerprint(path.join(outPath, 'cache', 'server'))
  return path.join(outPath, 'server', `bundle-${frameworkVersion()}-${generation}`)
}

function serverEntryFile(outPath: string): string {
  return path.join(serverEntryDir(outPath), 'entry.js')
}

/**
 * The prebuilt entry for a project root, or undefined when there is none to
 * use (no build, a custom `outDir`, a version or source-generation mismatch, or the opt-out). The
 * caller then falls back to importing src/cli/start.ts directly, so a miss only
 * costs speed. Deliberately cheap: one existsSync and one package.json read,
 * because it runs before anything else on the start path.
 */
export function prebuiltServerEntry(root = process.cwd()): string | undefined {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  if (process.env.PNEXT_NO_SERVER_BUNDLE === '1') return undefined
  const file = serverEntryFile(path.resolve(root, '.pnext'))
  return existsSync(file) ? pathToFileURL(file).href : undefined
}

/**
 * Bundle src/cli/start.ts under `<outPath>/server/bundle-<version>-<fingerprint>/`. Bare
 * specifiers stay external (the framework's deps are already plain JS), so only
 * the framework's own source is inlined. Splitting is on so the graph behind a
 * dynamic import (compat, dev, build) stays in its own chunk — folding it into
 * the entry would evaluate eagerly what the source graph never even reads.
 * Returns the emitted entry, or undefined when bundling failed — the build must
 * not fail over a start-time optimization.
 */
export async function emitServerEntry(outPath: string): Promise<string | undefined> {
  const { build } = await import('../../utils/esbuild')
  try {
    await build({
      entryPoints: [path.join(import.meta.dirname, '..', 'start.ts')],
      outdir: serverEntryDir(outPath),
      entryNames: 'entry',
      chunkNames: '[name]-[hash]',
      bundle: true,
      splitting: true,
      format: 'esm',
      platform: 'node',
      target: 'esnext',
      sourcemap: false,
      tsconfig: path.join(frameworkRoot, 'tsconfig.json'),
      logLevel: 'silent',
      // esbuild's ESM `require` shim throws for anything it did not bundle; the
      // framework's lazy `require('esbuild' | 'oxc-*')` facades need a real one,
      // anchored at the framework so they load ITS copy, not the app's.
      banner: {
        js:
          'import { createRequire as __pnextCreateRequire } from "node:module";\n' +
          `const require = __pnextCreateRequire(${JSON.stringify(
            pathToFileURL(path.join(frameworkRoot, 'package.json')).href,
          )});`,
      },
      plugins: [await serverEntryPlugin(outPath)],
    })
    return serverEntryFile(outPath)
  } catch (error) {
    console.warn(`pnext build: server entry bundling skipped — ${(error as Error).message}`)
    return undefined
  }
}

/**
 * Emit in a short-lived child process: the bundle's source strings and parse
 * allocations land in the child's heap (well under the build's own peak), not
 * on top of it. Falls back to in-process emission if the spawn fails.
 */
export async function emitServerEntryChild(outPath: string): Promise<void> {
  try {
    const child = Bun.spawn([process.execPath, import.meta.filename, outPath], {
      stdout: 'ignore',
      stderr: 'inherit',
    })
    if ((await child.exited) === 0) return
  } catch {
    // fall through to in-process emission
  }
  await emitServerEntry(outPath)
}

async function serverEntryPlugin(outPath: string): Promise<EsbuildPlugin> {
  const { rewriteFacts } = await import('../../resolve/scan-facts')
  const { spliceSource } = await import('../../runtime/module-transform')
  return {
    name: 'pnext-server-entry',
    setup(build) {
      // Bare specifiers (and node builtins) stay out of the bundle. They must
      // still resolve to the SAME file the framework's own source graph would
      // reach: keep the specifier bare when the output directory resolves it
      // identically (portable), otherwise pin the absolute path.
      build.onResolve({ filter: /^[^./]/ }, args => {
        if (args.path.startsWith('node:')) return { path: args.path, external: true }
        const target = resolveFrom(args.path, frameworkRoot)
        if (!target) return { path: args.path, external: true }
        const fromOutput = resolveFrom(args.path, serverEntryDir(outPath))
        return { path: fromOutput === target ? args.path : target, external: true }
      })
      // `import.meta` in a bundled module still means the ORIGINAL source file
      // (the framework locates its own runtime shims that way). oxc's exact
      // spans keep occurrences in strings and comments untouched.
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => {
        const source = await Bun.file(args.path).text()
        if (!source.includes('import.meta')) return undefined
        const facts = rewriteFacts(args.path, source)
        if (facts.unreliable) return undefined
        const edits = facts.importMetas.flatMap(meta => {
          const value = importMetaValue(source.slice(meta.end, meta.end + 16), args.path)
          return value
            ? [{ start: meta.start, end: meta.end + value.length, value: value.code }]
            : []
        })
        if (edits.length === 0) return undefined
        return { contents: spliceSource(source, edits), loader: loaderFor(args.path) }
      })
    },
  }
}

const importMetaProperties = ['dirname', 'filename', 'resolve', 'url', 'dir'] as const

/** The literal a bundled `import.meta.<prop>` must become, given the tail after `import.meta`. */
function importMetaValue(tail: string, file: string): { code: string; length: number } | undefined {
  const property = importMetaProperties.find(name => new RegExp(`^\\.${name}\\b`).test(tail))
  if (!property) return undefined
  const length = property.length + 1
  const dir = path.dirname(file)
  if (property === 'dirname' || property === 'dir') return { code: JSON.stringify(dir), length }
  if (property === 'filename') return { code: JSON.stringify(file), length }
  if (property === 'url') return { code: JSON.stringify(pathToFileURL(file).href), length }
  return {
    code: `(specifier => Bun.pathToFileURL(Bun.resolveSync(specifier, ${JSON.stringify(dir)})).href)`,
    length,
  }
}

function loaderFor(file: string): 'ts' | 'tsx' | 'js' | 'jsx' {
  if (file.endsWith('.tsx')) return 'tsx'
  if (file.endsWith('.jsx')) return 'jsx'
  return /\.[cm]?ts$/.test(file) ? 'ts' : 'js'
}

function resolveFrom(specifier: string, dir: string): string | undefined {
  try {
    return Bun.resolveSync(specifier, dir)
  } catch {
    return undefined
  }
}

// Child-process entry for emitServerEntryChild; last so every binding above is initialized.
if (import.meta.main && process.argv[2]) {
  const emitted = await emitServerEntry(process.argv[2])
  process.exit(emitted ? 0 : 1)
}
