// next.config `modularizeImports` (COMPAT).
//
// Next rewrites barrel `import { A, B } from '<specifier>'` into per-member imports of individual
// modules, driven by a `transform` template. For fixtures whose barrel file does not exist at all (only
// the per-member modules do), the rewrite is the ONLY way the import resolves.
//
// This is a plain source transform: for each configured specifier it splits a matching named-import
// statement into one import per member, applying the template with the kebabCase/camelCase/lowerCase/
// upperCase helpers. `skipDefaultConversion: true` emits a NAMED import of the original member name
// from the target module; otherwise a DEFAULT import. Aliasing is preserved.
//
// It runs BEFORE path-alias resolution, so the emitted specifiers still flow through tsconfig `paths`
// resolution. Namespace, default and mixed-default imports of the specifier are left untouched - Next
// bails on those too.

import { rewriteFacts, type ImportBinding } from '../../resolve/scan-facts'
import { spliceSource } from '../../runtime/module-transform'
import { withSniff, type ServerSourceTransform } from '../../extensions'
import { specifierSniffTokens } from '../../utils/code'

/** A normalized `modularizeImports[specifier]` entry (string-template form). */
export interface ModularizeRule {
  /** The output-path template, e.g. `'#/design-system/icons/{{ kebabCase member }}'`. */
  transform: string
  /** `true` => named import of the member from the target; otherwise a default import. */
  skipDefaultConversion?: boolean
}

/** Split an identifier into words on camelCase / digit / `_` / `-` boundaries. */
function splitWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

/** Apply a template helper (`kebabCase`/`camelCase`/`lowerCase`/`upperCase`) to a member name. */
function applyHelper(helper: string, member: string): string {
  switch (helper) {
    case 'kebabCase':
      return splitWords(member)
        .map(word => word.toLowerCase())
        .join('-')
    case 'camelCase':
      return splitWords(member)
        .map((word, index) =>
          index === 0 ? word.toLowerCase() : word[0]!.toUpperCase() + word.slice(1).toLowerCase(),
        )
        .join('')
    case 'lowerCase':
      return member.toLowerCase()
    case 'upperCase':
      return member.toUpperCase()
    default:
      return member
  }
}

/** Expand `{{ member }}` / `{{ helper member }}` placeholders in a transform template. */
function applyTemplate(template: string, member: string): string {
  return template.replace(/\{\{\s*(?:(\w+)\s+)?member\s*\}\}/g, (_full, helper?: string) =>
    helper ? applyHelper(helper, member) : member,
  )
}

/**
 * Rewrite the members of one matched named import into per-member import
 * statements. Returns `undefined` (leaving the original import untouched) for a
 * clause the rewrite does not own: no members, or a `type` import.
 */
function expandMembers(
  bindings: readonly ImportBinding[],
  rule: ModularizeRule,
): string | undefined {
  if (bindings.length === 0) return undefined

  const statements: string[] = []
  for (const binding of bindings) {
    if (binding.type || binding.imported === 'default' || binding.imported === '*') return undefined
    const original = binding.imported
    const local = binding.local
    const target = JSON.stringify(applyTemplate(rule.transform, original))
    if (rule.skipDefaultConversion) {
      const named = original === local ? original : `${original} as ${local}`
      statements.push(`import { ${named} } from ${target};`)
    } else {
      statements.push(`import ${local} from ${target};`)
    }
  }
  return statements.join(' ')
}

/**
 * Build a source transform applying the configured `modularizeImports` rules.
 * Returns a no-op transform when nothing is configured so pure-core apps pay
 * nothing.
 */
export function createModularizeImportsTransform(
  rules: Record<string, ModularizeRule>,
): ServerSourceTransform {
  if (Object.keys(rules).length === 0) return withSniff([], source => source)

  // Folded onto the module record: one memoized parse instead
  // of a per-rule import regex, and a configured specifier quoted in a string or
  // a comment no longer expands.
  return withSniff(specifierSniffTokens(Object.keys(rules)), (source, file) => {
    if (!source.includes('import')) return source
    const edits: { start: number; end: number; value: string }[] = []
    for (const statement of rewriteFacts(file, source).imports) {
      const rule = rules[statement.specifier]
      if (!rule) continue
      const expanded = expandMembers(statement.bindings, rule)
      if (expanded !== undefined) {
        edits.push({ start: statement.start, end: statement.end, value: expanded })
      }
    }
    return edits.length > 0 ? spliceSource(source, edits) : source
  })
}
