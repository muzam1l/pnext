import {
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

export const namedBinaryName = 'pnext'

// Keep in sync with the command case in bin/pnext, which resolves the same name.
const cliCommands = new Set(['dev', 'build', 'start', 'analyze', 'typegen'])

/** Process name for a CLI command: `pnext dev` runs as `pnext-dev`, etc. */
export function commandBinaryName(command: string | undefined) {
  if (command && cliCommands.has(command)) return `${namedBinaryName}-${command}`
  return namedBinaryName
}

/**
 * Path to a bun executable whose file is literally named `name`.
 *
 * Activity Monitor and `ps -o ucomm` show the kernel's process name, set from the basename of the
 * executable file at exec time - `argv0`, `exec -a` and `process.title` only change the argv that
 * plain `ps` prints. So the running bun binary is hardlinked (or cloned/copied) into the user cache
 * once per role and every process spawns through its role's link. Hardlinks share the inode, so the
 * extra names are free.
 *
 * Falls back to the plain bun binary when the cache is unavailable: naming is cosmetic and must never
 * break spawning.
 */
export function namedBunBinary(name: string = namedBinaryName): string {
  if (process.platform === 'win32') return process.execPath
  if (path.basename(process.execPath) === name) return process.execPath
  return namedExecutable(process.execPath, `bun-${Bun.version}`, name)
}

/**
 * Label esbuild's service process. The esbuild JS API spawns its own Go binary, so pnext never execs
 * it - but esbuild honors `ESBUILD_BINARY_PATH`, so pointing that at a hardlink of the platform
 * binary renames the service. The lib captures the variable at module load, so this must run before
 * anything imports esbuild.
 */
export function nameEsbuildProcess() {
  if (process.platform === 'win32') return
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  if (process.env.ESBUILD_BINARY_PATH) return // respect an explicit override
  try {
    const require = createRequire(import.meta.url)
    const { version } = require('esbuild/package.json') as { version: string }
    const binPath = require.resolve(`@esbuild/${process.platform}-${process.arch}/bin/esbuild`)
    const named = namedExecutable(binPath, `esbuild-${version}`, 'pnext-esbuild')
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    if (named !== binPath) process.env.ESBUILD_BINARY_PATH = named
  } catch {
    // unknown platform package or unavailable cache: esbuild resolves its own
    // binary and just keeps its name
  }
}

function namedExecutable(sourcePath: string, versionDir: string, name: string): string {
  try {
    // One directory per tool version, so upgrades switch paths instead of
    // serving a stale binary.
    const binRoot = path.join(cacheRoot(), 'bin')
    const dir = path.join(binRoot, versionDir)
    const named = path.join(dir, name)
    if (!existsSync(named)) {
      mkdirSync(dir, { recursive: true })
      // Land under a temp name and rename, so a concurrent pnext process can
      // never exec a half-written binary.
      const staging = path.join(dir, `.${name}-${process.pid}`)
      rmSync(staging, { force: true })
      try {
        linkSync(sourcePath, staging)
      } catch {
        // Cross-volume or hardlink-restricted: clone when the filesystem
        // supports it (free on APFS), else fall back to a full copy.
        copyFileSync(sourcePath, staging, fsConstants.COPYFILE_FICLONE)
        chmodSync(staging, 0o755)
      }
      renameSync(staging, named)
      removeStaleVersions(binRoot, path.basename(dir))
    }
    return named
  } catch {
    return sourcePath
  }
}

// Best-effort sweep of binaries linked for previous versions of the same
// tool: keeping `bun-1.3.6` removes other `bun-*` dirs but leaves
// `esbuild-*` alone.
function removeStaleVersions(binRoot: string, keep: string) {
  const toolPrefix = keep.slice(0, keep.indexOf('-') + 1)
  try {
    for (const entry of readdirSync(binRoot)) {
      if (entry === keep || !entry.startsWith(toolPrefix)) continue
      rmSync(path.join(binRoot, entry), { recursive: true, force: true })
    }
  } catch {
    // ignore: stale versions only waste a hardlink's worth of space
  }
}

/** pnext's user cache dir — survives the build wiping the output directory. */
export function cacheRoot() {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const xdg = process.env.XDG_CACHE_HOME
  if (xdg) return path.join(xdg, 'pnext')
  return path.join(os.homedir(), '.cache', 'pnext')
}
