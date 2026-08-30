// Batched transform pass for server modules: plain ESM sources are transformed with oxc and get their
// import specifiers rewritten by us, instead of paying a per-module esbuild bundle whose only real job -
// with `packages:'external'` and every specifier resolved by our own plugin - is specifier rewriting.
//
// esbuild's bundler is still load-bearing for a handful of shapes (below); `transformBailReason` sniffs
// those out per file and the caller falls back to the esbuild build for them. Same pipeline in dev and prod.
import type { TransformOptions } from 'oxc-transform'

// Lazy: the native binding costs ~3.6 MB RSS and a prod server never transforms.
const transformSync: typeof import('oxc-transform').transformSync = (...args) =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  loadNative(() => require('oxc-transform') as typeof import('oxc-transform')).transformSync(
    ...args,
  )
import { loadNative } from '../utils/native-require'
import { isCommonJsModuleSource } from '../resolve/imports'

/** Why a source cannot take the transform path — one per esbuild-only shape. */
export type TransformBailReason =
  | 'commonjs' // require()/module.exports: CJS→ESM conversion + the require-alias map
  | 'glob-import' // non-literal `import()`: esbuild's `__glob` expansion
  | 'enum' // oxc's enum lowering omits `E || {}`, breaking declaration merging
  | 'helpers' // the transform needed @oxc-project/runtime helper imports
  | 'parse-error'
  | 'specifier' // a specifier the bundler resolves by inlining (assets with a
// loader rule, `#subpath` facades, require-aliases)

// `import(` whose argument is not a string literal — esbuild turns those into a
// `__glob({...})` map of the matching directory, which needs the bundler.
const NON_LITERAL_DYNAMIC_IMPORT = /\bimport\s*\(\s*(?!['"])[^)]/
const REQUIRE_CALL = /\brequire\s*\(/
const COMMONJS_EXPORTS = /\bmodule\.exports\b|\bexports\s*\.\s*[A-Za-z_$]/
const ENUM_DECLARATION = /(?:^|[^.\w$])enum\s+[A-Za-z_$]/

export function transformBailReason(source: string, file: string): TransformBailReason | undefined {
  if (
    REQUIRE_CALL.test(source) ||
    COMMONJS_EXPORTS.test(source) ||
    isCommonJsModuleSource(source, file)
  ) {
    return 'commonjs'
  }
  if (NON_LITERAL_DYNAMIC_IMPORT.test(source)) return 'glob-import'
  if (ENUM_DECLARATION.test(source)) return 'enum'
  return undefined
}

/**
 * TS/JSX → ESM for one server module. `define` mirrors the esbuild build's own
 * `define` so constant folding stays identical across the two paths.
 */
export function transformServerModule(
  source: string,
  file: string,
  define: Record<string, string> | undefined,
): { code: string } | { bail: TransformBailReason } {
  const options: TransformOptions = {
    lang: langForFile(file),
    jsx: { runtime: 'automatic', importSource: 'preact' },
    // No `target`: these modules are loaded by Bun, so syntax lowering buys nothing and oxc's
    // lowering plugins are expensive on the transform line.
    sourcemap: false,
    ...(define ? { define } : {}),
  }
  const result = transformSync(file, source, options)
  if (result.errors.length > 0) return { bail: 'parse-error' }
  // Runtime helpers would import `@oxc-project/runtime`, which the app does not
  // have; esbuild inlines its equivalents, so hand those sources back to it.
  if (Object.keys(result.helpersUsed).length > 0) return { bail: 'helpers' }
  return { code: dropUnreferencedImports(result.code) }
}

// `.ts` forbids JSX (`<T>x` is a type assertion); `.js`/`.jsx` app modules may
// contain JSX, matching the esbuild build's `loader: { '.js': 'jsx' }`.
function langForFile(file: string): 'ts' | 'tsx' | 'jsx' {
  if (/\.[mc]?ts$/.test(file)) return 'ts'
  if (file.endsWith('.tsx')) return 'tsx'
  return 'jsx'
}

// --------------------------------------------------------------------------
// emitted-module specifier scan
// --------------------------------------------------------------------------

export type SpecifierKind = 'import-statement' | 'dynamic-import'

export interface FoundSpecifier {
  start: number
  end: number
  value: string
  kind: SpecifierKind
}

const SPECIFIER_RE =
  /(?:^|[\n;{}])\s*(?:import|export)\b[^;'"]*?\bfrom\s*("[^"]*"|'[^']*')|(?:^|[\n;{}])\s*import\s*("[^"]*"|'[^']*')|\bimport\s*\(\s*("[^"]*"|'[^']*')\s*\)/g

/** Every module specifier in emitted ESM, with the span of its string literal. */
export function outputSpecifiers(code: string): FoundSpecifier[] {
  const found: FoundSpecifier[] = []
  SPECIFIER_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SPECIFIER_RE.exec(code))) {
    for (let group = 1; group <= 3; group += 1) {
      const literal = match[group]
      if (literal === undefined) continue
      const start = match.index + match[0].lastIndexOf(literal)
      found.push({
        start,
        end: start + literal.length,
        value: literal.slice(1, -1),
        kind: group === 3 ? 'dynamic-import' : 'import-statement',
      })
    }
  }
  return found
}

/** Apply `{start, end, value}` replacements to `code` (spans must not overlap). */
export function spliceSource(code: string, edits: { start: number; end: number; value: string }[]) {
  let next = code
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    next = `${next.slice(0, edit.start)}${edit.value}${next.slice(edit.end)}`
  }
  return next
}

// --------------------------------------------------------------------------
// drop-unreferenced-imports post-pass
// --------------------------------------------------------------------------

const IMPORT_STATEMENT_RE =
  /(?:^|\n)[ \t]*import\s+([A-Za-z_$][\w$]*\s*,\s*)?(?:\*\s*as\s+([A-Za-z_$][\w$]*)|\{([^}]*)\}|([A-Za-z_$][\w$]*))\s+from\s*(?:"[^"]*"|'[^']*')\s*;?/g

/**
 * oxc keeps an import whose only uses were type positions it could not see through; the emitted module then
 * imports a name the compiled target does not export and fails to load. esbuild's TS pipeline drops those,
 * so drop any import statement whose every binding is unreferenced in the rest of the module - textual and
 * therefore conservative: a name mentioned anywhere else, even in a string, keeps its import.
 * Side-effect-only `import 'x'` never matches this pattern and is always kept.
 */
export function dropUnreferencedImports(code: string) {
  const statements: { start: number; end: number; names: string[] }[] = []
  IMPORT_STATEMENT_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = IMPORT_STATEMENT_RE.exec(code))) {
    const [text, defaultWithNamed, namespace, named, defaultOnly] = match
    const names: string[] = []
    if (defaultWithNamed) names.push(defaultWithNamed.replace(/\s*,\s*$/, '').trim())
    if (namespace) names.push(namespace)
    if (defaultOnly) names.push(defaultOnly)
    if (named !== undefined) {
      for (const part of named.split(',')) {
        const local = part
          .split(/\bas\b/)
          .pop()
          ?.trim()
        // An unparsed clause (comments, odd spacing) yields no local name: keep.
        if (!local) continue
        if (!/^[A-Za-z_$][\w$]*$/.test(local)) return code
        names.push(local)
      }
    }
    if (names.length === 0) continue
    const leading = text.startsWith('\n') ? 1 : 0
    statements.push({ start: match.index + leading, end: match.index + text.length, names })
  }
  if (statements.length === 0) return code

  // Reference test runs against the module with every import statement cut out,
  // so one import's bindings never count as a use of another's.
  const gaps: string[] = []
  let cursor = 0
  for (const statement of statements) {
    gaps.push(code.slice(cursor, statement.start))
    cursor = statement.end
  }
  gaps.push(code.slice(cursor))
  const used = referencedNames(gaps.join('\n'))
  const unused = statements.filter(statement => statement.names.every(name => !used.has(name)))
  if (unused.length === 0) return code
  return spliceSource(
    code,
    unused.map(({ start, end }) => ({ start, end, value: '' })),
  )
}

const IDENTIFIER_RE = /[A-Za-z_$][\w$]*/g

/**
 * Every identifier token that is not a member-access property name. A single
 * leading `.` is member access (`obj.name`, `obj?.name`); a doubled one is the
 * spread/rest operator (`...name`), which IS a reference.
 */
function referencedNames(body: string) {
  const names = new Set<string>()
  IDENTIFIER_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = IDENTIFIER_RE.exec(body))) {
    if (body[match.index - 1] === '.' && body[match.index - 2] !== '.') continue
    names.add(match[0])
  }
  return names
}
