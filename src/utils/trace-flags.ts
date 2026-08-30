/**
 * `PNEXT_TRACE=<comma-separated scopes>` - the single umbrella for pnext's diagnostic output.
 * The variable is parsed once, on first use; every later check is a map lookup on a boolean test,
 * so a build with tracing off pays nothing.
 *
 * Grammar: entries are `scope` or `scope=value`, comma separated. `1` is an alias for `boot`
 * (`PNEXT_TRACE=1` keeps its old meaning) and `all` turns on every scope.
 * Example: `PNEXT_TRACE=boot,server=/tmp/modules.json`.
 *
 * A scope is all-or-nothing: turning one on turns on everything it covers.
 *
 * | scope    | prints / does                                                                     |
 * | -------- | --------------------------------------------------------------------------------- |
 * | `boot`   | boot-phase timings and memory readings                                            |
 * | `server` | dev request / render / build timings, per-module compile attribution, route-facts and global-css hit/miss, cache-invalidation reasons, load-plugin registrations |
 * | `vendor` | vendor saturation spans, esbuild plugin-callback attribution, preplan/native report |
 * | `client` | client-build phase timings, and the esbuild metafile written to the output dir     |
 * | `all`    | the four above                                                                    |
 *
 * Two scopes take a `=<path>` value:
 * - `server=<path>` dumps the per-module compile list as JSON; a `.jsonl` path instead collects the
 *   heavy-package facade profile (they are never wanted at once, and the suffix picks between them).
 * - `vendor=<path>` appends the JSONL workload trace bench/tools/vendor-analyze.ts reads.
 */

/** Parse one raw `PNEXT_TRACE` value into scope -> value (`''` when the entry carried none). */
export function parseTraceFlags(raw: string | undefined): Map<string, string> {
  const scopes = new Map<string, string>()
  for (const entry of raw?.split(',') ?? []) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    const name = eq === -1 ? trimmed : trimmed.slice(0, eq).trim()
    if (!name) continue
    scopes.set(name === '1' ? 'boot' : name, eq === -1 ? '' : trimmed.slice(eq + 1).trim())
  }
  return scopes
}

let scopes: Map<string, string> | undefined
let all = false

function flags() {
  if (!scopes) {
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    scopes = parseTraceFlags(process.env.PNEXT_TRACE)
    all = scopes.has('all')
  }
  return scopes
}

/** Drop the memoized parse - for tests and benches that flip PNEXT_TRACE in-process. */
export function resetTraceFlags() {
  scopes = undefined
  all = false
}

/** True when `scope` (or `all`) is listed in PNEXT_TRACE, with or without a value. */
export function traceEnabled(scope: string): boolean {
  return flags().has(scope) || all
}

/** The `scope=<value>` payload, or undefined when the scope is absent or valueless. */
export function traceValue(scope: string): string | undefined {
  return flags().get(scope) || undefined
}
