// Writes `.next/types/{routes.d.ts,link.d.ts,validator.ts}` from a Next-shaped
// route-types manifest so the typed-routes / typed-routes-validator suites (which
// read `<distDir>/types/*` and run `tsc --noEmit`) pass. Compat-only.
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ResolvedConfig } from '../../config'
import type { RouteManifestEntry } from '../../types'
import { ensureDir, toPosixPath } from '../../utils/fs'
import { getNextConfig } from '../next/config-loader'
import { scanRootParamTypes, type RootParamValueType } from '../ppr/root-params-scan'
import { buildRouteTypesManifest } from './manifest'
import { generateLinkTypesFile, generateRouteTypesFile, generateValidatorFile } from './typegen'

async function writeIfChanged(file: string, source: string): Promise<void> {
  if (existsSync(file) && (await readFile(file, 'utf8')) === source) return
  await ensureDir(path.dirname(file))
  await writeFile(file, source)
}

export async function generateTypedRoutes(
  config: ResolvedConfig,
  routes: RouteManifestEntry[],
): Promise<void> {
  const nextConfig = getNextConfig()
  const typedRoutes = nextConfig.typedRoutes === true

  const manifest = await buildRouteTypesManifest({ config, routes, nextConfig })

  // Next writes generated types into `<distDir>/types`; the harness maps
  // distDir to `.next`, and the fixtures read `<distDir>/types/*` + include
  // them via tsconfig's `**/*.ts` glob.
  const typesDir = path.join(config.root, '.next', 'types')

  await writeIfChanged(path.join(typesDir, 'routes.d.ts'), generateRouteTypesFile(manifest))

  // Import specifiers in validator.ts are relative to the validator file's dir.
  const toImportSpecifier = (rootRelativePath: string): string => {
    const abs = path.join(config.root, rootRelativePath)
    const rel = toPosixPath(path.relative(typesDir, abs))
    return rel.startsWith('.') ? rel : `./${rel}`
  }
  await writeIfChanged(
    path.join(typesDir, 'validator.ts'),
    generateValidatorFile(manifest, toImportSpecifier),
  )

  if (typedRoutes) {
    await writeIfChanged(path.join(typesDir, 'link.d.ts'), generateLinkTypesFile(manifest))
  }

  // Next generates `<distDir>/types/root-params.d.ts` — a `declare module
  // 'next/root-params'` with one async getter per root param — and imports it
  // from next-env.d.ts (typecheck suite runs the app's own `tsc --noEmit`).
  await writeIfChanged(
    path.join(typesDir, 'root-params.d.ts'),
    rootParamsTypesFile(scanRootParamTypes(path.join(config.root, 'app'))),
  )

  // Next writes `next-env.d.ts` with reference imports so tsc - which does NOT traverse the dotfolder
  // `.next/` via the tsconfig glob - pulls the generated types, and thus the global
  // PageProps/LayoutProps/RouteContext and the next/link href augmentation, into the program. Without it a
  // plain `tsc --noEmit` in the app never sees the generated files.
  await writeNextEnv(config.root, typedRoutes)
}

// Match Next's generated file byte-for-byte (ordering + comment banner): the
// getters sort by name, and value types print string, string[], undefined.
function rootParamsTypesFile(rootParams: Map<string, Set<RootParamValueType>>): string {
  if (rootParams.size === 0) {
    return `// Type definitions for Next.js root params (next/root-params)\n// No root params detected.\nexport {}\n`
  }
  const order: RootParamValueType[] = ['string', 'string[]', 'undefined']
  const getters = [...rootParams.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, types]) => {
      const union = order.filter(type => types.has(type)).join(' | ')
      return `  export function ${name}(): Promise<${union}>`
    })
  return `// Type definitions for Next.js root params (next/root-params)\n\ndeclare module 'next/root-params' {\n${getters.join('\n')}\n}\n`
}

async function writeNextEnv(root: string, typedRoutes: boolean): Promise<void> {
  const lines = [
    '/// <reference types="next" />',
    'import "./.next/types/routes.d.ts";',
    'import "./.next/types/root-params.d.ts";',
  ]
  if (typedRoutes) lines.push('import "./.next/types/link.d.ts";')
  lines.push('', '// NOTE: This file should not be edited', '')
  await writeIfChanged(path.join(root, 'next-env.d.ts'), lines.join('\n'))
}
