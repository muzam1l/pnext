import path from 'node:path'
import { type ResolvedConfig } from '../../config'
import { setProxyExtensions, setProxyResponseProtocol } from '../../extensions'
import { findProxyFiles, setProxyRewriteObserver } from '../../routing/proxy'
import { moduleExportNames } from '../../resolve/scan-facts'
import { readText, toPosixPath } from '../../utils/fs'
import { recordRewrite } from '../protocol'
import { recordCanonicalUrl } from '../next/canonical-url'
import { getNextConfig } from '../next/config-loader'
import { activateTestProxy } from '../lifecycle/testmode'
import { legacyRequestAPIs } from '../../request/context'

export function registerProxyExtensions(_config: ResolvedConfig): void {
  setProxyResponseProtocol({
    nextHeader: 'x-middleware-next',
    rewriteHeader: 'x-middleware-rewrite',
  })
  setProxyExtensions({
    names: ['proxy', 'middleware'],
    validateFiles: validateNextProxyFiles,
    handlerExport: module => module.proxy ?? module.default ?? module.middleware,
    skipUrlNormalize: () => getNextConfig().skipProxyUrlNormalize === true,
    locale: proxyLocale,
    onExternalRewrite: request => activateTestProxy(request.headers),
    clientMaxBodySize: proxyClientMaxBodySize,
  })
  // A same-origin middleware rewrite feeds the Next rewrite-tracking channel so
  // RSC responses carry x-nextjs-rewritten-path/query (identical to next.config
  // rewrites; the RSC-only emission gate lives in compat/protocol.ts). The
  // ORIGINAL url is stashed too so usePathname/useSearchParams stay canonical.
  setProxyRewriteObserver((from, to) => {
    recordCanonicalUrl(from)
    recordRewrite(from, to)
  })
}

const DEFAULT_PROXY_CLIENT_MAX_BODY_SIZE = 10 * 1024 * 1024

// experimental.proxyClientMaxBodySize accepts bytes (2097152) or a size string
// ('5mb'); experimental.middlewareClientMaxBodySize is the deprecated alias.
function proxyClientMaxBodySize(): number {
  const experimental = (getNextConfig().experimental ?? {}) as Record<string, unknown>
  const raw = experimental.proxyClientMaxBodySize ?? experimental.middlewareClientMaxBodySize
  if (typeof raw === 'number' && raw > 0) return raw
  if (typeof raw === 'string') {
    const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(raw.trim())
    if (match?.[1]) {
      const unit = (match[2] ?? 'b').toLowerCase()
      const multiplier =
        unit === 'gb' ? 1024 ** 3 : unit === 'mb' ? 1024 ** 2 : unit === 'kb' ? 1024 : 1
      const bytes = Math.floor(Number(match[1]) * multiplier)
      if (bytes > 0) return bytes
    }
  }
  return DEFAULT_PROXY_CLIENT_MAX_BODY_SIZE
}

function proxyLocale(url: URL): string {
  const i18n = getNextConfig().i18n as { locales?: unknown } | undefined
  if (!Array.isArray(i18n?.locales)) return ''
  const locales = i18n.locales.filter((locale): locale is string => typeof locale === 'string')
  const dataLocale = /^\/_next\/data\/[^/]+\/([^/]+)(?:\/|$)/.exec(url.pathname)?.[1]
  const candidate = dataLocale ?? url.pathname.split('/')[1]
  return locales.find(locale => locale.toLowerCase() === candidate?.toLowerCase()) ?? ''
}

async function validateNextProxyFiles(config: ResolvedConfig) {
  const files = findProxyFiles(config, ['proxy', 'middleware'])
  const middleware = files.find(file => path.basename(file).startsWith('middleware.'))
  const proxy = files.find(file => path.basename(file).startsWith('proxy.'))
  if (middleware && proxy) {
    throw new Error(
      `Both middleware file "${relativeProxyPath(config, middleware)}" and proxy file "${relativeProxyPath(config, proxy)}" are detected. Please use "${relativeProxyPath(config, proxy)}" only.`,
    )
  }
  // Proxy is a Next 16 migration; legacy request APIs explicitly target the middleware era.
  if (middleware && !proxy && !legacyRequestAPIs()) {
    console.warn('The "middleware" file convention is deprecated. Please use "proxy" instead.')
  }
  await Promise.all(files.map(file => validateNextProxyFile(config, file)))
}

async function validateNextProxyFile(config: ResolvedConfig, file: string) {
  const source = await readText(file)
  const name = path.basename(file).split('.')[0]
  const exports = moduleExportNames(source, file)
  const validExport =
    exports.includes('default') ||
    (name === 'proxy' ? exports.includes('proxy') : exports.includes('middleware'))
  if (!validExport) {
    throw new Error(proxyMissingExportError(config, file))
  }
  if (name === 'proxy' && hasRuntimeConfig(source)) {
    throw new Error(
      `Route segment config is not allowed in Proxy file at "${relativeProxyPath(config, file)}". Proxy always runs on Node.js runtime. Learn more: https://nextjs.org/docs/messages/middleware-to-proxy`,
    )
  }
}

function proxyMissingExportError(config: ResolvedConfig, file: string) {
  const name = path.basename(file).split('.')[0] === 'middleware' ? 'middleware' : 'proxy'
  const migrationReason =
    name === 'proxy'
      ? "- You are migrating from `middleware` to `proxy`, but haven't updated the exported function.\n"
      : ''
  const target = name === 'proxy' ? 'proxy (previously called middleware)' : 'middleware'
  return `The file "${relativeProxyPath(config, file)}" must export a function, either as a default export or as a named "${name}" export.
This function is what Next.js runs for every request handled by this ${target}.

Why this happens:
${migrationReason}- The file exists but doesn't export a function.
- The export is not a function (e.g., an object or constant).
- There's a syntax error preventing the export from being recognized.

To fix it:
- Ensure this file has either a default or "${name}" function export.

Learn more: https://nextjs.org/docs/messages/middleware-to-proxy`
}

function hasRuntimeConfig(source: string) {
  return /\bexport\s+const\s+config\s*=/.test(source) && /\bruntime\s*:/.test(source)
}

function relativeProxyPath(config: ResolvedConfig, file: string) {
  return `./${toPosixPath(path.relative(config.root, file))}`
}
