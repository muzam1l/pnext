// webpack's `require.context()` (COMPAT).
//
// `require.context(dir, recursive, regExp)` is a webpack-only build-time API: it eagerly includes every
// file under `dir` matching `regExp` and returns a callable context module - `ctx(key)` yields a module,
// `ctx.keys()` lists the request keys, `ctx.resolve(key)` the underlying path, `ctx.id` the context
// module id. pnext has no webpack graph, so the call is expanded at transform time: the directory is
// walked on disk, the matching files become static top-level imports, and the call expression is
// replaced by a synthesized context object built from them.
//
// Wired as a server source transform (covering both the Bun runtime's per-file SSR loading and the
// esbuild server passes) and as a client source transform.

import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/** Extensions whose files also get an extension-less request key (webpack resolves both). */
const RESOLVABLE_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json']

// `require.context(` — also matches the TS-cast form the Next fixtures use,
// `(require as any).context(`, since the transform runs on pre-compiled source.
const CONTEXT_CALL = /(?:\(\s*require\s+as\s+[^)]*\)|\brequire)\s*\.\s*context\s*\(/g

/** Cheap gate: does this source contain any candidate `require.context(` call? */
export function sourceHasRequireContext(source: string): boolean {
  return source.includes('.context(') && source.includes('require')
}

interface ContextEntry {
  /** Request key, e.g. `./parent/file1.js`. */
  key: string
  /** Absolute path of the file the key resolves to. */
  file: string
}

/**
 * Split a call's argument list (the text between the outer parens) on top-level
 * commas, ignoring commas nested in parens/brackets/braces, strings, regex
 * literals and comments. Returns `undefined` when the parens never balance.
 */
function splitCallArguments(
  source: string,
  openIndex: number,
): { args: string[]; end: number } | undefined {
  const args: string[] = []
  let depth = 0
  let start = openIndex + 1
  let index = openIndex
  let quote: string | undefined
  let inRegex = false
  while (index < source.length) {
    const char = source[index]!
    const prev = source[index - 1]
    if (quote) {
      if (char === quote && prev !== '\\') quote = undefined
    } else if (inRegex) {
      if (char === '/' && prev !== '\\') inRegex = false
    } else if (char === '"' || char === "'" || char === '`') {
      quote = char
    } else if (char === '/' && source[index + 1] === '/') {
      index = source.indexOf('\n', index)
      if (index === -1) return undefined
    } else if (char === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2)
      if (close === -1) return undefined
      index = close + 1
    } else if (char === '/' && depth > 0) {
      // Inside the argument list a `/` can only start a regex literal (the
      // division case would need a preceding operand, which no argument
      // position of `require.context` produces).
      inRegex = true
    } else if (char === '(' || char === '[' || char === '{') {
      depth++
    } else if (char === ')' || char === ']' || char === '}') {
      depth--
      if (depth === 0) {
        args.push(source.slice(start, index))
        const trimmed = args.map(arg => arg.trim())
        return { args: trimmed.length === 1 && trimmed[0] === '' ? [] : trimmed, end: index }
      }
    } else if (char === ',' && depth === 1) {
      args.push(source.slice(start, index))
      start = index + 1
    }
    index++
  }
  return undefined
}

/** Parse a `/pattern/flags` literal; returns `undefined` for anything else. */
function parseRegExpLiteral(text: string): RegExp | undefined {
  const match = /^\/((?:\\.|\[(?:\\.|[^\]])*\]|[^/])+)\/([a-z]*)$/.exec(text)
  if (!match) return undefined
  try {
    return new RegExp(match[1]!, match[2]!.replace(/[gy]/g, ''))
  } catch {
    return undefined
  }
}

/** Parse a plain string literal argument; returns `undefined` for anything else. */
function parseStringLiteral(text: string): string | undefined {
  const match = /^(['"`])((?:\\.|[^\\])*)\1$/.exec(text)
  if (!match) return undefined
  try {
    return JSON.parse(`"${match[2]!.replace(/"/g, '\\"').replace(/\\'/g, "'")}"`) as string
  } catch {
    return match[2]
  }
}

function walkFiles(dir: string, recursive: boolean, prefix = ''): string[] {
  let names: string[]
  try {
    names = readdirSync(dir).sort()
  } catch {
    return []
  }
  const files: string[] = []
  for (const name of names) {
    if (name.startsWith('.') || name === 'node_modules') continue
    const full = path.join(dir, name)
    let isDirectory = false
    try {
      isDirectory = statSync(full).isDirectory()
    } catch {
      continue
    }
    if (isDirectory) {
      if (recursive) files.push(...walkFiles(full, recursive, `${prefix}${name}/`))
    } else {
      files.push(`${prefix}${name}`)
    }
  }
  return files
}

/**
 * The request keys a context over `dir` exposes, webpack-style: `'./'`-prefixed
 * POSIX paths relative to `dir`, filtered by `regExp` (tested against the key),
 * sorted lexicographically. With no `regExp` webpack's default (`/^\.\/.*$/`)
 * accepts everything AND the extension-less form of each resolvable file also
 * becomes a key, since `require('./parent/file1')` resolves there too.
 */
export function requireContextEntries(
  dir: string,
  recursive: boolean,
  regExp?: RegExp,
): ContextEntry[] {
  const entries: ContextEntry[] = []
  const seen = new Set<string>()
  for (const relative of walkFiles(dir, recursive)) {
    const file = path.join(dir, ...relative.split('/'))
    const keys = [`./${relative}`]
    if (!regExp && RESOLVABLE_EXTENSIONS.includes(path.extname(relative))) {
      keys.push(`./${relative.slice(0, -path.extname(relative).length)}`)
    }
    for (const key of keys) {
      if (regExp && !regExp.test(key)) continue
      if (seen.has(key)) continue
      seen.add(key)
      entries.push({ key, file })
    }
  }
  return entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

// Runtime helper injected alongside the expanded contexts. `ctx(key)` mirrors
// webpack's "returns module.exports": for a CommonJS target esbuild/Bun expose
// the exports object as the namespace's `default`, so unwrap that case; a real
// ESM module keeps its namespace.
const CONTEXT_RUNTIME = `function __pnext_require_context(entries, id) {
  const map = new Map(entries.map(entry => [entry[0], entry]));
  const missing = key => {
    const error = new Error("Cannot find module '" + key + "'");
    error.code = 'MODULE_NOT_FOUND';
    return error;
  };
  const context = key => {
    const entry = map.get(key);
    if (!entry) throw missing(key);
    const mod = entry[2];
    if (mod && typeof mod === 'object' && 'default' in mod) {
      const extra = Object.keys(mod).filter(name => name !== 'default' && name !== '__esModule');
      if (extra.length === 0 && mod.__esModule !== true) return mod.default;
    }
    return mod;
  };
  context.keys = () => entries.map(entry => entry[0]);
  context.resolve = key => {
    const entry = map.get(key);
    if (!entry) throw missing(key);
    return entry[1];
  };
  context.id = id;
  return context;
}`

/**
 * Resolve the context directory argument against the importing file. Server
 * builds can compile materialized copies of the app tree (see
 * `originalResourcePath` in webpack-loaders.ts); when the directory does not
 * exist next to the copy, rebase the importer onto `workspaceRoot` and retry so
 * sibling directories of the ORIGINAL source are found.
 */
function resolveContextDir(
  specifier: string,
  file: string,
  paths: { outPath?: string; workspaceRoot?: string } | undefined,
): string {
  const direct = path.resolve(path.dirname(file), specifier)
  if (existsSync(direct)) return direct
  if (paths?.outPath && paths.workspaceRoot) {
    const cacheRoot = path.join(paths.outPath, 'cache', 'server')
    const relative = path.relative(cacheRoot, file)
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      const segments = relative.split(path.sep)
      segments.shift() // drop <profileDir>
      const original = path.resolve(
        path.dirname(path.join(paths.workspaceRoot, ...segments)),
        specifier,
      )
      if (existsSync(original)) return original
    }
  }
  return direct
}

/**
 * Expand every `require.context(dir, recursive?, regExp?)` in `source` into a
 * static context module. Calls whose arguments are not statically analyzable
 * (a non-literal directory) are left untouched. Returns the source unchanged
 * when there is nothing to rewrite.
 */
export function rewriteRequireContextSource(
  source: string,
  file: string,
  paths?: { outPath?: string; workspaceRoot?: string },
): string {
  if (!sourceHasRequireContext(source)) return source
  const imports: string[] = []
  const contexts: string[] = []
  let output = ''
  let cursor = 0
  CONTEXT_CALL.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = CONTEXT_CALL.exec(source))) {
    const openIndex = match.index + match[0].length - 1
    const parsed = splitCallArguments(source, openIndex)
    if (!parsed) continue
    const [dirArg, recursiveArg, regExpArg] = parsed.args
    const specifier = dirArg === undefined ? undefined : parseStringLiteral(dirArg)
    if (specifier === undefined) continue
    const recursive = recursiveArg === undefined ? true : recursiveArg.trim() !== 'false'
    const regExp = regExpArg === undefined ? undefined : parseRegExpLiteral(regExpArg.trim())
    if (regExpArg !== undefined && !regExp) continue

    const dir = resolveContextDir(specifier, file, paths)
    const entries = requireContextEntries(dir, recursive, regExp)
    const id = contexts.length
    const binding = `__pnext_context_${id}`
    const rows = entries.map((entry, index) => {
      const namespace = `${binding}_${index}`
      imports.push(`import * as ${namespace} from ${JSON.stringify(entry.file)};`)
      return `[${JSON.stringify(entry.key)}, ${JSON.stringify(entry.file)}, ${namespace}]`
    })
    const contextId = `${specifier} ${recursive ? 'recursive ' : ''}${regExp ? regExp.source : '^\\.\\/.*$'}`
    contexts.push(
      `const ${binding} = __pnext_require_context([${rows.join(', ')}], ${JSON.stringify(contextId)});`,
    )
    output += source.slice(cursor, match.index) + binding
    cursor = parsed.end + 1
    CONTEXT_CALL.lastIndex = cursor
  }
  if (contexts.length === 0) return source
  output += source.slice(cursor)
  const injection = [...imports, CONTEXT_RUNTIME, ...contexts].join('\n')
  return injectAfterDirectives(output, injection)
}

// Injected declarations go after any leading directive prologue ('use client' /
// 'use server') and optional shebang so the directive stays the first statement.
function injectAfterDirectives(source: string, injection: string): string {
  const prologue =
    /^(\uFEFF?(?:#![^\n]*\n)?(?:[ \t]*(['"])use [\w-]+\2[ \t]*;?[ \t]*(?:\r?\n|$))*)/.exec(source)
  const index = prologue ? prologue[0].length : 0
  return `${source.slice(0, index)}${injection}\n${source.slice(index)}`
}
