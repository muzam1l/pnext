#!/usr/bin/env node
// Bump the package version. Usage: node scripts/bump.mjs <major|minor|patch> (default: patch)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const level = (process.argv[2] ?? 'patch').toLowerCase()
if (!['major', 'minor', 'patch'].includes(level)) {
  console.error(`Unknown bump level "${level}". Use one of: major, minor, patch.`)
  process.exit(1)
}

const pkgPath = path.join(root, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version.trim())
if (!match) {
  console.error(`Cannot bump non-semver version "${pkg.version}".`)
  process.exit(1)
}
let [major = 0, minor = 0, patch = 0] = match.slice(1).map(Number)
if (level === 'major') [major, minor, patch] = [major + 1, 0, 0]
else if (level === 'minor') [minor, patch] = [minor + 1, 0]
else patch += 1

const next = `${major}.${minor}.${patch}`
fs.writeFileSync(pkgPath, `${JSON.stringify({ ...pkg, version: next }, null, 2)}\n`)
console.log(`Bumped pnext ${pkg.version} -> ${next} (${level}). Run \`npm publish\` to ship it.`)
