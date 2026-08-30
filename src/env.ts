import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'dotenv'

type EnvMap = Record<string, string>

export interface LoadedEnvFile {
  env: EnvMap
  path: string
}

export interface LoadEnvResult {
  loadedEnvFiles: LoadedEnvFile[]
  mode: string
}

export async function loadEnv(
  root: string,
  options: { dev?: boolean } = {},
): Promise<LoadEnvResult> {
  const nodeEnvKey = 'NODE_ENV'
  const env = process.env as Record<string, string | undefined>
  if (!env[nodeEnvKey]) env[nodeEnvKey] = options.dev ? 'development' : 'production'

  const mode = process.env[nodeEnvKey] ?? 'production'
  const loadedEnvFiles: LoadedEnvFile[] = []
  for (const file of envFilesForMode(mode)) {
    const filePath = path.join(root, file)
    if (!(await isEnvFile(filePath))) continue

    const parsed = parse(await readFile(filePath, 'utf8'))
    const env = expandEnv(parsed)
    for (const [key, value] of Object.entries(env)) {
      if (process.env[key] === undefined) process.env[key] = value
    }
    loadedEnvFiles.push({ path: file, env })
  }

  return { mode, loadedEnvFiles }
}

function envFilesForMode(mode: string) {
  return [
    `.env.${mode}.local`,
    mode === 'test' ? undefined : '.env.local',
    `.env.${mode}`,
    '.env',
  ].filter((file): file is string => Boolean(file))
}

async function isEnvFile(file: string) {
  try {
    const info = await stat(file)
    return info.isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function expandEnv(parsed: EnvMap) {
  const env: EnvMap = {}
  for (const [key, value] of Object.entries(parsed)) {
    env[key] = expandValue(value, { ...parsed, ...env })
  }
  return env
}

function expandValue(value: string, parsed: EnvMap): string {
  let result = value
  for (
    let index = searchLastEnvReference(result), attempts = 0;
    index !== -1 && attempts < 100;
    index = searchLastEnvReference(result), attempts += 1
  ) {
    const match = result.slice(index).match(/^\$({?)([\w]+)(?::-([^}]*))?}?/)
    if (!match) break

    const token = match[0] ?? ''
    const braced = match[1] ?? ''
    const key = match[2] ?? ''
    const fallback = match[3] ?? ''
    const hasClosingBrace = braced ? token.endsWith('}') : true
    if (!hasClosingBrace) break

    const replacement = process.env[key] || fallback || parsed[key] || ''
    result = `${result.slice(0, index)}${replacement}${result.slice(index + token.length)}`
  }
  return result.replace(/\\\$/g, '$')
}

function searchLastEnvReference(value: string) {
  const matches = [...value.matchAll(/(?<!\\)\$/g)]
  return matches.length > 0 ? (matches.at(-1)?.index ?? -1) : -1
}
