import { format } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function formatServerConsole(...args: unknown[]): string {
  return format(...args).replace(
    /^(\s*at (?:.+? \()?)(file:\/\/\/.+|\/.+):(\d+):(\d+)(\)?(?: \{)?)$/gm,
    (_, prefix: string, file: string, line: string, column: string, suffix: string) =>
      `${prefix}${path.relative(process.cwd(), file.startsWith('file:') ? fileURLToPath(file) : file)}:${line}:${column}${suffix}`,
  )
}

const installed = Symbol.for('pnext.node-console-format-installed')

export function installNodeConsoleFormat(): void {
  const state = globalThis as typeof globalThis & Record<symbol, true | undefined>
  if (state[installed]) return
  state[installed] = true
  const log = console.log.bind(console)
  console.log = (...args: unknown[]) => log(formatServerConsole(...args))
  // Errors too: bun prints a thrown/logged Error as `error: message` (and uses
  // `err.name` alone for a renamed one), while Node — and therefore every Next
  // e2e expectation — prints util.inspect's `ClassName: message` /
  // `ClassName [name]: message` header followed by the stack.
  const error = console.error.bind(console)
  console.error = (...args: unknown[]) => error(formatServerConsole(...args))
  const warn = console.warn.bind(console)
  console.warn = (...args: unknown[]) => warn(formatServerConsole(...args))
}
