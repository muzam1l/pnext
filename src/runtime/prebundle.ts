// The published package runs production from dist/server (scripts/prebundle.ts). There, app imports
// of framework source resolve to the same prebundled modules, so the process holds one instance of
// each registry. A source checkout has no prebundle and resolves source as before.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Source modules production can import: the start entry and everything app code reaches at runtime. */
export const runtimeEntryFiles = ['cli/start.ts', 'index.ts', 'internal.ts', 'client/reference.ts']
export const runtimeEntryDirs = ['api', 'compat/next', 'compat/react']

/** Written last by the prebundle: dist is complete, and built from this version and source. */
export const PREBUNDLE_STAMP = path.join('dist', 'server', 'generation.json')

export interface PrebundleStamp {
  version: string
  fingerprint: string
  /** Package-relative sources dist imports rather than inlines: the public API closure. */
  source: string[]
}

declare const PNEXT_PREBUNDLE:
  { version: string; fingerprint: string; entries: string[] } | undefined

const prebundle = typeof PNEXT_PREBUNDLE === 'object' ? PNEXT_PREBUNDLE : undefined
const packageRoot = path.resolve(import.meta.dirname, '..', '..')
const srcRoot = path.join(packageRoot, 'src') + path.sep
const distRoot = path.join(packageRoot, 'dist', 'server')
const entries = new Set(prebundle?.entries)

function packageVersion(root: string) {
  return (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: string })
    .version
}

/** The framework's prebundle stamp when its dist is complete and built from `fingerprint`'s source. */
export function readPrebundleStamp(frameworkRoot: string, fingerprint: string) {
  let stamp: PrebundleStamp
  try {
    stamp = JSON.parse(
      readFileSync(path.join(frameworkRoot, PREBUNDLE_STAMP), 'utf8'),
    ) as PrebundleStamp
  } catch {
    return undefined
  }
  return stamp.fingerprint === fingerprint && stamp.version === packageVersion(frameworkRoot)
    ? stamp
    : undefined
}

/** The prebundled counterpart of a framework source module, else `file` unchanged. */
export function prebundledFile(file: string): string {
  if (!prebundle || !file.startsWith(srcRoot)) return file
  const entry = file.slice(srcRoot.length).replace(/\.tsx?$/, '')
  return entries.has(entry) ? path.join(distRoot, `${entry}.js`) : file
}

let registered = false

/** Route imports of framework source, by path, to the prebundle. */
export function registerPrebundleResolve(): void {
  if (!prebundle || registered) return
  registered = true
  const escaped = srcRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  Bun.plugin({
    name: 'pnext-prebundle',
    setup(build) {
      build.onResolve({ filter: new RegExp(`^(?:file://)?${escaped}.*\\.tsx?$`) }, args => {
        const file = args.path.startsWith('file:') ? fileURLToPath(args.path) : args.path
        const target = prebundledFile(file)
        return target === file ? undefined : { path: target }
      })
      // Compiled artifacts name framework modules by relative path.
      build.onResolve({ filter: /^\.\.?\/.*\/src\/.*\.tsx?$/ }, args => {
        const file = path.resolve(path.dirname(args.importer), args.path)
        const target = prebundledFile(file)
        return target === file ? undefined : { path: target }
      })
    },
  })
}
