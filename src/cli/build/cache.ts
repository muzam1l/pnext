import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, readlink } from 'node:fs/promises'
import path from 'node:path'
import type { ResolvedConfig } from '../../config'
import { frameworkFingerprint } from '../../runtime/fingerprint'
import type { BuildManifest } from '../../types'
import { writeFileAtomic } from '../../utils/fs'

const CACHE_VERSION = 2
const CACHE_SEGMENTS = ['cache', 'build'] as const
const SKIP_INPUT_DIRS = new Set([
  '.claude',
  '.git',
  '.husky',
  '.next',
  '.pnext',
  '.tmp',
  '.turbo',
  '.vercel',
  '.vscode',
  'node_modules',
])
const SKIP_INPUT_FILE = /(?:^\.DS_Store$|\.(?:log|pid)$)/i
const LOCK_FILES = [
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]

type InputRecord = [mtimeMs: number, size: number, hash: string]

interface CacheRecord {
  version: number
  key: string
  inputs: Record<string, InputRecord>
  outputHash: string
  outputs: Record<string, string>
}

export interface BuildCacheOptions {
  adapter?: 'vercel'
  debugBuildPaths?: string
  buildMode?: 'compile' | 'generate'
  debugPrerender?: boolean
}

export interface BuildCacheSession {
  enabled: boolean
  context?: string
  inputs?: Record<string, InputRecord>
  manifest?: BuildManifest
  reason?: string
}

/** Validate the standard production build before its output directory is touched. */
export async function lookupBuildCache(
  config: ResolvedConfig,
  options: BuildCacheOptions,
): Promise<BuildCacheSession> {
  if (!cacheEnabled(options)) return { enabled: false }
  const record = await readRecord(config.outPath)
  const inputs = await inputRecords(config, record?.inputs)
  const context = buildContext()
  const key = buildKey(context, inputs)
  if (record?.key !== key) return { enabled: true, context, inputs, reason: 'inputs' }
  const output = await outputSnapshot(config.outPath)
  if (output.hash !== record.outputHash) {
    const changed = changedFiles(record.outputs, output.files).slice(0, 3).join(', ')
    return { enabled: true, context, inputs, reason: `output (${changed || 'unknown'})` }
  }
  try {
    const manifest = JSON.parse(
      await readFile(path.join(config.outPath, 'manifest.json'), 'utf8'),
    ) as BuildManifest
    return { enabled: true, context, inputs, manifest, reason: 'hit' }
  } catch {
    return { enabled: true, context, inputs, reason: 'manifest' }
  }
}

/** Publish a successful build only after every production artifact has landed. */
export async function writeBuildCache(
  config: ResolvedConfig,
  options: BuildCacheOptions,
  session: BuildCacheSession,
) {
  if (!session.enabled || !session.context || !cacheEnabled(options)) return
  const inputs = await inputRecords(config, session.inputs)
  const output = await outputSnapshot(config.outPath)
  const record: CacheRecord = {
    version: CACHE_VERSION,
    key: buildKey(session.context, inputs),
    inputs,
    outputHash: output.hash,
    outputs: output.files,
  }
  await mkdir(cacheDir(config.outPath), { recursive: true })
  await writeFileAtomic(recordFile(config.outPath), JSON.stringify(record))
}

function cacheEnabled(options: BuildCacheOptions) {
  // Opt-in until the no-change short-circuit is finished: the key currently hashes the whole
  // environment, so cross-shell hits are rare and the cache adds bookkeeping without payoff.
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  if (process.env.PNEXT_BUILD_CACHE !== '1') return false
  return (
    options.adapter === undefined &&
    options.debugBuildPaths === undefined &&
    options.buildMode === undefined &&
    options.debugPrerender !== true
  )
}

function cacheDir(outPath: string) {
  return path.join(outPath, ...CACHE_SEGMENTS)
}

function recordFile(outPath: string) {
  return path.join(cacheDir(outPath), 'result.json')
}

async function readRecord(outPath: string): Promise<CacheRecord | undefined> {
  try {
    const parsed = JSON.parse(await readFile(recordFile(outPath), 'utf8')) as CacheRecord
    if (
      parsed.version === CACHE_VERSION &&
      parsed.key &&
      parsed.inputs &&
      parsed.outputHash &&
      parsed.outputs
    ) {
      return parsed
    }
  } catch {
    // A partial or older entry is a miss, never a stale hit.
  }
  return undefined
}

function buildContext() {
  const hash = createHash('sha256')
  hash.update(`pnext-build-cache:${CACHE_VERSION}\0`)
  hash.update(frameworkFingerprint())
  hash.update(`\0bun:${Bun.version}\0`)
  for (const [name, value] of Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(`${name}=${value ?? ''}\0`)
  }
  return hash.digest('hex')
}

function buildKey(context: string, inputs: Record<string, InputRecord>) {
  const hash = createHash('sha256')
  hash.update(context)
  for (const [file, record] of Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(`${file}\0${record[2]}\0`)
  }
  return hash.digest('hex')
}

async function inputRecords(
  config: ResolvedConfig,
  previous: Record<string, InputRecord> | undefined,
) {
  const files = new Map<string, string>()
  await collectTree(config.root, 'root', files, config.outPath)
  await collectModuleGraphInputs(config, files)

  // Dependency trees are represented by package-manager content identities,
  // while first-party modules above are keyed by their own bytes.
  for (const [prefix, root] of [
    ['root-deps', config.root],
    ['workspace-deps', config.workspaceRoot],
  ] as const) {
    for (const name of LOCK_FILES) addFile(files, `${prefix}:${name}`, path.join(root, name))
    addFile(
      files,
      `${prefix}:node_modules/.package-lock.json`,
      path.join(root, 'node_modules', '.package-lock.json'),
    )
  }

  const frameworkRoot = path.resolve(import.meta.dirname, '..', '..')
  addFile(files, 'framework:package.json', path.join(frameworkRoot, 'package.json'))
  for (const name of LOCK_FILES) {
    addFile(files, `framework:${name}`, path.join(frameworkRoot, name))
    addFile(files, `framework-workspace:${name}`, path.join(frameworkRoot, '..', name))
  }

  const entries = await Promise.all(
    [...files].map(async ([key, file]): Promise<[string, InputRecord] | undefined> => {
      const stats = await lstat(file).catch(() => undefined)
      if (!stats?.isFile() && !stats?.isSymbolicLink()) return undefined
      const old = previous?.[key]
      if (old?.[0] === stats.mtimeMs && old[1] === stats.size) return [key, old]
      const contents = stats.isSymbolicLink()
        ? Buffer.from(`link:${await readlink(file)}`)
        : await readFile(file)
      return [key, [stats.mtimeMs, stats.size, contentHash(contents)]]
    }),
  )
  return Object.fromEntries(
    entries.filter((entry): entry is [string, InputRecord] => Boolean(entry)),
  )
}

interface ModuleGraphIndex {
  files?: Record<string, unknown>
}

async function collectModuleGraphInputs(config: ResolvedConfig, files: Map<string, string>) {
  let parsed: ModuleGraphIndex
  try {
    parsed = JSON.parse(
      await readFile(path.join(config.outPath, 'cache', 'server', 'graph.json'), 'utf8'),
    ) as ModuleGraphIndex
  } catch {
    return
  }
  const frameworkRoot = path.resolve(import.meta.dirname, '..', '..')
  for (const source of Object.keys(parsed.files ?? {})) {
    const value = source.slice(2).split('/').join(path.sep)
    const file = source.startsWith('w:')
      ? path.resolve(config.workspaceRoot, value)
      : source.startsWith('f:')
        ? path.resolve(frameworkRoot, value)
        : source.startsWith('a:')
          ? value
          : undefined
    if (file) addFile(files, `module:${source}`, file)
  }
}

async function collectTree(
  root: string,
  prefix: string,
  files: Map<string, string>,
  outPath: string,
  dir = root,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries.map(async entry => {
      const file = path.join(dir, entry.name)
      if (file === outPath || file.startsWith(`${outPath}${path.sep}`)) return
      if (entry.isDirectory()) {
        if (!SKIP_INPUT_DIRS.has(entry.name)) await collectTree(root, prefix, files, outPath, file)
        return
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) return
      const relative = path.relative(root, file)
      // Local server logs and top-level response captures are not compiler
      // inputs; watching processes commonly rewrite them during a build.
      if (
        SKIP_INPUT_FILE.test(entry.name) ||
        (!relative.includes(path.sep) && /\.html?$/i.test(entry.name))
      ) {
        return
      }
      addFile(files, `${prefix}:${toPosix(relative)}`, file)
    }),
  )
}

function addFile(files: Map<string, string>, key: string, file: string) {
  if (existsSync(file)) files.set(key, file)
}

async function outputSnapshot(outPath: string) {
  const files = new Map<string, string>()
  const entries = await readdir(outPath, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries.map(async entry => {
      if (entry.name === 'cache' || entry.name === 'dev') return
      const file = path.join(outPath, entry.name)
      if (entry.isDirectory()) await collectOutputTree(outPath, file, files)
      else if (entry.isFile() || entry.isSymbolicLink()) {
        files.set(toPosix(entry.name), file)
      }
    }),
  )
  const hash = createHash('sha256')
  const hashes: Record<string, string> = {}
  for (const [name, file] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const stats = await lstat(file)
    const contents = stats.isSymbolicLink()
      ? Buffer.from(`link:${await readlink(file)}`)
      : await readFile(file)
    const contentsHash = contentHash(contents)
    hashes[name] = contentsHash
    hash.update(`${name}\0${contentsHash}\0`)
  }
  return { hash: hash.digest('hex'), files: hashes }
}

function changedFiles(before: Record<string, string>, after: Record<string, string>) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    file => before[file] !== after[file],
  )
}

async function collectOutputTree(root: string, dir: string, files: Map<string, string>) {
  const entries = await readdir(dir, { withFileTypes: true })
  await Promise.all(
    entries.map(async entry => {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) await collectOutputTree(root, file, files)
      else if (entry.isFile() || entry.isSymbolicLink()) {
        files.set(toPosix(path.relative(root, file)), file)
      }
    }),
  )
}

function contentHash(contents: Uint8Array) {
  return createHash('sha256').update(contents).digest('hex')
}

function toPosix(file: string) {
  return path.sep === '/' ? file : file.split(path.sep).join('/')
}
