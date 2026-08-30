// IDLE TIER - the navigation runtime. ./index.ts `import()`s this module on
// idle, so everything here forms the deferred chunk. One file because it is one
// chunk; the seams that do cost bytes stay separate (./hub, ./events).
import {
  entryModuleCache,
  entryModuleHref,
  linkClickTarget,
  linkFromEvent,
  locationKey,
  resolveSoftUrl,
  routerState,
} from './hub'
import {
  HISTORY_BFCACHE_ID_KEY,
  historyBfcacheId,
  historyState,
  newBfcacheId,
  newEntryId,
} from './history'
import {
  exportDocumentFetcher,
  loadingShellPredictionPolicy,
  prefetchStaleTimeMs,
  revalidationPrefetchDelayMs,
  segmentCachePolicy,
  shellStaleTimeMs,
  stylesheetReconciler,
} from './policies'
import {
  emitLocationChange,
  emitNavigationCommit,
  emitNavigationStart,
  scheduleNavigationScroll,
  withSilentLocationChange,
} from './events'
import type {
  ClientPageRoot,
  DocumentNavState,
  EntryModule,
  LinkPrefetchMode,
  LoadingShellPrediction,
  PrefetchedPage,
  PrefetchOptions,
  SegmentCacheHit,
  SoftNavigateOptions,
} from './types'
import type { LinkClickTarget } from './hub'
import { elementInPageSlot, graftPageSlot, loadingShellTarget, pageSlotRange } from './page-slot'
// ---------------------------------------------------------------------------
// DOCUMENTS
// ---------------------------------------------------------------------------
export interface BrowserRouteState {
  route?: string
  params?: Record<string, string | string[]>
  catchAllOptional?: boolean
  prefetchKind?: 'shell' | 'eager'
  runtimePrefetch?: boolean
}

function documentRouteState(doc: Document): BrowserRouteState | undefined {
  const prefix = 'window.__PNEXT_ROUTE__='
  const source = [...doc.scripts]
    .map(script => script.textContent ?? '')
    .find(text => text.startsWith(prefix))
  if (!source) return undefined
  try {
    return JSON.parse(source.slice(prefix.length).replace(/;\s*$/, '')) as BrowserRouteState
  } catch {
    return undefined
  }
}

// Rewrite detection (shared signal with the optimistic-routing predictor). A
// response whose embedded `__PNEXT_ROUTE__` route does not structurally fit the
// pathname it was served at came from a proxy rewrite, and must never be reused
// for a DIFFERENT URL of the same pathname shape - a sibling URL, or the same
// pathname with a different search, may rewrite elsewhere.

/** Extract `__PNEXT_ROUTE__` state directly from an HTML string (no DOM). */
function routeStateFromHtml(html: string): BrowserRouteState | undefined {
  const raw = /window\.__PNEXT_ROUTE__=(\{.*?\});<\/script>/.exec(html)?.[1]
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as BrowserRouteState
  } catch {
    return undefined
  }
}

/**
 * Whether a `__PNEXT_ROUTE__` route pattern (colon form: `:id`, `:slug*`)
 * structurally matches `pathname`. Purely structural - the rewrite signal only.
 */
export function routePatternMatchesPathname(
  route: string,
  pathname: string,
  catchAllOptional = false,
): boolean {
  const pattern = route.split('/').filter(Boolean)
  const target = pathname.split('/').filter(Boolean)
  let cursor = 0
  for (const segment of pattern) {
    if (/^:[\w$]+\*$/.test(segment)) {
      // Catch-all consumes the rest; `[...slug]` requires ≥1 remaining segment.
      return catchAllOptional || target.length - cursor >= 1
    }
    const value = target[cursor++]
    if (value === undefined) return false
    if (/^:[\w$]+$/.test(segment)) continue
    if (segment !== value) return false
  }
  return cursor === target.length
}

/**
 * A cached document is a rewrite when its route pattern does not fit the pathname
 * it was served at. No embedded route state is treated as non-rewrite.
 */
export function isRewriteDocument(html: string, pathname: string): boolean {
  const state = routeStateFromHtml(html)
  if (!state?.route) return false
  return !routePatternMatchesPathname(state.route, pathname, state.catchAllOptional)
}

export function routeParamBoundaryChanged(doc: Document): boolean {
  const current = documentRouteState(document)
  const incoming = documentRouteState(doc)
  if (!current?.route || !incoming?.route) return false
  if (current.route !== incoming.route) return true
  return stableParams(current.params) !== stableParams(incoming.params)
}

function stableParams(params: Record<string, string | string[]> | undefined): string {
  if (!params) return ''
  return JSON.stringify(
    Object.keys(params)
      .sort()
      .map(key => [key, params[key]]),
  )
}

// Importing a route's entry module during a navigation — only the navigation
// runtime ever imports an entry; the registry it reads is in ./hub, where the
// document's own entry registers itself at boot.

async function importEntry(src: string): Promise<EntryModule | null> {
  const href = entryModuleHref(src)
  const cached = entryModuleCache.get(href)
  if (cached) return cached
  window.__PNEXT_ROUTER_IMPORTS__ = (window.__PNEXT_ROUTER_IMPORTS__ ?? 0) + 1
  try {
    const entry = (await import(/* @vite-ignore */ href)) as EntryModule
    entryModuleCache.set(href, entry)
    return entry
  } catch {
    return null
  } finally {
    window.__PNEXT_ROUTER_IMPORTS__ = (window.__PNEXT_ROUTER_IMPORTS__ ?? 1) - 1
  }
}

// Reading and reconciling the live document: nav state, static hints, streamed
// segment/island materialization, stylesheet and <head> upkeep across a swap.

/**
 * The parallel-route state the server embedded into the current document. Echoed
 * on soft-navigation fetches so unmatched slots keep their content and
 * interception routes know the origin.
 */
function currentNavState(): DocumentNavState {
  let state: DocumentNavState = {}
  const script =
    typeof document.getElementById === 'function'
      ? document.getElementById('__PNEXT_NAV_STATE__')
      : null
  if (script?.textContent) {
    try {
      state = JSON.parse(script.textContent) as DocumentNavState
    } catch {
      state = {}
    }
  }
  if (!state.children) state = { ...state, children: location.pathname }
  return state
}

export interface StaticHint {
  isStatic: boolean
  staleTime?: number
  /**
   * Resumed from a BAKED SHELL. Never widens the document's own reuse window -
   * only the sliced static stage is filed as static.
   */
  staticStage?: boolean
}

/**
 * The same classification read out of a document's SOURCE - a navigation response
 * held as text rather than as the live document.
 */
function documentStaticHintFromHtml(html: string): StaticHint | null {
  return staticHintFromJson(navStateJson(html))
}

/** The same flag read out of a document's SOURCE (a navigation response). */
function htmlRuntimePrefetch(html: string): boolean {
  return routeStateFromHtml(html)?.runtimePrefetch === true
}

function staticHintFromJson(json: string | null): StaticHint | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as {
      isStatic?: unknown
      staleTime?: unknown
      staticStage?: unknown
    }
    const staleTime = typeof parsed.staleTime === 'number' ? parsed.staleTime : undefined
    const staticStage = parsed.staticStage === true ? { staticStage: true as const } : {}
    // A PARTIAL (PPR) document is not static but still publishes its `use cache`
    // window; callers read `isStatic` explicitly, so reporting it here never
    // promotes a dynamic document to a static one.
    if (parsed.isStatic !== true) {
      return staleTime === undefined && staticStage.staticStage === undefined
        ? null
        : { isStatic: false, ...(staleTime !== undefined ? { staleTime } : {}), ...staticStage }
    }
    return {
      isStatic: true,
      ...(staleTime !== undefined ? { staleTime } : {}),
      ...staticStage,
    }
  } catch {
    return null
  }
}

function rootLayoutId(doc: Document): string | null {
  return doc.documentElement?.getAttribute('data-pnext-root-layout')?.replace(/[?#].*/, '') ?? null
}

function rootLayoutChanged(incoming: Document) {
  const current = rootLayoutId(document)
  const next = rootLayoutId(incoming)
  // Import versions and cache-busting revisions describe the build that produced a document, not
  // a different root layout. The renderer's canonical id never needs either suffix in production.
  return current !== null && next !== null && current !== next
}

function isPNextDocument(doc: Document) {
  if (!doc.body) return false
  return Boolean(
    // `#__PNEXT_NAV_STATE__` is written on every route unconditionally, including
    // one with no client references at all - island and module-script markers
    // alone false-negative there, and every soft navigation TO it would hard-nav.
    doc.getElementById('__PNEXT_NAV_STATE__') ||
    doc.querySelector('[data-pnext-root], pnext-client, script[type="module"][src]') ||
    [...doc.scripts].some(script => script.text.includes('__PNEXT_ROUTE__')),
  )
}

/**
 * Group a node's children by the `<!--$ps:k-->` slot markers the renderer writes
 * around each slot of a slot-granular postponed boundary. Outside nodes ignored.
 */
function suspenseSlotGroups(root: ParentNode): Map<string, Node[]> {
  const groups = new Map<string, Node[]>()
  let current: Node[] | undefined
  for (const node of [...root.childNodes]) {
    if (node.nodeType === Node.COMMENT_NODE) {
      const data = (node as Comment).data
      const open = /^\$ps:(\d+)$/.exec(data)
      if (open) {
        current = []
        groups.set(open[1]!, current)
        continue
      }
      if (/^\/\$ps:\d+$/.test(data)) {
        current = undefined
        continue
      }
    }
    current?.push(node)
  }
  return groups
}

/**
 * Weave a slot-granular boundary back together: the fallback's `<template
 * data-pnext-static>` holds every slot's skeleton and says which slots are final;
 * the rest come from the streamed chunk. Null for an ordinary whole-boundary
 * chunk, which the caller grafts as before.
 */
function slotMergedContent(
  suspense: Element | null,
  chunk: ParentNode,
  chunkSlots: string | null,
  adopt: (node: Node) => Node,
): Node[] | null {
  if (!suspense || chunkSlots === null) return null
  const id = suspense.getAttribute('data-pnext-suspense') ?? ''
  const template = suspense.querySelector<HTMLTemplateElement>(
    `template[data-pnext-static="${CSS.escape(id)}"]`,
  )
  const count = Number(template?.getAttribute('data-pnext-slot-count'))
  if (!template || !Number.isFinite(count)) return null
  const isFinal = new Set((template.getAttribute('data-pnext-slots') ?? '').split(','))
  const staticSlots = suspenseSlotGroups(template.content)
  const dynamicSlots = suspenseSlotGroups(chunk)
  const merged: Node[] = []
  for (let index = 0; index < count; index++) {
    const key = String(index)
    const nodes = isFinal.has(key) ? staticSlots.get(key) : dynamicSlots.get(key)?.map(adopt)
    if (nodes) merged.push(...nodes)
  }
  return merged
}

function materializeStreamedSegments(doc: Document) {
  for (const chunk of doc.querySelectorAll<HTMLElement>(
    'div[hidden][data-pnext-stream], template[data-pnext-stream]',
  )) {
    const id = chunk.getAttribute('data-pnext-stream')
    const suspense = id
      ? doc.querySelector(`pnext-suspense[data-pnext-suspense="${CSS.escape(id)}"]`)
      : null
    const source: ParentNode = chunk instanceof HTMLTemplateElement ? chunk.content : chunk
    const merged = slotMergedContent(
      suspense,
      source,
      chunk.getAttribute('data-pnext-slots'),
      node => node,
    )
    if (merged && suspense) {
      suspense.replaceWith(...merged)
      chunk.remove()
      continue
    }
    let content: Node
    if (chunk instanceof HTMLTemplateElement) {
      content = chunk.content.cloneNode(true)
    } else {
      const fragment = doc.createDocumentFragment()
      while (chunk.firstChild) fragment.appendChild(chunk.firstChild)
      content = fragment
    }
    if (suspense) suspense.replaceWith(content)
    else chunk.replaceWith(content)
    chunk.remove()
  }
  materializeInlineIslands(doc)
}

// The in-place suspending path streams a boundary's resolved content as a hidden
// island to be grafted over the fallback. A live document does that itself via
// preact's `$RC` script; a soft navigation parses into a detached Document where
// no script runs, so the same graft has to happen here before the body swap.
function materializeInlineIslands(doc: Document) {
  const islands = [...doc.querySelectorAll<HTMLElement>('preact-island[data-target]')]
  if (islands.length === 0) return
  const markers = new Map<string, { start: Comment; end: Comment }>()
  const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_COMMENT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const comment = node as Comment
    const open = /^\$s:(.+)$/.exec(comment.data)
    if (open) markers.set(open[1]!, { start: comment, end: comment })
    const close = /^\/\$s:(.+)$/.exec(comment.data)
    const entry = close ? markers.get(close[1]!) : undefined
    if (entry) entry.end = comment
  }
  const holders = new Set<HTMLElement>()
  for (const island of islands) {
    const id = island.getAttribute('data-target')!
    if (island.parentElement) holders.add(island.parentElement)
    // Prefer the `<pnext-hole>` element (anchorInlineSuspenseHoles): it survives
    // an ancestor client layout's hydration where the comment markers do not.
    const hole = doc.querySelector<HTMLElement>(`pnext-hole[data-pnext-hole="${CSS.escape(id)}"]`)
    if (hole) {
      while (hole.firstChild) hole.removeChild(hole.firstChild)
      while (island.firstChild) hole.appendChild(island.firstChild)
      island.remove()
      continue
    }
    const marker = markers.get(id)
    if (!marker || marker.start === marker.end) continue
    // Drop the fallback, then move the streamed content in where it stood.
    for (let node = marker.end.previousSibling; node && node !== marker.start;) {
      const previous = node.previousSibling
      node.parentNode?.removeChild(node)
      node = previous
    }
    while (island.firstChild) marker.end.parentNode?.insertBefore(island.firstChild, marker.end)
    island.remove()
  }
  for (const holder of holders) {
    if (holder.hasAttribute('hidden') && holder.childNodes.length === 0) holder.remove()
  }
}

// swapBody drops the route's module entry script (the router mounts it itself), so
// a live document no longer carries it. The bfcache/entry-document snapshots are
// taken from the live DOM, so swapBody records the dropped src on <html> - without
// it a restored body would have no `entryScriptSrc` and mountRoute would not run.
const ENTRY_SCRIPT_ATTRIBUTE = 'data-pnext-entry'

function entryScriptSrc(doc: Document) {
  return (
    doc.body.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute('src') ??
    doc.documentElement.getAttribute(ENTRY_SCRIPT_ATTRIBUTE) ??
    undefined
  )
}

async function warmPageAssets(html: string) {
  if (typeof DOMParser === 'undefined') return
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const link of doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]')) {
    preloadStylesheet(link.getAttribute('href') ?? '')
  }
  warmEntryChunks(doc)
  const entrySrc = entryScriptSrc(doc)
  if (entrySrc) await importEntry(entrySrc)
}

// The destination entry's static chunks, kicked off before the entry itself is imported: without
// this the browser only discovers them after the entry parses, so every chunk the split put behind
// the entry costs another serial round trip on the navigation's critical path.
function warmEntryChunks(doc: Document) {
  for (const link of doc.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"][href]')) {
    preloadModule(link.getAttribute('href') ?? '')
  }
}

function preloadStylesheet(href: string) {
  if (!href || document.querySelector(`link[href="${CSS.escape(href)}"]`)) return
  const link = document.createElement('link')
  link.rel = 'preload'
  link.as = 'style'
  link.href = href
  document.head.append(link)
}

function preloadModule(href: string) {
  if (!href || document.querySelector(`link[href="${CSS.escape(href)}"]`)) return
  const link = document.createElement('link')
  link.rel = 'modulepreload'
  link.href = href
  document.head.append(link)
}

// Sheets this runtime appended that have not settled yet, keyed on absolute href. A paint
// that installs them and a later commit that awaits them are different calls, so the
// promise has to outlive the one that created the link.
const stylesheetLoads = new Map<string, [Promise<void>, () => void]>()

// Append the document's stylesheets SYNCHRONOUSLY and hand back the loads still in flight.
// Every path that puts the destination's content on screen goes through here: a paint that
// commits a navigation without its route's sheets shows unstyled content until the dynamic
// stage lands. Resolves on error too — a missing stylesheet should degrade styling, not
// wedge navigation.
function installStylesheets(doc: Document): Promise<void>[] {
  const pending: Promise<void>[] = []
  for (const link of doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]')) {
    const href = link.getAttribute('href')
    if (!href) continue
    const key = absoluteStylesheetHref(href)
    const installed = findStylesheet(href)
    if (installed) {
      // Already in the document — possibly installed by an earlier paint this
      // navigation, whose load the commit must still wait out.
      const inFlight = stylesheetLoads.get(key!)
      if (inFlight) {
        // A memory-cached/restored sheet can become usable without replaying `load`.
        // Its DOM-visible readiness is authoritative; release the earlier paint's waiter.
        // findStylesheet can return an SSR/body-streamed or island-owned same-href link,
        // so only settle the waiter recorded for the link this runtime created.
        if (installed.sheet) inFlight[1]()
        else pending.push(inFlight[0])
      }
      continue
    }
    const sheet = document.createElement('link')
    sheet.rel = 'stylesheet'
    sheet.href = href
    let settle!: () => void
    const load = new Promise<void>(resolve => {
      settle = () => {
        // The sheet can be pruned while its request is still in flight and then
        // reinstalled by a back navigation. Do not let the abandoned request
        // erase the newer request's promise from the dedup map.
        if (stylesheetLoads.get(key!)?.[0] === load) {
          stylesheetLoads.delete(key!)
        }
        resolve()
      }
    })
    sheet.onload = settle
    sheet.onerror = settle
    if (key) {
      stylesheetLoads.set(key, [load, settle])
    }
    document.head.append(sheet)
    pending.push(load)
  }
  return pending
}

function absoluteStylesheetHref(href: string) {
  try {
    return new URL(href, location.href).href
  } catch {
    return
  }
}

// Route stylesheets the new document does not use accumulate across navigations;
// drop them after the swap, once the new styles are applied. Only pnext-emitted
// sheets (same-origin under /assets/) are candidates: libraries inject their own
// at runtime and often track that injection in a once-only singleton, so removing
// theirs leaves the page permanently unstyled.
function pruneStylesheets(doc: Document) {
  const keep = new Set(
    [...doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]')].map(
      link => new URL(link.getAttribute('href') ?? '', location.href).href,
    ),
  )
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]')) {
    if (!pnextStylesheet(link.href)) continue
    if (!keep.has(link.href)) link.remove()
  }
}

// Built stylesheets answer to `/assets/` (core) and `/_next/static/` (next-compat, Next's own path).
const BUILT_SHEET = /^\/(?:assets|_next\/static)\//

function pnextStylesheet(href: string) {
  try {
    const url = new URL(href, location.href)
    return url.origin === location.origin && BUILT_SHEET.test(url.pathname)
  } catch {
    return false
  }
}

function findStylesheet(href: string) {
  const target = new URL(href, location.href).href
  return [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]')].find(
    link => link.href === target,
  )
}

function syncHeadMetadata(doc: Document) {
  const titleText =
    doc.head.querySelector('title')?.textContent ?? doc.body.querySelector('title')?.textContent
  doc.body.querySelector('title')?.remove()
  document.body.querySelector('title')?.remove()
  for (const node of [...document.head.childNodes]) {
    if (managedHeadNode(node)) node.remove()
  }
  for (const node of [...doc.head.childNodes]) {
    if (managedHeadNode(node)) document.head.append(document.importNode(node, true))
  }
  document.title = titleText ?? ''
}

function managedHeadNode(node: ChildNode) {
  if (node instanceof HTMLTitleElement) return true
  if (node instanceof HTMLMetaElement) return true
  if (!(node instanceof HTMLLinkElement)) return false
  const rel = node.rel.toLowerCase()
  return !['stylesheet', 'modulepreload', 'preload', 'preconnect', 'dns-prefetch'].includes(rel)
}

function materializeClientIslandMarkers(root: Document) {
  const comments: Comment[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT)
  const hasClientRuntime = Boolean(entryScriptSrc(root))
  while (walker.nextNode()) comments.push(walker.currentNode as Comment)
  for (const start of comments.reverse()) {
    const match = /^(pnext-client(?:-after)?|pnext-static-children|pnext-page):([^>]*)$/.exec(
      start.data,
    )
    const kind = match?.[1]
    const encoded = match?.[2]
    if (!kind || !encoded || !start.parentNode) continue
    if (kind === 'pnext-page' && !hasClientRuntime) {
      let end = start.nextSibling
      start.remove()
      while (end && !(end.nodeType === Node.COMMENT_NODE && end.nodeValue === '/pnext-page')) {
        end = end.nextSibling
      }
      end?.parentNode?.removeChild(end)
      continue
    }
    const container = document.createElement('div')
    const tag =
      kind === 'pnext-page' ? 'div' : kind === 'pnext-client-after' ? 'pnext-client' : kind
    container.innerHTML = `<${tag} ${encoded}></${tag}>`
    const island = container.firstElementChild
    if (!island) continue
    if (kind === 'pnext-client-after') {
      let anchor = start.previousSibling
      while (
        anchor &&
        !(anchor.nodeType === Node.COMMENT_NODE && !(anchor.nodeValue ?? '').trim())
      ) {
        anchor = anchor.previousSibling
      }
      if (!anchor) continue
      let node = anchor.nextSibling
      while (node && node !== start) {
        const next = node.nextSibling
        island.append(node)
        node = next
      }
      start.replaceWith(island)
      continue
    }
    const range = islandMarkerRange(start, `/${kind}`)
    if (!range) continue
    // The markers can end up in different parents (invalid nesting the parser
    // fixed up, e.g. a client `<p>` inside a server `<p>`). Anchor the host
    // where the CONTENT is in that case, not where the start marker landed.
    const first = range.nodes[0]
    if (first && first.parentNode !== start.parentNode) {
      first.parentNode!.insertBefore(island, first)
      start.remove()
    } else {
      start.replaceWith(island)
    }
    for (const node of range.nodes) island.append(node)
    range.end.remove()
  }
  stripTextSeparatorComments(root)
}

/**
 * Drop React's `<!-- -->` text separators from a COMMITTED navigation document.
 * Must run LAST: the `pnext-client-after` materializer uses a blank comment as its
 * anchor, so they are only inert once every marker above has been consumed.
 */
function stripTextSeparatorComments(root: Document) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT)
  const blanks: Comment[] = []
  while (walker.nextNode()) {
    const node = walker.currentNode as Comment
    if (node.data.trim() === '') blanks.push(node)
  }
  for (const node of blanks) node.remove()
}

/**
 * The nodes between an island's start marker and its matching end comment,
 * collected non-destructively. Climbs out of the start marker's parent so a parser
 * fix-up that split the markers across parents still resolves. Null when no end
 * marker is reachable - the caller then leaves the DOM untouched.
 */
function islandMarkerRange(start: Comment, endData: string) {
  const nodes: Node[] = []
  let cursor: Node = start
  for (;;) {
    let next = cursor.nextSibling
    while (!next) {
      const parent = cursor.parentNode
      if (!parent || parent.nodeName === 'HTML' || parent.nodeType === Node.DOCUMENT_NODE) {
        return null
      }
      cursor = parent
      next = cursor.nextSibling
    }
    if (next.nodeType === Node.COMMENT_NODE && next.nodeValue === endData) {
      return { nodes, end: next as Comment }
    }
    nodes.push(next)
    cursor = next
  }
}

const SEGMENT_PRESERVE_ATTRIBUTE = 'data-pnext-preserve-segment'

function isTopLevelServerSegment(segment: Element) {
  return segment.parentElement?.closest('pnext-layout[data-pnext-segment]') == null
}

function serverSegmentSignature(segment: Element) {
  return [segment, ...segment.querySelectorAll('pnext-layout[data-pnext-segment]')]
    .map(
      child =>
        `${child.getAttribute('data-pnext-segment') ?? ''}\u0001${child.getAttribute('data-pnext-scope') ?? ''}`,
    )
    .join('\u0000')
}

// Drop any segment-preserve tags left on a document by an earlier pass (the
// ungraftable dry run tags the same nodes). Every real pass re-tags from
// scratch, so stale indices never leak into the graft.
function clearSegmentPreserveTags(doc: Document) {
  for (const tagged of doc.body.querySelectorAll(`[${SEGMENT_PRESERVE_ATTRIBUTE}]`)) {
    tagged.removeAttribute(SEGMENT_PRESERVE_ATTRIBUTE)
  }
}

function matchPreservedServerSegments(doc: Document): Element[] {
  clearSegmentPreserveTags(doc)
  const liveBySignature = new Map<string, Element>()
  for (const segment of document.body.querySelectorAll('pnext-layout[data-pnext-segment]')) {
    if (!isTopLevelServerSegment(segment)) continue
    liveBySignature.set(serverSegmentSignature(segment), segment)
  }
  const preserved: Element[] = []
  for (const segment of doc.body.querySelectorAll('pnext-layout[data-pnext-segment]')) {
    if (!isTopLevelServerSegment(segment)) continue
    const live = liveBySignature.get(serverSegmentSignature(segment))
    if (!live) continue
    segment.setAttribute(SEGMENT_PRESERVE_ATTRIBUTE, String(preserved.length))
    preserved.push(live)
  }
  return preserved
}

function preservedSegmentIslands(segments: Element[]): LiveIslandRoot[] {
  const roots: LiveIslandRoot[] = []
  for (const segment of segments) {
    for (const root of segment.querySelectorAll('pnext-client[data-pnext-client]')) {
      const live = root as LiveIslandRoot
      if (!isTopLevelIslandRoot(root)) continue
      if (elementInPageSlot(root)) continue
      if (!live.__pnextLive) continue
      live.__pnextIncoming ??= live.cloneNode(true) as Element
      roots.push(live)
    }
  }
  return roots
}

function graftPreservedServerSegments(fragment: DocumentFragment, preserved: Element[]) {
  for (const placeholder of [...fragment.querySelectorAll(`[${SEGMENT_PRESERVE_ATTRIBUTE}]`)]) {
    const live = preserved[Number(placeholder.getAttribute(SEGMENT_PRESERVE_ATTRIBUTE))]
    placeholder.removeAttribute(SEGMENT_PRESERVE_ATTRIBUTE)
    if (!live) continue
    // MOVE (not clone) the incoming page slot: it already belongs to this
    // document, and cloning would turn an island root the island graft just
    // spliced in back into an inert copy, dropping its live preact tree. Moving
    // the slot itself also preserves whether this destination needs a mount
    // element or Next-flat comment anchors.
    if (!graftPageSlot(live, placeholder)) continue
    placeholder.replaceWith(live)
  }
}

const SEGMENT_SKIP_ATTRIBUTE = 'data-pnext-skip'

/**
 * True when the incoming document carries server-skipped shared-layout markers the
 * live document cannot graft over - the caller must refetch a full render.
 */
function skippedSegmentsUngraftable(doc: Document, refreshLike: boolean): boolean {
  const skipped = [...doc.body.querySelectorAll(`pnext-layout[${SEGMENT_SKIP_ATTRIBUTE}]`)]
  if (skipped.length === 0) return false
  if (refreshLike || navSlotsChanged(doc)) return true
  // Dry-run the segment match: it tags placeholders deterministically, so the
  // later real pass re-tags them identically.
  matchPreservedServerSegments(doc)
  return skipped.some(segment => !segment.closest(`pnext-layout[${SEGMENT_PRESERVE_ATTRIBUTE}]`))
}

// Shared-layout island preservation. An island root whose island renders again in
// the incoming document (matched by island id, in document order) keeps its live
// DOM across the body swap, so state and handlers survive. mount() stamps live
// roots with its render function (__pnextLive); the next entry re-renders a
// grafted root in place with the incoming props (__pnextIncoming).

const PRESERVE_ATTRIBUTE = 'data-pnext-preserve'

/** Per-island params scope stamped by a parallel-route slot (see render/slots). */
const ISLAND_PARAMS_ATTRIBUTE = 'data-pnext-params'

export interface LiveIslandRoot extends Element {
  /** The mounting entry's Preact render function while the root is live. */
  __pnextLive?: unknown
  /** Incoming placeholder (fresh SSR children) stashed for the next mount. */
  __pnextIncoming?: Element
  /** In-flight mount claim (mountIslandOnce) — a second pass awaits it. */
  __pnextMounting?: unknown
}

// Nested island roots belong to their parent island's tree; only top-level
// roots are independently mounted (and thus independently preservable).
function isTopLevelIslandRoot(root: Element) {
  return root.parentElement?.closest('pnext-client') == null
}

// The rendered source path of a document's children slot (from its embedded
// nav-state script), used to decide template remounts across a swap.
function docNavStateChildren(doc: Document, fallback: string): string {
  const text = doc.getElementById?.('__PNEXT_NAV_STATE__')?.textContent
  if (text) {
    try {
      const parsed = JSON.parse(text) as DocumentNavState
      if (parsed.children) return parsed.children
    } catch {
      // Malformed state — fall back to the navigation target.
    }
  }
  return fallback
}

// The per-slot source paths a document's embedded nav state records.
function docNavStateSlots(doc: Document): Record<string, string> {
  const text = doc.getElementById?.('__PNEXT_NAV_STATE__')?.textContent
  if (text) {
    try {
      const parsed = JSON.parse(text) as DocumentNavState
      if (parsed.slots) return parsed.slots
    } catch {
      // Malformed state — treat as empty slot state.
    }
  }
  return {}
}

export function slotsStateKey(slots: Record<string, string>): string {
  return JSON.stringify(
    Object.keys(slots)
      .sort()
      .map(key => [key, slots[key]]),
  )
}

// Whether the incoming document resolved its parallel-route slots differently
// than the live document (a slot navigated, opened, or reset to default).
function navSlotsChanged(doc: Document): boolean {
  return slotsStateKey(docNavStateSlots(doc)) !== slotsStateKey(currentNavState().slots ?? {})
}

// A client template island host (stamped by the renderer). Never preserved
// across a path navigation: Next mounts a fresh template instance per
// navigation of the segment it wraps.
function isTemplateIsland(root: Element): boolean {
  return root.hasAttribute('data-pnext-template')
}

// Pair each live island root with an incoming placeholder for the same island
// and tag the placeholder with its index. The attribute survives importNode,
// so graftPreservedIslands can find the placeholders inside the built fragment.
function matchPreservedIslands(
  doc: Document,
  remountTemplates: boolean,
  remountPageIslands = false,
): LiveIslandRoot[] {
  const liveById = new Map<string, LiveIslandRoot[]>()
  for (const root of document.body.querySelectorAll('pnext-client[data-pnext-client]')) {
    if (!isTopLevelIslandRoot(root)) continue
    if (!(root as LiveIslandRoot).__pnextLive) continue
    if (remountTemplates && isTemplateIsland(root)) continue
    if (remountPageIslands && elementInPageSlot(root)) continue
    const id = root.getAttribute('data-pnext-client') ?? ''
    const queue = liveById.get(id)
    if (queue) queue.push(root)
    else liveById.set(id, [root])
  }
  if (liveById.size === 0) return []
  const preserved: LiveIslandRoot[] = []
  for (const placeholder of doc.body.querySelectorAll('pnext-client[data-pnext-client]')) {
    if (!isTopLevelIslandRoot(placeholder)) continue
    if (remountTemplates && isTemplateIsland(placeholder)) continue
    if (remountPageIslands && elementInPageSlot(placeholder)) continue
    // Inside a preserved server segment the LAYOUT-level islands travel with the
    // live segment DOM that graftPreservedServerSegments splices in, so the island
    // graft (which runs first) must not move them out of it. Page-slot islands
    // still preserve: their placeholders move into the live page slot.
    const preservedSegment = placeholder.closest(`[${SEGMENT_PRESERVE_ATTRIBUTE}]`)
    if (preservedSegment && !elementInPageSlot(placeholder)) continue
    const live = liveById.get(placeholder.getAttribute('data-pnext-client') ?? '')?.shift()
    if (!live) continue
    // An island carrying its own params scope (a parallel-route slot stamps its
    // dynamic/catch-all captures onto every island below it) must MOUNT FRESH
    // when that scope changed: preserving the live root would keep the previous
    // URL's params in useParams even though the slot re-rendered server-side
    // (parallel-route-navigations / parallel-routes-breadcrumbs). Islands with
    // no params scope compare equal (both null) and preserve as before.
    if (
      live.getAttribute(ISLAND_PARAMS_ATTRIBUTE) !==
      placeholder.getAttribute(ISLAND_PARAMS_ATTRIBUTE)
    )
      continue
    placeholder.setAttribute(PRESERVE_ATTRIBUTE, String(preserved.length))
    preserved.push(live)
  }
  return preserved
}

const PAGE_PRESERVE_ATTRIBUTE = 'data-pnext-preserve-page'

export interface PreservedClientPage {
  root: ClientPageRoot
  nodes: Node[]
}

/**
 * A whole-page `'use client'` route has no `pnext-client` host to preserve - it mounts
 * straight onto the page slot - so a refresh would remount it and reset its component state
 * (a `useActionState` result must survive the refresh a revalidatePath triggers). Keep the
 * live page DOM instead: tag the incoming page slot so swapBody grafts the live nodes back
 * in, and hand the mount container to the entry's unmount as a kept root. Only for a refresh
 * of the SAME route, or a query-only nav that stays on it; a nav to a DIFFERENT route
 * renders a different page and must mount fresh.
 */
function matchPreservedClientPage(
  doc: Document,
  preserve: boolean,
  remountPage: boolean,
): PreservedClientPage | null {
  if (!preserve || remountPage) return null
  const root = window.__PNEXT_CLIENT_PAGE_ROOT__
  const incoming = doc.getElementById('pnext-page')
  if (!root || !incoming) return null
  const anchors = root.__pnextAnchors
  let nodes: Node[]
  if (anchors) {
    const [open, close] = anchors
    if (!open.isConnected || !close.isConnected || open.parentNode !== close.parentNode) return null
    nodes = [open]
    for (let node = open.nextSibling; node && node !== close; node = node.nextSibling) {
      nodes.push(node)
    }
    nodes.push(close)
  } else {
    if (!(root instanceof Element) || !root.isConnected) return null
    nodes = [root]
  }
  incoming.setAttribute(PAGE_PRESERVE_ATTRIBUTE, '')
  return { root, nodes }
}

// When a client layout adopts the page slot, its marker range disappears from the LIVE DOM and the
// page's client components become ordinary children inside a preserved provider island. Give those
// components a route-entry key on the incoming adoption source: Preact then unmounts only the page
// subtree while PageTransition, providers, and layout ancestors stay mounted.
// `key` is consumed by createElement and is not exposed as an application prop.
function keySlotlessClientPage(doc: Document, key: string) {
  const slot = pageSlotRange(doc.body)
  if (!slot) return
  const roots: Element[] = []
  for (const node of slot[2]) {
    if (!(node instanceof Element)) continue
    if (node.matches('pnext-client[data-pnext-client]')) roots.push(node)
    roots.push(...node.querySelectorAll('pnext-client[data-pnext-client]'))
  }
  for (const [index, root] of roots.entries()) {
    try {
      const props = JSON.parse(root.getAttribute('data-pnext-props') ?? '{}') as Record<
        string,
        unknown
      >
      props.key = `pnext-page:${key}:${index}`
      root.setAttribute('data-pnext-props', JSON.stringify(props))
    } catch {
      // Invalid island props will be diagnosed by the entry mount; navigation must still commit.
    }
  }
}

function hasSlotlessClientRootLayout(doc: Document, preserved: LiveIslandRoot[]) {
  if (pageSlotRange(document.body) !== null || preserved.length === 0) return false
  return preserved.some((root, index) => {
    // After adoption, a client root layout is itself a direct body child. Its incoming clone may
    // expose the page marker through serialized children, but older/generated entries can keep the
    // route-screen roots beside it instead, so the direct-body topology is the durable signal.
    if (root.parentElement === document.body) return true
    const placeholder = doc.querySelector<LiveIslandRoot>(`[${PRESERVE_ATTRIBUTE}="${index}"]`)
    return placeholder !== null && pageSlotRange(placeholder) !== null
  })
}

async function flushClientEffects() {
  if (window.requestAnimationFrame) {
    await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()))
  } else {
    await Promise.resolve()
  }
}

// A slotless live tree cannot be partially unmounted through a DOM container: the page lives as
// adopted children of a preserved provider root. Re-render that root once with the incoming page
// marker emptied while it is still in the old body. The temporary departure URL keeps pathname-keyed
// layout effects stable; after Preact flushes the outgoing page's cleanup, the real target render can
// mount its page fresh against the already-fired popstate flag.
async function unmountSlotlessClientPage(
  doc: Document,
  preserved: LiveIslandRoot[],
  entry: EntryModule | null | undefined,
  departingRouteKey: string,
): Promise<boolean> {
  if (!entry?.mountRoute || preserved.length === 0) return false
  let staged = false
  for (let index = 0; index < preserved.length; index++) {
    const placeholder = doc.querySelector<LiveIslandRoot>(`[${PRESERVE_ATTRIBUTE}="${index}"]`)
    if (!placeholder) continue
    const source = placeholder.cloneNode(true) as LiveIslandRoot
    const slot = pageSlotRange(source)
    if (!slot) continue
    for (const node of slot[2]) node.remove()
    if (slot[0] instanceof Element) slot[0].replaceChildren()
    else slot[0].remove()
    slot[1]?.remove()
    preserved[index]!.__pnextIncoming = source
    staged = true
  }
  if (!staged) return false

  const targetState: unknown = history.state
  const targetHref = location.href
  const departureHref = new URL(departingRouteKey, location.origin).href
  withSilentLocationChange(() => history.replaceState(targetState, '', departureHref))
  try {
    await entry.mountRoute()
    await flushClientEffects()
  } finally {
    withSilentLocationChange(() => history.replaceState(targetState, '', targetHref))
  }
  return true
}

// A query-only nav that stays on the SAME route renders the same whole-page `'use client'`
// root, so its live DOM must be preserved exactly like a refresh - otherwise the page
// REMOUNTS and a queued action's `setState` closure updates an orphaned component. The
// incoming page segment must equal the live one, with no root-layout change.
function sameRouteQueryNav(doc: Document): boolean {
  const incoming = documentRouteState(doc)?.route
  const live = documentRouteState(document)?.route
  return incoming !== undefined && incoming === live && !rootLayoutChanged(doc)
}

function swapBody(
  doc: Document,
  preserved: LiveIslandRoot[] = [],
  segments: Element[] = [],
  preservedPage: PreservedClientPage | null = null,
  reusable = reusableBodyChildren(),
) {
  const paintHold = document.querySelector<HTMLElement>('[data-pnext-navigation-paint-hold]')
  const fragment = document.createDocumentFragment()
  // The incoming document's entry src, remembered on <html> below so a snapshot
  // of the swapped (script-less) live DOM can still name its entry.
  let entrySrc: string | null = null
  for (const node of [...doc.body.childNodes]) {
    if (node instanceof HTMLScriptElement) {
      // The module entry is imported and mounted by the router, and the dev
      // reload script already holds an open event stream in this document.
      if (node.type === 'module' && node.src) {
        entrySrc ??= node.getAttribute('src')
        continue
      }
      if (node.hasAttribute('data-pnext-dev')) continue
      // Parser-created scripts are inert; rebuild them so props, route
      // state, and streamed-chunk patches execute in document order when the
      // fragment lands in the live document.
      const script = document.createElement('script')
      for (const attribute of node.attributes) script.setAttribute(attribute.name, attribute.value)
      script.text = node.text
      fragment.append(script)
      continue
    }
    const live = takeReusableBodyChild(reusable, node)
    fragment.append(live ?? document.importNode(node, true))
  }
  const connected =
    preserved.length > 0
      ? graftPreservedIslands(fragment, preserved)
      : new Map<Node, LiveIslandRoot>()
  if (segments.length > 0) graftPreservedServerSegments(fragment, segments)
  if (preservedPage) {
    const placeholder = fragment.querySelector(`[${PAGE_PRESERVE_ATTRIBUTE}]`)
    // Moving the live nodes keeps their identity, so the page's still-mounted
    // preact tree (and its state) carries straight into the new body.
    if (placeholder) placeholder.replaceWith(...preservedPage.nodes)
  }
  if (connected.size === 0) {
    document.body.replaceChildren(fragment)
  } else {
    // Reconcile around direct-body layout roots without ever disconnecting them.
    let cursor = document.body.firstChild
    for (const desired of [...fragment.childNodes]) {
      const node = connected.get(desired) ?? desired
      if (node === cursor) cursor = cursor.nextSibling
      else document.body.insertBefore(node, cursor)
    }
    while (cursor) {
      const next = cursor.nextSibling
      cursor.remove()
      cursor = next
    }
  }
  if (paintHold) document.body.append(paintHold)
  // Track the entry of what is now on screen (dropped when the incoming route
  // has none, so a stale entry is never attributed to it).
  if (entrySrc) document.documentElement.setAttribute(ENTRY_SCRIPT_ATTRIBUTE, entrySrc)
  else document.documentElement.removeAttribute(ENTRY_SCRIPT_ATTRIBUTE)
}

/** Keep the last complete screen painted while client roots mount into the committed document. */
type NavigationPaintHold = HTMLElement & {
  __pnextObserver?: MutationObserver
}

function removeNavigationPaintHold(hold: NavigationPaintHold) {
  hold.__pnextObserver?.disconnect()
  hold.remove()
}

function createNavigationPaintHold(): NavigationPaintHold | null {
  // A newer navigation may start before the prior hold's settling frame. Retire
  // that transaction synchronously so holds never nest (the older async release
  // becomes a no-op).
  const priorHold = document.querySelector<NavigationPaintHold>(
    '[data-pnext-navigation-paint-hold]',
  )
  if (priorHold) removeNavigationPaintHold(priorHold)
  const roots = [...document.body.children].filter(
    element =>
      !element.hasAttribute('data-pnext-navigation-paint-hold') &&
      !/^(SCRIPT|STYLE|LINK|TEMPLATE)$/.test(element.tagName) &&
      element.textContent?.trim(),
  )
  if (roots.length === 0) return null
  const hold = document.createElement('div')
  hold.setAttribute('data-pnext-navigation-paint-hold', '')
  hold.setAttribute('aria-hidden', 'true')
  hold.style.cssText =
    'position:fixed;inset:0;z-index:2147483646;overflow:hidden;pointer-events:none;background:Canvas;visibility:visible!important'
  hold.append(...roots.map(root => root.cloneNode(true)))
  // The copy is paint-only: route mount scans and id lookups must never treat it as live UI.
  for (const node of hold.querySelectorAll('[data-pnext-client]'))
    node.removeAttribute('data-pnext-client')
  for (const node of hold.querySelectorAll('[id]')) node.removeAttribute('id')
  // Cloned media are NEW elements: an `autoplay` attribute replays them on insertion, and
  // cloneNode copies attributes but not the live `muted` property - a video muted only via
  // property starts AUDIBLE in the copy. Freeze every clone on its current frame instead.
  for (const media of hold.querySelectorAll<HTMLMediaElement>('video,audio')) {
    media.removeAttribute('autoplay')
    media.muted = true
    media.setAttribute('muted', '')
    media.preload = 'none'
    media.removeAttribute('src')
    for (const source of media.querySelectorAll('source')) source.remove()
  }
  // A cloned iframe re-loads (and can re-play) its document; the paint copy needs only the box.
  for (const frame of hold.querySelectorAll('iframe')) frame.removeAttribute('src')
  return hold
}

function attachNavigationPaintHold(
  hold: NavigationPaintHold | null,
  scrollTop: number,
  sequence: number,
) {
  if (!hold || sequence !== navigationSequence) return
  // The opaque fixed clone covers the viewport while the committed tree mounts.
  // Keep that live tree visible to focus management and selector observers;
  // hiding <body> also hides every real destination element from browser gates.
  document.body.append(hold)
  hold.__pnextObserver ??= new MutationObserver(() => {
    if (sequence !== navigationSequence) {
      return removeNavigationPaintHold(hold)
    }
    if (!hold.isConnected) document.body.append(hold)
  })
  hold.__pnextObserver.observe(document.documentElement, { childList: true, subtree: true })
  const scrollRoot = hold.querySelector<HTMLElement>('[data-scroll-root]')
  if (scrollRoot) scrollRoot.scrollTop = scrollTop
}

async function releaseNavigationPaintHold(hold: NavigationPaintHold | null) {
  if (!hold) return
  // mountRoute, client effects and the navigation commit have completed before
  // this runs. Keep the departing frame through the next rendering opportunity,
  // then reveal the committed tree; content length is not a readiness signal.
  if (window.requestAnimationFrame) {
    await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()))
  }
  removeNavigationPaintHold(hold)
}

/**
 * Give focus back to the element that had it before the body swap: reattaching a
 * node blurs it, so a retained layout element would silently drop focus to <body>.
 * Focus the new tree already claimed (autofocus, segment focus) stands.
 */
function restoreSwapFocus(
  focused: Element | null,
  navigationTarget: HTMLElement | null = null,
): void {
  // Next applies scroll/focus after the changed segment has committed. pnext
  // resolves that segment before a client root can dissolve its page markers,
  // so remember the element the scroll action focused and reaffirm it after
  // client reconciliation. This is intentionally ahead of restoring retained
  // layout focus: an interactive/scrollable destination segment wins over the
  // link that initiated the navigation.
  if (navigationTarget?.isConnected) {
    try {
      navigationTarget.focus({ preventScroll: true })
    } catch {
      // Focus is best-effort; continue with retained-layout focus below.
    }
    if (document.activeElement === navigationTarget) return
  }
  if (!(focused instanceof HTMLElement) || focused === document.body) return
  if (!focused.isConnected) return
  if (document.activeElement !== null && document.activeElement !== document.body) return
  try {
    focused.focus({ preventScroll: true })
  } catch {
    // Focus is best-effort; a detached or non-focusable node just stays blurred.
  }
}

// Root-layout DOM identity across a soft navigation. The ROOT layout renders
// straight into <body> with no segment wrapper to match on, so a body child that is
// the SAME element in both documents keeps its live node: byte-identical markup
// as-is, otherwise reconciled in place (attributes synced, children replaced,
// recursing). Only plain server DOM is eligible - islands, segments and the page
// slot keep their own preservation paths, so the reconcile never races those.

// Body children that may be kept: no scripts (they must re-run in the new
// document) and nothing the island/segment/page grafts need to target.
function isReusableBodyChild(node: Node): node is Element {
  if (!(node instanceof Element)) return false
  if (node.tagName === 'SCRIPT') return false
  if (node.matches('pnext-client, pnext-layout, #pnext-page')) return false
  return (
    node.querySelector(
      `pnext-client, pnext-layout, #pnext-page, [${PRESERVE_ATTRIBUTE}], [${SEGMENT_PRESERVE_ATTRIBUTE}]`,
    ) == null
  )
}

function reusableBodyChildren(): Element[] {
  // Once the entry has mounted, a client page dissolves `#pnext-page` into comment
  // anchors, so its elements sit directly in <body>. They belong to the departing
  // render and must not be mistaken for root-layout DOM - skip the anchored range.
  return [...document.body.children].filter(
    node => !elementInPageSlot(node) && isReusableBodyChild(node),
  )
}

// Match an incoming body child to a still-available live one and hand back the
// live node so it keeps its identity across the swap. Consumes the match from
// `candidates` so no live node is claimed twice.
function takeReusableBodyChild(candidates: Element[], node: Node): Element | null {
  if (candidates.length === 0 || !isReusableBodyChild(node)) return null
  // Byte-identical subtree: same render, keep the live node untouched.
  const exact = candidates.findIndex(candidate => candidate.outerHTML === node.outerHTML)
  if (exact !== -1) return candidates.splice(exact, 1)[0]!
  // Same element, changed content: match by id, else by tag position. Keep the
  // live node and reconcile its attributes/children to the incoming markup so
  // only node identity (held handles, focus, scroll anchor) is preserved.
  const match = matchReconcilable(candidates, node)
  if (match === -1) return null
  const live = candidates.splice(match, 1)[0]!
  reconcileElement(live, node)
  return live
}

// Index in `pool` of a live element that is the same one as `incoming`: a
// tag+id match when `incoming` is keyed, otherwise the first same-tag unkeyed
// element (position). Returns -1 when nothing lines up (import a fresh copy).
function matchReconcilable(pool: readonly Element[], incoming: Element): number {
  if (incoming.id) {
    return pool.findIndex(
      candidate => candidate.tagName === incoming.tagName && candidate.id === incoming.id,
    )
  }
  return pool.findIndex(candidate => candidate.tagName === incoming.tagName && !candidate.id)
}

// Make `live` structurally equal to `incoming` while keeping `live`'s node identity.
// Only ever runs inside a reusable body child, so the subtree is plain server DOM
// with no islands/segments/page slot to disturb.
function reconcileElement(live: Element, incoming: Element): void {
  for (const attribute of [...live.attributes]) {
    if (!incoming.hasAttribute(attribute.name)) live.removeAttribute(attribute.name)
  }
  for (const attribute of incoming.attributes) {
    if (live.getAttribute(attribute.name) !== attribute.value) {
      live.setAttribute(attribute.name, attribute.value)
    }
  }
  reconcileChildren(live, incoming)
}

// Rebuild `live`'s child list to mirror `incoming`, reusing live element
// children that are the same one (tag+id, else tag position) and importing
// everything else (text, comments, unmatched elements) fresh from `incoming`.
function reconcileChildren(live: Element, incoming: Element): void {
  const keyed = new Map<string, Element>()
  const positional = new Map<string, Element[]>()
  for (const child of live.children) {
    if (child.id) {
      keyed.set(`${child.tagName}\0${child.id}`, child)
    } else {
      const bucket = positional.get(child.tagName)
      if (bucket) bucket.push(child)
      else positional.set(child.tagName, [child])
    }
  }
  const used = new Set<Element>()
  const next: Node[] = []
  for (const node of [...incoming.childNodes]) {
    if (!(node instanceof Element)) {
      next.push(document.importNode(node, true))
      continue
    }
    let reuse: Element | undefined
    if (node.id) {
      const candidate = keyed.get(`${node.tagName}\0${node.id}`)
      if (candidate && !used.has(candidate)) reuse = candidate
    }
    if (!reuse) {
      const bucket = positional.get(node.tagName)
      while (bucket && bucket.length > 0) {
        const candidate = bucket.shift()!
        if (!used.has(candidate)) {
          reuse = candidate
          break
        }
      }
    }
    if (reuse) {
      used.add(reuse)
      reconcileElement(reuse, node)
      next.push(reuse)
    } else {
      next.push(document.importNode(node, true))
    }
  }
  live.replaceChildren(...next)
}

// Cache clock and epoch. Only the navigation runtime reads these, so they sit
// apart from ./state (which the first-paint hub pulls in for routerState).

// Bumped by evictClientRouterCache(). A prefetch that STARTED before an eviction
// carries pre-invalidation data and must be dropped when it settles, not written
// back into the just-cleared caches.
const ROUTER_CACHE_EPOCH = Symbol.for('pnext.clientRouterCacheEpoch')

function routerCacheEpoch(): number {
  const value = (globalThis as Record<PropertyKey, unknown>)[ROUTER_CACHE_EPOCH]
  return typeof value === 'number' ? value : 0
}

function bumpRouterCacheEpoch(): void {
  const holder = globalThis as Record<PropertyKey, unknown>
  // Avoid colliding with an invalidated `_rsc` URL from an earlier document.
  holder[ROUTER_CACHE_EPOCH] = Math.max(routerCacheEpoch() + 1, Date.now() + Math.random())
}

// Client-cache staleness is measured against the wall clock, not performance.now():
// Next times its router cache with Date.now(), and the app-client-cache suites
// travel time by mocking `Date`.
function clientClockNow(): number {
  return Date.now()
}

// CACHES. Back/forward cache: history entry ids, the stashed live island roots and
// the document snapshots a traversal restores without a round trip.

/**
 * The canonical bfcache key for a route: pathname + search. Next distinguishes
 * entries by search params, so `/p?a` and `/p?b` are independent slots.
 */
export function bfRouteKey(pathname: string, search: string): string {
  return pathname + search
}

export {
  HISTORY_BFCACHE_ID_KEY,
  historyBfcacheId,
  historyState,
  newBfcacheId,
  newEntryId,
} from './history'

/**
 * The bfcache id for the entry a navigation is about to open. A path-changing push
 * mints a new id so every `key={bfcacheId}` subtree remounts (Next's leaf-form reset
 * semantics); a same-pathname navigation keeps the current id so that state survives.
 *
 * `departingPathname` must be the pathname the navigation STARTED from: reading
 * `location` is wrong once an optimistic shell paint has pushed the destination URL,
 * and every push would then look same-pathname and never remount.
 */
function nextBfcacheIdForNavigation(target: URL, departingPathname = location.pathname): string {
  if (target.pathname === departingPathname) {
    return historyBfcacheId() ?? newBfcacheId()
  }
  return newBfcacheId()
}

// Restore the target route's stashed live island roots: graft each over the matching
// incoming placeholder so its React state carries across the swap. Stashed roots
// with no matching placeholder are disposed.
function matchRouteCachedIslands(
  doc: Document,
  routeKey: string,
  indexOffset: number,
  remountTemplates: boolean,
): LiveIslandRoot[] {
  const cached = bfRouteRootCache.get(routeKey)
  if (!cached?.length) return []
  bfRouteRootCache.delete(routeKey)

  const liveById = new Map<string, LiveIslandRoot[]>()
  for (const root of cached) {
    if (remountTemplates && isTemplateIsland(root)) continue
    const id = root.getAttribute('data-pnext-client') ?? ''
    const queue = liveById.get(id)
    if (queue) queue.push(root)
    else liveById.set(id, [root])
  }

  const restored: LiveIslandRoot[] = []
  for (const placeholder of doc.body.querySelectorAll('pnext-client[data-pnext-client]')) {
    if (!isTopLevelIslandRoot(placeholder)) continue
    if (placeholder.hasAttribute(PRESERVE_ATTRIBUTE)) continue
    if (remountTemplates && isTemplateIsland(placeholder)) continue
    const live = liveById.get(placeholder.getAttribute('data-pnext-client') ?? '')?.shift()
    if (!live) continue
    placeholder.setAttribute(PRESERVE_ATTRIBUTE, String(indexOffset + restored.length))
    restored.push(live)
  }
  // Any cached root that found no placeholder in the new document is orphaned:
  // dispose it (unmount) rather than leaking it detached-but-live.
  const restoredSet = new Set(restored)
  for (const root of cached) if (!restoredSet.has(root)) disposeCachedRoot(root)
  return restored
}

// All top-level, live, non-kept island roots in the document. Snapshotted at the
// START of a navigation - before a cached/streamed loading shell can paint over and
// detach the departing page's islands - so the caller can stash them by route.
function collectTopLevelLiveRoots(): LiveIslandRoot[] {
  const roots: LiveIslandRoot[] = []
  for (const root of document.body.querySelectorAll('pnext-client[data-pnext-client]')) {
    const liveRoot = root as LiveIslandRoot
    if (!isTopLevelIslandRoot(root)) continue
    if (!liveRoot.__pnextLive) continue
    roots.push(liveRoot)
  }
  return roots
}

// Stash a route's live island roots for later back/forward restore, refreshing
// recency (Map insertion order = LRU). Over the cap, the oldest route's roots
// are evicted and disposed (Next's bfcache keeps a fixed number of entries).
function stashRouteRoots(routeKey: string, roots: LiveIslandRoot[]) {
  bfRouteRootCache.delete(routeKey)
  if (roots.length === 0) return
  bfRouteRootCache.set(routeKey, roots)
  while (bfRouteRootCache.size > BF_ROUTE_ROOT_CACHE_LIMIT) {
    const oldest = bfRouteRootCache.keys().next().value
    if (oldest === undefined) break
    const evicted = bfRouteRootCache.get(oldest) ?? []
    bfRouteRootCache.delete(oldest)
    for (const root of evicted) disposeCachedRoot(root)
  }
}

function disposeCachedRoot(root: LiveIslandRoot) {
  if (root.isConnected) return
  const render = root.__pnextLive
  if (typeof render !== 'function') return
  try {
    ;(render as (vnode: unknown, parent: Element) => void)(null, root)
  } catch {
    // Detached cache eviction is best-effort; a failed disposal must not break navigation.
  }
  root.__pnextLive = undefined
}

// Graft each preserved live root over its tagged placeholder: the placeholder's
// fresh island props move onto the live element, and the detached placeholder (fresh
// SSR children) is stashed for the entry's mountRoute to re-render in place.
function graftPreservedIslands(fragment: DocumentFragment, preserved: LiveIslandRoot[]) {
  const connected = new Map<Node, LiveIslandRoot>()
  for (const placeholder of [...fragment.querySelectorAll(`[${PRESERVE_ATTRIBUTE}]`)]) {
    const live = preserved[Number(placeholder.getAttribute(PRESERVE_ATTRIBUTE))]
    placeholder.removeAttribute(PRESERVE_ATTRIBUTE)
    if (!live) continue
    for (const name of live.getAttributeNames()) {
      if (!placeholder.hasAttribute(name)) live.removeAttribute(name)
    }
    for (const attribute of placeholder.attributes) {
      live.setAttribute(attribute.name, attribute.value)
    }
    live.__pnextIncoming = placeholder
    if (live.parentNode === document.body && placeholder.parentNode === fragment) {
      const marker = document.createComment('pnext-preserved-root')
      placeholder.replaceWith(marker)
      connected.set(marker, live)
    } else {
      placeholder.replaceWith(live)
    }
  }
  return connected
}

function isDevDocument() {
  return Boolean(document.querySelector('script[data-pnext-dev]'))
}

// `replace` is also set for history TRAVERSALS (options.pop): assign() would
// push a new entry over the popped one and truncate the forward stack, so a
// bailout during back/forward must replace the current entry instead.
function hardNavigate(href: string, replace?: boolean) {
  if (replace) location.replace(href)
  else location.assign(href)
}

function saveScrollPosition() {
  try {
    // The bfcache document is recorded when the route commits (and when a hard load settles).
    // Do not overwrite it from entryDocCache here: a streamed hard load intentionally keeps its
    // immutable pre-runtime source for history restoration, which can be only the loading shell.
    // Refiling that source on departure would downgrade the complete settled bfcache document and
    // make a full-prefetch Link back to the route commit a permanently suspended shell.
    // The scrollable height rides along so a pop restore into a still-short swapped body can
    // reserve it — the browser clamps scrollTo against the live height, silently losing the
    // position when the restored content mounts a beat after the swap.
    history.replaceState(
      {
        ...historyState(),
        __pnextScroll: [window.scrollX, window.scrollY, document.documentElement.scrollHeight],
      },
      '',
      location.href,
    )
  } catch {
    // History can throw on rapid updates; losing one scroll position is fine.
  }
}

function storeNavState() {
  try {
    history.replaceState(
      { ...historyState(), __pnextNavState: currentNavState() },
      '',
      location.href,
    )
  } catch {
    // Losing one entry's slot state degrades back/forward to default content.
  }
}

// Documents shown per history entry, restored on popstate without a fetch
// (Next's router cache behaves the same way). Keyed by a random id in
// history.state so the mapping survives navigation but not hard reloads.
const entryDocCache = new Map<string, PrefetchedPage>()
const ENTRY_DOC_CACHE_LIMIT = 12

// Back/forward document cache, keyed by ROUTE (pathname+search). Every shown
// document lands here, and a `prefetch={true}` full prefetch reads it before issuing
// any request. Only complete documents are kept (no shell-only/skip-marker
// responses), bounded by the static window.
export interface BfDocEntry {
  time: number
  page: PrefetchedPage
}
const bfDocCache = new Map<string, BfDocEntry>()
const BF_DOC_CACHE_LIMIT = 8

function storeBfDoc(
  key: string,
  page: PrefetchedPage,
  options: { preserveTime?: boolean } = {},
): void {
  // Shell-only, skip-marker and interception-host responses are each bound to the
  // context they rendered against, so none can serve a later origin-agnostic full
  // prefetch - the bfDoc-seeded entry therefore stays safely `originAgnostic`.
  if (
    !page.ok ||
    page.shellOnly === true ||
    page.html.includes(SKIP_MARKER) ||
    pageIsHostRender(page)
  ) {
    return
  }
  // Freshness dates from when the document was COMMITTED, not from each departure: a
  // departure snapshot updates the captured DOM but must keep the original time, or a
  // long-stale document would look freshly cached to a forward navigation.
  const priorTime = options.preserveTime ? bfDocCache.get(key)?.time : undefined
  bfDocCache.delete(key)
  bfDocCache.set(key, { time: priorTime ?? clientClockNow(), page })
  while (bfDocCache.size > BF_DOC_CACHE_LIMIT) {
    const oldest = bfDocCache.keys().next().value
    if (oldest === undefined) break
    bfDocCache.delete(oldest)
  }
}

function takeBfDoc(key: string): BfDocEntry | null {
  const entry = bfDocCache.get(key)
  if (!entry) return null
  // forceStale semantics: the shown document counts as fresh for the STATIC
  // window; beyond it the full prefetch goes back to the network.
  if (clientClockNow() - entry.time >= shellStaleTimeMs()) {
    bfDocCache.delete(key)
    return null
  }
  touchCacheEntry(bfDocCache, key, entry)
  return entry
}

// Per-URL STATIC freshness: the last prefetch response's staleTime for this URL.
// Written only by prefetch responses - navigation responses never shorten it, so a
// re-revealed link keeps the static window even after a shorter dynamic one.
const urlStaticFreshUntil = new Map<string, number>()
const URL_STATIC_FRESH_LIMIT = 64

function markUrlStaticFresh(key: string, staleTimeMs: number): void {
  if (staleTimeMs <= 0) return
  urlStaticFreshUntil.delete(key)
  urlStaticFreshUntil.set(key, clientClockNow() + staleTimeMs)
  while (urlStaticFreshUntil.size > URL_STATIC_FRESH_LIMIT) {
    const oldest = urlStaticFreshUntil.keys().next().value
    if (oldest === undefined) break
    urlStaticFreshUntil.delete(oldest)
  }
}

function urlStaticFresh(key: string): boolean {
  return urlStaticFreshState(key) === 'fresh'
}

/**
 * Tri-state freshness of a URL's last prefetch window: 'fresh', 'stale' (had one,
 * elapsed - must refetch) or 'unknown' (never prefetched). The stale marker is kept
 * rather than deleted so staleness stays distinguishable from never-fetched.
 */
function urlStaticFreshState(key: string): 'fresh' | 'stale' | 'unknown' {
  const until = urlStaticFreshUntil.get(key)
  if (until === undefined) return 'unknown'
  return clientClockNow() >= until ? 'stale' : 'fresh'
}

// Back/forward cache of live island roots, keyed by route. Leaving a route stashes
// its stateful roots here (kept alive, detached); returning restores them so React
// state survives. Fixed-size LRU.
const bfRouteRootCache = new Map<string, LiveIslandRoot[]>()
const BF_ROUTE_ROOT_CACHE_LIMIT = 3
let activeBfcacheId: string | undefined

function cacheEntryDocument(page: PrefetchedPage) {
  let id = historyState().__pnextEntry
  if (typeof id === 'string') routerState.renderedEntryId = id
  if (typeof id !== 'string') {
    id = newEntryId()
    try {
      history.replaceState({ ...historyState(), __pnextEntry: id }, '', location.href)
    } catch {
      return
    }
  }
  let bfcacheId = historyBfcacheId()
  if (typeof bfcacheId !== 'string') {
    bfcacheId = newBfcacheId()
    try {
      history.replaceState(
        { ...historyState(), [HISTORY_BFCACHE_ID_KEY]: bfcacheId },
        '',
        location.href,
      )
    } catch {
      // Ignore: without a stable id we can’t preserve bfcache state.
    }
  }
  activeBfcacheId = bfcacheId
  entryDocCache.set(id as string, page)
  if (entryDocCache.size > ENTRY_DOC_CACHE_LIMIT) {
    const oldest = entryDocCache.keys().next().value
    if (oldest !== undefined) entryDocCache.delete(oldest)
  }
}

// Loading-shell cache: the streamed shell of a route response, carrying its closed
// <pnext-suspense> fallback. Cached per PATHNAME (search-param independent, like
// Next's loading segment) for the static staleTime window, so a navigation can paint
// the loading state synchronously. Entries are immutable within their window so the
// loading UI is stable across navigations.

export interface ShellEntry {
  time: number
  html: string
  stateKey: string
  /**
   * This shell's OWN reuse window, from `x-nextjs-stale-time`. A route that publishes
   * a SHORTER one than the flat static window must not keep painting its loading shell
   * past it. Absent header means the flat window.
   */
  staleTimeMs?: number
}
/** A shell's effective window: its own (from the response) or the flat default. */
function shellEntryStaleTimeMs(entry: ShellEntry): number {
  return entry.staleTimeMs ?? shellStaleTimeMs()
}
/**
 * The window a freshly stored shell carries. Only a POSITIVE finite header value
 * narrows it: a dynamic response reports `0`, and a zero-length window would drop the
 * shell before it could ever paint.
 */
function shellStaleTimeFromPage(page: PrefetchedPage): number | undefined {
  const seconds = page.staleTimeSeconds
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return undefined
  const ms = seconds * 1000
  return ms < shellStaleTimeMs() ? ms : undefined
}
const shellCache = new Map<string, ShellEntry>()
const SHELL_CACHE_LIMIT = 32

/** Slice a buffered route document down to its streamed shell, if it had one. */
function sliceShell(html: string, shellOnly = false): string | null {
  if (!html.includes(SUSPENSE_FALLBACK_CLOSE) && !html.includes(INLINE_FALLBACK_CLOSE)) return null
  const cut = streamChunkCut(html)
  if (cut === -1) {
    // Only a response the server MARKED shell-only (truncated partial prefetch,
    // prebuilt PPR shell) is a shell; a settled document must never be cached as one.
    return shellOnly ? html : null
  }
  // Close the sliced shell so DOMParser sees a well-formed document.
  const shell = `${html.slice(0, cut)}</body></html>`
  return materializeRuntimeShellPrefix(html, shell)
}

function materializeRuntimeShellPrefix(html: string, shell: string): string {
  if (typeof DOMParser === 'undefined') return shell
  const parser = new DOMParser()
  const shellDoc = parser.parseFromString(shell, 'text/html')
  const shellPrefetch = documentRouteState(shellDoc)?.prefetchKind === 'shell'
  const suspenses = [
    ...shellDoc.querySelectorAll<HTMLElement>('pnext-suspense[data-pnext-suspense]'),
  ]
  const boundary = Number(suspenses.at(-1)?.getAttribute('data-pnext-suspense'))
  const fullDoc = parser.parseFromString(html, 'text/html')
  for (const chunk of fullDoc.querySelectorAll<HTMLElement>('div[hidden][data-pnext-stream]')) {
    const id = Number(chunk.getAttribute('data-pnext-stream'))
    if (!Number.isFinite(id)) continue
    const revealsNestedFallback = Boolean(
      chunk.querySelector('pnext-suspense[data-pnext-suspense]'),
    )
    if (shellPrefetch ? !Number.isFinite(boundary) || id >= boundary : !revealsNestedFallback) {
      continue
    }
    const fallback = shellDoc.querySelector(
      `pnext-suspense[data-pnext-suspense="${CSS.escape(String(id))}"]`,
    )
    if (!fallback) continue
    const merged = slotMergedContent(
      fallback,
      chunk,
      chunk.getAttribute('data-pnext-slots'),
      node => shellDoc.importNode(node, true),
    )
    fallback.replaceWith(
      ...(merged ?? [...chunk.childNodes].map(node => shellDoc.importNode(node, true))),
    )
  }
  return `<!doctype html>${shellDoc.documentElement.outerHTML}`
}

function storeShell(
  pathname: string,
  page: PrefetchedPage,
  navState: DocumentNavState = currentNavState(),
  search = '',
): void {
  if (!page.ok) return
  const shell = sliceShell(page.html, page.shellOnly === true)
  if (!shell) return
  const stateKey = navStateKey(navState)
  // A rewrite shell is keyed on the EXACT pathname+search it was rendered for, never
  // under its finalUrl pathname: a sibling URL, or the same pathname with a different
  // search, may rewrite elsewhere, so takeShell(pathname) must not hand it to them.
  const paths = new Set<string>()
  if (isRewriteDocument(shell, pathname)) {
    paths.add(pathname + search)
  } else {
    paths.add(pathname)
    try {
      paths.add(new URL(page.finalUrl, location.href).pathname)
    } catch {
      // finalUrl should always parse; the requested pathname alone is fine.
    }
  }
  const staleTimeMs = shellStaleTimeFromPage(page)
  for (const path of paths) {
    const existing = shellCache.get(path)
    if (
      existing?.stateKey === stateKey &&
      clientClockNow() - existing.time < shellEntryStaleTimeMs(existing)
    ) {
      continue
    }
    shellCache.set(path, {
      time: clientClockNow(),
      html: shell,
      stateKey,
      ...(staleTimeMs === undefined ? {} : { staleTimeMs }),
    })
  }
  while (shellCache.size > SHELL_CACHE_LIMIT) {
    const oldest = shellCache.keys().next().value
    if (oldest === undefined) break
    shellCache.delete(oldest)
  }
}

/**
 * The stored shell for a navigation target, with the key it was found under.
 * `storeShell` files a rewrite-produced shell under `pathname + search`, so a plain
 * pathname read misses it - try the exact URL key first, then the pathname.
 */
function takeShellForUrl(url: URL): { key: string; html: string } | null {
  const exactKey = url.pathname + url.search
  const exact = url.search ? takeShell(exactKey) : null
  if (exact !== null) return { key: exactKey, html: exact }
  const byPath = takeShell(url.pathname)
  return byPath === null ? null : { key: url.pathname, html: byPath }
}

function takeShell(pathname: string): string | null {
  const entry = shellCache.get(pathname)
  if (!entry) return null
  if (clientClockNow() - entry.time >= shellEntryStaleTimeMs(entry)) {
    shellCache.delete(pathname)
    return null
  }
  if (entry.stateKey !== navStateKey(currentNavState())) return null
  return entry.html
}

function shellHtmlByPath() {
  const shells = new Map<string, string>()
  for (const [pathname, entry] of shellCache) {
    if (clientClockNow() - entry.time < shellEntryStaleTimeMs(entry)) {
      shells.set(pathname, entry.html)
    }
  }
  return shells
}

// Segment-prefetch tree cache: a `/_tree` request learns a route's staleTime before
// any HTML is fetched, so the HTML prefetch's reuse window is right on first visit.
// Keyed by pathname (Next's PPR segment cache excludes search from the tree key).
export interface SegmentTree {
  time: number
  staleTimeSeconds: number
  isStatic: boolean
}
const segmentTreeCache = new Map<string, SegmentTree>()
// ---------------------------------------------------------------------------
// SEGMENT CACHE
// ---------------------------------------------------------------------------
const SEGMENT_PREFETCH_HEADER = 'next-router-segment-prefetch'
const TREE_SEGMENT_PATH = '/_tree'
/**
 * Response header naming the route pattern a segment payload was matched against. Its value
 * is a route pattern, so it is NEVER empty - which is why "did the server publish a vary
 * set?" keys on THIS header and not on the vary header itself: an EMPTY vary set serialises
 * to an empty header value, which a Playwright route-interception round trip silently drops.
 */
const SEGMENT_ROUTE_HEADER = 'x-pnext-segment-route'
// Opt-in: this fetch can consume a late metadata tail written after `</html>`.
const LATE_METADATA_HEADER = 'x-pnext-late-metadata'

/**
 * Fetch the `/_tree` segment-prefetch payload for a route and cache its
 * staleTime. Best-effort: a server that doesn't answer segment prefetches (or a
 * dev server) simply leaves the tree cache empty and the HTML prefetch falls
 * back to the mode-derived window. Returns the parsed staleTime (seconds) or
 * undefined.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function segmentTreePrefetch(url: URL): Promise<number | undefined> {
  const key = segmentCachePathname(url)
  const cached = segmentTreeCache.get(key)
  if (cached && clientClockNow() - cached.time < cached.staleTimeSeconds * 1000) {
    touchCacheEntry(segmentTreeCache, key, cached)
    return cached.staleTimeSeconds
  }
  try {
    const init: RequestInit & { priority?: 'auto' | 'high' | 'low' } = {
      headers: {
        rsc: '1',
        'next-router-prefetch': '1',
        [SEGMENT_PREFETCH_HEADER]: TREE_SEGMENT_PATH,
      },
      credentials: 'same-origin',
      priority: 'low',
    }
    const response = await fetch(withRscQuery(url.href), init)
    if (!response.ok) return undefined
    const type = response.headers.get('content-type') ?? ''
    if (!type.includes('text/x-component')) return undefined
    const text = await response.text()
    // Requests with the `_rsc` CDN key use Flight's `0:<json>` framing. Keep
    // accepting unframed JSON for direct compat responders.
    const payload = JSON.parse(text.startsWith('0:') ? text.slice(2) : text) as {
      staleTime?: number
      isStatic?: boolean
    }
    const staleTimeSeconds = typeof payload.staleTime === 'number' ? payload.staleTime : undefined
    if (staleTimeSeconds === undefined) return undefined
    segmentTreeCache.set(key, {
      time: clientClockNow(),
      staleTimeSeconds,
      isStatic: Boolean(payload.isStatic),
    })
    return staleTimeSeconds
  } catch {
    return undefined
  }
}

// Per-segment DOCUMENT cache: the HTML a `/_page`-style segment response
// carries, keyed by segment path and reusable across search params.

function segmentDocumentHtml(body: string, expectedSegment: string): string | null {
  const json = body.startsWith('0:') ? body.slice(2) : body
  try {
    const payload = JSON.parse(json) as { segment?: unknown; html?: unknown }
    return payload.segment === expectedSegment && typeof payload.html === 'string'
      ? payload.html
      : null
  } catch {
    return null
  }
}

export interface SegmentDocumentEntry {
  key: string
  time: number
  staleTimeMs: number
  lifetimeMs: number
  page: PrefetchedPage
}

const segmentDocumentCache = new Map<string, SegmentDocumentEntry>()

function segmentDocumentCacheKey(
  // Absent when the tree phase was SKIPPED (its payload was already learned):
  // there are no rewrite headers to key on, so the requested URL stands.
  response: Response | undefined,
  href: string,
  mode: 'auto' | 'full',
): string {
  const url = new URL(href, location.href)
  const pathname = response?.headers.get('x-nextjs-rewritten-path') ?? url.pathname
  const rewrittenQuery = response?.headers.get('x-nextjs-rewritten-query') ?? null
  const search = rewrittenQuery === null ? url.search : rewrittenQuery ? `?${rewrittenQuery}` : ''
  return `${pathname}${search}\u0000${mode}`
}

function getSegmentDocument(
  key: string,
  href: string,
  mode: 'auto' | 'full',
): PrefetchedPage | null {
  const exact = freshSegmentDocument(key, false)
  const alias = mode === 'auto' ? freshSegmentDocument(segmentShellKey(href), true) : null
  const entry = exact ?? (alias?.key !== key ? alias : null)
  if (!entry) return null
  return { ...entry.page, finalUrl: href }
}

function freshSegmentDocument(key: string, useLifetime: boolean): SegmentDocumentEntry | null {
  const entry = segmentDocumentCache.get(key)
  if (!entry) return null
  const maxAge = useLifetime ? entry.lifetimeMs : entry.staleTimeMs
  if (clientClockNow() - entry.time >= maxAge) {
    segmentDocumentCache.delete(key)
    return null
  }
  touchCacheEntry(segmentDocumentCache, key, entry)
  return entry
}

function storeSegmentDocument(
  key: string,
  href: string,
  mode: 'auto' | 'full',
  page: PrefetchedPage,
): void {
  const staleTimeMs = prefetchStaleTimeMs({
    headerStaleTimeSeconds: page.staleTimeSeconds,
    prefetchFull: mode === 'full',
  })
  const entry = {
    key,
    time: clientClockNow(),
    staleTimeMs,
    lifetimeMs: Math.max(staleTimeMs, shellStaleTimeMs()),
    page,
  }
  segmentDocumentCache.set(key, entry)
  if (mode === 'auto' && (page.shellOnly || page.segmentPrerendered)) {
    segmentDocumentCache.set(segmentShellKey(href), entry)
  }
  while (segmentDocumentCache.size > SEGMENT_CACHE_LIMIT) {
    const oldest = segmentDocumentCache.keys().next().value
    if (oldest === undefined) break
    segmentDocumentCache.delete(oldest)
    // Size pressure dropped this URL's document: the tree learned for it goes
    // too, so the next reveal re-fetches instead of skipping the tree phase on
    // the strength of an entry that is gone.
    forgetLearnedRouteTree(urlKeyOf(oldest))
  }
}

function segmentShellKey(href: string): string {
  // The shell alias is per-URL, not per-pathname: a page that reads
  // searchParams renders different content for `?foo=1` and `?foo=2`, so a
  // pathname-only alias would silently satisfy the second query's lookup from
  // the first one's shell and elide its body request. Cross-query reuse is the
  // per-segment (vary-aware) cache's job, not this alias's.
  const url = new URL(href, location.href)
  return `${url.pathname}${url.search}\u0000auto-shell`
}

function hasReusableSegmentPath(href: string): boolean {
  // Only a COMPLETE cached segment (the prerender carrying the param content) satisfies an
  // eager route's speculative prefetch. A shell-only alias still needs the full fetch: the
  // shared app shell lacks the per-param data, which is why unstable_eager fires at all.
  const entry = freshSegmentDocument(segmentShellKey(href), true)
  return entry !== null && entry.page.shellOnly !== true
}

// The response URL carries the `_rsc` cache-buster we added; strip it so the
// client history/canonical URL never shows the internal query param.
// Compare two query strings by value, ignoring how their reserved characters
// were percent-encoded (`?x=./b` and `?x=.%2Fb` are the same destination).
function decodeSearch(search: string): string {
  try {
    return decodeURIComponent(search)
  } catch {
    return search
  }
}

function stripRscQuery(href: string): string {
  if (!href) return href
  try {
    const url = new URL(href, location.href)
    if (!url.searchParams.has(RSC_UNION_QUERY)) return href
    url.searchParams.delete(RSC_UNION_QUERY)
    const search = url.search
    return `${url.origin}${url.pathname}${search}${url.hash}`
  } catch {
    return href
  }
}

// Bumped by evictClientRouterCache(). An in-flight prefetch that STARTED
// before an eviction (a server action's revalidation) carries pre-invalidation
// data; when it settles it must be dropped instead of repopulating the
// just-cleared caches with stale shells/pages.
let revalidationPrefetchGeneration = 0
let revalidationPrefetchBlocked = false

// Segment body cache. Beyond `/_tree`, the client fetches the route's body segment (served
// as text/x-component) into an LRU keyed by PATHNAME - search params are excluded from the
// PPR segment key, so it is reusable across `?a`/`?b`. Entries expire on their own
// x-nextjs-stale-time window, and a server-action revalidate evicts them.

const ROUTE_SEGMENT_PATH = '/'
const SEGMENT_CACHE_LIMIT = 32

// Per-segment cache policy seam (compat: compat/client/segment-cache.ts). The caches above
// are whole-URL; a compat layer can register a PER-SEGMENT cache keying entries on the params
// a segment provably reads, so one entry serves every param value the segment does not depend
// on. Core stays generic, and absent a registered policy every hook is a no-op.

// The segment-cache seam's shapes live in ./types (the facade re-exports them
// without pulling this module into any entry graph).

// The policy holder itself lives in ./policies (first-paint tier): compat
// registers it during install, long before the router chunk lands.

/** The segment request key the router sends for the whole-route body. */
const INDEX_SEGMENT_PATH = '/_index'

/** The segment request key of the outlined dynamic head (metadata). */
const HEAD_SEGMENT_PATH = '/_head'

/** The segment request key of the LAYOUT frame (the page slot stripped out). */
const LAYOUT_SEGMENT_REQUEST_PATH = '/_layout'

/** The segment request key of the PAGE frame (the layout chain cut away). */
const PAGE_SEGMENT_REQUEST_PATH = '/_page'

/**
 * Which body frame this prefetch has to fetch: the whole route (`/_index`), or - when the
 * per-segment cache already holds this URL's PAGE frame and only its LAYOUT varied - the
 * layout frame alone.
 */
function prefetchBodySegmentPath(href: string): string {
  const url = new URL(href, location.href)
  return segmentCachePolicy?.needsLayoutFrameOnly?.({
    pathname: url.pathname,
    search: url.search,
  }) === true
    ? LAYOUT_SEGMENT_REQUEST_PATH
    : INDEX_SEGMENT_PATH
}

export interface SegmentBodyEntry {
  time: number
  staleTimeMs: number
  body: string
  /** A fully-static route body is a complete document safe to stitch on nav. */
  complete: boolean
}
const segmentBodyCache = new Map<string, SegmentBodyEntry>()

/** Fetch and cache the whole-route body segment for `url`. Best-effort. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function segmentBodyPrefetch(url: URL): Promise<boolean> {
  const key = segmentCachePathname(url)
  const cached = segmentBodyCache.get(key)
  if (cached && clientClockNow() - cached.time < cached.staleTimeMs) {
    touchCacheEntry(segmentBodyCache, key, cached)
    return true
  }
  try {
    const response = await fetch(withRscQuery(url.href), {
      headers: {
        rsc: '1',
        'next-router-prefetch': '1',
        [SEGMENT_PREFETCH_HEADER]: ROUTE_SEGMENT_PATH,
      },
      credentials: 'same-origin',
      priority: 'low',
    })
    if (!response.ok) return false
    const type = response.headers.get('content-type') ?? ''
    if (!type.includes('text/x-component')) return false
    const body = await response.text()
    const staleHeader = response.headers.get('x-nextjs-stale-time')
    const staleSeconds = staleHeader ? Number(staleHeader) : 30
    // A body served without x-nextjs-postponed is a complete (non-PPR) route
    // body: safe to commit on navigation without a second fetch. A postponed
    // (PPR shell) body is only the static shell, so it is cached for warmth but
    // not stitched as the whole page.
    const complete = response.headers.get('x-nextjs-postponed') !== '1'
    setSegmentBody(
      key,
      body,
      Number.isFinite(staleSeconds) ? staleSeconds * 1000 : 30_000,
      complete,
    )
    return true
  } catch {
    return false
  }
}

function setSegmentBody(key: string, body: string, staleTimeMs: number, complete: boolean): void {
  segmentBodyCache.set(key, { time: clientClockNow(), staleTimeMs, body, complete })
  // LRU: evict the oldest entries beyond the limit.
  while (segmentBodyCache.size > SEGMENT_CACHE_LIMIT) {
    const oldest = segmentBodyCache.keys().next().value
    if (oldest === undefined) break
    segmentBodyCache.delete(oldest)
  }
}

/**
 * A cached, COMPLETE body segment for `pathname` within its staleTime window (safe to stitch
 * as the navigation page), or null. A PPR (postponed) shell is never returned here - it is a
 * static shell, not the whole page.
 */
function takeSegmentBody(pathname: string): string | null {
  const key = segmentCachePathname(pathname)
  const entry = segmentBodyCache.get(key)
  if (!entry) return null
  if (clientClockNow() - entry.time >= entry.staleTimeMs) {
    segmentBodyCache.delete(key)
    return null
  }
  touchCacheEntry(segmentBodyCache, key, entry)
  return entry.complete ? entry.body : null
}

function segmentCachePathname(url: URL | string): string {
  const pathname = typeof url === 'string' ? url : url.pathname
  // URL.pathname retains a literal %2F, which is the route-cache identity; do
  // not decode it or a param containing an encoded slash aliases a different
  // segment. Normalizing only malformed escape sequences keeps cache lookups
  // stable across history restoration and prefetch URLs.
  try {
    return new URL(pathname, location.origin).pathname
  } catch {
    return pathname
  }
}

/**
 * Evict segment-cache entries on revalidation, so the next prefetch re-fetches fresh data.
 * Clears both the tree and body caches: Next evicts by tag, but pnext has no client-side tag
 * map, so a full clear is the honest superset.
 */
function evictSegmentCache(options: { pageSegmentsOnly?: boolean } = {}): void {
  segmentTreeCache.clear()
  learnedRouteTrees.clear()
  routeTreesEvicted.clear()
  segmentBodyCache.clear()
  segmentDocumentCache.clear()
  // A same-URL navigation refreshes the PAGE segments only — the shared layout
  // and head segments of the current tree stay cached (Next's refresh
  // semantics). The whole-URL caches above have no per-segment granularity, so
  // only the per-segment policy can honor the distinction.
  if (options.pageSegmentsOnly) segmentCachePolicy?.evictPageSegments()
  else segmentCachePolicy?.clear()
}

/**
 * A server action that revalidated invalidates the ENTIRE client router cache, matching Next:
 * not just the segment caches but the full-document prefetch cache, the loading-shell cache
 * and the back/forward entry-document cache - otherwise a later Link nav to a route whose
 * document was cached BEFORE the revalidation would paint stale data.
 *
 * EXCEPT the stashed island roots (`bfRouteRootCache`), which hold CLIENT STATE, not server
 * data: a revalidation says nothing about them, so a traversal shows revalidated server data
 * while the departed page's React state survives.
 */
export function evictClientRouterCache(options: { rearmVisiblePrefetches?: boolean } = {}): void {
  bumpRouterCacheEpoch()
  revalidationPrefetchGeneration += 1
  revalidationPrefetchBlocked = true
  segmentTreeCache.clear()
  learnedRouteTrees.clear()
  routeTreesEvicted.clear()
  segmentBodyCache.clear()
  segmentDocumentCache.clear()
  segmentCachePolicy?.clear()
  const invalidated = Array.from(prefetchCache.values())
  prefetchCache.clear()
  shellCache.clear()
  entryDocCache.clear()
  bfDocCache.clear()
  urlStaticFreshUntil.clear()
  // Element sets outlive an evicted cache otherwise: in a multi-document host (tests, jsdom
  // embedders) the previous document's links stay registered and get re-pinged against the next
  // document's tree, spending prefetches nothing asked for.
  visiblePrefetchElements.clear()
  // Pending loads belong to the document that created their <link> elements. In a
  // multi-document host (tests, jsdom embedders) a never-settling promise keyed by an
  // absolute href would otherwise stall the next document's first commit on the same URL.
  stylesheetLoads.clear()
  for (const entry of invalidated) notifyPrefetchInvalidation(entry, true)
  if (options.rearmVisiblePrefetches !== false) rearmVisiblePrefetches()
}

export function rearmVisiblePrefetches(): void {
  const generation = revalidationPrefetchGeneration
  const retry = () => {
    if (generation !== revalidationPrefetchGeneration) return
    revalidationPrefetchBlocked = false
    for (const element of prefetchedElements) {
      if (!element.isConnected) {
        prefetchedElements.delete(element)
        continue
      }
      // Links carry href; prefetching forms (next/form) carry action.
      const href = element.getAttribute('href') ?? element.getAttribute('action')
      if (href && isElementVisible(element)) {
        void prefetchRoute(href, {
          element,
          full: isFullPrefetchLink(element),
        })
      }
    }
  }
  if (revalidationPrefetchDelayMs > 0) setTimeout(retry, revalidationPrefetchDelayMs)
  else queueMicrotask(retry)
}

function notifyPrefetchInvalidation(entry: PrefetchEntry, afterRevalidation = false): void {
  const callbacks = entry.onInvalidate.splice(0)
  const generation = revalidationPrefetchGeneration
  for (const callback of callbacks) {
    if (afterRevalidation && revalidationPrefetchDelayMs > 0) {
      // The delayed onInvalidate callback IS the post-cooldown re-prefetch surface. It was
      // scheduled at eviction time, so it fires BEFORE the rearm timer (same deadline,
      // registered later) would lift the eviction block - lift it here, or the manual
      // re-prefetch is silently swallowed.
      setTimeout(() => {
        if (generation === revalidationPrefetchGeneration) {
          revalidationPrefetchBlocked = false
        }
        callback()
      }, revalidationPrefetchDelayMs)
    } else {
      queueMicrotask(callback)
    }
  }
}

/** Non-consuming freshness check for the segment body cache. */
function peekSegmentBody(pathname: string): boolean {
  const entry = segmentBodyCache.get(segmentCachePathname(pathname))
  return Boolean(entry && clientClockNow() - entry.time < entry.staleTimeMs && entry.complete)
}

/** Drop the cached document + shell for a refreshed/revalidated URL. */
function evictNavigationCache(key: string, pathname: string): void {
  const entries = [
    prefetchCache.get(prefetchCacheKey(key, true)),
    prefetchCache.get(prefetchCacheKey(key, false)),
  ]
  prefetchCache.delete(prefetchCacheKey(key, true))
  prefetchCache.delete(prefetchCacheKey(key, false))
  shellCache.delete(pathname)
  bfDocCache.delete(key)
  urlStaticFreshUntil.delete(key)
  for (const entry of entries) if (entry) notifyPrefetchInvalidation(entry)
}

// PREFETCH scheduler (Next's segment-cache semantics). At most 4 concurrent prefetch
// requests; the most-recently-hovered link rides a reserved lane (12) so hover intent
// starts immediately. Queued work is ordered by (priority, phase, sortId) desc - hover
// beats default, tree fetches beat segment bodies, newer beats older. A link leaving
// the viewport drops queued work and stops an in-flight task before its next phase
// (in-flight requests are not aborted, matching Next). Navigation fetches never queue.

const PREFETCH_PRIORITY_DEFAULT = 1
const PREFETCH_PRIORITY_INTENT = 2
const PREFETCH_PHASE_TREE = 2
const PREFETCH_PHASE_SEGMENT = 0
const PREFETCH_DEFAULT_LIMIT = 4
const PREFETCH_INTENT_LIMIT = 12

export interface PrefetchFetchTask {
  cacheKey: string
  sortId: number
  priority: number
  phase: number
  cancelled: boolean
  element?: Element
}

let prefetchSortIdCounter = 0
let inFlightPrefetchRequests = 0
let mostRecentIntentTask: PrefetchFetchTask | undefined
const prefetchTasksByKey = new Map<string, PrefetchFetchTask>()
const prefetchTasksByElement = new WeakMap<Element, PrefetchFetchTask>()

export interface PrefetchSlotWaiter {
  task: PrefetchFetchTask
  resolve: (granted: boolean) => void
}
const prefetchSlotWaiters: PrefetchSlotWaiter[] = []
let prefetchPumpScheduled = false

function createPrefetchTask(cacheKey: string, options: PrefetchOptions): PrefetchFetchTask {
  const task: PrefetchFetchTask = {
    cacheKey,
    sortId: ++prefetchSortIdCounter,
    priority: options.intent ? PREFETCH_PRIORITY_INTENT : PREFETCH_PRIORITY_DEFAULT,
    phase: PREFETCH_PHASE_TREE,
    cancelled: false,
    ...(options.element ? { element: options.element } : {}),
  }
  if (options.intent) trackMostRecentIntent(task)
  prefetchTasksByKey.set(cacheKey, task)
  if (options.element) prefetchTasksByElement.set(options.element, task)
  return task
}

/** Only one task holds Intent priority; the previous one demotes to Default
 * but keeps its (bumped) sortId, staying ahead of other Default tasks. */
function trackMostRecentIntent(task: PrefetchFetchTask): void {
  if (mostRecentIntentTask && mostRecentIntentTask !== task) {
    mostRecentIntentTask.priority = PREFETCH_PRIORITY_DEFAULT
  }
  mostRecentIntentTask = task
}

/** Hover intent: bump the task to the top of the queue with the reserved lane. */
function boostPrefetchTask(task: PrefetchFetchTask): void {
  task.sortId = ++prefetchSortIdCounter
  task.priority = PREFETCH_PRIORITY_INTENT
  trackMostRecentIntent(task)
  pumpPrefetchQueue()
}

/**
 * Viewport exit: drop queued work; an in-flight task stops before its next phase. The
 * pending cache entry is NOT evicted - a request already on the wire still lands and
 * belongs in the cache. A task stopped short resolves null and prefetchRoute's settle
 * handler drops the entry instead.
 */
function cancelPrefetchTask(task: PrefetchFetchTask): void {
  if (task.cancelled) return
  task.cancelled = true
  pumpPrefetchQueue()
}

function finishPrefetchTask(task: PrefetchFetchTask): void {
  if (prefetchTasksByKey.get(task.cacheKey) === task) prefetchTasksByKey.delete(task.cacheKey)
  if (task.element && prefetchTasksByElement.get(task.element) === task) {
    prefetchTasksByElement.delete(task.element)
  }
  if (mostRecentIntentTask === task) mostRecentIntentTask = undefined
}

// Tri-state: compat's cacheComponents mode stamps `true` (Next's segment-cache scheduler),
// PLAIN next-compat stamps `false` (fire immediately - Next's request-count contracts), and
// undefined means a pure core app, which schedules.
function segmentSchedulerEnabled(): boolean {
  return (
    (process.browser || typeof window !== 'undefined') &&
    (window as { __PNEXT_SEGMENT_SCHEDULER__?: boolean }).__PNEXT_SEGMENT_SCHEDULER__ !== false
  )
}

// Next always restores a history entry's bfcacheId, but retaining the inactive
// React tree in an <Activity> boundary is exclusive to cacheComponents. Compat
// stamps this exact value into the document; an unstamped core app must keep its
// ordinary unmount/remount lifecycle.
function activityBfcacheEnabled(): boolean {
  return (
    (process.browser || typeof window !== 'undefined') &&
    (window as { __PNEXT_SEGMENT_SCHEDULER__?: boolean }).__PNEXT_SEGMENT_SCHEDULER__ === true
  )
}

function acquirePrefetchSlot(task: PrefetchFetchTask, phase: number): Promise<boolean> {
  task.phase = phase
  if (task.cancelled) return Promise.resolve(false)
  // No scheduler: grant immediately so prefetches never queue behind each other.
  if (!segmentSchedulerEnabled()) return Promise.resolve(true)
  return new Promise(resolve => {
    prefetchSlotWaiters.push({ task, resolve })
    pumpPrefetchQueue()
  })
}

function releasePrefetchSlot(): void {
  inFlightPrefetchRequests = Math.max(0, inFlightPrefetchRequests - 1)
  pumpPrefetchQueue()
}

// Deferred to a microtask so a batch of same-tick reveals is granted in queue
// order (LIFO), matching Next's once-per-JS-task queue processing.
function pumpPrefetchQueue(): void {
  if (prefetchPumpScheduled) return
  prefetchPumpScheduled = true
  queueMicrotask(() => {
    prefetchPumpScheduled = false
    for (let index = prefetchSlotWaiters.length - 1; index >= 0; index--) {
      const waiter = prefetchSlotWaiters[index]!
      if (waiter.task.cancelled) {
        prefetchSlotWaiters.splice(index, 1)
        waiter.resolve(false)
      }
    }
    prefetchSlotWaiters.sort(
      (a, b) =>
        b.task.priority - a.task.priority ||
        b.task.phase - a.task.phase ||
        b.task.sortId - a.task.sortId,
    )
    while (prefetchSlotWaiters.length > 0) {
      const head = prefetchSlotWaiters[0]!
      const limit =
        head.task.priority === PREFETCH_PRIORITY_INTENT
          ? PREFETCH_INTENT_LIMIT
          : PREFETCH_DEFAULT_LIMIT
      if (inFlightPrefetchRequests >= limit) break
      prefetchSlotWaiters.shift()
      inFlightPrefetchRequests++
      head.resolve(true)
    }
  })
}

// The whole-document prefetch cache: entry shape, the LRU itself, and the
// entry/byte trimming Next bounds its client prefetch cache with.

const PREFETCH_CACHE_LIMIT = 32

export interface PrefetchEntry {
  time: number
  page: Promise<PrefetchedPage | null>
  /**
   * FULL-DOCUMENT reuse window (ms): a navigation within it commits the cached document
   * without a fetch. Resolved from `x-nextjs-stale-time` once the fetch settles; until
   * then the entry uses the dynamic default so a click racing the prefetch never
   * over-reuses. Dynamic data defaults to 0 under Next 16.
   */
  staleTimeMs: number
  /**
   * ENTRY lifetime (ms): the prefetch-dedup window. Even when the data is immediately
   * stale (staleTimeMs 0) the entry stays warm for the static window, so a
   * hovered/visible link does not refetch on every intent.
   */
  lifetimeMs: number
  /** True for a full-page (prefetch={true}) prefetch (static reuse window). */
  full: boolean
  /**
   * Serialized nav state the prefetch was rendered against. A prefetched page bakes in
   * its parallel-route slots at fetch time, so if the live document's nav state has
   * since changed the cached page is stale and a navigation must refetch.
   */
  stateKey: string
  /** A pending prefetch always dedupes; settled stale data must refetch. */
  settled: boolean
  /** Byte size of the settled document (LRU size accounting). */
  bytes?: number
  /** Settled as a shell-only (partial prefetch) response — see PrefetchedPage. */
  shellOnly?: boolean
  /**
   * The entry's document is COMPLETE (no server-skipped shared-layout markers): it can
   * commit from any origin whose parallel-slot state matches. Skip-marker responses
   * stay bound to the exact nav state they rendered against (stateKey).
   */
  originAgnostic?: boolean
  /**
   * The entry's document is an interception HOST render. Such an entry is bound to its
   * exact host nav state - it never serves via the origin-agnostic (slot-only) match,
   * and a DIRECT render of the same URL must not serve an intercepting navigation.
   */
  intercepted?: boolean
  /** Slot-only key of the nav state the entry was rendered against. */
  slotsKey: string
  onInvalidate: (() => void)[]
}

const prefetchCache = new Map<string, PrefetchEntry>()
const prefetchedElements = new Set<Element>()
// Next re-evaluates every currently visible Link when the committed URL/base tree changes:
// the same href may need a different segment delta from the new route. Keep this separate from
// `prefetchedElements` (which also includes intent-only and formerly visible elements used by
// revalidation) so an ordinary navigation only pings links that are actually on screen.
const visiblePrefetchElements = new Set<Element>()

function touchCacheEntry<T>(cache: Map<string, T>, key: string, entry: T): void {
  // Map insertion order is our LRU order. Reads must move an entry to the end
  // before trimPrefetchCache removes the oldest key.
  cache.delete(key)
  cache.set(key, entry)
}

function prefetchCacheKey(key: string, full: boolean): string {
  return `${key}\u0000${full ? 'full' : 'auto'}`
}

function prefetchEntriesForNavigation(key: string): PrefetchEntry[] {
  return [
    prefetchCache.get(prefetchCacheKey(key, true)),
    prefetchCache.get(prefetchCacheKey(key, false)),
  ].filter((entry): entry is PrefetchEntry => entry !== undefined)
}

// Byte budget for settled prefetch documents. Entry-count and byte limits both apply,
// but ONLY to settled entries: evicting an in-flight prefetch's pending entry would
// make a second reveal of the same link duplicate the request.
const PREFETCH_CACHE_BYTE_LIMIT = 50 * 1024 * 1024

function trimPrefetchCache() {
  let settled = 0
  let bytes = 0
  for (const entry of prefetchCache.values()) {
    if (!entry.settled) continue
    settled += 1
    bytes += entry.bytes ?? 0
  }
  if (settled <= PREFETCH_CACHE_LIMIT && bytes <= PREFETCH_CACHE_BYTE_LIMIT) return
  for (const [key, entry] of prefetchCache) {
    if (settled <= PREFETCH_CACHE_LIMIT && bytes <= PREFETCH_CACHE_BYTE_LIMIT) return
    if (!entry.settled) continue
    prefetchCache.delete(key)
    // Cache pressure evicted this URL's prefetch data: its learned route tree must fall
    // with it, or the next reveal skips the tree phase on the strength of data the
    // router no longer has.
    forgetLearnedRouteTree(urlKeyOf(key))
    settled -= 1
    bytes -= entry.bytes ?? 0
  }
}

// Learned route facts: which routes outline (or head-first fetch) their <head>,
// and the per-URL route trees a prefetch/navigation response teaches the router.

/**
 * Route patterns whose prefetch responses outline their head (`x-pnext-head-outlined`):
 * the <title> arrives as a separate `/_head` response rather than inside the
 * param-shared body.
 */
const outlinedHeadRoutes = new Set<string>()

/**
 * The subset of those routes whose head is fetched BEFORE the body: a route with
 * dynamic params, whose param-shared body and per-URL head are separate segments. A
 * PARAMLESS route's head is outlined out of its single body response, so it arrives
 * after it.
 */
const headFirstRoutes = new Set<string>()

/** True when `pathname` belongs to a route observed to outline its head. */
function routeOutlinesHead(pathname: string): boolean {
  return matchesLearnedRoute(outlinedHeadRoutes, pathname)
}

/** True when `pathname`'s route answers its outlined head before its body. */
function routeFetchesHeadFirst(pathname: string): boolean {
  return matchesLearnedRoute(headFirstRoutes, pathname)
}

function matchesLearnedRoute(routes: Set<string>, pathname: string): boolean {
  if (routes.size === 0) return false
  // Pattern matching lives in the compat segment cache; go through the policy
  // seam so this module stays free of a compat import (as needsLayoutFrameOnly
  // already does).
  const matchesRoute = segmentCachePolicy?.matchesRoute
  if (!matchesRoute) return false
  for (const route of routes) if (matchesRoute(route, pathname)) return true
  return false
}

// Learned route trees. Next's segment cache keys the ROUTE TREE by ROUTE, not by URL,
// so once `/photo/1` has taught the client the tree of `/photo/:id`, revealing
// `/photo/2` issues no `/_tree` request. `segmentTreeCache` above is keyed by exact
// pathname and misses every sibling, so this map closes that gap. Entries are learned
// from both prefetch tree and navigation responses, and resolve to their route LAZILY:
// a baked tree response carries no `route` field, but the segment cache learns the
// pathname->route mapping from the payload that follows.
export interface LearnedRouteTree {
  time: number
  staleTimeMs: number
  /** Pathname the tree was learned for (the map key also carries the search). */
  pathname: string
  /**
   * The SEARCH the tree was learned with. A tree response is negotiated for the whole
   * URL: a page reading `searchParams` answers `/_tree` differently per query, so a URL
   * differing only in search has NOT had its tree learned.
   */
  search: string
  /** Route pattern from the tree payload, when the server stamped one. */
  route?: string
  /**
   * The response was REWRITTEN (its segment entries key on the rewritten path). Such a
   * tree is remembered but never reused: skipping the request would key the follow-up
   * segment on the requested URL instead, breaking the rewrite dedup contract.
   */
  rewritten?: boolean
}
const learnedRouteTrees = new Map<string, LearnedRouteTree>()
/**
 * URLs whose prefetch data was evicted under CACHE PRESSURE. Barred from the sibling
 * prediction below until they learn a tree of their own again. Bounded LRU.
 */
const routeTreesEvicted = new Set<string>()

function learnedRouteTreeKey(pathname: string, search: string): string {
  return `${pathname}\u0000${search}`
}

/** The `pathname[?search]` half of a `<url key>\u0000<variant>` cache key. */
function urlKeyOf(cacheKey: string): string {
  const separator = cacheKey.lastIndexOf('\u0000')
  return separator === -1 ? cacheKey : cacheKey.slice(0, separator)
}

/**
 * File the route tree learned for `pathname` + `search`. The window is the STATIC one,
 * never the response's data staleTime: a route tree's SHAPE is static even for a
 * dynamically rendered route, and a revalidation clears this map outright. A configured
 * zero static window disables the reuse entirely.
 */
function learnRouteTree(pathname: string, search: string, route?: string, rewritten = false): void {
  const staleTimeMs = shellStaleTimeMs()
  if (!(staleTimeMs > 0)) return
  const path = segmentCachePathname(pathname)
  const key = learnedRouteTreeKey(path, search)
  learnedRouteTrees.delete(key)
  // Re-learning cancels the eviction marker: this URL has its tree back.
  routeTreesEvicted.delete(key)
  learnedRouteTrees.set(key, {
    time: clientClockNow(),
    staleTimeMs,
    pathname: path,
    search,
    ...(route ? { route } : {}),
    ...(rewritten ? { rewritten: true } : {}),
  })
  while (learnedRouteTrees.size > SEGMENT_CACHE_LIMIT) {
    const oldest = learnedRouteTrees.keys().next().value
    if (oldest === undefined) break
    learnedRouteTrees.delete(oldest)
  }
}

/**
 * Drop the tree learned for a URL key, used when that URL's prefetch data is evicted
 * under CACHE PRESSURE. A learned tree is a dedupe token for data the client still
 * holds; outliving that data turns an LRU eviction into a silently skipped refetch.
 */
function forgetLearnedRouteTree(urlKey: string): void {
  let url: URL
  try {
    url = new URL(urlKey, location.href)
  } catch {
    return
  }
  const key = learnedRouteTreeKey(segmentCachePathname(url), url.search)
  learnedRouteTrees.delete(key)
  // A SIBLING of the same route must not paper over the gap either: the evicted URL's
  // own data is what the next reveal has to re-fetch. The marker survives until this
  // URL learns a tree of its own again.
  routeTreesEvicted.delete(key)
  routeTreesEvicted.add(key)
  while (routeTreesEvicted.size > SEGMENT_CACHE_LIMIT) {
    const oldest = routeTreesEvicted.values().next().value
    if (oldest === undefined) break
    routeTreesEvicted.delete(oldest)
  }
}

/**
 * True when the `/_tree` payload for `href` is already known - this exact URL was
 * learned, or it is a SIBLING of a learned dynamic route. Three guards keep the sibling
 * case from eliding a request that carries new information: only an entry learned with
 * the same SEARCH may stand in; the pattern is reused only for a pathname the SERVER
 * already resolved to that same route (a genuine first reveal carries per-URL data);
 * and a URL barred by `routeTreesEvicted` is never predicted onto.
 */
function routeTreeAlreadyLearned(href: string): boolean {
  const policy = segmentCachePolicy
  const routeFor = policy?.routeFor
  const matchesRoute = policy?.matchesRoute
  if (!routeFor || !matchesRoute) return false
  const url = new URL(href, location.href)
  const pathname = segmentCachePathname(url)
  const search = url.search
  const ownKey = learnedRouteTreeKey(pathname, search)
  const time = clientClockNow()
  const own = learnedRouteTrees.get(ownKey)
  if (own?.rewritten) return false
  if (own) {
    if (time - own.time < own.staleTimeMs) {
      touchCacheEntry(learnedRouteTrees, ownKey, own)
      return true
    }
    learnedRouteTrees.delete(ownKey)
  }
  if (routeTreesEvicted.has(ownKey)) return false
  const ownRoute = routeFor(pathname)
  if (ownRoute === null) return false
  // Most recently learned first, like the segment cache's own learned-route
  // prediction order.
  for (const [learnedKey, entry] of [...learnedRouteTrees].reverse()) {
    if (time - entry.time >= entry.staleTimeMs) {
      learnedRouteTrees.delete(learnedKey)
      continue
    }
    if (entry.rewritten) continue
    if (entry.search !== search) continue
    const route = entry.route ?? routeFor(entry.pathname)
    // A param-free route serves exactly one URL: it can never stand in for a
    // pathname other than its own (the exact hit above already covers that).
    if (!route?.includes(':')) continue
    if (ownRoute !== route) continue
    if (!matchesRoute(route, pathname)) continue
    touchCacheEntry(learnedRouteTrees, learnedKey, entry)
    return true
  }
  return false
}

// prefetchRoute: the public prefetch entry point, its segment-cache
// short-circuits and the cache/scheduler bookkeeping each prefetch performs.

/**
 * True when the per-segment VARY cache already holds content that is byte-correct for
 * `url`, so a default prefetch has nothing to fetch. The router's own cache is keyed on
 * pathname+search and cannot see this: a segment whose render provably never read the
 * differing param (or the query) is shared across every value of it.
 *
 * The test is `prefetchSatisfied`, NOT the stricter `networkFree` commit rule - a
 * runtime-prefetch shell is postponed yet a prefetch its vary set already covers is a
 * genuine no-op. Never under `output: 'export'`, where the segment cache is fed by
 * VISITED documents rather than prefetch responses, and a visit must not satisfy a
 * prefetch.
 */
function segmentVaryPrefetchSatisfied(url: URL): boolean {
  if (!segmentCachePolicy || exportDocumentFetcher) return false
  const lookup = { pathname: url.pathname, search: url.search }
  const body = segmentCachePolicy.take({ ...lookup, segmentPath: INDEX_SEGMENT_PATH })
  if (!body || !hitSatisfiesPrefetch(body)) {
    return segmentCachePolicy.runtimePageFrameSatisfied?.(lookup) === true
  }
  // The head (metadata) segment varies independently of the body: metadata that reads
  // params must refetch even when the body is shared. A route with no head entry at all
  // (its head inlined in the body response) is satisfied by the body alone.
  const head = segmentCachePolicy.take({ ...lookup, segmentPath: HEAD_SEGMENT_PATH })
  // No head entry: satisfied UNLESS this route is known to outline its head —
  // there the shared body would elide the whole prefetch and the new URL's title
  // would never be fetched.
  if (head === null) return !routeOutlinesHead(url.pathname)
  return hitSatisfiesPrefetch(head)
}

/** `prefetchSatisfied`, falling back to the commit rule for older policies. */
function hitSatisfiesPrefetch(hit: SegmentCacheHit): boolean {
  return hit.prefetchSatisfied ?? hit.networkFree
}

/**
 * The BODY-segment bytes a prefetch of `href` would fetch, when the vary cache already
 * holds them under another URL's key. Narrower than `segmentVaryPrefetchSatisfied`:
 * asked once the tree phase is done, and it holds even for a POSTPONED shell. The
 * synthesized page is `shellOnly`, so the navigation still fetches the remainder.
 */
function segmentBodyCovered(
  href: string,
  mode: 'auto' | 'full' | undefined,
): PrefetchedPage | null {
  const policy = segmentCachePolicy
  if (!policy?.prefetchCovered || exportDocumentFetcher) return null
  // DEFAULT prefetches only. A FULL (`prefetch={true}` / unstable_forceStale) prefetch
  // asks for the whole page INCLUDING the parts that vary - a shell whose vary set
  // covers this URL says nothing about the dynamic content the full fetch exists to get.
  if (mode !== 'auto') return null
  const url = new URL(href, location.href)
  const covered = policy.prefetchCovered({
    pathname: url.pathname,
    search: url.search,
    segmentPath: INDEX_SEGMENT_PATH,
  })
  if (!covered) return null
  return {
    html: covered.html,
    finalUrl: href,
    ok: true,
    shellOnly: true,
    // Already filed under the vary key it was fetched for — re-recording it
    // under THIS URL would pin the shared entry to one URL's key.
    segmentRecorded: true,
  }
}

export function prefetchRoute(
  href: string,
  options: PrefetchOptions = {},
): Promise<PrefetchedPage | null> {
  // Dev pages render per request and entries build on demand; hover prefetch
  // would hammer the dev server for little gain. Navigation still fetches.
  if (isDevDocument()) return Promise.resolve(null)
  if (isBotUserAgent()) return Promise.resolve(null)
  // `strict` is handled at the facade, the only entry point that can be handed
  // an unparseable href; everything reaching here already resolved once.
  const url = resolveSoftUrl(href)
  if (!url) return Promise.resolve(null)
  const key = url.pathname + url.search
  const full = Boolean(options.full)
  const cacheKey = prefetchCacheKey(key, full)
  // Track the element before the current-route short circuit. A visible link to the page we are
  // already on has an empty prefetch delta now, but its delta changes after navigating away and
  // it must be reconsidered against that new base tree.
  if (options.element) prefetchedElements.add(options.element)
  // Prefetching the page we are already on is a no-op (Next's router produces
  // an empty delta for the current tree) — and it must not spend a request.
  if ((key === locationKey() || key === routerState.activeRouteKey) && !options.currentUrl) {
    return Promise.resolve(null)
  }
  // A default prefetch carries only static segment data; search params are dynamic data
  // it never includes. Same-pathname links differing only in search therefore have
  // nothing prefetchable, and Next issues no request until the click.
  if (!options.full && url.pathname === location.pathname && !options.currentUrl) {
    return Promise.resolve(null)
  }
  if (revalidationPrefetchBlocked) return Promise.resolve(null)
  // Hover intent on a link whose prefetch is already scheduled/pending: boost
  // it to the reserved Intent lane instead of spawning anything new.
  const existingTask = prefetchTasksByKey.get(cacheKey)
  if (options.intent && existingTask && !existingTask.cancelled) {
    boostPrefetchTask(existingTask)
  }
  const cached = prefetchCache.get(cacheKey)
  if (cached) {
    const age = clientClockNow() - cached.time
    const reusable = age < cached.lifetimeMs && (!cached.settled || age < cached.staleTimeMs)
    // A DEFAULT prefetch only ever fetches static data. While this URL's static window
    // is still fresh a settled entry keeps deduping, even after a navigation re-seeded
    // it with the shorter dynamic window.
    if (reusable || (!full && cached.settled && urlStaticFresh(key))) {
      touchCacheEntry(prefetchCache, cacheKey, cached)
      if (options.onInvalidate) cached.onInvalidate.push(options.onInvalidate)
      return cached.page
    }
    prefetchCache.delete(cacheKey)
    notifyPrefetchInvalidation(cached)
  } else if (!full && urlStaticFresh(key)) {
    // No entry, but the URL's static data is still warm from an earlier
    // prefetch: a default prefetch has nothing new to fetch (the navigation
    // itself fetches the dynamic data). Eager app-shell routes still upgrade
    // to a full prefetch below — only the plain static re-prefetch is elided.
    const predicted = loadingShellPredictionPolicy?.(url, shellHtmlByPath())
    if (predicted?.prefetch !== 'eager') return Promise.resolve(null)
  }
  if (full && !options.currentUrl) {
    // Back/forward cache read: a complete document recently shown for this exact route serves
    // a full prefetch with zero network, seeded as a settled entry so the following navigation
    // commits without a fetch. Never for a `currentUrl` seed - the bfcache holds the very
    // document that seed is running for, and the point is to obtain the bytes it does NOT have.
    const bfDoc = takeBfDoc(key)
    if (bfDoc) {
      const page = Promise.resolve(bfDoc.page)
      const state = currentNavState()
      prefetchCache.set(cacheKey, {
        time: bfDoc.time,
        page,
        staleTimeMs: shellStaleTimeMs(),
        lifetimeMs: shellStaleTimeMs(),
        full: true,
        stateKey: navStateKey(state),
        slotsKey: slotsStateKey(state.slots ?? {}),
        settled: true,
        // storeBfDoc only keeps complete, marker-free documents.
        originAgnostic: true,
        onInvalidate: options.onInvalidate ? [options.onInvalidate] : [],
      })
      trimPrefetchCache()
      return page
    }
  }
  if (!full) {
    const predicted = loadingShellPredictionPolicy?.(url, shellHtmlByPath())
    // A 'shell' route (`prefetch = 'allow-runtime' | 'partial'`) shares one app shell across
    // params, so once any same-route shell is cached, revealing another link of the route has
    // nothing to fetch. EXCEPT when this exact URL's own data has EXPIRED (a stale runtime
    // prefetch must refetch on re-reveal), and EXCEPT for `allow-runtime` routes: their shell
    // is RUNTIME-prefetched, so its content belongs to the URL it was sampled for and every
    // unseen URL must fall through to fetchPage. Only a STATIC `partial` shell is shared.
    if (
      predicted?.prefetch === 'shell' &&
      !predicted.runtimePrefetch &&
      urlStaticFreshState(key) !== 'stale'
    ) {
      return Promise.resolve(null)
    }
    if (predicted?.prefetch === 'eager' && !hasReusableSegmentPath(url.href)) {
      return prefetchRoute(url.href, { ...options, full: true })
    }
    // Last elision before the wire: the per-segment vary cache may already hold
    // content valid for this URL even though its pathname+search was never
    // fetched (an empty vary set shares one entry across param/query values).
    if (segmentVaryPrefetchSatisfied(url)) return Promise.resolve(null)
  }

  // Capture the nav state this prefetch renders against so a later click can
  // detect it went stale (a sibling slot navigated in the meantime).
  const prefetchState = currentNavState()
  options.element?.dispatchEvent(new CustomEvent('pnext:prefetchstart'))
  const startEpoch = routerCacheEpoch()
  const task = createPrefetchTask(cacheKey, options)
  const page = fetchPage(url.href, {
    prefetch: full ? 'full' : 'auto',
    navState: prefetchState,
    task,
    // Only when the shell is actually cached: the server strips it from the
    // response, so without a local copy there would be nothing to merge into.
    resumeFromShell: options.hoverResume === true && takeShellForUrl(url) !== null,
  })
    .then(async fetched => {
      // The router cache was evicted (action revalidation) while this prefetch
      // was in flight: its data predates the invalidation. Drop it — the
      // eviction already re-armed visible prefetches for fresh data.
      if (routerCacheEpoch() !== startEpoch) {
        const entry = prefetchCache.get(cacheKey)
        if (entry?.page === page) prefetchCache.delete(cacheKey)
        return null
      }
      // Never keep an error page warm: a prefetch racing a deploy or restart
      // must not make the later click swap in a stale failure.
      if (fetched && !fetched.ok) {
        prefetchCache.delete(cacheKey)
        return null
      }
      if (fetched) {
        // The server's `x-nextjs-stale-time` (static/dynamic window, or the
        // experimental.staleTimes override) sets this entry's reuse window.
        const staleTimeMs = prefetchStaleTimeMs({
          headerStaleTimeSeconds: fetched.staleTimeSeconds,
          prefetchFull: full,
        })
        // How long THIS URL counts as prefetched. Normally the response's own window - but a
        // shell whose vary coverage the server never published (a baked fallback shell: every
        // param hung) leaves the params-dependent content unfetched, so its shell stays
        // paintable for the full window while the URL's data is only as fresh as the DYNAMIC
        // one. A shell that publishes an (even empty) vary set keeps its own window.
        const dataStaleTimeMs = fetched.varyCoverageUnknown
          ? Math.min(staleTimeMs, prefetchStaleTimeMs({}))
          : staleTimeMs
        const entry = prefetchCache.get(cacheKey)
        if (entry) {
          entry.staleTimeMs = dataStaleTimeMs
          entry.lifetimeMs = Math.max(staleTimeMs, shellStaleTimeMs())
          entry.shellOnly = fetched.shellOnly
          entry.intercepted = pageIsHostRender(fetched)
          entry.originAgnostic =
            fetched.shellOnly !== true && !fetched.html.includes(SKIP_MARKER) && !entry.intercepted
          entry.bytes = fetched.html.length
        }
        // This URL's STATIC data is now fresh for the response's window: a
        // later default prefetch of the same URL (even after a navigation
        // re-seeds the entry with the shorter dynamic window) has nothing new
        // to fetch until it elapses.
        markUrlStaticFresh(key, dataStaleTimeMs)
        // The streamed shell carries the route's loading boundary; cache it so
        // a later navigation can paint the loading state instantly.
        storeShell(url.pathname, fetched, prefetchState, url.search)
        // ...and feed the per-segment cache with the prefetched STATIC STAGE. A framed segment
        // payload already filed itself in fetchPage; a prefetch the server answered with a
        // whole DOCUMENT (a route it serves no segments for, or a segment-unaware server) is
        // recorded from its markup here, or the navigation that follows has nothing to paint.
        if (!fetched.segmentRecorded) {
          recordNavigationSegment(url.pathname, url.search, fetched)
        }
        void warmPageAssets(fetched.html)
        const appShell = loadingShellPredictionPolicy?.(url, shellHtmlByPath())
        if (!full && appShell?.prefetch === 'eager' && !hasReusableSegmentPath(url.href)) {
          await prefetchRoute(url.href, { element: options.element, full: true })
        }
      }
      return fetched
    })
    .catch(() => {
      prefetchCache.delete(cacheKey)
      return null
    })
    .finally(() => {
      finishPrefetchTask(task)
      options.element?.dispatchEvent(new CustomEvent('pnext:prefetchfinish'))
    })
  // Seed the window from the requested mode until the response header refines it:
  // a full prefetch reuses for the static window, a default one for the dynamic.
  const seedStale = prefetchStaleTimeMs({ prefetchFull: full })
  prefetchCache.set(cacheKey, {
    time: clientClockNow(),
    page,
    staleTimeMs: seedStale,
    lifetimeMs: Math.max(seedStale, shellStaleTimeMs()),
    full,
    stateKey: navStateKey(prefetchState),
    slotsKey: slotsStateKey(prefetchState.slots ?? {}),
    settled: false,
    onInvalidate: options.onInvalidate ? [options.onInvalidate] : [],
  })
  void page.then(fetched => {
    const entry = prefetchCache.get(cacheKey)
    if (entry?.page === page) {
      // Null = task stopped short with no data; a settled null would dedupe
      // every later reveal into null, so drop the entry and let a viewport
      // re-entry reschedule.
      if (fetched) entry.settled = true
      else prefetchCache.delete(cacheKey)
    }
    // Size accounting only applies to settled documents — re-trim now that
    // this entry's bytes count against the budget.
    trimPrefetchCache()
  })
  trimPrefetchCache()
  return page
}

// ---------------------------------------------------------------------------
// NETWORK
// ---------------------------------------------------------------------------
// RSC transport: the `_rsc` union query, redirect replay, streamed-chunk
// framing and the late-metadata tail a streaming response appends.

// Next's RSC union query param (NEXT_RSC_UNION_QUERY): every RSC/prefetch URL
// carries `?_rsc=<hash>` so a CDN keys its cache on the RSC negotiation rather
// than serving a document response to a router fetch (cache-poisoning defense).
const RSC_UNION_QUERY = '_rsc'

// Append the `_rsc` cache-buster WITHOUT re-escaping any existing (possibly
// URI-encoded) query params: URLSearchParams.set would re-encode `%20` to `+`,
// which the prefetch suites forbid. Splice the raw param onto the search string.
// `variant` folds the request's negotiation variant (prefetch mode + segment
// path) into the hash, like Next derives its cache-busting param from the
// router request headers: a CDN that keys on the URL alone (ignoring Vary)
// must never serve the `/_tree` payload for the `/_index` request.
function withRscQuery(href: string, variant = ''): string {
  const url = new URL(href, location.href)
  if (url.searchParams.has(RSC_UNION_QUERY)) return url.href
  const currentEpoch = routerCacheEpoch()
  const epoch = currentEpoch === 0 ? '' : `:${currentEpoch}`
  const hash = rscHash(url.pathname + url.search + epoch + (variant ? `#${variant}` : ''))
  const separator = url.search ? '&' : '?'
  const rawSearch = `${url.search}${separator}${RSC_UNION_QUERY}=${hash}`
  return `${url.origin}${url.pathname}${rawSearch}${url.hash}`
}

// Chrome's redirect limit, the same bound Next uses for its replay loop.
const MAX_RSC_REDIRECT_REPLAYS = 20

/**
 * Issue a router fetch, replaying a redirect chain that came back carrying a `_rsc`
 * cache-buster we did not send. A proxy/CDN that redirects an RSC request typically
 * drops the query string, so a server that validates the param answers with a redirect
 * of its own - and a redirect the browser follows internally is invisible to both the
 * client and a test harness. Re-fetching the resolved URL with our own `_rsc` settles
 * the chain in one interceptable request.
 */
async function fetchWithRedirectReplay(
  requestHref: string,
  init: RequestInit,
  variant: string,
): Promise<Response> {
  let fetchHref = requestHref
  let response = await fetch(fetchHref, init)
  for (let replay = 0; replay < MAX_RSC_REDIRECT_REPLAYS; replay++) {
    if (!response.redirected) break
    const requested = new URL(fetchHref, location.href)
    const resolved = new URL(response.url, fetchHref)
    // A cross-origin redirect is out of our hands (and its response is opaque
    // to the cache-busting contract).
    if (resolved.origin !== requested.origin) break
    const resolvedRsc = resolved.searchParams.get(RSC_UNION_QUERY)
    // Same param we sent: the chain ended where we aimed it, nothing to redo.
    if (resolvedRsc === requested.searchParams.get(RSC_UNION_QUERY)) break
    // No param at all: the chain ended at a plain redirect target the server was happy
    // to serve. Only a chain carrying a DIFFERENT `_rsc` passed through a cache-busting
    // bounce and needs the replay; re-fetching every redirect would cost a request.
    if (resolvedRsc === null) break
    resolved.searchParams.delete(RSC_UNION_QUERY)
    fetchHref = withRscQuery(resolved.href, variant)
    void response.body?.cancel().catch(() => undefined)
    response = await fetch(fetchHref, init)
  }
  return response
}

// A short deterministic hash of the URL and router-cache epoch. Repeated
// prefetches dedupe until action revalidation bumps the epoch; afterward the
// new URL bypasses stale browser/CDN entries from before the invalidation.
function rscHash(input: string): string {
  let hash = 0
  for (let index = 0; index < input.length; index++) {
    hash = (Math.imul(31, hash) + input.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(36)
}

// Read a streamed HTML response, offering the shell at the response-chunk boundary where the
// navigation can commit it. A pending Suspense hole paints its fallback at that commit, exactly
// like a browser receiving a streamed document shell; if the shell and its replacement arrive in
// the same read, the complete content wins without an intermediate paint. The shell carries every
// Suspense fallback as a closed `<pnext-suspense>`; replacement IDs distinguish resolved holes.
// A route with no Suspense boundary never fires onShell. The in-place suspending path closes its
// fallback with preact's `<!--/$s:ID-->` comment and streams content as `<preact-island data-target>`.
const STREAM_CHUNK_MARKER = '<div hidden data-pnext-stream'
const INLINE_CHUNK_MARKER = '<div hidden><preact-island'
const SUSPENSE_FALLBACK_CLOSE = '</pnext-suspense>'
// The inline-suspense shell closes each hole with `</pnext-hole>`
// (anchorInlineSuspenseHoles rewrites preact's `<!--/$s:ID-->` marker to it).
const INLINE_FALLBACK_CLOSE = '</pnext-hole>'

function streamChunkCut(buffer: string) {
  const streamed = buffer.indexOf(STREAM_CHUNK_MARKER)
  const inline = buffer.indexOf(INLINE_CHUNK_MARKER)
  return streamed < 0 ? inline : inline < 0 ? streamed : Math.min(streamed, inline)
}

// A network read can end halfway through its final continuation. DOMParser auto-closes that
// carrier, which would make materializeStreamedSegments graft partial markup over the fallback.
// Stream carriers are top-level divs, so balance their nested div tags and retain every complete
// same-read carrier while hiding the incomplete trailing one from shell logic.
function completeStreamedPrefix(buffer: string): string {
  const start = Math.max(
    buffer.lastIndexOf(STREAM_CHUNK_MARKER),
    buffer.lastIndexOf(INLINE_CHUNK_MARKER),
  )
  if (start < 0) return buffer
  const tail = buffer.slice(start)
  return (tail.match(/<div\b/g)?.length ?? 0) === (tail.match(/<\/div>/g)?.length ?? 0)
    ? buffer
    : buffer.slice(0, start)
}

function streamHasPendingHole(buffer: string) {
  for (const match of buffer.matchAll(/data-pnext-(?:suspense|hole)="([^"]+)"/g)) {
    const suffix = `="${match[1]}"`
    if (
      !buffer.includes(`data-pnext-stream${suffix}`) &&
      // Scope data-target to pnext's exact inline continuation wire form; app markup commonly
      // uses the bare attribute for toggles and tabs.
      !buffer.includes(`<preact-island hidden data-target${suffix}`)
    ) {
      return true
    }
  }
  return false
}

export async function readStreamedBody(
  response: Response,
  onShell: (shellHtml: string) => void,
): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return response.text()
  const decoder = new TextDecoder()
  let buffer = ''
  let shellDelivered = false
  for (;;) {
    const { done, value } = await reader.read()
    if (value) buffer += decoder.decode(value, { stream: true })
    const shellBuffer = completeStreamedPrefix(buffer)
    if (
      !shellDelivered &&
      (shellBuffer.includes(SUSPENSE_FALLBACK_CLOSE) ||
        shellBuffer.includes(INLINE_FALLBACK_CLOSE)) &&
      // A read that already ends the document has nothing left to stream: painting the
      // pre-chunk loading shell would commit a fallback stage the immediate full-document
      // swap replaces, and that replacement rides island mounts. Skip the shell and let
      // the caller swap the complete, materialized document.
      !/<\/html>\s*$/.test(shellBuffer)
    ) {
      if (streamHasPendingHole(shellBuffer)) {
        shellDelivered = true
        // Expose only holes still pending at this commit. Continuations already present in the
        // read are included so showLoadingShell can materialize them before choosing a fallback.
        onShell(`${shellBuffer}</body></html>`)
      }
    }
    // A late metadata tail (LATE_METADATA_HEADER) rides after the document bytes, so the
    // navigation must not wait for it: everything before the marker IS the document and
    // commits now, while the tail folds into the head once it resolves.
    const late = buffer.indexOf(LATE_METADATA_MARKER)
    if (late !== -1) {
      void collectLateTail(reader, decoder, buffer.slice(late), done, navigationSequence)
      return buffer.slice(0, late)
    }
    if (done) break
  }
  buffer += decoder.decode()
  return buffer
}

const LATE_METADATA_MARKER = '<!--pnext-late-metadata-->'

// Metadata the server resolved after the document flushed. It is appended to
// the live body — the same place a blocking render puts request-time metadata —
// and dropped if another navigation has since taken over.
async function collectLateTail(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  initial: string,
  finished: boolean,
  sequence: number,
) {
  let tail = initial
  if (!finished) {
    for (;;) {
      const { done, value } = await reader.read()
      if (value) tail += decoder.decode(value, { stream: true })
      if (done) break
    }
  }
  tail += decoder.decode()
  const html = tail.split(LATE_METADATA_MARKER).join('').trim()
  if (!html || sequence !== navigationSequence) return
  applyLateMetadata(html)
}

// The document swapped in with no request-time metadata, so its head holds none of these:
// the tail lands the way syncHeadMetadata would have landed it, and anything else (a
// metadata redirect's script) is rebuilt so it executes.
function applyLateMetadata(html: string) {
  const template = document.createElement('template')
  template.innerHTML = html
  let title: string | undefined
  for (const node of [...template.content.childNodes]) {
    if (node instanceof HTMLTitleElement) {
      title = node.textContent ?? ''
      continue
    }
    if (managedHeadNode(node)) {
      document.head.append(node)
      continue
    }
    if (node instanceof HTMLScriptElement) {
      const script = document.createElement('script')
      for (const attribute of node.attributes) script.setAttribute(attribute.name, attribute.value)
      script.text = node.text
      document.body.append(script)
      continue
    }
    document.body.append(node)
  }
  if (title !== undefined) document.title = title
}

// The navigation/prefetch fetch path: one request per page or segment, plus
// the head-outlining and segment-tree negotiation that ride on it.

async function fetchPage(
  href: string,
  options: {
    navState?: DocumentNavState
    /** Rendered URL this navigation departed from (popstate location already names the target). */
    fromUrl?: string
    /**
     * 'auto' - a default prefetch (sends `next-router-prefetch`). 'full' - a
     * `prefetch={true}` full-page prefetch, which Next issues WITHOUT that header.
     * Undefined - a navigation.
     */
    prefetch?: 'auto' | 'full'
    onShell?: (shellHtml: string) => void
    /** Ask the server for a complete render (no shared-layout skipping). */
    fullRender?: boolean
    /** Scheduler task gating this prefetch's fetches (bandwidth + priority). */
    task?: PrefetchFetchTask
    /**
     * The client holds the route's cached static shell: ask the server for the dynamic
     * continuation only (unstable_dynamicOnHover) and merge it into the shell locally.
     */
    resumeFromShell?: boolean
  } = {},
): Promise<PrefetchedPage | null> {
  const state = options.navState ?? currentNavState()
  const priority = options.prefetch ? 'low' : 'auto'
  const segmentPrefetch = options.prefetch !== undefined
  const headers: Record<string, string> = {
    accept: segmentPrefetch ? 'text/x-component' : 'text/html',
    // Router-navigation marker (Next wire-compat: tooling and test harnesses
    // recognize router fetches by it; the pnext server keys off x-pnext-*).
    rsc: '1',
    // Next stamps the fetch priority it used on router fetches so harnesses can
    // assert prefetches ride low priority and navigations auto.
    'next-test-fetch-priority': priority,
    'x-pnext-soft-nav': '1',
    'x-pnext-nav-state': encodeURIComponent(JSON.stringify(state)),
    // Preserve Next's public Flight request contract alongside pnext's richer
    // parallel-slot state header. Proxies and route handlers key RSC variants
    // on this encoded tree.
    'next-router-state-tree': encodeURIComponent(JSON.stringify(state)),
    // The current URL identifies the already-rendered branch. A prefetch uses
    // it to retain shared layouts and stop at the target loading boundary.
    'next-url': options.fromUrl ?? locationKey(),
  }
  if (options.prefetch === 'auto') headers['next-router-prefetch'] = '1'
  // Only the streamed-navigation read path (readStreamedBody) can consume a
  // late metadata tail written after `</html>`, so only it asks for one: the
  // server keeps blocking on `generateMetadata` for every other consumer.
  if (options.onShell) headers[LATE_METADATA_HEADER] = '1'
  if (options.fullRender) headers['x-pnext-full-render'] = '1'
  if (options.resumeFromShell) headers['x-pnext-resume-shell'] = '1'

  const init: RequestInit & { priority?: 'auto' | 'high' | 'low' } = {
    headers,
    credentials: 'same-origin',
    // Viewport/intent prefetches use low fetch priority; navigations use auto.
    priority,
  }
  // `output: 'export'`: no server, so one request for the exported artifact IS the whole
  // protocol. The router headers still ride along (harnesses and proxies identify router
  // traffic by them) and everything an export serves is static, so the entry takes the
  // static reuse window. A miss returns null and the caller hard-navigates.
  if (exportDocumentFetcher) {
    const exported = await exportDocumentFetcher(href, init, segmentPrefetch)
    return exported
      ? {
          html: exported.html,
          finalUrl: exported.finalUrl,
          ok: true,
          staleTimeSeconds: shellStaleTimeMs() / 1000,
        }
      : null
  }
  // Every router fetch carries Next's `_rsc` union query (cache-poisoning defense). After
  // an action revalidation the hash also folds in the bumped router-cache epoch so
  // browser/CDN caches cannot serve a pre-eviction document. Each request VARIANT (mode +
  // segment) hashes distinctly (see withRscQuery).
  const rscVariant = options.prefetch ?? 'nav'
  let requestHref = withRscQuery(href, rscVariant)
  let segmentCacheKey: string | undefined
  let segmentPayload = false
  // Which body frame this fetch asked for: the whole route, or (w9-segment-split)
  // the `/_layout` frame alone when the page frame is already cached.
  let bodySegment: string = INDEX_SEGMENT_PATH
  // The dynamic head, when it was fetched BEFORE the body (Next's order).
  let outlinedHeadHtml: string | null = null
  let response: Response
  // Prefetch fetches ride the bandwidth scheduler: each phase (route tree,
  // segment body) waits for a slot before its request and frees it once the
  // response body is consumed. Navigations (no task) never wait.
  const task = options.task
  let heldSlot = false
  const acquireSlot = async (phase: number): Promise<boolean> => {
    if (!task) return true
    heldSlot = await acquirePrefetchSlot(task, phase)
    return heldSlot
  }
  const releaseSlot = () => {
    if (!heldSlot) return
    heldSlot = false
    releasePrefetchSlot()
  }
  // Header-stripping intermediaries: a CDN/proxy that pipes bodies without re-emitting
  // headers loses content-type/staleness. The tree PAYLOAD itself carries
  // staleTime/isStatic, so classify by body shape and fall back to those fields.
  let treePayloadStaleTime: number | undefined
  let treePayloadStatic = false
  let strippedBody: string | undefined
  try {
    if (options.prefetch === 'full' && !segmentSchedulerEnabled()) {
      // A `prefetch={true}` FULL prefetch on a CLASSIC (non-cacheComponents) app is a SINGLE
      // request, not the two-phase tree/index a segment prefetch uses. Under cacheComponents
      // the two-phase path stays - its tree response carries the rewritten path the segment
      // cache keys on for rewrite dedup.
      headers[SEGMENT_PREFETCH_HEADER] = '/_index'
      requestHref = withRscQuery(href, `${rscVariant}:/_index`)
      if (!(await acquireSlot(PREFETCH_PHASE_SEGMENT))) return null
      const indexResponse = await fetchWithRedirectReplay(
        requestHref,
        init,
        `${rscVariant}:/_index`,
      )
      segmentPayload =
        indexResponse.headers.get('content-type')?.includes('text/x-component') === true &&
        indexResponse.headers.get('x-nextjs-postponed') === '2'
      if (!segmentPayload && !indexResponse.headers.get('content-type')) {
        strippedBody = await indexResponse.text()
      }
      if (segmentPayload) {
        segmentCacheKey = segmentDocumentCacheKey(indexResponse, href, 'full')
        const cached = getSegmentDocument(segmentCacheKey, href, 'full')
        if (cached) {
          if (indexResponse.body && !indexResponse.bodyUsed) await indexResponse.arrayBuffer()
          return cached
        }
      }
      response = indexResponse
    } else if (segmentPrefetch && routeTreeAlreadyLearned(href)) {
      // Route-tree reuse: this URL's tree is already known (its own, or the one learned for
      // the dynamic route that serves it). Next keys the route tree by ROUTE, so a sibling
      // prefetch issues no tree request - go straight to the segment phase.
      segmentCacheKey = segmentDocumentCacheKey(undefined, href, options.prefetch!)
      const cached = getSegmentDocument(segmentCacheKey, href, options.prefetch!)
      if (cached) return cached
      if (task?.cancelled) return null
      if (needsOutlinedHeadFirst(href, false)) {
        outlinedHeadHtml = await fetchOutlinedHead(href, init, headers, rscVariant)
      }
      const covered = segmentBodyCovered(href, options.prefetch)
      if (covered) return withOutlinedHead(covered, outlinedHeadHtml)
      bodySegment = prefetchBodySegmentPath(href)
      headers[SEGMENT_PREFETCH_HEADER] = bodySegment
      requestHref = withRscQuery(href, `${rscVariant}:${bodySegment}`)
      if (!(await acquireSlot(PREFETCH_PHASE_SEGMENT))) return null
      const indexResponse = await fetchWithRedirectReplay(
        requestHref,
        init,
        `${rscVariant}:${bodySegment}`,
      )
      segmentPayload =
        indexResponse.headers.get('content-type')?.includes('text/x-component') === true &&
        indexResponse.headers.get('x-nextjs-postponed') === '2'
      // Header-stripping intermediary: classify the frame by SHAPE, the way the
      // tree phase classifies its own payload.
      if (!segmentPayload && !indexResponse.headers.get('content-type')) {
        const text = await indexResponse.text()
        if (segmentDocumentHtml(text, bodySegment) !== null) segmentPayload = true
        strippedBody = text
      }
      response = indexResponse
    } else if (segmentPrefetch) {
      headers[SEGMENT_PREFETCH_HEADER] = TREE_SEGMENT_PATH
      requestHref = withRscQuery(href, `${rscVariant}:${TREE_SEGMENT_PATH}`)
      if (!(await acquireSlot(PREFETCH_PHASE_TREE))) return null
      const treeResponse = await fetchWithRedirectReplay(
        requestHref,
        init,
        `${rscVariant}:${TREE_SEGMENT_PATH}`,
      )
      segmentPayload =
        treeResponse.headers.get('content-type')?.includes('text/x-component') === true &&
        treeResponse.headers.get('x-nextjs-postponed') === '2'
      let treePayload: ReturnType<typeof parseSegmentTreePayload> = null
      if (!segmentPayload && !treeResponse.headers.get('content-type')) {
        const text = await treeResponse.text()
        const payload = parseSegmentTreePayload(text)
        if (payload) {
          segmentPayload = true
          treePayload = payload
          treePayloadStaleTime = payload.staleTime
          treePayloadStatic = payload.isStatic
        } else {
          strippedBody = text
        }
      }
      if (segmentPayload) {
        segmentCacheKey = segmentDocumentCacheKey(treeResponse, href, options.prefetch!)
        // The tree PAYLOAD is only bookkeeping (route learning, headFirst): read it
        // without blocking the segment phase, so the body request goes on the wire in
        // the same task the tree HEADERS resolve in — before the tree body's own
        // stream-close task, where a harness batch (router-act) may already drain.
        const treeText = treeResponse.body && !treeResponse.bodyUsed ? treeResponse.text() : null
        const finishTree = async () => {
          if (treeText) treePayload = parseSegmentTreePayload(await treeText)
          // Remember this route's tree so a SIBLING URL of the same route never
          // asks for it again (Next keys the route tree by route, not by URL).
          const treeUrl = new URL(href, location.href)
          learnRouteTree(
            treeUrl.pathname,
            treeUrl.search,
            treePayload?.route,
            treeResponse.headers.has('x-nextjs-rewritten-path') ||
              treeResponse.headers.has('x-nextjs-rewritten-query'),
          )
        }
        releaseSlot()
        const cached = getSegmentDocument(segmentCacheKey, href, options.prefetch!)
        if (cached) {
          await finishTree()
          return cached
        }
        // The link left the viewport while the tree was in flight: stop before
        // the segment phase (the in-flight tree request is never aborted, but no
        // follow-up request may be issued — Next's cancellation contract).
        if (task?.cancelled) {
          await finishTree()
          return null
        }
        // Head-before-body order is preserved: the tree response HEADERS announce
        // outlining (x-pnext-head-outlined), so no tree-body read is needed here.
        const treeHeadOutlined = treeResponse.headers.get('x-pnext-head-outlined')
        if (needsOutlinedHeadFirst(href, treeHeadOutlined === 'first')) {
          await finishTree()
          outlinedHeadHtml = await fetchOutlinedHead(href, init, headers, rscVariant)
        }
        const covered = segmentBodyCovered(href, options.prefetch)
        if (covered) {
          await finishTree()
          return withOutlinedHead(covered, outlinedHeadHtml)
        }
        bodySegment = prefetchBodySegmentPath(href)
        headers[SEGMENT_PREFETCH_HEADER] = bodySegment
        requestHref = withRscQuery(href, `${rscVariant}:${bodySegment}`)
        if (!(await acquireSlot(PREFETCH_PHASE_SEGMENT))) {
          await finishTree()
          return null
        }
        const bodyPromise = fetchWithRedirectReplay(
          requestHref,
          init,
          `${rscVariant}:${bodySegment}`,
        )
        // A rejection before the await below must not surface as unhandled.
        bodyPromise.catch(() => undefined)
        await finishTree()
        response = await bodyPromise
      } else {
        response = treeResponse
      }
    } else {
      response = await fetchWithRedirectReplay(requestHref, init, rscVariant)
    }
    const type = response.headers.get('content-type') ?? ''
    // Wire-compat: the server answers router fetches (rsc: 1) with Next's RSC content type;
    // a plain HTML response (pure-core server) stays accepted. An ABSENT content-type
    // (header-stripping proxy) falls through to the body-shape classification below.
    if (type && !type.includes('text/html') && !type.includes('text/x-component')) return null
    const staleTimeHeader = response.headers.get('x-nextjs-stale-time')
    let staleTimeSeconds = staleTimeHeader ? Number(staleTimeHeader) : treePayloadStaleTime
    // A segment prefetch whose redirect chain terminated at the target's plain DOCUMENT: the
    // document IS the complete prefetched page, so give it the static reuse window and the
    // navigation commits from it without a refetch.
    if (
      segmentPrefetch &&
      !segmentPayload &&
      response.redirected &&
      type.includes('text/html') &&
      staleTimeSeconds === undefined
    ) {
      staleTimeSeconds = shellStaleTimeMs() / 1000
    }
    // Only a default ('auto') prefetch is ever truncated server-side; a full prefetch or
    // navigation of a PPR route also carries x-nextjs-postponed but streams complete resumed
    // content, so the generic postponed flags must NOT downgrade it. Sole exception: a FULL
    // prefetch answered with the dedicated x-pnext-runtime-prefetch marker is the server's
    // runtime-prefetch (unstable_instant) shell and must never commit as a document - the
    // navigation still fetches the dynamic continuation.
    const shellOnly =
      (options.prefetch === 'auto' &&
        (response.headers.get('x-nextjs-postponed') === '1' ||
          response.headers.get('x-pnext-segment-postponed') === '1')) ||
      (options.prefetch === 'full' && response.headers.get('x-pnext-runtime-prefetch') === '1')
    const segmentPrerendered =
      segmentPayload &&
      !shellOnly &&
      (response.headers.get('x-nextjs-prerender') === '1' ||
        // Header-stripped responses: the tree payload's isStatic stands in.
        (treePayloadStatic && !response.headers.has('x-nextjs-prerender')))
    // A TRUNCATED prefetch shell the server both PRERENDERED and published a vary set for is
    // STATIC content: its bytes are a pure function of the params that set names, so the
    // segment cache may share the entry across every URL those params cover. Deliberately
    // NOT folded into `segmentPrerendered` (which means a COMPLETE prerendered payload): the
    // entry stays `complete: false`, so `networkFree` stays false and the navigation still
    // fetches the dynamic remainder below the boundary.
    const shellPrerendered =
      segmentPayload &&
      shellOnly &&
      response.headers.get('x-nextjs-prerender') === '1' &&
      response.headers.has(SEGMENT_ROUTE_HEADER)
    // A SHELL answered from the route's BAKED artifact carries no vary set: it was rendered
    // with every param hanging, so the server cannot say which of this URL's params it
    // covers. It paints, but it is NOT this URL's own prefetched data - see
    // `varyCoverageUnknown`.
    const varyCoverageUnknown =
      segmentPayload && shellOnly && !response.headers.has(SEGMENT_ROUTE_HEADER)
    const responseBody =
      strippedBody ??
      (options.onShell ? await readStreamedBody(response, options.onShell) : await response.text())
    let html = segmentPayload ? segmentDocumentHtml(responseBody, bodySegment) : responseBody
    if (html === null) return null
    // A LAYOUT-only prefetch carries no page: compose this URL's cached page frame
    // into it and go on as if the whole route had been fetched. Uncomposable means
    // the prefetch has nothing paintable — drop it and let the navigation fetch.
    if (bodySegment === LAYOUT_SEGMENT_REQUEST_PATH) {
      const url = new URL(href, location.href)
      const composed = segmentCachePolicy?.composeLayoutFrame?.({
        pathname: url.pathname,
        search: url.search,
        layoutHtml: html,
      })
      if (composed == null) return null
      html = composed
      bodySegment = INDEX_SEGMENT_PATH
    }
    // A resume-only response (unstable_dynamicOnHover) carries just the dynamic
    // continuation chunks: merge them into the cached static shell so the entry
    // is a complete document the navigation commits without another fetch.
    if (response.headers.get('x-pnext-resume-only') === '1') {
      const stored = takeShellForUrl(new URL(href, location.href))
      if (!stored) return null
      html = mergeResumeDocument(stored.html, html)
    }
    // The server outlined the dynamic head out of this response: fetch it as its own `/_head`
    // follow-up and merge it back into the cached document. Not gated on a FULL prefetch - a
    // DEFAULT prefetch's body is shared across params too, so its head has to be fetched per
    // URL or the first slug's title is served for every sibling.
    const headOutlinedHeader = response.headers.get('x-pnext-head-outlined')
    if (headOutlinedHeader === '1' || headOutlinedHeader === 'first') {
      const outlinedRoute = response.headers.get(SEGMENT_ROUTE_HEADER)
      if (outlinedRoute) {
        outlinedHeadRoutes.add(outlinedRoute)
        if (headOutlinedHeader === 'first') headFirstRoutes.add(outlinedRoute)
      }
      if (outlinedHeadHtml === null && !options.task?.cancelled) {
        outlinedHeadHtml = await fetchOutlinedHead(href, init, headers, rscVariant)
      }
    }
    if (outlinedHeadHtml !== null) html = mergeOutlinedHead(html, outlinedHeadHtml)
    const page: PrefetchedPage = {
      html,
      finalUrl: stripRscQuery(response.url) || href,
      ok: response.ok,
      ...(staleTimeSeconds !== undefined && Number.isFinite(staleTimeSeconds)
        ? { staleTimeSeconds }
        : {}),
      ...(shellOnly ? { shellOnly } : {}),
      ...(segmentPrerendered ? { segmentPrerendered } : {}),
      ...(varyCoverageUnknown ? { varyCoverageUnknown } : {}),
    }
    if (segmentCacheKey && options.prefetch) {
      storeSegmentDocument(segmentCacheKey, href, options.prefetch, page)
    }
    // Per-segment (vary-params) cache: hand the raw payload to the compat policy
    // so it can key this response on the params the segment actually read. No-op
    // when nothing registered a policy.
    if (segmentPayload && options.prefetch && segmentCachePolicy) {
      page.segmentRecorded = true
      recordSegmentEntry({
        href,
        body: responseBody,
        html,
        page,
        mode: options.prefetch,
        response,
        shellOnly,
        segmentPrerendered,
        shellPrerendered,
        segmentPath: bodySegment,
      })
    }
    return page
  } finally {
    releaseSlot()
  }
}

/**
 * Fetch THIS navigation's `/_page` frame and splice it into the layout frame the
 * per-segment policy already holds, instead of asking the server for the whole document -
 * what Next's per-segment navigation looks like on the wire.
 *
 * EVERY unexpected answer returns null and the caller issues the ordinary whole-document
 * fetch: a redirect, a miss, a plain document, a frame that does not compose. The fallback
 * is byte-identical to a build without this path.
 */
async function fetchPageFrameNavigation(
  url: URL,
  options: { navState?: DocumentNavState; sameUrl: boolean; fromUrl?: string },
): Promise<PrefetchedPage | null> {
  const policy = segmentCachePolicy
  // `output: 'export'` has no server to negotiate a frame with.
  if (!policy?.needsPageFrameOnly || !policy.composePageFrame || exportDocumentFetcher) return null
  const lookup = { pathname: url.pathname, search: url.search, sameUrl: options.sameUrl }
  if (!policy.needsPageFrameOnly(lookup)) return null
  const state = options.navState ?? currentNavState()
  // The navigation headers `fetchPage` sends, plus the segment marker. Kept
  // literal rather than shared: this request is a NAVIGATION (auto priority, no
  // prefetch marker, no scheduler slot) that happens to ask for one frame.
  const headers: Record<string, string> = {
    accept: 'text/x-component',
    rsc: '1',
    'next-test-fetch-priority': 'auto',
    'x-pnext-soft-nav': '1',
    'x-pnext-nav-state': encodeURIComponent(JSON.stringify(state)),
    'next-router-state-tree': encodeURIComponent(JSON.stringify(state)),
    'next-url': options.fromUrl ?? locationKey(),
    [SEGMENT_PREFETCH_HEADER]: PAGE_SEGMENT_REQUEST_PATH,
  }
  const variant = `nav:${PAGE_SEGMENT_REQUEST_PATH}`
  let response: Response
  try {
    response = await fetchWithRedirectReplay(
      withRscQuery(url.href, variant),
      { headers, credentials: 'same-origin', priority: 'auto' },
      variant,
    )
  } catch {
    return null
  }
  if (!response.ok) return null
  // An app redirect (or a rewrite that moved the destination) is the whole
  // document path's business: the frame would compose into the WRONG layout.
  try {
    if (new URL(response.url, location.href).pathname !== url.pathname) return null
  } catch {
    return null
  }
  if (!(response.headers.get('content-type') ?? '').includes('text/x-component')) return null
  const responseBody = await response.text()
  const frame = segmentDocumentHtml(responseBody, PAGE_SEGMENT_REQUEST_PATH)
  if (frame === null) {
    // The server could not frame this route (parallel slots, interception) and replied with
    // the WHOLE DOCUMENT. Commit it: falling through to `fetchPage` would refetch the same
    // URL and put two identical navigation responses on the wire for one navigation.
    if (!responseBody.trimStart().startsWith('{') && !responseBody.startsWith('0:')) {
      const wholeStaleHeader = response.headers.get('x-nextjs-stale-time')
      const wholeStaleSeconds = wholeStaleHeader === null ? undefined : Number(wholeStaleHeader)
      return {
        html: responseBody,
        finalUrl: url.href,
        ok: true,
        ...(wholeStaleSeconds !== undefined && Number.isFinite(wholeStaleSeconds)
          ? { staleTimeSeconds: wholeStaleSeconds }
          : {}),
      }
    }
    return null
  }
  const html = policy.composePageFrame({ ...lookup, pageHtml: frame })
  if (html === null) return null
  const staleTimeHeader = response.headers.get('x-nextjs-stale-time')
  const staleTimeSeconds = staleTimeHeader === null ? undefined : Number(staleTimeHeader)
  return {
    html,
    finalUrl: url.href,
    ok: true,
    ...(staleTimeSeconds !== undefined && Number.isFinite(staleTimeSeconds)
      ? { staleTimeSeconds }
      : {}),
  }
}

/** Feed one segment-prefetch response into the registered per-segment policy. */
function recordSegmentEntry(input: {
  href: string
  body: string
  html: string
  page: PrefetchedPage
  mode: 'auto' | 'full'
  response: Response
  shellOnly: boolean
  segmentPrerendered: boolean
  /** A truncated shell whose prerendered bytes a published vary set covers. */
  shellPrerendered: boolean
  /** The frame this response answered: `/_index`, or `/_layout` (w9 split). */
  segmentPath: string
}): void {
  const url = new URL(input.href, location.href)
  const runtime = input.response.headers.get('x-pnext-runtime-prefetch') === '1'
  segmentCachePolicy?.record({
    pathname: url.pathname,
    search: url.search,
    segmentPath: input.segmentPath,
    body: input.body,
    html: input.html,
    staleTimeMs: prefetchStaleTimeMs({
      headerStaleTimeSeconds: input.page.staleTimeSeconds,
      prefetchFull: input.mode === 'full',
      // A prerendered payload reuses for exactly the window it reported; a
      // runtime-prefetched one (cookies/headers holes sampled at prefetch time)
      // is request data and reuses for the dynamic window at most.
      static: input.segmentPrerendered,
      runtime,
    }),
    // A runtime prefetch is "complete" when its render never postponed — the
    // page reads only cookies/params and does no uncached IO, so the payload is
    // the whole document even though it was request-sampled.
    complete: runtime
      ? input.response.headers.get('x-pnext-runtime-complete') === '1'
      : !input.shellOnly,
    // A prerendered TRUNCATED shell counts as static here (see
    // `shellPrerendered`) — `complete` above stays false, so the entry paints
    // and satisfies a sibling's prefetch without ever committing network-free.
    static: input.segmentPrerendered || input.shellPrerendered,
    runtime,
    // The server TRUNCATED this response at its postponed boundary: the payload is this
    // URL's own prerendered static stage, so a navigation may paint it however little of
    // the page sits outside the holes. A runtime sample is not that - it is request data.
    postponedShell: input.shellOnly && !runtime,
  })
}

/**
 * Splice a resume-only response's streamed chunk divs into the cached static shell, before
 * its closing </body>. materializeStreamedSegments then grafts each chunk over its
 * Suspense fallback, yielding the complete document.
 */
function mergeResumeDocument(shell: string, resume: string): string {
  const open = resume.indexOf('<body')
  const start = open === -1 ? -1 : resume.indexOf('>', open) + 1
  const end = resume.lastIndexOf('</body>')
  const chunks = start !== -1 && start !== 0 && end > start ? resume.slice(start, end) : resume
  const insertAt = shell.lastIndexOf('</body>')
  return insertAt === -1
    ? shell + chunks
    : `${shell.slice(0, insertAt)}${chunks}${shell.slice(insertAt)}`
}

/** A cache-served body with this URL's freshly fetched head merged back in. */
function withOutlinedHead(page: PrefetchedPage, headHtml: string | null): PrefetchedPage {
  return headHtml === null ? page : { ...page, html: mergeOutlinedHead(page.html, headHtml) }
}

/**
 * Fetch a route's outlined `/_head` response and file it under its own `/_head` cache key -
 * the head varies independently of the (often param-shared) body, so the vary cache has to
 * be able to ask whether THIS url's head is cached. Null when it could not be fetched.
 */
async function fetchOutlinedHead(
  href: string,
  init: RequestInit,
  headers: Record<string, string>,
  rscVariant: string,
): Promise<string | null> {
  headers[SEGMENT_PREFETCH_HEADER] = HEAD_SEGMENT_PATH
  try {
    const headUrl = new URL(href, location.href)
    const headResponse = await fetch(withRscQuery(href, `${rscVariant}:${HEAD_SEGMENT_PATH}`), init)
    if (!headResponse.ok) return null
    const headBody = await headResponse.text()
    const headHtml = segmentDocumentHtml(headBody, HEAD_SEGMENT_PATH)
    if (!headHtml) return null
    segmentCachePolicy?.record({
      pathname: headUrl.pathname,
      search: headUrl.search,
      segmentPath: HEAD_SEGMENT_PATH,
      body: headBody,
      html: headHtml,
      staleTimeMs: shellStaleTimeMs(),
      complete: true,
      static: true,
      runtime: false,
    })
    return headHtml
  } catch {
    return null
  }
}

/**
 * True when this URL's dynamic head has to be fetched BEFORE its body: the route is known
 * to answer its head first (it sits above the page in the route tree) and no `/_head` entry
 * covers this URL yet.
 */
function needsOutlinedHeadFirst(href: string, announced: boolean): boolean {
  const url = new URL(href, location.href)
  if (!announced && !routeFetchesHeadFirst(url.pathname)) return false
  return (
    segmentCachePolicy?.take({
      pathname: url.pathname,
      search: url.search,
      segmentPath: HEAD_SEGMENT_PATH,
    }) == null
  )
}

/**
 * Body-shape classification of a `/_tree` response whose negotiation headers were stripped
 * by an intermediary: a flight-framed (`0:{...}`) or bare JSON object carrying a `tree`
 * field IS the RootTreePrefetch. Returns its embedded staleness.
 */
function parseSegmentTreePayload(body: string): {
  staleTime?: number
  isStatic: boolean
  route?: string
  headOutlined?: boolean
  headFirst?: boolean
} | null {
  const json = body.startsWith('0:') ? body.slice(2) : body
  if (!json.startsWith('{')) return null
  try {
    const payload = JSON.parse(json) as {
      tree?: unknown
      staleTime?: unknown
      isStatic?: unknown
      route?: unknown
      headOutlined?: unknown
      headFirst?: unknown
    }
    if (!payload.tree || typeof payload.tree !== 'object') return null
    return {
      ...(typeof payload.staleTime === 'number' ? { staleTime: payload.staleTime } : {}),
      isStatic: payload.isStatic === true,
      // Segment-M2: the route pattern this URL resolved to, when the server
      // stamped one (a BAKED tree carries none — the router then falls back to
      // the segment cache's own pathname->route map).
      ...(typeof payload.route === 'string' ? { route: payload.route } : {}),
      ...(payload.headOutlined === true ? { headOutlined: true } : {}),
      ...(payload.headFirst === true ? { headFirst: true } : {}),
    }
  } catch {
    return null
  }
}

/** Insert an outlined head fragment (`<title>…`) back before </head>. */
function mergeOutlinedHead(html: string, headFragment: string): string {
  const at = html.indexOf('</head>')
  return at === -1 ? headFragment + html : `${html.slice(0, at)}${headFragment}${html.slice(at)}`
}

// WHAT A NAVIGATION PAINTS - loading shells and the static (PPR) stage: painting a route's
// fallback into the live page container before the resolved document lands.

// The in-place suspending path marks each boundary with a `<pnext-hole>` element
// (anchorInlineSuspenseHoles). Return the first hole's parent plus the fallback nodes it
// wraps, so the shell paint has the same anchor and source shape as the
// `<pnext-suspense>` path.
function inlineSuspenseRange(
  doc: Document,
): { anchor: Element; nodes: Node[]; hole: Element } | null {
  // A loading.js hole carries the depth attribute the renderer lifted onto it; prefer it over
  // an app `<Suspense>` hole exactly as the marker wire form prefers its stamped marker.
  const hole =
    doc.querySelector(`pnext-hole[data-pnext-hole][${LOADING_DEPTH_ATTRIBUTE}]`) ??
    doc.querySelector('pnext-hole[data-pnext-hole]')
  if (!hole?.parentElement) return null
  return { anchor: hole.parentElement, nodes: [...hole.childNodes], hole }
}

/** Exported for the DOM-level unit test (see `paintStaticStageSubtree`). */
export function showLoadingShell(
  shellHtml: string,
  sequence: number,
  target: URL,
  predictedRoute?: LoadingShellPrediction['route'],
  /**
   * Paint even when the markup carries NO loading boundary: a cached static segment is the
   * route's real content, not a fallback, and refusing to paint it leaves the departing
   * page on screen for the whole dynamic-stage request. Also marks the paint as a STATIC
   * STAGE so its fallbacks are unwrapped - committed content carries no stream wrappers.
   */
  allowWithoutBoundary = false,
  /** The shell came from this navigation's live response at its commit boundary. */
  allowResponseSuspense = false,
) {
  if (sequence !== navigationSequence) return false
  if (typeof DOMParser === 'undefined') return false
  const paintHold = document.querySelector<HTMLElement>('[data-pnext-navigation-paint-hold]')
  const doc = new DOMParser().parseFromString(shellHtml, 'text/html')
  materializeClientIslandMarkers(doc)
  // A STATIC STAGE owns whatever chunks streamed with it, so resolve them before picking what
  // to paint - `paintStaticStageSubtree` already does, and painting the fallback of a boundary
  // whose content is right there would put a placeholder on screen for content we hold.
  if (allowWithoutBoundary || allowResponseSuspense) materializeStreamedSegments(doc)
  // A shell can carry markers for BOTH a loading.js boundary and the app's own
  // `<Suspense>`; prefer the loading.js one. Cached shells require that explicit route boundary,
  // while a live response paints any hole still pending when its shell commits.
  const marker =
    doc.querySelector(`pnext-suspense[data-pnext-suspense][${LOADING_DEPTH_ATTRIBUTE}]`) ??
    doc.querySelector('pnext-suspense[data-pnext-suspense]')
  const inline = marker ? null : inlineSuspenseRange(doc)
  const suspense = marker ?? inline?.anchor
  if (!suspense && !allowWithoutBoundary) return false
  // Either wire form can carry the loading.js stamp; the hole is the inline form's marker.
  const boundary = marker ?? inline?.hole ?? null
  const loadingBoundary = isLoadingBoundaryMarker(boundary)
  if (!allowWithoutBoundary && !loadingBoundary && !allowResponseSuspense) {
    return false
  }
  if (!loadingBoundaryChanges(boundary, target)) return false
  const { container: slotContainer, markerRange } = loadingShellTarget()
  // `loadingShellTarget` degrades to <body> when the live document has no page slot - what a
  // CLIENT layout leaves behind, its slot markers consumed by the Preact render. Painting there
  // replaces the WHOLE live body with an inert copy: no preserved islands, no reused layout DOM.
  // When the incoming slot sits inside an island the live document also mounts, the paint IS
  // scopable after all - graft through that island (searchparams-reuse-loading reuses a
  // prefetched loading state under a client layout). Otherwise wait for the payload, which
  // grafts through `swapBody` with island preservation intact.
  const scopedOwner =
    !markerRange && slotContainer === document.body
      ? liveOwnerOfIncomingSlot(doc, boundary ?? suspense ?? null)
      : null
  if (!markerRange && slotContainer === document.body && !scopedOwner) return false
  const container = scopedOwner ?? slotContainer
  const fragment = document.createDocumentFragment()
  // The streamed document can already contain an ancestor layout that resolved before the
  // loading boundary. Keep that prefix when painting the fallback: replacing the target
  // with only the suspense children loses the eagerly prefetched layout.
  const incomingTarget =
    (markerRange ? doc.getElementById('pnext-page') : null) ??
    (container.id ? doc.getElementById(container.id) : null) ??
    doc.querySelector('[data-pnext-root]') ??
    (container === document.body ? doc.body : null)
  const sourceNodes = incomingTarget
    ? [...incomingTarget.childNodes]
    : inline
      ? // The inline anchor is whatever element holds the markers (often <body>);
        // only the fallback BETWEEN them is this boundary's content.
        inline.nodes
      : suspense
        ? [...(suspense.closest('pnext-layout[data-pnext-segment]') ?? suspense).childNodes]
        : // Boundary-free markup with no page container to copy from: there is
          // nothing this paint could put on screen.
          null
  if (!sourceNodes) return false
  // A painted loading shell IS a committed navigation (pushOptimisticUrl moves the address
  // bar the instant this returns true), so the window route state must reflect the
  // DESTINATION before any island reads useParams - otherwise usePathname and useParams
  // diverge and a history entry captures the new URL with the OLD params.
  const shellRoute = predictedRoute ?? documentRouteState(doc)
  if (shellRoute) window.__PNEXT_ROUTE__ = shellRoute
  // Past every bailout: this paint puts the destination on screen and commits the
  // navigation, so its sheets go in with it rather than waiting for the payload.
  void installStylesheets(doc)
  for (const node of sourceNodes) fragment.append(document.importNode(node, true))
  // A STATIC STAGE paints committed content, so its fallbacks land bare — the
  // wrappers are stripped from the COPY (the source doc keeps them, so the
  // boundary lookups above stay valid).
  if (allowWithoutBoundary) unwrapSuspenseFallbacks(fragment)
  // A CLIENT root layout owns the paint target: the page container sits inside a mounted
  // island's Preact tree, which still points at the DOM nodes about to be replaced.
  // Overwriting them behind Preact's back desynchronizes the live tree, so every later
  // render patches detached nodes. Re-render the island with the shell as its incoming
  // children instead - the same graft the final commit uses.
  const liveOwner = liveIslandOwner(container)
  const incomingOwner = liveOwner && incomingIslandFor(doc, liveOwner)
  if (liveOwner && incomingOwner) liveOwner.__pnextIncoming = incomingOwner
  else if (markerRange) {
    for (const node of markerRange[2]) node.remove()
    markerRange[0].after(fragment)
  } else container.replaceChildren(fragment)
  // Any painted shell can carry islands (a loading fallback that calls
  // useOffline(), say), and an unmounted island keeps its SSR value forever.
  // mountRoute is idempotent, so mounting on every paint is safe.
  mountPaintedIslands(doc)
  if (paintHold) document.body.append(paintHold)
  return true
}

/**
 * The nearest mounted island root that OWNS `node`'s DOM - the Preact tree a raw DOM
 * replacement here would invalidate. Null when nothing live owns it.
 */
function liveIslandOwner(node: Element): LiveIslandRoot | null {
  const root: LiveIslandRoot | null = node.closest('pnext-client[data-pnext-client]')
  return root?.__pnextLive ? root : null
}

/**
 * The MOUNTED island that owns the incoming document's page slot, when the live document
 * mounts the same one. It is the paint target a consumed slot leaves behind: the shell
 * re-renders through the island rather than over the whole body.
 */
function liveOwnerOfIncomingSlot(doc: Document, boundary: Element | null): LiveIslandRoot | null {
  // A shell that suspended ABOVE its page slot ships no slot at all - the slot rides in the
  // resolved chunk. The boundary itself then names the island the paint belongs to.
  const incoming = (doc.getElementById('pnext-page') ?? boundary)?.closest(
    'pnext-client[data-pnext-client]',
  )
  const id = incoming?.getAttribute('data-pnext-client')
  if (!id) return null
  const live: LiveIslandRoot | null = document.querySelector(
    `pnext-client[data-pnext-client="${CSS.escape(id)}"]`,
  )
  return live?.__pnextLive ? live : null
}

/** `live`'s counterpart in an incoming document, matched on island id. */
function incomingIslandFor(doc: Document, live: LiveIslandRoot): Element | null {
  const id = live.getAttribute('data-pnext-client')
  if (!id) return null
  return doc.querySelector(`pnext-client[data-pnext-client="${CSS.escape(id)}"]`)
}

/** Mount the islands of a just-painted document fragment (idempotent). */
function mountPaintedIslands(doc: Document) {
  const entrySrc = entryScriptSrc(doc)
  if (!entrySrc) return
  const warmed = entryModuleCache.get(entryModuleHref(entrySrc))
  if (warmed) void warmed.mountRoute?.()
  else void importEntry(entrySrc).then(entry => entry?.mountRoute?.())
}

/**
 * Commit a cached STATIC STAGE into the live document while the dynamic stage is still in
 * flight.
 *
 * `showLoadingShell` grafts the incoming page slot's CHILDREN over the live one, which
 * cannot express a destination whose static content lives OUTSIDE that slot (a static
 * layout the live tree never rendered, a parallel-route slot beside the page) - those nodes
 * would be dropped. When the incoming stage carries such structure, take the real graft
 * path instead: `swapBody`, so root-layout DOM identity survives.
 *
 * Exported for the DOM-level unit test.
 */
export function commitStaticStage(
  html: string,
  sequence: number,
  target: URL,
  /**
   * Whether the server declared this a postponed shell. Under cacheComponents, Next treats this
   * as the segment-cache commit and may paint its application fallback. Ordinary apps still need
   * destination content beside the holes or an explicit loading.js boundary.
   */
  postponedShell = false,
): boolean {
  if (sequence !== navigationSequence) return false
  // cacheComponents' postponed stage is a real segment-cache commit, including
  // an application Suspense fallback such as Next's mismatching-prefetch shell.
  // Ordinary apps retain the stricter rule that prevented their root splash
  // from painting merely because a shell arrived.
  if (!staticStageIsRealContent(html, postponedShell && activityBfcacheEnabled())) return false
  if (paintStaticStageSubtree(html)) return true
  return showLoadingShell(html, sequence, target, undefined, true)
}

/**
 * True when a cached static stage is the destination's REAL content rather than an app shell
 * still waiting on its holes. `allowWithoutBoundary` exists for the fully prerendered stage,
 * which carries no boundary at all; a stage whose page content is NOTHING but an unresolved
 * `<Suspense>` fallback is a placeholder the dynamic payload replaces, and only a `loading.js`
 * boundary may paint that early - exactly the rule the loading-shell path applies.
 *
 * A partially static stage - real content BESIDE its holes - is the destination's prerendered
 * output, which Next paints as soon as it has it (segment-cache "serves cached static segments
 * instantly on the second navigation").
 */
function staticStageIsRealContent(html: string, trustedPostponedShell = false): boolean {
  // Cheap reject: no boundary wire form in the markup means nothing is unresolved.
  if (!html.includes('data-pnext-suspense') && !html.includes('data-pnext-hole')) return true
  if (trustedPostponedShell) return true
  if (typeof DOMParser === 'undefined') return true
  const doc = new DOMParser().parseFromString(html, 'text/html')
  materializeClientIslandMarkers(doc)
  // Boundaries whose chunk already streamed resolve here; whatever marker survives is a hole
  // the dynamic stage still owes.
  materializeStreamedSegments(doc)
  // A hole stamped with the loading depth is a loading.js boundary, which may paint here for
  // the same reason its marker form may: it is the wait Next itself shows.
  const unresolved = [
    ...doc.querySelectorAll(`pnext-hole[data-pnext-hole]:not([${LOADING_DEPTH_ATTRIBUTE}])`),
    ...[...doc.querySelectorAll('pnext-suspense[data-pnext-suspense]')].filter(
      marker => !isLoadingBoundaryMarker(marker),
    ),
  ]
  return unresolved.length === 0 || stageCarriesContentBesideHoles(doc)
}

/** Elements that carry no page content of their own: wire hosts and document plumbing. */
const STAGE_STRUCTURAL_ELEMENTS = new Set([
  'script',
  'template',
  'style',
  'link',
  'pnext-suspense',
  'pnext-hole',
])

/**
 * True when the stage renders something of the destination's own OUTSIDE its unresolved
 * boundaries - the partially static (PPR) shape. A stage whose page slot holds only boundary
 * fallbacks is an app shell and keeps waiting.
 */
function stageCarriesContentBesideHoles(doc: Document): boolean {
  const pageSlot = doc.getElementById('pnext-page')
  if (
    !pageSlot &&
    doc.querySelector(
      'pnext-client :is(pnext-hole[data-pnext-hole],pnext-suspense[data-pnext-suspense])',
    )
  ) {
    // A boundary above the page slot postpones the client root that owns the page itself.
    // Wrapper/static-child markup around that hole is not an independently paintable PPR
    // segment; the page slot only materializes with the continuation.
    return false
  }
  const slot = pageSlot ?? doc.body
  if (!slot) return false
  for (const element of slot.querySelectorAll('*')) {
    if (STAGE_STRUCTURAL_ELEMENTS.has(element.localName)) continue
    if (element.closest('pnext-suspense[data-pnext-suspense], pnext-hole[data-pnext-hole]'))
      continue
    return true
  }
  return false
}

/**
 * Replace every `<pnext-suspense>` fallback wrapper with the fallback itself. The renderer
 * wraps a boundary's fallback so the streaming runtime can promote the resolved chunk over
 * it; a painted STATIC STAGE has no stream to promote, and the wrapper would sit INSIDE the
 * app's own elements where the app reads them. The dynamic stage swaps in its own markers,
 * so nothing downstream depends on the ones dropped here. Exported for the unit test.
 */
function unwrapSuspenseFallbacks(root: ParentNode): void {
  for (const marker of [...root.querySelectorAll('pnext-suspense[data-pnext-suspense]')]) {
    // The postponed boundary's static skeleton (`renderStaticSkeleton`) is inert
    // markup that belongs to the WRAPPER, not to the app. Unwrapping would
    // promote it into the app's own element, where the suites read it.
    for (const skeleton of [...marker.querySelectorAll('template[data-pnext-static]')]) {
      if (skeleton.parentNode === marker) skeleton.remove()
    }
    marker.replaceWith(...marker.childNodes)
  }
}

/**
 * Graft a static stage that changes the tree AROUND the page slot into the live document,
 * returning false when a page-slot-only paint is enough (the caller then falls back to
 * `showLoadingShell`). Exported for the DOM-level unit test.
 */
export function paintStaticStageSubtree(html: string): boolean {
  if (typeof DOMParser === 'undefined') return false
  const paintHold = document.querySelector<HTMLElement>('[data-pnext-navigation-paint-hold]')
  const doc = new DOMParser().parseFromString(html, 'text/html')
  if (!isPNextDocument(doc)) return false
  // Materialize BEFORE comparing structure: the renderer ships the page slot (and
  // every island) as comment markers, so `#pnext-page` does not exist until this
  // pass expands them — and the frame comparison is keyed on that element.
  materializeClientIslandMarkers(doc)
  materializeStreamedSegments(doc)
  if (!staticStageFrameGrows(doc)) return false
  // This paint COMMITS the navigation, so the destination's sheets belong on the document
  // now; the commit below re-reads them from its own doc and waits out these loads.
  void installStylesheets(doc)
  unwrapSuspenseFallbacks(doc)
  // A painted static stage IS a committed navigation (see showLoadingShell):
  // the window route state must describe the destination before any island
  // reads useParams.
  const shellRoute = documentRouteState(doc)
  if (shellRoute) window.__PNEXT_ROUTE__ = shellRoute
  // Keep the DEPARTING render's `#__PNEXT_NAV_STATE__` on the live document. This paint
  // happens BEFORE the dynamic-stage request goes out, and both that request's
  // `next-router-state-tree` and the commit's slot comparison read the state script off the
  // live DOM: swapping in the destination's would announce the navigation as already
  // committed, leaving the static stage's fallbacks on screen forever.
  const incomingState = doc.getElementById('__PNEXT_NAV_STATE__')
  const liveState = document.getElementById('__PNEXT_NAV_STATE__')
  if (liveState) {
    if (incomingState) incomingState.replaceWith(doc.importNode(liveState, true))
    else doc.body.append(doc.importNode(liveState, true))
  }
  // No preserved islands/segments: this paint happens mid-navigation, before the departing
  // entry unmounts, so nothing may claim live island roots yet - the final commit does that
  // against the tree painted here. `swapBody`'s own body-child reuse still applies.
  swapBody(doc)
  mountPaintedIslands(doc)
  if (paintHold) document.body.append(paintHold)
  return true
}

/**
 * True when the incoming document's page slot sits inside structure the live document does
 * not have - a layout segment or parallel-route slot the live tree never rendered. Strictly
 * one-directional: structure the LIVE tree has and the incoming markup lacks proves nothing,
 * since a static stage is a truncated stream.
 */
function staticStageFrameGrows(doc: Document): boolean {
  const incoming = staticStageFrame(doc)
  const live = staticStageFrame(document)
  if (!incoming || !live) return false
  for (const descriptor of incoming) if (!live.has(descriptor)) return true
  return false
}

/** Elements that carry no structural meaning for the frame comparison. */
const FRAME_IGNORED_ELEMENTS = new Set([
  'script',
  'style',
  'link',
  'template',
  'next-route-announcer',
])

/**
 * Structural skeleton of everything AROUND `#pnext-page`: the layout segments that wrap it
 * plus the siblings at every level up to <body>. Deliberately content-free - only the
 * presence of layouts/slots decides how to paint.
 */
function staticStageFrame(doc: Document): Set<string> | null {
  const page = doc.getElementById('pnext-page')
  if (!page || !doc.body) return null
  const frame = new Set<string>()
  for (let node: Element | null = page; node && node !== doc.body; node = node.parentElement) {
    const parent: Element | null = node.parentElement
    if (!parent) break
    if (node !== page) frame.add(frameDescriptor(node))
    for (const sibling of [...parent.children]) {
      if (sibling === node) continue
      addFrameDescriptors(frame, sibling)
    }
  }
  return frame
}

function addFrameDescriptors(frame: Set<string>, element: Element): void {
  if (FRAME_IGNORED_ELEMENTS.has(element.localName)) return
  frame.add(frameDescriptor(element))
  for (const nested of element.querySelectorAll(
    'pnext-layout[data-pnext-segment], [data-pnext-slot]',
  )) {
    frame.add(frameDescriptor(nested))
  }
}

function frameDescriptor(element: Element): string {
  return [
    element.localName,
    element.id,
    element.getAttribute('data-pnext-segment') ?? '',
    element.getAttribute('data-pnext-scope') ?? '',
    element.getAttribute('data-pnext-slot') ?? '',
  ].join('\0')
}

/** Attribute the renderer stamps with a loading boundary's guarded URL depth. */
const LOADING_DEPTH_ATTRIBUTE = 'data-pnext-loading-depth'

/**
 * True when a shell's boundary is a `loading.js` one — the ONLY boundary Next may swap in
 * before the navigation payload lands. The renderer stamps the URL depth on exactly those
 * markers, so the attribute IS the signal: a plain `<Suspense>` the app wrote in a layout
 * (or in the page) carries none, and its fallback belongs to the incoming render, not to
 * the wait for it. Painting one over the departing page empties the body a whole request
 * early, where Next keeps the previous route interactive.
 *
 * The inline-suspense wire form (`<pnext-hole>`, rewritten from preact's stream comments)
 * gets the same stamp lifted onto it from the fallback's leading depth marker, so a
 * loading.js boundary proves itself in both wire forms; an app `<Suspense>` in either
 * carries nothing and never paints a fallback.
 */
function isLoadingBoundaryMarker(marker: Element | null): boolean {
  return marker?.hasAttribute(LOADING_DEPTH_ATTRIBUTE) === true
}

/**
 * True when the loading boundary carried by a shell owns a segment INSIDE the subtree this
 * navigation changes, so its fallback may paint. A loading.js boundary re-arms only when
 * the segment it directly guards changes; the server stamps each boundary's URL depth on
 * its marker, and when the live and target children paths diverge DEEPER than that the
 * boundary belongs to a preserved shared ancestor and painting it would flash a loading
 * state Next never shows. A STATIC STAGE paints committed content rather than a fallback,
 * so its (possibly absent) marker imposes no such gate.
 */
function loadingBoundaryChanges(marker: Element | null, target: URL): boolean {
  const raw = marker?.getAttribute(LOADING_DEPTH_ATTRIBUTE)
  if (raw === null || raw === undefined) return true
  const depth = Number.parseInt(raw, 10)
  if (!Number.isFinite(depth)) return true
  const previous = (currentNavState().children ?? location.pathname).split('/').filter(Boolean)
  const next = target.pathname.split('/').filter(Boolean)
  // Same path (refresh/search-only nav): every boundary is in scope.
  if (previous.join('/') === next.join('/')) return true
  let divergence = 0
  const shared = Math.min(previous.length, next.length)
  while (divergence < shared && previous[divergence] === next[divergence]) divergence++
  return divergence <= depth
}

// Choosing the document a navigation commits: cache hit, in-flight prefetch,
// segment reuse or a fresh fetch — and recording what the answer taught us.

/**
 * How long a navigation may wait on a prefetch that has not landed yet. pnext attaches to
 * in-flight prefetches to avoid a duplicate request, but must never wait forever - a
 * partial prefetch of a route with an unresolvable Suspense boundary never responds, and
 * blocking on it would leave the click with no loading shell and no history push.
 */
const UNSETTLED_PREFETCH_WAIT_MS = 300

/** Resolves `null` once an in-flight prefetch has waited long enough. */
function unsettledPrefetchDeadline(): Promise<null> {
  return new Promise(resolve => setTimeout(() => resolve(null), UNSETTLED_PREFETCH_WAIT_MS))
}

async function pageForNavigation(
  url: URL,
  options: SoftNavigateOptions = {},
  onShell?: (shellHtml: string) => void,
  /**
   * Paint a cached STATIC STAGE into the live page before the dynamic-stage request goes
   * out. Unlike `onShell` this markup is not a loading fallback but the route's real static
   * content, so it paints with or without a boundary.
   */
  onStaticStage?: (html: string, postponedShell?: boolean) => void,
  /** The segment-cache hit `softNavigate` already looked up for this URL. */
  segmentHit?: SegmentCacheHit | null,
  /**
   * The parallel-route state the navigation STARTED from, captured before any optimistic
   * paint could swap the live one. Cached entries are matched against it, never the live one.
   */
  departureNavState: DocumentNavState = currentNavState(),
  /** The rendered origin route; unlike location this still names the departure on popstate. */
  departureUrl: string = locationKey(),
  /**
   * This navigation may ask for the `/_page` frame alone when the policy says the layout
   * chain is already in hand. Decided by `softNavigate` (it owns the departing URL/state)
   * and still gated by the policy itself below.
   */
  pageFrame: { eligible: boolean; sameUrl: boolean } = { eligible: false, sameUrl: false },
) {
  const key = url.pathname + url.search
  const now = clientClockNow()
  // At most one static stage paints per navigation: an attached prefetch's
  // shell and a segment-cache hit are two views of the same content.
  let staticStagePainted = false
  const paintStaticStage = (html: string, postponedShell = false) => {
    if (staticStagePainted) return
    staticStagePainted = true
    // A cached stage with parallel slots has dynamic continuations beside the page. Those cannot
    // be reconstructed from a page-only frame, so this navigation needs the whole target document.
    if (html.includes('data-pnext-slot=') || slotStateSensitive(departureNavState, html))
      pageFrame.eligible = false
    onStaticStage?.(html, postponedShell)
  }
  const cached = prefetchEntriesForNavigation(key).find(
    entry =>
      entryMatchesNavState(entry, departureNavState) &&
      (!entry.settled || now - entry.time < entry.staleTimeMs),
  )
  // Popstate restores a history entry's own parallel-route state; a prefetched response was
  // rendered against the pre-navigation state and may not match, so back/forward always
  // fetches. A refresh bypasses the cache entirely.
  if (cached && !options.pop && !options.refreshLike) {
    // A still-pending exact-URL prefetch must not block the navigation when a fresh, fully
    // prerendered document for the SAME pathname is already cached: a static prerender never
    // rendered search params server-side, so only the client-visible URL differs.
    if (!cached.settled) {
      const shared = await samePathnamePrerenderedPage(url, now, departureNavState)
      if (shared) return shared
    }
    // Reuse within the staleTime window (the entry is kept warm, not one-shot). A failed
    // entry is dropped. A shell-only (partial prefetch) entry never commits as a document -
    // its loading shell was painted above; fall through to the real fetch.
    // A full (`prefetch={true}`) prefetch is a complete document for this navigation:
    // attach to it on its own settle signal (cancel/error resolve null), never a wall
    // clock - a slow machine must not make the router duplicate the request.
    const page =
      cached.settled || cached.full
        ? await cached.page
        : await Promise.race([cached.page, unsettledPrefetchDeadline()])
    if (page && !page.shellOnly) return page
    // Attached to an in-flight (or already settled) SHELL prefetch for this exact target:
    // the navigation issued no duplicate fetch, so paint the static stage it landed and let
    // the dynamic stage stream in below.
    // A shell-only prefetch IS the server's postponed shell for this URL (its headers are what
    // `shellOnly` reads), so it paints like the PPR stage it is.
    if (page?.shellOnly) paintStaticStage(page.html, true)
    if (!page) {
      for (const full of [true, false]) {
        const cacheKey = prefetchCacheKey(key, full)
        if (prefetchCache.get(cacheKey)?.page === cached.page) prefetchCache.delete(cacheKey)
      }
    }
  } else {
    for (const full of [true, false]) {
      const cacheKey = prefetchCacheKey(key, full)
      const entry = prefetchCache.get(cacheKey)
      if (entry && now - entry.time >= entry.lifetimeMs) prefetchCache.delete(cacheKey)
    }
  }
  // Segment cache: a complete (non-PPR) route body prefetched via the segment protocol
  // commits without a second request. Search-param independent, so `?a` reuses a `?b`
  // prefetch. Everything below is keyed by PATHNAME alone, so none of it may commit for a
  // navigation whose parallel-route slots the server has to resolve - a cached document
  // encodes one particular slot resolution.
  const navState = departureNavState
  if (!options.pop && !options.refreshLike && !slotStateSensitive(navState)) {
    // Per-segment (vary-params) cache first: it can serve a URL whose params the cached
    // segment provably never read. Network-free commit is EXACT-URL only (takeSegment
    // enforces !shared) and requires a complete+static or complete-runtime entry; a
    // cross-URL shared hit is PAINTED below and the dynamic stage still fetched.
    if (segmentHit?.networkFree && !slotStateSensitive(navState, segmentHit.html)) {
      return { html: segmentHit.html, finalUrl: url.href, ok: true }
    }
    const body = takeSegmentBody(url.pathname)
    if (body && !slotStateSensitive(navState, body)) {
      return { html: body, finalUrl: url.href, ok: true }
    }
    // No entry for this exact URL: a fresh fully-prerendered document for the
    // same pathname (different search params) still commits without a fetch.
    const shared = await samePathnamePrerenderedPage(url, now, departureNavState)
    if (shared && !slotStateSensitive(navState, shared.html)) return shared
  }
  // Partial paint (Segment-M2 fix-forward 1): a cached static segment that may
  // NOT commit on its own still paints now, so the route's static content is on
  // screen while the dynamic stage below streams the remainder in.
  if (segmentHit && !segmentHit.networkFree)
    paintStaticStage(segmentHit.html, segmentHit.postponedShell === true)
  // Per-segment navigation: `/_page` alone, composed with the cached layout.
  // Null (policy declined, miss, anything unexpected) falls through to the
  // whole-document fetch below unchanged.
  const framed = pageFrame.eligible
    ? await fetchPageFrameNavigation(url, {
        navState: options.navState ?? departureNavState,
        sameUrl: pageFrame.sameUrl,
        fromUrl: departureUrl,
      }).catch(() => null)
    : null
  const page =
    framed ??
    (await fetchPage(url.href, {
      navState: options.navState ?? departureNavState,
      fromUrl: departureUrl,
      onShell,
    }).catch(() => null))
  // Visited-page seeding: the navigation response is as fresh as any prefetch —
  // seed the cache so an immediate return visit within the data window commits
  // without a fetch (Next seeds its router cache from navigations the same way).
  if (page?.ok) seedNavigationEntry(key, url.pathname, page, options.navState)
  return page
}

/**
 * A fresh, settled, fully-prerendered document cached for `url.pathname` under a DIFFERENT
 * search, reusable for a navigation to `url`. Only static prerenders qualify: they never
 * rendered search params on the server, so the committed document is byte-correct for any
 * search. Returned with `finalUrl` rewritten so history shows the navigated params.
 */
async function samePathnamePrerenderedPage(
  url: URL,
  now: number,
  navState: DocumentNavState = currentNavState(),
): Promise<PrefetchedPage | null> {
  const state = navState
  const exactKey = url.pathname + url.search
  for (const [cacheKey, entry] of prefetchCache) {
    if (!entry.settled) continue
    if (now - entry.time >= entry.staleTimeMs) continue
    const keyPart = cacheKey.slice(0, cacheKey.indexOf('\u0000'))
    if (keyPart === exactKey) continue
    const queryIndex = keyPart.indexOf('?')
    const pathname = queryIndex === -1 ? keyPart : keyPart.slice(0, queryIndex)
    if (pathname !== url.pathname) continue
    if (!entryMatchesNavState(entry, state)) continue
    const page = await entry.page
    if (!page || page.shellOnly || page.segmentPrerendered !== true) continue
    // A rewrite-produced document may map a different search to a different destination (a
    // proxy rewrite can key on the query). This branch is reached only for a DIFFERENT
    // search of the same pathname, so a rewrite entry must never reuse here.
    if (isRewriteDocument(page.html, url.pathname)) continue
    return { ...page, finalUrl: url.href }
  }
  return null
}

/** True when a fresh full-document cache entry will serve this navigation. */
function hasFreshDocument(url: URL): boolean {
  return prefetchEntriesForNavigation(url.pathname + url.search).some(
    cached =>
      // An unsettled entry is NOT a fresh document yet: its fetch may hang arbitrarily long
      // (dynamic page mid-stream), and the loading shell must paint instead of the
      // navigation blocking bare.
      cached.settled &&
      !cached.shellOnly &&
      clientClockNow() - cached.time < cached.staleTimeMs &&
      entryMatchesNavState(cached, currentNavState()),
  )
}

// Seed the prefetch cache from a navigation (or hard-load) response. Only a FULLY STATIC
// (prerendered) document is seeded as a whole-document entry: a postponed/partial/dynamic
// response is request data, and seeding it would let every later navigation replay the
// stale document network-free instead of taking the paint-then-stream path. Such a response
// still feeds the loading-shell and per-segment caches below, which model partial content
// correctly (an incomplete entry paints and STILL fetches the dynamic stage).
function seedNavigationEntry(
  key: string,
  pathname: string,
  page: PrefetchedPage,
  navState?: DocumentNavState,
  /** Pre-hydration static stage of a hard-loaded document, when one was stashed. */
  staticStage?: string,
  /** This is the INITIAL hard-loaded document, not a navigation response. */
  hardLoad = false,
) {
  const staleTimeMs = prefetchStaleTimeMs({ headerStaleTimeSeconds: page.staleTimeSeconds })
  const seedState = navState ?? currentNavState()
  // `output: 'export'`: a visited route is NOT a prefetched one. With no server to negotiate
  // a delta with, a link prefetch always reads the route's artifact off the static host, so
  // seeding the document entry here would make a link back to an already-visited route
  // resolve network-free and prefetch nothing. The shell/segment caches below are still
  // seeded, so the navigation itself stays instant. A DYNAMIC render is seedable, but only
  // when the app opted into a non-zero `staleTimes.dynamic` window (Next's default is 0).
  const dynamicSeedAllowed =
    page.shellOnly !== true &&
    staleTimeMs > 0 &&
    prefetchStaleTimeMs({}) > 0 &&
    !page.html.includes(SKIP_MARKER)
  // `prefetch = 'allow-runtime'`: a visited document of such a route is request data with
  // the dynamic holes already filled in. Keeping it reusable would commit a later navigation
  // network-free off content the route promises to re-sample. Only its runtime-prefetch
  // shell is a reusable payload.
  if (
    exportDocumentFetcher === undefined &&
    !(hardLoad && htmlRuntimePrefetch(page.html)) &&
    (page.segmentPrerendered === true || dynamicSeedAllowed)
  ) {
    prefetchCache.set(prefetchCacheKey(key, false), {
      time: clientClockNow(),
      page: Promise.resolve(page),
      staleTimeMs,
      // Unlike a prefetch, a seeded visit does not pin a warm shell entry for the
      // whole static window: its lifetime is its data window, so a visible link
      // to it re-prefetches once the data expires (renewing the window).
      lifetimeMs: staleTimeMs,
      full: false,
      stateKey: navStateKey(seedState),
      slotsKey: slotsStateKey(seedState.slots ?? {}),
      // An interception host render is bound to its host — never origin-agnostic,
      // and tagged so a DIRECT render of the same URL never serves a navigation
      // that should intercept (nor vice versa). See `entryMatchesNavState`.
      intercepted: pageIsHostRender(page),
      // A hard load (or complete DIRECT nav response) seeds a document any origin
      // can reuse — Next seeds its router cache the same way, origin-independent.
      originAgnostic:
        page.shellOnly !== true && !page.html.includes(SKIP_MARKER) && !pageIsHostRender(page),
      settled: true,
      onInvalidate: [],
    })
  }
  // An `allow-runtime` route's document shell is not a loading shell: the server samples the
  // request BEFORE the first flush, so the sliced shell carries resolved runtime content.
  // Serving it as a shellCache "loading state" would keep painting request-sampled data for
  // the static window; the per-segment record below caps it at the runtime threshold.
  if (!htmlRuntimePrefetch(page.html)) {
    storeShell(pathname, page, seedState, key.slice(pathname.length))
  }
  recordNavigationSegment(pathname, key.slice(pathname.length), page, staticStage, hardLoad)
  trimPrefetchCache()
}

/**
 * The document's own PRE-HYDRATION shell, stashed by the document bootstrap before island
 * hydration (or by the streaming runtime if a continuation promotes first). `captureHardLoad`
 * otherwise sees the LIVE DOM at the load event - after every
 * streamed chunk has been promoted over its fallback - so a PPR document reads back as
 * settled and `sliceShell` finds no cut.
 */
function preHydrationShell(): string | undefined {
  const stashed = (window as { __PNEXT_SHELL_HTML__?: string }).__PNEXT_SHELL_HTML__
  // If a promotion script won the capture race, one or more dynamic continuations already sit in
  // the markup. Those carry the loaded URL's resolved content, so anything replaying this stage -
  // a sibling param reusing it across an empty vary set - would paint that URL's data. Drop any
  // carriers; the document-bootstrap zero-stream case simply has none.
  return stashed && stripStreamChunks(stashed)
}

/** `html` without the hidden `<div data-pnext-stream>` carriers of its streamed continuations. */
function stripStreamChunks(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const chunks = doc.querySelectorAll('div[hidden][data-pnext-stream]')
  if (!chunks.length) return html
  for (const chunk of chunks) chunk.remove()
  return `<!doctype html>${doc.documentElement.outerHTML}`
}

/**
 * Feed the per-segment policy from a NAVIGATION response or the initial hard-loaded
 * document. Prefetches are recorded from their framed segment payload in `fetchPage`; these
 * are whole documents, so the STATIC STAGE has to be sliced out of the streamed markup:
 *
 *  - a document that streamed a continuation caches its SHELL as an incomplete entry: the
 *    next navigation paints it and still fetches the dynamic stage;
 *  - a settled document caches whole, but only when the route is STATIC. A dynamic document
 *    is request data, never an entry a later navigation may commit network-free.
 *
 * `staticStage` overrides the slice for the hard-loaded document, whose live markup no
 * longer shows the cut (see `preHydrationShell`).
 */
function recordNavigationSegment(
  pathname: string,
  search: string,
  page: PrefetchedPage,
  staticStage?: string,
  /** This is the INITIAL hard-loaded document, not a navigation response. */
  hardLoad = false,
): void {
  if (!segmentCachePolicy || !page.ok) return
  // Only a document ANY origin could reuse becomes a segment entry - the same bar
  // `originAgnostic` sets. A shared-layout-skipped render is incomplete without the live DOM
  // it grafts onto, and an interception host render is bound to the origin that intercepted.
  if (page.html.includes(SKIP_MARKER) || pageIsHostRender(page)) return
  // This document's LAYOUT frame, filed before any of the staleness/staticness gates below -
  // those decide whether the PAGE content is reusable, a different question from whether the
  // layout chain is still the one on screen. It takes the static reuse window rather than
  // the (frequently zero) window of the page's own data.
  segmentCachePolicy.recordDocumentLayout?.({
    pathname,
    search,
    html: page.html,
    staleTimeMs: shellStaleTimeMs(),
  })
  // `prefetch = 'allow-runtime'`: a whole DOCUMENT of this route has no shareable static
  // stage. Slicing one yields the page's Suspense FALLBACKS (the sampled content sits below
  // them), and filing that under this URL's exact key would beat the runtime-prefetch entry -
  // the only payload carrying the sampled content - on every later lookup.
  const runtimeDocument = htmlRuntimePrefetch(page.html)
  if (hardLoad && runtimeDocument) return
  const hint = documentStaticHintFromHtml(page.html)
  const shell = staticStage ?? sliceShell(page.html, page.shellOnly === true)
  // A document resumed from a BAKED SHELL is a prerender, and the server published that
  // shell's vary set alongside the flag, so the entry keys across the route's params. Both
  // halves are required: the flag alone (with no stage in hand) proves nothing, and a stage
  // without it is a sliced dynamic stream. The stage is whichever the router holds - a hard
  // load's stashed pre-hydration prefix, or the slice of a streamed navigation response,
  // which cuts at exactly the boundary the server postponed at. The entry stays INCOMPLETE,
  // so a navigation onto it still fetches its own dynamic remainder.
  const bakedStaticStage = (staticStage ?? shell) !== null && hint?.staticStage === true
  const isStatic = page.segmentPrerendered === true || hint?.isStatic === true || bakedStaticStage
  if (shell === null && !isStatic) return
  const staleTimeMs = prefetchStaleTimeMs({
    headerStaleTimeSeconds: page.staleTimeSeconds ?? hint?.staleTime,
    // A static stage recorded off a navigation reuses for the window the route
    // itself reported, never a wider one: the fast-forward past that window has
    // to evict the entry, or the expired static stage keeps painting.
    static: isStatic,
    // A SOFT-NAV document of an `allow-runtime` route: its header reports the route's PUBLIC
    // cache window, but the content is request-sampled (the private/runtime caches resolve
    // after headers flush). The compat policy caps the entry at the runtime threshold.
    runtimeDocument,
  })
  // The route TREE this navigation just proved (its SHAPE, not its data) is reusable by a
  // later prefetch of the same URL and of the route's siblings. Its route resolves lazily
  // from the segment record below. Keyed with the SEARCH it was proved for: a different
  // query is a different tree negotiation.
  learnRouteTree(pathname, search)
  // A dynamic (zero-window) entry would be stale the instant it is written.
  if (staleTimeMs <= 0) return
  segmentCachePolicy.record({
    pathname,
    search,
    segmentPath: INDEX_SEGMENT_PATH,
    kind: 'document',
    body: page.html,
    html: shell ?? page.html,
    staleTimeMs,
    complete: shell === null,
    static: isStatic,
    runtime: false,
    postponedShell: bakedStaticStage,
  })
}

// NAV STATE - reading parallel-route state off a document, and deciding whether a cached
// prefetch entry was rendered against a state a navigation can reuse.

/** Server-skipped shared-layout marker — such a document is origin-bound. */
const SKIP_MARKER = 'data-pnext-skip'

/**
 * A navigation issued from a HOST page (one rendering parallel-route slots) may be
 * intercepted by the server into a parallel slot - a decision the client cannot make
 * locally. A DIRECT full-page cache entry must therefore not be reused via the
 * origin-agnostic slot-only match for such a navigation, or the interception would be
 * silently skipped. Force a fetch so the server intercepts.
 */
function isHostPageNavState(state: DocumentNavState): boolean {
  return Object.keys(state.slots ?? {}).length > 0
}

/**
 * A document that renders parallel-route slots - either the one being LEFT or the CACHED
 * target - must be re-resolved by the server, never committed from a pathname-keyed cache:
 * slot content is decided from `x-pnext-nav-state`, which such a cache does not key on.
 */
function slotStateSensitive(state: DocumentNavState, cachedHtml?: string): boolean {
  if (isHostPageNavState(state)) return true
  return cachedHtml !== undefined && isHostPageNavState(htmlNavState(cachedHtml) ?? {})
}

/**
 * True when the entry may serve a navigation issued from nav state `state`.
 * Exported for unit testing (interception cache-pollution regression).
 */
export function entryMatchesNavState(entry: PrefetchEntry, state: DocumentNavState): boolean {
  if (entry.stateKey === navStateKey(state)) return true
  // Interception host renders are host-bound: they only serve their exact host
  // nav state (matched above), never the origin-agnostic slot-only fallback.
  if (entry.originAgnostic !== true || entry.intercepted === true) return false
  if (entry.slotsKey !== slotsStateKey(state.slots ?? {})) return false
  // A direct target render must not be reused for a navigation that could
  // intercept (issued from a host page) — the server decides interception.
  if (isHostPageNavState(state)) return false
  return true
}

/**
 * The nav state embedded in a rendered document's `__PNEXT_NAV_STATE__` script,
 * parsed from the raw HTML string (no DOM available at prefetch-settle time).
 * The server JSON-escapes `<` as `<`, so the script body carries no literal
 * `<` and a single-tag regex extracts it safely.
 */
function htmlNavState(html: string): DocumentNavState | null {
  const json = navStateJson(html)
  if (json === null) return null
  try {
    return JSON.parse(json) as DocumentNavState
  } catch {
    return null
  }
}

/** The raw `__PNEXT_NAV_STATE__` script body of a rendered document, or null. */
function navStateJson(html: string): string | null {
  return html.match(/id="__PNEXT_NAV_STATE__"[^>]*>([^<]*)</)?.[1] ?? null
}

/** True when a rendered document is a server-stamped interception host render. */
function pageIsHostRender(page: PrefetchedPage): boolean {
  return htmlNavState(page.html)?.hostRender === true
}

/**
 * Stable key for a document nav state (sorted slot keys) to compare prefetch
 * freshness. Exported for unit testing alongside `entryMatchesNavState`.
 */
export function navStateKey(state: DocumentNavState): string {
  const slots = state.slots ?? {}
  const ordered: Record<string, string> = {}
  for (const key of Object.keys(slots).sort()) ordered[key] = slots[key]!
  return JSON.stringify({
    children: (state.children ?? '') + (state.childrenSearch ?? ''),
    slots: ordered,
  })
}

// SOFT NAVIGATION - the whole commit: pick the document, paint a shell, preserve
// islands/segments, swap the body, settle history and scroll.

// Bumped once per soft navigation. Everything a navigation starts (shell paint,
// streamed tail, form-state restore) checks its own sequence against this and
// abandons the moment a newer navigation supersedes it.
let navigationSequence = 0
let suppressImmediateRefresh = false

/** Current navigation generation, exposed so DOM-level paint tests retain the stale-work guard. */
export function currentNavigationSequence(): number {
  return navigationSequence
}

export async function softNavigate(href: string, options: SoftNavigateOptions = {}) {
  emitNavigationStart()
  const departingEntrySrc = entryScriptSrc(document)
  // The entry being left (on popstate, history already points at the target,
  // so the live document's entry id is the tracked active one).
  const departingBfcacheId = options.pop ? activeBfcacheId : (historyBfcacheId() ?? activeBfcacheId)
  const previousSearch = location.search
  // The DEPARTING pathname, likewise read before anything can move the address
  // bar: the bfcache id of the entry this navigation opens is minted by
  // comparing where we are GOING with where we came FROM (see
  // nextBfcacheIdForNavigation), and an optimistic shell push has already
  // rewritten `location` to the destination by the time that runs.
  const previousPathname = location.pathname
  // The DEPARTING render's children path, read before anything can paint into
  // the live document: a static-stage paint that grafts the destination's whole
  // subtree (commitStaticStage) swaps the live `#__PNEXT_NAV_STATE__` for the
  // destination's, and reading it after that would report the incoming path as
  // the previous one (mis-classifying the nav as slot-only, killing the scroll).
  // The DEPARTING parallel-route state, likewise read before anything can paint. Every "may
  // this cached entry serve this navigation?" question is asked about the state the navigation
  // STARTED from. An optimistic loading-shell paint swaps the live `#__PNEXT_NAV_STATE__` for
  // the destination's, so re-reading after it would compare the navigation's own prefetch
  // against the target's state and reject it - re-fetching a route it had already prefetched.
  const departureNavState = currentNavState()
  const previousChildrenPath = departureNavState.children
  // `next-url` names the children tree the current document actually renders,
  // which can differ from the browser URL after middleware rewrites. Keep this
  // separate from `departingRouteKey`: the latter is intentionally the visible
  // pathname+search used by history/document caches.
  // Back/forward cache (Next's bfcache): the route being left, keyed by
  // pathname+search. On popstate `location` already points at the target, so
  // the departing route is the last committed one (`routerState.activeRouteKey`); on a
  // link/push nav it is simply the current location. Its stateful island roots
  // are stashed under this key below so returning to it (via link OR history
  // traversal) restores React state.
  const departingRouteKey = options.pop ? routerState.activeRouteKey : locationKey()
  const departureUrl = departureNavState.hostRender
    ? departingRouteKey
    : previousChildrenPath! + (departureNavState.childrenSearch ?? previousSearch)
  const url = resolveSoftUrl(href)
  if (!url) {
    hardNavigate(href, options.replace || options.pop)
    return
  }
  // Resolve a traversal's document in the same place as every other navigation source. popstate
  // supplies only the target history state; this chooser owns the decision between that entry's
  // immutable restore source and the normal cache/fetch path. `cachedPage` remains an explicit
  // injection point for focused DOM tests and callers that already hold a completed source.
  const entryRestorePage = options.pop
    ? entryDocCache.get(historyState().__pnextEntry as string)
    : undefined
  // A hard-loaded streaming document is cached from its immutable pre-hydration source. When that
  // source contains a boundary whose continuation had not parsed yet, it is a static/loading stage,
  // not a complete history document. Committing it on pop would bypass pageForNavigation entirely,
  // so no request could ever deliver the missing continuation and the entry would remain loading.
  // Keep explicit cachedPage injections unchanged for focused callers, but make an incomplete
  // entry-bound source fall through to the ordinary pop fetch.
  const restorePage =
    options.cachedPage ??
    (entryRestorePage && !streamHasPendingHole(entryRestorePage.html)
      ? entryRestorePage
      : undefined)
  // Client-instrumentation transition hook (Next's onRouterTransitionStart).
  ;(
    window as { __PNEXT_ON_ROUTER_TRANSITION_START__?: (href: string, kind: string) => void }
  ).__PNEXT_ON_ROUTER_TRANSITION_START__?.(
    url.href,
    options.pop ? 'traverse' : options.replace ? 'replace' : 'push',
  )
  // A refresh (a self-navigation to the current URL, replace + no scroll) is the client
  // surface of router.refresh() and of a server-action revalidatePath/Tag. It bypasses every
  // client cache and evicts this URL's entries so later prefetches re-fetch. A same-URL LINK
  // click is refresh-like too, so the caller may ask for the refresh path explicitly
  // (`options.refreshLike`) without pretending to be a replace.
  const refreshLike =
    !options.pop &&
    (Boolean(options.replace) || options.refreshLike === true) &&
    url.pathname === location.pathname &&
    url.search === previousSearch
  if (refreshLike && suppressImmediateRefresh) return
  if (!options.pop && !refreshLike) {
    suppressImmediateRefresh = true
    queueMicrotask(() => {
      suppressImmediateRefresh = false
    })
  }
  // Same-URL (or same-pathname) navigation: refresh the PAGE segments only.
  if (!options.pop && url.pathname === location.pathname) {
    evictSegmentCache({ pageSegmentsOnly: true })
  }
  if (refreshLike) evictNavigationCache(url.pathname + url.search, url.pathname)

  const sequence = ++navigationSequence
  // Snapshot the departing entry before a cached/streamed loading shell paints
  // into the live body. Capturing later would save the target's fallback as
  // the previous history entry and restore a permanently stuck "Loading...".
  if (!options.pop) saveScrollPosition()
  if (departingBfcacheId) saveFormState(departingBfcacheId)
  // Snapshot the departing page's live island roots NOW, before a loading shell
  // can paint over (and detach) them below — they are stashed for back/forward
  // restore once the incoming document tells us which are preserved vs left.
  const departingLiveRoots = collectTopLevelLiveRoots()
  // Snapshot plain root-layout DOM before a cached/streamed shell can detach it. The final swap
  // reconciles onto these nodes so server layouts keep the same identity Next's root reconciler does.
  const departingReusableBody = reusableBodyChildren()
  // Capture the complete outgoing screen before any loading/static stage can replace it. The
  // resolved client-root commit uses this copy only while its first complete paint settles.
  const paintHoldScrollTop =
    document.querySelector<HTMLElement>('[data-scroll-root]')?.scrollTop ?? 0
  const paintHold = createNavigationPaintHold()
  // Painting a prefetched loading shell IS a committed navigation, so push the requested URL
  // here and let usePathname() and the address bar reflect the destination while the fetch is
  // still in flight; the final commit replaces this entry with the resolved one (or, on a
  // redirect, its corrected destination). Skipped for popstate, refreshes and same-URL navs.
  let optimisticallyPushed = false
  // The optimistic entry shows a DIFFERENT document than the departing one, so it opens with
  // its own entry id: carrying the departing id over makes a traversal off it read as a
  // shallow same-entry move in onPopState and get dropped, stranding the UI on the
  // half-committed target. The commit below reuses the id.
  let optimisticEntryId: string | undefined
  let optimisticBfcacheId: string | undefined
  // `silent` moves the address bar without broadcasting: used before the tree is painted, where a
  // location broadcast would render the destination URL against the departing route's params.
  const pushOptimisticUrl = (silent = false) => {
    if (optimisticallyPushed || options.pop || refreshLike) return
    if (url.pathname === location.pathname && url.search === location.search) return
    optimisticallyPushed = true
    optimisticEntryId = routerState.renderedEntryId = newEntryId()
    // The loading/static stage publishes the destination URL immediately. Give
    // that render the destination's state identity too; otherwise useRouter
    // observes the new pathname with the departing bfcacheId, and the final
    // same-URL broadcast cannot make a keyed leaf reset.
    optimisticBfcacheId = nextBfcacheIdForNavigation(url, previousPathname)
    // A PAINTED optimistic entry's document is what is on screen from here on; keep the
    // live-entry pointer in step, or a traversal in this window snapshots the DESTINATION's
    // DOM under the departing entry's id and destroys that entry's form-state capture. The
    // silent (pre-paint) push leaves the pointer alone — the departing DOM is still live.
    if (!silent) activeBfcacheId = optimisticBfcacheId
    const shellState = {
      ...historyState(),
      __pnextEntry: optimisticEntryId,
      [HISTORY_BFCACHE_ID_KEY]: optimisticBfcacheId,
    }
    const move = () => {
      if (options.replace) history.replaceState(shellState, '', url.href)
      else history.pushState(shellState, '', url.href)
    }
    if (silent) withSilentLocationChange(move)
    else move()
    // Record the observed URL without emitting; a stale key would make a back() off this
    // entry compare equal to the departing URL and read as a shallow move, so onPopState
    // would leave the DOM alone and this navigation would paint over the popped entry.
    routerState.observedLocationKey = locationKey()
  }
  // A forward navigation to a route with a loading boundary streams shell-first, so paint
  // that fallback into the current page container as soon as the shell chunk arrives. Skipped
  // for popstate/cached navigations (no fetch) AND for refreshes: a refresh keeps the live
  // content on screen, and painting the fallback would detach the live island roots BEFORE
  // matchPreservedIslands runs, losing their component state.
  //
  // Also skipped when a cached loading shell (or static stage) has already painted for THIS
  // navigation: the response's own shell chunk carries the same boundary re-rendered
  // server-side, and re-painting would replace a committed loading state with a second,
  // different one. A segment's loading fallback commits ONCE per navigation.
  let cachedStagePainted = false
  const devSoftNavigation = isDevDocument()
  const onShell =
    restorePage || options.pop || refreshLike
      ? undefined
      : (shellHtml: string) => {
          if (cachedStagePainted) return
          if (devSoftNavigation) return
          // In dev, compilation can suspend an application boundary even though the route's real
          // content is otherwise ready. Keep the departing page until that compile-only hole is
          // resolved; an explicit loading.js boundary remains paintable through the ordinary
          // loading-boundary path. Production retains streamed application-Suspense behavior.
          const devNavigation = shellHtml.includes('data-pnext-dev')
          if (!showLoadingShell(shellHtml, sequence, url, undefined, false, !devNavigation)) return
          // A loading boundary is a committed navigation state.
          pushOptimisticUrl()
          scheduleNavigationScroll(url, options)
        }
  // The per-segment cache's answer for this navigation, looked up ONCE: it decides both
  // whether the generic loading shell should paint (a real cached static segment is strictly
  // better) and, in pageForNavigation, whether the navigation commits network-free.
  const segmentHit =
    restorePage || options.pop || refreshLike || slotStateSensitive(currentNavState())
      ? null
      : (segmentCachePolicy?.take({
          pathname: url.pathname,
          search: url.search,
          segmentPath: INDEX_SEGMENT_PATH,
        }) ?? null)
  // Paint a cached STATIC STAGE — the route's own content, not a fallback — and
  // treat it as a committed navigation exactly like a loading shell.
  const onStaticStage = onShell
    ? (html: string, postponedShell = false) => {
        if (devSoftNavigation) return
        if (!commitStaticStage(html, sequence, url, postponedShell)) return
        cachedStagePainted = true
        pushOptimisticUrl()
        scheduleNavigationScroll(url, options)
      }
    : undefined
  // Loading-shell reuse: when the navigation must fetch, paint the CACHED shell for the
  // target pathname synchronously - search-param independent, so `?a` reuses the shell a `?b`
  // prefetch streamed - instead of waiting for the response's shell chunk.
  // A sibling runtime prefetch may have supplied a reusable PAGE frame while this URL's
  // param-dependent LAYOUT frame is missing. The route shell is not vary-aware, so do not
  // paint a sibling's layout while the destination layout is still on the wire.
  if (
    onShell &&
    !devSoftNavigation &&
    !refreshLike &&
    !segmentHit &&
    !segmentCachePolicy?.needsLayoutFrameOnly?.({
      pathname: url.pathname,
      search: url.search,
    }) &&
    !hasFreshDocument(url) &&
    !peekSegmentBody(url.pathname)
  ) {
    const stored = takeShellForUrl(url)
    const predicted = loadingShellPredictionPolicy?.(
      url,
      stored ? new Map([[stored.key, stored.html]]) : shellHtmlByPath(),
    )
    const shellPainted = predicted
      ? showLoadingShell(predicted.html, sequence, url, predicted.route)
      : stored
        ? showLoadingShell(stored.html, sequence, url)
        : false
    if (shellPainted) {
      cachedStagePainted = true
      pushOptimisticUrl()
      scheduleNavigationScroll(url, options)
    }
  }
  // Which navigations may fetch the PAGE frame alone. Never on popstate (a history entry
  // restores its own render, layouts included) and never for a refresh/action revalidation,
  // which must re-render the layout chain too - a same-URL LINK click (`pageRefresh`) is the
  // one refresh-like navigation served page-segments-only. Slot-state sensitive navigations
  // are excluded: their layout chain is resolved per request by the server.
  const pageFrame = {
    eligible:
      !options.pop &&
      (!refreshLike || options.pageRefresh === true) &&
      !slotStateSensitive(departureNavState, segmentHit?.html),
    // The DEPARTING URL, not the live one: an optimistic shell paint above may
    // already have pushed the destination into the address bar.
    sameUrl: url.pathname === previousPathname && url.search === previousSearch,
  }
  // A traversal (or a newer navigation) can supersede this one after its response has landed.
  // The document is still valid data for its own route, so it stays in the bfcache instead of
  // dying with the navigation. Never for a cached entry: re-storing one resets its commit time.
  const abandonFetchedPage = (fetched: PrefetchedPage | null | undefined) => {
    if (!fetched || restorePage) return
    const settled = new URL(fetched.finalUrl, location.href)
    storeBfDoc(bfRouteKey(settled.pathname, settled.search), fetched)
  }
  let page =
    restorePage ??
    (await pageForNavigation(
      url,
      { ...options, refreshLike },
      onShell,
      onStaticStage,
      segmentHit,
      departureNavState,
      departureUrl,
      pageFrame,
    ))
  if (sequence !== navigationSequence) return abandonFetchedPage(page)
  if (!page) {
    // Offline: a hard navigation would land on the browser's error page and lose the app
    // entirely. Keep the current document and retry the whole navigation once connectivity
    // returns - unless a newer navigation superseded this one.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      await new Promise<void>(resolve =>
        window.addEventListener('online', () => resolve(), { once: true }),
      )
      if (sequence !== navigationSequence) return
      return softNavigate(href, options)
    }
    hardNavigate(url.href, options.replace || options.pop)
    return
  }

  let doc = new DOMParser().parseFromString(page.html, 'text/html')
  if (!isPNextDocument(doc)) {
    hardNavigate(url.href, options.replace || options.pop)
    return
  }
  materializeClientIslandMarkers(doc)
  materializeStreamedSegments(doc)

  // Shared-layout retention: the server may have skipped executing shared layouts
  // (data-pnext-skip markers), counting on this client to graft its live layout DOM over
  // them. When the graft cannot land (refresh, slot-state shift, no matching live segment),
  // refetch with the full-render header. A cached history entry has no server to refetch from
  // as far as this navigation is concerned - the document IS the entry's own render.
  if (
    !restorePage &&
    skippedSegmentsUngraftable(
      doc,
      options.freshSegments || cachedStagePainted || (refreshLike && !options.pageRefresh),
    )
  ) {
    const fullPage = await fetchPage(url.href, {
      navState: options.navState,
      fromUrl: departureUrl,
      fullRender: true,
    }).catch(() => null)
    if (sequence !== navigationSequence) return abandonFetchedPage(fullPage ?? page)
    if (!fullPage?.ok) {
      hardNavigate(url.href, options.replace || options.pop)
      return
    }
    page = fullPage
    doc = new DOMParser().parseFromString(page.html, 'text/html')
    materializeClientIslandMarkers(doc)
    materializeStreamedSegments(doc)
  }

  const targetUrl = new URL(page.finalUrl, location.href)
  targetUrl.hash = url.hash
  if (targetUrl.origin !== location.origin) {
    hardNavigate(targetUrl.href, options.replace || options.pop)
    return
  }

  if (rootLayoutChanged(doc)) {
    hardNavigate(targetUrl.href, options.replace || options.pop)
    return
  }

  // All hard-navigate bailouts are behind us: open the history entry NOW, before the asset
  // warm-up awaits the network - a back() in that window would otherwise escape the app
  // (no entry pushed yet). The final commit replaces this entry, correcting redirects. Silent:
  // nothing has painted yet, so subscribers must keep seeing the departing route until commit.
  pushOptimisticUrl(true)

  // Warm the new document's assets before touching the current one: the swap
  // then paints styled content immediately instead of flashing unstyled HTML.
  const entrySrc = entryScriptSrc(doc)
  warmEntryChunks(doc)
  // A restored traversal with warm modules and settled stylesheets commits in the popstate
  // task itself: the browser (and Next's in-memory router) treat back/forward as synchronous,
  // so a reader immediately after history.back() must observe the target document. Awaiting
  // here — even already-resolved promises — pushes the swap at least a task later and loses
  // that footrace. Everything upstream of this point is synchronous when restorePage is set.
  const pendingStylesheets = installStylesheets(doc)
  let entryModule = entrySrc ? (entryModuleCache.get(entryModuleHref(entrySrc)) ?? null) : null
  let departingEntryModule = departingEntrySrc
    ? (entryModuleCache.get(entryModuleHref(departingEntrySrc)) ?? null)
    : null
  const warmPop =
    options.pop &&
    Boolean(restorePage) &&
    pendingStylesheets.length === 0 &&
    (entryModule !== null || !entrySrc) &&
    (departingEntryModule !== null || !departingEntrySrc)
  if (!warmPop) {
    ;[entryModule, departingEntryModule] = await Promise.all([
      entrySrc ? importEntry(entrySrc) : Promise.resolve(null),
      departingEntrySrc ? importEntry(departingEntrySrc) : Promise.resolve(null),
      Promise.all(pendingStylesheets),
    ])
    if (sequence !== navigationSequence) return abandonFetchedPage(page)
  }

  if (!options.pop) {
    const bfcacheId = optimisticBfcacheId ?? nextBfcacheIdForNavigation(targetUrl, previousPathname)
    const entryState = {
      ...historyState(),
      // The shell push already minted this entry's id; keep it so the resolved
      // document lands on the entry the loading state opened.
      __pnextEntry: (routerState.renderedEntryId = optimisticEntryId ?? newEntryId()),
      [HISTORY_BFCACHE_ID_KEY]: bfcacheId,
    }
    // An optimistic shell push already opened this entry: replace it in place instead of
    // pushing a duplicate. When the resolved destination is the same route the shell was
    // pushed for (a rewrite, not a redirect), keep the as-requested href - `page.finalUrl`
    // comes from the RSC fetch URL, whose query is percent-encoded, and the browser bar must
    // show what the user navigated to.
    const sameDestination =
      optimisticallyPushed &&
      targetUrl.pathname === url.pathname &&
      decodeSearch(targetUrl.search) === decodeSearch(url.search)
    const committedHref = sameDestination ? url.href : targetUrl.href
    // A refresh-like navigation targets the URL that is already current (a
    // router.refresh(), or a click on a Link to the page we are on): Next opens
    // no history entry for it, so update this one in place.
    if (options.replace || optimisticallyPushed || refreshLike)
      history.replaceState(entryState, '', committedHref)
    else history.pushState(entryState, '', committedHref)
  }

  // Install the final document's route snapshot before any preserved island is reconciled.
  // A full popstate intentionally does not publish its address-bar change while the departing
  // tree is still live; this snapshot keeps useParams paired with the URL when mountRoute renders
  // that island for the committed tree. Forward commits need the same ordering when no loading or
  // static stage painted an earlier destination snapshot.
  // Compare against the departing route before publishing the incoming route
  // state. Once window.__PNEXT_ROUTE__ is replaced, routeParamBoundaryChanged
  // would compare the destination with itself and hide every param transition.
  const parallelSlotsChanged = navSlotsChanged(doc)
  const remountPageIslands =
    (options.pop && !parallelSlotsChanged) || routeParamBoundaryChanged(doc)
  const committedRoute = documentRouteState(doc)
  if (committedRoute) window.__PNEXT_ROUTE__ = committedRoute

  // Template semantics: a client template island REMOUNTS (fresh state) when
  // the segment it wraps navigates to a different path, and is preserved like
  // a layout island otherwise (refresh, search-param-only and slot-only navs).
  const remountTemplates = docNavStateChildren(doc, targetUrl.pathname) !== previousChildrenPath
  // Page effects are entry-scoped. In particular, an app's popstate-gated initializer must run
  // again on cached back; reattaching the old live page root skips that initializer. Different
  // children routes likewise mount fresh even when two pages happen to use the same island id.
  // Shared-layout state preservation: live island roots that render again in the incoming
  // document keep their DOM (and component state) across the swap. Server-segment
  // preservation keeps live layout DOM and refreshes only the page slot. Parallel-route slot
  // content renders OUTSIDE that slot, so when the incoming slot state differs from the live
  // one - or on a refresh, where every segment carries fresh server data - grafting would
  // keep stale slot/layout DOM; skip segment preservation for those. A same-URL click
  // (`pageRefresh`) is the exception and grafts like a normal navigation.
  //
  // Matched BEFORE the islands so matchPreservedIslands can see which placeholders sit inside
  // a preserved segment, and so this pass agrees with the identical dry run in
  // skippedSegmentsUngraftable above.
  const preservedSegments =
    options.freshSegments ||
    cachedStagePainted ||
    (refreshLike && !options.pageRefresh) ||
    parallelSlotsChanged
      ? (clearSegmentPreserveTags(doc), [])
      : matchPreservedServerSegments(doc)
  const preservedIslands = matchPreservedIslands(doc, remountTemplates, remountPageIslands)
  // A missing live page marker alone is not enough: ordinary server layouts also consume their
  // marker after mount. The slotless lifecycle path is specifically for a preserved client-layout
  // island whose incoming placeholder owns the page marker that its live tree adopted.
  const slotlessClientRootLayout = hasSlotlessClientRootLayout(doc, preservedIslands)
  // A cacheComponents tree follows Next's Activity lifecycle: the inactive page
  // stays mounted. The explicit empty-page pass exists only for ordinary apps,
  // whose outgoing page must unmount while its DOM is still connected.
  // On a traversal, the browser has already fired popstate. A synthetic empty-page
  // render would remount layout effects against the departing URL and let them
  // consume that signal before the destination page can initialize from it. The
  // final mount still reconciles the outgoing page while its preserved shell is
  // connected. Forward navigations retain the explicit pass so their cleanup can
  // snapshot the departing page before the swap.
  const unmountSlotlessPage = slotlessClientRootLayout && !activityBfcacheEnabled() && !options.pop
  if (unmountSlotlessPage) {
    keySlotlessClientPage(
      doc,
      `${targetUrl.pathname}${targetUrl.search}|${historyBfcacheId() ?? ''}`,
    )
  }
  const preservedPage = matchPreservedClientPage(
    doc,
    (refreshLike || sameRouteQueryNav(doc)) && !options.remount,
    remountPageIslands,
  )
  const targetRouteKey = bfRouteKey(targetUrl.pathname, targetUrl.search)
  // Live islands the incoming tree keeps in place (preserved layout/segment
  // islands): the departing page's OTHER roots are the ones to stash.
  const keptLiveIslands = new Set<Element>([
    ...preservedIslands,
    ...preservedSegmentIslands(preservedSegments),
  ])
  // A client root layout can consume the page slot during hydration, leaving its route screens as
  // top-level island roots beside the preserved shell islands. Absence from #pnext-page must not
  // promote those unmatched screens into layout cache entries: they are page lifecycle owners and
  // must unmount while the live shell (and its scroll container) is still attached. The shared roots
  // are already identified above by matching an incoming placeholder and remain preserved.
  // Back/forward cache - stash BEFORE restore, so the fixed-size eviction sees the true entry
  // count (page 1 evicts on the 4th visit even though that same navigation restores page 2).
  // Keeping the departing roots alive and adding them to keptIslands makes the unmount below
  // skip them, so a later return restores their React state.
  const preserveInactiveTree = activityBfcacheEnabled()
  const departingRoots = preserveInactiveTree
    ? departingLiveRoots.filter(root => !keptLiveIslands.has(root))
    : []
  // Only shared-layout roots belong in pnext's live-root cache. Page roots must be unmounted by
  // the outgoing entry while still attached (so effect cleanups can read/save DOM state), then the
  // destination source mounts a fresh root after the swap.
  if (departingRouteKey && departingRouteKey !== targetRouteKey) {
    stashRouteRoots(departingRouteKey, departingRoots)
  }
  // Back/forward cache restore: graft the target route's stashed island roots over the
  // incoming placeholders so their React state survives. A refresh never restores cached
  // client state. A LINK navigation back to a visited route only restores under
  // cacheComponents (Next's link-navigation bfcache ships with the client segment cache); a
  // classic app remounts instead, so a re-revealed accordion starts closed again. History
  // traversal restores either way.
  const restoredIslands =
    refreshLike || !preserveInactiveTree
      ? []
      : matchRouteCachedIslands(doc, targetRouteKey, preservedIslands.length, remountTemplates)
  const keptIslands = new Set<Element>([...keptLiveIslands, ...restoredIslands])
  for (const cachedRoot of departingRoots) keptIslands.add(cachedRoot)
  // The preserved client page's mount container is not an Element (a dissolved
  // page slot is a marker-range proxy); the entry's unmount compares roots by
  // identity, so it rides the same set.
  if (preservedPage) keptIslands.add(preservedPage.root as unknown as Element)
  // Wake route-keyed layout children while the departing DOM is still attached. Their layout
  // cleanups can save shell state before unmount/swap; pop mounts the destination first instead.
  window.__PNEXT_ACTIVE_ENTRY__?.unmount?.(keptIslands)
  let focusedBeforeSwap: Element | null = null
  let navigationFocusTarget: HTMLElement | null = null
  try {
    if (unmountSlotlessPage && departingRouteKey && departingRouteKey !== targetRouteKey) {
      // Cover the lifecycle-only empty-page pass. This is the same outgoing screen clone used for
      // the final atomic commit, attached early enough that no empty intermediate frame can paint.
      attachNavigationPaintHold(paintHold, paintHoldScrollTop, sequence)
      await unmountSlotlessClientPage(
        doc,
        preservedIslands,
        departingEntryModule,
        departingRouteKey,
      )
      if (sequence !== navigationSequence) return
    }
    syncHeadMetadata(doc)
    // Next reconciles the DOM in place, so a focused element in a retained layout keeps focus
    // across a navigation. pnext's swap DETACHES preserved subtrees to graft them into the new
    // body, and detaching blurs - remember the focused node so it can be refocused.
    focusedBeforeSwap = document.activeElement
    swapBody(
      doc,
      [...preservedIslands, ...restoredIslands],
      preservedSegments,
      preservedPage,
      departingReusableBody,
    )
    attachNavigationPaintHold(paintHold, paintHoldScrollTop, sequence)
    // A client root layout adopts and dissolves the page-slot markers during
    // mount. Resolve Next's segment scroll target against the freshly swapped
    // document while those markers still identify the changed page.
    const slotOnlyNav =
      currentNavState().children === previousChildrenPath &&
      url.search === previousSearch &&
      // A changed pathname is only slot-only when the parallel-slot state
      // actually changed. This remains decidable when a body-owned client shell
      // has already removed the departing entry's route script.
      (targetUrl.pathname === previousPathname || parallelSlotsChanged) &&
      !remountPageIslands
    const navigationScrollOptions = {
      ...options,
      scroll:
        targetUrl.pathname !== previousPathname && !parallelSlotsChanged
          ? options.scroll
          : slotOnlyNav
            ? false
            : options.scroll,
    }
    // Resolve the changed segment while the freshly swapped document still has
    // its page markers. A body-owning client root dissolves those markers during
    // mount, after which the compat scroll walk can only see the broad shell.
    scheduleNavigationScroll(url, navigationScrollOptions)
    const focusedByNavigation = document.activeElement
    if (
      focusedByNavigation instanceof HTMLElement &&
      focusedByNavigation !== document.body &&
      focusedByNavigation !== document.documentElement &&
      focusedByNavigation !== focusedBeforeSwap
    ) {
      navigationFocusTarget = focusedByNavigation
    }
    stylesheetReconciler?.(doc)
    // Finish the stylesheet transaction in the same synchronous DOM turn as the body swap. A
    // selector waiter can observe the destination immediately after this stack unwinds; pruning in
    // the later post-mount phase let it catch the target node between its correct route sheet and a
    // stale asynchronous prune from the preceding navigation.
    if (!url.hash) pruneStylesheets(doc)
    // The swapped document carries the render's parallel-route state; pin it
    // (plus the document itself) to this history entry so back/forward restores
    // what was actually shown, without a server round trip.
    storeNavState()
    cacheEntryDocument(page)
    // The committed document is a shown-route snapshot: a later full prefetch of
    // this route reads it from the bfcache instead of the network.
    storeBfDoc(targetRouteKey, page)
    // This route is now the committed one — the next navigation's departing key.
    routerState.activeRouteKey = targetRouteKey
    pingVisiblePrefetchLinks()
    // Browser form restoration is part of the traversal itself: fill the swapped (raw,
    // pre-hydration) controls in the same synchronous turn as the swap, so a reader right after
    // history.back() sees the values. The post-effects pass below still handles controls a
    // mount rebuilds, and only ever fills empty ones.
    if (options.pop) restoreFormState(historyBfcacheId())

    if (page.p) (window as typeof window & { __PNEXT_PROPS__?: unknown }).__PNEXT_PROPS__ = page.p
    await entryModule?.mountRoute?.()
    // The mount can recreate the controls the pre-mount fill above populated. Re-fill before
    // flushClientEffects' settling FRAME below — deferring past it shows a traversal with
    // empty controls for a full frame, which a reader right after history.back() observes.
    if (options.pop && sequence === navigationSequence) restoreFormState(historyBfcacheId())
    // Compat batches layout-effect disposal to the end of the Preact commit. Let that disposal run
    // before usePathname wakes the preserved PageTransition's destination effect (which resets the
    // shared shell scroll position). The old screen and its scroll container are still connected.
    await flushClientEffects()
    // Publish the committed URL while the paint hold still covers the new tree. Preserved client
    // layouts key their routed child on usePathname/useSearchParams; waking that store is what gives
    // the outgoing child a real cleanup and the destination a fresh initializer. Keeping the hold
    // through the following frame makes that keyed replacement atomic in dev as well as production.
    if (sequence === navigationSequence) {
      // Commit listeners run first: loaders may deliberately remain visible until the location
      // subscriber observes the matching tree (the same ordering as the former end-of-commit pair).
      emitNavigationCommit()
      emitLocationChange()
      // History traversal restores the popped entry's form state over the freshly mounted tree
      // (browser back/forward form restoration semantics). This runs BEFORE the paint hold's
      // settling frame below: mounting can recreate the controls the pre-mount fill populated,
      // and deferring the re-fill past the hold's rAF leaves a visibly empty window after the
      // traversal has committed.
      if (options.pop) {
        const targetBfcacheId = historyBfcacheId()
        restoreFormState(targetBfcacheId)
        if (targetBfcacheId) restoreFormStateWhenMounted(targetBfcacheId, sequence)
      }
    }
  } finally {
    await releaseNavigationPaintHold(paintHold)
  }
  if (sequence !== navigationSequence) return
  // Mounting/location subscribers run after the initial pre-mount scroll action.
  // Reapply traversal coordinates once that work has settled; otherwise a page
  // effect can reset the restored position to zero after Back.
  if (options.pop) {
    await flushClientEffects()
    scheduleNavigationScroll(url, options)
  }
  restoreSwapFocus(focusedBeforeSwap, navigationFocusTarget)
  // Activity-preserved trees reconcile their keyed leaf against the new entry id
  // themselves. Replaying the departing DOM snapshot there would resurrect the
  // old leaf value after React correctly reset it; the fallback is only for the
  // ordinary remounting path where pnext has replaced layout-owned DOM.
  if (
    !preserveInactiveTree &&
    !options.pop &&
    departingBfcacheId &&
    previousPathname !== targetUrl.pathname
  ) {
    restoreSharedLayoutFormState(departingBfcacheId, previousPathname, targetUrl.pathname)
  }
  // Same-entry-identity navigation (a search-param nav on the same pathname, a refresh):
  // `key={bfcacheId}` subtrees do NOT remount, so typed values must survive. The commit can
  // still rebuild the page DOM under them (a PPR route streams its page slot in AFTER the
  // swap), so re-apply the departure snapshot as the controls appear - but only to the DOM
  // this swap replaced, never to a control a live island's own render owns (see
  // islandOwnedControl). The pop equivalent runs inside the commit above, ahead of the paint
  // hold's settling frame.
  if (!options.pop && departingBfcacheId && departingBfcacheId === historyBfcacheId()) {
    restoreFormStateWhenMounted(departingBfcacheId, sequence, true)
  }
}

function isBotUserAgent() {
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  return /Googlebot(?!-)|Googlebot$|bingbot|Slurp|DuckDuckBot|Baiduspider|YandexBot/i.test(
    userAgent,
  )
}

// Per-history-entry form-control state, keyed by bfcache id: captured when a navigation
// leaves an entry, restored after a popstate remounts it. Free-text controls only -
// checkboxes/radios and selects are commonly React-controlled, and overwriting a controlled
// control desyncs it from component state.

export interface FormControlState {
  tag: string
  type: string
  value: string
}
const entryFormStateCache = new Map<string, FormControlState[]>()
const ENTRY_FORM_STATE_CACHE_LIMIT = 12
const RESTORED_INPUT_TYPES = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'number',
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
  'color',
  'range',
  '',
])

function formControls(): (HTMLInputElement | HTMLTextAreaElement)[] {
  return [
    ...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea'),
  ].filter(
    control =>
      // The navigation paint hold is a paint-only CLONE of the departing screen: its copied
      // controls would shift indices and trip the count guard during the exact window the
      // synchronous pop restore runs in.
      !control.closest('[data-pnext-navigation-paint-hold]') &&
      (control instanceof HTMLTextAreaElement ||
        RESTORED_INPUT_TYPES.has(control.getAttribute('type')?.toLowerCase() ?? '')),
  )
}

function saveFormState(bfcacheId: string) {
  const state = formControls().map(control => ({
    tag: control.localName,
    type: control.getAttribute('type')?.toLowerCase() ?? '',
    value: control.value,
  }))
  entryFormStateCache.delete(bfcacheId)
  if (state.some(control => control.value !== '')) entryFormStateCache.set(bfcacheId, state)
  while (entryFormStateCache.size > ENTRY_FORM_STATE_CACHE_LIMIT) {
    const oldest = entryFormStateCache.keys().next().value
    if (oldest === undefined) break
    entryFormStateCache.delete(oldest)
  }
}

function restoreControl(
  control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  saved: FormControlState,
  onlyEmpty: boolean,
) {
  if (control.localName !== saved.tag) return
  if (
    control.localName === 'input' &&
    (control.getAttribute('type')?.toLowerCase() ?? '') !== saved.type
  )
    return
  if (onlyEmpty && control.value !== '') return
  if (control.value !== saved.value) control.value = saved.value
}

/**
 * A control inside a mounted island is owned by that island's preact diff, which reproduces
 * React's reconciliation - including an app key (`key={searchParams.get('q')}`) that
 * deliberately remounts the subtree with an EMPTY control. Re-applying the departure snapshot
 * there fights the app; only DOM the raw swap replaced is pnext's own loss to compensate.
 */
function islandOwnedControl(control: Element): boolean {
  const root: LiveIslandRoot | null = control.closest('pnext-client[data-pnext-client]')
  return Boolean(root?.__pnextLive)
}

function restoreFormState(bfcacheId: string | undefined, onlyEmpty = false, skipIslands = false) {
  if (!bfcacheId) return
  const state = entryFormStateCache.get(bfcacheId)
  if (!state) return
  const controls = formControls()
  if (controls.length !== state.length) return
  for (const [index, control] of controls.entries()) {
    if (skipIslands && islandOwnedControl(control)) continue
    // `onlyEmpty`: a freshly mounted control is empty, so filling it restores
    // what the remount lost — while anything already carrying a value (the app
    // set it, or the user typed after the commit) is left alone.
    restoreControl(control, state[index]!, onlyEmpty)
  }
}

/** Restore uncontrolled controls owned by a layout whose URL scope did not change. */
function restoreSharedLayoutFormState(
  bfcacheId: string,
  departingPathname: string,
  targetPathname: string,
) {
  const state = entryFormStateCache.get(bfcacheId)
  if (!state) return
  const controls = formControls()
  if (controls.length !== state.length) return
  const departing = departingPathname.split('/').filter(Boolean)
  const target = targetPathname.split('/').filter(Boolean)
  for (const [index, control] of controls.entries()) {
    if (elementInPageSlot(control)) continue
    // Only controls rendered by the layout island itself belong to this
    // shared scope. A nested page island may sit inside that host after it
    // adopts the page slot, but its bfcacheId intentionally changes on a fresh
    // push and its keyed form must be allowed to reset.
    const raw = control
      .closest('pnext-client[data-pnext-client]')
      ?.getAttribute('data-pnext-layout-segments')
    if (!raw) continue
    const depth = (JSON.parse(raw) as { depth?: number }).depth
    if (!depth || departing.slice(0, depth).join('/') !== target.slice(0, depth).join('/')) continue
    restoreControl(control, state[index]!, false)
  }
}

/**
 * `restoreFormState` for a tree that may still be arriving: a PPR route commits its shell
 * first and promotes the streamed page slot a beat later, so the controls the snapshot
 * describes can appear after the swap. Keep trying while the DOM changes until the control
 * set matches the snapshot.
 */
function restoreFormStateWhenMounted(bfcacheId: string, sequence: number, skipIslands = false) {
  const state = entryFormStateCache.get(bfcacheId)
  if (!state) return
  restoreFormState(bfcacheId, true, skipIslands)
  // The controls can be rebuilt more than once while the commit settles, so the restore stays
  // armed for a short window instead of firing once. It only ever fills EMPTY controls, so a
  // value the app or the user set after the commit is never clobbered.
  const observer = new MutationObserver(() => {
    if (sequence !== navigationSequence) {
      observer.disconnect()
      return
    }
    restoreFormState(bfcacheId, true, skipIslands)
  })
  observer.observe(document.body, { childList: true, subtree: true })
  window.setTimeout(() => observer.disconnect(), FORM_STATE_RESTORE_WINDOW_MS)
}

const FORM_STATE_RESTORE_WINDOW_MS = 5000

// INSTALL - link interception and history events: click/intent handling, the eager
// (visible-link) prefetch observer, popstate and pageshow.

function onLinkClick(event: MouseEvent) {
  const target = linkClickTarget(event)
  if (!target) return
  event.preventDefault()
  commitLinkNavigation(target)
}

/**
 * Commit an already-accepted link click. Split from the click handler so the first-paint hub
 * can decide (and preventDefault) synchronously and replay the navigation here once the
 * router chunk lands.
 */
export function commitLinkNavigation({ url, replace, scroll }: LinkClickTarget) {
  const samePage = url.pathname === location.pathname && url.search === location.search

  // A hash CHANGE on the current URL is pure scroll (no request). Clicking the
  // link for the hash we are already at is a same-URL navigation, not a hash
  // change, and refreshes the page segments like any other same-URL click.
  if (samePage && url.hash && url.hash !== location.hash) {
    if (replace) history.replaceState(historyState(), '', url.href)
    else history.pushState(historyState(), '', url.href)
    scheduleNavigationScroll(url, { scroll })
    emitLocationChange()
    return
  }

  if (samePage) {
    // Already on this exact URL: Next opens no history entry, but it DOES navigate - the page
    // segments are evicted and refetched while the layout segments stay cached. Route it
    // through the refresh-like path (which replaces the current entry in place) instead of
    // returning after a bare scroll, or a same-URL click issues no request at all. The scroll
    // and broadcast still happen up front.
    scheduleNavigationScroll(url, { scroll })
    emitLocationChange()
    void softNavigate(url.href, { replace, scroll, refreshLike: true, pageRefresh: true })
    return
  }

  void softNavigate(url.href, { replace, scroll })
}

// A `prefetch={true}` Link marks itself `data-prefetch-full` so the router
// reuses its prefetch for the static staleTime window (Next's full prefetch);
// a default (`data-prefetch="visible"`) Link uses the dynamic window.
function isFullPrefetchLink(link: Element): boolean {
  return link.getAttribute('data-prefetch-full') === 'true'
}

// The mode a link prefetches in. Its own `data-prefetch` always wins; a plain
// `data-pnext-link` anchor without one takes the app-wide config default
// (`window.__PNEXT_PREFETCH__`, injected by the server), else 'visible'.
export function linkPrefetchMode(link: Element): LinkPrefetchMode {
  const attribute = link.getAttribute('data-prefetch')
  if (attribute === null)
    return (typeof window === 'undefined' ? undefined : window.__PNEXT_PREFETCH__) ?? 'visible'
  return attribute === 'false' ? false : (attribute as LinkPrefetchMode)
}

// Pointer-intent state. True once the pointer has moved since the last pointerdown -
// distinguishes a real hover from content swapping in under a stationary cursor. Starts true
// so a hover before any click counts. Because boundary events precede the pointermove of the
// same gesture, the stationary-swap case is detected by coordinates: a pointerover at the
// last pointerdown position with no movement in between.
let pointerMovedSinceInteraction = true
let lastPointerDownX = Number.NaN
let lastPointerDownY = Number.NaN

function onLinkIntent(event: Event) {
  // A pointerover at the last pointerdown position without any pointer
  // movement in between is content swapping in under a stationary cursor, not
  // a hover (see the pointermove/pointerdown listeners in installRouter).
  if (
    event.type === 'pointerover' &&
    !pointerMovedSinceInteraction &&
    event instanceof PointerEvent &&
    Math.abs(event.clientX - lastPointerDownX) < 2 &&
    Math.abs(event.clientY - lastPointerDownY) < 2
  ) {
    return
  }
  const link = linkFromEvent(event)
  if (!link) return
  if (linkPrefetchMode(link) === false) return
  const href = link.getAttribute('href')
  // unstable_dynamicOnHover: hover intent upgrades the partial (viewport)
  // prefetch to a full one carrying the dynamic data — served as a resume-only
  // continuation when the static shell is already cached.
  const hoverFull = link.getAttribute('data-prefetch-hover-full') === 'true'
  const full = isFullPrefetchLink(link) || hoverFull
  // Hover/touch/focus rides the scheduler's reserved Intent lane: a pending
  // viewport prefetch for this link is boosted to the front of the queue.
  if (href) {
    void prefetchRoute(href, {
      element: link,
      full,
      intent: true,
      hoverResume: hoverFull && !isFullPrefetchLink(link),
    })
  }
}

// A traversal can REACTIVATE this document out of the browser's bfcache instead of loading it
// again: no script re-runs, and every promise in flight when it froze is dead, so a document
// frozen mid-hydration comes back inert. Re-arm the mount (the entry's remount hook only
// touches roots no earlier pass mounted) and re-sync the router's bookkeeping.
function onPageShow(event: PageTransitionEvent) {
  if (!event.persisted) return
  routerState.activeRouteKey = locationKey()
  const entryId = historyState().__pnextEntry
  if (typeof entryId === 'string') routerState.renderedEntryId = entryId
  // A mount claim (mountIslandOnce) left in flight by the freeze can never
  // settle, and the remount awaits it before re-claiming the root — drop the
  // claims of every root that never went live so the re-arm can proceed.
  for (const root of document.querySelectorAll('pnext-client[data-pnext-client]')) {
    const island = root as LiveIslandRoot
    if (!island.__pnextLive) island.__pnextMounting = undefined
  }
  window.__PNEXT_MOUNT_ISLANDS__?.()
  emitLocationChange()
}

export function onPopState() {
  const state = historyState()
  const entryId = state.__pnextEntry
  // Shallow traversal - the document on screen already IS this entry's: a fragment-only move,
  // or an entry the app created with its own history.pushState (which wipes pnext's entry
  // state, and whose URL may not even exist on the server). Either way broadcast the location,
  // scroll, and leave the DOM alone - refetching would swap the body and reset every live
  // component.
  if (
    locationKey() === routerState.observedLocationKey ||
    typeof entryId !== 'string' ||
    entryId === routerState.renderedEntryId
  ) {
    routerState.observedLocationKey = locationKey()
    scheduleNavigationScroll(new URL(location.href), { pop: true, scroll: true })
    emitLocationChange()
    return
  }
  routerState.observedLocationKey = locationKey()
  // The popped entry restores ITS recorded document/parallel-route state
  // (what was on screen when the entry was active), not the current
  // document's: from the entry cache when possible, else by re-rendering
  // server-side from the recorded slot state.
  const navState = state.__pnextNavState as DocumentNavState | undefined
  // Do not broadcast the address-bar change until softNavigate commits the popped document.
  // Persistent islands belong to the rendered tree, not to the speculative browser location:
  // publishing here can update their hook state while they are being detached, then make the
  // post-commit broadcast bail out as unchanged. softNavigate installs the cached document's route
  // snapshot before mountRoute and emits the location immediately after the navigation commit.
  void softNavigate(location.href, { pop: true, navState }).catch(() => location.reload())
}

const eagerLinks = new WeakSet<Element>()
// Per DOCUMENT, not per process: an observer belongs to the document whose links it watches.
// A browser page never swaps documents, but multi-document hosts (jsdom embedders, the test
// process) do, and a stale observer silently never fires for the new document's links.
let visibleLinkObserver: IntersectionObserver | undefined
let visibleLinkObserverDoc: Document | undefined

/** Recompute visible Link prefetches against the newly committed URL/base tree. */
export function pingVisiblePrefetchLinks() {
  for (const element of visiblePrefetchElements) {
    if (!element.isConnected) {
      visiblePrefetchElements.delete(element)
      prefetchedElements.delete(element)
      continue
    }
    const href = element.getAttribute('href')
    if (href) {
      void prefetchRoute(href, {
        element,
        full: isFullPrefetchLink(element),
      })
    }
  }
}

// `load` links prefetch as soon as they appear; `visible` links when they
// enter the viewport. Both arrive with the page or with later client renders,
// so watch the whole document for additions.
function watchEagerPrefetchLinks() {
  scanEagerPrefetchLinks(document.documentElement)
  const observer = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element) scanEagerPrefetchLinks(node)
      }
    }
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })
}

function scanEagerPrefetchLinks(root: Element) {
  const links = [...root.querySelectorAll<HTMLAnchorElement>('a[data-pnext-link]')]
  if (root.matches('a[data-pnext-link]')) links.push(root as HTMLAnchorElement)
  for (const link of links) {
    const mode = linkPrefetchMode(link)
    if (mode !== 'load' && mode !== 'visible') continue
    if (eagerLinks.has(link)) continue
    eagerLinks.add(link)
    if (mode === 'load') {
      const href = link.getAttribute('href')
      if (isElementVisible(link)) visiblePrefetchElements.add(link)
      if (href) void prefetchRoute(href, { element: link, full: isFullPrefetchLink(link) })
      continue
    }
    if (visibleLinkObserverDoc !== document) {
      visibleLinkObserver = undefined
      visibleLinkObserverDoc = document
    }
    visibleLinkObserver ??= new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) {
          visiblePrefetchElements.delete(entry.target)
          // The link left the viewport (scrolled/hidden) — cancel its pending
          // prefetch task: queued work is dropped, an in-flight task stops
          // before its next phase, and the pending cache entry is evicted so
          // re-entering the viewport reschedules the prefetch.
          const task = prefetchTasksByElement.get(entry.target)
          if (task) cancelPrefetchTask(task)
          continue
        }
        visiblePrefetchElements.add(entry.target)
        const href = entry.target.getAttribute('href')
        if (href)
          void prefetchRoute(href, {
            element: entry.target,
            full: isFullPrefetchLink(entry.target),
          })
      }
    })
    visibleLinkObserver.observe(link)
    if (isElementVisible(link)) {
      visiblePrefetchElements.add(link)
      const href = link.getAttribute('href')
      if (href) void prefetchRoute(href, { element: link, full: isFullPrefetchLink(link) })
      continue
    }
  }
}

function isElementVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect()
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  )
}

// The idle tier of the client router: everything the first-paint hub defers.
// This module is only ever reached through `import()` from ./index.ts, so it
// (and the ~25 region modules behind it) forms its own chunk — nothing here is
// in any route entry's static closure.

// The lazy half of ./index.ts's public surface: the facade forwards to these
// once this chunk lands.

export function installRouterFull() {
  // A router-free entry (no Link, no navigation hook in the route's closure) never ran
  // installRouter, so this tier is the first router code on the page and can only be reached
  // by a programmatic navigation through the facade. Do the hub's seeding here.
  if (!window.__PNEXT_ROUTER_INSTALLED__) {
    window.__PNEXT_ROUTER_INSTALLED__ = true
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
    routerState.activeRouteKey = locationKey()
  }
  // Seed the hard-loaded entry's ids BEFORE any island mounts — the hub already
  // did that (see ./index.ts installRouter); this tier picks up from there.
  storeNavState()
  // Next's initial RSC payload seeds the segment cache before request params resolve. PNext's hard
  // HTML load carries only the resolved continuation, so obtain the prerendered current-route stage
  // now and keep it as the cacheComponents segment seed. Default apps do no extra work.
  if (activityBfcacheEnabled()) void prefetchRoute(location.href, { currentUrl: true })
  // Bind every delayed hard-load operation to the document and history entry that installed this
  // runtime. `load` can fire after a fast soft navigation has already committed; consulting the
  // then-current location/state would file the original source under the destination entry key.
  const hardLoadRouteKey = locationKey()
  const hardLoadPathname = location.pathname
  let hardLoadHtml =
    (window as { __PNEXT_SHELL_HTML__?: string }).__PNEXT_SHELL_HTML__ ||
    `<!doctype html>${document.documentElement.outerHTML}`
  // The shell bootstrap can run before these settled, URL-specific scripts parse. A traversal must
  // restore them with the immutable entry source; otherwise a whole-page client component remounts
  // against the route/props globals of the page just left (for example Back to `[id]=1` renders 2).
  if (currentNavState().children !== hardLoadPathname)
    hardLoadHtml += document.getElementById('__PNEXT_NAV_STATE__')?.outerHTML ?? ''
  const hardLoadEntrySrc = entryScriptSrc(document)
  if (hardLoadEntrySrc) hardLoadHtml += `<script type="module" src="${hardLoadEntrySrc}"></script>`
  const hardLoadRestoreSource: PrefetchedPage = {
    html: hardLoadHtml,
    finalUrl: location.href,
    ok: true,
    p: (window as typeof window & { __PNEXT_PROPS__?: unknown }).__PNEXT_PROPS__,
  }
  const hardLoadStaticStage = documentStaticHintFromHtml(hardLoadRestoreSource.html)?.isStatic
    ? undefined
    : preHydrationShell()
  // Entry-document identity is needed as soon as navigation can start, not at window.load.
  cacheEntryDocument(hardLoadRestoreSource)
  const hardLoadEntryId = historyState().__pnextEntry
  // The source snapshot is already entry-bound above. Defer only navigation-cache seeding until
  // load, when the original response has completed its browser lifecycle.
  const captureHardLoad = () => {
    // A fast navigation can commit before the original window load event. The live DOM then belongs
    // to another entry and must not be filed as this hard load's settled segment payload.
    if (historyState().__pnextEntry !== hardLoadEntryId) return
    const settledHtml = `<!doctype html>${document.documentElement.outerHTML}`
    const hardLoadHint = documentStaticHintFromHtml(settledHtml)
    const hardLoadRuntimePrefetch = htmlRuntimePrefetch(settledHtml)
    // A hard HTML load carries no `x-nextjs-stale-time` response header, so
    // seedNavigationEntry would fall to the dynamic default (0) and a fully
    // static page gets re-requested on the next navigation. The document inlines
    // its own static classification (`#__PNEXT_NAV_STATE__`, see renderer.ts):
    // when the route is static, seed the TRUE static window (its own `cacheLife`
    // stale seconds, or the configured static default) and mark it prerendered so
    // no `_rsc` refetch fires while the window is fresh.
    const navigationSeedPage: PrefetchedPage = {
      ...hardLoadRestoreSource,
      html: settledHtml,
    }
    if (hardLoadHint?.isStatic) {
      navigationSeedPage.staleTimeSeconds = hardLoadHint.staleTime ?? shellStaleTimeMs() / 1000
      navigationSeedPage.segmentPrerendered = true
    }
    // Keep the entry-bound history document as immutable server source: ordinary
    // (non-cacheComponents) traversals must remount it, rather than restoring a
    // hydrated tree whose effect cleanup may already have mutated application
    // state. The navigation-data seed has a different contract. Once the hard
    // load settles, its resolved page data is fresh for staleTimes.dynamic and a
    // later Link back to this URL must be able to reuse it.
    // Visited-page seeding: the hard load is as fresh as a fetch — an immediate
    // soft navigation back to this URL within the dynamic window reuses it.
    seedNavigationEntry(
      hardLoadRouteKey,
      hardLoadPathname,
      navigationSeedPage,
      undefined,
      // A streaming document's static stage is unrecoverable from the settled
      // DOM; the pre-promotion stash is the only faithful copy.
      hardLoadStaticStage,
      true,
    )
    storeBfDoc(hardLoadRouteKey, navigationSeedPage)
    // A STREAMING route's pre-promotion shell always carries a pending hole, so the pop guard
    // in softNavigate rejects it and every traversal back to this entry refetches. The settled
    // DOM is this entry's only complete render — re-file it so history restoration stays
    // network-free. Complete (non-streaming) sources keep their immutable pre-hydration copy.
    if (streamHasPendingHole(hardLoadRestoreSource.html) && !streamHasPendingHole(settledHtml)) {
      cacheEntryDocument(navigationSeedPage)
    }
    // `prefetch = 'allow-runtime'`: the document that just loaded shows RESOLVED sampled
    // content, but its cacheable stage is the runtime-prefetch shell, which the hard load never
    // fetched. Ask the server for that payload so a later navigation back paints the sampled
    // content instead of the Suspense fallbacks.
    if (hardLoadRuntimePrefetch) {
      void prefetchRoute(hardLoadRestoreSource.finalUrl, { full: true, currentUrl: true })
    }
  }
  if (document.readyState === 'complete') captureHardLoad()
  else window.addEventListener('load', captureHardLoad, { once: true })

  document.addEventListener('click', onLinkClick)
  document.addEventListener('pointerover', onLinkIntent, true)
  document.addEventListener('touchstart', onLinkIntent, { capture: true, passive: true })
  document.addEventListener('focusin', onLinkIntent, true)
  // Hover intent requires actual pointer MOVEMENT: when a click swaps new content under a
  // stationary cursor, Chrome dispatches a pointerover on the swapped-in link, but that is not
  // user intent - treating it as a hover would fire an Intent-lane prefetch.
  document.addEventListener(
    'pointermove',
    () => {
      pointerMovedSinceInteraction = true
    },
    { capture: true, passive: true },
  )
  document.addEventListener(
    'pointerdown',
    event => {
      pointerMovedSinceInteraction = false
      lastPointerDownX = event.clientX
      lastPointerDownY = event.clientY
    },
    { capture: true, passive: true },
  )
  window.addEventListener('popstate', onPopState)
  window.addEventListener('pageshow', onPageShow)
  watchEagerPrefetchLinks()
}
