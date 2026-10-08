/**
 * Server entry for hosts that serve a build through `createRequestHandler`: a thin loader that
 * resolves `@wular/pnext` from the output's own location (as `.next/server` loads `next`), so the
 * output carries no framework code and no build-machine paths.
 */
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
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
  const generation = frameworkFingerprint(path.join(outPath, 'cache', 'server'))
  return path.join(outPath, 'server', `bundle-${frameworkVersion()}-${generation}`)
}

/** Write `<outPath>/server/bundle-<version>-<fingerprint>/entry.js`, re-exporting src/cli/start.ts. */
export async function emitServerEntry(outPath: string): Promise<void> {
  const start = await Bun.file(path.join(import.meta.dirname, '..', 'start.ts')).text()
  const names = new Bun.Transpiler({ loader: 'ts' }).scan(start).exports
  const dir = serverEntryDir(outPath)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'entry.js'),
    `const pnext = await import(new URL('./cli/start.ts', import.meta.resolve('@wular/pnext')).href)\n` +
      `export const { ${names.join(', ')} } = pnext\n`,
  )
}
