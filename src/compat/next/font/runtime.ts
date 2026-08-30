import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ResolvedConfig } from '../../../config'
import { onExtensionHostReset, registerResponseFinalizers } from '../../../extensions'
import { getWorkUnit } from '../../../request/context'
import type { MetadataLink } from '../../../types'
import { persistFont, persistedFont } from './cache'
import { escapeRegex } from '../../../utils/code'
import {
  familyStack,
  fontStyle,
  googleFontNaming,
  localFontNaming,
  singleQuoteFamily,
  stableJson,
  type FontDisplay,
  type GoogleFontOptions,
  type LocalFontOptions,
  type LocalFontSource,
  type NextFont,
  type NextFontWithVariable,
} from './shared'

export type {
  FontDisplay,
  GoogleFontOptions,
  LocalFontOptions,
  LocalFontSource,
  NextFont,
  NextFontWithVariable,
}

interface FontScope {
  fonts: Map<string, FontDefinition>
  /** Set once a resolved font in this render shipped a size-adjusted fallback face. */
  sizeAdjust?: boolean
}

interface FontDefinition {
  className: string
  family: string
  key: string
  resolve(context: FontResolveContext): Promise<ResolvedFont>
  style: NextFont['style']
  variable: string
  hasVariable: boolean
}

interface FontResolveContext {
  config: ResolvedConfig
  dev?: boolean
}

export interface ResolvedFontAssets {
  css: string
  preloads: MetadataLink[]
}

interface ResolvedFont {
  css: string
  /** Whether this font emitted a size-adjusted fallback face (drives Next's `next-size-adjust` meta). */
  sizeAdjust: boolean
  /** Preloadable font links (empty when `preload:false`). Delivered via the
   * `Link` response header in prod, not as HTML `<link>` tags. */
  preloads: MetadataLink[]
  /** Whether this definition emitted any font file (used to decide preconnect). */
  usesFonts: boolean
  /** Emitted font files on disk, re-checked on every resolve — a rebuild can
   * wipe the output directory under a running server. */
  files: string[]
  /** Local source files this resolution read; the persisted record stats them. */
  sources?: string[]
}

interface GoogleFontMetadata {
  axes?: { tag: string; min: number; max: number; defaultValue?: number }[]
  styles: string[]
  subsets: string[]
  weights: string[]
}

interface NormalizedGoogleOptions {
  axes?: string[]
  adjustFontFallback: boolean
  display: FontDisplay
  fallback: string[]
  preload: boolean
  styles: string[]
  subsets?: string[]
  variable?: string
  weights: string[]
}

interface NormalizedLocalSource {
  file: string
  style?: string
  weight?: string
}

/**
 * State every copy of this module must agree on: the app reaches next/font through the COMPILED
 * runtime, the framework through node_modules, so a plain module-level value exists once per copy.
 */
const fontRuntimeGlobal = globalThis as typeof globalThis & Record<symbol, unknown>
const sharedAcrossInstances = <T>(key: symbol, create: () => T) =>
  (fontRuntimeGlobal[key] ??= create()) as T

const fontStorage = sharedAcrossInstances(
  Symbol.for('pnext.compat.font.storage'),
  () => new AsyncLocalStorage<FontScope>(),
)
const allowedDisplayValues = new Set(['auto', 'block', 'swap', 'fallback', 'optional'])
const require = createRequire(import.meta.url)
const googleCssCache = new Map<string, Promise<string>>()
const googleFontFileCache = new Map<string, Promise<Uint8Array>>()
// Shared for the same reason as declaredFonts below, and so a request-time render reuses the
// build's resolution instead of re-fetching the Google stylesheet on every cold start.
const resolvedFontCache = sharedAcrossInstances(
  Symbol.for('pnext.compat.font.resolved'),
  () => new Map<string, Promise<ResolvedFont>>(),
)
let googleMetadataCache: Record<string, GoogleFontMetadata> | undefined

/**
 * Every font definition constructed so far, whether or not a render has read its `.className` yet.
 * Definitions are created when the app's font module evaluates - well before the render that registers
 * them - which is what makes the resolve prewarmable.
 */
const declaredFonts = sharedAcrossInstances(
  Symbol.for('pnext.compat.font.declared'),
  () => new Map<string, FontDefinition>(),
)

/**
 * Resolve the declared fonts ahead of the render that will ask for them. Fire-and-forget: this only
 * fills `resolvedFontCache`, so a failure costs nothing - the render's own `resolveFont` re-runs and
 * surfaces the error.
 */
export async function prewarmFonts(
  config: ResolvedConfig,
  options: { dev?: boolean } = {},
): Promise<void> {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  if (process.env.PNEXT_PREWARM_FONTS === '0' || declaredFonts.size === 0) return
  await Promise.allSettled(
    [...declaredFonts.values()].map(font => resolveFont(font, { config, dev: options.dev })),
  )
}

export function runWithFontScope<T>(callback: () => T): T {
  // Ensure the `Link`-header finalizer is registered before any render runs.
  // Idempotent; register-font also calls it (canonical orchestrator seam).
  registerFontFinalizerOnce()
  return fontStorage.run({ fonts: new Map() }, callback)
}

/** Work-unit stash key for the font `Link` header preloads collected in a render. */
const FONT_HEADER_PRELOADS = Symbol.for('pnext.compat.font.headerPreloads')

export async function fontAssets(
  config: ResolvedConfig,
  options: { dev?: boolean } = {},
): Promise<ResolvedFontAssets> {
  const scope = fontStorage.getStore()
  if (!scope || scope.fonts.size === 0) return { css: '', preloads: [] }

  const resolved = await Promise.all(
    [...scope.fonts.values()].map(font => resolveFont(font, { config, dev: options.dev })),
  )

  const preloads = dedupePreloads(resolved.flatMap(font => font.preloads))
  // Next delivers font preloads via a `Link` response header (not HTML link
  // tags). Stash them on the request work unit; the response finalizer
  // (registerFontResponseFinalizer) reads them back and sets the header.
  stashHeaderPreloads(preloads)
  if (resolved.some(font => font.sizeAdjust)) scope.sizeAdjust = true

  const usesFonts = resolved.some(font => font.usesFonts)
  return {
    css: resolved
      .map(font => font.css)
      .filter(Boolean)
      .join('\n'),
    // Prod matches Next: font preloads travel EXCLUSIVELY in the `Link` response header, so the SSR
    // document carries no `<link as="font">` tags. The live DOM still gets the links post-load via
    // fontPreloadDomScript, which derives them from the emitted @font-face CSS - Next's client inserts
    // them the same way, and the navigation suite counts them in the browser. Dev keeps the document
    // links, since it has no header path.
    preloads:
      preloads.length > 0 ? (options.dev ? preloads : []) : usesFonts ? [fontPreconnect()] : [],
  }
}

/**
 * Inline script that mirrors Next's client-side font preload insertion: scan
 * same-origin stylesheets for @font-face sources whose filename carries the
 * `.p.` preload marker and insert a `<link rel="preload" as="font">` for each
 * (deduped against any existing link). Prod-only companion to the header-only
 * delivery above.
 */
export function fontPreloadDomScript(): string {
  return (
    '<script>(function(){try{function a(){var seen={},ls=document.querySelectorAll(\'link[as="font"]\');' +
    'for(var i=0;i<ls.length;i++)seen[ls[i].href]=1;' +
    'for(var i=0;i<document.styleSheets.length;i++){var rules;try{rules=document.styleSheets[i].cssRules}catch(e){continue}if(!rules)continue;' +
    'for(var j=0;j<rules.length;j++){var r=rules[j];if(!(r.type===5))continue;' +
    'var m=/url\\((?:"|\')?([^"\')\\s]*\\.p\\.woff2)/.exec(r.cssText);if(!m)continue;' +
    'var u;try{u=new URL(m[1],location.href).href}catch(e){continue}if(seen[u])continue;seen[u]=1;' +
    'var l=document.createElement("link");l.rel="preload";l.as="font";l.type="font/woff2";l.setAttribute("crossorigin","");l.href=u;document.head.appendChild(l)}}}' +
    'document.readyState==="loading"?document.addEventListener("DOMContentLoaded",a):a()}catch(e){}})();</script>'
  )
}

/**
 * Next's `<meta name="next-size-adjust">` marker, emitted once per document whenever any next/font in
 * the render shipped a metrics-adjusted fallback face (`appUsingSizeAdjustment`). The flag lives on the
 * render's own font scope, so it can neither leak across requests nor depend on a work unit a
 * build-time render does not have.
 */
export function fontSizeAdjustMeta(): string {
  // Byte-for-byte with Next, empty `content` included.
  return fontStorage.getStore()?.sizeAdjust === true
    ? '<meta name="next-size-adjust" content=""/>'
    : ''
}

function stashHeaderPreloads(preloads: MetadataLink[]): void {
  if (preloads.length === 0) return
  const unit = getWorkUnit()
  if (!unit) return
  const compat = (unit.compat ??= {})
  const existing = (compat[FONT_HEADER_PRELOADS] as MetadataLink[] | undefined) ?? []
  compat[FONT_HEADER_PRELOADS] = dedupePreloads([...existing, ...preloads])
}

/** Read the font `Link` header preloads stashed during the current render. */
export function takeFontHeaderPreloads(): MetadataLink[] {
  const unit = getWorkUnit()
  const compat = unit?.compat
  if (!compat) return []
  const preloads = (compat[FONT_HEADER_PRELOADS] as MetadataLink[] | undefined) ?? []
  compat[FONT_HEADER_PRELOADS] = undefined
  return preloads
}

let fontFinalizerRegistered = false
// Host-scoped guard: the finalizer lives on the host, so a fresh host needs it again.
onExtensionHostReset(() => (fontFinalizerRegistered = false))

/**
 * Register the response finalizer that flushes the stashed font preloads to the
 * `Link` header. Idempotent: safe to call from both register-font (the canonical
 * orchestrator seam) and lazily from font-scope setup, so preloads reach the
 * header even before the orchestrator wires register-font in.
 */
export function registerFontFinalizerOnce(): void {
  if (fontFinalizerRegistered) return
  fontFinalizerRegistered = true
  registerResponseFinalizers(ctx => {
    const preloads = takeFontHeaderPreloads()
    if (preloads.length === 0) return
    const value = preloads.map(fontLinkHeaderValue).join(', ')
    const existing = ctx.headers.get('link')
    ctx.headers.set('link', existing ? `${existing}, ${value}` : value)
  })
}

/** `<url>; rel=preload; as=font; type=font/woff2; crossorigin=""` */
export function fontLinkHeaderValue(link: MetadataLink): string {
  const parts = [`<${link.url}>`, `rel=${link.rel}`]
  if (link.as) parts.push(`as=${link.as}`)
  if (link.type) parts.push(`type=${link.type}`)
  parts.push('crossorigin=""')
  return parts.join('; ')
}

export function googleFont(family: string) {
  return (options: GoogleFontOptions = {}): NextFontWithVariable => {
    const naming = googleFontNaming(family, options)
    const { className, variable, fontFamily, hash, style, hasVariable } = naming
    const definition: FontDefinition = {
      className,
      family: fontFamily,
      key: `google:${stableJson({ family, options })}`,
      style,
      variable,
      hasVariable,
      resolve: context =>
        resolveGoogleFont(context, {
          className,
          family,
          fontFamily,
          hash,
          options,
          variable,
        }),
    }

    return fontObject(definition)
  }
}

export interface LocalFontLoader {
  (options: LocalFontOptions): NextFontWithVariable
  withFile: typeof localFontWithFile
}

export const localFont: LocalFontLoader = Object.assign(
  (options: LocalFontOptions) => localFontWithFile(inferLocalFontCallerFile())(options),
  { withFile: localFontWithFile },
)

export function localFontWithFile(callerFile: string | undefined, family?: string) {
  return (options: LocalFontOptions): NextFontWithVariable => {
    const naming = localFontNaming(callerFile, options)
    if (family) {
      naming.fontFamily = family
      naming.style = fontStyle(family, options, options.fallback ?? [])
    }
    const { className, variable, fontFamily, hash, style, hasVariable } = naming
    const definition: FontDefinition = {
      className,
      family: fontFamily,
      key: `local:${stableJson({ callerFile, options })}`,
      style,
      variable,
      hasVariable,
      resolve: context =>
        resolveLocalFont(context, {
          callerFile,
          className,
          fontFamily,
          hash,
          options,
          variable,
        }),
    }

    return fontObject(definition)
  }
}

function fontObject(definition: FontDefinition): NextFontWithVariable {
  // Recorded at construction, not at first `.className` read: the whole point
  // is to know the font exists before any render registers it.
  declaredFonts.set(definition.key, definition)
  // `variable` is exposed only when the loader call passed a `variable` option
  // (matches Next; an extra key would break `toEqual` on the font object).
  const descriptors: PropertyDescriptorMap = {
    className: {
      enumerable: true,
      get() {
        registerFont(definition)
        return definition.className
      },
    },
    style: {
      enumerable: true,
      get() {
        registerFont(definition)
        return definition.style
      },
    },
  }
  if (definition.hasVariable) {
    descriptors.variable = {
      enumerable: true,
      get() {
        registerFont(definition)
        return definition.variable
      },
    }
  }
  return Object.defineProperties({}, descriptors) as NextFontWithVariable
}

function registerFont(definition: FontDefinition) {
  fontStorage.getStore()?.fonts.set(definition.key, definition)
}

async function resolveFont(definition: FontDefinition, context: FontResolveContext) {
  const key = `${context.config.outPath}:${context.dev ? 'dev' : 'build'}:${definition.key}`
  let resolved = resolvedFontCache.get(key)
  if (!resolved) {
    resolved = resolveThroughCache(definition, context, key)
    resolvedFontCache.set(key, resolved)
  }
  const font = await resolved
  // A `pnext build` wiping the output directory under a running server must
  // not leave cached font URLs pointing at deleted files; re-emit them.
  // Font bytes stay cached in memory, so this never refetches the network.
  if (font.files.every(file => existsSync(file))) return font
  const fresh = resolveAndPersist(definition, context, key)
  resolvedFontCache.set(key, fresh)
  return fresh
}

/**
 * Dev reuses the persisted resolution when it still describes disk: a restart otherwise re-fetches every
 * Google stylesheet and font file to re-derive URLs whose bytes are already emitted. A build always
 * resolves for real - it owns the output directory it just emptied.
 */
async function resolveThroughCache(
  definition: FontDefinition,
  context: FontResolveContext,
  key: string,
): Promise<ResolvedFont> {
  if (!context.dev) return definition.resolve(context)
  const persisted = await persistedFont(context.config, key)
  if (persisted) return persisted
  return resolveAndPersist(definition, context, key)
}

function resolveAndPersist(
  definition: FontDefinition,
  context: FontResolveContext,
  key: string,
): Promise<ResolvedFont> {
  const resolved = definition.resolve(context)
  if (context.dev) {
    void resolved.then(font => persistFont(context.config, key, font)).catch(() => undefined)
  }
  return resolved
}

async function resolveGoogleFont(
  context: FontResolveContext,
  request: {
    className: string
    family: string
    fontFamily: string
    hash: string
    options: GoogleFontOptions
    variable: string
  },
): Promise<ResolvedFont> {
  const metadata = googleMetadata()[request.family]
  if (!metadata) throw new Error(`Unknown font \`${request.family}\``)
  const options = normalizeGoogleOptions(request.family, metadata, request.options)
  const adjustFontFallback = options.adjustFontFallback
  const url = googleFontsUrl(request.family, googleFontAxes(metadata, options), options.display)
  const css =
    (await googleCss(url, request.family, Boolean(context.dev))).split('body {', 1)[0] ?? ''
  const fontFiles = findGoogleFontFiles(css, options.preload ? options.subsets : undefined)
  const emitted = await Promise.all(
    fontFiles.map(async fontFile => ({
      ...fontFile,
      emitted: await emitRemoteFontFile(context, fontFile.googleFontFileUrl, {
        preload: fontFile.preloadFontFile,
        adjustFontFallback,
      }),
    })),
  )

  let rewrittenCss = css
  for (const item of emitted) {
    rewrittenCss = rewrittenCss.replaceAll(item.googleFontFileUrl, item.emitted.url)
  }

  const stack = familyStack(request.fontFamily, options.fallback, adjustFontFallback)
  const scopedCss = [
    rewriteFontFamily(rewrittenCss, request.family, request.fontFamily),
    adjustFontFallback ? fallbackFaceCss(request.fontFamily) : '',
    classRule(
      request.className,
      stack,
      singleCssValue(options.weights),
      singleCssValue(options.styles),
    ),
    request.options.variable
      ? variableRule(request.variable, customProperty(request.options.variable), stack)
      : '',
  ]
    .filter(Boolean)
    .join('\n')

  return {
    usesFonts: emitted.length > 0,
    sizeAdjust: adjustFontFallback,
    css: scopedCss,
    preloads: emitted
      .filter(item => item.preloadFontFile)
      .map(item => fontPreload(item.emitted.url, item.emitted.type)),
    files: emitted.map(item => item.emitted.file),
  }
}

async function resolveLocalFont(
  context: FontResolveContext,
  request: {
    callerFile: string | undefined
    className: string
    fontFamily: string
    hash: string
    options: LocalFontOptions
    variable: string
  },
): Promise<ResolvedFont> {
  const display = validateDisplay(request.options.display ?? 'swap')
  const adjustFontFallback = request.options.declarations?.some(item => item.prop === 'font-family')
    ? false
    : true
  const preload = request.options.preload !== false
  const sources = normalizeLocalSources(request.options, request.callerFile)
  const emitted = await Promise.all(
    sources.map(async source => ({
      ...source,
      emitted: await emitLocalFontFile(context, source.file, { preload, adjustFontFallback }),
    })),
  )
  const stack = familyStack(request.fontFamily, request.options.fallback ?? [], adjustFontFallback)
  const declarations = request.options.declarations ?? []
  const faceCss = emitted.map(source =>
    [
      '@font-face{',
      `font-family:${singleQuoteFamily(request.fontFamily)};`,
      `src:url("${source.emitted.url}") format("${fontFormat(source.emitted.ext)}");`,
      `font-display:${display};`,
      (source.weight ?? request.options.weight)
        ? `font-weight:${cssIdentifier(source.weight ?? request.options.weight ?? '')};`
        : '',
      (source.style ?? request.options.style)
        ? `font-style:${cssIdentifier(source.style ?? request.options.style ?? '')};`
        : '',
      ...declarations.map(item => `${cssProperty(item.prop)}:${cssDeclarationValue(item.value)};`),
      '}',
    ]
      .filter(Boolean)
      .join(''),
  )

  return {
    usesFonts: emitted.length > 0,
    sizeAdjust: adjustFontFallback,
    css: [
      ...faceCss,
      adjustFontFallback ? fallbackFaceCss(request.fontFamily) : '',
      classRule(request.className, stack, request.options.weight, request.options.style),
      request.options.variable
        ? variableRule(request.variable, customProperty(request.options.variable), stack)
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
    preloads: preload ? emitted.map(item => fontPreload(item.emitted.url, item.emitted.type)) : [],
    files: emitted.map(item => item.emitted.file),
    sources: emitted.map(source => source.file),
  }
}

function normalizeGoogleOptions(
  family: string,
  metadata: GoogleFontMetadata,
  options: GoogleFontOptions,
): NormalizedGoogleOptions {
  const display = validateDisplay(options.display ?? 'swap')
  const preload = options.preload ?? true
  const subsets = options.subsets
  if (metadata.subsets.length === 0) {
    // Matches Next: fonts without preloadable subsets silently disable preload.
  } else if (preload) {
    if (!subsets) {
      throw new Error(
        `Preload is enabled but no subsets were specified for font \`${family}\`. ` +
          `Please specify subsets or disable preloading.`,
      )
    }
    for (const subset of subsets) {
      if (!metadata.subsets.includes(subset)) {
        throw new Error(`Unknown subset \`${subset}\` for font \`${family}\`.`)
      }
    }
  }

  const weights = uniqueArray(options.weight ? arrayValue(options.weight) : [])
  if (weights.length === 0) {
    if (metadata.weights.includes('variable')) weights.push('variable')
    else throw new Error(`Missing weight for font \`${family}\`.`)
  }
  if (weights.length > 1 && weights.includes('variable')) {
    throw new Error(`Unexpected \`variable\` in weight array for font \`${family}\`.`)
  }
  for (const weight of weights) {
    if (!metadata.weights.includes(weight))
      throw new Error(`Unknown weight \`${weight}\` for font \`${family}\`.`)
  }

  const styles = uniqueArray(options.style ? arrayValue(options.style) : [])
  if (styles.length === 0)
    styles.push(metadata.styles.length === 1 ? (metadata.styles[0] ?? 'normal') : 'normal')
  for (const style of styles) {
    if (!metadata.styles.includes(style))
      throw new Error(`Unknown style \`${style}\` for font \`${family}\`.`)
  }

  if (options.axes) {
    if (!metadata.weights.includes('variable') || weights[0] !== 'variable') {
      throw new Error('Axes can only be defined for variable fonts.')
    }
    const definableAxes = (metadata.axes ?? []).map(axis => axis.tag).filter(tag => tag !== 'wght')
    for (const axis of options.axes) {
      if (!definableAxes.includes(axis))
        throw new Error(`Invalid axes value \`${axis}\` for font \`${family}\`.`)
    }
  }

  return {
    axes: options.axes,
    adjustFontFallback: options.adjustFontFallback ?? true,
    display,
    fallback: options.fallback ?? [],
    preload: metadata.subsets.length === 0 ? false : preload,
    styles,
    subsets,
    variable: options.variable,
    weights,
  }
}

function googleFontAxes(metadata: GoogleFontMetadata, options: NormalizedGoogleOptions) {
  const hasItalic = options.styles.includes('italic')
  const hasNormal = options.styles.includes('normal')
  const ital = hasItalic ? [...(hasNormal ? ['0'] : []), '1'] : undefined

  if (options.weights[0] !== 'variable') {
    return {
      ital,
      wght: options.weights,
      variableAxes: undefined as [string, string][] | undefined,
    }
  }

  let weightAxis: string | undefined
  const variableAxes: [string, string][] = []
  for (const axis of metadata.axes ?? []) {
    if (axis.tag === 'wght') weightAxis = `${axis.min}..${axis.max}`
    else if (options.axes?.includes(axis.tag))
      variableAxes.push([axis.tag, `${axis.min}..${axis.max}`])
  }

  return {
    ital,
    wght: weightAxis ? [weightAxis] : undefined,
    variableAxes: variableAxes.length > 0 ? variableAxes : undefined,
  }
}

function googleFontsUrl(
  family: string,
  axes: { ital?: string[]; wght?: string[]; variableAxes?: [string, string][] },
  display: FontDisplay,
) {
  const variants: [string, string][][] = []
  if (axes.wght) {
    for (const wght of axes.wght) {
      if (!axes.ital) {
        variants.push([['wght', wght], ...(axes.variableAxes ?? [])])
      } else {
        for (const ital of axes.ital)
          variants.push([['ital', ital], ['wght', wght], ...(axes.variableAxes ?? [])])
      }
    }
  } else if (axes.variableAxes) {
    variants.push([...axes.variableAxes])
  }

  if (axes.variableAxes) {
    for (const variant of variants) {
      variant.sort(([a], [b]) => {
        const aLower = a.charCodeAt(0) > 96
        const bLower = b.charCodeAt(0) > 96
        if (aLower && !bLower) return -1
        if (bLower && !aLower) return 1
        return a > b ? 1 : -1
      })
    }
  }

  let url = `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, '+')}`
  const firstVariant = variants[0]
  if (firstVariant) {
    url += `:${firstVariant.map(([key]) => key).join(',')}@${variants
      .map(variant => variant.map(([, value]) => value).join(','))
      .sort(sortFontVariantValues)
      .join(';')}`
  }
  return `${url}&display=${display}`
}

async function googleCss(url: string, family: string, dev: boolean) {
  let cached = googleCssCache.get(url)
  if (!cached) {
    cached = fetchGoogleCss(url, family, dev)
    googleCssCache.set(url, cached)
  }
  return cached
}

async function fetchGoogleCss(url: string, family: string, dev: boolean) {
  const mocked = mockedGoogleResponse(url)
  if (typeof mocked === 'string') return mocked

  const response = await fetch(url, {
    headers: {
      // Google returns modern woff2 CSS for current browsers.
      'user-agent': 'Mozilla/5.0 AppleWebKit/537.36 Chrome/120 Safari/537.36',
    },
  })
  if (!response.ok) {
    const message = `Failed to fetch font \`${family}\` from Google Fonts: ${response.status} ${response.statusText}`
    throw new Error(
      dev ? `${message}. Use NEXT_FONT_GOOGLE_MOCKED_RESPONSES for offline tests.` : message,
    )
  }
  return response.text()
}

function findGoogleFontFiles(css: string, subsetsToPreload: string[] | undefined) {
  const fontFiles: { googleFontFileUrl: string; preloadFontFile: boolean }[] = []
  let currentSubset = ''
  for (const line of css.split('\n')) {
    const subset = /\/\* (.+?) \*\//.exec(line)?.[1]
    if (subset) {
      currentSubset = subset
      continue
    }

    const googleFontFileUrl = /src: url\((.+?)\)/.exec(line)?.[1]
    if (!googleFontFileUrl || fontFiles.some(file => file.googleFontFileUrl === googleFontFileUrl))
      continue
    fontFiles.push({
      googleFontFileUrl,
      preloadFontFile: Boolean(subsetsToPreload?.includes(currentSubset)),
    })
  }
  return fontFiles
}

interface EmitFontOptions {
  preload: boolean
  adjustFontFallback: boolean
}

async function emitRemoteFontFile(context: FontResolveContext, url: string, emit: EmitFontOptions) {
  let cached = googleFontFileCache.get(url)
  if (!cached) {
    cached = fetchFontFile(url)
    googleFontFileCache.set(url, cached)
  }
  const bytes = await cached
  return emitFontBytes(context, bytes, fontExt(url), emit)
}

async function fetchFontFile(url: string) {
  const mocked = mockedGoogleResponse(url)
  if (mocked instanceof Uint8Array) return mocked
  if (typeof mocked === 'string') return new TextEncoder().encode(mocked)

  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to fetch font file from \`${url}\`.`)
  return new Uint8Array(await response.arrayBuffer())
}

async function emitLocalFontFile(context: FontResolveContext, file: string, emit: EmitFontOptions) {
  const bytes = await readFile(file)
  return emitFontBytes(context, bytes, fontExt(file), emit, file)
}

async function emitFontBytes(
  context: FontResolveContext,
  bytes: Uint8Array,
  ext: string,
  emit: EmitFontOptions,
  sourceFile?: string,
) {
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
  // Next's loader names emitted files `[hash]-s.p.[ext]`: `-s` when a
  // size-adjust fallback font is used, `.p` when the font is preloaded.
  const filename = `${hash}${emit.adjustFontFallback ? '-s' : ''}${emit.preload ? '.p' : ''}.${ext}`
  // Served from `/_next/static/media/` — files under the out dir's public/ map 1:1 to the URL path,
  // which is the only place dev and build both look them up.
  const mediaSegments = ['_next', 'static', 'media']
  const outDir = path.join(context.config.outPath, 'public', ...mediaSegments)
  const file = path.join(outDir, filename)
  const asset = {
    ext,
    file,
    type: fontMimeType(ext),
    url: `/${mediaSegments.join('/')}/${filename}`,
  }
  // Existence first, mkdir second: at request time the filesystem is read-only, and an
  // unconditional mkdir throws EROFS just to discover the build already emitted these bytes.
  if (existsSync(file)) return asset
  await mkdir(outDir, { recursive: true })
  if (sourceFile) await copyFile(sourceFile, file)
  else await writeFile(file, bytes)
  return asset
}

function normalizeLocalSources(
  options: LocalFontOptions,
  callerFile: string | undefined,
): NormalizedLocalSource[] {
  if (!callerFile) throw new Error('next/font/local requires PNext server source transforms.')
  const values = Array.isArray(options.src) ? options.src : [options.src]
  return values.map(value => {
    const item = typeof value === 'string' ? { path: value } : value
    if (!item.path) throw new Error('next/font/local src entries require a path.')
    const file = path.resolve(path.dirname(callerFile), item.path)
    if (!existsSync(file)) throw new Error(`Font file not found: ${item.path}`)
    return { file, style: item.style, weight: item.weight }
  })
}

function inferLocalFontCallerFile(): string | undefined {
  const stack = new Error().stack
  if (!stack) return undefined
  for (const line of stack.split('\n')) {
    const file = stackFrameFile(line)
    if (!file) continue
    if (file.replace(/\\/g, '/').includes('/src/compat/next/font/')) continue
    return originalSourceFile(file)
  }
  return undefined
}

function stackFrameFile(line: string) {
  const match =
    /\(?((?:file:\/\/)?\/[^():]+\.[cm]?[jt]sx?|(?:file:\/\/)?\/[^():]+\.mjs):\d+:\d+\)?/.exec(line)
  const file = match?.[1]
  if (!file) return undefined
  return file.startsWith('file://') ? fileURLToPath(file) : file
}

function originalSourceFile(file: string) {
  const source = sourceComment(file)
  if (!source) return file
  const normalized = source.replace(/\\/g, '/')
  if (normalized.startsWith('file://')) return fileURLToPath(normalized)
  if (path.isAbsolute(normalized)) return existsSync(normalized) ? normalized : file
  const nodeModulesIndex = normalized.indexOf('node_modules/')
  const relative = nodeModulesIndex === -1 ? normalized : normalized.slice(nodeModulesIndex)
  const candidate = path.resolve(compiledProjectRoot(file), relative)
  return existsSync(candidate) ? candidate : file
}

function sourceComment(file: string) {
  if (!existsSync(file)) return undefined
  const firstLine = readFileSync(file, 'utf8').split(/\r?\n/, 1)[0]?.trim()
  return /^\/\/\s+(.+)$/.exec(firstLine ?? '')?.[1]
}

function compiledProjectRoot(file: string) {
  const marker = `${path.sep}.pnext${path.sep}`
  const index = file.indexOf(marker)
  return index === -1 ? process.cwd() : file.slice(0, index)
}

function googleMetadata() {
  if (!googleMetadataCache) {
    googleMetadataCache = loadGoogleMetadata()
  }
  return googleMetadataCache
}

function loadGoogleMetadata(): Record<string, GoogleFontMetadata> {
  const override = process.env.PNEXT_FONT_GOOGLE_METADATA
  if (override) {
    const metadata = readGoogleMetadataFile(override)
    if (metadata) return metadata
    throw new Error(`Invalid Google font metadata file: ${override}`)
  }

  const metadata =
    tryLoadGoogleMetadata('next-font/google/font-data.json') ?? tryLoadGoogleMetadata('next-font')
  if (metadata) return metadata

  throw new Error('next/font/google requires Google font metadata. Install `next-font`.')
}

function tryLoadGoogleMetadata(specifier: string): Record<string, GoogleFontMetadata> | undefined {
  try {
    const loaded = require(specifier) as
      | {
          default?: unknown
          googleFontsMetadata?: unknown
        }
      | Record<string, GoogleFontMetadata>
    const metadata =
      'googleFontsMetadata' in loaded
        ? loaded.googleFontsMetadata
        : 'default' in loaded
          ? loaded.default
          : loaded
    return isGoogleMetadata(metadata) ? metadata : undefined
  } catch {
    return undefined
  }
}

function readGoogleMetadataFile(file: string): Record<string, GoogleFontMetadata> | undefined {
  const metadata: unknown = JSON.parse(readFileSync(file, 'utf8'))
  return isGoogleMetadata(metadata) ? metadata : undefined
}

function isGoogleMetadata(value: unknown): value is Record<string, GoogleFontMetadata> {
  if (!value || typeof value !== 'object') return false
  const inter = (value as Record<string, GoogleFontMetadata>).Inter
  return Boolean(
    inter &&
    Array.isArray(inter.weights) &&
    Array.isArray(inter.styles) &&
    Array.isArray(inter.subsets),
  )
}

function mockedGoogleResponse(url: string) {
  const mockFile = process.env.NEXT_FONT_GOOGLE_MOCKED_RESPONSES
  if (!mockFile) return undefined
  const mocked = require(mockFile) as Record<string, string>
  const value = mocked[url]
  if (value === undefined) throw new Error(`Missing mocked response for URL: ${url}`)
  if (typeof value === 'string' && value.startsWith('/') && existsSync(value)) {
    return new Uint8Array(readFileSync(value))
  }
  return value
}

function rewriteFontFamily(css: string, originalFamily: string, scopedFamily: string) {
  const familyPattern = escapeRegex(originalFamily)
  return css.replace(
    new RegExp(`font-family:\\s*(["']?)${familyPattern}\\1`, 'g'),
    `font-family:${singleQuoteFamily(scopedFamily)}`,
  )
}

/** Metrics-adjusted fallback `@font-face` (`'<family> Fallback'`). We omit the
 * ascent/descent/size-adjust metrics (would need fontkit); the local() source
 * never loads, so the browser resolves the real font or the next stack entry. */
function fallbackFaceCss(family: string) {
  return `@font-face{font-family:${singleQuoteFamily(`${family} Fallback`)};src:local("Arial");}`
}

function classRule(className: string, familyStack: string, weight?: string, style?: string) {
  return [
    `.${className}{font-family:${familyStack};`,
    weight && !isRangeValue(weight) ? `font-weight:${cssIdentifier(weight)};` : '',
    style && !isRangeValue(style) ? `font-style:${cssIdentifier(style)};` : '',
    '}',
  ].join('')
}

function variableRule(className: string, variable: string, familyStack: string) {
  return `.${className}{${variable}:${familyStack};}`
}

function fontPreload(url: string, type: string): MetadataLink {
  return { rel: 'preload', url, as: 'font', type, crossOrigin: '' }
}

/** Single `<link rel="preconnect" href="/" crossorigin="">` for the
 * `preload:false` (no preloaded fonts) case. */
function fontPreconnect(): MetadataLink {
  return { rel: 'preconnect', url: '/', crossOrigin: '' }
}

function dedupePreloads(preloads: MetadataLink[]) {
  const seen = new Set<string>()
  return preloads.filter(preload => {
    if (seen.has(preload.url)) return false
    seen.add(preload.url)
    return true
  })
}

function validateDisplay(value: FontDisplay) {
  if (!allowedDisplayValues.has(value)) throw new Error(`Invalid font display value \`${value}\`.`)
  return value
}

function fontExt(value: string) {
  return /\.(woff2?|eot|ttf|otf)(?:[?#]|$)/.exec(value)?.[1] ?? 'woff2'
}

function fontMimeType(ext: string) {
  if (ext === 'woff') return 'font/woff'
  if (ext === 'ttf') return 'font/ttf'
  if (ext === 'otf') return 'font/otf'
  if (ext === 'eot') return 'application/vnd.ms-fontobject'
  return 'font/woff2'
}

function fontFormat(ext: string) {
  if (ext === 'ttf') return 'truetype'
  if (ext === 'otf') return 'opentype'
  return ext
}

function singleCssValue(values: string[]) {
  return values.length === 1 ? values[0] : undefined
}

function isRangeValue(value: string) {
  return value.trim().includes(' ')
}

function arrayValue<T>(value: T | T[]) {
  return Array.isArray(value) ? value : [value]
}

function uniqueArray<T>(items: T[]) {
  return [...new Set(items)]
}

function customProperty(value: string) {
  if (!/^--[-_a-zA-Z0-9]+$/.test(value)) throw new Error(`Invalid font variable name: ${value}`)
  return value
}

function cssIdentifier(value: string) {
  if (!/^[-_a-zA-Z0-9. ]+$/.test(value)) throw new Error(`Invalid font option value: ${value}`)
  return value
}

function cssProperty(value: string) {
  if (!/^[-_a-zA-Z0-9]+$/.test(value)) throw new Error(`Invalid CSS property: ${value}`)
  return value
}

function cssDeclarationValue(value: string) {
  if (/[;{}]/.test(value)) throw new Error(`Invalid CSS declaration value: ${value}`)
  return value
}

function sortFontVariantValues(a: string, b: string) {
  if (a.includes(',') && b.includes(',')) {
    const [aPrefix, aSuffix] = a.split(',', 2)
    const [bPrefix, bSuffix] = b.split(',', 2)
    return aPrefix === bPrefix
      ? parseInt(aSuffix ?? '0', 10) - parseInt(bSuffix ?? '0', 10)
      : parseInt(aPrefix ?? '0', 10) - parseInt(bPrefix ?? '0', 10)
  }
  return parseInt(a, 10) - parseInt(b, 10)
}
