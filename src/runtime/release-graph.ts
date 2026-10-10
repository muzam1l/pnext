/**
 * A release's server dependencies, one graph per App Router layer, as Next bundles them. The compile
 * vendors (or natively loads) each package import for the build's own prerender and logs it; once
 * every release module is compiled, this links what a layer imports and repoints the release modules
 * at the graph. Pages Router layers keep their per-package artifacts, as Next keeps those external.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { readFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type { ResolvedConfig } from '../config'
import { getExternalPackagePolicy } from '../resolve/imports'
import { importMetaRefs, importSpecifiers } from '../resolve/scan-facts'
import { splitResourceQuery } from '../utils/resource-query'
import { toPosixPath, writeFileAtomic } from '../utils/fs'
import { hashBundleSpecifier } from './loader'
import { cacheRoot, devSourceIdentity } from './module-cache'
import { outputSpecifiers, spliceSource } from './module-transform'
import { compiledSpecifiersManifestSuffix, releaseLayerArtifactDir } from './modules'
import { emittedRefs } from './vendor'
import {
  linkReleaseDependencies,
  releaseDependencyLog,
  type ReleaseDependency,
  type ReleaseDependencyLayer,
} from './vendor-build'

const layerDirs: Record<ReleaseDependencyLayer, string> = {
  'server:server': 'rsc',
  'client:client': 'ssr',
}
const layers = Object.keys(layerDirs) as ReleaseDependencyLayer[]
const frameworkRoot = realpathSync(path.resolve(import.meta.dirname, '..', '..'))

export interface LinkedLayer {
  /** Every file the graph wrote. */
  files: string[]
  /** A dependency artifact the compile handed out -> the graph entry that replaces it. */
  moved: Map<string, string>
}

/** A release module compiled for another layer than its directory's. */
interface ReleaseModuleLayer {
  module: string
  layer: ReleaseDependencyLayer
}

/** Demands by the file the compile handed out (natives by real path too), per layer. */
type Demands = Map<string, Map<ReleaseDependencyLayer, ReleaseDependency>>

/**
 * Link `layer` for the release whose modules are `roots`, and rewrite the release modules importing
 * its dependencies to import the graph. `sources` holds the App Router modules read so far, shared
 * across layers. Undefined when the layer imports no dependency.
 */
export async function linkReleaseLayer(
  config: ResolvedConfig,
  layer: ReleaseDependencyLayer,
  roots: readonly string[],
  sources: Map<string, string>,
): Promise<LinkedLayer | undefined> {
  const { demands, moduleLayers } = loggedDependencies(config)
  if (![...demands.values()].some(owners => owners.has(layer))) return undefined
  const cache = cacheRoot(config.outPath)
  const dirs = new Map(layers.map(each => [each, releaseLayerArtifactDir(config, each)] as const))
  const inLayers = (file: string) => [...dirs.values()].some(dir => isInside(dir, file))
  await readLayerModules(inLayers, roots, sources)
  const policy = getExternalPackagePolicy()
  // A native demand is imported bare; only its packages need resolving.
  const natives = new Set(
    [...demands]
      .filter(([file, owners]) => owners.has(layer) && !isInside(cache, file))
      .map(([, owners]) => packageName(owners.get(layer)!.specifier)),
  )
  const resolved = new Map<string, string | undefined>()
  const resolveBare = (specifier: string, from: string) => {
    const key = `${path.dirname(from)}\0${specifier}`
    if (!resolved.has(key)) resolved.set(key, realFile(bunResolve(specifier, from)))
    return resolved.get(key)
  }
  // The importer's compile layer picks the graph: a `'use client'` file compiles for the client layer
  // into the RSC tree, and a cross-layer artifact is one file both layers demanded.
  const demandOf = (file: string | undefined, importer: string) => {
    const owners = file && (demands.get(file) ?? demands.get(realFile(file) ?? file))
    if (!owners) return undefined
    const importerLayer =
      moduleLayers.get(importer) ?? [...dirs].find(([, dir]) => isInside(dir, importer))?.[0]
    const owner =
      importerLayer && owners.has(importerLayer)
        ? importerLayer
        : owners.size === 1
          ? [...owners.keys()][0]
          : undefined
    return owner === layer ? owners.get(layer) : undefined
  }
  const entries = new Map<string, { in: string; out: string }>()
  const entryOf = (demand: ReleaseDependency) => {
    const entry = demand.entry!
    if (!entries.has(entry)) entries.set(entry, { in: entry, out: entryName(config, entry) })
    return entry
  }
  const edits = new Map<string, { start: number; end: number; suffix: string; to: string }[]>()
  for (const [file, code] of sources) {
    const list: { start: number; end: number; suffix: string; to: string }[] = []
    for (const found of outputSpecifiers(code)) {
      const { specifier, suffix } = splitSuffix(found.value)
      const relative = specifier.startsWith('.')
      const target = relative && path.resolve(path.dirname(file), specifier)
      const demand = target
        ? inLayers(target)
          ? undefined
          : demandOf(target, file)
        : natives.has(packageName(specifier))
          ? demandOf(resolveBare(specifier, file), file)
          : undefined
      if (!demand?.entry) continue
      const edit = { start: found.start, end: found.end, suffix }
      // Next's built-in externals load as plain imports wherever the release resolves them as the app does.
      if (policy.releaseExternal?.(packageName(demand.specifier) ?? '')) {
        if (!relative) continue
        if (resolveBare(demand.specifier, file) === realFile(demand.entry)) {
          list.push({ ...edit, to: demand.specifier })
          continue
        }
      }
      list.push({ ...edit, to: entryOf(demand) })
    }
    if (list.length > 0) edits.set(file, list)
  }
  // A release module the compile served straight from a dependency artifact (a package's client file).
  const rootEntries = new Map<string, string>()
  for (const root of roots) {
    const demand = inLayers(root) ? undefined : demands.get(root)?.get(layer)
    if (demand?.entry) rootEntries.set(root, entryOf(demand))
  }
  if (entries.size === 0 && edits.size === 0) return undefined
  const outdir = path.join(cache, 'deps', layerDirs[layer])
  const linked =
    entries.size > 0
      ? await linkReleaseDependencies(config, layer, [...entries.values()], outdir)
      : { files: [], inPlace: [] }
  // An entry left in place keeps the import the compile emitted.
  for (const entry of linked.inPlace) entries.delete(entry)
  const target = (edit: { to: string }) =>
    entries.has(edit.to) || !path.isAbsolute(edit.to) ? edit.to : undefined
  const output = (entry: string) => path.join(outdir, `${entries.get(entry)!.out}.js`)
  await Promise.all(
    [...edits].map(async ([file, all]) => {
      const list = all.filter(target)
      if (list.length === 0) return
      const code = spliceSource(
        sources.get(file)!,
        list.map(edit => ({
          start: edit.start,
          end: edit.end,
          value: JSON.stringify(
            `${entries.has(edit.to) ? importPath(file, output(edit.to)) : edit.to}${edit.suffix}`,
          ),
        })),
      )
      sources.set(file, code)
      // Nothing reads the release's modules while the build links them.
      await Bun.write(file, code)
      const sidecar = `${file}${compiledSpecifiersManifestSuffix}`
      if (existsSync(sidecar)) {
        await writeFileAtomic(sidecar, JSON.stringify(importSpecifiers(code, file)))
      }
    }),
  )
  return {
    files: linked.files,
    moved: new Map(
      [...rootEntries]
        .filter(([, entry]) => entries.has(entry))
        .map(([root, entry]) => [root, output(entry)]),
    ),
  }
}

/** Read the App Router modules: the `roots` among them and what they import relatively. */
async function readLayerModules(
  inLayers: (file: string) => boolean,
  roots: readonly string[],
  sources: Map<string, string>,
) {
  const seen = new Set<string>()
  let frontier = roots.filter(inLayers)
  while (frontier.length > 0) {
    const next: string[] = []
    await Promise.all(
      frontier.map(async file => {
        if (seen.has(file)) return
        seen.add(file)
        const code = sources.get(file) ?? (await readFile(file, 'utf8').catch(() => undefined))
        if (code === undefined) return
        sources.set(file, code)
        for (const found of outputSpecifiers(code)) {
          if (!found.value.startsWith('.')) continue
          const target = path.resolve(path.dirname(file), splitSuffix(found.value).specifier)
          if (inLayers(target)) next.push(target)
        }
      }),
    )
    frontier = next
  }
}

function loggedDependencies(config: ResolvedConfig) {
  const demands: Demands = new Map()
  const moduleLayers = new Map<string, ReleaseDependencyLayer>()
  let log: string
  try {
    log = readFileSync(releaseDependencyLog(config), 'utf8')
  } catch {
    return { demands, moduleLayers }
  }
  const add = (file: string, demand: ReleaseDependency) => {
    const owners = demands.get(file) ?? new Map<ReleaseDependencyLayer, ReleaseDependency>()
    if (!owners.has(demand.layer)) owners.set(demand.layer, demand)
    demands.set(file, owners)
  }
  for (const line of log.split('\n')) {
    if (!line) continue
    const record = JSON.parse(line) as ReleaseDependency | ReleaseModuleLayer
    if ('module' in record) {
      moduleLayers.set(path.resolve(record.module), record.layer)
      continue
    }
    // The framework is the runtime itself: its modules stay the ones the server loads.
    if (record.entry && isInside(frameworkRoot, record.entry)) continue
    add(path.resolve(record.file), record)
    const real = realFile(record.file)
    if (real && real !== path.resolve(record.file)) add(real, record)
  }
  return { demands, moduleLayers }
}

/**
 * Remove the vendor artifacts no compiled module imports any more: the compile wrote them for the
 * build's own prerender, and the linked graphs replaced them. `sources` are the App Router modules,
 * already read.
 */
export async function pruneReleaseVendor(config: ResolvedConfig, sources: Map<string, string>) {
  const cache = cacheRoot(config.outPath)
  const vendor = path.join(cache, 'vendor')
  const graphs = path.join(cache, 'deps')
  const compiled = await compiledFiles(cache)
  const reached = new Set<string>()
  let frontier = compiled.filter(file => !isInside(vendor, file) && !isInside(graphs, file))
  while (frontier.length > 0) {
    const next: string[] = []
    await Promise.all(
      frontier.map(async file => {
        if (reached.has(file)) return
        reached.add(file)
        const real = realFile(file)
        if (real) reached.add(real)
        const code =
          sources.get(file) ??
          (/\.[cm]?js$/.test(file)
            ? await readFile(file, 'utf8').catch(() => undefined)
            : undefined)
        for (const specifier of code ? relativeReferences(file, code) : []) {
          const target = path.resolve(path.dirname(file), splitSuffix(specifier).specifier)
          if (isInside(vendor, target)) next.push(target)
        }
      }),
    )
    frontier = next
  }
  await Promise.all(
    compiled
      .filter(file => isInside(vendor, file) && !file.endsWith('.trace.js') && !reached.has(file))
      .map(file => rm(file, { force: true })),
  )
}

// The compat cache mirrors app-root entries (node_modules included) as symlinks; never follow them.
async function compiledFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map(async entry => {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) return compiledFiles(file)
      return entry.isFile() && /\.[cm]?js$/.test(entry.name) ? [file] : []
    }),
  )
  return nested.flat()
}

/** Relative module references in emitted code: imports, requires and `new URL(…, import.meta.url)`. */
function relativeReferences(file: string, code: string) {
  return [
    ...outputSpecifiers(code).map(found => found.value),
    ...emittedRefs(code).map(ref => ref.specifier),
    ...importMetaRefs(file, code).urls.map(url => url.specifier),
  ].filter(specifier => specifier.startsWith('.'))
}

/** A stable entry name: the package path it starts from, plus its workspace identity's hash. */
function entryName(config: ResolvedConfig, entry: string) {
  const installed = entry.lastIndexOf(`${path.sep}node_modules${path.sep}`)
  const label = toPosixPath(installed < 0 ? path.basename(entry) : entry.slice(installed + 14))
    .replace(/\.[cm]?[jt]sx?$/, '')
    .replace(/[^\w.-]+/g, '_')
  return `${label.slice(-48)}.${hashBundleSpecifier(devSourceIdentity(entry, config.workspaceRoot)).slice(0, 8)}`
}

function splitSuffix(value: string) {
  const { path: specifier, query: suffix } = splitResourceQuery(value)
  return { specifier, suffix }
}

function packageName(specifier: string) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function importPath(from: string, to: string) {
  const relative = toPosixPath(path.relative(path.dirname(from), to))
  return relative.startsWith('.') ? relative : `./${relative}`
}

function bunResolve(specifier: string, from: string) {
  try {
    return Bun.resolveSync(specifier, path.dirname(from))
  } catch {
    return undefined
  }
}

function realFile(file: string | undefined) {
  if (!file) return undefined
  try {
    return realpathSync(file)
  } catch {
    return undefined
  }
}

function isInside(dir: string, file: string) {
  return file.startsWith(`${dir}${path.sep}`)
}
