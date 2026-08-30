import { useContext } from 'preact/hooks'
import type { Context } from 'preact'

interface TrackedThenable<T> extends PromiseLike<T> {
  status?: 'pending' | 'fulfilled' | 'rejected'
  value?: T
  reason?: unknown
}

// Replay state for use() in server components: the renderer replays a component
// after a thrown thenable settles, and use() call N must resolve to the thenable
// recorded on the previous attempt (the rerun creates a fresh promise).
export interface UseThenableState {
  thenables: TrackedThenable<unknown>[]
}

// globalThis-anchored: the prebundled server entry inlines its own copy of this module;
// a replay in one copy must be visible to use() in the other or retries loop forever.
interface UseReplayState {
  active: UseThenableState | null
  index: number
}
const REPLAY_STATE_KEY = Symbol.for('pnext.useReplayState')
const replayState = ((globalThis as Record<PropertyKey, unknown>)[REPLAY_STATE_KEY] ??= {
  active: null,
  index: 0,
}) as UseReplayState

export function withUseThenableState<T>(state: UseThenableState, run: () => T): T {
  const previousState = replayState.active
  const previousIndex = replayState.index
  replayState.active = state
  replayState.index = 0
  try {
    return run()
  } finally {
    replayState.active = previousState
    replayState.index = previousIndex
  }
}

// React 19's use(): unwrap a thenable via suspense, or read a context.
export function use<T>(usable: PromiseLike<T> | Context<T>): T {
  if (usable && typeof (usable as PromiseLike<T>).then === 'function') {
    let thenable = usable as TrackedThenable<T>
    if (replayState.active) {
      const index = replayState.index++
      const existing = replayState.active.thenables[index]
      if (existing) thenable = existing as TrackedThenable<T>
      else replayState.active.thenables[index] = thenable
    }
    if (thenable.status === 'fulfilled') return thenable.value as T
    if (thenable.status === 'rejected') throw thenable.reason
    if (thenable.status !== 'pending') {
      thenable.status = 'pending'
      thenable.then(
        value => {
          thenable.status = 'fulfilled'
          thenable.value = value
        },
        reason => {
          thenable.status = 'rejected'
          thenable.reason = reason
        },
      )
    }
    // React use() protocol: suspend by throwing the thenable itself.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw thenable
  }
  return useContext(usable as Context<T>)
}
