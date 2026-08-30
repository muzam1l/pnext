// Build flags the SERVING runtime needs (COMPAT).
//
// `next build --debug-prerender` changes what a production server logs for an error that crosses the
// 'use cache' boundary (real frames + environmentName vs minified frames + a redacted error). The flag
// is a build-time input, so the build records it next to the other server artifacts and start reads it
// back.
//
// State is anchored on globalThis: the built compat-server bundle and the original module can both be
// loaded in one process, and a module-local cache would then be filled in one copy and empty in the other.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const BUILD_FLAG_GLOBALS = Symbol.for('pnext.compat.buildFlags')

export interface BuildFlags {
  debugPrerender: boolean
}

interface BuildFlagState {
  /** The serving root's output dir, recorded by the init hook. */
  outPath?: string
  /** Lazily read flags: `null` once a read found no build to serve. */
  flags?: BuildFlags | null
}

function state(): BuildFlagState {
  const root = globalThis as unknown as Record<PropertyKey, BuildFlagState | undefined>
  return (root[BUILD_FLAG_GLOBALS] ??= {})
}

function flagsFile(outPath: string): string {
  return path.join(outPath, 'server', 'pnext-build-flags.json')
}

/** Record the output dir at build/start init so the runtime can find the file. */
export function setBuildFlagsOutPath(outPath: string): void {
  const current = state()
  if (current.outPath !== outPath) {
    current.outPath = outPath
    current.flags = undefined
  }
}

/** Persist the build's `--debug-prerender` flag for the serving runtime. */
export function writeBuildFlags(outPath: string, debugPrerender: boolean): void {
  const file = flagsFile(outPath)
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ debugPrerender })}\n`)
  } catch {
    // A read-only/absent output dir only costs the runtime this hint.
  }
  const current = state()
  current.outPath = outPath
  current.flags = { debugPrerender }
}

/**
 * The flags of the build being served, or undefined when there is none to read
 * (a dev server, or a start against an output dir this process never built).
 * Callers use the absence to stay out of production-only behavior.
 */
export function servedBuildFlags(): BuildFlags | undefined {
  const current = state()
  if (current.flags !== undefined) return current.flags ?? undefined
  const outPath = current.outPath
  if (outPath === undefined) return undefined
  let flags: BuildFlags | null = null
  try {
    const file = flagsFile(outPath)
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { debugPrerender?: unknown }
      flags = { debugPrerender: parsed.debugPrerender === true }
    }
  } catch {
    flags = null
  }
  current.flags = flags
  return flags ?? undefined
}
