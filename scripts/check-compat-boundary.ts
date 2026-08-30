#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// Core -> compat boundary guard.
//
// Fails if any file under src/ (excluding src/compat/) statically imports (or
// re-exports, or `import type`s) from src/compat/. The ONLY permitted edge is
// the single gated dynamic import in src/compat-bootstrap.ts. Run in CI via the
// package lint script. Compat -> core is allowed and not checked here.
// ---------------------------------------------------------------------------

import { readdir, readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { internalSourceFiles, isNestedProjectRoot } from './source-boundary.ts'

const packageRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..')
const srcDir = path.join(packageRoot, 'src')
const compatDir = path.join(srcDir, 'compat')
const bootstrapFile = path.join(srcDir, 'compat-bootstrap.ts')

// Static `import ... from '...'`, `export ... from '...'` (single- or multi-line),
// and bare `import '...'`. Dynamic `import('...')` is intentionally NOT matched
// (the one allowed edge). `[^;]` (not `[^\n]`) so multi-line named imports match.
const staticImportPattern =
  /\b(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (full === compatDir) continue // compat may import compat freely
      if (isNestedProjectRoot(full)) continue // vendored project, not pnext source
      yield* walk(full)
    } else if (/\.tsx?$/.test(entry.name)) {
      yield full
    }
  }
}

function resolvesIntoCompat(fromFile: string, specifier: string): boolean {
  if (!specifier.startsWith('.')) return false
  const resolved = path.resolve(path.dirname(fromFile), specifier)
  return resolved === compatDir || resolved.startsWith(compatDir + path.sep)
}

const violations: string[] = []
for await (const file of walk(srcDir)) {
  if (file === bootstrapFile) continue // the single gated dynamic-import edge
  const rel = path.relative(packageRoot, file).split(path.sep).join('/')
  const source = await readFile(file, 'utf8')
  for (const match of source.matchAll(staticImportPattern)) {
    const specifier = match[1] ?? match[2]
    if (!specifier || !resolvesIntoCompat(file, specifier)) continue
    violations.push(`${rel} -> ${specifier}`)
  }
}

if (violations.length > 0) {
  console.error(
    'Core -> compat boundary violation: core (src/ outside src/compat/) must not\n' +
      'statically import src/compat/. Use an extension registry seam instead.\n',
  )
  for (const violation of violations) console.error(`  ${violation}`)
  process.exit(1)
}

console.log('check-compat-boundary: OK')

// Every .tsx that is pnext's own source (see source-boundary.ts) must carry the preact
// jsxImportSource pragma: the Bun runtime ignores
// tsconfig jsxImportSource for files under node_modules, so an npm-installed pnext would compile
// a pragma-less file with the REACT automatic runtime (react.shared-subset crash on React 18,
// silent react/preact mixing on 19). Files using h() explicitly still need it if they contain JSX.
const missingPragma: string[] = []
for (const file of internalSourceFiles(srcDir, /\.tsx$/)) {
  const source = readFileSync(file, 'utf8')
  if (!/<[A-Za-z]/.test(source)) continue // no JSX syntax, pragma irrelevant
  if (!source.includes('@jsxImportSource preact')) {
    missingPragma.push(path.relative(packageRoot, file).split(path.sep).join('/'))
  }
}
if (missingPragma.length > 0) {
  console.error(
    '.tsx files missing /** @jsxImportSource preact */ (required: Bun ignores tsconfig\n' +
      'jsxImportSource under node_modules, so npm installs would compile these with React):\n',
  )
  for (const file of missingPragma) console.error(`  ${file}`)
  process.exit(1)
}
console.log('check-jsx-pragma: OK')
