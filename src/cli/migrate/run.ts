// `pnext migrate [directory] [--dry-run]` — converts a Next.js app in place.
//
// Only structured, safe edits are applied (package.json, tsconfig.json,
// pnext.config.ts, .gitignore, next-env.d.ts). Application source is never
// rewritten: it is scanned and reported so the user stays in control.

import { existsSync } from 'node:fs'
import { appendFile, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { bold } from '../../utils/ansi'
import { migratePackageJson, readPackageJson } from './package-json'
import { emptyResult, printHeader, printResult, type MigrationResult } from './report'
import { scanSources } from './scan'
import { withSpinner } from './spinner'
import { migrateTsconfig } from './tsconfig'

const NEXT_CONFIG_FILES = ['next.config.ts', 'next.config.js', 'next.config.mjs', 'next.config.cjs']
const PNEXT_CONFIG_FILES = ['pnext.config.ts', 'pnext.config.js', 'pnext.config.mjs']

export async function migrateApp(directory: string | undefined, options: { dryRun: boolean }) {
  const root = path.resolve(directory ?? process.cwd())
  const pkg = await readPackageJson(root)
  const hasNextDependency = Boolean(
    pkg && (hasDependency(pkg.dependencies, 'next') || hasDependency(pkg.devDependencies, 'next')),
  )
  const hasNextConfig = NEXT_CONFIG_FILES.some(name => existsSync(path.join(root, name)))

  if (!hasNextDependency && !hasNextConfig) {
    console.error(
      `${bold('Not a Next.js app')}: ${root}\n` +
        `  - ${pkg ? 'package.json has no "next" dependency' : 'no readable package.json'}\n` +
        '  - no next.config.{ts,js,mjs,cjs}',
    )
    return 1
  }

  printHeader(root, options.dryRun)
  const result = emptyResult()
  // The scan runs first: what it finds decides what the config enables (sync request APIs) and
  // which dependencies the app needs (next/font/google → next-font).
  await withSpinner('Scanning sources ...', () => scanSources(root, result))
  if (pkg) await migratePackageJson(root, pkg, result, options.dryRun)
  await createPnextConfig(root, result, options.dryRun)
  await migrateTsconfig(root, result, options.dryRun)
  await removeNextEnv(root, result, options.dryRun)
  await updateGitignore(root, result, options.dryRun)

  printResult(result, { install: installCommand(root) })
  return 0
}

async function createPnextConfig(root: string, result: MigrationResult, dryRun: boolean) {
  const legacy = result.syncRequestApis.length > 0
  const existing = PNEXT_CONFIG_FILES.find(name => existsSync(path.join(root, name)))
  if (existing) {
    result.reports.push({
      title: `${existing} already exists`,
      detail: 'Make sure it sets compat: { next: true }. See https://pnext.dev/docs/compat.',
    })
    if (legacy) reportSyncRequestApis(result, existing)
    return
  }
  if (!dryRun) {
    await writeFile(
      path.join(root, 'pnext.config.ts'),
      legacy
        ? 'export default {\n' +
            '  compat: {\n' +
            '    // Sync cookies()/headers()/params still work; migrate to `await` and drop this.\n' +
            '    next: { legacyRequestAPIs: true },\n' +
            '  },\n' +
            '};\n'
        : 'export default { compat: { next: true } };\n',
    )
  }
  result.edits.push({
    file: 'pnext.config.ts',
    description: legacy
      ? 'created with compat.next enabled (legacyRequestAPIs)'
      : 'created with compat.next enabled',
  })
  if (legacy) reportSyncRequestApis(result)
}

function reportSyncRequestApis(result: MigrationResult, existingConfig?: string) {
  result.reports.push({
    title: 'Sync cookies()/headers()/params detected',
    detail: existingConfig
      ? `Set compat: { next: { legacyRequestAPIs: true } } in ${existingConfig} to keep these working, then migrate to \`await\` and remove it. See https://pnext.dev/docs/compat`
      : 'Enabled compat.next.legacyRequestAPIs; migrate to `await` and remove it. See https://pnext.dev/docs/compat',
    files: [...new Set(result.syncRequestApis)],
  })
}

async function removeNextEnv(root: string, result: MigrationResult, dryRun: boolean) {
  const file = path.join(root, 'next-env.d.ts')
  if (!existsSync(file)) return
  if (!dryRun) await rm(file)
  result.edits.push({ file: 'next-env.d.ts', description: 'deleted' })
}

async function updateGitignore(root: string, result: MigrationResult, dryRun: boolean) {
  const file = path.join(root, '.gitignore')
  if (!existsSync(file)) return
  const text = await readFile(file, 'utf8')
  if (text.split(/\r?\n/).some(line => line.trim() === '.pnext/')) return
  if (!dryRun) await appendFile(file, `${text.endsWith('\n') || text === '' ? '' : '\n'}.pnext/\n`)
  result.edits.push({ file: '.gitignore', description: 'appended .pnext/' })
}

function installCommand(root: string) {
  if (existsSync(path.join(root, 'bun.lock')) || existsSync(path.join(root, 'bun.lockb'))) {
    return 'bun install'
  }
  if (existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm install'
  if (existsSync(path.join(root, 'yarn.lock'))) return 'yarn'
  return 'npm install'
}

function hasDependency(bucket: unknown, name: string) {
  return typeof bucket === 'object' && bucket !== null && name in bucket
}
