// One oxc-parser pass per unique source, memoized by content: every module fact the scanners need (imports,
// re-exports, `export *`, own export names, the `'use client'` directive) comes from that single parse
// instead of the regex passes and transpiler scan they replace. Regexes read comments and strings as code
// (phantom `type` imports, `'use client'` inside a comment) and never saw `export * from`; the transpiler
// scan reports its own injected JSX-runtime imports and throws on a shebang.
//
// Expression-shaped facts (dynamic() options, segment config, request-API use) stay on their gated string
// passes - materializing the full AST for them is slower than the passes they would replace.
//
// The same parse also backs `rewriteFacts`: the record-shaped rewrite passes (specifier aliasing, namespace
// imports, import.meta.url) splice byte spans off it instead of re-scanning the source with their own
// regexes.
// Lazy: the oxc-parser native binding costs ~12.6 MB RSS; load it only when a parse happens.
const parseSync: typeof import('oxc-parser').parseSync = (...args) =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  loadNative(() => require('oxc-parser') as typeof import('oxc-parser')).parseSync(...args)
import { loadNative } from '../utils/native-require'
import { spliceSource } from '../runtime/module-transform'

// `Bun` through globalThis: pnext ships TypeScript source, so app compilers without
// bun-types typecheck this file and a bare `Bun` identifier would fail them.
const { Bun: bun } = globalThis as unknown as {
  Bun: { hash(input: string | ArrayBufferView): { toString(radix?: number): string } }
}

export interface ScanEdge {
  specifier: string
  /** Bound names: `default`, `*` (namespace object), or the imported names. */
  exports: string[]
  /** Byte offset of the statement — edges are consumed in true source order. */
  index: number
  /** `export * from`: binds every named export of the target, none of them known here. */
  star?: boolean
  /** `export … from` rather than `import`. */
  reexport?: boolean
  /** Public export name -> name imported from the target. */
  exportMap?: Record<string, string>
}

/** One module specifier literal, with the span of its quoted text. */
export interface SpecifierEdge {
  specifier: string
  /** Span of the quoted literal, quotes included. */
  start: number
  end: number
  /** `side-effect` is `import 'x'`: no clause, so no `from` for a textual pass to key on. */
  kind: 'import' | 'side-effect' | 'export' | 'dynamic' | 'require'
}

export interface ImportBinding {
  /** Name in the target module; `default`/`*` for the default/namespace forms. */
  imported: string
  local: string
  /** `import type …` / `{ type X }`: erased, but part of the statement's text. */
  type: boolean
}

/** A static `import` statement, spans included — the unit the folded passes splice. */
export interface ImportStatement {
  specifier: string
  /** Statement span (`import` … `;`). */
  start: number
  end: number
  /** Span of the quoted specifier literal inside the statement. */
  specifierStart: number
  specifierEnd: number
  bindings: ImportBinding[]
}

/**
 * The module-record projection the rewrite passes splice against: specifier literals, import statements and
 * `import.meta` spans, all exact - never a match inside a string or comment. Shares `scanFacts`' memoized
 * parse, so a folded pass on an already-scanned source costs nothing beyond the lookup.
 */
export interface RewriteFacts {
  edges: SpecifierEdge[]
  imports: ImportStatement[]
  importMetas: { start: number; end: number }[]
  /**
   * The parse recovered from errors, so the record may be incomplete — folded
   * passes fall back to their textual form rather than silently under-rewrite.
   */
  unreliable: boolean
}

/**
 * A `name(loader, options?)` call whose loader statically targets one module —
 * the shape `dynamic()` extraction needs. Emitted for every identifier-callee
 * call with such a loader; consumers gate on their own `dynamic` binding set.
 */
export interface DynamicCallFact {
  name: string
  /** Callee identifier start — aligns with the textual call scan's index. */
  start: number
  /** Call end (past the closing paren). */
  end: number
  /** Loader target, cooked value. */
  specifier: string
  /** Span of the quoted specifier literal, quotes included. */
  specifierStart: number
  specifierEnd: number
  /** From the `.then(m => m.X)` arm (or awaited member); `default` otherwise. */
  exportName: string
  /** First arg is a string literal (`dynamic('./x')` form), not a loader fn. */
  literal?: boolean
  /** End of the loader argument — options/appended args follow it. */
  loaderEnd: number
  /** Second-argument span, when present. */
  optionsStart?: number
  optionsEnd?: number
}

export interface ScanFacts {
  /** Static value imports and `export … from` re-exports, in source order. */
  imports: ScanEdge[]
  /** `import('literal')` expressions, in source order. */
  dynamicImports: { specifier: string; index: number }[]
  /** `require('literal')` calls — CJS sources still reach these scanners. */
  requires: { specifier: string; index: number; specifierStart: number }[]
  /** This module's own value export names, `default` included. */
  exportNames: string[]
  /** Specifiers of `export * from` (whose names live in the target). */
  exportStars: string[]
  /** A real `'use client'` directive — prologue position only, never a comment. */
  useClient: boolean
  /** A real module-level `'use server'` directive, on the same terms. */
  useServer: boolean
  /** Loader-shaped calls (see `DynamicCallFact`); only sources that can bind `dynamic` are walked. */
  dynamicCalls: DynamicCallFact[]
}

const stylesheetOrData = /\.(?:css|scss|sass|less|styl|json)$/

const emptyFacts: ScanFacts = {
  imports: [],
  dynamicImports: [],
  requires: [],
  exportNames: [],
  exportStars: [],
  useClient: false,
  useServer: false,
  dynamicCalls: [],
}

const emptyRewriteFacts: RewriteFacts = {
  edges: [],
  imports: [],
  importMetas: [],
  unreliable: false,
}

const memo = new Map<string, { scan: ScanFacts; rewrite: RewriteFacts }>()
let hits = 0
let misses = 0

export function scanFacts(file: string, source: string): ScanFacts {
  // The module walk reaches stylesheets/data as ordinary edges; they hold no
  // module facts and are not parseable as script.
  if (stylesheetOrData.test(file)) return emptyFacts
  return parsed(file, source).scan
}

/** Every specifier a module pulls in — static, dynamic and `require`, in source order. */
export function importSpecifiers(source: string, sourcefile = 'source') {
  const facts = scanFacts(sourcefile, source)
  return [
    ...facts.imports.map(edge => edge.specifier),
    ...facts.dynamicImports.map(entry => entry.specifier),
    ...facts.requires.map(entry => entry.specifier),
  ]
}

export function moduleExportNames(source: string, sourcefile = 'source.tsx') {
  return scanFacts(sourcefile, source).exportNames
}

/** Specifiers of `export * from` — their names live in the target module. */
export function moduleExportStars(source: string, sourcefile = 'source.tsx') {
  return scanFacts(sourcefile, source).exportStars
}

/**
 * AST-derived `dynamic()` loader facts — the single source of truth. A call
 * without a fact is an unanalyzable loader: no detection, nothing to splice.
 */
export function dynamicCallFacts(source: string, file = 'module.tsx'): DynamicCallFact[] {
  if (stylesheetOrData.test(file)) return []
  return parsed(file, source).scan.dynamicCalls
}

/** Module-record spans for the rewrite passes (see `RewriteFacts`). */
export function rewriteFacts(file: string, source: string): RewriteFacts {
  if (stylesheetOrData.test(file)) return emptyRewriteFacts
  return parsed(file, source).rewrite
}

/** Every specifier literal with the syntax that determines when it is resolved. */
export function moduleSpecifierEdges(source: string, file = 'source'): SpecifierEdge[] {
  const facts = rewriteFacts(file, source)
  return facts.unreliable ? textualEdges(source) : facts.edges
}

function parsed(file: string, source: string, lang = langForFile(file)) {
  const key = `${lang}\0${source.length}\0${bun.hash(source).toString()}`
  const cached = memo.get(key)
  if (cached) {
    hits += 1
    return cached
  }
  misses += 1
  const facts = parseFacts(file, source, lang)
  memo.set(key, facts)
  return facts
}

/**
 * Splice every module specifier `replace` answers for, in place. The span is
 * the quoted literal, so formatting and comments around it are untouched, and
 * a specifier appearing in a string or a comment is never seen at all.
 * `replace` returns the REPLACEMENT LITERAL (quotes included) or undefined.
 */
export function rewriteSpecifierLiterals(
  source: string,
  file: string,
  replace: (specifier: string, kind: SpecifierEdge['kind']) => string | undefined,
): string {
  // A partially recovered parse has a partial record; the textual scan the
  // folded passes replaced is the safe answer there.
  const edges = moduleSpecifierEdges(source, file)
  const edits: { start: number; end: number; value: string }[] = []
  for (const edge of edges) {
    const value = replace(edge.specifier, edge.kind)
    if (value !== undefined) edits.push({ start: edge.start, end: edge.end, value })
  }
  return edits.length > 0 ? spliceSource(source, edits) : source
}

const textualSpecifier = /(\bfrom\s*|\b(?:import|require)\s*\(\s*)(['"])([^'"]+)\2/g

function textualEdges(source: string): SpecifierEdge[] {
  const edges: SpecifierEdge[] = []
  textualSpecifier.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = textualSpecifier.exec(source))) {
    const start = match.index + match[1]!.length
    edges.push({
      specifier: match[3]!,
      start,
      end: start + match[3]!.length + 2,
      kind: match[1]!.includes('require')
        ? 'require'
        : match[1]!.includes('import')
          ? 'dynamic'
          : 'import',
    })
  }
  return edges
}

/** Memo effectiveness, for the dev-boot benches. */
export function scanFactsStats() {
  return { hits, misses, sources: memo.size }
}

function parseFacts(file: string, source: string, lang: ParserLang) {
  // Parse errors are recovered, never thrown: a scan of a half-typed file in
  // the dev watcher must still yield whatever the parser did understand.
  const result = parseSync(file, source, { lang })
  const imports: ScanEdge[] = []
  const exportNames: string[] = []
  const exportStars: string[] = []
  const edges: SpecifierEdge[] = []
  const importStatements: ImportStatement[] = []

  for (const statement of result.module.staticImports) {
    const names: string[] = []
    const bindings: ImportBinding[] = []
    let bindsValue = statement.entries.length === 0
    for (const entry of statement.entries) {
      const kind: string = entry.importName.kind
      bindings.push({
        imported:
          kind === 'Default'
            ? 'default'
            : kind === 'NamespaceObject'
              ? '*'
              : (entry.importName.name ?? ''),
        local: entry.localName.value ?? '',
        type: entry.isType,
      })
      if (entry.isType) continue
      bindsValue = true
      if (kind === 'Default') names.push('default')
      else if (kind === 'NamespaceObject') names.push('*')
      else if (entry.importName.name) names.push(entry.importName.name)
    }
    importStatements.push({
      specifier: statement.moduleRequest.value,
      start: statement.start,
      end: statement.end,
      specifierStart: statement.moduleRequest.start,
      specifierEnd: statement.moduleRequest.end,
      bindings,
    })
    edges.push({
      specifier: statement.moduleRequest.value,
      start: statement.moduleRequest.start,
      end: statement.moduleRequest.end,
      kind: statement.entries.length === 0 ? 'side-effect' : 'import',
    })
    // `import type { … }` binds nothing at runtime: not an edge.
    if (!bindsValue) continue
    imports.push({
      specifier: statement.moduleRequest.value,
      exports: names,
      index: statement.start,
    })
  }

  // One `export { a, b } from 'x'` reports the same moduleRequest per entry.
  const seenExportRequests = new Set<number>()
  for (const statement of result.module.staticExports) {
    for (const entry of statement.entries) {
      const request = entry.moduleRequest
      if (!request || seenExportRequests.has(request.start)) continue
      seenExportRequests.add(request.start)
      edges.push({
        specifier: request.value,
        start: request.start,
        end: request.end,
        kind: 'export',
      })
    }
  }

  for (const statement of result.module.staticExports) {
    const edges = new Map<string, ScanEdge>()
    for (const entry of statement.entries) {
      if (entry.isType) continue
      const exportKind: string = entry.exportName.kind
      if (exportKind === 'Default') exportNames.push('default')
      else if (entry.exportName.name) exportNames.push(entry.exportName.name)

      const specifier = entry.moduleRequest?.value
      if (!specifier) continue
      const importKind: string = entry.importName.kind
      const star = importKind === 'AllButDefault'
      if (star) exportStars.push(specifier)
      let edge = edges.get(specifier)
      if (!edge) {
        edge = {
          specifier,
          exports: [],
          index: statement.start,
          reexport: true,
          exportMap: {},
        }
        edges.set(specifier, edge)
        imports.push(edge)
      }
      if (star) edge.star = true
      else if (importKind === 'All') edge.exports.push('*')
      else {
        const imported = importKind === 'Default' ? 'default' : entry.importName.name
        if (!imported) continue
        edge.exports.push(imported)
        const exported = exportKind === 'Default' ? 'default' : entry.exportName.name
        if (exported) edge.exportMap![exported] = imported
      }
    }
  }

  imports.sort((a, b) => a.index - b.index)

  const dynamicImports: { specifier: string; index: number }[] = []
  for (const entry of result.module.dynamicImports) {
    const raw = source.slice(entry.moduleRequest.start, entry.moduleRequest.end)
    const specifier = literalSpecifier(raw)
    if (specifier === undefined) continue
    dynamicImports.push({ specifier, index: entry.start })
    // The literal's own span, without the whitespace `moduleRequest` includes.
    const lead = raw.length - raw.trimStart().length
    edges.push({
      specifier,
      start: entry.moduleRequest.start + lead,
      end: entry.moduleRequest.start + lead + specifier.length + 2,
      kind: 'dynamic',
    })
  }

  const requires = requireCalls(source, result.comments)
  for (const call of requires) {
    edges.push({
      specifier: call.specifier,
      start: call.specifierStart,
      end: call.specifierStart + call.specifier.length + 2,
      kind: 'require',
    })
  }
  edges.sort((a, b) => a.start - b.start)

  return {
    scan: {
      imports,
      dynamicImports,
      requires,
      exportNames,
      exportStars,
      useClient: moduleDirective(source, result, 'use client'),
      useServer: moduleDirective(source, result, 'use server'),
      // `result.program` deserializes the whole AST: walk it only for sources
      // that can bind `dynamic()` at all (same cheap gate as resolve/dynamic.ts).
      dynamicCalls:
        source.includes('@wular/pnext') || source.includes('next/dynamic')
          ? collectDynamicCalls(result.program as unknown as AstNode)
          : [],
    },
    rewrite: {
      edges,
      imports: importStatements,
      importMetas: result.module.importMetas.map(meta => ({ start: meta.start, end: meta.end })),
      unreliable: result.errors.length > 0,
    },
  }
}

/**
 * `result.program.body` deserializes the whole AST across the NAPI boundary, and the prologue sniff
 * was its only consumer. The raw-source scanner answers it without the AST; the AST is still
 * consulted for the prologue shapes the scanner will not commit to.
 */
function moduleDirective(
  source: string,
  result: { program: { body: readonly Directive[] } },
  directive: string,
) {
  const sniffed = sniffDirective(source, directive)
  if (sniffed !== undefined) return sniffed
  // Uncertain, but a directive is its raw text: no occurrence, no directive.
  if (!source.includes(directive)) return false
  return hasDirective(result.program.body, directive)
}

interface Directive {
  type: string
  directive?: string | null
}

// A string literal is only a directive if what follows it ends the statement; a
// continuation token means it was an expression (`'use client' + x`).
const continuesExpression = /[+\-*/%.,?:=<>!&|^~([`)\]}]/
const wordContinuation = /^(?:in|instanceof)\b/
const lineTerminator = /[\n\r\u2028\u2029]/

/**
 * Directive-prologue sniff over raw source. Returns undefined - not a guess - for any shape it cannot decide
 * exactly (escaped literal, unterminated string or comment, ambiguous ASI), so the caller falls back to the
 * AST.
 */
function sniffDirective(source: string, directive: string): boolean | undefined {
  let index = 0
  if (source.startsWith('#!')) {
    const nl = source.search(lineTerminator)
    if (nl < 0) return false
    index = nl + 1
  }
  for (;;) {
    index = skipTrivia(source, index)
    if (index < 0) return undefined
    const quote = source[index]
    if (quote !== '"' && quote !== "'") return false // prologue is over

    let end = index + 1
    while (end < source.length) {
      const char = source[end]!
      // An escape makes the raw text differ from the directive, but decoding it
      // exactly is the AST's job, not this scanner's.
      if (char === '\\' || lineTerminator.test(char)) return undefined
      if (char === quote) break
      end += 1
    }
    if (end >= source.length) return undefined // unterminated literal
    const raw = source.slice(index + 1, end)

    const after = skipTrivia(source, end + 1)
    if (after < 0) return undefined
    const next = source[after]
    let terminated = after >= source.length || next === ';'
    if (!terminated && lineTerminator.test(source.slice(end + 1, after))) {
      // ASI closes the statement unless the next token continues the expression.
      terminated =
        !continuesExpression.test(next!) && !wordContinuation.test(source.slice(after, after + 11))
    }
    if (!terminated) return undefined
    if (raw === directive) return true
    index = next === ';' ? after + 1 : after
    if (index >= source.length) return false
  }
}

/** Past whitespace and comments; -1 for an unterminated block comment. */
function skipTrivia(source: string, index: number) {
  for (;;) {
    while (index < source.length && /\s/.test(source[index]!)) index += 1
    if (source[index] !== '/') return index
    if (source[index + 1] === '/') {
      let end = index + 2
      while (end < source.length && !lineTerminator.test(source[end]!)) end += 1
      index = end
      continue
    }
    if (source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      if (end < 0) return -1
      index = end + 2
      continue
    }
    return index
  }
}

function hasDirective(
  body: readonly { type: string; directive?: string | null }[],
  directive: string,
) {
  // The prologue ends at the first non-directive statement; comments and other
  // directives before it do not.
  for (const statement of body) {
    if (statement.type !== 'ExpressionStatement' || typeof statement.directive !== 'string')
      return false
    if (statement.directive === directive) return true
  }
  return false
}

const requirePattern = /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g

/**
 * CJS `require` is an ordinary call, not a module record entry, so it stays on a regex - but a regex reads
 * comments as code, and a prose `require('x')` in a doc comment became a real graph edge, an unresolvable
 * one aborting the whole module compile. The parse's comment spans are already in hand, so drop every match
 * that lands inside one.
 */
function requireCalls(source: string, comments: readonly { start: number; end: number }[]) {
  const calls: { specifier: string; index: number; specifierStart: number }[] = []
  if (!source.includes('require')) return calls
  requirePattern.lastIndex = 0
  let match: RegExpExecArray | null
  // Both comments and matches ascend, so one shared cursor walks them together.
  let cursor = 0
  while ((match = requirePattern.exec(source))) {
    const index = match.index
    while (cursor < comments.length && comments[cursor]!.end <= index) cursor += 1
    if (cursor < comments.length && index >= comments[cursor]!.start) continue
    calls.push({
      specifier: match[2]!,
      index,
      specifierStart: index + match[0].indexOf(match[1]!),
    })
  }
  return calls
}

function literalSpecifier(raw: string) {
  return /^\s*(['"])([^'"]*)\1\s*$/.exec(raw)?.[2] || undefined
}

interface AstNode {
  type: string
  start: number
  end: number
  [key: string]: unknown
}

function isNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && typeof (value as AstNode).type === 'string'
}

function child(node: AstNode | undefined, key: string): AstNode | undefined {
  const value = node?.[key]
  return isNode(value) ? value : undefined
}

function collectDynamicCalls(program: AstNode): DynamicCallFact[] {
  const calls: DynamicCallFact[] = []
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (!isNode(value)) return
    if (value.type === 'CallExpression') {
      const fact = dynamicCallFact(value)
      if (fact) calls.push(fact)
    }
    for (const key in value) {
      if (key === 'type' || key === 'loc' || key === 'range') continue
      const entry = value[key]
      if (entry && typeof entry === 'object') visit(entry)
    }
  }
  visit(program.body)
  return calls.sort((a, b) => a.start - b.start)
}

function dynamicCallFact(call: AstNode): DynamicCallFact | undefined {
  const callee = child(call, 'callee')
  if (callee?.type !== 'Identifier') return undefined
  const args = call.arguments
  if (!Array.isArray(args) || !isNode(args[0])) return undefined
  const loader = args[0]

  let target: { specifier: AstNode; exportName: string } | undefined
  let literal: boolean | undefined
  if (stringValue(loader) !== undefined) {
    target = { specifier: loader, exportName: 'default' }
    literal = true
  } else if (loader.type === 'ArrowFunctionExpression' || loader.type === 'FunctionExpression') {
    target = loaderImportTarget(loader) ?? firstImportTarget(loader)
  }
  if (!target) return undefined

  const specifier = stringValue(target.specifier)
  if (specifier === undefined) return undefined
  const options = isNode(args[1]) ? args[1] : undefined
  return {
    name: callee.name as string,
    start: callee.start,
    end: call.end,
    specifier,
    specifierStart: target.specifier.start,
    specifierEnd: target.specifier.end,
    exportName: target.exportName,
    ...(literal ? { literal } : {}),
    loaderEnd: loader.end,
    ...(options ? { optionsStart: options.start, optionsEnd: options.end } : {}),
  }
}

function stringValue(node: AstNode | undefined): string | undefined {
  if (!node) return undefined
  if (node.type !== 'Literal' && node.type !== 'StringLiteral') return undefined
  return typeof node.value === 'string' ? node.value : undefined
}

/** Past parens, `await`, `as`/`!` and optional-chain wrappers to the loader's real expression. */
function unwrapExpression(node: AstNode | undefined): AstNode | undefined {
  let current = node
  for (;;) {
    if (!current) return undefined
    if (current.type === 'ParenthesizedExpression' || current.type === 'ChainExpression') {
      current = child(current, 'expression')
    } else if (current.type === 'AwaitExpression') {
      current = child(current, 'argument')
    } else if (
      current.type === 'TSAsExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSSatisfiesExpression'
    ) {
      current = child(current, 'expression')
    } else {
      return current
    }
  }
}

/** The expression a loader function resolves to: its expression body or first `return`. */
function loaderResult(fn: AstNode): AstNode | undefined {
  const body = child(fn, 'body')
  if (!body) return undefined
  if (body.type !== 'BlockStatement' && body.type !== 'FunctionBody') return unwrapExpression(body)
  const statements = body.body
  if (!Array.isArray(statements)) return undefined
  for (const statement of statements) {
    if (isNode(statement) && statement.type === 'ReturnStatement') {
      return unwrapExpression(child(statement, 'argument'))
    }
  }
  return undefined
}

function importSource(node: AstNode | undefined): AstNode | undefined {
  if (node?.type !== 'ImportExpression') return undefined
  const source = child(node, 'source')
  return source && stringValue(source) !== undefined ? source : undefined
}

/**
 * Statically resolve a loader body: `import('x')`, `import('x').then(m => m.X)`
 * (any param/arrow formatting), or `(await import('x')).X`.
 */
function loaderImportTarget(fn: AstNode): { specifier: AstNode; exportName: string } | undefined {
  const result = loaderResult(fn)
  if (!result) return undefined

  const direct = importSource(result)
  if (direct) return { specifier: direct, exportName: 'default' }

  if (result.type === 'MemberExpression' && result.computed !== true) {
    const source = importSource(unwrapExpression(child(result, 'object')))
    const property = child(result, 'property')
    if (source && property?.type === 'Identifier') {
      return { specifier: source, exportName: property.name as string }
    }
  }

  if (result.type !== 'CallExpression') return undefined
  const callee = child(result, 'callee')
  if (callee?.type !== 'MemberExpression' || callee.computed === true) return undefined
  if (child(callee, 'property')?.name !== 'then') return undefined
  const source = importSource(unwrapExpression(child(callee, 'object')))
  if (!source) return undefined
  return { specifier: source, exportName: thenArmExport(result) ?? 'default' }
}

/** `X` of a `.then(m => m.X)` arm; undefined for any other arm shape. */
function thenArmExport(thenCall: AstNode): string | undefined {
  const args = thenCall.arguments
  if (!Array.isArray(args) || !isNode(args[0])) return undefined
  const arm = args[0]
  if (arm.type !== 'ArrowFunctionExpression' && arm.type !== 'FunctionExpression') return undefined
  const params = arm.params
  const param = Array.isArray(params) && isNode(params[0]) ? params[0] : undefined
  if (param?.type !== 'Identifier') return undefined
  const result = loaderResult(arm)
  if (result?.type !== 'MemberExpression' || result.computed === true) return undefined
  const object = unwrapExpression(child(result, 'object'))
  if (object?.type !== 'Identifier' || object.name !== param.name) return undefined
  const property = child(result, 'property')
  return property?.type === 'Identifier' ? (property.name as string) : undefined
}

/**
 * Fallback for loader shapes the structured pass cannot follow: the first
 * literal `import()` anywhere in the loader, default export — mirrors what the
 * textual extraction always did for these.
 */
function firstImportTarget(fn: AstNode): { specifier: AstNode; exportName: string } | undefined {
  let found: AstNode | undefined
  const visit = (value: unknown) => {
    if (found) return
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (!isNode(value)) return
    const source = importSource(value)
    if (source) {
      found = source
      return
    }
    for (const key in value) {
      const entry = value[key]
      if (entry && typeof entry === 'object') visit(entry)
    }
  }
  visit(fn.body)
  return found ? { specifier: found, exportName: 'default' } : undefined
}

type ParserLang = 'ts' | 'tsx'

// `.ts` forbids JSX (`<T>value` is a type assertion there); everything else —
// including extensionless scan inputs — parses as the tsx superset.
function langForFile(file: string): ParserLang {
  return /\.[mc]?ts$/.test(file) ? 'ts' : 'tsx'
}
