import { copyFile, cp, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { constants, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileHref } from '../../config'
import type { ResolvedConfig } from '../../config'
import { nextCompatEnabled } from '../../render/hooks'
import { findProxyFile, proxyRoutePatterns, type ProxyModule } from '../../routing/proxy'
import { cacheRoot } from '../boot/named-bin'
import {
  immutableAssetPath,
  immutableAssetPrefixes,
  immutableCacheControl,
} from '../serve/immutable'
import { escapeRegex } from '../../utils/code'
import { listFiles, toPosixPath, writeText } from '../../utils/fs'
import { createVerboseLogger, type VerboseLogger } from '../../utils/verbose'
import type { BuildManifest, StaticFileMetadata } from '../../types'

// The single catch-all server function: the same `pnext start` pipeline,
// running on Vercel's Bun runtime (`"bunVersion": "1.x"` in vercel.json).
const SERVER_FUNCTION = '_pnext'

// The platform the function actually runs on, declared once: `architecture`
// goes into .vc-config.json and the same target selects the native packages
// shipped inside it, so the two can never drift. Vercel's default instruction
// set is x86_64 and its function runtime is glibc-based.
const FUNCTION_PLATFORM = {
  architecture: 'x86_64',
  os: 'linux',
  cpu: 'x64',
  libc: 'glibc',
} as const

// Image optimization's native stack: Vercel optimizes images itself, as Next's builder drops these
// (next/dist/build/collect-build-traces.js).
const functionDroppedPackages = [/^sharp$/, /^@img\/sharp-libvips/]

interface VercelConfig {
  version: 3
  routes?: (
    | {
        src: string
        dest?: string
        methods?: string[]
        headers?: Record<string, string>
        continue?: boolean
        important?: boolean
      }
    | { handle: 'filesystem' }
  )[]
  overrides?: Record<string, { path?: string; contentType?: string }>
}

/** `.vercel/output`: the standalone dir as the server function, its `static/` as the CDN tree. */
export async function writeVercelOutput(
  config: ResolvedConfig,
  manifest: BuildManifest,
  options: { verbose?: boolean } = {},
) {
  const log = createVerboseLogger(options.verbose ?? false, 'vercel')
  const outputPath = path.join(config.root, '.vercel', 'output')
  const staticPath = path.join(config.outPath, 'static')
  const staticFiles = manifest.staticFiles ?? {}
  await log.step('prepare output directory', () => emptyDir(outputPath))

  const functionPath = path.join(outputPath, 'functions', `${SERVER_FUNCTION}.func`)
  await writeServerFunction(config.outPath, manifest, functionPath, log)

  await log.step('copy static files', () =>
    copyStaticFiles(
      staticPath,
      path.join(outputPath, 'static'),
      relative => !staticFiles[relative] || canServeStaticOnVercel(staticFiles[relative]),
    ),
  )
  const overrides = await staticOverrides(staticPath, staticFiles)

  const routes: NonNullable<VercelConfig['routes']> = [
    // next-compat documents reference the build output under Next's static path (assetPathname),
    // but it is copied to the CDN at `static/assets/*`. Rewrite before `handle: filesystem` so the
    // CDN serves those bytes itself - without it every stylesheet and chunk fell through to the
    // server function: served, but at function cost with no edge cache.
    ...compatStaticRewrite(config, outputPath),
    // Every content-hashed build asset, exactly the set `pnext start` serves immutable.
    ...(await immutableAssetRoutes(staticPath, manifest.publicAssets)),
    // Proxy-matched paths go to the server function before the CDN filesystem
    // check — `pnext start` runs the proxy ahead of static files too.
    ...(await proxyRoutes(config)),
    ...staticHeaderRoutes(staticFiles),
    { handle: 'filesystem' },
    { src: '^/.*$', dest: `/${SERVER_FUNCTION}` },
  ]

  const vercelConfig: VercelConfig = {
    version: 3,
    routes,
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
  }
  await writeText(
    path.join(outputPath, 'config.json'),
    `${JSON.stringify(vercelConfig, null, 2)}\n`,
  )
}

// Unlinking the previous run's output (tens of thousands of hardlinks) must not block the build:
// rename it aside - which is what actually makes it invisible - and let a detached child do the
// unlinking. Nothing downstream depends on the bytes being gone, and anything an interrupted run
// leaves behind is swept on the next build.
async function emptyDir(dir: string) {
  const parent = path.dirname(dir)
  await mkdir(parent, { recursive: true })
  const staleMarker = `${path.basename(dir)}.stale-`
  if (existsSync(dir)) {
    await rename(
      dir,
      path.join(parent, `${staleMarker}${process.pid.toString(36)}-${Date.now().toString(36)}`),
    )
  }
  const stale = readdirSync(parent)
    .filter(entry => entry.startsWith(staleMarker))
    .map(entry => path.join(parent, entry))
  await mkdir(dir, { recursive: true })
  if (stale.length > 0) {
    Bun.spawn(['rm', '-rf', ...stale], { stdout: 'ignore', stderr: 'ignore' })
  }
}

/**
 * The `/_next/static/*` -> `/assets/*` CDN rewrite for a next-compat build, restricted to the names
 * actually copied under `assets/`. It has to be a NARROW alternation, not `(.*)`: `_next/static` is
 * also a REAL output path (`media/*` from the static-media mirror, `pnext/_buildManifest.js`), and
 * a blanket rewrite would point those at an `assets/` twin that does not exist.
 */
function compatStaticRewrite(config: ResolvedConfig, outputPath: string) {
  if (!nextCompatEnabled(config)) return []
  const staticDir = path.join(outputPath, 'static')
  const names = readdirSyncSafe(path.join(staticDir, 'assets'))
    // A name that is ALSO a real `_next/static/<name>` must keep resolving to itself.
    .filter(name => !existsSync(path.join(staticDir, '_next', 'static', name)))
  if (names.length === 0) return []
  const alternation = names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  return [{ src: `^/_next/static/(${alternation})(/.*)?$`, dest: '/assets/$1$2', continue: true }]
}

function readdirSyncSafe(dir: string) {
  return existsSync(dir) ? readdirSync(dir) : []
}

async function proxyRoutes(config: ResolvedConfig) {
  const proxyFile = findProxyFile(config)
  if (!proxyFile) return []
  const proxyModule = (await import(pathToFileHref(proxyFile))) as ProxyModule
  // Percent-encoded paths and repeated slashes go to the function, which decodes or 308s them.
  return [...proxyRoutePatterns(proxyModule.config), '^.*(?:%|//).*$'].map(src => ({
    src,
    dest: `/${SERVER_FUNCTION}`,
  }))
}

async function writeServerFunction(
  standalonePath: string,
  manifest: BuildManifest,
  functionPath: string,
  log: VerboseLogger,
) {
  await mkdir(path.dirname(functionPath), { recursive: true })
  // A copy-on-write clone where the filesystem has one; links stay links.
  await log.step('copy standalone', () =>
    cp(standalonePath, functionPath, { recursive: true, verbatimSymlinks: true }),
  )
  const modules = path.join(functionPath, 'node_modules')
  const packages = await packageDirs(modules)
  await Promise.all(
    [...packages]
      .filter(([name]) => functionDroppedPackages.some(pattern => pattern.test(name)))
      .map(([, dirs]) => Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })))),
  )
  await log.step('platform natives', () => replaceHostNatives(packages, log))

  await writeText(
    path.join(functionPath, 'index.mjs'),
    `import { createRequestHandler } from './server/entry.js';

const handlerPromise = createRequestHandler({ root: import.meta.dirname });

async function handler(request) {
  return (await handlerPromise)(request);
}

// Callable for the Node-style launcher, \`fetch\` for the Bun runtime.
export default Object.assign(handler, { fetch: handler });
`,
  )

  const maxDuration = manifest.routes.reduce<number | undefined>(
    (max, route) => (route.maxDuration ? Math.max(max ?? 0, route.maxDuration) : max),
    undefined,
  )
  await writeText(
    path.join(functionPath, '.vc-config.json'),
    `${JSON.stringify(
      {
        // The Bun function runtime (project-level `bunVersion` does not apply
        // to prebuilt Build Output API functions, so the version is pinned
        // here). Not `bun1.x`: that resolves to Bun 1.3.14, which segfaults a
        // second into serving and takes the whole function down with SIGABRT.
        // Note: bun functions have a 150 MiB uncompressed size limit vs 250
        // MiB for nodejs.
        runtime: 'bun1.4.x',
        handler: 'index.mjs',
        launcherType: 'Nodejs',
        architecture: FUNCTION_PLATFORM.architecture,
        // The default export takes a web `Request` and returns a `Response`.
        useWebApi: true,
        supportsResponseStreaming: true,
        ...(maxDuration ? { maxDuration } : {}),
      },
      null,
      2,
    )}\n`,
  )
}

/** Package name -> the shipped directories holding it (a store layout can carry several). */
async function packageDirs(modules: string) {
  const found = new Map<string, string[]>()
  const visit = async (dir: string, depth: number) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = path.join(dir, entry.name)
      if (entry.name === '.bun' || entry.name === '.pnpm') {
        for (const store of await readdir(full, { withFileTypes: true }).catch(() => []))
          if (store.isDirectory()) await visit(path.join(full, store.name, 'node_modules'), 0)
      } else if (entry.name.startsWith('@') && depth === 0) {
        await visit(full, 1)
      } else if (existsSync(path.join(full, 'package.json'))) {
        const name = depth === 1 ? `${path.basename(dir)}/${entry.name}` : entry.name
        found.set(name, [...(found.get(name) ?? []), full])
        await visit(path.join(full, 'node_modules'), 0)
      }
    }
  }
  await visit(modules, 0)
  return found
}

interface PackageJson {
  name?: string
  version?: string
  os?: string[]
  cpu?: string[]
  libc?: string[]
  optionalDependencies?: Record<string, string>
}

async function readPackageJson(dir: string) {
  try {
    return JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as PackageJson
  } catch {
    return undefined
  }
}

/**
 * Native bindings resolved here are built for the build host; the function needs the ones for its
 * own platform. Each is replaced by its owner's build for the function platform, whole: a binding
 * package is its binary.
 */
async function replaceHostNatives(packages: Map<string, string[]>, log: VerboseLogger) {
  const manifests = new Map<string, PackageJson>()
  for (const [name, dirs] of packages) {
    const json = await readPackageJson(dirs[0]!)
    if (json) manifests.set(name, json)
  }
  const hostNatives = new Map<
    string,
    { dirs: string[]; owner?: { name: string; version: string } }
  >()
  for (const [name, json] of manifests) {
    if (!(json.os ?? json.cpu) || matchesFunctionPlatform(json)) continue
    const owner = [...manifests].find(([, candidate]) => candidate.optionalDependencies?.[name])
    hostNatives.set(name, {
      dirs: packages.get(name)!,
      owner: owner && { name: owner[0], version: owner[1].version ?? '' },
    })
  }
  if (hostNatives.size === 0) return
  const targets = await platformNativePackages(hostNatives, manifests, log)
  for (const [name, dir] of targets) {
    for (const host of hostNatives.get(name)?.dirs ?? []) {
      const target = path.join(path.dirname(host), name.split('/').at(-1)!)
      await rm(host, { recursive: true, force: true })
      await cp(dir, target, { recursive: true, dereference: true })
    }
  }
}

/**
 * The function platform's builds, from the registry: one cross-platform install per distinct set of
 * owning packages, cached by content in the user cache dir. Falls back to the host copies when the
 * install is unavailable (offline CI, private registry), so packaging never hard-fails on a network
 * hiccup.
 */
async function platformNativePackages(
  hostNatives: Map<string, { dirs: string[]; owner?: { name: string; version: string } }>,
  manifests: Map<string, PackageJson>,
  log: VerboseLogger,
) {
  const owners = new Map<string, string>()
  for (const [name, { owner }] of hostNatives) {
    const spec = owner ?? { name, version: manifests.get(name)?.version ?? '' }
    if (spec.version) owners.set(spec.name, spec.version)
  }
  const specs = [...owners].map(([name, version]) => `${name}@${version}`).sort()
  if (specs.length === 0) return new Map<string, string>()
  try {
    const installed = await crossPlatformInstall(specs)
    const matches = new Map<string, string>()
    for (const [name, dir] of installed) {
      const json = await readPackageJson(dir)
      if (json && (json.os ?? json.cpu) && matchesFunctionPlatform(json)) matches.set(name, dir)
    }
    if (matches.size === 0)
      throw new Error(`no ${FUNCTION_PLATFORM.os} builds in ${specs.join(' ')}`)
    return matches
  } catch (error) {
    console.warn(
      `vercel adapter: could not fetch ${FUNCTION_PLATFORM.os}-${FUNCTION_PLATFORM.cpu} native packages; ` +
        `the function will carry this machine's builds and fail at runtime:`,
      error,
    )
    log.log('falling back to host native packages')
    return new Map<string, string>()
  }
}

function matchesFunctionPlatform(packageJson: { os?: string[]; cpu?: string[]; libc?: string[] }) {
  // npm's field semantics: an all-negated list excludes, anything else is an
  // allow-list (`os: ["!win32"]` still fits linux).
  const matches = (declared: string[] | undefined, value: string) => {
    if (!declared?.length) return true
    if (declared.every(entry => entry.startsWith('!'))) return !declared.includes(`!${value}`)
    return declared.includes(value)
  }
  return (
    matches(packageJson.os, FUNCTION_PLATFORM.os) &&
    matches(packageJson.cpu, FUNCTION_PLATFORM.cpu) &&
    // Both a glibc and a musl build exist for the same os/cpu; Vercel's
    // function runtime is glibc.
    matches(packageJson.libc, FUNCTION_PLATFORM.libc)
  )
}

/**
 * Installs `specs` for the function's platform into a content-addressed cache
 * directory and returns every package that landed. Bun's `--os`/`--cpu` pick
 * the target's optional deps instead of this machine's; its own download cache
 * makes a repeat install ~0.1s, and the directory cache makes it free.
 */
async function crossPlatformInstall(specs: string[]) {
  const key = Bun.hash
    .xxHash3(`${FUNCTION_PLATFORM.os}-${FUNCTION_PLATFORM.cpu}\0${specs.join('\0')}`)
    .toString(16)
  const dir = path.join(cacheRoot(), 'vercel-natives', key)
  const modules = path.join(dir, 'node_modules')
  if (!existsSync(modules)) {
    // Land under a temp name and rename: a concurrent build must never read a
    // half-installed tree.
    const staging = `${dir}.${process.pid.toString(36)}`
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    await writeText(path.join(staging, 'package.json'), '{"name":"pnext-natives"}\n')
    const install = Bun.spawn(
      [
        'bun',
        'add',
        '--no-save',
        '--ignore-scripts',
        '--silent',
        `--os=${FUNCTION_PLATFORM.os}`,
        `--cpu=${FUNCTION_PLATFORM.cpu}`,
        ...specs,
      ],
      { cwd: staging, stdout: 'ignore', stderr: 'pipe' },
    )
    if ((await install.exited) !== 0) {
      const stderr = await new Response(install.stderr).text()
      await rm(staging, { recursive: true, force: true })
      throw new Error(stderr.trim() || 'bun add failed')
    }
    await rm(dir, { recursive: true, force: true })
    await rename(staging, dir)
  }

  const installed = new Map<string, string>()
  for (const entry of readdirSync(modules)) {
    if (entry.startsWith('.')) continue
    if (!entry.startsWith('@')) {
      installed.set(entry, path.join(modules, entry))
      continue
    }
    for (const scoped of readdirSync(path.join(modules, entry))) {
      installed.set(`${entry}/${scoped}`, path.join(modules, entry, scoped))
    }
  }
  return installed
}

async function copyStaticFiles(
  from: string,
  to: string,
  shouldCopy: (relative: string) => boolean = () => true,
) {
  const files = (await listFiles(from)).filter(file =>
    shouldCopy(toPosixPath(path.relative(from, file))),
  )
  // One mkdir per directory, not per file, then link them all at once.
  const directories = new Set(
    files.map(file => path.dirname(path.join(to, path.relative(from, file)))),
  )
  await Promise.all([...directories].map(dir => mkdir(dir, { recursive: true })))
  await Promise.all(
    files.map(file =>
      copyFile(file, path.join(to, path.relative(from, file)), constants.COPYFILE_FICLONE),
    ),
  )
}

async function staticOverrides(
  publicPath: string,
  staticFiles: Record<string, StaticFileMetadata>,
) {
  const overrides: NonNullable<VercelConfig['overrides']> = {}
  for (const file of await listFiles(publicPath)) {
    const relative = toPosixPath(path.relative(publicPath, file))
    if (!relative.endsWith('/index.html')) continue
    overrides[relative] = { path: relative.replace(/\/index\.html$/, '') }
  }
  for (const [relative, metadata] of Object.entries(staticFiles)) {
    if (!canServeStaticOnVercel(metadata)) continue
    const contentType = metadata.headers.find(
      ([name]) => name.toLowerCase() === 'content-type',
    )?.[1]
    if (contentType) overrides[relative] = { ...overrides[relative], contentType }
  }
  return overrides
}

// `important` lets route headers win over the CDN's own static-file cache-control, as Next's builder does.
// Vercel anchors every `src` at both ends, so a prefix must match the rest of the path.
async function immutableAssetRoutes(publicDir: string, publicAssets: string[] = []) {
  const app = new Set(publicAssets)
  const built =
    publicAssets.length > 0
      ? (await listFiles(publicDir))
          .map(file => toPosixPath(path.relative(publicDir, file)))
          .filter(relative => !app.has(relative) && immutableAssetPath(relative))
      : []
  const patterns = immutableAssetPatterns(built, publicAssets)
  return routeSources(patterns, source => `^/(?:${source})$`).map(src => ({
    src,
    headers: { 'cache-control': immutableCacheControl },
    continue: true,
    important: true,
  }))
}

/**
 * Whole immutable prefixes that hold no app public file; under the others, each build file collapsed
 * to its topmost folder below the prefix that holds no app public file, else its exact name.
 */
function immutableAssetPatterns(built: string[], publicAssets: string[]) {
  const appDirs = new Set(publicAssets.flatMap(ancestorDirs))
  const prefixes = [...new Set(immutableAssetPrefixes())]
  const patterns = prefixes
    .filter(prefix => !appDirs.has(prefix))
    .map(prefix => `${escapeRegex(prefix)}.+`)
  for (const relative of built) {
    const prefix = prefixes.find(prefix => relative.startsWith(prefix))
    if (!prefix || !appDirs.has(prefix)) continue
    const dir = ancestorDirs(relative).find(dir => dir.length > prefix.length && !appDirs.has(dir))
    patterns.push(dir ? `${escapeRegex(requestPath(dir))}.+` : escapeRegex(requestPath(relative)))
  }
  return [...new Set(patterns)]
}

/** A public-relative path as browsers request it (the WHATWG path percent-encode set). */
function requestPath(relative: string) {
  return relative.replace(/[\0-\x20"#<>?`{}\x7f-\u{10ffff}]/gu, char => encodeURIComponent(char))
}

/** `a/b/c.js` -> `['a/', 'a/b/']`. */
function ancestorDirs(relative: string) {
  const parts = relative.split('/').slice(0, -1)
  return parts.map((_, index) => `${parts.slice(0, index + 1).join('/')}/`)
}

// Headers a CDN route cannot replay; a file that sets one stays on the server function.
const functionOnlyHeaders = new Set([
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'set-cookie',
])

function canServeStaticOnVercel(metadata: StaticFileMetadata) {
  if (metadata.status !== 200) return false
  const headers = routeHeaders(metadata)
  if (headers.length === 0) return true
  // ISR state needs the function to revalidate.
  return (
    metadata.revalidateSeconds === undefined &&
    metadata.expireSeconds === undefined &&
    !metadata.tags?.length &&
    headers.every(([name]) => !functionOnlyHeaders.has(name.toLowerCase()))
  )
}

/** Headers beyond content-type, which an override carries instead. */
function routeHeaders(metadata: StaticFileMetadata) {
  return metadata.headers.filter(([name]) => name.toLowerCase() !== 'content-type')
}

// Keeps each route pattern well inside Vercel's route size limits.
const maxRouteSourceLength = 2000

/**
 * Route headers for the CDN-served static files whose headers an override cannot carry, so the CDN
 * answers with what `pnext start` sends. Files sharing a header set share a route.
 */
function staticHeaderRoutes(staticFiles: Record<string, StaticFileMetadata>) {
  const groups = new Map<string, { headers: Record<string, string>; patterns: string[] }>()
  for (const [relative, metadata] of Object.entries(staticFiles)) {
    const extra = routeHeaders(metadata)
    if (extra.length === 0 || !canServeStaticOnVercel(metadata)) continue
    const headers = Object.fromEntries(new Headers(extra))
    const key = JSON.stringify(headers)
    const group = groups.get(key) ?? { headers, patterns: [] }
    groups.set(key, group)
    group.patterns.push(servedPathPattern(relative))
  }
  return [...groups.values()].flatMap(({ headers, patterns }) =>
    routeSources(patterns, source => `^/(?:${source})$`).map(src => ({
      src,
      methods: ['GET', 'HEAD'],
      headers,
      continue: true,
      important: true,
    })),
  )
}

/** Joins patterns into as few `wrap`ped route sources as fit `maxRouteSourceLength`. */
function routeSources(patterns: string[], wrap: (alternation: string) => string) {
  const sources: string[] = []
  for (const pattern of patterns) {
    const last = sources.length - 1
    if (last >= 0 && wrap(`${sources[last]}|${pattern}`).length <= maxRouteSourceLength) {
      sources[last] += `|${pattern}`
    } else {
      sources.push(pattern)
    }
  }
  return sources.map(wrap)
}

/** A static file's request paths: `a/index.html` also answers `/a` and `/a/`. */
function servedPathPattern(relative: string) {
  if (relative === 'index.html') return '(?:index\\.html)?'
  if (!relative.endsWith('/index.html')) return escapeRegex(relative)
  return `${escapeRegex(relative.slice(0, -'/index.html'.length))}(?:/|/index\\.html)?`
}
