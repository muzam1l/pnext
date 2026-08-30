/**
 * Source-text scanning to find Next-style server actions ('use server').
 *
 * This is deliberately regex/heuristic based, not a full parser. It targets the
 * common Next fixture shapes and documents its limitations rather than trying to
 * be a compiler. The reliable, fully-static path is a module-level 'use server'
 * file with named exports; inline actions inside components are best-effort.
 */

export { actionId, workspaceRelative } from './ids'

const DIRECTIVE = /^(['"])use server\1\s*;?$/
const CACHE_DIRECTIVE = /^(['"])use cache\1\s*;?$/

/**
 * True when the file's FIRST statement is a 'use server' directive, marking the
 * whole module as a server-action module (every export is an action).
 *
 * Leading comments (line and block), a shebang, and blank lines are skipped, as
 * a real JS engine would when looking for a directive prologue.
 */
export function moduleLevelUseServer(source: string): boolean {
  const first = firstStatementText(stripLeading(source))
  return first !== undefined && DIRECTIVE.test(first.trim())
}

/**
 * True when the file's FIRST statement is a plain 'use cache' directive. Such a module's exports are
 * server references exactly like a 'use server' module: a client component that imports one must get
 * RPC stubs, since the cached functions always execute (and cache) on the server. Named handler
 * variants are function-level only in practice and excluded.
 */
export function moduleLevelUseCache(source: string): boolean {
  const first = firstStatementText(stripLeading(source))
  return first !== undefined && CACHE_DIRECTIVE.test(first.trim())
}

export interface InlineAction {
  /** Local (and, when exported, exported) name of the action function. */
  name: string
  /** True when the function is a named export (`export ...` / re-exported). */
  exported: boolean
  /** Character offset of the start of the matched declaration in `source`. */
  start: number
  /** Character offset just past the `"use server"` directive that marked it. */
  directiveEnd: number
}

/**
 * Find inline 'use server' actions: functions whose body opens with a
 * `"use server"` directive. Handles the two common Next shapes:
 *
 *   async function foo() { "use server"; ... }
 *   const foo = async (...) => { "use server"; ... }
 *
 * Both with and without a leading `export`. Returns local names + spans.
 *
 * Limitations (documented, not fixed):
 * - No full parser: a `"use server"` string that is not the first statement of a
 *   function body may still match if it sits right after `{`; conversely unusual
 *   formatting (directive on a line with trailing code) can be missed.
 * - Default exports and object-method shorthand are not detected here.
 * - Actions defined inline in a component and passed to <form action={fn}> are
 *   found as local declarations, but whether they are truly exported/reachable
 *   as an RPC target can't be resolved statically. Prefer named exports of a
 *   module-level 'use server' file for the reliable wire path.
 */
export function inlineUseServerFunctions(source: string): InlineAction[] {
  const found: InlineAction[] = []
  const seen = new Set<string>()

  // Shape 1: [export] [async] function NAME(...) { "use server"
  const fnDecl =
    /(\bexport\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*(['"])use server\3\s*;?/g
  collect(fnDecl, source, found, seen, { nameGroup: 2, exportGroup: 1, dirGroup: 3 })

  // Shape 2: [export] const NAME = [async] (...) => { "use server"
  //          also covers `= async function (...) { "use server"`
  const arrowOrExpr =
    /(\bexport\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*|function\s*\*?\s*\([^)]*\))\s*(?:=>\s*)?\{\s*(['"])use server\3\s*;?/g
  collect(arrowOrExpr, source, found, seen, { nameGroup: 2, exportGroup: 1, dirGroup: 3 })

  return found.sort((a, b) => a.start - b.start)
}

interface Groups {
  nameGroup: number
  exportGroup: number
  dirGroup: number
}

function collect(
  pattern: RegExp,
  source: string,
  out: InlineAction[],
  seen: Set<string>,
  groups: Groups,
) {
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source))) {
    const name = match[groups.nameGroup]
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push({
      name,
      exported: Boolean(match[groups.exportGroup]),
      start: match.index,
      directiveEnd: match.index + match[0].length,
    })
  }
}

/**
 * Names to treat as action RPC targets for a module-level 'use server' file:
 * every named export plus a default export flagged as `'default'`. Regex-based
 * export scanning; covers `export function`, `export const`, `export { a, b }`,
 * `export { a as b }`, `export default`.
 */
export function moduleActionExports(source: string): string[] {
  const names = new Set<string>()

  // export [async] function NAME / export const|let|var NAME
  const declRe =
    /\bexport\s+(?:async\s+)?(?:function\s*\*?\s+|const\s+|let\s+|var\s+|class\s+)([A-Za-z_$][\w$]*)/g
  for (let m; (m = declRe.exec(source));) if (m[1]) names.add(m[1])

  // export default ...
  if (/\bexport\s+default\b/.test(source)) names.add('default')

  // export { a, b as c }  (ignore `export type { ... }`)
  const listRe = /\bexport\s+(?!type\b)\{([^}]*)\}/g
  for (let m; (m = listRe.exec(source));) {
    for (const part of (m[1] ?? '').split(',')) {
      const trimmed = part.trim()
      if (!trimmed || trimmed.startsWith('type ')) continue
      const exportedName = /\bas\s+([A-Za-z_$][\w$]*)\s*$/.exec(trimmed)?.[1]
      const name = exportedName ?? trimmed
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name)
    }
  }

  return [...names]
}

/** Strip a leading shebang and BOM so directive detection starts at real code. */
function stripLeading(source: string): string {
  let s = source.replace(/^\uFEFF/, '')
  if (s.startsWith('#!')) {
    const nl = s.indexOf('\n')
    s = nl === -1 ? '' : s.slice(nl + 1)
  }
  return s
}

/**
 * Return the text of the first statement, skipping leading comments and blank
 * lines. Used only to check the directive prologue; returns the first
 * `;`-or-newline-terminated token run.
 */
function firstStatementText(source: string): string | undefined {
  let i = 0
  const n = source.length
  while (i < n) {
    const ch = source[i]
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++
      continue
    }
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i)
      if (nl === -1) return undefined
      i = nl + 1
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      if (end === -1) return undefined
      i = end + 2
      continue
    }
    break
  }
  if (i >= n) return undefined
  // Read until end of line or a semicolon (directive is a single statement).
  let j = i
  while (j < n && source[j] !== '\n' && source[j] !== ';') j++
  const end = source[j] === ';' ? j + 1 : j
  return source.slice(i, end)
}

/**
 * Anonymous inline actions (`onClick={async () => { 'use server'; ... }}`)
 * carry no compile-tagged id; the directive in the live function source is the
 * only signal separating them from plain client handlers when serialization is
 * restricted to identified actions.
 */
export function opensWithUseServerDirective(fn: unknown): boolean {
  if (typeof fn !== 'function') return false
  let source: string
  try {
    source = String(fn)
  } catch {
    return false
  }
  const body = source.indexOf('{', source.indexOf(')') + 1)
  if (body === -1) return false
  return /^\s*(['"])use server\1/.test(source.slice(body + 1))
}
