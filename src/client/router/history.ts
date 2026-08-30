// History entry identity: the ids pnext stamps on `history.state`, and the seed
// that puts them there for the hard-loaded document.
//
// Its own module because its tier is decided by the app, not by the router: a
// page whose client graph reads router state (`api/client-navigation`) seeds at
// first paint and pulls this in; a page that only has a <Link> never reads an id
// before the navigation runtime lands, so this rides the idle chunk with it.
import { routerState } from './hub'

export const HISTORY_BFCACHE_ID_KEY = '__pnextBfcacheId'

export function historyState(): Record<string, unknown> {
  const state = history.state as Record<string, unknown> | null
  return state && typeof state === 'object' ? state : {}
}

export function historyBfcacheId(
  state: Record<string, unknown> = historyState(),
): string | undefined {
  const value = state[HISTORY_BFCACHE_ID_KEY]
  return typeof value === 'string' ? value : undefined
}

function newHistoryId(prefix: string) {
  return `${prefix}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function newBfcacheId() {
  return newHistoryId('b_')
}

export function newEntryId() {
  return newHistoryId('e')
}

/**
 * Stamp the hard-loaded entry's ids onto `history.state` and record which entry is on screen. Called
 * at module scope by `api/client-navigation` - the module that reads them - rather than from the
 * hub's install, so a page whose client graph never touches router state does not pay for them:
 *
 *  - `useRouter().bfcacheId` keys client subtrees, so the id must be stable from the first client
 *    render; waiting for the runtime's load-event snapshot would flip it from '' to a real value on
 *    the first navigation and remount every keyed subtree.
 *  - an entry with no id is indistinguishable from an app-created (shallow) one, and `patchHistory`
 *    carries the ids forward onto an app pushState.
 *
 * The runtime seeds the same fields when it installs, so a page without this call still gets ids
 * before it can navigate away.
 */
export function seedHistoryEntry() {
  if (!process.browser && typeof window === 'undefined') return
  const state = historyState()
  const entryId = state.__pnextEntry
  const hasEntryId = typeof entryId === 'string'
  routerState.renderedEntryId = hasEntryId ? entryId : newEntryId()
  if (historyBfcacheId(state) && hasEntryId) return
  try {
    history.replaceState(
      {
        ...state,
        __pnextEntry: routerState.renderedEntryId,
        [HISTORY_BFCACHE_ID_KEY]: historyBfcacheId(state) ?? newBfcacheId(),
      },
      '',
      location.href,
    )
  } catch {
    // Without a stable id, bfcache-keyed subtrees fall back to remounting.
  }
}
