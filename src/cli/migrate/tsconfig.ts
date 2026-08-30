// tsconfig.json: drop the `next` TS plugin and repoint the generated-types
// include glob at .pnext/types. Configs with comments (JSONC) are reported,
// never rewritten — the same bail compat/tsconfig-defaults.ts takes, since a
// JSON round-trip would strip the user's comments.

import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { MigrationResult } from './report'

const MANUAL_STEPS =
  'remove { "name": "next" } from compilerOptions.plugins and replace ".next/types" includes with ".pnext/types/**/*.ts".'

export async function migrateTsconfig(root: string, result: MigrationResult, dryRun: boolean) {
  const file = path.join(root, 'tsconfig.json')
  if (!existsSync(file)) return
  const text = await readFile(file, 'utf8')

  let config: Record<string, unknown>
  try {
    config = JSON.parse(text) as Record<string, unknown>
  } catch {
    result.reports.push({
      title: 'tsconfig.json has comments (JSONC) — not edited',
      detail: `Apply by hand: ${MANUAL_STEPS}`,
    })
    return
  }
  if (typeof config !== 'object' || config === null) return

  const changes: string[] = []
  const compilerOptions = config.compilerOptions
  if (isObject(compilerOptions) && Array.isArray(compilerOptions.plugins)) {
    const kept = compilerOptions.plugins.filter(
      plugin => !(isObject(plugin) && plugin.name === 'next'),
    )
    if (kept.length !== compilerOptions.plugins.length) {
      if (kept.length === 0) delete compilerOptions.plugins
      else compilerOptions.plugins = kept
      changes.push('next TypeScript plugin removed')
    }
  }

  if (Array.isArray(config.include)) {
    const seen = new Set<string>()
    const include: unknown[] = []
    let repointed = false
    for (const entry of config.include) {
      if (typeof entry !== 'string') {
        include.push(entry)
        continue
      }
      const next =
        entry.includes('.next/types') || entry.includes('.next/dev/types')
          ? '.pnext/types/**/*.ts'
          : entry
      if (next !== entry) repointed = true
      if (seen.has(next)) continue
      seen.add(next)
      include.push(next)
    }
    if (repointed) {
      config.include = include
      changes.push('type includes repointed at .pnext/types')
    }
  }

  if (changes.length === 0) return
  if (!dryRun) await writeFile(file, `${JSON.stringify(config, null, 2)}\n`)
  for (const change of changes) {
    result.edits.push({ file: 'tsconfig.json', description: change })
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
