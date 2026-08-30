import { existsSync, lstatSync, readdirSync, readFileSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { Plugin } from 'esbuild'
import type { ResolvedConfig } from '../../config'
import { resolveImport } from '../../resolve/imports'
import { hoistCssImports } from '../../css/build'
import { maybeLightningcssTransform } from './lightningcss'
import { escapeRegex } from '../../utils/code'

interface ComposeRef {
  names: string[]
  from?: string
}

interface CssModuleInfo {
  classes: Set<string>
  composes: Map<string, ComposeRef[]>
  dependencies: string[]
}

const pagesCompatIgnoredSourceEntries = new Set(['.next', '.pnext', 'app', 'node_modules', 'pages'])

export function materializeNextCssSources(config: ResolvedConfig) {
  const generatedRoot = path.dirname(config.appPath)
  if (path.basename(path.dirname(generatedRoot)) !== 'pnext-pages-compat') return

  for (const entry of readdirSync(config.root)) {
    if (pagesCompatIgnoredSourceEntries.has(entry)) continue
    const source = path.join(config.root, entry)
    const target = path.join(generatedRoot, entry)
    if (existsSync(target)) continue
    try {
      symlinkSync(source, target, lstatSync(source).isDirectory() ? 'dir' : 'file')
    } catch {
      // A concurrent materialization may have linked the same source already.
    }
  }
}

export function nextCssModuleChunkPlugin(config: ResolvedConfig): Plugin {
  return {
    name: 'pnext-compat-css-modules',
    setup(build) {
      build.onLoad({ filter: /\.css$/ }, ({ path: file }) => {
        const source = nextCssSource(file, config.root)
        // This onLoad claims every `.css`, so core's directive-order plugin
        // (registered after it) never sees a compat app's stylesheet — hoist here.
        const raw = hoistCssImports(readFileSync(source, 'utf8'))
        const contents = file.endsWith('.module.css')
          ? transformCssModule(raw, source, config.root)
          : rewriteTransparentBodyChildren(raw)
        return {
          // No-op unless next.config enables experimental.useLightningcss.
          contents: maybeLightningcssTransform(contents, source, config.root),
          loader: 'css',
          resolveDir: path.dirname(source),
        }
      })
    },
  }
}

export function nextCssResolveModule(config: ResolvedConfig) {
  return (file: string): Record<string, string> | undefined =>
    isCssModuleFile(file) ? cssModuleMapping(file, config.root) : undefined
}

export function nextCssLoadModuleForClient(config: ResolvedConfig) {
  return (file: string): string | undefined =>
    isCssModuleFile(file)
      ? `export default ${JSON.stringify(cssModuleMapping(file, config.root))};`
      : undefined
}

export function nextCssResolveDependency(config: ResolvedConfig) {
  const requires = new Map<string, NodeJS.Require>()
  return (_root: string, fromFile: string, specifier: string): string | undefined => {
    if (specifier.startsWith('.') || path.isAbsolute(specifier)) return undefined
    const source = nextCssSource(fromFile, config.root)
    let require = requires.get(source)
    if (!require) {
      require = createRequire(source)
      requires.set(source, require)
    }
    try {
      const resolved = require.resolve(specifier)
      return isCssDependency(resolved) ? resolved : undefined
    } catch {
      return undefined
    }
  }
}

function isCssModuleFile(file: string) {
  return file.endsWith('.module.css')
}

function isCssDependency(file: string) {
  return /\.(?:css|scss|sass)$/.test(file)
}

function cssModuleMapping(file: string, root: string) {
  file = nextCssSource(file, root)
  const cache = new Map<string, CssModuleInfo>()
  const info = moduleInfo(file, root, cache)
  return Object.fromEntries(
    [...info.classes].map(className => [
      className,
      classValue(file, className, root, cache, new Set()),
    ]),
  )
}

export function nextCssSource(file: string, root: string) {
  const resolved = path.resolve(file)
  const parts = resolved.split(path.sep)
  // Matched on the cache segments alone: the out dir above them is configurable
  // (distDir) and gains a `dev/` level under a dev server.
  const buildClientIndex = parts.findIndex(
    (_, index) => parts.slice(index, index + 3).join('/') === 'cache/server/build-client',
  )
  if (buildClientIndex !== -1) {
    const source = path.join(root, ...parts.slice(buildClientIndex + 3))
    if (existsSync(source)) return source
  }
  const generatedIndex = parts.lastIndexOf('pnext-pages-compat')
  const relative = generatedIndex === -1 ? undefined : parts.slice(generatedIndex + 2)
  if (relative?.length) {
    const source = path.join(
      root,
      ...(relative[0] === 'source-app'
        ? ['app', ...relative.slice(1)]
        : relative[0] === 'source-pages'
          ? ['pages', ...relative.slice(1)]
          : relative),
    )
    if (existsSync(source)) return source
  }

  return resolved
}

function rewriteTransparentBodyChildren(source: string) {
  return source.replace(
    /body\s*>\s*(-?[_a-zA-Z][\w-]*)/g,
    (_, element: string) => `:is(body>${element},body :where(pnext-layout,#pnext-page)>${element})`,
  )
}

function transformCssModule(source: string, file: string, root: string) {
  const info = moduleInfoFromSource(source, file, root)
  const imports = info.dependencies.map(dep => `@import ${JSON.stringify(dep)};`).join('\n')
  const css = scopeKeyframes(rewriteModuleSelectors(stripComposes(source), file), file)
  return [imports, css].filter(Boolean).join('\n')
}

function moduleInfo(file: string, root: string, cache: Map<string, CssModuleInfo>): CssModuleInfo {
  const key = path.resolve(file)
  const cached = cache.get(key)
  if (cached) return cached
  const info = moduleInfoFromSource(readFileSync(key, 'utf8'), key, root)
  cache.set(key, info)
  return info
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
  cache: Map<string, CssModuleInfo>,
  stack: Set<string>,
): string {
  const key = `${path.resolve(file)}\0${className}`
  if (stack.has(key)) return cssModuleClassName(file, className)
  stack.add(key)

  const info = moduleInfo(file, root, cache)
  const parts = [cssModuleClassName(file, className)]
  for (const ref of info.composes.get(className) ?? []) {
    if (ref.from === 'global') {
      parts.push(...ref.names)
      continue
    }
    const refFile = ref.from ? resolveCssModuleImport(root, file, ref.from) : file
    if (!refFile) continue
    const refInfo = moduleInfo(refFile, root, cache)
    for (const name of ref.names) {
      if (!refInfo.classes.has(name)) continue
      parts.push(...classValue(refFile, name, root, cache, stack).split(/\s+/))
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

function resolveCssModuleImport(root: string, fromFile: string, specifier: string) {
  const resolved = resolveImport(root, fromFile, specifier)
  if (resolved && isCssModuleFile(resolved)) return path.resolve(resolved)
  if (specifier.startsWith('.') || path.isAbsolute(specifier)) return undefined

  const sibling = path.resolve(path.dirname(fromFile), specifier)
  return existsSync(sibling) && isCssModuleFile(sibling) ? sibling : undefined
}

function stripComposes(source: string) {
  return source.replace(/\s*composes\s*:[^;{}]+;/g, '')
}

function cssClassNames(source: string) {
  return new Set(selectorClassNames(source.replace(/\{[^{}]*\}/g, '{')))
}

function selectorClassNames(selector: string) {
  const classes: string[] = []
  const pattern = /(^|[\s,>+~])\.(-?[_a-zA-Z][\w-]*)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(selector))) {
    if (match[2]) classes.push(match[2])
  }
  return classes
}

function rewriteModuleSelectors(css: string, file: string) {
  // A selector is any brace/semicolon-free run ending at a brace - which also covers NESTED rule
  // openings (postcss-nested / native CSS nesting and rules inside `@media`), whose selectors follow a
  // brace or a declaration's semicolon. A prior version anchored on (^|}) and left nested class
  // selectors unhashed while the JS mapping handed out the hashed name.
  //
  // Scanned by hand rather than with a regex: on a stylesheet whose tail holds no brace, the obvious
  // pattern re-consumes the whole tail from every offset and backtracks it away again, which is
  // quadratic and can cost minutes of build time on a large module.
  let out = ''
  let runStart = 0
  for (let index = 0; index < css.length; index++) {
    const char = css[index]
    if (char === '{') {
      out += `${rewriteSelectorRun(css.slice(runStart, index), file)}{`
      runStart = index + 1
    } else if (char === '}' || char === ';') {
      out += css.slice(runStart, index + 1)
      runStart = index + 1
    }
  }
  return out + css.slice(runStart)
}

function rewriteSelectorRun(selector: string, file: string) {
  if (selector.trimStart().startsWith('@')) return selector
  let out = selector
  for (const className of selectorClassNames(selector)) {
    out = rewriteClassSelector(out, cssModuleClassName(file, className), className)
  }
  return out.replace(/:global\(((?:[^()]|\([^()]*\))*)\)/g, '$1')
}

function scopeKeyframes(css: string, file: string) {
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

function keyframeNames(css: string) {
  const names = new Set<string>()
  const pattern = /@(?:-webkit-)?keyframes\s+(-?[_a-zA-Z][\w-]*)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(css))) {
    if (match[1]) names.add(match[1])
  }
  return names
}

function cssModuleClassName(file: string, className: string) {
  const base = path
    .basename(file)
    .replace(/\.module\.css$/, '')
    .replace(/[^_a-zA-Z0-9]/g, '_')
  const hash = pathHash(cssModuleScopePath(file))
  return `${base}_${className}_${hash}`
}

function cssModuleScopePath(file: string) {
  const normalized = file.split(path.sep).join('/')
  const appIndex = normalized.lastIndexOf('/app/')
  if (appIndex !== -1) return normalized.slice(appIndex + 1)
  return normalized.split('/').slice(-3).join('/')
}

function rewriteClassSelector(css: string, scopedClassName: string, originalClassName: string) {
  const pattern = new RegExp(`\\.${escapeRegex(originalClassName)}(?![-_a-zA-Z0-9])`, 'g')
  return css.replace(pattern, `.${scopedClassName}`)
}

function pathHash(file: string) {
  let hash = 5381
  for (const char of file) hash = ((hash << 5) + hash) ^ char.charCodeAt(0)
  return (hash >>> 0).toString(36).slice(0, 5)
}
