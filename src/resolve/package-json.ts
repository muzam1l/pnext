// package.json reads and workspace-root discovery, which config loading needs without the resolver.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
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

  const found = workspaceRootInfo(key).root
  workspaceRootCache.set(key, found)
  return found
}

export function workspaceRootInfo(root: string): {
  root?: string
  lockfiles: string[]
  boundary?: { directory: string; marker: string; type: 'repository' | 'home' }
} {
  const start = realpathSync(root)
  let home = homedir()
  try {
    home = realpathSync(home)
  } catch {
    // A nonexistent home retains its lexical boundary.
  }
  let repository: { directory: string; worktree: boolean } | undefined
  const lockfiles: string[] = []
  const workspaces: string[] = []
  let dir = start
  while (true) {
    const git = path.join(dir, '.git')
    if (!repository && existsSync(git)) {
      if (statSync(git).isDirectory()) repository = { directory: dir, worktree: false }
      else {
        const target = /^gitdir: (.+?)[\r\n]*$/s.exec(readFileSync(git, 'utf8'))?.[1]
        if (target && existsSync(path.resolve(dir, target, 'commondir'))) {
          repository = { directory: dir, worktree: true }
        }
      }
    }
    const workspaceMarker =
      ['pnpm-workspace.yaml', 'lerna.json'].map(name => path.join(dir, name)).find(existsSync) ??
      (readPackageJson(dir).workspaces != null ? path.join(dir, 'package.json') : undefined)
    const lockfile = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb']
      .map(name => path.join(dir, name))
      .find(existsSync)
    if (workspaceMarker) workspaces.push(workspaceMarker)
    if (lockfile) lockfiles.push(lockfile)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  // Workspace declarations take precedence over lockfiles, including those below a rejected marker.
  const candidates = workspaces.length ? workspaces : lockfiles
  const accepted: string[] = []
  let boundary: ReturnType<typeof workspaceRootInfo>['boundary']
  for (const marker of candidates) {
    const directory = path.dirname(marker)
    if (directory !== start) {
      if (repository && !isWithin(repository.directory, directory)) {
        if (!repository.worktree)
          boundary = { directory: repository.directory, marker, type: 'repository' }
        break
      }
      if (isWithin(directory, home)) {
        boundary = { directory: home, marker, type: 'home' }
        break
      }
    }
    accepted.push(marker)
  }
  return {
    root: accepted.length
      ? path.dirname(accepted[accepted.length - 1]!)
      : candidates.length
        ? start
        : undefined,
    lockfiles: workspaces.length ? [] : accepted,
    boundary,
  }
}

function isWithin(root: string, file: string) {
  const relative = path.relative(root, file)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function readJson<T>(file: string) {
  if (!existsSync(file)) return undefined
  return JSON.parse(readFileSync(file, 'utf8')) as T
}
