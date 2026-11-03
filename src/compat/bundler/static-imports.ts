import { pathToFileHref } from '../../config'
import { rewriteFacts, rewriteSpecifierLiterals } from '../../resolve/scan-facts'
import { spliceSource } from '../../runtime/module-transform'
import { uniqueIdentifier } from '../../utils/code'

export const nextDefaultImportSpecifiers = [
  'next/cache',
  'next/client',
  'next/compat/router',
  'next/offline',
  'next/web-vitals',
]

export function rewriteNextCallableRequires(
  source: string,
  file: string,
  aliases?: Readonly<Record<string, string>>,
): string {
  if (!source.includes('require')) return source
  const imports = new Map<string, { namespace: string; value: string }>()
  const edits: { start: number; end: number; value: string }[] = []
  for (const edge of rewriteFacts(file, source).edges) {
    if (
      edge.kind !== 'require' ||
      !['next/head', 'next/link'].includes(edge.specifier.replace(/\.js$/, ''))
    )
      continue
    if (aliases && !aliases[edge.specifier]) continue
    const before = /\brequire\s*\(\s*$/.exec(source.slice(0, edge.start))
    const after = /^\s*\)/.exec(source.slice(edge.end))
    if (!before || !after) continue
    let binding = imports.get(edge.specifier)
    if (!binding) {
      const namespace = uniqueIdentifier(source, `__pnextRequired${imports.size}`)
      const value = uniqueIdentifier(source, `${namespace}Value`)
      binding = { namespace, value }
      imports.set(edge.specifier, binding)
    }
    const { namespace, value } = binding
    edits.push({
      start: before.index,
      end: edge.end + after[0].length,
      value: `(${value} ??= Object.assign(${namespace}.default, ${namespace}, { default: ${namespace}.default }))`,
    })
  }
  if (!edits.length) return source
  // Appended imports and var bindings are hoisted without disturbing the directive prologue.
  return (
    spliceSource(source, edits) +
    '\n' +
    [...imports]
      .map(
        ([specifier, { namespace, value }]) =>
          `import * as ${namespace} from ${JSON.stringify(specifier)}; var ${value};`,
      )
      .join('\n')
  )
}

export function rewriteNextDefaultImports(
  source: string,
  file: string,
  aliases?: Readonly<Record<string, string>>,
): string {
  if (!source.includes('import')) return source
  const edits: { start: number; end: number; value: string }[] = []
  for (const statement of rewriteFacts(file, source).imports) {
    const specifier = statement.specifier.replace(/\.js$/, '')
    if (!nextDefaultImportSpecifiers.includes(specifier)) continue
    if (aliases && !aliases[statement.specifier]) continue
    const primary = statement.bindings.find(binding => binding.imported === 'default')
    if (!primary || primary.type) continue
    const target = JSON.stringify(statement.specifier)
    const rest = statement.bindings.filter(binding => binding !== primary)
    const imports = rest.map(binding =>
      binding.imported === '*'
        ? `import * as ${binding.local} from ${target};`
        : `import { ${binding.type ? 'type ' : ''}${binding.imported} as ${binding.local} } from ${target};`,
    )
    // Webpack defaults a CommonJS cache entry to its namespace without adding a namespace default.
    if (specifier === 'next/cache') imports.unshift(`import * as ${primary.local} from ${target};`)
    else {
      imports.push(`const ${primary.local} = undefined;`)
      if (rest.length === 0) {
        const unused = uniqueIdentifier(source, `__pnext_${primary.local}`)
        imports.unshift(`import * as ${unused} from ${target}; void ${unused};`)
      }
    }
    edits.push({ start: statement.start, end: statement.end, value: imports.join('\n') })
  }
  return edits.length ? spliceSource(source, edits) : source
}

/**
 * Resolve registered compat aliases before Bun reaches installed package entries. Folded onto the
 * memoized module record: only real import/export/dynamic-import/require specifiers are considered, so
 * an alias key quoted inside a string or a comment - which the old specifier regex rewrote - is never
 * touched.
 */
export function rewriteStaticCompatImports(
  source: string,
  file: string,
  aliases: Readonly<Record<string, string>>,
  requireAliases: Readonly<Record<string, string>> = {},
): string {
  source = rewriteNextDefaultImports(source, file, aliases)
  source = rewriteNextCallableRequires(source, file, aliases)
  return rewriteSpecifierLiterals(source, file, (specifier, kind) => {
    // A side-effect `import 'x'` keeps resolving through the host resolver, as
    // it did under the `from`-anchored regex this replaced.
    const target = kind === 'side-effect' ? undefined : aliases[specifier]
    if (!target) return undefined
    const resolved =
      kind === 'require' ? (requireAliases[specifier] ?? target) : pathToFileHref(target)
    return JSON.stringify(resolved)
  })
}
