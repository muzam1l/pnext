import { createHash } from 'node:crypto'
import path from 'node:path'

/**
 * Stable, deterministic id for a server action export. This id is the wire
 * contract between the generated client stub (which sends it in a header) and
 * the runtime endpoint (which looks the action up by it). It must be:
 *
 * - Deterministic: same input -> same output across processes and builds. No
 *   Date.now / Math.random. A build machine and a serving machine compute the
 *   same id from the same (path, name).
 * - Path-stable: computed from the workspace-relative POSIX path so absolute
 *   prefixes (which differ between machines / CI) never leak into the id.
 *
 * `root` is the project/workspace root. When omitted the raw `filePath` is used
 * as-is (already-relative paths pass through unchanged).
 */
export function actionId(filePath: string, exportName: string, root?: string): string {
  const key = workspaceRelative(filePath, root)
  return createHash('sha256').update(key).update('\0').update(exportName).digest('hex').slice(0, 12)
}

/**
 * Normalize a module path to a stable, workspace-relative POSIX key. Exported so
 * the registry and detection share one notion of a module's identity.
 */
export function workspaceRelative(filePath: string, root?: string): string {
  const rel = root ? path.relative(root, filePath) : filePath
  return toPosix(rel)
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}
