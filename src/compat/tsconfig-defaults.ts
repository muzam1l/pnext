// tsconfig.json configuration defaults (COMPAT).
//
// Mirrors Next's `writeConfigurationDefaults`: on build, missing suggested options are added and
// mandatory options are forced into the app's tsconfig.json, logging the same "suggested values" /
// "mandatory changes" summaries the suites assert on. Notably, when the app uses `module: "preserve"`,
// `moduleResolution`, `esModuleInterop` and `resolveJsonModule` are implied and must NOT be added or
// mentioned.
//
// Deliberate deviations from Next, all no-op-preserving: configs with comments (JSONC) are left untouched
// (bailing is safe because a failed parse only skips the rewrite), and the test-glob exclusions are not
// applied.
//
// When no tsconfig.json exists but the project contains TypeScript sources, one is created from scratch.

import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '../utils/fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { ResolvedConfig } from '../config'
import { getNextConfig } from './next/config-loader'

interface SuggestedOption {
  suggested: unknown
  reason?: string
}
interface RequiredOption {
  parsedValue?: unknown
  parsedValues?: unknown[]
  value: unknown
  reason: string
}
type DesiredOption = SuggestedOption | RequiredOption

interface TsconfigShape {
  compilerOptions?: Record<string, unknown>
  include?: unknown
  exclude?: unknown
  [key: string]: unknown
}

// Whether the project carries any .ts/.tsx source (bounded walk skipping
// node_modules/dot-dirs) — Next's TS-detection gate for first-time setup.
function hasTypescriptSources(root: string, depth = 0): boolean {
  if (depth > 6) return false
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    if (entry.isFile() && /\.(ts|tsx|mts|cts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      return true
    }
    if (entry.isDirectory() && hasTypescriptSources(path.join(root, entry.name), depth + 1)) {
      return true
    }
  }
  return false
}

// The app's typescript version, else pnext's own. Read from package.json rather
// than `ts.version` so the 8 MB compiler never loads for a version string —
// nothing outside the typecheck step should pull `typescript` in at all.
function appTypescriptVersion(root: string): string {
  for (const base of [root, import.meta.dirname]) {
    try {
      const require = createRequire(path.join(base, 'noop.js'))
      const pkg = require('typescript/package.json') as { version?: string }
      if (typeof pkg.version === 'string') return pkg.version
    } catch {
      // keep looking
    }
  }
  return '5.9.0'
}

function versionGte(version: string, major: number, minor: number): boolean {
  const [maj = 0, min = 0] = version.split('.').map(part => Number.parseInt(part, 10))
  return maj > major || (maj === major && min >= minor)
}

function getDesiredCompilerOptions(
  typescriptVersion: string,
  userTsConfig: TsconfigShape,
): Record<string, DesiredOption> {
  const configuredModule =
    typeof userTsConfig.compilerOptions?.module === 'string'
      ? userTsConfig.compilerOptions.module.toLowerCase()
      : undefined
  const preferBundlerResolution =
    versionGte(typescriptVersion, 5, 0) &&
    configuredModule !== 'commonjs' &&
    configuredModule !== 'amd'
  const modulePreserve = versionGte(typescriptVersion, 5, 4) && configuredModule === 'preserve'

  return {
    target: {
      suggested: 'ES2017',
      reason: 'For top-level `await`. Note: Next.js only polyfills for the esmodules target.',
    },
    lib: { suggested: ['dom', 'dom.iterable', 'esnext'] },
    allowJs: { suggested: true },
    skipLibCheck: { suggested: true },
    strict: { suggested: false },
    noEmit: { suggested: true },
    incremental: { suggested: true },
    module: {
      parsedValue: 'esnext',
      parsedValues: [
        ...(versionGte(typescriptVersion, 5, 4) ? ['preserve'] : []),
        'es2020',
        'esnext',
        'commonjs',
        'amd',
        'nodenext',
        'node16',
      ],
      value: 'esnext',
      reason: 'for dynamic import() support',
    },
    // `module: "preserve"` implies moduleResolution: bundler, esModuleInterop
    // and resolveJsonModule — the app does not need (and must not be told to
    // add) any of them.
    ...(modulePreserve
      ? {}
      : {
          esModuleInterop: { value: true, reason: 'requirement for SWC / babel' },
          moduleResolution: {
            parsedValue: preferBundlerResolution ? 'bundler' : 'node',
            parsedValues: preferBundlerResolution
              ? ['node16', 'nodenext', 'bundler']
              : ['node', 'node12', 'node16', 'nodenext'],
            value: preferBundlerResolution ? 'bundler' : 'node',
            reason: preferBundlerResolution
              ? 'to match modern bundler resolution'
              : 'to match webpack resolution',
          },
          resolveJsonModule: { value: true, reason: 'to match webpack resolution' },
        }),
    ...(userTsConfig.compilerOptions?.verbatimModuleSyntax === true
      ? {}
      : { isolatedModules: { value: true, reason: 'requirement for SWC / Babel' } }),
    jsx: {
      // A missing value follows Next's automatic-runtime default, while an app
      // that explicitly owns JSX emission keeps preserve. PNext's private
      // typecheck project can analyze either without rewriting user intent.
      parsedValue: 'react-jsx',
      parsedValues: ['preserve', 'react-jsx'],
      value: 'react-jsx',
      reason: 'next.js uses the React automatic runtime',
    },
  }
}

// `<distDir>/types/**` plus the dev-mode variant, shortest first (Next sorts by
// length so dev/build runs produce identical include arrays).
function typeDefinitionGlobPatterns(distDir: string): string[] {
  return [`${distDir}/types/**/*.ts`, `${distDir}/dev/types/**/*.ts`].sort(
    (a, b) => a.length - b.length,
  )
}

/**
 * Patch the app's tsconfig.json with Next's suggested/mandatory compiler
 * options and log the changes the way `next build` does. No-op when the config
 * is absent, extends another config, is unparseable, or already satisfies
 * every requirement.
 */
export async function writeTsconfigDefaults(config: ResolvedConfig): Promise<void> {
  const tsConfigPath = path.join(config.root, 'tsconfig.json')
  const tempDirectory = path.dirname(config.root)
  let isFirstTimeSetup = false
  if (!existsSync(tsConfigPath)) {
    if (!hasTypescriptSources(config.root)) return
    isFirstTimeSetup = true
    // Atomic: the client build's tsconfig-paths reader runs in a parallel phase
    // and must never see a truncated file.
    await writeFileAtomic(tsConfigPath, '{}\n', tempDirectory)
  }

  let userTsConfig: TsconfigShape
  try {
    userTsConfig = JSON.parse(await readFile(tsConfigPath, 'utf8')) as TsconfigShape
  } catch {
    return // JSONC / invalid — leave the user's file alone
  }
  if (userTsConfig === null || typeof userTsConfig !== 'object') return
  // Automatic setup would clobber inherited options; Next bails here too.
  if ('extends' in userTsConfig || 'references' in userTsConfig) return

  if (userTsConfig.compilerOptions == null) userTsConfig.compilerOptions = {}
  const compilerOptions = userTsConfig.compilerOptions

  const desired = getDesiredCompilerOptions(appTypescriptVersion(config.root), userTsConfig)

  const suggestedActions: string[] = []
  const requiredActions: string[] = []
  for (const [optionKey, check] of Object.entries(desired)) {
    if ('suggested' in check) {
      if (!(optionKey in compilerOptions)) {
        compilerOptions[optionKey] = check.suggested
        suggestedActions.push(
          `${optionKey} was set to ${JSON.stringify(check.suggested)}` +
            (check.reason ? ` (${check.reason})` : ''),
        )
      }
      continue
    }
    let existingValue = compilerOptions[optionKey]
    if (typeof existingValue === 'string') existingValue = existingValue.toLowerCase()
    const satisfied = check.parsedValues
      ? check.parsedValues.includes(existingValue)
      : (check.parsedValue ?? check.value) === existingValue
    if (!satisfied) {
      compilerOptions[optionKey] = check.value
      requiredActions.push(`${optionKey} was set to ${String(check.value)} (${check.reason})`)
    }
  }

  const hasAppDir =
    existsSync(path.join(config.root, 'app')) || existsSync(path.join(config.root, 'src', 'app'))
  const hasPagesDir =
    existsSync(path.join(config.root, 'pages')) ||
    existsSync(path.join(config.root, 'src', 'pages'))
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const strictRouteTypes = process.env.__NEXT_EXPERIMENTAL_STRICT_ROUTE_TYPES === 'true'
  const distDir =
    typeof getNextConfig().distDir === 'string' ? (getNextConfig().distDir as string) : '.next'
  const nextTypes = typeDefinitionGlobPatterns(distDir)

  if (!('include' in userTsConfig)) {
    const defaultInclude =
      hasAppDir && !strictRouteTypes
        ? ['next-env.d.ts', ...nextTypes, '**/*.mts', '**/*.ts', '**/*.tsx']
        : ['next-env.d.ts', '**/*.mts', '**/*.ts', '**/*.tsx']
    userTsConfig.include = defaultInclude
    suggestedActions.push(
      `include was set to [${defaultInclude.map(type => `'${type}'`).join(', ')}]`,
    )
  } else if (hasAppDir && !strictRouteTypes && Array.isArray(userTsConfig.include)) {
    for (const type of nextTypes) {
      if (!userTsConfig.include.includes(type)) {
        userTsConfig.include.push(type)
        suggestedActions.push(`include was updated to add '${type}'`)
      }
    }
  }

  if (hasAppDir) {
    const plugins = [
      ...(Array.isArray(userTsConfig.plugins) ? (userTsConfig.plugins as unknown[]) : []),
      ...(Array.isArray(compilerOptions.plugins) ? (compilerOptions.plugins as unknown[]) : []),
    ] as { name?: string }[]
    if (!plugins.some(plugin => plugin?.name === 'next')) {
      if (!Array.isArray(compilerOptions.plugins)) compilerOptions.plugins = []
      ;(compilerOptions.plugins as unknown[]).push({ name: 'next' })
      suggestedActions.push(`plugins was updated to add { name: 'next' }`)
    }
    if (hasPagesDir && !compilerOptions.strict && !('strictNullChecks' in compilerOptions)) {
      compilerOptions.strictNullChecks = true
      suggestedActions.push('strictNullChecks was set to true')
    }
  }

  if (!('exclude' in userTsConfig)) {
    userTsConfig.exclude = ['node_modules']
    suggestedActions.push(`exclude was set to ['node_modules']`)
  }

  if (suggestedActions.length === 0 && requiredActions.length === 0) return

  await writeFileAtomic(tsConfigPath, `${JSON.stringify(userTsConfig, null, 2)}\n`, tempDirectory)

  if (isFirstTimeSetup) {
    console.log(
      '\nWe detected TypeScript in your project and created a tsconfig.json file for you.',
    )
    return
  }

  const lines = [
    '',
    `We detected TypeScript in your project and reconfigured your tsconfig.json file for you.${
      compilerOptions.strict ? '' : ' Strict-mode is set to false by default.'
    }`,
  ]
  if (suggestedActions.length > 0) {
    lines.push(
      `The following suggested values were added to your tsconfig.json. These values can be changed to fit your project's needs:\n`,
      ...suggestedActions.map(action => `\t- ${action}`),
      '',
    )
  }
  if (requiredActions.length > 0) {
    lines.push(
      `The following mandatory changes were made to your tsconfig.json:\n`,
      ...requiredActions.map(action => `\t- ${action}`),
      '',
    )
  }
  console.log(lines.join('\n'))
}
