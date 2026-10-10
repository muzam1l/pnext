// Publish-time prebundle of the production runtime into dist/server: ESM chunks the installed
// package loads instead of parsing src at every start. Runs from `prepack`; `postpack` removes it.
import { rm, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { internalSourceFiles } from './source-boundary'
import { rewriteFacts } from '../src/resolve/scan-facts'
import { spliceSource } from '../src/runtime/module-transform'
import { computeFrameworkFingerprint } from '../src/runtime/fingerprint'
import {
  PREBUNDLE_STAMP,
  runtimeEntryDirs,
  runtimeEntryFiles,
  type PrebundleStamp,
} from '../src/runtime/prebundle'

const root = path.resolve(import.meta.dirname, '..')
const src = path.join(root, 'src')
const outdir = path.join(root, 'dist', 'server')
const PACKAGE_ROOT = '__PNEXT_PACKAGE_ROOT__'
const SOURCE = '__PNEXT_SOURCE__/'
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
  version: string
  exports: Record<string, string>
}

// What `@wular/pnext` exports resolves to, plus its imports: dist imports this closure from src
// instead of inlining it, so a host and the runtime share one instance whichever loads first.
const shared = new Set(
  Object.values(pkg.exports)
    .filter(target => target.startsWith('./src/'))
    .map(target => path.join(root, target)),
)
const scanner = {
  ts: new Bun.Transpiler({ loader: 'ts' }),
  tsx: new Bun.Transpiler({ loader: 'tsx' }),
}
for (const file of shared) {
  const code = await readFile(file, 'utf8')
  for (const edge of scanner[file.endsWith('.tsx') ? 'tsx' : 'ts'].scanImports(code)) {
    if (edge.path.startsWith('.')) shared.add(Bun.resolveSync(edge.path, path.dirname(file)))
  }
}

// Everything else app code can import at runtime is an entry, so app imports and the runtime share
// one instance of each module through common chunks.
const entrypoints = [
  ...['cli/index.ts', ...runtimeEntryFiles].map(file => path.join(src, file)),
  ...runtimeEntryDirs.flatMap(dir => internalSourceFiles(path.join(src, dir), /(?<!\.d)\.tsx?$/)),
].filter(file => !shared.has(file))

const fingerprint = computeFrameworkFingerprint(src)
await rm(path.join(root, 'dist'), { recursive: true, force: true })
const result = await Bun.build({
  entrypoints,
  root: src,
  outdir,
  target: 'bun',
  format: 'esm',
  splitting: true,
  packages: 'external',
  naming: { entry: '[dir]/[name].js', chunk: '_chunks/[name]-[hash].js' },
  define: {
    PNEXT_PREBUNDLE: JSON.stringify({
      version: pkg.version,
      fingerprint,
      entries: entrypoints.map(file => path.relative(src, file).replace(/\.tsx?$/, '')),
    }),
  },
  plugins: [
    {
      name: 'pnext-package-paths',
      setup(build) {
        build.onResolve({ filter: new RegExp(`^${SOURCE}`) }, args => ({
          path: args.path,
          external: true,
        }))
        // `import.meta` inside a chunk names the chunk; point it back at the module's own file in
        // the installed package so framework resources resolve as they do from source. Imports of
        // the shared closure become markers the pass below turns into relative src paths.
        build.onLoad({ filter: /\.tsx?$/ }, async args => {
          const source = await readFile(args.path, 'utf8')
          const loader = args.path.endsWith('.tsx') ? 'tsx' : 'ts'
          const facts = rewriteFacts(args.path, source)
          if (facts.unreliable) throw new Error(`prebundle: cannot parse ${args.path}`)
          const file = path.relative(root, args.path)
          const metas = facts.importMetas.flatMap(meta => {
            const property = /^\.(dirname|dir|filename|path|url)\b/.exec(
              source.slice(meta.end, meta.end + 10),
            )?.[1]
            if (!property) return []
            const value =
              property === 'url'
                ? `Bun.pathToFileURL(${PACKAGE_ROOT} + ${JSON.stringify(`/${file}`)}).href`
                : `(${PACKAGE_ROOT} + ${JSON.stringify(`/${property === 'dirname' || property === 'dir' ? path.dirname(file) : file}`)})`
            return [{ start: meta.start, end: meta.end + property.length + 1, value }]
          })
          // A statement can surface as more than one edge over the same literal.
          const literals = new Map(facts.edges.map(edge => [edge.start, edge]))
          const imports = [...literals.values()].flatMap(edge => {
            if (!edge.specifier.startsWith('.')) return []
            const target = Bun.resolveSync(edge.specifier, path.dirname(args.path))
            if (!shared.has(target)) return []
            return [{ ...edge, value: JSON.stringify(`${SOURCE}${path.relative(src, target)}`) }]
          })
          const edits = [...metas, ...imports]
          return { contents: edits.length ? spliceSource(source, edits) : source, loader }
        })
      },
    },
  ],
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

for (const output of result.outputs) {
  const original = await readFile(output.path, 'utf8')
  const up = path.relative(path.dirname(output.path), root)
  let code = original.replaceAll(SOURCE, `${up}/src/`)
  if (code.includes(PACKAGE_ROOT)) {
    // After the `// @bun` pragma, which only a shebang may precede.
    const newline = code.indexOf('\n', code.indexOf('// @bun')) + 1
    code =
      code.slice(0, newline) +
      `import { join as __pnextJoin } from "node:path";\nconst ${PACKAGE_ROOT} = __pnextJoin(import.meta.dirname, ${JSON.stringify(up)});\n` +
      code.slice(newline)
  }
  if (code !== original) await writeFile(output.path, code)
}
// Last: its presence marks dist complete.
const stamp: PrebundleStamp = {
  version: pkg.version,
  fingerprint,
  source: [...shared].map(file => path.relative(root, file)).sort(),
}
await writeFile(path.join(root, PREBUNDLE_STAMP), JSON.stringify(stamp))
console.log(`prebundle: ${result.outputs.length} files in ${path.relative(root, outdir)}`)
