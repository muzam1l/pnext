import type { Plugin } from 'esbuild'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute } from 'node:path'

import {
  isCommonJsModuleSource,
  providedEntryResolution,
  resolveLinkedPackageSpecifier,
  resolveRuntimeSpecifier,
} from '../../resolve/imports'
import { rewriteFacts } from '../../resolve/scan-facts'
import { spliceSource } from '../../runtime/module-transform'
import { clientReferenceId } from '../../client/reference'
import { hasUseClientDirective } from '../../client/reference-stub'
import { esbuildEntryExportNames, isIdentifier, uniqueIdentifier } from '../../utils/code'
import { fileMemo, fileMemoAsync } from './source-cache'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

// esbuild treats a CommonJS entry point as `module.exports`, bypassing its
// normal `__esModule` default-import interop. Route CJS package entries through
// a JavaScript ESM facade so Babel/TypeScript-shaped modules expose
// `exports.default`, while ordinary CJS continues to expose `module.exports`.
const interopEntryPrefix = 'pnext-cjs-interop:'

/**
 * Entry-point CJS classification, done ONCE where the caller already knows the entry - the marker keeps
 * the plugin's onResolve off every non-entry resolve, where its old catch-all filter answered a large
 * volume of dead callbacks. Returns undefined for ESM/unresolvable entries: use the specifier as-is.
 */
export function commonJsInteropEntry(
  specifier: string,
  resolveDir: string,
  resolved?: string,
): string | undefined {
  const classified =
    resolved ?? (isAbsolute(specifier) ? specifier : resolveEntryPath(specifier, resolveDir))
  if (!classified || !isCommonJsJavaScriptFile(classified)) return undefined
  return interopEntryPrefix + specifier
}

export function commonJsDefaultInteropPlugin(): Plugin {
  return {
    name: 'pnext-cjs-default-interop',
    setup(build) {
      build.onResolve({ filter: /^pnext-cjs-interop:/ }, args => {
        const source = args.path.slice(interopEntryPrefix.length)
        const resolved = isAbsolute(source)
          ? source
          : resolveEntryPath(source, args.resolveDir || process.cwd())
        return {
          path: `${source}.pnext-cjs-default-interop.js`,
          namespace: 'pnext-cjs-default-interop',
          pluginData: { source, resolved: resolved ?? source },
        }
      })
      build.onLoad({ filter: /.*/, namespace: 'pnext-cjs-default-interop' }, args => {
        const data = args.pluginData as { source?: string; resolved?: string } | undefined
        const source = data?.source ?? args.path
        // The facade's `export default` alone breaks a consumer's named import
        // (`import { Network } from 'relay-runtime'`), so mirror the entry's
        // statically discoverable CommonJS keys as named exports too. Read them
        // from the *resolved* file — `source` may be a bare specifier.
        const names = data?.resolved ? namedFacadeExportNames(data.resolved) : []
        const namespaceName = '__pnext_cjs_ns'
        const bindings = names.map((name, index) => ({
          name,
          localName: `__pnext_cjs_named_${index}`,
        }))
        return {
          contents: [
            `const value = require(${JSON.stringify(source)});`,
            `const ${namespaceName} = value != null && value.__esModule ? value.default : value;`,
            `export default ${namespaceName};`,
            // `__esModule` only redirects the *default* binding; named exports
            // live on the raw `module.exports` (a tsc-shaped CJS module sets
            // `__esModule` with no `exports.default`, so the unwrapped namespace
            // is undefined). Read names off `value`, falling back to the
            // namespace for packages that expose them only under `.default`.
            ...bindings.map(({ name, localName }) => {
              const key = JSON.stringify(name)
              return `const ${localName} = value != null && value[${key}] !== undefined ? value[${key}] : (${namespaceName} == null ? undefined : ${namespaceName}[${key}]);`
            }),
            ...(bindings.length > 0
              ? [
                  `export { ${bindings
                    .map(({ name, localName }) => `${localName} as ${name}`)
                    .join(', ')} };`,
                ]
              : []),
          ].join('\n'),
          loader: 'js',
          // resolveDir must be a real directory. `dirname()` of a scoped bare
          // specifier ('@scope/pkg' -> '@scope') is not one, and esbuild will
          // not walk up for node_modules from it; unscoped only worked by
          // accident ('pkg' -> '.'). Anchor on the resolved file.
          resolveDir: dirname(data?.resolved ?? source),
        }
      })
    },
  }
}

/**
 * `use client` in a CommonJS file, resolved once per file: the callback fires
 * for every `.js` in every build, and the overwhelming majority answer "not a
 * client reference" after a full read the bundler then repeats itself.
 */
export const clientReferenceLoad = fileMemoAsync(async (file: string) => {
  let bytes: Buffer
  try {
    bytes = await readFile(file)
  } catch {
    return undefined
  }
  // Almost every file the bundler loads has no directive at all. Search the
  // raw bytes for the only string one can be spelled with, and decode (plus
  // run the real directive-prologue test) for the few that could.
  if (!bytes.includes('use client')) return undefined
  const source = bytes.toString('utf8')
  if (!isCommonJsModuleSource(source, file) || !hasUseClientDirective(source)) return undefined
  const references = commonJsExportNames(source)
    .map(name => {
      const value = name === 'default' ? 'exports.default' : `exports[${JSON.stringify(name)}]`
      const reference = JSON.stringify({
        id: `c-${clientReferenceId(file, name)}`,
        file,
        exportName: name,
      })
      return `if (typeof ${value} === "function") ${value}[Symbol.for("pnext.clientReference")] = ${reference};`
    })
    .join('\n')
  return {
    contents: references ? `${source}\n${references}\n` : source,
    loader: 'js' as const,
    resolveDir: dirname(file),
  }
})

export function commonJsClientReferencePlugin(): Plugin {
  return {
    name: 'pnext-cjs-client-references',
    setup(build) {
      build.onLoad({ filter: /\.c?js$/, namespace: 'file' }, args => clientReferenceLoad(args.path))
    },
  }
}

// Minified ESM keeps every statement on one line, which `isCommonJsModuleSource`'s line-anchored test
// misses (`…;export{H as RWebShare};`). Such an entry taken for CommonJS gets the facade above, whose
// `__esModule ? .default` unwrap of esbuild's `__toCommonJS` namespace yields undefined and publishes
// no named exports at all. Checked HERE rather than in the shared predicate: that one also decides
// transform bail-outs and vendor entry shape, where the looser test changes unrelated behaviour.
const MINIFIED_ESM_SYNTAX = /[;}](?:import(?:\s|[{'"*])|export(?:\s|[{*]))/

const isCommonJsJavaScriptFile = fileMemo((file: string) => {
  try {
    const source = readFileSync(file, 'utf8')
    return isCommonJsModuleSource(source, file) && !MINIFIED_ESM_SYNTAX.test(source)
  } catch {
    return true
  }
})

/** Entry classification is per (specifier, resolveDir) and never changes. */
const entryResolutions = new Map<string, string | undefined>()

function resolveEntryPath(specifier: string, resolveDir: string) {
  const key = `${specifier}\0${resolveDir}`
  if (entryResolutions.has(key)) return entryResolutions.get(key)
  // The vendor build already resolved bare entry specifiers; never re-resolve.
  const provided = providedEntryResolution(specifier, resolveDir)
  if (provided) {
    entryResolutions.set(key, provided)
    return provided
  }
  let resolved: string | undefined
  try {
    resolved = Bun.resolveSync(specifier, resolveDir)
  } catch {
    resolved = undefined
  }
  entryResolutions.set(key, resolved)
  return resolved
}

// esbuild turns a bundled CommonJS dependency into an ESM wrapper whose
// default export is the complete `module.exports` object. That is right for a
// static default import, but webpack's static namespace interop exposes an
// own `.default` value (when present) as `namespace.default`. Dynamic import
// intentionally retains the native ESM-wrapper namespace and is left alone.
export function rewriteStaticCommonJsNamespaceImports(source: string, file: string): string {
  const facts = rewriteFacts(file, source)
  const edits: { start: number; end: number; value: string }[] = []
  const taken: string[] = []
  for (const statement of facts.imports) {
    // Namespace-only: `import d, * as ns from 'x'` would lose its default.
    const binding = statement.bindings[0]
    if (statement.bindings.length !== 1 || binding?.imported !== '*') continue
    if (!isCommonJsImport(statement.specifier, file)) continue

    const defaultBinding = uniqueIdentifier(source, '__pnext_cjs_namespace_default', ...taken)
    taken.push(defaultBinding)
    const quote = source[statement.specifierStart] ?? "'"
    const indent = statementIndent(source, statement.start)
    edits.push({
      start: statement.start,
      end: statement.end,
      value: `import ${defaultBinding} from ${quote}${statement.specifier}${quote};\n${indent}const ${binding.local} = { ...${defaultBinding} };`,
    })
  }
  return edits.length > 0 ? spliceSource(source, edits) : source
}

/** Leading whitespace of the line the statement starts on. */
function statementIndent(source: string, start: number) {
  const lineStart = source.lastIndexOf('\n', start - 1) + 1
  const indent = source.slice(lineStart, start)
  return /^[\t ]*$/.test(indent) ? indent : ''
}

function isCommonJsImport(specifier: string, file: string): boolean {
  const resolved = resolveRuntimeSpecifier(dirname(file), specifier)
  return resolved !== undefined && extname(resolved) === '.cjs'
}

export function recoverCommonJsNamedExportsPlugin(): Plugin {
  return {
    name: 'pnext-recover-cjs-named-exports',
    setup(build) {
      build.onEnd(result => {
        const output = result.outputFiles?.[0]
        if (!output) return
        const next = recoverCommonJsNamedExports(decoder.decode(output.contents))
        if (next === decoder.decode(output.contents)) {
          return
        }
        output.contents = encoder.encode(next)
      })
    },
  }
}

// esbuild's native CommonJS dynamic-import facade only exports `default`. Webpack's namespace has the
// statically discoverable CJS keys too, so create a tiny ESM facade for client-side dynamic imports
// that forwards both forms. Static imports keep esbuild's normal interop path: their namespace shape is
// handled separately above and changing it here would alter static output.
//
// The filter admits any specifier that can still land on a `.cjs` file: a bare package name, a path
// whose final segment carries no extension, or an explicit `.cjs`. Anything ending in another extension
// is excluded in the FILTER - esbuild's Go regexp has no lookahead, so the rule is spelled positively.
const dynamicCjsCandidate = /^[^./]|(^|\/)[^/.]+$|\.cjs([?#]|$)/

export function clientDynamicCommonJsImportsPlugin(root: string): Plugin {
  return {
    name: 'pnext-client-dynamic-cjs-exports',
    setup(build) {
      // Per-BUILD memo of the whole classification. Each miss walks node_modules, probes package
      // targets and may parse the file for its CJS export names, overwhelmingly for the same handful
      // of lazily-imported specifiers.
      const classified = new Map<string, { path: string; names: string[] } | undefined>()
      const classify = (specifier: string, resolveDir: string) => {
        let file: string
        try {
          file =
            resolveLinkedPackageSpecifier(root, `${resolveDir}/pnext-resolve.ts`, specifier, [
              'browser',
              'style',
              'import',
              'default',
            ]) ?? Bun.resolveSync(specifier, resolveDir)
        } catch {
          return undefined
        }
        if (extname(file) !== '.cjs') return undefined
        const names = commonJsExportNamesFromFile(file).filter(name => name !== 'default')
        return names.length === 0 ? undefined : { path: file, names }
      }
      build.onResolve({ filter: dynamicCjsCandidate }, args => {
        if (args.kind !== 'dynamic-import' || !args.resolveDir) return undefined
        const key = `${args.resolveDir}\0${args.path}`
        let hit = classified.get(key)
        if (hit === undefined && !classified.has(key)) {
          hit = classify(args.path, args.resolveDir)
          classified.set(key, hit)
        }
        if (!hit) return undefined
        return {
          path: hit.path,
          namespace: 'pnext-dynamic-cjs-facade',
          pluginData: { names: hit.names },
        }
      })
      build.onLoad({ filter: /.*/, namespace: 'pnext-dynamic-cjs-facade' }, args => {
        const names = (args.pluginData as { names?: string[] } | undefined)?.names ?? []
        const forwards = names
          .map(name => `export const ${name} = value[${JSON.stringify(name)}];`)
          .join('\n')
        return {
          contents: `import value from ${JSON.stringify(args.path)};\nexport default value;\n${forwards}\n`,
          loader: 'js',
          resolveDir: dirname(args.path),
        }
      })
    },
  }
}

// React 19 renders a thenable child by unwrapping it through `use()`. Preact
// does not perform that conversion for a bare child, so a client component's
// `const value = import('pkg').then(...)` otherwise remains an empty node even
// after its chunk has loaded. Rewrite this narrow direct-child pattern to use
// the compat React `use()` shim, which suspends and retries inside pnext's
// implicit client Suspense boundary.
export function rewriteClientDynamicImportPromises(source: string): string {
  const names = [
    ...source.matchAll(
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*import\(\s*(['"])[^'"]+\2\s*\)\s*\.then\s*\(/g,
    ),
  ]
    .map(match => match[1])
    .filter((name): name is string => Boolean(name))
  if (names.length === 0) return source

  const hook = uniqueIdentifier(source, '__pnext_use')
  let next = source
  let changed = false
  for (const name of names) {
    const expression = new RegExp(`\\{${escapeRegExp(name)}\\}`, 'g')
    const rewritten = next.replace(expression, `{${hook}(${name})}`)
    changed ||= rewritten !== next
    next = rewritten
  }
  if (!changed) return source

  const directive = /^(?:\s*['"][^'"]+['"];?\s*)*/.exec(next)?.[0] ?? ''
  return `${directive}import { use as ${hook} } from 'react';\n${next.slice(directive.length)}`
}

function recoverCommonJsNamedExports(code: string) {
  if (hasNonDefaultExport(code)) return code
  const names = [...new Set([...commonJsExportNames(code), ...esbuildEntryExportNames(code)])]
    .filter(name => name !== 'default' && name !== '__esModule')
    .sort()
  if (names.length === 0) return code

  const directDefaultExport = /(^|\n)export default ([^;\n]+);/.exec(code)
  const listedDefaultExport =
    /(^|\n)export\s*\{\s*([A-Za-z_$][\w$]*)\s+as\s+default\s*,?\s*\};?/.exec(code)
  const defaultExport = directDefaultExport ?? listedDefaultExport
  if (!defaultExport?.[2]) return code

  const defaultName = uniqueIdentifier(code, '__pnext_cjs_default')
  const namespaceName = commonJsNamespaceBinding(code, defaultExport[2])
  const usedNames = [defaultName]
  const bindings = names.map(name => {
    const localName = uniqueIdentifier(code, `__pnext_cjs_export_${name}`, ...usedNames)
    usedNames.push(localName)
    return { name, localName }
  })
  const namedBindings = bindings
    .map(
      ({ name, localName }) =>
        `const ${localName} = ${namespaceName ?? defaultName}[${JSON.stringify(name)}];`,
    )
    .join('\n')
  const namedExports = bindings.map(({ name, localName }) => `${localName} as ${name}`).join(', ')

  return code.replace(
    defaultExport[0],
    `${defaultExport[1]}const ${defaultName} = ${defaultExport[2]};\nexport default ${defaultName};\n${namedBindings}\nexport { ${namedExports} };\n`,
  )
}

function commonJsNamespaceBinding(
  code: string,
  defaultName: string,
  depth = 0,
): string | undefined {
  const assignment = new RegExp(
    `(?:^|\\n)(?:var|const|let)\\s+${escapeRegExp(defaultName)}\\s*=\\s*([A-Za-z_$][\\w$]*)\\.default\\s*;`,
  ).exec(code)
  if (assignment?.[1]) return assignment[1]

  const unwrap = new RegExp(
    `(?:^|\\n)(?:var|const|let)\\s+${escapeRegExp(defaultName)}\\s*=\\s*([A-Za-z_$][\\w$]*)\\s*!=\\s*null\\s*&&[\\s\\S]*?\\?\\s*\\1\\.default\\s*:\\s*\\1\\s*;`,
  ).exec(code)?.[1]
  if (unwrap) return unwrap

  // esbuild aliases the interop facade's namespace before exporting it as default. An `__esModule`
  // entry with no `default` unwraps to undefined, so following the alias is what keeps the names
  // being read off the raw `module.exports` rather than off nothing.
  if (depth >= 4) return undefined
  const alias = new RegExp(
    `(?:^|\\n)(?:var|const|let)\\s+${escapeRegExp(defaultName)}\\s*=\\s*([A-Za-z_$][\\w$]*)\\s*;`,
  ).exec(code)?.[1]
  return alias ? commonJsNamespaceBinding(code, alias, depth + 1) : undefined
}

function hasNonDefaultExport(code: string) {
  if (/(^|\n)export\s+(?:\*|(?:const|let|var|function|class)\s+)/.test(code)) return true
  for (const statement of code.matchAll(/(^|\n)export\s*\{([^}]*)\}/g)) {
    const names = (statement[2] ?? '')
      .split(',')
      .map(name =>
        name
          .trim()
          .split(/\s+as\s+/i)
          .at(-1),
      )
      .filter((name): name is string => Boolean(name))
    if (names.some(name => name !== 'default')) return true
  }
  return false
}

function commonJsExportNames(code: string) {
  return [
    ...new Set(
      [
        ...[...code.matchAll(/\bexports\.([A-Za-z_$][\w$]*)\s*=\s*/g)].map(match => match[1]),
        ...[
          ...code.matchAll(
            /\bObject\.defineProperty\(\s*exports\s*,\s*["']([A-Za-z_$][\w$]*)["']/g,
          ),
        ].map(match => match[1]),
        ...extractModuleExportsObjectNames(code),
      ]
        .filter((name): name is string =>
          Boolean(name && name !== '__esModule' && isIdentifier(name)),
        )
        .sort(),
    ),
  ]
}

function commonJsExportNamesFromFile(file: string, visited = new Set<string>()): string[] {
  if (visited.has(file)) return []
  visited.add(file)
  let code: string
  try {
    code = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const names = commonJsExportNames(code)
  if (names.length > 0) return names

  // Follow the simple `const value = require('...'); module.exports = value`
  // form used by packages that re-export an `imports` map entry, plus the
  // equally common direct `module.exports = require('./lib')` (relay-runtime).
  const reexport =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)[\s\S]*?\bmodule\.exports\s*=\s*\1\s*;?/.exec(
      code,
    ) ?? /\bmodule\.exports\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/.exec(code)
  const specifier = reexport?.[2] ?? reexport?.[1]
  if (!specifier) return []
  try {
    return commonJsExportNamesFromFile(Bun.resolveSync(specifier, dirname(file)), visited)
  } catch {
    return []
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractModuleExportsObjectNames(code: string) {
  const start = /\bmodule\.exports\s*=\s*\{/.exec(code)
  if (!start) return []
  const objectBody = topLevelObjectBody(code, start.index + start[0].length - 1)
  if (objectBody === undefined) return []
  return [
    ...objectBody.matchAll(/(?:^|,)\s*(?:([A-Za-z_$][\w$]*)\s*:|["']([A-Za-z_$][\w$]*)["']\s*:)/g),
  ]
    .map(match => match[1] || match[2])
    .filter((name): name is string => Boolean(name && isIdentifier(name)))
}

// Scan an object literal from its opening brace, keeping only top-level text: nested bodies, strings
// and comments are blanked out so a nested key (or a comment separating keys) cannot be mistaken for -
// or hide - a top-level one. Returns undefined when the literal is unterminated.
function topLevelObjectBody(code: string, openIndex: number): string | undefined {
  let depth = 0
  let out = ''
  for (let index = openIndex; index < code.length; index += 1) {
    const char = code[index]!
    if (char === '"' || char === "'" || char === '`') {
      const end = skipString(code, index, char)
      if (depth === 1) out += ' '.repeat(end - index + 1)
      index = end
      continue
    }
    if (char === '/' && (code[index + 1] === '/' || code[index + 1] === '*')) {
      const end = commentEnd(code, index)
      if (depth === 1) out += ' '.repeat(end - index + 1)
      index = end
      continue
    }
    if (char === '{' || char === '[' || char === '(') {
      depth += 1
      if (depth === 1) continue
      out += depth === 2 ? ' ' : ''
      continue
    }
    if (char === '}' || char === ']' || char === ')') {
      depth -= 1
      if (depth === 0) return out
      continue
    }
    if (depth === 1) out += char
  }
  return undefined
}

// Index of the last character of the comment starting at `start`.
function commentEnd(code: string, start: number): number {
  if (code[start + 1] === '/') {
    const newline = code.indexOf('\n', start)
    return (newline < 0 ? code.length : newline) - 1
  }
  const close = code.indexOf('*/', start)
  return close < 0 ? code.length - 1 : close + 1
}

function skipString(code: string, start: number, quote: string): number {
  for (let index = start + 1; index < code.length; index += 1) {
    const char = code[index]
    if (char === '\\') {
      index += 1
      continue
    }
    if (char === quote) return index
  }
  return code.length - 1
}

// Reserved words are legal CommonJS object keys but illegal export bindings, so
// a `module.exports = { class: … }` entry must not reach the facade.
const reservedWords = new Set([
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
])

export const namedFacadeExportNames = fileMemo((file: string): string[] =>
  commonJsExportNamesFromFile(file).filter(
    name => name !== 'default' && name !== '__esModule' && !reservedWords.has(name),
  ),
)
