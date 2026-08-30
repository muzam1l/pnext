#!/usr/bin/env bun
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { markBoot } from './boot/trace'
import { commandBinaryName, nameEsbuildProcess, namedBunBinary } from './boot/named-bin'

const MIN_BUN = '1.3.10'
// Not a floor but a hole in one: 1.3.14 segfaults about a second into serving,
// so a pnext server dies before its first response with no error of its own to
// show. 1.3.13 and 1.4.x are both fine.
const BROKEN_BUN = new Set(['1.3.14'])
const VERSION = packageVersion()
const COMMANDS = new Set([
  'dev',
  'build',
  'start',
  'analyze',
  'typegen',
  'create',
  'migrate',
  'info',
])

// Reached only if something bypassed bin/pnext (which guards the same way).
if (typeof Bun === 'undefined') {
  console.error(`pnext requires Bun >=${MIN_BUN}. Install it from https://bun.sh/get`)
  process.exit(1)
}
// A prerelease sorts below its own release, so compare the release: a 1.4.0-canary is a 1.4.0 here.
const bunVersion = Bun.version.split('-')[0] ?? Bun.version
if (BROKEN_BUN.has(bunVersion)) {
  console.error(
    `pnext does not support Bun ${Bun.version}: it crashes the process at runtime. ` +
      'Upgrade to latest Bun with `bun upgrade`.',
  )
  process.exit(1)
} else if (!Bun.semver.satisfies(bunVersion, `>=${MIN_BUN}`)) {
  console.error(
    `pnext requires Bun >=${MIN_BUN}, found ${Bun.version}. Upgrade with \`bun upgrade\`.`,
  )
  process.exit(1)
}

const [, , command, ...args] = process.argv
markBoot('cli:entry')

// A no-op once we already run under the command's name; otherwise it creates
// the hardlink so bin/pnext can exec it directly from the next run on.
namedBunBinary(commandBinaryName(command))

// Before any command lazily imports esbuild, which captures the binary path on
// module load.
nameEsbuildProcess()
markBoot('cli:naming')

try {
  if (command === '--version' || command === '-v') {
    console.log(VERSION)
  } else if (command === '--help' || command === '-h' || !command) {
    printHelp()
  } else if (COMMANDS.has(command) && (args.includes('--help') || args.includes('-h'))) {
    printCommandHelp(command)
  } else if (command === 'dev') {
    warnUnknownFlags(command, args)
    const { dev } = await import('./dev')
    await dev({
      root: positionalRoot(args),
      port: optionNumber(args, '--port'),
      hostname: optionString(args, '--hostname'),
    })
  } else if (command === 'build') {
    warnUnknownFlags(command, args)
    const { buildProject } = await import('./build')
    await buildProject(positionalRoot(args), {
      adapter: adapterOption(args),
      verbose: args.includes('--verbose'),
      debugBuildPaths: optionString(args, '--debug-build-paths'),
      buildMode: buildModeOption(args),
      debugPrerender: args.includes('--debug-prerender'),
    })
    // A live CSS worker thread races Bun's exit teardown (Linux: silent exit 1
    // after a successful build); stop it before force-exiting.
    await (await import('../css/build')).stopCssWorker()
    // Nothing here keeps the event loop alive on success, but a project's
    // next.config can (e.g. a stray setInterval) and Next's own `next build`
    // force-exits regardless of such handles. Do the same so `build` always
    // terminates once buildProject resolves.
    process.exit(0)
  } else if (command === 'start') {
    warnUnknownFlags(command, args)
    const root = positionalRoot(args)
    // The build emits src/cli/start.ts prebundled into one file; parsing that
    // instead of walking the framework's source graph is most of `start`'s
    // spawn→first-200. Absent (no build yet, custom outDir) → source path.
    const { prebuiltServerEntry } = await import('./serve/entry')
    const prebuilt = prebuiltServerEntry(root)
    const { start } = prebuilt
      ? ((await import(prebuilt)) as typeof import('./start'))
      : await import('./start')
    await start({
      root,
      port: optionNumber(args, '--port'),
      hostname: optionString(args, '--hostname'),
    })
  } else if (command === 'analyze') {
    warnUnknownFlags(command, args)
    const { analyzeProject } = await import('./analyze')
    const { route, root } = analyzePositionals(args)
    const result = await analyzeProject(root, {
      compression: analyzeCompression(args),
      route,
    })
    if (args.includes('--json')) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      const { printAnalyzeResult } = await import('./analyze')
      printAnalyzeResult(result, { route, files: args.includes('--files') })
    }
  } else if (command === 'typegen') {
    warnUnknownFlags(command, args)
    const { typegenProject } = await import('./typegen')
    const result = await typegenProject(positionalRoot(args))
    console.log(
      `Generated ${result.routes} route types, ${result.aliases} aliases, and ${result.checks} checks at ${result.file}`,
    )
    // Like `next typegen`, exit even when the loaded next.config leaves open
    // handles (timers/connections) alive — a one-shot command must not hang.
    process.exit(0)
  } else if (command === 'create') {
    warnUnknownFlags(command, args)
    const { createApp } = await import('./create')
    await createApp(positionals(args)[0], { install: !args.includes('--no-install') })
    process.exit(0)
  } else if (command === 'migrate') {
    warnUnknownFlags(command, args)
    const { migrateApp } = await import('./migrate/run')
    const code = await migrateApp(positionalRoot(args), { dryRun: args.includes('--dry-run') })
    process.exit(code)
  } else if (command === 'info') {
    warnUnknownFlags(command, args)
    printInfo()
  } else {
    printHelp()
    process.exit(command ? 1 : 0)
  }
} catch (error) {
  const formatted = formatCliError(error)
  // A blank formatted message exits 1 with no explanation; fall back to the
  // raw error so the failure is never silent.
  if (formatted.message.trim()) console.error(formatted.message)
  else
    console.error(
      error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error),
    )
  if (formatted.trace) console.log(`\n${formatted.trace}`)
  process.exit(1)
}

function formatCliError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const traceStart = message.indexOf('\npnext client import trace for route ')
  if (traceStart === -1) return { message }
  return {
    message: message.slice(0, traceStart),
    trace: message.slice(traceStart + 1),
  }
}

function positionalRoot(args: string[]) {
  return positionals(args)[0]
}

// The analyze command takes optional [route] and [directory] positionals. A
// leading-slash argument is the route filter unless it points at a directory
// that looks like a project root — system directories like /home or /run
// collide with real route names.
function analyzePositionals(args: string[]) {
  let route: string | undefined
  let root: string | undefined
  for (const arg of positionals(args)) {
    if (!route && arg.startsWith('/') && !isProjectDirectory(arg)) route = arg
    else root ??= arg
  }
  return { route, root }
}

function isProjectDirectory(candidate: string) {
  if (!isDirectory(candidate)) return false
  return ['package.json', '.pnext', 'app', path.join('src', 'app')].some(entry =>
    existsSync(path.join(candidate, entry)),
  )
}

function positionals(args: string[]) {
  const out: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg) continue
    if (
      arg === '--port' ||
      arg === '--adapter' ||
      arg === '--hostname' ||
      arg === '--debug-build-paths' ||
      arg === '--experimental-build-mode'
    ) {
      index += 1
      continue
    }
    if (!arg.startsWith('--')) out.push(arg)
  }
  return out
}

function isDirectory(candidate: string) {
  try {
    return statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

function optionNumber(args: string[], name: string) {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  return value ? Number(value) : undefined
}

function optionString(args: string[], name: string) {
  // Accept both `--name value` and `--name=value`.
  const inline = args.find(arg => arg.startsWith(`${name}=`))
  if (inline !== undefined) return inline.slice(name.length + 1)
  const index = args.indexOf(name)
  if (index === -1) return undefined
  return args[index + 1]
}

/**
 * `next build --experimental-build-mode compile|generate` parity. Both the
 * space (`--experimental-build-mode generate`) and equals
 * (`--experimental-build-mode=generate`) forms are accepted; `generate` runs
 * the standard full build (idempotent over a prior `compile` run).
 */
function buildModeOption(args: string[]): 'compile' | 'generate' | undefined {
  const value = optionString(args, '--experimental-build-mode')
  if (value === 'compile' || value === 'generate') return value
  if (value !== undefined) {
    console.error(
      `error: option '--experimental-build-mode <mode>' argument '${value}' is invalid. Expected 'compile' or 'generate'.`,
    )
    process.exit(1)
  }
  return undefined
}

function adapterOption(args: string[]) {
  const index = args.indexOf('--adapter')
  if (index === -1) return undefined
  const adapter = args[index + 1]
  if (adapter === 'vercel') return adapter
  throw new Error(`Unsupported adapter: ${adapter ?? ''}`)
}

function analyzeCompression(args: string[]) {
  return args.includes('--brotli') ? 'brotli' : 'gzip'
}

function packageVersion() {
  const packageJson = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as {
    version?: unknown
  }
  return typeof packageJson.version === 'string' ? packageJson.version : 'unknown'
}

function warnUnknownFlags(command: string, args: string[]) {
  const flags = commandFlags(command)
  for (const arg of args) {
    if (!arg.startsWith('-') || arg === '--') continue
    const name = arg.startsWith('--') ? arg.split('=', 1)[0]! : arg
    if (!flags.has(name)) console.warn(`Warning: unknown option '${name}' was ignored.`)
  }
}

function commandFlags(command: string) {
  const flags = new Set(['--help', '-h'])
  if (command === 'dev' || command === 'start') {
    flags.add('--port')
    flags.add('--hostname')
  }
  if (command === 'build') {
    for (const flag of [
      '--adapter',
      '--verbose',
      '--experimental-build-mode',
      '--debug-build-paths',
      '--debug-prerender',
    ])
      flags.add(flag)
  }
  if (command === 'analyze') for (const flag of ['--json', '--files', '--brotli']) flags.add(flag)
  if (command === 'create') flags.add('--no-install')
  if (command === 'migrate') flags.add('--dry-run')
  return flags
}

function printInfo() {
  const config = configPresence(process.cwd())
  console.log(`pnext info
  pnext: ${VERSION}
  bun: ${Bun.version}
  os: ${process.platform} ${process.arch}
  package manager: ${packageManager(process.cwd())}
  pnext.config: ${config.pnext}
  next.config: ${config.next}`)
}

function packageManager(root: string) {
  if (existsSync(path.join(root, 'bun.lock')) || existsSync(path.join(root, 'bun.lockb')))
    return 'bun'
  if (existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(path.join(root, 'yarn.lock'))) return 'yarn'
  if (existsSync(path.join(root, 'package-lock.json'))) return 'npm'
  return 'unknown'
}

function configPresence(root: string) {
  const find = (base: string) => {
    const file = ['js', 'mjs', 'cjs', 'ts']
      .map(extension => `${base}.${extension}`)
      .find(file => existsSync(path.join(root, file)))
    return file ?? 'none'
  }
  return { pnext: find('pnext.config'), next: find('next.config') }
}

function printHelp() {
  console.log(`pnext ${VERSION}

Usage: pnext <command> [options]

Commands:
  dev       Start the development server.
  build     Create a production build.
  start     Start the production server.
  analyze   Analyze production bundle output.
  typegen   Generate route TypeScript definitions.
  create    Create a new pnext application.
  migrate   Migrate a Next.js application to pnext.
  info      Print environment details for bug reports.

Common flags:
  --port <port>          Port to listen on (default: 3000).
  --hostname <hostname>  Hostname to listen on (default: 0.0.0.0).
  --version, -v          Print the pnext version.
  --help, -h             Show this help message.

Docs: https://pnext.dev`)
}

function printCommandHelp(command: string) {
  const help: Record<string, string> = {
    dev: `Usage: pnext dev [directory] [options]\n\nFlags:\n  --port <port>          Port to listen on (default: 3000).\n  --hostname <hostname>  Hostname to listen on (default: 0.0.0.0).`,
    build: `Usage: pnext build [directory] [options]\n\nFlags:\n  --adapter <adapter>                  Deployment adapter (vercel).\n  --verbose                            Print detailed build output.\n  --experimental-build-mode <mode>     Build mode: compile or generate.\n  --debug-build-paths <patterns>       Build matching routes only.\n  --debug-prerender                    Debug prerender failures.`,
    start: `Usage: pnext start [directory] [options]\n\nFlags:\n  --port <port>          Port to listen on (default: 3000).\n  --hostname <hostname>  Hostname to listen on (default: 0.0.0.0).`,
    analyze: `Usage: pnext analyze [route] [directory] [options]\n\nFlags:\n  --json                 Print JSON output.\n  --files                Include individual files.\n  --brotli               Report Brotli compression.`,
    typegen: 'Usage: pnext typegen [directory]',
    create:
      'Usage: pnext create <directory> [options]\n\nFlags:\n  --no-install           Skip dependency installation.',
    migrate:
      'Usage: pnext migrate [directory] [options]\n\nFlags:\n  --dry-run              Preview changes without writing.',
    info: 'Usage: pnext info',
  }
  console.log(help[command])
}
