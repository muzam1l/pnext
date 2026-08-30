import { format } from 'node:util'

const installed = Symbol.for('pnext.node-console-format-installed')

export function installNodeConsoleFormat(): void {
  const state = globalThis as typeof globalThis & Record<symbol, true | undefined>
  if (state[installed]) return
  state[installed] = true
  const log = console.log.bind(console)
  console.log = (...args: unknown[]) => log(format(...args))
  // Errors too: bun prints a thrown/logged Error as `error: message` (and uses
  // `err.name` alone for a renamed one), while Node — and therefore every Next
  // e2e expectation — prints util.inspect's `ClassName: message` /
  // `ClassName [name]: message` header followed by the stack.
  const error = console.error.bind(console)
  console.error = (...args: unknown[]) => error(format(...args))
  const warn = console.warn.bind(console)
  console.warn = (...args: unknown[]) => warn(format(...args))
}
