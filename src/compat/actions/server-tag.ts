/**
 * Server-side association from an action function instance to its wire id, so
 * render/index.tsx can turn `<form action={serverAction}>` into a progressive-
 * enhancement POST to the action endpoint (hidden id field + method/action
 * attributes) even without JS.
 *
 * A function is tagged when a server render imports an action module and the
 * render layer registers each exported action here. Kept in a WeakMap so tags
 * don't retain modules. Best-effort: an untagged action function renders as a
 * normal form (the client stub still POSTs it when JS runs).
 */
const actionIds = new WeakMap<object, string>()

export function tagServerAction(fn: unknown, id: string): void {
  if (typeof fn === 'function') actionIds.set(fn, id)
}

export function serverActionId(fn: unknown): string | undefined {
  if (typeof fn !== 'function') return undefined
  return actionIds.get(fn)
}
