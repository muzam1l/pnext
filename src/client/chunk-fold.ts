/**
 * Chunk-count fold for the initial tier: merges chunks that are provably
 * co-loaded (see `coLoadGroups`), so a merge can never over-fetch. Mechanically
 * an esbuild re-bundle of a renaming barrel plus an import rewrite in every
 * chunk that referenced a member.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import path from 'node:path'
import { build, type BuildOptions, type Metafile } from 'esbuild'
import { clientProfile } from './profile'
import { readText, writeText } from '../utils/fs'
import { escapeRegex } from '../utils/code'

/** Unlinking an artifact a concurrent build already removed is not news. */
function ignoreMissing() {
  return undefined
}

/** Import/export forms the rewrite understands; anything else vetoes the fold. */
const namedClause = String.raw`\{([^}]*)\}`

interface FoldOptions {
  outDir: string
  metafile: Metafile
  /** esbuild flags of the build being folded, so the merge is emitted the same way. */
  buildOptions: Pick<BuildOptions, 'minify' | 'sourcemap' | 'target' | 'format'>
}

/**
 * Merge the always-initial chunks of a finished client build. Returns a metafile
 * with the merge applied, or the original untouched when nothing folds.
 */
export async function foldInitialChunks(options: FoldOptions): Promise<Metafile> {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  if (process.env.PNEXT_CHUNK_FOLD === '0') return options.metafile
  // The cost this removes is compressed-transfer only (a gzip header and
  // dictionary reset per chunk), so the pass rides the minify flag.
  if (!options.buildOptions.minify) return options.metafile
  return foldChunks(options)
}

/**
 * Failure policy: a group that has not touched disk is skipped and reported (the
 * build is correct without the fold); once it has, the metafile and the files on
 * disk have diverged, so it rethrows. `PNEXT_CHUNK_FOLD=strict` throws for both.
 */
async function foldChunks({ outDir, metafile, buildOptions }: FoldOptions): Promise<Metafile> {
  let folded = metafile
  const groups = clientProfile.time('foldGroups', () => coLoadGroups(metafile))
  clientProfile.count('foldGroup#', groups.length)
  clientProfile.count('foldOutput#', Object.keys(metafile.outputs).length)
  if (groups.length === 0) return folded
  // Output text is read once and kept in step with what each group writes, and
  // the same state indexes specifiers — so a group visits only the files naming
  // one of its members instead of re-reading and re-filtering every output.
  const state = await clientProfile.timeAsync('foldRead', () => createFoldState(outDir, metafile))
  for (const group of groups) {
    const mutation = { started: false }
    try {
      folded = await foldGroup({ outDir, metafile: folded, buildOptions }, group, mutation, state)
    } catch (error) {
      if (mutation.started) throw error
      reportFoldFailure(group, error)
      break
    }
  }
  return folded
}

function reportFoldFailure(group: string[], error: unknown) {
  const names = group.map(member => path.basename(member)).join(', ')
  const message = error instanceof Error ? error.message : String(error)
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  if (process.env.PNEXT_CHUNK_FOLD === 'strict') {
    throw new Error(`client chunk fold failed for [${names}]: ${message}`)
  }
  console.warn(`pnext: client chunk fold skipped [${names}] — ${message}`)
}

async function foldGroup(
  { outDir, metafile, buildOptions }: FoldOptions,
  members: string[],
  mutation: { started: boolean },
  state: FoldState,
): Promise<Metafile> {
  if (members.length < 2) return metafile

  const chunksDir = path.join(outDir, 'chunks')
  const memberNames = members.map(output => path.basename(output))
  if (memberNames.some(name => !existsSync(path.join(chunksDir, name)))) return metafile

  const sources = new Map<string, string>()
  for (const name of memberNames) sources.set(name, await readText(path.join(chunksDir, name)))

  const aliases = memberAliases(memberNames, sources)
  if (!aliases) return metafile

  // Every file that referenced a member has to be rewritten; if any of them
  // uses a form the rewriter can't express (`import * as`, `export *`, a bare
  // dynamic `import()` of a member), the fold is abandoned whole.
  const rewrites = new Map<string, string>()
  const rewrite = memberRewriter(memberNames, aliases, chunksDir)
  const rewritable = clientProfile.time('foldRewrite', () => {
    for (const file of state.referrersOf(memberNames)) {
      if (memberNames.includes(path.basename(file))) continue
      const output = state.outputs.get(file)
      if (!output) continue
      const next = rewrite(output.text, file)
      if (next === null) return false
      if (next !== output.text) rewrites.set(file, next)
    }
    return true
  })
  if (!rewritable) return metafile

  const merged = await clientProfile.timeAsync('foldBuild', () =>
    buildMergedChunk(chunksDir, memberNames, aliases, buildOptions),
  )
  if (!merged) return metafile

  // Read-only up to here, so failing is skippable. From the first rewrite on the
  // metafile and the files on disk must be kept in step, so failures are fatal.
  mutation.started = true

  // The rewrites were produced against a placeholder href — the merged chunk's
  // name is its own content hash and so isn't known until it is built.
  await Promise.all(
    [...rewrites].map(([file, source]) => {
      const next = source.replaceAll(MERGED_PLACEHOLDER, merged.name)
      state.set(file, foldOutput(next))
      return writeText(file, next)
    }),
  )
  await Promise.all(
    memberNames.flatMap(name => [
      unlink(path.join(chunksDir, name)).catch(ignoreMissing),
      unlink(path.join(chunksDir, `${name}.map`)).catch(ignoreMissing),
    ]),
  )
  for (const name of memberNames) state.remove(path.join(chunksDir, name))
  // A later group can reference this merged chunk, and it is what the previous
  // per-group re-walk picked up off disk; index it the same way.
  state.set(path.join(chunksDir, merged.name), foldOutput(merged.text))
  return mergeMetafile(metafile, members, path.join(chunksDir, merged.name), merged.bytes)
}

/**
 * Chunks that are always downloaded together, grouped. Two chunks reachable from
 * exactly the same load roots (route entries and `import()` targets) can merge
 * without adding a byte to any load. Entries never fold - the shared chunk is
 * what a lazily loaded island's CSS/runtime seam resolves against.
 */
function coLoadGroups(metafile: Metafile) {
  const dynamicTargets = new Set<string>()
  for (const output of Object.values(metafile.outputs)) {
    for (const imported of output.imports ?? []) {
      if (imported.kind === 'dynamic-import') dynamicTargets.add(imported.path)
    }
  }
  // esbuild records an `entryPoint` for the chunk behind every `import()` too,
  // so dynamic targets have to be subtracted before what is left counts as a
  // route entry.
  const entries = Object.keys(metafile.outputs).filter(
    file => metafile.outputs[file]?.entryPoint && !dynamicTargets.has(file),
  )
  if (entries.length === 0) return []

  const available = availability(metafile, entries, dynamicTargets)
  const roots = [...available.keys()]
  const groups = new Map<string, string[]>()
  for (const file of Object.keys(metafile.outputs)) {
    if (!file.endsWith('.js')) continue
    if (entries.includes(file) || dynamicTargets.has(file)) continue
    const mask = roots.map(root => (available.get(root)!.has(file) ? '1' : '0')).join('')
    // A chunk no root can reach is dead output; leave it alone.
    if (!mask.includes('1')) continue
    ;(groups.get(mask) ?? groups.set(mask, []).get(mask)!).push(file)
  }
  return [...groups.values()]
    .filter(
      group =>
        group.length > 1 &&
        // Only groups that touch a first-paint tier are worth a re-bundle; a
        // purely deferred group is off-budget and pays build time for bytes
        // nobody waits on.
        entries.some(entry => available.get(entry)!.has(group[0]!)),
    )
    .map(group => [...group].sort())
}

/**
 * What is guaranteed to be on the page when `file` runs: a root answers for
 * itself, any other chunk with the intersection over every root that reaches it.
 */
function availabilityAt(
  available: Map<string, Set<string>>,
  file: string,
  memo: Map<string, Set<string>>,
) {
  const own = available.get(file)
  if (own) return own
  // The fixpoint below asks for the same non-root importers once per round per
  // target, and each answer scans every root's availability set — quadratic in
  // roots. The memo is cleared whenever a round changes an answer.
  const cached = memo.get(file)
  if (cached) return cached
  let acc: Set<string> | undefined
  for (const set of available.values()) {
    if (!set.has(file)) continue
    acc = acc === undefined ? new Set(set) : intersect(acc, set)
  }
  const answer = acc ?? new Set([file])
  memo.set(file, answer)
  return answer
}

/**
 * A dynamic chunk only runs on a page that already ran a route entry, so the intersection over every
 * entry that can reach it is a guaranteed availability floor - `inherited` intersects over direct
 * importers whose own availability is still an estimate, and lands pessimistic behind route chunks.
 */
function entryFloors(metafile: Metafile, entries: string[], closures: Map<string, Set<string>>) {
  const dynamicEdges = new Map<string, string[]>()
  for (const [file, output] of Object.entries(metafile.outputs)) {
    for (const imported of output.imports ?? []) {
      if (imported.kind !== 'dynamic-import') continue
      ;(dynamicEdges.get(file) ?? dynamicEdges.set(file, []).get(file)!).push(imported.path)
    }
  }
  const floors = new Map<string, Set<string>>()
  for (const entry of entries) {
    const own = closures.get(entry)!
    const seen = new Set(own)
    const queue = [...own]
    // `queue` grows inside the loop: every chunk this entry can reach by any
    // chain of static and dynamic imports.
    for (const current of queue) {
      for (const target of dynamicEdges.get(current) ?? []) {
        if (seen.has(target)) continue
        for (const file of closures.get(target) ?? staticClosure(metafile, target)) {
          if (seen.has(file)) continue
          seen.add(file)
          queue.push(file)
        }
        const floor = floors.get(target)
        floors.set(target, floor ? intersect(floor, own) : new Set(own))
      }
    }
  }
  return floors
}

/** Per load root, the chunks guaranteed to be on the page once it runs. */
function availability(metafile: Metafile, entries: string[], dynamicTargets: Set<string>) {
  const available = new Map<string, Set<string>>()
  const closures = new Map<string, Set<string>>()
  for (const root of [...entries, ...dynamicTargets]) {
    closures.set(root, staticClosure(metafile, root))
    available.set(root, new Set(closures.get(root)))
  }
  for (const [target, floor] of entryFloors(metafile, entries, closures)) {
    const set = available.get(target)
    if (set) for (const file of floor) set.add(file)
  }
  const importersOf = new Map<string, string[]>()
  for (const [file, output] of Object.entries(metafile.outputs)) {
    for (const imported of output.imports ?? []) {
      if (imported.kind !== 'dynamic-import') continue
      ;(
        importersOf.get(imported.path) ?? importersOf.set(imported.path, []).get(imported.path)!
      ).push(file)
    }
  }
  // `available` only ever grows, so iterating to a fixed point terminates; the
  // bound is the number of roots (each round settles at least one).
  const memo = new Map<string, Set<string>>()
  for (let round = 0; round < dynamicTargets.size + 1; round += 1) {
    let changed = false
    for (const target of dynamicTargets) {
      const importers = importersOf.get(target) ?? []
      let inherited: Set<string> | undefined
      for (const importer of importers) {
        const from = availabilityAt(available, importer, memo)
        inherited = inherited === undefined ? new Set(from) : intersect(inherited, from)
      }
      const next = new Set([...closures.get(target)!, ...(inherited ?? [])])
      if (next.size !== available.get(target)!.size) {
        available.set(target, next)
        memo.clear()
        changed = true
      }
    }
    if (!changed) break
  }
  return available
}

function staticClosure(metafile: Metafile, root: string) {
  const seen = new Set([root])
  const queue = [root]
  // `queue` grows inside the loop — a breadth-first walk of the chunk graph.
  for (const current of queue) {
    for (const imported of metafile.outputs[current]?.imports ?? []) {
      if (imported.kind !== 'import-statement') continue
      if (seen.has(imported.path)) continue
      seen.add(imported.path)
      queue.push(imported.path)
    }
  }
  return seen
}

function intersect(a: Set<string>, b: Set<string>) {
  return new Set([...a].filter(item => b.has(item)))
}

/**
 * Per-member `exported name -> alias`. Chunk exports are minified per chunk and
 * collide across chunks, so the barrel renames them apart.
 */
function memberAliases(memberNames: string[], sources: Map<string, string>) {
  const aliases = new Map<string, Map<string, string>>()
  for (const [index, name] of memberNames.entries()) {
    const source = sources.get(name)!
    // A star re-export can't be aliased name-by-name; nothing to fold safely.
    if (/export\s*\*/.test(source)) return undefined
    // The export clause is the chunk's last one — a linked sourcemap comment
    // can follow it, so anchor on "last `export{…}` that isn't a re-export"
    // rather than on end-of-file.
    const clauses = [
      ...source.matchAll(new RegExp(String.raw`export\s*${namedClause}\s*(?!from)`, 'g')),
    ]
    const clause = clauses.at(-1)
    const names = new Map<string, string>()
    for (const part of clause?.[1]?.split(',') ?? []) {
      const exported = part.split(' as ').at(-1)?.trim()
      if (exported) names.set(exported, `$${index}${exported}`)
    }
    aliases.set(name, names)
  }
  return aliases
}

/**
 * The rewrite for one group, compiled once: points a file's member imports at the
 * merged chunk, renaming each binding to its barrel alias. Answers `null` when a
 * member is referenced through a form the fold cannot rewrite.
 */
function memberRewriter(
  memberNames: string[],
  aliases: Map<string, Map<string, string>>,
  chunksDir: string,
) {
  const memberPattern = memberNames.map(escapeRegex).join('|')
  const specifier = String.raw`"\.[^"]*(?:${memberPattern})"`
  // Forms that can't be expressed against a renaming barrel.
  const vetoes = [
    new RegExp(String.raw`import\s*\*\s*as\s*[\w$]+\s*from\s*${specifier}`),
    new RegExp(String.raw`export\s*\*[^;]*from\s*${specifier}`),
    new RegExp(String.raw`import\(\s*${specifier}`),
    // The merged chunk's href is computed RELATIVE to each referrer, so a member named through an
    // absolute specifier (a publicPath URL) cannot be re-pointed. Unlinking it anyway leaves the
    // referrer importing a file that no longer exists — a 404 for every chunk, and a blank app.
    new RegExp(String.raw`"[^".][^"]*(?:${memberPattern})"`),
  ]
  const namedImport = new RegExp(
    String.raw`(import|export)\s*${namedClause}\s*from\s*(${specifier})`,
    'g',
  )
  const sideEffectImport = new RegExp(String.raw`import\s*(${specifier})`, 'g')

  const nameOf = (spec: string) => memberNames.find(name => spec.includes(name))!
  const rename = (clause: string, member: string) =>
    clause
      .split(',')
      .map(part => {
        const [imported, local] = part.split(' as ').map(item => item.trim())
        if (!imported) return part
        const alias = aliases.get(member)?.get(imported)
        if (!alias) return part
        return `${alias} as ${local ?? imported}`
      })
      .join(',')

  return (source: string, file: string) => {
    for (const veto of vetoes) if (veto.test(source)) return null
    const mergedHref = path
      .relative(path.dirname(file), path.join(chunksDir, MERGED_PLACEHOLDER))
      .split(path.sep)
      .join('/')
    const href = mergedHref.startsWith('.') ? mergedHref : `./${mergedHref}`
    return (
      source
        .replace(
          namedImport,
          (_all, keyword: string, clause: string, spec: string) =>
            `${keyword}{${rename(clause, nameOf(spec))}}from"${href}"`,
        )
        // Side-effect-only imports of a member collapse onto the merged chunk.
        .replace(sideEffectImport, () => `import"${href}"`)
    )
  }
}

/** Stands in for the merged chunk's final (content-hashed) name. */
const MERGED_PLACEHOLDER = ' pnext-merged '

async function buildMergedChunk(
  chunksDir: string,
  memberNames: string[],
  aliases: Map<string, Map<string, string>>,
  buildOptions: FoldOptions['buildOptions'],
) {
  const barrel = memberNames
    .map(name => {
      const names = aliases.get(name)!
      const spec = JSON.stringify(`./${name}`)
      if (names.size === 0) return `import ${spec};`
      const clause = [...names].map(([exported, alias]) => `${exported} as ${alias}`).join(',')
      return `export {${clause}} from ${spec};`
    })
    .join('\n')

  const barrelPath = path.join(chunksDir, '__pnext-fold-barrel.js')
  await writeText(barrelPath, barrel)
  try {
    const result = await build({
      minify: buildOptions.minify,
      sourcemap: buildOptions.sourcemap,
      target: buildOptions.target,
      format: buildOptions.format ?? 'esm',
      bundle: true,
      entryPoints: [barrelPath],
      outfile: path.join(chunksDir, '__pnext-fold-merged.js'),
      write: false,
      // Only the members are pulled in; every other chunk reference (including
      // the `import()`s that keep the idle tier deferred) passes through as-is.
      plugins: [
        {
          name: 'pnext-fold-members',
          setup(builder) {
            builder.onResolve({ filter: /.*/ }, args => {
              if (args.kind === 'entry-point') return undefined
              const base = path.basename(args.path)
              if (memberNames.includes(base)) return { path: path.join(chunksDir, base) }
              return { path: args.path, external: true }
            })
          },
        },
      ],
    })
    const js = result.outputFiles?.find(file => file.path.endsWith('.js'))
    if (!js) return undefined
    const hash = createHash('sha256').update(js.contents).digest('hex').slice(0, 8).toUpperCase()
    const name = `shared-init-${hash}.js`
    const map = result.outputFiles?.find(file => file.path.endsWith('.js.map'))
    let contents = new TextDecoder().decode(js.contents)
    if (map) {
      contents = contents.replace(/# sourceMappingURL=.*$/m, `# sourceMappingURL=${name}.map`)
      await writeText(path.join(chunksDir, `${name}.map`), new TextDecoder().decode(map.contents))
    }
    await writeText(path.join(chunksDir, name), contents)
    return { name, text: contents, bytes: Buffer.byteLength(contents) }
  } finally {
    await unlink(barrelPath).catch(ignoreMissing)
  }
}

/** An output file's text plus the relative specifiers it imports through. */
interface FoldOutput {
  text: string
  specifiers: string[]
}

function foldOutput(text: string): FoldOutput {
  // Absolute specifiers are indexed too, though the rewriter cannot express them: a referrer the
  // index cannot see is a referrer the fold silently strands. Being visible lets the veto fire.
  return { text, specifiers: [...text.matchAll(/"[./][^"]*"/g)].map(match => match[0]) }
}

/** Every output's text plus a basename->referrers index, read once. Chunk names
 * are content-hashed, so a specifier naming a member spells it as its basename. */
interface FoldState {
  outputs: Map<string, FoldOutput>
  /** Files whose specifiers name any of `names`, each visited once. */
  referrersOf(names: string[]): Iterable<string>
  set(file: string, output: FoldOutput): void
  remove(file: string): void
}

async function createFoldState(outDir: string, metafile: Metafile): Promise<FoldState> {
  const outputs = new Map<string, FoldOutput>()
  const referrers = new Map<string, Set<string>>()

  const index = (file: string, output: FoldOutput, add: boolean) => {
    for (const spec of output.specifiers) {
      const base = path.basename(spec.slice(1, -1))
      const set = referrers.get(base) ?? referrers.set(base, new Set()).get(base)!
      if (add) set.add(file)
      else set.delete(file)
    }
  }

  for (const name of Object.keys(metafile.outputs)) {
    if (!name.endsWith('.js')) continue
    const resolved = path.resolve(name)
    const local = existsSync(resolved) ? resolved : path.join(outDir, path.basename(name))
    if (outputs.has(local) || !existsSync(local)) continue
    const output = foldOutput(await readText(local))
    outputs.set(local, output)
    index(local, output, true)
  }

  return {
    outputs,
    referrersOf(names) {
      const seen = new Set<string>()
      for (const name of names) for (const file of referrers.get(name) ?? []) seen.add(file)
      return seen
    },
    set(file, output) {
      const previous = outputs.get(file)
      if (previous) index(file, previous, false)
      outputs.set(file, output)
      index(file, output, true)
    },
    remove(file) {
      const previous = outputs.get(file)
      if (previous) index(file, previous, false)
      outputs.delete(file)
    },
  }
}

/** The shipped graph, with the members collapsed into the merged chunk. */
function mergeMetafile(
  metafile: Metafile,
  members: string[],
  mergedPath: string,
  bytes: number,
): Metafile {
  const memberSet = new Set(members)
  const merged = path.relative(process.cwd(), mergedPath)
  const outputs: Metafile['outputs'] = {}
  const mergedImports: Metafile['outputs'][string]['imports'] = []
  const mergedInputs: Metafile['outputs'][string]['inputs'] = {}

  for (const [file, output] of Object.entries(metafile.outputs)) {
    const remap = (list: typeof output.imports) => {
      const seen = new Set<string>()
      return list.flatMap(imported => {
        const target = memberSet.has(imported.path) ? merged : imported.path
        const key = `${target}:${imported.kind}`
        if (seen.has(key)) return []
        seen.add(key)
        return [{ ...imported, path: target }]
      })
    }
    if (memberSet.has(file)) {
      Object.assign(mergedInputs, output.inputs)
      for (const imported of remap(output.imports ?? [])) {
        if (imported.path !== merged) mergedImports.push(imported)
      }
      continue
    }
    outputs[file] = { ...output, imports: remap(output.imports ?? []) }
  }
  outputs[merged] = {
    imports: mergedImports,
    exports: [],
    inputs: mergedInputs,
    bytes,
  }
  return { ...metafile, outputs }
}
