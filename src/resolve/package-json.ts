// package.json reads and workspace-root discovery, which config loading needs without the resolver.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

type PackageExport = unknown

export interface PackageJson {
  name?: string
  type?: string
  browser?: string
  main?: string
  module?: string
  source?: string
  exports?: PackageExport
  imports?: Record<string, PackageExport>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  workspaces?: string[] | { packages?: string[] }
}

const packageJsonCache = new Map<string, PackageJson>()
const workspaceRootCache = new Map<string, string | undefined>()

export function readPackageJson(root: string) {
  const existing = packageJsonCache.get(root)
  if (existing) return existing
  const config = readJson<PackageJson>(path.join(root, 'package.json')) ?? {}
  packageJsonCache.set(root, config)
  return config
}

export function findWorkspaceRoot(root: string) {
  const key = path.resolve(root)
  if (workspaceRootCache.has(key)) return workspaceRootCache.get(key)

  let dir = key
  while (true) {
    if (readPackageJson(dir).workspaces || existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      workspaceRootCache.set(key, dir)
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) {
      workspaceRootCache.set(key, undefined)
      return undefined
    }
    dir = parent
  }
}

function readJson<T>(file: string) {
  if (!existsSync(file)) return undefined
  return JSON.parse(readFileSync(file, 'utf8')) as T
}
