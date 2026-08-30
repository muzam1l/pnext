// Page-slot framing for the layout/page segment split (COMPAT - browser-safe).
//
// pnext answers a segment prefetch with ONE document that carries the layout chain AND the page. Next
// answers with per-segment frames, each keyed on the params THAT segment read - which is what lets a
// navigation re-fetch a layout (vary `[category, item]`) while reusing the cached page (vary `[category]`).
//
// pnext keeps the one-document wire form and derives the two frames from it: the page's markup always
// lives inside the renderer's page slot, emitted as either a `<div id="pnext-page">` wrapper or the
// neutralized comment pair a client-island bootstrap dissolves it into. So the LAYOUT frame is the
// document with the slot's CHILDREN removed, the PAGE frame is the document as rendered, and composing
// them splices the page frame's slot children into the layout frame's slot.
//
// Deliberately string-level, not DOM-level: the server has no DOM and the client runs this before it
// parses anything. The div scan is BALANCED - a greedy `</div>` match swallows ancestor closing tags and
// leaves the layout unclosed.

/** The byte range of a document's page slot and of the page markup inside it. */
export interface PageSlotRange {
  /** Index of the opening `<div …>` / `<!--pnext-page:…-->` marker. */
  start: number
  /** Index just past the opening marker (where the page's markup begins). */
  childrenStart: number
  /** Index of the closing `</div>` / `<!--/pnext-page-->` marker. */
  childrenEnd: number
  /** Index just past the closing marker. */
  end: number
}

const SLOT_DIV_OPEN = /<div\b[^>]*\bid="pnext-page"[^>]*>/
const SLOT_COMMENT_OPEN = /<!--pnext-page:[^>]*-->/
const SLOT_COMMENT_CLOSE = '<!--/pnext-page-->'

/**
 * Locate the page slot in a rendered document, or null when it has none (a
 * global-error document, a page that ships no client runtime and therefore had
 * its slot markers dropped, a non-pnext body).
 */
export function pageSlotRange(html: string): PageSlotRange | null {
  const comment = SLOT_COMMENT_OPEN.exec(html)
  if (comment) {
    const childrenStart = comment.index + comment[0].length
    const childrenEnd = html.indexOf(SLOT_COMMENT_CLOSE, childrenStart)
    if (childrenEnd === -1) return null
    return {
      start: comment.index,
      childrenStart,
      childrenEnd,
      end: childrenEnd + SLOT_COMMENT_CLOSE.length,
    }
  }
  const open = SLOT_DIV_OPEN.exec(html)
  if (!open) return null
  const childrenStart = open.index + open[0].length
  const tag = /<div\b|<\/div>/g
  tag.lastIndex = childrenStart
  let depth = 1
  for (let match = tag.exec(html); match; match = tag.exec(html)) {
    depth += match[0] === '</div>' ? -1 : 1
    if (depth !== 0) continue
    return {
      start: open.index,
      childrenStart,
      childrenEnd: match.index,
      end: match.index + match[0].length,
    }
  }
  return null
}

/** The page's own markup (the slot's children), or null without a slot. */
export function pageSlotContent(html: string): string | null {
  const range = pageSlotRange(html)
  return range ? html.slice(range.childrenStart, range.childrenEnd) : null
}

/**
 * The LAYOUT frame of a rendered document: the same document with the page's markup removed and the slot
 * left empty. Returned unchanged when the document has no page slot - an empty layout frame would be
 * worse than a whole one.
 */
export function stripPageSlotContent(html: string): string {
  const range = pageSlotRange(html)
  if (!range) return html
  return html.slice(0, range.childrenStart) + html.slice(range.childrenEnd)
}

// A streamed Suspense continuation: the hidden chunk divs the renderer appends
// near the end of the document (renderer.ts STREAM_CHUNK_MARKER), plus the
// inline-suspense variant. A page's dynamic content resolves INTO one of these,
// not into the slot, so a page frame that stopped at the slot would carry only
// the page's `loading` fallback.
const STREAM_CHUNK_MARKERS = ['<div hidden data-pnext-stream', '<div hidden><preact-island']

/** Index of the first streamed continuation chunk at/after `from`, or -1. */
function streamedContinuationStart(html: string, from: number): number {
  const cuts = STREAM_CHUNK_MARKERS.map(marker => html.indexOf(marker, from)).filter(
    index => index !== -1,
  )
  return cuts.length > 0 ? Math.min(...cuts) : -1
}

/**
 * The PAGE frame of a rendered document: the page slot - its markers plus the page's own markup -
 * followed by the document's streamed continuation chunks, with the whole layout chain and the document
 * shell cut away. Null when the document has no page slot.
 *
 * The inverse of `stripPageSlotContent`, and what the `/_page` segment request serves: the response must
 * not carry the layout's markup (a navigation that already renders that layout rejects it), while
 * carrying everything needed to resolve the page's own boundaries. The frame is self-identifying: its
 * page slot starts at offset 0, which is what `composeSegmentFrames` keys on.
 */
export function pageSlotFrame(html: string): string | null {
  const range = pageSlotRange(html)
  if (!range) return null
  const slot = html.slice(range.start, range.end)
  const chunks = streamedContinuationStart(html, range.end)
  if (chunks === -1) return slot
  const bodyEnd = html.lastIndexOf('</body>')
  return slot + html.slice(chunks, bodyEnd > chunks ? bodyEnd : html.length)
}

/**
 * A LAYOUT frame with the streamed continuation chunks of the render it came from cut away.
 *
 * Every layout frame is derived from a document that also rendered a PAGE, and that page's dynamic content
 * resolves into the chunks near the end of the document, not into the slot. Splicing a FRESH page frame
 * into a frame that still carries the old page's chunks would graft the stale content over the new page's
 * boundaries. Scanned on the frame, whose slot is already empty, so the first marker found is always a
 * continuation chunk.
 */
export function stripStreamedContinuation(html: string): string {
  // Each chunk is removed SURGICALLY (its balanced div plus the promotion
  // script that follows it), never "from the first marker to </body>": a layout
  // whose own content streams emits chunks BEFORE the page slot, and cutting to
  // the end of the body would take the slot with them, leaving a frame nothing
  // can be composed into.
  let result = html
  let from = 0
  for (;;) {
    const start = streamedContinuationStart(result, from)
    if (start === -1) return result
    const end = chunkEnd(result, start)
    if (end === -1) return result
    // A chunk that CONTAINS the page slot is the frame's own slot carrier (the
    // page's markup streams in below the layout), not stale continuation —
    // dropping it would leave nothing to compose a fresh page into.
    const slot = pageSlotRange(result)
    if (slot && slot.start > start && slot.end <= end) {
      from = end
      continue
    }
    result = result.slice(0, start) + result.slice(end)
  }
}

/** Index just past a continuation chunk (its balanced div + promotion script). */
function chunkEnd(html: string, start: number): number {
  const tag = /<div\b|<\/div>/g
  tag.lastIndex = start + '<div'.length
  let depth = 1
  let divEnd = -1
  for (let match = tag.exec(html); match; match = tag.exec(html)) {
    depth += match[0] === '</div>' ? -1 : 1
    if (depth > 0) continue
    divEnd = match.index + match[0].length
    break
  }
  if (divEnd === -1) return -1
  const rest = html.slice(divEnd)
  const script = /^\s*<script\b[^>]*>[\s\S]*?<\/script>/.exec(rest)
  return script ? divEnd + script[0].length : divEnd
}

/**
 * Compose a cached LAYOUT frame with a PAGE frame: the layout document with the page frame's slot children
 * spliced into its (empty) slot.
 *
 * When `pageHtml` is a `/_page` FRAME - its slot starts at offset 0 - rather than a whole document,
 * whatever follows the slot is the page's streamed continuation and is appended before the layout's
 * `</body>`, so the composed document resolves the page's boundaries exactly as the whole-document
 * response would have. Null when either side has no page slot: the frames cannot be proven to line up,
 * and painting a half-composed document is worse than fetching.
 */
export function composeSegmentFrames(layoutHtml: string, pageHtml: string): string | null {
  const range = pageSlotRange(layoutHtml)
  if (!range) return null
  const pageRange = pageSlotRange(pageHtml)
  if (!pageRange) return null
  const page = pageHtml.slice(pageRange.childrenStart, pageRange.childrenEnd)
  const composed =
    layoutHtml.slice(0, range.childrenStart) + page + layoutHtml.slice(range.childrenEnd)
  // A whole document's tail is its own layout/scripts, already present in the
  // layout frame; only a frame's tail is continuation markup to carry over.
  const tail = pageRange.start === 0 ? pageHtml.slice(pageRange.end) : ''
  if (!tail) return composed
  const insertAt = composed.lastIndexOf('</body>')
  return insertAt === -1
    ? composed + tail
    : composed.slice(0, insertAt) + tail + composed.slice(insertAt)
}
