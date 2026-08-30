import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { hasUseClientDirective } from '../../client/reference-stub'
import { listFiles, listFilesSync, toPosixPath } from '../../utils/fs'
import { getNextConfig } from '../next/config-loader'

const basePageExtensions = ['tsx', 'ts', 'jsx', 'js', 'mjs']

// The app's configured pageExtensions (e.g. @next/mdx appending mdx/md) must
// apply to materialization too, or hybrid apps lose their .mdx routes — this
// runs during config resolution, before registerMdxExtensions.
function materializeExtensions(): string[] {
  const configured = getNextConfig().pageExtensions
  const extras = Array.isArray(configured)
    ? configured.filter((ext): ext is string => typeof ext === 'string' && ext.length > 0)
    : []
  return [...new Set([...basePageExtensions, ...extras])]
}
const appConventions = new Set([
  'default',
  'error',
  'forbidden',
  'global-error',
  'layout',
  'loading',
  'not-found',
  'page',
  'route',
  'template',
  'unauthorized',
])

// Metadata code routes (manifest.js, opengraph-image.tsx, icon2.tsx, ...) are
// app conventions too and must survive materialization in hybrid apps.
const metadataConventionPattern =
  /^(robots|sitemap|manifest|icon\d*|apple-icon\d*|opengraph-image\d*|twitter-image\d*)$/

function isAppConvention(name: string): boolean {
  return appConventions.has(name) || metadataConventionPattern.test(name)
}

/**
 * Build a compat-owned App Router view for basic Pages files. Keeping this
 * outside the source app preserves native App routes and avoids hybrid-route
 * conflict validation; linked sources and node_modules keep normal resolution.
 */
export async function materializePagesApp(root: string): Promise<string | undefined> {
  const pagesPath = path.join(root, 'pages')
  if (!existsSync(pagesPath)) return undefined

  const nativeApp = path.join(root, 'app')
  const pages = await discoverPages(pagesPath)
  const apiRoutes = await discoverPagesApi(pagesPath)
  if (pages.length === 0 && apiRoutes.length === 0) return undefined

  // Content-addressed, never rebuilt in place. Every pnext process that resolves this app's config
  // materializes — a build and the warm child it spawns do so concurrently — so wiping and repopulating
  // one shared directory let one process scan a half-materialized tree ("page.js doesn't have a root
  // layout" on a build that passes on the next run). Naming the directory after what goes in it makes
  // the second writer a no-op, and staging + rename means a reader sees the whole tree or nothing.
  const generatedRoot = path.join(
    tmpdir(),
    'pnext-pages-compat',
    materializationKey(root, nativeApp, pages, apiRoutes),
  )
  const appPath = path.join(generatedRoot, 'app')
  if (existsSync(appPath)) return appPath

  const staging = `${generatedRoot}.${process.pid.toString(36)}.staging`
  await buildMaterializedApp(staging, root, pagesPath, nativeApp, pages, apiRoutes)
  try {
    await rename(staging, generatedRoot)
  } catch {
    // Another process materialized the same key first; its tree is byte-identical to ours.
    await rm(staging, { recursive: true, force: true })
    if (!existsSync(appPath)) throw new Error(`pnext: could not materialize ${root}/pages`)
  }
  void sweepStaleMaterializations(path.dirname(generatedRoot))
  return appPath
}

/**
 * Everything the materialized tree is derived from: the pages facts (already parsed out of the
 * sources), the native app tree's shape, and this module — whose `wrapperSource` writes the files.
 */
function materializationKey(
  root: string,
  nativeApp: string,
  pages: PagesRoute[],
  apiRoutes: PagesApiRoute[],
): string {
  const stamp = (file: string) => {
    const info = statSync(file, { throwIfNoEntry: false })
    return info ? `${info.size}:${info.mtimeMs}` : ''
  }
  const nativeFiles = existsSync(nativeApp)
    ? listFilesSync(nativeApp)
        .map(file => `${toPosixPath(path.relative(nativeApp, file))}\0${stamp(file)}`)
        .sort()
    : []
  // Sorted: discovery follows readdir order, and two processes that disagreed on it would key the
  // same tree twice.
  const byRelative = <T extends { relative: string }>(routes: T[]) =>
    [...routes].sort((a, b) => a.relative.localeCompare(b.relative))
  return createHash('sha256')
    .update(
      JSON.stringify([
        root,
        materializeExtensions(),
        byRelative(pages),
        byRelative(apiRoutes),
        nativeFiles,
        stamp(fileURLToPath(import.meta.url)),
      ]),
    )
    .digest('hex')
    .slice(0, 16)
}

// Abandoned stagings and superseded trees, swept on an age that no live process can still be using:
// a dev server holds its materialized tree open for as long as it runs.
const STALE_MATERIALIZATION_MS = 7 * 24 * 60 * 60_000

async function sweepStaleMaterializations(base: string) {
  try {
    const cutoff = Date.now() - STALE_MATERIALIZATION_MS
    for (const entry of await readdir(base)) {
      const dir = path.join(base, entry)
      const info = statSync(dir, { throwIfNoEntry: false })
      if (info && info.mtimeMs < cutoff) await rm(dir, { recursive: true, force: true })
    }
  } catch {
    // Best-effort: a stale tree only costs a few KB of temp space.
  }
}

async function buildMaterializedApp(
  generatedRoot: string,
  root: string,
  pagesPath: string,
  nativeApp: string,
  pages: PagesRoute[],
  apiRoutes: PagesApiRoute[],
): Promise<void> {
  const appPath = path.join(generatedRoot, 'app')
  const sourcePages = path.join(generatedRoot, 'source-pages')
  const sourceApp = path.join(generatedRoot, 'source-app')

  await rm(generatedRoot, { recursive: true, force: true })
  await mkdir(appPath, { recursive: true })
  await symlink(pagesPath, sourcePages, 'dir')
  const nodeModules = path.join(root, 'node_modules')
  if (existsSync(nodeModules))
    await symlink(nodeModules, path.join(generatedRoot, 'node_modules'), 'dir')

  // Static assets referenced from materialized routes (e.g. an app route's
  // `new URL('../../public/vercel.png', import.meta.url)` or a `public/*` asset
  // import) resolve relative to the generated root; without the symlink the
  // bundler can't find them and the route 500s.
  const publicDir = path.join(root, 'public')
  if (existsSync(publicDir)) await symlink(publicDir, path.join(generatedRoot, 'public'), 'dir')

  if (existsSync(nativeApp)) {
    await symlink(nativeApp, sourceApp, 'dir')
    await materializeNativeApp(sourceApp, appPath)
  }
  if (!existsSync(path.join(appPath, 'layout.js'))) {
    await writeFile(
      path.join(appPath, 'layout.js'),
      'export default function PagesLayout({ children }) {\n  return <html><body>{children}</body></html>\n}\n',
    )
  }

  for (const page of pages) {
    const destination = path.join(appPath, ...encodePrivateSegments(page.segments), 'page.js')
    if (existsSync(destination)) continue
    await mkdir(path.dirname(destination), { recursive: true })
    const pagesPattern = `/${page.segments.join('/')}`.replace(/\/+$/, '') || '/'
    const sourceSpecifier = relativeImport(destination, path.join(sourcePages, page.relative))
    let clientSpecifier: string | undefined
    if (page.hasStaticProps || page.hasServerSideProps) {
      const clientDestination = path.join(path.dirname(destination), 'pnext-page-client.js')
      await writeFile(
        clientDestination,
        `'use client';\nexport { default } from ${JSON.stringify(sourceSpecifier)};\n`,
      )
      clientSpecifier = './pnext-page-client.js'
    }
    await writeFile(
      destination,
      wrapperSource(
        sourceSpecifier,
        // A pages-router component is implicitly a client module: it SSRs AND
        // hydrates (hooks, event handlers, next/router). Without the client
        // wrapper it renders as a server component and never becomes
        // interactive. Data functions keep a server wrapper and pass their
        // props into the page's client facade.
        !page.hasServerSideProps && !page.hasStaticProps,
        page.hasServerSideProps,
        page.hasStaticProps,
        clientSpecifier,
        page.runtime,
        page.maxDuration,
        pagesPattern,
      ),
    )
  }
  for (const apiRoute of apiRoutes) {
    const destination = path.join(appPath, 'api', ...apiRoute.segments, 'route.js')
    if (existsSync(destination)) continue
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(
      destination,
      pagesApiWrapperSource(
        relativeImport(destination, path.join(sourcePages, apiRoute.relative)),
        apiRoute.runtime,
      ),
    )
  }
}

async function materializeNativeApp(sourceApp: string, appPath: string): Promise<void> {
  for (const file of await listFiles(sourceApp)) {
    const relative = toPosixPath(path.relative(sourceApp, file))
    const parsed = path.parse(relative)
    // Non-code files (favicon.ico, robots.txt, sitemap.xml, og images, ...)
    // are static metadata routes discovered by scanning the app dir — carry
    // them into the merged view or they 404 in hybrid apps. Copied, not
    // symlinked: the file listers skip symlink dirents.
    if (!materializeExtensions().includes(parsed.ext.slice(1))) {
      const destination = path.join(appPath, relative)
      await mkdir(path.dirname(destination), { recursive: true })
      await copyFile(file, destination)
      continue
    }
    if (!isAppConvention(parsed.name)) continue
    const destination = path.join(appPath, parsed.dir, `${parsed.name}.js`)
    await mkdir(path.dirname(destination), { recursive: true })
    const source = await readFile(file, 'utf8')
    const client =
      hasUseClientDirective(source) || (await defaultExportImportsClientModule(file, source))
    await writeFile(
      destination,
      wrapperSource(
        relativeImport(destination, file),
        client,
        false,
        false,
        undefined,
        runtimeFromSource(source),
      ),
    )
  }
}

async function defaultExportImportsClientModule(file: string, source: string): Promise<boolean> {
  const defaultExport = /export\s+default\s+([A-Za-z_$][\w$]*)\s*;?/.exec(source)
  if (!defaultExport?.[1]) return false

  const binding = defaultExport[1]
  const imports = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = imports.exec(source))) {
    const importsBinding = (match[1] ?? '').split(',').some(value => {
      const names = /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(value)
      return (names?.[2] ?? names?.[1]) === binding
    })
    if (!importsBinding || !match[2]?.startsWith('.')) continue
    const imported = resolveSourceImport(file, match[2])
    if (imported && hasUseClientDirective(await readFile(imported, 'utf8'))) return true
  }
  return false
}

function resolveSourceImport(file: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(file), specifier)
  for (const candidate of [
    base,
    ...materializeExtensions().flatMap(extension => [
      `${base}.${extension}`,
      path.join(base, `index.${extension}`),
    ]),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return undefined
}

interface PagesRoute {
  relative: string
  segments: string[]
  hasServerSideProps: boolean
  hasStaticProps: boolean
  runtime?: 'edge' | 'nodejs'
  maxDuration?: number
}

interface PagesApiRoute {
  relative: string
  segments: string[]
  runtime?: 'edge' | 'nodejs'
}

// A pages-router segment beginning with `_` is a real route (pages has no private-folder convention),
// but the app-router scanner that consumes the materialized app would drop a literal `_segment` as
// private. Encoding the leading underscore to `%5F` keeps the materialized directory routable - the
// scanner decodes it back.
function encodePrivateSegments(segments: string[]): string[] {
  return segments.map(segment => (segment.startsWith('_') ? `%5F${segment.slice(1)}` : segment))
}

async function discoverPages(pagesPath: string): Promise<PagesRoute[]> {
  const routes = new Map<string, PagesRoute>()
  const files = await listFiles(pagesPath)
  for (const extension of materializeExtensions()) {
    for (const file of files) {
      if (!file.endsWith(`.${extension}`)) continue
      const relative = toPosixPath(path.relative(pagesPath, file))
      const withoutExtension = relative.slice(0, -extension.length - 1)
      const sourceSegments = withoutExtension.split('/')
      // The pages router has no private-folder convention (that is app-router
      // only): a nested `_dashboard/index.tsx` routes at `/_dashboard`. Only the
      // reserved root components (`_app`/`_document`/`_error`) and the `api`
      // segment are excluded from route materialization.
      if (sourceSegments[0] === 'api') continue
      if (
        sourceSegments.length === 1 &&
        (sourceSegments[0] === '_app' ||
          sourceSegments[0] === '_document' ||
          sourceSegments[0] === '_error')
      ) {
        continue
      }
      const segments =
        sourceSegments.at(-1) === 'index' ? sourceSegments.slice(0, -1) : sourceSegments
      const key = segments.join('/')
      if (!routes.has(key)) {
        const source = await readFile(file, 'utf8')
        routes.set(key, {
          relative,
          segments,
          hasServerSideProps: /\bgetServerSideProps\b/.test(source),
          hasStaticProps: /\bgetStaticProps\b/.test(source),
          runtime: runtimeFromSource(source),
          maxDuration: maxDurationFromSource(source),
        })
      }
    }
  }
  return [...routes.values()]
}

async function discoverPagesApi(pagesPath: string): Promise<PagesApiRoute[]> {
  const routes = new Map<string, PagesApiRoute>()
  const files = await listFiles(path.join(pagesPath, 'api'))
  for (const extension of materializeExtensions()) {
    for (const file of files) {
      if (!file.endsWith(`.${extension}`)) continue
      const relative = toPosixPath(path.relative(pagesPath, file))
      const segments = relative
        .slice(0, -extension.length - 1)
        .split('/')
        .slice(1)
      if (segments.some(segment => segment.startsWith('_'))) continue
      const key = segments.join('/')
      if (routes.has(key)) continue
      routes.set(key, {
        relative,
        segments,
        runtime: runtimeFromSource(await readFile(file, 'utf8')),
      })
    }
  }
  return [...routes.values()]
}

// The compat runtime module the data wrappers import (by absolute path — the
// materialized app lives outside the source tree, so bare/relative specifiers
// cannot reach it). It computes + stashes the SSR useRouter() state and
// serializes it for the inline __PNEXT_PAGES_DATA__ JSON node.
function routerStateModulePath(): string {
  return path.join(import.meta.dirname, 'router-state.ts')
}

// The shared prologue/epilogue for data wrappers: emit the pages-router state
// node alongside the page so the next/router shim (SSR and browser) sees the
// pages-route pattern, canonical asPath, and merged query.
function routerStateSnippet(pagesPattern: string | undefined): {
  imports: string
  render: string
} {
  if (!pagesPattern) {
    return { imports: '', render: 'return createElement(Page, result?.props ?? {});' }
  }
  return {
    imports: `import { pagesRouterSsrState, serializePagesRouterState } from ${JSON.stringify(
      routerStateModulePath(),
    )};\n`,
    render: `const routerState = pagesRouterSsrState(${JSON.stringify(pagesPattern)}, resolvedParams);
  return createElement(
    Fragment,
    null,
    createElement('script', {
      type: 'application/json',
      id: '__PNEXT_PAGES_DATA__',
      dangerouslySetInnerHTML: { __html: serializePagesRouterState(routerState) },
    }),
    createElement(Page, result?.props ?? {}),
  );`,
  }
}

function wrapperSource(
  specifier: string,
  client = false,
  hasServerSideProps = false,
  hasStaticProps = false,
  clientSpecifier?: string,
  runtime?: 'edge' | 'nodejs',
  maxDuration?: number,
  pagesPattern?: string,
): string {
  const runtimeExport = runtime ? `export const runtime = ${JSON.stringify(runtime)};\n` : ''
  const maxDurationExport =
    maxDuration === undefined ? '' : `export const maxDuration = ${maxDuration};\n`
  const routerState = routerStateSnippet(pagesPattern)
  if (hasStaticProps && clientSpecifier) {
    return `import { createElement, Fragment } from 'react';
import { notFound, redirect } from 'next/navigation';
import Page from ${JSON.stringify(clientSpecifier)};
import * as pageModule from ${JSON.stringify(specifier)};
${routerState.imports}export * from ${JSON.stringify(specifier)};
${runtimeExport}${maxDurationExport}export default async function PagesCompatStaticPage({ params }) {
  // The otel compat exposes a span wrapper (Render.getStaticProps) at runtime.
  const withSpan = globalThis.__PNEXT_PAGES_DATA_SPAN__ ?? ((kind, fn) => fn());
  const resolvedParams = await params;
  const invoke = async () => pageModule.getStaticProps?.({ params: resolvedParams });
  const result = await withSpan('getStaticProps', invoke);
  if (result?.notFound) notFound();
  if (result?.redirect) redirect(result.redirect.destination);
  ${routerState.render}
}
`
  }
  if (!hasServerSideProps) {
    if (client) {
      return `'use client';
export { default } from ${JSON.stringify(specifier)};
${runtimeExport}${maxDurationExport}`
    }
    return `import * as __pnext_page_ns from ${JSON.stringify(specifier)};
export default __pnext_page_ns.default;
export * from ${JSON.stringify(specifier)};
${runtimeExport}${maxDurationExport}`
  }
  return `import { createElement, Fragment } from 'react';
import { notFound, redirect } from 'next/navigation';
import { cookies, headers } from 'next/headers';
import Page from ${JSON.stringify(clientSpecifier)};
import * as pageModule from ${JSON.stringify(specifier)};
${routerState.imports}export * from ${JSON.stringify(specifier)};
export const dynamic = 'force-dynamic';
${runtimeExport}${maxDurationExport}export default async function PagesCompatPage({ params, searchParams }) {
  // The otel compat exposes a span wrapper (Render.getServerSideProps) at runtime.
  const withSpan = globalThis.__PNEXT_PAGES_DATA_SPAN__ ?? ((kind, fn) => fn());
  const resolvedParams = await params;
  // getServerSideProps reads a node-shaped \`req\`/\`res\`. This page is
  // force-dynamic, so headers()/cookies() are available; \`method\` is always
  // 'GET' and \`res\` is inert (writes are dropped) — a workable baseline until
  // the pages layer threads the real request through.
  const requestHeaders = Object.fromEntries((await headers()).entries());
  const requestCookies = Object.fromEntries(
    (await cookies()).getAll().map(cookie => [cookie.name, cookie.value]),
  );
  const invoke = async () => pageModule.getServerSideProps?.({
    params: resolvedParams,
    query: (await searchParams) ?? {},
    req: {
      headers: requestHeaders,
      cookies: requestCookies,
      method: 'GET',
      url: ${JSON.stringify(pagesPattern ?? '/')},
    },
    res: {
      statusCode: 200,
      setHeader() {},
      getHeader() {},
      getHeaders() { return {}; },
      removeHeader() {},
      end() {},
      write() { return true; },
    },
    resolvedUrl: ${JSON.stringify(pagesPattern ?? '/')},
    preview: false,
    previewData: undefined,
    draftMode: false,
  });
  const result = await withSpan('getServerSideProps', invoke);
  if (result?.notFound) notFound();
  if (result?.redirect) redirect(result.redirect.destination);
  ${routerState.render}
}
`
}

function runtimeFromSource(source: string): 'edge' | 'nodejs' | undefined {
  const runtime = /\bruntime\b\s*[:=]\s*(['"`])(edge|nodejs|experimental-edge)\1/.exec(source)?.[2]
  return runtime === 'experimental-edge' ? 'edge' : (runtime as 'edge' | 'nodejs' | undefined)
}

function maxDurationFromSource(source: string): number | undefined {
  const value = /\bmaxDuration\s*:\s*(\d+)\b/.exec(source)?.[1]
  return value === undefined ? undefined : Number(value)
}

function pagesApiWrapperSource(specifier: string, runtime?: 'edge' | 'nodejs'): string {
  const runtimeExport = runtime ? `export const runtime = ${JSON.stringify(runtime)};\n` : ''
  return `import handler from ${JSON.stringify(specifier)};
import { NextRequest } from 'next/server';
import { Writable } from 'node:stream';
${runtimeExport}export async function GET(request) {
  return run(handler, request);
}
export async function POST(request) {
  return run(handler, request);
}
export async function PUT(request) {
  return run(handler, request);
}
export async function PATCH(request) {
  return run(handler, request);
}
export async function DELETE(request) {
  return run(handler, request);
}
// Bridge a pages-API handler onto the app-route Response contract. Edge-style
// handlers (request-only, return a Response) pass through; node-style handlers
// get a real Writable \`res\` whose bytes stream into the Response body, with
// client disconnects surfaced as res 'close'/destroy (stream cancellation).
async function run(handler, request) {
  const nextRequest = request instanceof NextRequest ? request : new NextRequest(request);
  const state = { status: 200, headers: new Headers() };
  let controller;
  let started = false;
  let notifyStarted = () => {};
  const startedPromise = new Promise(resolve => { notifyStarted = resolve; });
  const start = () => {
    if (!started) {
      started = true;
      notifyStarted();
    }
  };
  const body = new ReadableStream({
    start(c) { controller = c; },
    cancel() { res.destroy(); },
  });
  const enqueue = chunk => {
    try {
      controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
    } catch {}
  };
  const res = new Writable({
    write(chunk, _encoding, callback) { start(); enqueue(chunk); callback(); },
    final(callback) { start(); try { controller.close(); } catch {} callback(); },
    destroy(error, callback) { try { controller.close(); } catch {} callback(error); },
  });
  Object.defineProperty(res, 'statusCode', {
    get: () => state.status,
    set: value => { state.status = value; },
  });
  res.setHeader = (name, value) => { state.headers.set(name, String(value)); return res; };
  res.getHeader = name => state.headers.get(name) ?? undefined;
  res.removeHeader = name => { state.headers.delete(name); };
  res.status = code => { state.status = code; return res; };
  res.json = value => { state.headers.set('content-type', 'application/json'); res.end(JSON.stringify(value)); };
  res.send = value => { res.end(value); };
  // A client disconnect aborts the request signal; pages handlers observe it
  // as the response closing (res.on('close') per Node semantics).
  request.signal?.addEventListener?.('abort', () => res.destroy(), { once: true });
  const finished = Promise.resolve()
    .then(() => handler(nextRequest, res))
    .catch(error => {
      if (!started) throw error;
      try { controller.error(error); } catch {}
    });
  const outcome = await Promise.race([
    startedPromise.then(() => 'started'),
    finished.then(() => 'done'),
  ]);
  if (outcome === 'done' && !started) {
    const result = await finished;
    return result instanceof Response ? result : new Response(null, { status: state.status, headers: state.headers });
  }
  return new Response(body, { status: state.status, headers: state.headers });
}
`
}

function relativeImport(fromFile: string, targetFile: string): string {
  const relative = toPosixPath(path.relative(path.dirname(fromFile), targetFile))
  return relative.startsWith('.') ? relative : `./${relative}`
}
