import { networkInterfaces } from 'node:os'
import { bold, cyan, dim, green } from '../../utils/ansi'

interface ReadyBanner {
  /** Short mode label shown after the mark, e.g. "dev" or "production". */
  mode: string
  /** The bind hostname, used to derive Local/Network URLs. */
  hostname: string
  port: number
  /** Milliseconds to boot, when known (dev server startup). */
  elapsedMs?: number
}

/**
 * The hostname a browser should actually visit. Loopback and wildcard binds all
 * present as `localhost` so cookies and trusted-origin checks (e.g. auth) line
 * up with the canonical dev origin instead of a raw `127.0.0.1`.
 */
export function browserHost(hostname: string) {
  // IPv6 binds present their bracketed loopback (Next prints http://[::1]:port).
  if (hostname === '::' || hostname === '::1') return '[::1]'
  if (['0.0.0.0', '127.0.0.1'].includes(hostname)) return 'localhost'
  return hostname
}

/** Print a Next.js-style "server ready" banner with local and network URLs. */
export function printServerReady({ mode, hostname, port, elapsedMs }: ReadyBanner) {
  const rows: [string, string][] = [['Local:', cyan(`http://${browserHost(hostname)}:${port}`)]]

  // When bound to all interfaces, surface the LAN address so it's reachable
  // from other devices (phones, other machines) without hunting for the IP.
  // Next prints the bracketed wildcard itself for IPv6 (`http://[::]:port`).
  const lan = hostname === '::' ? '[::]' : wildcard(hostname) ? lanAddress() : undefined
  if (lan) rows.push(['Network:', cyan(`http://${lan}:${port}`)])

  const ready =
    elapsedMs === undefined
      ? `${green('✓')} ${bold('Ready')}`
      : `${green('✓')} ${bold('Ready')} ${dim(`in ${Math.round(elapsedMs)}ms`)}`

  const pad = Math.max(...rows.map(([label]) => label.length))
  console.log('')
  console.log(`${cyan('▲')} ${bold('pnext')} ${dim(mode)}`)
  for (const [label, value] of rows) {
    console.log(`  ${dim('-')} ${dim(label.padEnd(pad))}  ${value}`)
  }
  console.log('')
  console.log(ready)
  console.log('')
}

function wildcard(hostname: string) {
  return hostname === '0.0.0.0' || hostname === '::'
}

/**
 * Fail fast when the port is already served on any loopback address. Binding checks alone miss the
 * case that bites: one server holding IPv4 127.0.0.1 and another IPv6 ::1 - no bind conflict, but
 * `localhost` resolves to both and the browser silently alternates between old and new servers.
 */
export async function ensurePortFree(
  port: number,
  hostname: string,
  options: { attempts?: number; delayMs?: number } = {},
) {
  const attempts = options.attempts ?? 1
  const delayMs = options.delayMs ?? 300
  const candidates =
    wildcard(hostname) || hostname === 'localhost' ? ['127.0.0.1', '::1'] : [hostname]

  for (const candidate of candidates) {
    let inUse = await portInUse(candidate, port)
    // A respawning server may race its predecessor's shutdown; give it a beat.
    for (let attempt = 1; inUse && attempt < attempts; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs))
      inUse = await portInUse(candidate, port)
    }
    if (inUse) {
      throw new Error(
        `Port ${port} is already in use on ${candidate} (another pnext dev/start or process). ` +
          `Stop it or pass --port. To find it:` +
          `  lsof -nP -iTCP:${port} -sTCP:LISTEN`,
      )
    }
  }
}

function portInUse(hostname: string, port: number) {
  return new Promise<boolean>(resolve => {
    const timer = setTimeout(() => resolve(false), 300)
    Bun.connect({
      hostname,
      port,
      socket: {
        open(socket) {
          clearTimeout(timer)
          socket.end()
          resolve(true)
        },
        data() {
          // Only connectability matters; any payload is ignored.
        },
        connectError() {
          clearTimeout(timer)
          resolve(false)
        },
        error() {
          clearTimeout(timer)
          resolve(false)
        },
      },
    }).catch(() => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

/** First non-internal IPv4 address, or undefined when offline. */
function lanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address
    }
  }
  return undefined
}

/**
 * Open the given URL in the user's default browser. Best-effort and silent:
 * never throws if the platform `open` command is missing.
 *
 * Honors the Vite/CRA-standard `BROWSER` env var: `BROWSER=none` (or `CI`)
 * disables auto-open, and `BROWSER=<app>` opens with that specific browser,
 * passing any `BROWSER_ARGS` (whitespace-separated) ahead of the URL.
 */
export function openBrowser(url: string) {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const browser = process.env.BROWSER
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  if (browser === 'none' || process.env.CI || process.env.NODE_ENV === 'test') return

  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const browserArgs = process.env.BROWSER_ARGS?.split(/\s+/).filter(Boolean) ?? []
  const command = browser
    ? process.platform === 'darwin'
      ? ['open', '-a', browser, ...browserArgs, url]
      : [browser, ...browserArgs, url]
    : process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url]

  try {
    Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' }).unref()
  } catch {
    // ignore: opening a browser is a convenience, not a requirement
  }
}
