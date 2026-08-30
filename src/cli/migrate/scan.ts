// Report-only source scan. Import specifiers come from Bun's transpiler, never
// from regexes over application code; text checks here only classify what to
// report and never drive a rewrite.

import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { MigrationResult } from './report'

const SKIP_DIRS = new Set(['node_modules', '.next', '.pnext', '.git', 'dist', 'build'])
const LOADERS: Record<string, 'ts' | 'tsx' | 'js' | 'jsx'> = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.jsx': 'jsx',
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
}
const STREAMING_APIS = ['renderToReadableStream', 'renderToPipeableStream']
// `cookies().get(...)` / `headers()['x']` with no `await` — Next 14 sync request-API reads.
const CALL_THEN_ACCESS = /(await\s+)?\b([\w$]+)\s*\(\s*\)\s*(?:\.\s*([\w$]+)|\[)/g
const NEXT_HEADERS_IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"]next\/headers['"]/g
const REQUEST_APIS = new Set(['cookies', 'headers', 'draftMode'])
const PROMISE_METHODS = new Set(['then', 'catch', 'finally'])
const SPECIAL_PAGES = ['_app', '_document', '_error']
// App-router segment files, the only place `params`/`searchParams` arrive as props.
const SEGMENT_FILES = new Set(['page', 'layout', 'route', 'template', 'default'])
// Every head whose match ENDS at the parameter list's `(` — default exports and generateMetadata.
const SEGMENT_HEADS =
  /export\s+default\s+(?:async\s+)?function\s*[\w$]*\s*\(|export\s+default\s+(?:async\s+)?\(|export\s+(?:async\s+)?function\s+generateMetadata\s*\(|export\s+const\s+generateMetadata\s*(?::[^=]*)?=\s*(?:async\s*)?\(/g
// Route-handler methods take `{ params }` as their SECOND parameter (the context object).
const ROUTE_HANDLER_HEADS =
  /export\s+(?:async\s+)?function\s+(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\s*\(|export\s+const\s+(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\s*(?::[^=]*)?=\s*(?:async\s*)?\(/g
const SYNC_PROPS = ['params', 'searchParams'] as const

export async function scanSources(root: string, result: MigrationResult) {
  const { SHIMMED_NEXT_DIST_PATHS } = await import('../../compat/aliases')
  const shimmed = new Set<string>(SHIMMED_NEXT_DIST_PATHS)
  const deepImports: string[] = []
  const streaming: string[] = []
  const headImports: string[] = []

  for await (const file of walk(root)) {
    const loader = LOADERS[path.extname(file)]
    if (!loader) continue
    const text = await readFile(file, 'utf8')
    let specifiers: string[]
    try {
      specifiers = new Bun.Transpiler({ loader }).scanImports(text).map(item => item.path)
    } catch {
      continue // unparseable source is the app's problem, not migrate's
    }
    const relative = path.relative(root, file)
    for (const specifier of specifiers) {
      if (specifier.startsWith('next/dist/') && !shimmed.has(specifier.replace(/\.js$/, ''))) {
        deepImports.push(`${relative} → ${specifier}`)
      }
      if (
        /^react-dom\/server(\.|\/|$)/.test(specifier) &&
        STREAMING_APIS.some(api => text.includes(api))
      ) {
        streaming.push(relative)
      }
      if (specifier === 'next/head') headImports.push(relative)
      // next/font/local reads the app's own files; only the Google loader needs the metadata
      // package, so only it earns the dependency.
      if (specifier === 'next/font/google') result.googleFontImports.push(relative)
    }
    if (readsRequestApiSynchronously(text) || readsSyncSegmentProps(file, text)) {
      result.syncRequestApis.push(relative)
    }
  }

  if (deepImports.length > 0) {
    result.reports.push({
      title: 'Unsupported next/dist/* deep imports',
      detail:
        'Only five next/dist paths are shimmed — replace these with public APIs. See https://pnext.dev/docs/compat ("Smaller surfaces").',
      files: deepImports,
    })
  }
  if (streaming.length > 0) {
    result.reports.push({
      title: 'react-dom/server streaming APIs',
      detail:
        'preact/compat does not provide renderToReadableStream/renderToPipeableStream — use pnext rendering instead. See https://pnext.dev/docs/compat.',
      files: [...new Set(streaming)],
    })
  }

  if (headImports.length > 0) {
    result.reports.push({
      title: 'next/head is ignored in the app router',
      detail:
        'pnext ignores next/head in app-directory components (matching Next). Move these tags to metadata exports or the root layout <head>. See https://pnext.dev/docs/compat.',
      files: [...new Set(headImports)],
    })
  }

  scanSpecialPages(root, result)
  await scanNextConfig(root, result)
}

/**
 * A next/headers request API called and immediately read, with no `await` — the Next 14 shape that
 * throws under Next 16 semantics. Local aliases (`cookies as getCookies`) count; `.then()` chains do not.
 */
function readsRequestApiSynchronously(text: string): boolean {
  const locals = new Set<string>()
  for (const match of text.matchAll(NEXT_HEADERS_IMPORT)) {
    for (const binding of match[1]!.split(',')) {
      const [imported, local] = binding.trim().split(/\s+as\s+/)
      if (imported && REQUEST_APIS.has(imported)) locals.add(local ?? imported)
    }
  }
  if (locals.size === 0) return false
  for (const match of text.matchAll(CALL_THEN_ACCESS)) {
    if (match[1] || !locals.has(match[2]!)) continue
    if (match[3] && PROMISE_METHODS.has(match[3])) continue
    return true
  }
  return false
}

/**
 * A segment file whose default export (or generateMetadata) takes `params`/`searchParams` the Next 14
 * way — annotated as a plain object rather than a Promise, or destructured and read without `await`.
 * Precision over recall: an unresolvable annotation, an awaited read, or a `params` key anywhere other
 * than the parameter list (an axios `{ params: { page } }` option bag) never counts.
 */
export function readsSyncSegmentProps(file: string, text: string): boolean {
  const extension = path.extname(file)
  if (!SEGMENT_FILES.has(path.basename(file, extension))) return false
  return readsHeadProps(text, SEGMENT_HEADS, 0) || readsHeadProps(text, ROUTE_HANDLER_HEADS, 1)
}

function readsHeadProps(text: string, heads: RegExp, index: number): boolean {
  for (const head of text.matchAll(heads)) {
    const list = balanced(text, head.index + head[0].length - 1, '(', ')')
    const parameter = (splitTopLevel(list)[index] ?? '').trim()
    if (parameter && readsPropsSynchronously(parameter, text)) return true
  }
  return false
}

function readsPropsSynchronously(parameter: string, text: string): boolean {
  const colon = topLevelIndex(parameter, ':')
  const binding = (colon < 0 ? parameter : parameter.slice(0, colon)).trim()
  const annotation = colon < 0 ? '' : parameter.slice(colon + 1).trim()
  const destructured = binding.startsWith('{') ? destructuredKeys(binding) : null
  for (const prop of SYNC_PROPS) {
    if (destructured && !destructured.has(prop)) continue
    if (annotation) {
      const declared = propertyType(annotation, text, prop)
      if (declared && !/^Promise\s*</.test(declared)) return true
      continue
    }
    // Untyped JS: a destructured binding read without `await`, or `props.params` read without one.
    if (destructured) {
      if (!new RegExp(`await\\s+${prop}\\b`).test(text)) return true
    } else if (/^[\w$]+$/.test(binding)) {
      const reads = text.matchAll(new RegExp(`(await\\s+)?\\b${binding}\\.${prop}\\b`, 'g'))
      if ([...reads].some(read => !read[1])) return true
    }
  }
  return false
}

/** The declared type of `prop` inside an inline object annotation or a locally declared type/interface. */
function propertyType(annotation: string, text: string, prop: string): string | undefined {
  let body: string | undefined
  if (annotation.startsWith('{')) {
    body = balanced(annotation, 0, '{', '}')
  } else {
    const name = /^[\w$]+/.exec(annotation)?.[0]
    body = name ? localTypeBody(name, text) : undefined
  }
  if (!body) return undefined
  return new RegExp(`(?:^|[{;,\\n])\\s*${prop}\\s*\\??\\s*:\\s*([^;,\\n]+)`).exec(body)?.[1]?.trim()
}

function localTypeBody(name: string, text: string): string | undefined {
  const declaration = new RegExp(`\\b(?:type|interface)\\s+${name}\\b`).exec(text)
  if (!declaration) return undefined
  const open = text.indexOf('{', declaration.index)
  // An alias to something else (`type Props = PageProps<'/x'>`) has no object body of its own.
  if (open < 0 || /[;)]/.test(text.slice(declaration.index, open))) return undefined
  return balanced(text, open, '{', '}')
}

/** The keys of a destructuring pattern, renames included (`{ params: p }` → `params`). */
function destructuredKeys(binding: string): Set<string> {
  const keys = new Set<string>()
  for (const part of splitTopLevel(balanced(binding, 0, '{', '}'))) {
    const key = /^\s*(?:\.\.\.)?([\w$]+)/.exec(part)?.[1]
    if (key) keys.add(key)
  }
  return keys
}

/** Text between `open` at `from` and its matching close, exclusive. */
function balanced(text: string, from: number, open: string, close: string): string {
  let depth = 0
  for (let i = from; i < text.length; i++) {
    if (text[i] === open) depth++
    else if (text[i] === close && --depth === 0) return text.slice(from + 1, i)
  }
  return ''
}

function splitTopLevel(list: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < list.length; i++) {
    const char = list[i]!
    if (char === '=' && list[i + 1] === '>') i++
    else if ('({[<'.includes(char)) depth++
    else if (')}]>'.includes(char)) depth--
    else if (char === ',' && depth === 0) {
      parts.push(list.slice(start, i))
      start = i + 1
    }
  }
  parts.push(list.slice(start))
  return parts
}

/** Index of `char` outside any bracket pair, or -1. */
function topLevelIndex(text: string, char: string): number {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const current = text[i]!
    if ('({[<'.includes(current)) depth++
    else if (')}]>'.includes(current)) depth--
    else if (current === char && depth === 0) return i
  }
  return -1
}

function scanSpecialPages(root: string, result: MigrationResult) {
  const found: string[] = []
  for (const base of ['pages', path.join('src', 'pages')]) {
    for (const name of SPECIAL_PAGES) {
      for (const extension of ['.tsx', '.ts', '.jsx', '.js']) {
        const relative = path.join(base, `${name}${extension}`)
        if (existsSync(path.join(root, relative))) found.push(relative)
      }
    }
  }
  if (found.length === 0) return
  result.reports.push({
    title: 'pages/_app, _document and _error are ignored',
    detail:
      'Move this setup into the app-router root layout — pnext never loads these files. See https://pnext.dev/docs/compat.',
    files: found,
  })
}

async function scanNextConfig(root: string, result: MigrationResult) {
  for (const name of ['next.config.ts', 'next.config.js', 'next.config.mjs', 'next.config.cjs']) {
    const file = path.join(root, name)
    if (!existsSync(file)) continue
    const text = await readFile(file, 'utf8')
    if (!text.includes('webpack:') && !text.includes('webpack(')) return
    const svgr = text.includes('@svgr/webpack')
    result.reports.push({
      title: `${name} defines a webpack function`,
      detail: svgr
        ? 'The webpack function is never executed; SVGR is auto-detected from @svgr/webpack, so SVG imports keep working. See https://pnext.dev/docs/compat.'
        : 'The webpack function is never executed — port any custom loaders/plugins to pnext config. See https://pnext.dev/docs/compat.',
    })
    return
  }
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      yield* walk(path.join(dir, entry.name))
    } else if (entry.isFile()) {
      yield path.join(dir, entry.name)
    }
  }
}
