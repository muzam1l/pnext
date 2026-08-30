import { actionId } from './ids'

/**
 * In-process registry mapping a stable actionId -> the module + export that
 * implements it. Populated at build/startup by the wiring agent from the route
 * manifest; read by the runtime endpoint to resolve an incoming action id.
 *
 * The id is computed with the same `actionId` scheme the client stub uses, so a
 * registration and its client stub always agree on the wire id.
 */

export interface ActionEntry {
  /** actionId(filePath, exportName, root) — the wire id. */
  id: string
  /** Module path the wiring agent will hand to importModule(). */
  modulePath: string
  /** Named export within the module implementing the action. */
  exportName: string
  /**
   * The SOURCE file the id was computed from (workspace-relative when the registration passed `root`,
   * otherwise as given). Used to decide whether a POSTed route's module graph contains the action -
   * Next's "forwarded action" discrimination, see serve.ts isForwardedAction.
   */
  filePath: string
}

const registry = new Map<string, ActionEntry>()

/**
 * Register every action export of a module. `filePath` identifies the module for
 * id computation (workspace-relative when `root` is given); `modulePath` is what
 * gets stored for the endpoint's importModule() (may differ, e.g. a compiled
 * output path). When `modulePath` is omitted it defaults to `filePath`.
 *
 * Returns the entries that were registered (with their ids), so callers can emit
 * matching client stubs.
 */
export function registerActionModule(
  filePath: string,
  exportNames: readonly string[],
  options: { root?: string; modulePath?: string } = {},
): ActionEntry[] {
  const modulePath = options.modulePath ?? filePath
  const entries: ActionEntry[] = []
  for (const exportName of exportNames) {
    const id = actionId(filePath, exportName, options.root)
    const entry: ActionEntry = { id, modulePath, exportName, filePath }
    registry.set(id, entry)
    entries.push(entry)
  }
  return entries
}

/** Resolve an action id to its module + export, or undefined if unknown. */
export function lookupAction(id: string): { modulePath: string; exportName: string } | undefined {
  const entry = registry.get(id)
  if (!entry) return undefined
  return { modulePath: entry.modulePath, exportName: entry.exportName }
}

/** The source file a registered action id was computed from, or undefined. */
export function lookupActionSource(id: string): string | undefined {
  return registry.get(id)?.filePath
}

/** Snapshot of all registered actions. */
export function allActions(): ActionEntry[] {
  return [...registry.values()]
}

/** Clear the registry (test/rebuild support). */
export function clearActions(): void {
  registry.clear()
}
