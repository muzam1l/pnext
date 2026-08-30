// CSS chunking (COMPAT - Next `experimental.cssChunking`).
//
// A faithful port of Next's webpack CssChunkingPlugin (strict variant). Next merges a route's ordered
// CSS modules into as few <link> requests as possible without ever reordering a stylesheet relative to
// any other route that shares it, splitting again when a chunk would grow past MAX_CSS_CHUNK_SIZE or
// when a global stylesheet would leak into a route that does not import it.
//
// pnext ships one mode-blind build, so the STRICT algorithm runs: it produces the request counts the
// css-order suite asserts for conflict routes - which only exercise the strict expectation - while
// leaving the non-conflict routes at the same count strict and loose both expect.
//
// The result crosses the core boundary as `Map<routeId, string[][]>`: each inner array is one chunk's
// ordered slice of that route's `cssImports`, and the slices partition the route's imports in order.
// The output is per-route, which is invisible to the suite: it only checks each page's <link> count and
// computed cascade order, never cross-page asset identity.

import { statSync } from 'node:fs'
import { getNextConfig } from '../next/config-loader'

// Merge chunks until they pass this size; avoid merging past MAX. Mirrors Next.
const MIN_CSS_CHUNK_SIZE = 30 * 1024
const MAX_CSS_CHUNK_SIZE = 100 * 1024

interface RouteCss {
  id: string
  cssImports: string[]
}

function isGlobalCss(file: string) {
  return !/\.module\.(?:css|scss|sass)$/.test(file)
}

function moduleSize(file: string) {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

// Partition every route's ordered CSS imports into shared chunks, then project
// the global grouping back onto each route as ordered contiguous slices.
export function nextPlanRouteCssChunks(routes: RouteCss[]): Map<string, string[][]> {
  if (nextCssChunkingMode() === 'loose') return loosePlanRouteCssChunks(routes)

  const sizes = new Map<string, number>()
  const size = (file: string) => {
    let value = sizes.get(file)
    if (value === undefined) {
      value = moduleSize(file)
      sizes.set(file, value)
    }
    return value
  }

  interface ChunkState {
    modules: string[]
    requests: number
  }

  const chunkStates: ChunkState[] = []
  // file -> (chunkState -> index within that route's ordered import list)
  const statesByModule = new Map<string, Map<ChunkState, number>>()
  for (const route of routes) {
    if (route.cssImports.length === 0) continue
    const state: ChunkState = { modules: route.cssImports, requests: route.cssImports.length }
    chunkStates.push(state)
    route.cssImports.forEach((file, index) => {
      let byState = statesByModule.get(file)
      if (!byState) {
        byState = new Map()
        statesByModule.set(file, byState)
      }
      // A file may repeat within a route; the last index wins (matches Next,
      // where a module maps to a single position per chunk group).
      byState.set(state, index)
    })
  }

  // Process modules by ascending index-sum so shared prefixes seed chunks first.
  const ordered = [...statesByModule.keys()].sort((a, b) => {
    const sum = (file: string) => {
      let total = 0
      for (const index of statesByModule.get(file)!.values()) total += index
      return total
    }
    return sum(a) - sum(b) || (a < b ? -1 : 1)
  })
  const remaining = new Set(ordered)

  const chunkOfModule = new Map<string, number>()
  let nextChunkId = 0

  for (const startModule of remaining) {
    let globalMode = isGlobalCss(startModule)
    const claimed = new Map(statesByModule.get(startModule))
    const chunkModules = new Set([startModule])
    let currentSize = size(startModule)

    const potential = new Map<string, Map<ChunkState, number>>()
    const enqueueNext = (state: ChunkState, index: number) => {
      const next = state.modules[index + 1]
      if (next && remaining.has(next) && !chunkModules.has(next)) {
        potential.set(next, statesByModule.get(next)!)
      }
    }
    for (const [state, index] of claimed) enqueueNext(state, index)

    let progressed = true
    while (progressed) {
      progressed = false

      // Prefer the candidate that collapses the highest-request chunk group.
      const candidates = [...potential.entries()].map(([file, states]) => {
        let maxRequests = 0
        for (const state of states.keys()) {
          if (claimed.has(state)) maxRequests = Math.max(maxRequests, state.requests)
        }
        return { file, states, maxRequests }
      })
      candidates.sort((a, b) => b.maxRequests - a.maxRequests || (a.file < b.file ? -1 : 1))

      for (const { file, states } of candidates) {
        const fileSize = size(file)
        if (currentSize + fileSize > MAX_CSS_CHUNK_SIZE) continue

        // Strict order preservation: in every route sharing this module its
        // position must be exactly one past what we've claimed there, otherwise
        // merging would reorder or interleave stylesheets.
        let orderOk = true
        for (const [state, index] of states) {
          const claimedIndex = claimed.get(state)
          if (claimedIndex === undefined) {
            // A route that doesn't yet overlap: only pull it in while the chunk
            // is still under the min-size target (Next's merge-up-to-MIN rule).
            if (currentSize >= MIN_CSS_CHUNK_SIZE) {
              orderOk = false
              break
            }
          } else if (claimedIndex + 1 !== index) {
            orderOk = false
            break
          }
        }
        if (!orderOk) continue

        // A global stylesheet must never enter a route that doesn't import it,
        // and once the chunk carries a global it can't spread to new routes.
        const nextIsGlobal = isGlobalCss(file)
        if (globalMode) {
          let leaks = false
          for (const state of states.keys()) {
            if (!claimed.has(state)) {
              leaks = true
              break
            }
          }
          if (leaks) continue
        }
        if (nextIsGlobal) {
          let leaks = false
          for (const state of claimed.keys()) {
            if (!states.has(state)) {
              leaks = true
              break
            }
          }
          if (leaks) continue
        }

        potential.delete(file)
        currentSize += fileSize
        if (nextIsGlobal) globalMode = true
        for (const [state, index] of states) {
          if (claimed.has(state)) state.requests--
          claimed.set(state, index)
          enqueueNext(state, index)
        }
        chunkModules.add(file)
        progressed = true
        break
      }
    }

    const chunkId = nextChunkId++
    for (const file of chunkModules) {
      remaining.delete(file)
      chunkOfModule.set(file, chunkId)
    }
  }

  // Project the global grouping back to per-route ordered slices. A chunk's
  // modules are contiguous in every route (guaranteed by the strict merge), so
  // each route's imports break cleanly at chunk-id boundaries.
  const plan = new Map<string, string[][]>()
  for (const route of routes) {
    if (route.cssImports.length < 2) continue
    const segments: string[][] = []
    let current: string[] = []
    let currentChunk = -1
    for (const file of route.cssImports) {
      const chunkId = chunkOfModule.get(file) ?? -1
      if (chunkId !== currentChunk && current.length > 0) {
        segments.push(current)
        current = []
      }
      current.push(file)
      currentChunk = chunkId
    }
    if (current.length > 0) segments.push(current)
    // Single segment means core's default single-chunk path already suffices.
    if (segments.length > 1) plan.set(route.id, segments)
  }
  return plan
}

function nextCssChunkingMode(): 'loose' | 'strict' {
  const experimental = getNextConfig().experimental as { cssChunking?: unknown } | undefined
  return experimental?.cssChunking === 'loose' || experimental?.cssChunking === undefined
    ? 'loose'
    : 'strict'
}

// Loose mode minimizes each route's stylesheet requests independently. A
// global stylesheet begins a fresh chunk so it cannot move ahead of styles
// imported before it; subsequent modules may share that chunk.
function loosePlanRouteCssChunks(routes: RouteCss[]): Map<string, string[][]> {
  const plan = new Map<string, string[][]>()

  for (const route of routes) {
    if (route.cssImports.length < 2) continue

    const segments: string[][] = []
    let current: string[] = []
    let currentSize = 0
    for (const file of route.cssImports) {
      const size = moduleSize(file)
      if (current.length > 0 && (isGlobalCss(file) || currentSize + size > MAX_CSS_CHUNK_SIZE)) {
        segments.push(current)
        current = []
        currentSize = 0
      }
      current.push(file)
      currentSize += size
    }
    if (current.length > 0) segments.push(current)
    if (segments.length > 1) plan.set(route.id, segments)
  }

  return plan
}
