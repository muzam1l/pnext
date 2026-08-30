// Persisted next/font resolutions - the restart half of the in-memory `resolvedFontCache`. The
// bytes a resolution emits are already content-addressed on disk, but the resolution itself is not,
// so a dev restart would re-fetch every Google Fonts stylesheet and font file just to re-derive
// URLs it already emitted. This records the finished resolution next to those bytes and
// re-validates it with stats only:
//   - every emitted file must still exist (a `pnext build` empties the dir), and
//   - every local source file must still match the stat it was read at, so a font swapped while the
//     server was not running re-resolves and re-emits.
// Nothing here is used by `pnext build`, which owns the directory it just wiped.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { ResolvedConfig } from '../../../config'
import { restartCacheEnabled } from '../../../dev/restart/enabled'
import { frameworkFingerprint } from '../../../runtime/fingerprint'
import { writeFileAtomic } from '../../../utils/fs'
import type { MetadataLink } from '../../../types'

export interface PersistableFont {
  css: string
  /** Whether the resolution shipped a size-adjusted fallback face (Next's `next-size-adjust` meta). */
  sizeAdjust: boolean
  preloads: MetadataLink[]
  usesFonts: boolean
  files: string[]
  /** Local font files the resolution read (google resolutions have none). */
  sources?: string[]
}

/** `[file, mtimeMs, size]` — a local source and the stat it was resolved at. */
type SourceStat = [string, number, number]

interface Entry extends PersistableFont {
  sourceStats: SourceStat[]
}

interface IndexFile {
  version: number
  /** pnext's generation, so an upgrade never serves the previous framework's output. */
  runtime: string
  fonts: Record<string, Entry>
}

/** Bumped whenever a record's shape changes; an older index is simply ignored. */
const INDEX_VERSION = 2

interface FontIndex {
  file: string
  fonts: Map<string, Entry>
  dirty: boolean
  flush?: Timer
}

const indexes = new Map<string, FontIndex>()

function fontIndex(config: ResolvedConfig): FontIndex {
  const file = path.join(config.outPath, 'cache', 'fonts', 'index.json')
  const existing = indexes.get(file)
  if (existing) return existing
  const created: FontIndex = { file, fonts: readIndex(file), dirty: false }
  indexes.set(file, created)
  process.on('exit', () => {
    if (!created.dirty) return
    created.dirty = false
    try {
      writeFileSync(created.file, serializeIndex(created.fonts))
    } catch {
      // Best effort: a missing index only costs the next boot a re-resolve.
    }
  })
  return created
}

/** The recorded resolution for `key`, or undefined when it no longer describes disk. */
export async function persistedFont(
  config: ResolvedConfig,
  key: string,
): Promise<PersistableFont | undefined> {
  if (!restartCacheEnabled()) return undefined
  const entry = fontIndex(config).fonts.get(key)
  if (!entry) return undefined
  if (!entry.files.every(file => existsSync(file))) return undefined
  const stats = await Promise.all(
    entry.sourceStats.map(async ([file, mtimeMs, size]) => {
      const current = await stat(file).catch(() => undefined)
      return current?.mtimeMs === mtimeMs && current.size === size
    }),
  )
  if (!stats.every(Boolean)) return undefined
  return entry
}

/** Record a finished resolution. Failures are non-fatal — they cost a re-resolve. */
export async function persistFont(config: ResolvedConfig, key: string, font: PersistableFont) {
  const index = fontIndex(config)
  const sourceStats = await Promise.all(
    (font.sources ?? []).map(async (file): Promise<SourceStat | undefined> => {
      const stats = await stat(file).catch(() => undefined)
      return stats ? [file, stats.mtimeMs, stats.size] : undefined
    }),
  )
  // A source that vanished mid-resolve must not be recorded as validated.
  if (sourceStats.some(entry => entry === undefined)) return
  index.fonts.set(key, { ...font, sourceStats: sourceStats as SourceStat[] })
  persist(index)
}

function persist(index: FontIndex) {
  index.dirty = true
  if (index.flush) return
  index.flush = setTimeout(async () => {
    index.flush = undefined
    if (!index.dirty) return
    const contents = serializeIndex(index.fonts)
    try {
      await mkdir(path.dirname(index.file), { recursive: true })
      await writeFileAtomic(index.file, contents)
      index.dirty = false
    } catch {
      // A write that lost a race with a cache wipe must not look persisted.
    }
  }, 50)
  // NOT unref'd: under the dev server this timer never fired, so the index was never written and
  // every restart re-resolved every font over the network. The `exit` handler above still covers a
  // process exit inside the window.
}

function readIndex(file: string) {
  const fonts = new Map<string, Entry>()
  let parsed: IndexFile | undefined
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as IndexFile
  } catch {
    return fonts
  }
  if (parsed?.version !== INDEX_VERSION || parsed.runtime !== runtimeFingerprint()) {
    return fonts
  }
  for (const [key, entry] of Object.entries(parsed.fonts ?? {})) {
    if (entry && Array.isArray(entry.files) && Array.isArray(entry.sourceStats)) {
      fonts.set(key, entry)
    }
  }
  return fonts
}

function serializeIndex(fonts: Map<string, Entry>) {
  return JSON.stringify({
    version: INDEX_VERSION,
    runtime: runtimeFingerprint(),
    fonts: Object.fromEntries(fonts),
  } satisfies IndexFile)
}

// A recorded resolution IS framework output - its css, its preloads, its emitted file names - so it
// follows pnext's generation, the same one every other compiled artifact is keyed on. Never a
// hand-picked file list: this hashed four files in this directory and was blind to every other
// source the resolution reads (utils/code, the asset emitter, this file's own record rule).
const runtimeFingerprint = () => frameworkFingerprint()
