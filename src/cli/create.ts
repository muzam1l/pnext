import { existsSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { bold, cyan, dim, green } from '../utils/ansi'
import { latestPnextVersionRange } from '../utils/registry'
import { formatDuration } from '../utils/verbose'

export interface CreateAppOptions {
  install: boolean
}

export async function createApp(dir: string | undefined, options: CreateAppOptions) {
  if (!dir) {
    console.log('Usage: pnext create <directory> [--no-install]')
    throw new Error('pnext create requires a directory argument')
  }

  const target = path.resolve(dir)
  if (existsSync(target)) {
    if ((await readdir(target)).length > 0) {
      throw new Error(`Directory already exists and is not empty: ${target}`)
    }
  } else {
    await mkdir(target, { recursive: true })
  }

  const name = sanitizePackageName(path.basename(target))
  console.log(`⚡ ${bold('pnext create')} ${dim(`— scaffolding ${name}`)}\n`)

  const files = await scaffoldFiles(name, await latestPnextVersionRange('create'))
  await Promise.all(
    Object.entries(files).map(([file, source]) => Bun.write(path.join(target, file), source)),
  )
  for (const file of Object.keys(files).sort()) console.log(`  ${green('+')} ${dim(file)}`)

  let installed = false
  if (options.install) {
    console.log('')
    installed = await install(target, dir)
  }

  printNextSteps(dir, installed)
}

// npm package name rules: lowercase, url-safe, no leading dot/underscore.
function sanitizePackageName(raw: string) {
  const name = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
  return name || 'pnext-app'
}

async function install(target: string, dir: string) {
  const stop = spinner('Installing dependencies...')
  const start = Bun.nanoseconds()
  const proc = Bun.spawn(['bun', 'install'], { cwd: target, stdout: 'pipe', stderr: 'pipe' })
  // Drain both pipes: an unread pipe can fill and stall the child.
  const [stderr, , code] = await Promise.all([
    new Response(proc.stderr).text(),
    new Response(proc.stdout).text(),
    proc.exited,
  ])
  stop()

  if (code === 0) {
    const durationMs = (Bun.nanoseconds() - start) / 1e6
    console.log(
      `${green('✓')} ${bold('Installed dependencies')} ${dim(`in ${formatDuration(durationMs)}`)}`,
    )
    return true
  }
  console.log(`${dim('Install failed. Run it manually:')}`)
  console.log(`  ${cyan('cd')} ${dir}`)
  console.log(`  ${cyan('bun install')}`)
  if (stderr.trim()) console.log(dim(stderr.trim()))
  return false
}

/** Braille spinner, TTY-only; a plain line prints once and stays put otherwise. */
function spinner(label: string) {
  if (!process.stdout.isTTY) {
    console.log(label)
    return () => undefined
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  let frame = 0
  process.stdout.write(`${cyan(frames[0]!)} ${label}`)
  const timer = setInterval(() => {
    frame = (frame + 1) % frames.length
    process.stdout.write(`\r${cyan(frames[frame]!)} ${label}`)
  }, 80)
  return () => {
    clearInterval(timer)
    process.stdout.write('\r\x1b[K')
  }
}

function printNextSteps(dir: string, installed: boolean) {
  const commands = installed ? [`cd ${dir}`, 'bun dev'] : [`cd ${dir}`, 'bun install', 'bun dev']
  const title = 'Next steps'
  const width = Math.max(title.length, ...commands.map(c => c.length)) + 2
  const row = (text: string, colorFn: (s: string) => string = s => s) =>
    `${dim('│')} ${colorFn(text.padEnd(width))} ${dim('│')}`

  console.log('')
  console.log(dim(`┌${'─'.repeat(width + 2)}┐`))
  console.log(row(title, bold))
  console.log(row(''))
  for (const cmd of commands) console.log(row(cmd, cyan))
  console.log(dim(`└${'─'.repeat(width + 2)}┘`))
}

// The template is a real runnable app in src/cli/template; files are copied verbatim with the
// placeholder name swapped, and package.json gets the app name and pnext version stamped in.
const TEMPLATE_DIR = path.join(import.meta.dir, 'template')
const PLACEHOLDER_NAME = 'pnext-app'

async function scaffoldFiles(name: string, pnextRange: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  for (const entry of await readdir(TEMPLATE_DIR, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const rel = path.relative(TEMPLATE_DIR, path.join(entry.parentPath, entry.name))
    const source = await Bun.file(path.join(TEMPLATE_DIR, rel)).text()
    // npm strips .gitignore from published tarballs, so the template stores it unprefixed.
    if (rel === 'gitignore') {
      files['.gitignore'] = source
    } else if (rel === 'package.json') {
      const pkg = JSON.parse(source) as { name: string; devDependencies: Record<string, string> }
      pkg.name = name
      pkg.devDependencies['@wular/pnext'] = pnextRange
      files[rel] = `${JSON.stringify(pkg, null, 2)}\n`
    } else {
      files[rel] = source.replaceAll(PLACEHOLDER_NAME, name)
    }
  }
  return files
}
