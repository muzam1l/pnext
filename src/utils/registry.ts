// Which @wular/pnext a generated project depends on. `bunx @wular/pnext` reuses a cached copy of the
// package instead of re-resolving the dist-tag, so a stale laptop runs an old CLI — and an old CLI
// stamping its own version pins the new project to it. The range comes from the registry instead,
// with the running version as the offline fallback.

import { bold, cyan, dim } from './ansi'
import { pnextVersionRange } from './fs'

const REGISTRY_URL = 'https://registry.npmjs.org/@wular%2Fpnext'
// Short: create/migrate must not hang behind a slow or captive network.
const TIMEOUT_MS = 2000

async function fetchLatestPublishedVersion() {
  const response = await fetch(REGISTRY_URL, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    // The abbreviated document — dist-tags plus versions, without the full metadata.
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  })
  if (!response.ok) return undefined
  const body = (await response.json()) as { 'dist-tags'?: { latest?: string } }
  return body['dist-tags']?.latest
}

// Test seam: the create/migrate suites assert the stamped range and must never hit the network.
let fetchLatestVersion: () => Promise<string | undefined> = fetchLatestPublishedVersion

/** @internal Test-only. Returns a restore function. */
export function setLatestVersionFetcher(fetcher: () => Promise<string | undefined>) {
  const previous = fetchLatestVersion
  fetchLatestVersion = fetcher
  return () => {
    fetchLatestVersion = previous
  }
}

/**
 * '^' + the latest published @wular/pnext, for a project this CLI generates. Never throws and never
 * blocks for long — any failure falls back to the running version. Warns when the CLI itself is
 * stale, which is the symptom the user actually has to fix.
 */
export async function latestPnextVersionRange(command: 'create' | 'migrate') {
  const running = pnextVersionRange().slice(1)
  const latest = await fetchLatestVersion().catch(() => undefined)
  if (!latest) return `^${running}`
  if (isNewer(latest, running)) warnStaleCli(command, running, latest)
  return `^${latest}`
}

function warnStaleCli(command: string, running: string, latest: string) {
  console.error(
    `\n${bold('⚠ Your pnext CLI is out of date')} — running ${running}, latest is ${latest}.\n` +
      dim(
        `  bunx reused a cached copy. This project depends on ^${latest}, but ${command} ran with ${running}.\n`,
      ) +
      `  Re-run with: ${cyan(`bunx @wular/pnext@latest ${command}`)}\n`,
  )
}

/** Numeric major.minor.patch only; anything unparseable counts as "not newer". */
function isNewer(candidate: string, current: string) {
  const parts = (value: string) => value.split('-')[0]!.split('.').map(Number)
  const [a, b] = [parts(candidate), parts(current)]
  for (let index = 0; index < 3; index += 1) {
    const left = a[index] ?? 0
    const right = b[index] ?? 0
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false
    if (left !== right) return left > right
  }
  return false
}
