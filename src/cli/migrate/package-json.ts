// package.json rewriting: scripts and dependencies. Structured edit only —
// JSON.parse -> mutate -> stringify, which preserves key insertion order.

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pnextOptionalDependencyRange } from '../../utils/fs'
import { latestPnextVersionRange } from '../../utils/registry'
import type { MigrationResult } from './report'

const SEPARATORS = new Set(['&&', '||', ';', '|', '&'])
const MAPPED_SUBCOMMANDS = new Set(['dev', 'build', 'start', 'typegen'])
const DROPPED_FLAGS = new Set(['--turbo', '--turbopack'])

type Json = Record<string, unknown>

/**
 * Rewrite `next` only where it is a command word: the first token of the
 * script or the first token after a shell separator. Substrings like
 * `nextron build` or `npx next-sitemap` are never touched.
 */
export function rewriteScript(script: string): { script: string; reports: string[] } {
  const tokens = script.split(/\s+/).filter(Boolean)
  const reports: string[] = []
  const out: string[] = []
  let commandStart = true
  let changed = false

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (SEPARATORS.has(token)) {
      out.push(token)
      commandStart = true
      continue
    }
    // Env-var prefixes (NODE_OPTIONS=x next dev) don't end the command position.
    if (commandStart && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      out.push(token)
      continue
    }
    if (!commandStart || token !== 'next') {
      out.push(token)
      commandStart = false
      continue
    }

    let end = index + 1
    while (end < tokens.length && !SEPARATORS.has(tokens[end]!)) end += 1
    const subcommand = tokens[index + 1]
    const rest = tokens.slice(index + 2, end)

    if (subcommand && MAPPED_SUBCOMMANDS.has(subcommand)) {
      out.push('pnext', subcommand, ...translateFlags(subcommand, rest))
      changed = true
    } else if (subcommand === 'lint') {
      out.push(...tokens.slice(index, end))
      reports.push('`next lint` left as-is — pnext has no lint command; run eslint directly.')
    } else {
      out.push(...tokens.slice(index, end))
      const command = subcommand ? `next ${subcommand}` : 'next'
      reports.push(`\`${command}\` has no pnext equivalent — left as-is.`)
    }
    index = end - 1
    commandStart = false
  }

  return { script: changed ? out.join(' ') : script, reports }
}

function translateFlags(subcommand: string, rest: string[]) {
  const out: string[] = []
  for (const flag of rest) {
    if (DROPPED_FLAGS.has(flag)) continue
    if (flag === '-p' && (subcommand === 'dev' || subcommand === 'start')) {
      out.push('--port')
      continue
    }
    out.push(flag)
  }
  return out
}

export async function migratePackageJson(
  root: string,
  pkg: Json,
  result: MigrationResult,
  dryRun: boolean,
) {
  const scripts = isObject(pkg.scripts) ? pkg.scripts : undefined
  if (scripts) {
    const rewritten: string[] = []
    for (const [name, value] of Object.entries(scripts)) {
      if (typeof value !== 'string') continue
      const { script, reports } = rewriteScript(value)
      if (script !== value) {
        scripts[name] = script
        rewritten.push(`${name}: ${value} → ${script}`)
      }
      for (const detail of reports) {
        result.reports.push({ title: `package.json script "${name}"`, detail })
      }
    }
    if (rewritten.length > 0) {
      result.edits.push({
        file: 'package.json',
        description: `scripts rewritten (${rewritten.length})`,
        details: rewritten,
      })
    }
  }

  const dependencies = ensureObject(pkg, 'dependencies')
  const devDependencies = ensureObject(pkg, 'devDependencies')

  for (const [field, bucket] of [
    ['dependencies', dependencies],
    ['devDependencies', devDependencies],
  ] as const) {
    if ('next' in bucket) {
      delete bucket.next
      result.edits.push({
        file: 'package.json',
        description: 'next removed',
        details: [`next removed from ${field}`],
      })
    }
  }
  if (!('@wular/pnext' in devDependencies) && !('@wular/pnext' in dependencies)) {
    const versionRange = await latestPnextVersionRange('migrate')
    devDependencies['@wular/pnext'] = versionRange
    result.edits.push({
      file: 'package.json',
      description: '@wular/pnext added',
      details: [`devDependencies: @wular/pnext ${versionRange}`],
    })
  }
  // next/font/google resolves its metadata from `next-font`, one of pnext's optional dependencies.
  // A hoisted store makes it resolve locally whether or not the app declares it, so an undeclared
  // one only shows up as a 500 from a deployed function, where the closure ships what the app asks
  // for. Declare it here, where the migration already knows the app uses the loader.
  const fontRange = pnextOptionalDependencyRange('next-font')
  if (
    result.googleFontImports.length > 0 &&
    fontRange &&
    !('next-font' in dependencies) &&
    !('next-font' in devDependencies)
  ) {
    dependencies['next-font'] = fontRange
    result.edits.push({
      file: 'package.json',
      description: 'next-font added',
      details: [
        `dependencies: next-font ${fontRange} (next/font/google metadata, used by ${result.googleFontImports.length} file${result.googleFontImports.length === 1 ? '' : 's'})`,
      ],
    })
  }
  if (!('preact' in dependencies) && !('preact' in devDependencies)) {
    dependencies.preact = '^10'
    result.edits.push({
      file: 'package.json',
      description: 'preact added',
      details: ['dependencies: preact ^10 (react/react-dom kept — compat aliases them)'],
    })
  }

  const leftovers = [...Object.keys(dependencies), ...Object.keys(devDependencies)].filter(
    name => name === 'eslint-config-next' || name.startsWith('@next/'),
  )
  if (leftovers.length > 0) {
    result.reports.push({
      title: 'Next-specific packages still installed',
      detail: 'Optional cleanup — these are unused under pnext. See https://pnext.dev/docs/compat.',
      files: leftovers,
    })
  }

  pruneEmpty(pkg, 'dependencies')
  pruneEmpty(pkg, 'devDependencies')

  if (!dryRun) {
    await writeFile(path.join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  }
}

export async function readPackageJson(root: string): Promise<Json | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as unknown
    return isObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Create the bucket in place so an existing key keeps its position.
function ensureObject(pkg: Json, key: string): Json {
  if (!isObject(pkg[key])) pkg[key] = {}
  return pkg[key] as Json
}

function pruneEmpty(pkg: Json, key: string) {
  const value = pkg[key]
  if (isObject(value) && Object.keys(value).length === 0) delete pkg[key]
}
