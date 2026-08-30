// Routing extension registration (COMPAT - may import core freely).
//
// Wires the Next-only routing conventions and request-dependency detectors into the core routing registry
// so core's route scanner carries no Next hardcoding: registerRouteConventions gets the authInterrupt
// boundaries (forbidden/unauthorized), and registerUsageDetectors gets next/headers, next/navigation
// request-hook and next/server connection() import detection.
//
// A pure-core app registers none of these, so its route scan discovers only the generic conventions.

import type { ResolvedConfig } from '../../config'
import {
  registerAlwaysClientEntryReason,
  registerClientEntryDetectors,
  registerRouteDependencyClassifiers,
  registerRouteConventions,
  registerUsageDetectors,
} from '../../extensions'
import { nextCompatEnabled } from '../../compat/aliases'
import { escapeRegex } from '../../utils/code'

export function registerRoutingExtensions(config: ResolvedConfig): void {
  if (!nextCompatEnabled(config)) return
  // Next's experimental authInterrupts boundaries mirror error/not-found.
  registerRouteConventions(
    { name: 'forbidden', boundary: true },
    { name: 'unauthorized', boundary: true },
  )
  registerUsageDetectors(usesNextRequestImport, usesNextServerConnection)
  registerRouteDependencyClassifiers(classifyNextRouteDependencies)
  registerClientEntryDetectors(
    { reason: 'actions', detect: usesServerActionForm },
    { reason: 'form', detect: usesNextForm },
    { reason: 'control-flow', detect: usesClientControlFlowThrow },
  )
  // Next emits its app-router bootstrap for every app page, so every document
  // hydrates — instrumentation-client runs before hydration and the hydration
  // timestamp exists even on a page with no client components at all
  // (instrumentation-client-hook asserts both). Core keeps its leaner default.
  registerAlwaysClientEntryReason('compat-parity')
}

// A route's layout chain is re-classified for every route below it, and the answer depends only on
// the source and the route kind - memoize on exactly that.
const classificationCache = new Map<string, boolean>()

function classifyNextRouteDependencies({
  kind,
  files,
}: import('../../extensions').RouteDependencyContext) {
  for (const { source } of files) {
    const key = `${kind}\0${source.length}\0${Bun.hash(source).toString()}`
    let usesRequest = classificationCache.get(key)
    if (usesRequest === undefined) {
      usesRequest = sourceUsesRequest(kind, source)
      classificationCache.set(key, usesRequest)
    }
    if (usesRequest) return { usesRequest: true }
  }
  return undefined
}

function sourceUsesRequest(kind: 'page' | 'handler', source: string): boolean {
  const requestUse = usesNextRequestImport(source) || usesNextServerConnection(source)
  const afterOnly = hasAfterCallbacks(source) && !hasRequestApiOutsideAfter(source)
  const handlerAfterDraftMode = kind === 'handler' && hasAfterDraftMode(source)

  // Page after() callbacks run after their render scope has detached, so an
  // API used only there does not make the page dynamic. Handler callbacks
  // retain the request scope and must render per request instead.
  if ((requestUse && (kind === 'handler' || !afterOnly)) || handlerAfterDraftMode) return true
  // An automatic page that schedules after() work needs a request lifecycle to flush it after the
  // response. Explicit static segment config still wins in core's mode inference: the page is statically
  // prerendered and its after() runs during the build prerender, so it must NOT be forced dynamic here.
  // draftMode()-only after() work needs no request lifecycle either: it is readable at buildtime and
  // enable()/disable() throw inside after() regardless. Such a page stays statically prerenderable so its
  // callbacks run during the build prerender.
  return (
    kind === 'page' &&
    hasAfterCallbacks(source) &&
    !hasRequestApiUse(source) &&
    !hasAfterDraftMode(source) &&
    !hasExplicitStaticDynamic(source)
  )
}

function hasAfterDraftMode(source: string): boolean {
  return hasAfterCallbacks(source) && nextHeadersBindings(source).draftMode.length > 0
}

function hasRequestApiOutsideAfter(source: string): boolean {
  return hasRequestApiUse(withoutAfterCallbacks(source))
}

function hasRequestApiUse(source: string): boolean {
  const outside = stripCommentsAndStrings(source)
  const headers = nextHeadersBindings(source)
  return (
    headers.headers.some(name => new RegExp(`\\b${escapeRegex(name)}\\s*\\(`).test(outside)) ||
    headers.cookies.some(name => new RegExp(`\\b${escapeRegex(name)}\\s*\\(`).test(outside)) ||
    connectionBindings(source).some(name =>
      new RegExp(`\\b${escapeRegex(name)}\\s*\\(`).test(outside),
    )
  )
}

function nextHeadersBindings(source: string) {
  const headers: string[] = []
  const cookies: string[] = []
  const draftMode: string[] = []
  const pattern = /\bimport\s+\{([^}]*)\}\s+from\s*['"]next\/headers(?:\.js)?['"]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(stripComments(source)))) {
    for (const item of match[1]!.split(',')) {
      const [imported, local] = item.trim().split(/\s+as\s+/)
      const name = (local ?? imported)?.trim()
      if (!name) continue
      if (imported?.trim() === 'headers') headers.push(name)
      if (imported?.trim() === 'cookies') cookies.push(name)
      if (imported?.trim() === 'draftMode') draftMode.push(name)
    }
  }
  return { headers, cookies, draftMode }
}

function connectionBindings(source: string): string[] {
  const names: string[] = []
  const pattern = /\bimport\s+[^'";]+?\s+from\s*['"]next\/server(?:\.js)?['"]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(stripComments(source)))) {
    const named = /\{([^}]*)\}/.exec(match[0])?.[1]
    if (!named) continue
    for (const item of named.split(',')) {
      const [imported, local] = item.trim().split(/\s+as\s+/)
      if (imported?.trim() === 'connection') names.push((local ?? imported).trim())
    }
  }
  return names
}

// Masking only blanks comment/string characters, so a source with no `after`
// token at all cannot grow one — the gate skips the whole-source mask (the
// common case) without changing a single answer.
const AFTER_TOKEN = /\bafter\b/

function mentionsAfter(source: string): boolean {
  return source.includes('after') && AFTER_TOKEN.test(source)
}

function hasAfterCallbacks(source: string): boolean {
  return mentionsAfter(source) && /\bafter\s*\(/.test(maskCommentsAndStrings(source))
}

// Explicit static segment config that keeps a page statically prerenderable
// (so its after() runs during the build prerender, not per request). Matches
// `export const dynamic = 'error'` / `'force-static'`.
function hasExplicitStaticDynamic(source: string): boolean {
  return /\bexport\s+const\s+dynamic\s*=\s*['"](?:error|force-static)['"]/.test(
    stripComments(source),
  )
}

function withoutAfterCallbacks(source: string): string {
  if (!mentionsAfter(source)) return source
  const chars = [...source]
  const searchable = maskCommentsAndStrings(source)
  const pattern = /\bafter\s*\(/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(searchable))) {
    let depth = 1
    let index = match.index + match[0].length
    for (; index < searchable.length && depth > 0; index++) {
      if (searchable[index] === '(') depth++
      else if (searchable[index] === ')') depth--
    }
    if (depth !== 0) continue
    for (let cursor = match.index; cursor < index; cursor++) chars[cursor] = ' '
    pattern.lastIndex = index
  }
  return chars.join('')
}

const maskCommentsAndStrings = memoizeBySource(maskSource)

function maskSource(source: string): string {
  const chars = [...source]
  let quote: string | undefined
  let lineComment = false
  let blockComment = false
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index]!
    const next = chars[index + 1]
    if (lineComment) {
      if (char === '\n') lineComment = false
      else chars[index] = ' '
      continue
    }
    if (blockComment) {
      chars[index] = char === '\n' ? '\n' : ' '
      if (char === '*' && next === '/') {
        chars[index + 1] = ' '
        blockComment = false
        index++
      }
      continue
    }
    if (quote) {
      chars[index] = char === '\n' ? '\n' : ' '
      if (char === '\\') {
        if (next && next !== '\n') chars[index + 1] = ' '
        index++
      } else if (char === quote) {
        quote = undefined
      }
      continue
    }
    if (char === '/' && next === '/') {
      chars[index] = chars[index + 1] = ' '
      lineComment = true
      index++
      continue
    }
    if (char === '/' && next === '*') {
      chars[index] = chars[index + 1] = ' '
      blockComment = true
      index++
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      chars[index] = ' '
      quote = char
    }
  }
  return chars.join('')
}

// A source that declares a server action needs the client action runtime, even
// when the <form> itself lives in a client component the page hands the action
// to. Preserve string literals so module and inline directives remain visible,
// but discard comments: framework/user documentation mentioning `'use server'`
// is not executable and must not pull the action runtime into every importing route.
function usesServerActionForm(source: string): boolean {
  return (
    (source.includes('use server') && /(['"])use server\1/.test(stripComments(source))) ||
    usesClientFunctionFormAction(source)
  )
}

// React runs a FUNCTION passed to `<form action>` / `<button formAction>` on the client with the form's
// FormData - no server action involved. That needs the action runtime's submit interception even in an app
// with no `'use server'` anywhere. Restricted to `'use client'` sources (a server component passing a
// function needs the directive) and to non-string expressions, so `<form action={url}>` keeps the lean
// entry.
const CLIENT_FUNCTION_ACTION_PATTERN = /\b(?:action|formAction)\s*=\s*\{\s*(?!['"`])/

function usesClientFunctionFormAction(source: string): boolean {
  if (!hasUseClientDirective(source)) return false
  return CLIENT_FUNCTION_ACTION_PATTERN.test(stripComments(source))
}

const USE_CLIENT_DIRECTIVE =
  /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*|#![^\n]*\n|\s)*(['"])use client\1/

// The prologue regex scans every leading comment; the literal it ends in has to
// be somewhere in the source for it to match at all.
function hasUseClientDirective(source: string): boolean {
  return source.includes('use client') && USE_CLIENT_DIRECTIVE.test(source)
}
const CONTROL_FLOW_IMPORT_PATTERN =
  /import\s*\{[^}]*\b(?:notFound|forbidden|unauthorized)\b[^}]*\}\s*from\s*['"]next\/navigation(?:\.js)?['"]/

// A `'use client'` module that throws notFound()/forbidden()/unauthorized() does it during HYDRATION,
// where only the in-tree ClientErrorBoundary can render the outcome - the deferred window last resort
// lands at idle, long after the throw has unmounted the SSR tree. Server components keep the lean entry:
// their throw is resolved by the server render.
function usesClientControlFlowThrow(source: string): boolean {
  return hasUseClientDirective(source) && CONTROL_FLOW_IMPORT_PATTERN.test(source)
}

const NEXT_FORM_IMPORT_PATTERN = /import\s+[^'";]*\s+from\s+['"]next\/form(?:\.js)?['"]/

function usesNextForm(source: string): boolean {
  if (!source.includes('next/form')) return false
  const searchable = stripComments(source)
  if (!NEXT_FORM_IMPORT_PATTERN.test(searchable)) return false
  return (
    /\b<form\b[^>]*\b(?:action|formAction)\s*=/.test(searchable) ||
    /\bformAction\s*:\s*/.test(searchable) ||
    /<\s*[A-Za-z_$][\w$]*\b[^>]*\b(?:action|formAction)\s*=/.test(searchable)
  )
}

// A next/headers or next/navigation request-hook import makes a route dynamic.
function usesNextRequestImport(source: string): boolean {
  const withoutComments = stripComments(source)
  // A `draftMode`-only import of next/headers is not request-bound: Next still
  // fully prerenders such pages (isEnabled is false at build time); only a
  // __prerender_bypass cookie opts into a fresh dynamic render at request time.
  const draftModeOnlyImport =
    /\bimport\s+\{\s*draftMode\s*(?:as\s+[\w$]+\s*)?,?\s*\}\s*from\s*['"]next\/headers(?:\.js)?['"]/g
  const headers = nextHeadersImportPattern().test(withoutComments.replace(draftModeOnlyImport, ''))
  const client = /^\s*['"]use client['"]\s*;?/.test(withoutComments)
  return headers || (!client && importsNextNavigationRequestHook(withoutComments))
}

function nextHeadersImportPattern() {
  return /(?:from\s+|import\s*\()\s*['"]next\/headers(?:\.js)?['"]/
}

function importsNextNavigationRequestHook(source: string): boolean {
  const importPattern = /\bimport\s+(type\s+)?([^'";]+?)\s+from\s+['"]next\/navigation['"]/g
  let match: RegExpExecArray | null
  while ((match = importPattern.exec(source))) {
    const [, typeKeyword, clause] = match
    if (!typeKeyword && clause && includesRequestNavigationHook(importedExports(clause)))
      return true
  }

  const exportPattern = /\bexport\s+(type\s+)?\{([^}]*)\}\s+from\s+['"]next\/navigation['"]/g
  while ((match = exportPattern.exec(source))) {
    const [, typeKeyword, clause] = match
    if (!typeKeyword && clause && includesRequestNavigationHook(exportedNames(clause))) return true
  }
  return false
}

function usesNextServerConnection(source: string): boolean {
  const withoutComments = stripComments(source)
  const searchable = stripCommentsAndStrings(source)
  const importPattern = /\bimport\s+(type\s+)?([^'";]+?)\s+from\s+['"]next\/server(?:\.js)?['"]/g
  let match: RegExpExecArray | null
  while ((match = importPattern.exec(withoutComments))) {
    const [, typeKeyword, clause] = match
    if (typeKeyword || !clause) continue
    for (const pattern of importedConnectionCallPatterns(clause)) {
      if (pattern.test(searchable)) return true
    }
  }
  return false
}

function importedConnectionCallPatterns(clause: string): RegExp[] {
  const patterns: RegExp[] = []
  const namespace = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause)?.[1]
  if (namespace) patterns.push(new RegExp(`\\b${escapeRegex(namespace)}\\.connection\\s*\\(`))
  const named = /\{([^}]*)\}/.exec(clause)?.[1]
  if (named) {
    for (const item of named.split(',')) {
      const [imported, local] = item.trim().split(/\s+as\s+/)
      if (imported?.trim() === 'connection') {
        patterns.push(new RegExp(`\\b${escapeRegex((local ?? imported).trim())}\\s*\\(`))
      }
    }
  }
  return patterns
}

function includesRequestNavigationHook(exports: string[]): boolean {
  return (
    exports.includes('*') || exports.includes('useSearchParams') || exports.includes('useRoute')
  )
}

function importedExports(clause: string): string[] {
  const value = clause.trim()
  if (!value) return []
  const exports = new Set<string>()
  if (value.startsWith('*')) exports.add('*')
  const defaultImport = /^[A-Za-z_$][\w$]*/.exec(value)
  if (defaultImport && !value.startsWith('{') && !value.startsWith('*')) exports.add('default')
  const named = /\{([^}]*)\}/.exec(value)
  if (named?.[1]) {
    for (const item of named[1].split(',')) {
      const [name] = item.trim().split(/\s+as\s+/)
      if (name) exports.add(name.trim())
    }
  }
  return [...exports]
}

function exportedNames(clause: string): string[] {
  return clause
    .split(',')
    .map(item =>
      item
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim(),
    )
    .filter((name): name is string => Boolean(name) && name !== 'type')
}

/**
 * One route's request-dependency answer strips the same source several times over and masks it several
 * more, each a whole-source pass. A tiny FIFO of recent (source -> derived) pairs collapses those to one
 * each; the key is the source itself, so it never stales.
 */
function memoizeBySource(derive: (source: string) => string) {
  const cache = new Map<string, string>()
  return (source: string): string => {
    const hit = cache.get(source)
    if (hit !== undefined) return hit
    const value = derive(source)
    if (cache.size >= 4) cache.delete(cache.keys().next().value!)
    cache.set(source, value)
    return value
  }
}

const stripCommentsAndStrings = memoizeBySource(source =>
  stripComments(source).replace(/(['"`])(?:\\[\s\S]|(?!\1)[^\\])*\1/g, ''),
)

// Keep literal contents intact: consumers use this to find directive literals
// and import specifiers. A regex-only stripper mistakes the second slash in
// `"https://..."` for a line comment, erasing every real directive later on
// that line or below it. Scan the lexical states instead, so every source
// shape follows the same rule.
const stripComments = memoizeBySource(source => {
  const chars = [...source]
  let quote: string | undefined
  let lineComment = false
  let blockComment = false
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index]!
    const next = chars[index + 1]
    if (lineComment) {
      if (char === '\n') lineComment = false
      else chars[index] = ' '
      continue
    }
    if (blockComment) {
      chars[index] = char === '\n' ? '\n' : ' '
      if (char === '*' && next === '/') {
        chars[index + 1] = ' '
        blockComment = false
        index++
      }
      continue
    }
    if (quote) {
      if (char === '\\') index++
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '/' && next === '/') {
      chars[index] = chars[index + 1] = ' '
      lineComment = true
      index++
      continue
    }
    if (char === '/' && next === '*') {
      chars[index] = chars[index + 1] = ' '
      blockComment = true
      index++
    }
  }
  return chars.join('')
})
