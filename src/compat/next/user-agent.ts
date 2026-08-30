// Pure (client-safe) `next/server` helpers: userAgent parsing + URLPattern.
//
// These carry no request scope and import no node:* builtins, so both the
// server entry (server.ts) and the client-safe entry (client-server.ts)
// re-export them. Kept in their own module so the client `next/server` variant
// can pull them in without dragging server.ts's node:async_hooks imports
// (request/context, ppr, cache/revalidate) into the browser bundle.

/** Native URLPattern when the runtime provides one (Bun/Node 23+/browsers). */
export const URLPattern = (globalThis as { URLPattern?: unknown }).URLPattern

export interface UserAgent {
  ua: string
  browser: { name?: string; version?: string }
  os: { name?: string; version?: string }
  device: { type?: string; vendor?: string; model?: string }
  engine: { name?: string; version?: string }
  cpu: { architecture?: string }
  isBot: boolean
}

const botPattern =
  /bot|crawler|spider|crawling|slurp|bingpreview|facebookexternalhit|mediapartners|headless/i

export function userAgentFromString(input: string | undefined): UserAgent {
  const ua = input ?? ''
  return {
    ua,
    browser: parseBrowser(ua),
    os: parseOs(ua),
    device: parseDevice(ua),
    engine: parseEngine(ua),
    cpu: parseCpu(ua),
    isBot: botPattern.test(ua),
  }
}

export function userAgent({ headers }: { headers: Headers }): UserAgent {
  return userAgentFromString(headers.get('user-agent') ?? undefined)
}

function parseBrowser(ua: string): UserAgent['browser'] {
  const edge = ua.match(/Edg(?:e|A|iOS)?\/([\d.]+)/)
  if (edge) return { name: 'Edge', version: edge[1] }
  const samsung = ua.match(/SamsungBrowser\/([\d.]+)/)
  if (samsung) return { name: 'Samsung Internet', version: samsung[1] }
  const chrome = ua.match(/(?:Chrome|CriOS)\/([\d.]+)/)
  if (chrome) return { name: 'Chrome', version: chrome[1] }
  const firefox = ua.match(/(?:Firefox|FxiOS)\/([\d.]+)/)
  if (firefox) return { name: 'Firefox', version: firefox[1] }
  if (ua.includes('Safari')) return { name: 'Safari', version: ua.match(/Version\/([\d.]+)/)?.[1] }
  return {}
}

function parseEngine(ua: string): UserAgent['engine'] {
  const gecko = ua.match(/rv:([\d.]+)\).*Gecko/)
  if (gecko) return { name: 'Gecko', version: gecko[1] }
  const webkit = ua.match(/AppleWebKit\/([\d.]+)/)
  if (webkit) {
    const chrome = ua.match(/(?:Chrome|CriOS|Edg(?:e|A|iOS)?|OPR)\/([\d.]+)/)
    if (chrome) return { name: 'Blink', version: chrome[1] }
    return { name: 'WebKit', version: webkit[1] }
  }
  return {}
}

function parseCpu(ua: string): UserAgent['cpu'] {
  if (/arm64|aarch64/i.test(ua)) return { architecture: 'arm64' }
  if (/\barm\b/i.test(ua)) return { architecture: 'arm' }
  if (/x86_64|x64|Win64|WOW64/i.test(ua)) return { architecture: 'amd64' }
  if (/i686|\bx86\b/i.test(ua)) return { architecture: 'ia32' }
  return {}
}

function parseOs(ua: string): UserAgent['os'] {
  if (ua.includes('Windows'))
    return { name: 'Windows', version: ua.match(/Windows NT ([\d.]+)/)?.[1] }
  if (ua.includes('Android')) return { name: 'Android', version: ua.match(/Android ([\d.]+)/)?.[1] }
  if (/iPhone|iPad|iPod/.test(ua)) {
    return { name: 'iOS', version: ua.match(/OS (\d+(?:[_.]\d+)*)/)?.[1]?.replace(/_/g, '.') }
  }
  if (ua.includes('Mac OS X')) {
    return {
      name: 'Mac OS',
      version: ua.match(/Mac OS X (\d+(?:[_.]\d+)*)/)?.[1]?.replace(/_/g, '.'),
    }
  }
  if (ua.includes('Linux')) return { name: 'Linux' }
  return {}
}

function parseDevice(ua: string): UserAgent['device'] {
  if (ua.includes('iPhone')) return { type: 'mobile', vendor: 'Apple', model: 'iPhone' }
  if (ua.includes('iPad')) return { type: 'tablet', vendor: 'Apple', model: 'iPad' }
  if (ua.includes('Android')) {
    const type = ua.includes('Mobile') ? 'mobile' : 'tablet'
    const samsung = ua.match(/\b(SM-[\w]+)\b/)
    if (samsung) return { type, vendor: 'Samsung', model: samsung[1] }
    const pixel = ua.match(/;\s*(Pixel[\w ]*?)\s*(?:Build|\))/)
    if (pixel) return { type, vendor: 'Google', model: pixel[1] }
    return { type }
  }
  return ua.includes('Mobile') ? { type: 'mobile' } : {}
}
