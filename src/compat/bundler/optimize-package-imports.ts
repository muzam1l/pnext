// `experimental.optimizePackageImports` (COMPAT). A barrel package re-exports its whole catalogue
// from one entry and the vendor pipeline compiles the ENTRY, so a route naming four icons makes the
// server evaluate the whole barrel.
//
// Rewrite `import { A, B } from 'pkg'` into per-member imports of the LEAF modules. Configured and
// Next-default packages use explicit re-exports; large generated catalogues are detected from their
// export/leaf shape. Each leaf becomes an ordinary vendor demand, so the existing per-package grouping
// compiles demanded subpaths as entries of one `splitting: true` build.
//
// Unlike `modularizeImports` (a user-written path template), the leaf map is DERIVED from the
// barrel itself, so nothing here encodes a package's layout. Derivation is also the safety gate:
// listed entries must be pure re-export barrels, and automatic catalogue detection additionally
// verifies each export's re-export target against its same-named sibling file, or - for a catalogue
// that aliases many names onto few leaves - that the entry is nothing but unambiguous re-exports.

import path from 'node:path'
import { readFileSync, readdirSync, statSync } from 'node:fs'
// Lazy: the oxc-parser native binding costs ~12.6 MB RSS; load it only when a parse happens.
const parseSync: typeof import('oxc-parser').parseSync = (...args) =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  loadNative(() => require('oxc-parser') as typeof import('oxc-parser')).parseSync(...args)
import { loadNative } from '../../utils/native-require'
import { rewriteFacts, type ImportBinding } from '../../resolve/scan-facts'
import { spliceSource } from '../../runtime/module-transform'
import { resolvePackageSpecifier, resolveVendorPackageSpecifier } from '../../resolve/imports'
import { withSniff, type ServerSourceTransform } from '../../extensions'
import { escapeRegex, stripComments } from '../../utils/code'

/**
 * Next's default `optimizePackageImports` set - the barrels big enough that compiling the entry is the
 * dominant cost. Extended by the config option. Every name is still gated by the applicable derivation
 * below, so a package that fails its safety gate costs nothing but one parse.
 */
const DEFAULT_OPTIMIZED_PACKAGES = [
  'lucide-react',
  'date-fns',
  'lodash-es',
  'ramda',
  'antd',
  'react-bootstrap',
  'ahooks',
  '@ant-design/icons',
  '@headlessui/react',
  '@headlessui-float/react',
  '@heroicons/react/20/solid',
  '@heroicons/react/24/solid',
  '@heroicons/react/24/outline',
  '@visx/visx',
  '@tremor/react',
  '@mui/material',
  '@mui/icons-material',
  '@material-ui/core',
  '@material-ui/icons',
  '@tabler/icons-react',
  '@phosphor-icons/react',
  'react-use',
  'recharts',
  'rxjs',
]

const GENERATED_BARREL_MIN_BYTES = 64 * 1024
const GENERATED_BARREL_MIN_EXPORTS = 16
const GENERATED_BARREL_LEAF_RATIO = 0.8
const OPTIMIZE_PACKAGE_IMPORTS_SNIFF_TOKENS = ['import'] as const

export function optimizedPackageSet(configured: readonly string[]): string[] {
  // Rewriting a barrel changes what the vendor pipeline compiles, so it is also
  // what a slow or wrong artifact has to be bisected against — and how the
  // bench A/Bs it (same seam shape as `PNEXT_VENDOR_GROUP=0`).
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  if (process.env.PNEXT_OPTIMIZE_PACKAGE_IMPORTS === '0') return []
  return [...new Set([...DEFAULT_OPTIMIZED_PACKAGES, ...configured])]
}

/** Where one exported name really lives: the barrel's re-export target. */
interface BarrelMember {
  /** The leaf module, relative to the barrel entry. */
  source: string
  /** The name to take from it: `default`, `*`, or an export name. */
  imported: string
  /** Font Awesome entry binding, checked lazily against the demanded leaf. */
  fontAwesomeLocal?: string
}

/** The exported names a pure re-export barrel publishes, and their leaves. */
type BarrelMap = ReadonlyMap<string, BarrelMember>

const barrelMaps = new Map<string, BarrelMap | undefined>()

/**
 * The leaf map of a barrel entry, or undefined when its configured/automatic
 * safety gate fails. Cached per entry file and mode.
 */
function barrelMap(entry: string, automatic: boolean): BarrelMap | undefined {
  const key = `${automatic ? 'auto' : 'listed'}\0${entry}`
  if (barrelMaps.has(key)) return barrelMaps.get(key)
  let map: BarrelMap | undefined
  try {
    map = automatic ? parseGeneratedBarrel(entry) : parseBarrel(entry)
  } catch {
    map = undefined
  }
  barrelMaps.set(key, map)
  return map
}

function parseBarrel(entry: string): BarrelMap | undefined {
  const source = readFileSync(entry, 'utf8')
  const parsed = parseSync(entry, source, { lang: 'js' })
  if (parsed.errors.length > 0) return undefined

  // A namespace re-export (`import * as icons from './icons/index.js'; export
  // { icons }`) is two statements; the local binding is only allowed to leave
  // the module through that export, or the barrel is doing something else.
  const namespaces = new Map<string, string>()
  for (const node of parsed.program.body) {
    if (node.type === 'ImportDeclaration') {
      const specifiers = node.specifiers ?? []
      const only = specifiers[0]
      if (specifiers.length !== 1 || only?.type !== 'ImportNamespaceSpecifier') return undefined
      namespaces.set(only.local.name, node.source.value)
      continue
    }
    if (node.type === 'ExportNamedDeclaration') {
      // `export const x = …` is a definition, not a re-export: not a barrel.
      if (node.declaration) return undefined
      continue
    }
    // `export * from` hides its names in the target, so a demanded name cannot
    // be attributed to a leaf; anything else is code with a side effect.
    return undefined
  }

  const members = new Map<string, BarrelMember>()
  for (const statement of parsed.module.staticExports) {
    for (const record of statement.entries) {
      if (record.isType) continue
      const exported = record.exportName.name
      if (!exported) return undefined
      const request = record.moduleRequest?.value
      if (request) {
        const kind: string = record.importName.kind
        if (kind === 'AllButDefault') return undefined
        const imported =
          kind === 'Default' ? 'default' : kind === 'All' ? '*' : record.importName.name
        if (!imported) return undefined
        if (!addMember(members, exported, { source: request, imported })) return undefined
        continue
      }
      const local = record.localName.name
      const namespace = local === null ? undefined : namespaces.get(local)
      if (!namespace) return undefined
      if (!addMember(members, exported, { source: namespace, imported: '*' })) return undefined
    }
  }
  return members.size > 0 ? members : undefined
}

function addMember(members: Map<string, BarrelMember>, name: string, member: BarrelMember) {
  const prior = members.get(name)
  if (prior && (prior.source !== member.source || prior.imported !== member.imported)) return false
  members.set(name, member)
  return true
}

/**
 * Detect generated catalogues whose entry explicitly re-exports same-named
 * sibling modules. Requiring a large entry, a side-effect-free package, and an
 * overwhelming filename/export match keeps this automatic path away from
 * ordinary package entries. Inline definitions are not equivalent merely
 * because a sibling has the same name; the only exception is Font Awesome's
 * generated Pro/Sharp shape, whose leaf definition is checked against the
 * entry definition before it is mapped.
 */
function parseGeneratedBarrel(entry: string): BarrelMap | undefined {
  if (statSync(entry).size < GENERATED_BARREL_MIN_BYTES) return undefined
  const packageDir = packageDirOf(entry)
  if (!packageDir || !packageHasNoSideEffects(packageDir)) return undefined

  const source = readFileSync(entry, 'utf8')
  if (isGeneratedFontAwesomePackage(packageDir)) {
    return parseGeneratedFontAwesomeBarrel(entry, source)
  }
  const parsed = parseSync(entry, source, { lang: 'js' })
  if (parsed.errors.length > 0) return undefined
  const siblings = siblingFilesByStem(path.dirname(entry), entry)
  const exports = new Map<string, BarrelMember>()
  const exportNames = new Set<string>()
  let exportCount = 0
  for (const statement of parsed.module.staticExports) {
    for (const record of statement.entries) {
      if (record.isType) continue
      const name = record.exportName.name
      if (!name || exportNames.has(name)) return undefined
      exportNames.add(name)
      exportCount++
      const request = record.moduleRequest?.value
      if (!request) {
        return undefined
      }
      const kind: string = record.importName.kind
      if (kind === 'AllButDefault') return undefined
      const imported =
        kind === 'Default' ? 'default' : kind === 'All' ? '*' : record.importName.name
      if (!imported) return undefined
      exports.set(name, { source: request, imported })
    }
  }
  if (exportCount < GENERATED_BARREL_MIN_EXPORTS) return undefined

  const members = new Map<string, BarrelMember>()
  for (const [name, member] of exports) {
    const files = siblings.get(name)
    const file = files?.[0]
    if (
      file &&
      files.length === 1 &&
      path.resolve(path.dirname(entry), member.source) === path.resolve(path.dirname(entry), file)
    ) {
      members.set(name, member)
    }
  }
  if (members.size / exportCount >= GENERATED_BARREL_LEAF_RATIO) return members
  return manyToFewBarrelMembers(parsed.program.body, exports, entry)
}

/**
 * The same-named-sibling ratio describes one-export-per-file catalogues. A generated barrel may
 * instead publish thousands of aliases over a handful of leaves, where no export name is a filename.
 * The invariant that makes THAT shape safe is the one the listed path already relies on: every
 * demanded name resolves statically to exactly one re-export record, and the entry runs no code
 * beyond those re-exports. Members whose leaf stem is ambiguous on disk are dropped, so a demanded
 * name that could resolve to a different extension stays on the barrel. Leaf contents are still only
 * read for demanded members.
 */
function manyToFewBarrelMembers(
  body: readonly { type: string; declaration?: unknown }[],
  exports: ReadonlyMap<string, BarrelMember>,
  entry: string,
): BarrelMap | undefined {
  for (const node of body) {
    if (node.type !== 'ExportNamedDeclaration' || node.declaration) return undefined
  }
  const byDirectory = new Map<string, Map<string, string[]>>()
  const members = new Map<string, BarrelMember>()
  for (const [name, member] of exports) {
    if (!member.source.startsWith('.')) continue
    const file = path.resolve(path.dirname(entry), member.source)
    const directory = path.dirname(file)
    let siblings = byDirectory.get(directory)
    if (!siblings) {
      siblings = siblingFilesByStem(directory, entry)
      byDirectory.set(directory, siblings)
    }
    if (siblings.get(path.basename(file).replace(/\.(?:c|m)?js$/, ''))?.length !== 1) continue
    members.set(name, member)
  }
  return members.size > 0 ? members : undefined
}

/** The `.js`-family files of a directory, grouped by stem, so an ambiguous stem is visible. */
function siblingFilesByStem(directory: string, exclude: string) {
  const siblings = new Map<string, string[]>()
  for (const file of readdirSync(directory)) {
    const match = /^(.*)\.(?:c|m)?js$/.exec(file)
    if (!match?.[1] || path.resolve(directory, file) === exclude) continue
    const files = siblings.get(match[1]) ?? []
    files.push(file)
    siblings.set(match[1], files)
  }
  return siblings
}

function isGeneratedFontAwesomePackage(packageDir: string) {
  const packageName = packageNameOfDir(packageDir)
  return packageName !== undefined && /^@fortawesome\/(?:pro|sharp)-.+-svg-icons$/.test(packageName)
}

/**
 * Font Awesome's generated Pro/Sharp entries are multi-megabyte inline catalogues with one final
 * export list. Parsing the whole catalogue synchronously costs more than a second per style even
 * though an import demands only a handful of leaves. Read that explicit export list directly, then
 * retain the same per-demand definition/leaf identity check in `resolveLeafSpecifier`.
 */
function parseGeneratedFontAwesomeBarrel(entry: string, source: string): BarrelMap | undefined {
  const start = source.lastIndexOf('\nexport {')
  if (start < 0) return undefined
  const open = source.indexOf('{', start)
  const close = source.indexOf('};', open + 1)
  if (open < 0 || close < 0 || source.slice(close + 2).trim() !== '') return undefined

  const siblings = siblingFilesByStem(path.dirname(entry), entry)

  const members = new Map<string, BarrelMember>()
  let exportCount = 0
  for (const raw of source.slice(open + 1, close).split(',')) {
    const match = /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(raw)
    if (!match?.[1]) return undefined
    const local = match[1]
    const exported = match[2] ?? local
    exportCount++
    const files = siblings.get(exported)
    const file = files?.[0]
    if (!file || files.length !== 1 || members.has(exported)) continue
    members.set(exported, {
      source: `./${file}`,
      imported: exported,
      fontAwesomeLocal: local,
    })
  }
  if (exportCount < GENERATED_BARREL_MIN_EXPORTS) return undefined
  if (members.size / exportCount < GENERATED_BARREL_LEAF_RATIO) return undefined
  fontAwesomeBarrelSources.set(entry, source)
  return members
}

const fontAwesomeBarrelSources = new Map<string, string>()

function leafMatchesFontAwesomeDefinition(file: string, exported: string, definition: string) {
  const leaf = readFileSync(file, 'utf8')
  if (
    !new RegExp(`(?:^|\\n)exports\\.${escapeRegex(exported)}\\s*=\\s*exports\\.definition;`).test(
      leaf,
    )
  ) {
    return false
  }
  for (const field of ['prefix', 'iconName', 'unicode', 'svgPathData']) {
    const match = new RegExp(`(?:^|\\n)var ${field} = (['"])(.*)\\1;`).exec(leaf)
    if (!match?.[2] || !definition.includes(match[2])) return false
  }
  return true
}

function fontAwesomeEntryDefinition(source: string, exportedLocal: string) {
  let local = exportedLocal
  const visited = new Set<string>()
  while (!visited.has(local)) {
    visited.add(local)
    const marker = `var ${local} = `
    const markerAt = source.indexOf(`\n${marker}`)
    const start = markerAt >= 0 ? markerAt + 1 : source.startsWith(marker) ? 0 : -1
    if (start < 0) return undefined
    const valueStart = start + marker.length
    if (source[valueStart] === '{') {
      const end = source.indexOf('\n};', valueStart)
      return end < 0 ? undefined : source.slice(start, end + 3)
    }
    const end = source.indexOf(';', valueStart)
    if (end < 0) return undefined
    const alias = source.slice(valueStart, end).trim()
    if (!/^[A-Za-z_$][\w$]*$/.test(alias)) return undefined
    local = alias
  }
  return undefined
}

function packageHasNoSideEffects(packageDir: string) {
  return packageMetadata(packageDir)?.sideEffects === false
}

const packageMetadataCache = new Map<
  string,
  { sideEffects?: unknown; exports?: unknown } | undefined
>()

function packageMetadata(packageDir: string) {
  if (packageMetadataCache.has(packageDir)) return packageMetadataCache.get(packageDir)
  let metadata: { sideEffects?: unknown; exports?: unknown } | undefined
  try {
    metadata = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as {
      sideEffects?: unknown
      exports?: unknown
    }
  } catch {
    metadata = undefined
  }
  packageMetadataCache.set(packageDir, metadata)
  return metadata
}

/**
 * The barrel entry, but only when both layers resolve the specifier to the SAME
 * file: a package that splits its entry per condition publishes a different
 * catalogue per layer, and one rewritten source is compiled for both.
 */
function barrelEntry(root: string, file: string, specifier: string) {
  const client = resolveVendorPackageSpecifier(root, file, specifier, CLIENT_CONDITIONS)
  if (!client) return undefined
  return resolveVendorPackageSpecifier(root, file, specifier, SERVER_CONDITIONS) === client
    ? client
    : undefined
}

/**
 * The bare specifier that names a leaf module - what the rewrite emits, so the leaf goes through the
 * ordinary package-resolution and vendor-grouping paths rather than a raw path only this transform could
 * resolve. Verified by re-resolving it: a package whose `exports` map withholds the subpath resolves to
 * something else, and then the member is left on the barrel. Verified under BOTH layers' conditions,
 * because one rewritten source is compiled for both.
 */
function leafSpecifier(root: string, entry: string, member: BarrelMember): string | undefined {
  const key = `${entry}\0${member.source}\0${member.imported}`
  if (leafSpecifiers.has(key)) return leafSpecifiers.get(key)
  const specifier = resolveLeafSpecifier(root, entry, member)
  leafSpecifiers.set(key, specifier)
  return specifier
}

const leafSpecifiers = new Map<string, string | undefined>()

const CLIENT_CONDITIONS = ['module', 'import']
const SERVER_CONDITIONS = ['react-server', 'node', 'module', 'import']

function resolveLeafSpecifier(root: string, entry: string, member: BarrelMember) {
  if (!member.source.startsWith('.')) return undefined
  const file = path.resolve(path.dirname(entry), member.source)
  if (member.fontAwesomeLocal) {
    const source = fontAwesomeBarrelSources.get(entry)
    const definition = source && fontAwesomeEntryDefinition(source, member.fontAwesomeLocal)
    if (!definition || !leafMatchesFontAwesomeDefinition(file, member.imported, definition)) {
      return undefined
    }
  }
  const packageDir = packageDirOf(entry)
  if (!packageDir) return undefined
  const name = packageNameOfDir(packageDir)
  const relative = path.relative(packageDir, file)
  if (!name || relative.startsWith('..') || path.isAbsolute(relative)) return undefined
  const subpath = relative.split(path.sep).join('/')
  const extensionless = subpath.replace(/\.(?:c|m)?js$/, '')
  const full = `${name}/${subpath}`
  const short = `${name}/${extensionless}`
  const mirrored =
    packageMetadata(packageDir)?.exports === undefined || extensionless === subpath
      ? [full]
      : [short, full]
  // The published subpath first: a package whose `exports` maps its leaves under a rewritten prefix
  // (`"./icons/*": "./dist/icons/*.js"`) has no public specifier that mirrors the file path, and
  // pnext's resolver would otherwise settle for one `exports` withholds.
  const candidates = new Set([...exportsMapSpecifiers(packageDir, name, subpath), ...mirrored])
  for (const specifier of candidates) {
    if (
      [CLIENT_CONDITIONS, SERVER_CONDITIONS].every(
        conditions => resolvePackageSpecifier(root, entry, specifier, conditions) === file,
      ) &&
      leafHasExport(file, member.imported)
    ) {
      return specifier
    }
  }
  return undefined
}

/**
 * The specifiers a package's `exports` map could publish a leaf file under, by inverting each
 * subpath target against the file. Only a proposal: every candidate is still accepted by
 * re-resolving it back to the same file under both layers' conditions.
 */
function exportsMapSpecifiers(packageDir: string, name: string, subpath: string): string[] {
  const map = packageMetadata(packageDir)?.exports
  if (map === undefined) return []
  const target = `./${subpath}`
  const specifiers: string[] = []
  const visit = (key: string, value: unknown) => {
    if (typeof value === 'string') {
      const matched = matchExportsTarget(key, value, target)
      if (matched !== undefined)
        specifiers.push(`${name}${matched === '.' ? '' : matched.slice(1)}`)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(key, item)
      return
    }
    if (!value || typeof value !== 'object') return
    for (const [inner, nested] of Object.entries(value)) {
      visit(inner.startsWith('.') ? inner : key, nested)
    }
  }
  visit('.', map)
  return specifiers
}

/** The subpath key `target` publishes `file` under, substituting one wildcard. */
function matchExportsTarget(key: string, target: string, file: string) {
  if (!key.startsWith('.')) return undefined
  const star = target.indexOf('*')
  if (star < 0) return target === file ? key : undefined
  const prefix = target.slice(0, star)
  const suffix = target.slice(star + 1)
  if (!file.startsWith(prefix) || !file.endsWith(suffix)) return undefined
  const value = file.slice(prefix.length, file.length - suffix.length)
  return value && key.includes('*') ? key.replace('*', value) : undefined
}

const leafExports = new Map<string, ReadonlySet<string> | undefined>()

function leafHasExport(file: string, name: string) {
  if (name === '*') return true
  if (!leafExports.has(file)) {
    let names: Set<string> | undefined
    try {
      const source = readFileSync(file, 'utf8')
      const parsed = parseSync(file, source, { lang: 'js' })
      if (parsed.errors.length === 0) {
        names = new Set<string>()
        for (const statement of parsed.module.staticExports) {
          for (const record of statement.entries) {
            if (record.isType) continue
            const kind: string = record.exportName.kind
            if (kind === 'Default') names.add('default')
            else if (record.exportName.name) names.add(record.exportName.name)
          }
        }
        const code = stripComments(source)
        for (const match of code.matchAll(/(?:^|\n)\s*exports\.([A-Za-z_$][\w$]*)\s*=/g)) {
          if (match[1]) names.add(match[1])
        }
        if (/(?:^|\n)\s*module\.exports\s*=/.test(code)) names.add('default')
      }
    } catch {
      names = undefined
    }
    leafExports.set(file, names)
  }
  const names = leafExports.get(file)
  if (names?.has(name)) return true
  // Computed CommonJS export names are rare but valid identifiers in generated leaves.
  if (!names) return false
  const source = stripComments(readFileSync(file, 'utf8'))
  return new RegExp(`(?:^|\\n)\\s*exports\\[(['"])${escapeRegex(name)}\\1\\]\\s*=`).test(source)
}

/** The installed package a barrel entry belongs to, by its `node_modules` segment. */
function packageDirOf(entry: string) {
  const marker = `${path.sep}node_modules${path.sep}`
  const index = entry.lastIndexOf(marker)
  if (index < 0) return undefined
  const rest = entry.slice(index + marker.length).split(path.sep)
  const segments = rest[0]?.startsWith('@') ? rest.slice(0, 2) : rest.slice(0, 1)
  return path.join(entry.slice(0, index + marker.length), ...segments)
}

function packageNameOfDir(packageDir: string) {
  const marker = `${path.sep}node_modules${path.sep}`
  const index = packageDir.lastIndexOf(marker)
  if (index < 0) return undefined
  return packageDir
    .slice(index + marker.length)
    .split(path.sep)
    .join('/')
}

/**
 * Rewrite one matched import into per-leaf imports, or undefined to leave it alone - a default/namespace
 * import of the barrel itself, a type-only clause, or a name the barrel does not re-export from a
 * resolvable leaf.
 */
function expandBarrelImport(
  bindings: readonly ImportBinding[],
  map: BarrelMap,
  root: string,
  entry: string,
): string | undefined {
  if (bindings.length === 0) return undefined
  const statements: string[] = []
  for (const binding of bindings) {
    // A barrel publishes its types off the same entry, so `{ Icon, type Props }`
    // is the common shape. The type binding is erased before anything resolves
    // it, so dropping it is what lets the value bindings split at all.
    if (binding.type) continue
    if (binding.imported === 'default' || binding.imported === '*') return undefined
    const member = map.get(binding.imported)
    if (!member) return undefined
    const specifier = leafSpecifier(root, entry, member)
    if (!specifier) return undefined
    const target = JSON.stringify(specifier)
    if (member.imported === 'default') statements.push(`import ${binding.local} from ${target};`)
    else if (member.imported === '*')
      statements.push(`import * as ${binding.local} from ${target};`)
    else {
      const named =
        member.imported === binding.local ? binding.local : `${member.imported} as ${binding.local}`
      statements.push(`import { ${named} } from ${target};`)
    }
  }
  return statements.length > 0 ? statements.join(' ') : undefined
}

/**
 * The transform. Registered on both layers' chains: one rewritten source is
 * compiled for the RSC graph and the browser graph, which is why the leaf
 * specifier has to resolve identically under both.
 */
export function createOptimizePackageImportsTransform(
  packages: readonly string[],
  root: string,
): ServerSourceTransform {
  if (packages.length === 0) return withSniff([], source => source)
  const optimized = new Set(packages)
  return withSniff(OPTIMIZE_PACKAGE_IMPORTS_SNIFF_TOKENS, (source, file) => {
    const edits: { start: number; end: number; value: string }[] = []
    for (const statement of rewriteFacts(file, source).imports) {
      const listed = optimized.has(statement.specifier)
      if (!listed && packageNameOfDirSpecifier(statement.specifier) !== statement.specifier)
        continue
      const entry = barrelEntry(root, file, statement.specifier)
      const map = entry && barrelMap(entry, !listed)
      if (!map || !entry) continue
      const expanded = expandBarrelImport(statement.bindings, map, root, entry)
      if (expanded !== undefined) {
        edits.push({ start: statement.start, end: statement.end, value: expanded })
      }
    }
    return edits.length > 0 ? spliceSource(source, edits) : source
  })
}

function packageNameOfDirSpecifier(specifier: string) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/** Sniff used by load hooks that re-offer this transform outside source roots. */
export function optimizePackageImportsSniffTokens(packages: readonly string[]) {
  return packages.length > 0 ? OPTIMIZE_PACKAGE_IMPORTS_SNIFF_TOKENS : []
}
