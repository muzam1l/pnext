// Sass / SCSS compiler (COMPAT).
//
// pnext core treats `.scss`/`.sass` as EMPTY modules (no compiler). This module supplies the missing
// compiler using the optional `sass` package (Dart Sass, JS API), consumed at every CSS build and
// runtime seam through the CSS-extras registry.
//
// Two products, mirroring how core handles `.module.css`:
//   - compileSassCss(file)    -> compiled CSS text, module class selectors already rewritten to their
//                                scoped names.
//   - sassModuleMapping(file) -> { localClass: scopedClass } for a `.module.scss` / `.module.sass` file.
//
// The scoped class-name algorithm is a byte-for-byte replica of core's `cssModuleClassName` so a class
// referenced in a component matches the selector emitted in the CSS chunk. If core's algorithm changes,
// this replica MUST change with it.
//
// `sass` is an optionalDependency; when absent the module degrades to core's behavior (empty CSS, empty
// map) so a non-sass app is never broken by loading compat.

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { resolveImport } from '../../resolve/imports'
import { nextCssSource } from './modules'
import { escapeRegex } from '../../utils/code'

// Structural typing of the slice of the Dart Sass JS API we use. Avoids a hard
// type dependency on the optional `sass` package (mirrors how css.ts/runtime.ts
// type postcss/sharp via local structural shapes).
interface SassCompileOptions {
  loadPaths?: string[]
  style?: 'expanded' | 'compressed'
  syntax?: 'scss' | 'indented' | 'css'
  sourceMap?: boolean
}
interface SassCompileResult {
  css: string
}
interface SassApi {
  compile: (path: string, options?: SassCompileOptions) => SassCompileResult
  compileString: (source: string, options?: SassCompileOptions) => SassCompileResult
}

const sassApis = new Map<string, SassApi | null>()

/** Resolve the optional `sass` package once, from the project root. */
function loadSass(root: string): SassApi | undefined {
  const cacheKey = path.resolve(root)
  if (sassApis.has(cacheKey)) return sassApis.get(cacheKey) ?? undefined
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const roots = [root, path.resolve(import.meta.dirname, '../../..'), process.env.PNEXT_NEXTJS_REPO]
    .filter(
      (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
    )
    .map(candidate => path.join(path.resolve(candidate), 'package.json'))

  for (const packageJson of roots) {
    try {
      const appRequire = createRequire(packageJson)
      const sass = appRequire('sass') as SassApi
      sassApis.set(cacheKey, sass)
      return sass
    } catch {
      // Try the next resolution root.
    }
  }

  // Not installed / not resolvable — degrade to core's empty-module behavior.
  sassApis.set(cacheKey, null)
  return undefined
}

/** True for `.scss` / `.sass` (module or global). */
export function isSassFile(file: string): boolean {
  return /\.(?:scss|sass)$/.test(file)
}

/** True for `.module.scss` / `.module.sass`. */
export function isSassModuleFile(file: string): boolean {
  return /\.module\.(?:scss|sass)$/.test(file)
}

/**
 * Compile a `.scss`/`.sass` file to CSS. For a `*.module.*` file the class
 * selectors in the compiled output are rewritten to their scoped names so the
 * emitted stylesheet matches the class map a component imports.
 *
 * `includePaths` (Next / node-sass compatibility) are threaded to Dart Sass as
 * `loadPaths`. When `sass` is not installed this returns '' (core's prior
 * empty-module behavior) so the bundle still succeeds.
 */
export function compileSassCss(file: string, root: string, includePaths: string[] = []): string {
  file = nextCssSource(file, root)
  const sass = loadSass(root)
  if (!sass) return ''
  const compiled = sass.compile(file, {
    loadPaths: [path.dirname(file), ...includePaths],
    style: 'expanded',
    syntax: file.endsWith('.sass') ? 'indented' : 'scss',
  }).css

  if (!isSassModuleFile(file)) return compiled
  return transformCssModule(compiled, file, root, includePaths)
}

/**
 * Compile a `.module.scss`/`.module.sass` and return its `{ local: scoped }`
 * class-name map (parallel to core's `cssModuleMapping` for `.module.css`).
 * Class names are read from the COMPILED css (so classes produced by mixins /
 * `@extend` are included). When `sass` is absent, returns `{}`.
 */
export function sassModuleMapping(
  file: string,
  root: string,
  includePaths: string[] = [],
): Record<string, string> {
  file = nextCssSource(file, root)
  const sass = loadSass(root)
  if (!sass) return {}
  const compiled = sass.compile(file, {
    loadPaths: [path.dirname(file), ...includePaths],
    style: 'expanded',
    syntax: file.endsWith('.sass') ? 'indented' : 'scss',
  }).css

  return cssModuleMappingFromSource(compiled, file, root, includePaths)
}

// ---------------------------------------------------------------------------
// Class-scoping — replicated from src/css/index.ts so scoped names match exactly.
// ---------------------------------------------------------------------------

interface ComposeRef {
  names: string[]
  from?: string
}

interface CssModuleInfo {
  classes: Set<string>
  composes: Map<string, ComposeRef[]>
  dependencies: string[]
}

function cssModuleMappingFromSource(
  source: string,
  file: string,
  root: string,
  includePaths: string[],
): Record<string, string> {
  const cache = new Map<string, CssModuleInfo>()
  const info = moduleInfoFromSource(source, file, root)
  cache.set(path.resolve(file), info)
  return Object.fromEntries(
    [...info.classes].map(className => [
      className,
      classValue(file, className, root, includePaths, cache, new Set()),
    ]),
  )
}

function transformCssModule(
  source: string,
  file: string,
  root: string,
  _includePaths: string[],
): string {
  const info = moduleInfoFromSource(source, file, root)
  const imports = info.dependencies.map(dep => `@import ${JSON.stringify(dep)};`).join('\n')
  const css = scopeKeyframes(rewriteModuleSelectors(stripComposes(source), file), file)
  return [imports, css].filter(Boolean).join('\n')
}

function moduleInfo(
  file: string,
  root: string,
  includePaths: string[],
  cache: Map<string, CssModuleInfo>,
): CssModuleInfo {
  const key = path.resolve(file)
  const cached = cache.get(key)
  if (cached) return cached
  const source = isSassFile(key)
    ? compileSassCssSource(key, root, includePaths)
    : readFileSync(key, 'utf8')
  const info = moduleInfoFromSource(source, key, root)
  cache.set(key, info)
  return info
}

function compileSassCssSource(file: string, root: string, includePaths: string[]): string {
  const sass = loadSass(root)
  if (!sass) return ''
  return sass.compile(file, {
    loadPaths: [path.dirname(file), ...includePaths],
    style: 'expanded',
    syntax: file.endsWith('.sass') ? 'indented' : 'scss',
  }).css
}

function moduleInfoFromSource(source: string, file: string, root: string): CssModuleInfo {
  const classes = cssClassNames(source)
  const composes = new Map<string, ComposeRef[]>()
  const dependencies: string[] = []
  const seenDependencies = new Set<string>()
  const rulePattern = /(^|})([^{}]+)\{([^{}]*)\}/g
  let match: RegExpExecArray | null

  while ((match = rulePattern.exec(source))) {
    const [, , selector, body] = match
    if (!selector || !body) continue
    const localClasses = selectorClassNames(selector).filter(className => classes.has(className))
    if (localClasses.length === 0) continue

    for (const ref of composeRefs(body)) {
      for (const localClass of localClasses) {
        const refs = composes.get(localClass) ?? []
        refs.push(ref)
        composes.set(localClass, refs)
      }
      if (!ref.from || ref.from === 'global') continue
      const dependency = resolveCssModuleImport(root, file, ref.from)
      if (!dependency || seenDependencies.has(dependency)) continue
      dependencies.push(dependency)
      seenDependencies.add(dependency)
    }
  }

  return { classes, composes, dependencies }
}

function classValue(
  file: string,
  className: string,
  root: string,
  includePaths: string[],
  cache: Map<string, CssModuleInfo>,
  stack: Set<string>,
): string {
  const key = `${path.resolve(file)}\0${className}`
  if (stack.has(key)) return cssModuleClassName(file, className)
  stack.add(key)

  const info = moduleInfo(file, root, includePaths, cache)
  const parts = [cssModuleClassName(file, className)]
  for (const ref of info.composes.get(className) ?? []) {
    if (ref.from === 'global') {
      parts.push(...ref.names)
      continue
    }
    const refFile = ref.from ? resolveCssModuleImport(root, file, ref.from) : file
    if (!refFile) continue
    const refInfo = moduleInfo(refFile, root, includePaths, cache)
    for (const name of ref.names) {
      if (!refInfo.classes.has(name)) continue
      parts.push(...classValue(refFile, name, root, includePaths, cache, stack).split(/\s+/))
    }
  }

  stack.delete(key)
  return [...new Set(parts)].join(' ')
}

function composeRefs(body: string): ComposeRef[] {
  const refs: ComposeRef[] = []
  const pattern = /\bcomposes\s*:\s*([^;]+);/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(body))) {
    const value = match[1]?.trim()
    if (!value) continue
    const fromMatch = /^(.+?)\s+from\s+(['"]?)([^'"]+)\2$/.exec(value)
    const names = (fromMatch?.[1] ?? value).split(/\s+/).filter(Boolean)
    if (names.length === 0) continue
    refs.push({ names, ...(fromMatch?.[3] ? { from: fromMatch[3] } : {}) })
  }

  return refs
}

function resolveCssModuleImport(
  root: string,
  fromFile: string,
  specifier: string,
): string | undefined {
  const resolved = resolveImport(root, fromFile, specifier)
  if (resolved && isCssModuleFile(resolved)) return path.resolve(resolved)
  if (specifier.startsWith('.') || path.isAbsolute(specifier)) return undefined

  const sibling = path.resolve(path.dirname(fromFile), specifier)
  return existsSync(sibling) && isCssModuleFile(sibling) ? sibling : undefined
}

function isCssModuleFile(file: string): boolean {
  return /\.module\.(?:css|scss|sass)$/.test(file)
}

function stripComposes(source: string): string {
  return source.replace(/\s*composes\s*:[^;{}]+;/g, '')
}

function rewriteModuleSelectors(css: string, file: string): string {
  return css.replace(/(^|})([^{}]+)\{/g, (match, boundary: string, selector: string) => {
    if (selector.trimStart().startsWith('@')) return match
    let out = selector
    for (const className of selectorClassNames(selector)) {
      out = rewriteClassSelector(out, cssModuleClassName(file, className), className)
    }
    return `${boundary}${out}{`
  })
}

function cssClassNames(source: string): Set<string> {
  return new Set(selectorClassNames(source.replace(/\{[^{}]*\}/g, '{')))
}

function selectorClassNames(selector: string): string[] {
  const classNames: string[] = []
  const classPattern = /(^|[\s,>+~])\.(-?[_a-zA-Z][\w-]*)/g
  let match: RegExpExecArray | null
  while ((match = classPattern.exec(selector))) {
    if (match[2]) classNames.push(match[2])
  }
  return classNames
}

function cssModuleClassName(file: string, className: string): string {
  const base = path
    .basename(file)
    .replace(/\.module\.(?:css|scss|sass)$/, '')
    .replace(/[^_a-zA-Z0-9]/g, '_')
  const hash = pathHash(cssModuleScopePath(file))
  return `${base}_${className}_${hash}`
}

function scopeKeyframes(css: string, file: string): string {
  let out = css
  for (const name of keyframeNames(css)) {
    const scoped = cssModuleClassName(file, name)
    out = out.replace(
      new RegExp(`(@(?:-webkit-)?keyframes\\s+)${escapeRegex(name)}(?![-_a-zA-Z0-9])`, 'g'),
      `$1${scoped}`,
    )
    out = out.replace(
      new RegExp(`(animation-name\\s*:\\s*)${escapeRegex(name)}(?![-_a-zA-Z0-9])`, 'g'),
      `$1${scoped}`,
    )
    out = out.replace(
      new RegExp(
        `(animation\\s*:[^;{}]*?(?<![-_a-zA-Z0-9]))${escapeRegex(name)}(?![-_a-zA-Z0-9])`,
        'g',
      ),
      `$1${scoped}`,
    )
  }
  return out
}

function keyframeNames(css: string): Set<string> {
  const names = new Set<string>()
  const pattern = /@(?:-webkit-)?keyframes\s+(-?[_a-zA-Z][\w-]*)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(css))) {
    if (match[1]) names.add(match[1])
  }
  return names
}

function cssModuleScopePath(file: string): string {
  const normalized = file.split(path.sep).join('/')
  const appIndex = normalized.lastIndexOf('/app/')
  if (appIndex !== -1) return normalized.slice(appIndex + 1)
  return normalized.split('/').slice(-3).join('/')
}

function rewriteClassSelector(
  css: string,
  scopedClassName: string,
  originalClassName: string,
): string {
  const esbuildNamePattern = new RegExp(
    `\\.${escapeRegex(originalClassName)}(?![-_a-zA-Z0-9])`,
    'g',
  )
  return css.replace(esbuildNamePattern, `.${scopedClassName}`)
}

function pathHash(file: string): string {
  let hash = 5381
  for (const char of file) hash = ((hash << 5) + hash) ^ char.charCodeAt(0)
  return (hash >>> 0).toString(36).slice(0, 5)
}
