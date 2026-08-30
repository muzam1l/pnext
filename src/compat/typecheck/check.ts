import { existsSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import type * as TS from 'typescript'
import type { ResolvedConfig } from '../../config'
import { getNextConfig, type NextConfigObject } from '../next/config-loader'
import { turbopackLoaderRules } from '../bundler/config'
import { scanRootParamTypes, type RootParamValueType } from '../ppr/root-params-scan'

export class PnextTypecheckError extends Error {
  /** The individual diagnostics, kept so the worker can ship them across intact. */
  readonly messages: string[]
  constructor(messages: string[]) {
    super(messages.join('\n'))
    this.name = 'PnextTypecheckError'
    this.messages = messages
  }
}

// `typescript` is 8 MB of JS and is needed ONLY to read the app's tsconfig
// (extends chains, ambient file lists) and as the fallback checker. Loading it
// lazily keeps it out of every build that never reaches this step.
let typescriptModule: typeof TS | undefined
async function loadTypescript(): Promise<typeof TS> {
  typescriptModule ??= (await import('typescript')) as unknown as typeof TS
  return typescriptModule
}

/**
 * `typescript.ignoreBuildErrors` in next.config disables the production typecheck entirely. Fixtures that
 * ship intentional type errors - a `fetch(..., { next: { revalidate: '1' } })` whose runtime error is what
 * the test asserts - rely on the build completing so the app can start and surface it.
 */
export function typecheckDisabled(): boolean {
  const typescript = getNextConfig().typescript as { ignoreBuildErrors?: unknown } | undefined
  return typescript?.ignoreBuildErrors === true
}

/** What ./worker.ts needs to run the check without re-loading the app config. */
export interface TypecheckWorkerInput {
  root: string
  outPath: string
  compat: ResolvedConfig['compat']
  nextConfig: NextConfigObject
}

export type TypecheckWorkerResult =
  { ok: true } | { ok: false; messages?: string[]; failure?: string }

/**
 * Run the check on a worker thread, so `typescript`'s large import and the diagnostics pass land
 * off the build thread and overlap client bundling and prerendering.
 *
 * The checker reads only `typescript`, `typedRoutes` and `turbopack.rules` from next.config, so a
 * structured-cloneable projection of those goes across rather than the real object (which can carry
 * functions) or a second config load (which would re-run its telemetry and deprecation warnings).
 * A worker that cannot start at all falls back to the in-process path rather than failing the build.
 */
export async function validateTypesOffThread(config: ResolvedConfig): Promise<void> {
  if (typecheckDisabled()) return
  const next = getNextConfig()
  const input: TypecheckWorkerInput = {
    root: config.root,
    outPath: config.outPath,
    compat: config.compat,
    nextConfig: cloneable({
      typescript: next.typescript,
      typedRoutes: next.typedRoutes,
      turbopack: next.turbopack,
    }),
  }
  let worker: Worker
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { workerData: input })
  } catch {
    return validateTypes(config)
  }
  const result = await new Promise<TypecheckWorkerResult>((resolve, reject) => {
    worker.on('message', resolve)
    worker.on('error', reject)
    // A worker that exits without a message crashed in a way `error` missed;
    // treat it as a clean check rather than failing a build over the harness.
    worker.on('exit', () => resolve({ ok: true }))
  }).finally(() => void worker.terminate())
  if (result.ok) return
  if (result.messages) throw new PnextTypecheckError(result.messages)
  throw new Error(result.failure ?? 'typecheck worker failed')
}

/** Drop anything structured-clone would reject (a `turbopack.rules` function). */
function cloneable(value: NextConfigObject): NextConfigObject {
  try {
    return JSON.parse(JSON.stringify(value)) as NextConfigObject
  } catch {
    return {}
  }
}

/**
 * TypeScript 7 (`tsgo`) is a separate process, so the check genuinely overlaps bundling instead of
 * blocking the event loop - and it is much faster. It runs as the GATE: a clean TS 7 pass ends the check,
 * which is every successful build.
 *
 * When it does report something, tsc 5.9 re-runs and owns the message text. The two compilers agree on
 * which code is wrong but not always on how they say it - TS 7 collapses a failed generic constraint to
 * the specific cause where 5.9 leads with the constraint itself, and Next's own wording is what the compat
 * suites match. That second pass only ever runs on a build that is already failing.
 */
export async function validateTypes(config: ResolvedConfig): Promise<void> {
  if (typecheckDisabled()) return
  const native = await nativeCheckerBin(config.root)
  const project = await writeTypecheckProject(config, native)
  if (native && (await checkWithNative(native, project, config)).length === 0) return
  const messages = await checkInProcess(project, config)
  if (messages.length === 0) return
  throw new PnextTypecheckError(messages)
}

async function checkInProcess(project: string, config: ResolvedConfig): Promise<string[]> {
  const ts = await loadTypescript()
  const parsed = readProject(ts, project)
  const program = ts.createProgram(parsed.fileNames, parsed.options)
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter(diagnostic => appDiagnostic(diagnostic.file?.fileName, config))
  return formatDiagnostics(ts, diagnostics)
}

/**
 * The `tsgo` binary (`@typescript/native-preview`), resolved from the app first so a project pinning its
 * own TS 7 wins. Absent means the in-process fallback. `PNEXT_TYPECHECK=classic` forces the fallback.
 */
async function nativeCheckerBin(root: string): Promise<string | undefined> {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  if (process.env.PNEXT_TYPECHECK === 'classic') return undefined
  for (const base of [root, import.meta.dirname]) {
    try {
      const require = createRequire(path.join(base, 'noop.js'))
      const pkg = require.resolve('@typescript/native-preview/package.json')
      // The package exposes the platform binary only through its own resolver
      // (the published `.` export is just a version stub).
      const { default: getExePath } = (await import(
        path.join(path.dirname(pkg), 'lib', 'getExePath.js')
      )) as { default: () => string }
      const bin = getExePath()
      if (bin && existsSync(bin)) return bin
    } catch {
      // keep looking
    }
  }
  return undefined
}

async function checkWithNative(
  bin: string,
  project: string,
  config: ResolvedConfig,
): Promise<string[]> {
  const proc = Bun.spawn([bin, '--noEmit', '--pretty', 'false', '-p', project], {
    cwd: config.root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return nativeDiagnostics(`${stdout}${stderr}`, config)
}

/**
 * Reshape `tsgo --pretty false` output into the same `<file>:<line>:<col>` plus `Type error: <message>`
 * lines the in-process path produces. A diagnostic is one `file(line,col): error TSxxxx: message` header
 * plus every indented elaboration line under it - the same text `flattenDiagnosticMessageText` builds from
 * a message chain.
 */
function nativeDiagnostics(output: string, config: ResolvedConfig): string[] {
  const header = /^(?:(.+)\((\d+),(\d+)\): )?error TS\d+: (.*)$/
  const messages = new Set<string>()
  const lines = output.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const match = header.exec(lines[index]!)
    if (!match) continue
    const [, file, line, column, text] = match
    const elaborations: string[] = []
    while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1]!)) {
      elaborations.push(lines[index + 1]!)
      index += 1
    }
    const resolved = file ? path.resolve(config.root, file) : undefined
    if (!appDiagnostic(resolved, config)) continue
    const raw = [text, ...elaborations].join('\n')
    const location = resolved ? `${resolved}:${line}:${column}\n` : ''
    messages.add(`${location}Type error: ${typedRouteMessage(raw) ?? raw}`)
  }
  return [...messages]
}

// Only diagnostics originating in the app's own sources may fail the build;
// errors inside node_modules, pnext shims, or generated files are never the
// app author's fault (Next.js typechecks with the same scoping).
function appDiagnostic(file: string | undefined, config: ResolvedConfig): boolean {
  if (!file) return true
  const resolved = path.resolve(file)
  // The generated project is pnext's own; an option error in it (TS5102 and
  // friends) is a framework bug and must never be silently swallowed.
  if (resolved === generatedProjectPath(config)) return true
  if (!resolved.startsWith(config.root + path.sep)) return false
  if (resolved.includes(`${path.sep}node_modules${path.sep}`)) return false
  if (resolved.startsWith(path.resolve(config.outPath) + path.sep)) return false
  return true
}

function generatedProjectPath(config: ResolvedConfig): string {
  return path.resolve(config.outPath, 'typecheck', 'tsconfig.json')
}

/**
 * The app's `react` import resolves to pnext's preact compat shim at runtime, whose types cannot satisfy
 * React-typed app code. Point the typechecker at real `@types/react` instead - the app's own copy if
 * installed, otherwise the one visible from pnext. React mappings intentionally override app paths, since
 * they describe pnext's runtime aliases, while unrelated path mappings remain.
 *
 * Written INTO the generated tsconfig rather than patched onto parsed options, so the out-of-process
 * checker sees exactly what the in-process one does.
 */
function reactTypePaths(
  root: string,
  basePaths: Record<string, string[]> | undefined,
  compatPreact?: string,
): Record<string, string[]> | undefined {
  const react = resolveTypesDir('react', root)
  if (!react) return basePaths
  const reactDom = resolveTypesDir('react-dom', root)
  const paths: Record<string, string[]> = { ...basePaths }
  const mappings: Record<string, string | undefined> = {
    react: path.join(react, 'index.d.ts'),
    'react/*': path.join(react, '*'),
    'react-dom': reactDom && path.join(reactDom, 'index.d.ts'),
    'react-dom/*': reactDom && path.join(reactDom, '*'),
    preact: compatPreact,
  }
  for (const [key, value] of Object.entries(mappings)) {
    if (value) paths[key] = [value]
  }
  return paths
}

function resolveTypesDir(name: string, root: string): string | undefined {
  for (const base of [root, import.meta.dirname]) {
    try {
      const require = createRequire(path.join(base, 'noop.js'))
      return path.dirname(require.resolve(`@types/${name}/package.json`))
    } catch {
      // keep looking
    }
  }
  return undefined
}

// Rebase an app's `paths` onto absolute targets so the generated project (which
// lives elsewhere and can no longer carry a `baseUrl`) resolves them identically.
function absolutePaths(
  paths: TS.MapLike<string[]> | undefined,
  basePath: string,
): Record<string, string[]> | undefined {
  if (!paths) return undefined
  return Object.fromEntries(
    Object.entries(paths).map(([key, targets]) => [
      key,
      targets.map(target => (path.isAbsolute(target) ? target : path.resolve(basePath, target))),
    ]),
  )
}

function resolvePackageDir(name: string, root: string): string | undefined {
  for (const base of [root, import.meta.dirname]) {
    try {
      const require = createRequire(path.join(base, 'noop.js'))
      return path.dirname(require.resolve(`${name}/package.json`))
    } catch {
      // keep looking
    }
  }
  return undefined
}

async function writeTypecheckProject(
  config: ResolvedConfig,
  native: string | undefined,
): Promise<string> {
  const dir = path.join(config.outPath, 'typecheck')
  await mkdir(dir, { recursive: true })
  const reactTypes = resolveTypesDir('react', config.root)
  const hasReactTypes = reactTypes !== undefined
  const rootParams = scanRootParamTypes(path.join(config.root, 'app'))
  // With `typedRoutes` on, the build generates `.next/types/link.d.ts`, whose next/link, next/navigation
  // and next augmentations layer the RouteImpl type onto the *real* next package. pnext's own permissive
  // `next/*` shims would shadow those and mask the typed-route errors the suite asserts. When the real next
  // package is resolvable from the app, drop the next-module shims and let real next plus the generated
  // files drive the check - exactly what `next build` does.
  const hasRealNext = realNextResolvable(config.root)
  const omitNextModuleShims = typedRoutesEnabled() && hasRealNext
  const legacyRequestTypes =
    typeof config.compat?.next === 'object' && config.compat.next.legacyRequestAPIs === true
  await writeFile(
    path.join(dir, 'next-shims.d.ts'),
    nextShims(hasReactTypes, rootParams, omitNextModuleShims, legacyRequestTypes, hasRealNext),
  )
  const preact = resolvePackageDir('preact', config.root)
  if (reactTypes && preact) {
    await writeFile(preactTypeShimPath(config), preactTypeShim(preact, reactTypes))
  }
  const base = tsconfigPath(config.root)
  const baseProject = base ? await readBaseProject(base, native) : undefined
  const baseOptions = baseProject?.options ?? {}
  const preactShim = preactTypeShimPath(config)
  const project = generatedProjectPath(config)
  const paths = reactTypePaths(
    config.root,
    absolutePaths(
      baseOptions.paths,
      baseOptions.baseUrl ?? (base ? path.dirname(base) : config.root),
    ),
    existsSync(preactShim) ? preactShim : undefined,
  )
  // App sources (and fixture helpers they import) may use node builtins
  // (`node:fs`, `node:path`). Next resolves them through @types/node; put the
  // app's copy (or pnext's fallback) in the program so `Cannot find module
  // 'node:*'` never fails an app build.
  const nodeTypes = resolveTypesDir('node', config.root)
  await writeFile(
    project,
    JSON.stringify(
      {
        ...(base ? { extends: base } : {}),
        compilerOptions: {
          noEmit: true,
          // TS keeps only the buildinfo under noEmit, so a re-check of an
          // unchanged app is near-free. It lives outside outPath, which every
          // build wipes.
          incremental: true,
          tsBuildInfoFile: path.join(
            config.root,
            'node_modules',
            '.cache',
            'pnext',
            'typecheck.tsbuildinfo',
          ),
          skipLibCheck: true,
          allowJs: true,
          resolveJsonModule: true,
          isolatedModules: true,
          // Next owns the JSX transform and typechecks the source form. Besides
          // matching its required tsconfig option, `preserve` keeps a legacy
          // `import React` semantically used when noUnusedLocals is enabled.
          jsx: 'preserve',
          // `paths` only, never `baseUrl` — TS 7 removed it (TS5102). The
          // mappings are absolutized above so they resolve the same from here.
          ...(paths ? { paths } : {}),
          // Fallbacks for apps whose tsconfig leaves these unset (the ES3 default rejects modern syntax).
          // The app's own values win - `next build` checks with the app's options, and overriding
          // lib/strict/target changes inference.
          ...(baseOptions.strict === undefined ? { strict: false } : {}),
          ...(baseOptions.target === undefined ? { target: 'es2022' } : {}),
          ...(baseOptions.module === undefined ? { module: 'esnext' } : {}),
          ...(baseOptions.moduleResolution === undefined ? { moduleResolution: 'bundler' } : {}),
          ...(baseOptions.lib === undefined ? { lib: ['es2022', 'dom', 'dom.iterable'] } : {}),
        },
        include: [
          path.join(dir, 'next-shims.d.ts'),
          // Generated per-route assignability checks (typegen writes them next to this
          // project, not under the app-included `types/` dir, so only pnext's own compiler
          // reads them). Included by hand to keep that coverage.
          path.join(dir, 'checks', '**/*.ts'),
          ...(nodeTypes ? [path.join(nodeTypes, 'index.d.ts')] : []),
          path.join(config.root, 'next-env.d.ts'),
          // The build emits `.next/types/validator.ts` (page/layout/route-handler export validation) just
          // before this typecheck. Next includes it in the program so invalid exports fail the build with a
          // constraint type error; include it here too. It lives outside the `.pnext` outPath, so its
          // diagnostics survive appDiagnostic's scoping.
          ...(!legacyRequestTypes && existsSync(path.join(config.root, '.next/types/validator.ts'))
            ? [path.join(config.root, '.next/types/validator.ts')]
            : []),
          path.join(config.root, 'middleware.*'),
          path.join(config.root, 'proxy.*'),
          // Next type-checks the project's next.config.(ts|mts|cts) as part of
          // `next build`; a type error in the config fails the build (the
          // next-config-ts*/type-error suites assert this). JS configs carry no
          // types to check, so only the TS variants are included.
          path.join(config.root, 'next.config.ts'),
          path.join(config.root, 'next.config.mts'),
          path.join(config.root, 'next.config.cts'),
          path.join(config.root, 'app/**/*.ts'),
          path.join(config.root, 'app/**/*.tsx'),
          path.join(config.root, 'pages/**/*.ts'),
          path.join(config.root, 'pages/**/*.tsx'),
          // The app tsconfig's own file list contributes ambient declarations
          // (global .d.ts JSX/module augmentations) nothing imports; merge just
          // those in. Merging its `include` PATTERNS instead would also drag in
          // every stray root-level source (e2e fixtures keep collectors, custom
          // servers and loader inputs there) that no app entry imports, failing
          // builds on helper files the app never bundles.
          ...baseAmbientDeclarations(baseProject?.fileNames, config),
        ],
        exclude: [
          path.join(config.root, 'node_modules'),
          path.join(config.root, '**/*.test.ts'),
          path.join(config.root, '**/*.test.tsx'),
        ],
      },
      null,
      2,
    ),
  )
  return project
}

function preactTypeShimPath(config: ResolvedConfig): string {
  return path.join(config.outPath, 'typecheck', 'preact-compat.d.ts')
}

function preactTypeShim(preact: string, react: string): string {
  const preactTypes = JSON.stringify(path.join(preact, 'src', 'index.d.ts'))
  const types = JSON.stringify(path.join(react, 'index.d.ts'))
  return `import type { ReactNode } from ${types}

export * from ${preactTypes}
export type ComponentChild = ReactNode
export type ComponentChildren = ReactNode
`
}

function typedRoutesEnabled(): boolean {
  return (getNextConfig() as { typedRoutes?: unknown }).typedRoutes === true
}

// Whether the real `next` package's type entry resolves from the app root.
function realNextResolvable(root: string): boolean {
  try {
    createRequire(path.join(root, 'noop.js')).resolve('next/package.json')
    return true
  } catch {
    return false
  }
}

/** Absolute `.d.ts` paths the app's own tsconfig would have put in the program. */
function baseAmbientDeclarations(
  fileNames: readonly string[] | undefined,
  config: ResolvedConfig,
): string[] {
  if (!fileNames) return []
  const outPath = path.resolve(config.outPath) + path.sep
  return fileNames
    .map(name => path.resolve(name))
    .filter(
      name =>
        name.endsWith('.d.ts') &&
        !name.includes(`${path.sep}node_modules${path.sep}`) &&
        !name.startsWith(outPath),
    )
}

interface BaseProject {
  options: {
    paths?: TS.MapLike<string[]>
    baseUrl?: string
    strict?: unknown
    target?: unknown
    module?: unknown
    moduleResolution?: unknown
    lib?: unknown
  }
  fileNames: string[]
}

/**
 * Resolves the app tsconfig's extends chain and include globs via `tsgo --showConfig` so the native
 * fast path never imports the classic `typescript` package. Any failure falls back to the classic
 * reader.
 */
async function readBaseProject(file: string, native: string | undefined): Promise<BaseProject> {
  const shown = native ? await showConfigViaNative(native, file) : undefined
  if (shown) return shown
  const ts = await loadTypescript()
  const parsed = readProject(ts, file)
  return { options: parsed.options, fileNames: [...parsed.fileNames] }
}

async function showConfigViaNative(bin: string, file: string): Promise<BaseProject | undefined> {
  try {
    const proc = Bun.spawn([bin, '--showConfig', '-p', file], { stdout: 'pipe', stderr: 'pipe' })
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    if (proc.exitCode !== 0) return undefined
    const shown = JSON.parse(stdout) as {
      compilerOptions?: BaseProject['options']
      files?: string[]
    }
    const dir = path.dirname(file)
    const options = shown.compilerOptions ?? {}
    if (typeof options.baseUrl === 'string') options.baseUrl = path.resolve(dir, options.baseUrl)
    const fileNames = (shown.files ?? []).map(f => path.resolve(dir, f))
    return { options, fileNames }
  } catch {
    return undefined
  }
}

function tsconfigPath(root: string): string | undefined {
  const tsConfig = getNextConfig().typescript as { tsconfigPath?: unknown } | undefined
  const configured = tsConfig?.tsconfigPath
  const file =
    typeof configured === 'string' && configured.length > 0
      ? path.join(root, configured)
      : path.join(root, 'tsconfig.json')
  return existsSync(file) ? file : undefined
}

/**
 * Memoized per project path: `parseJsonConfigFileContent` walks every `include` glob to build
 * `fileNames`. The cache lives for the process, which for the checker is one build (dev never
 * typechecks).
 */
const parsedProjects = new Map<string, { stamp: number; parsed: TS.ParsedCommandLine }>()

function readProject(ts: typeof TS, project: string): TS.ParsedCommandLine {
  // The generated project is rewritten before every check, so the cache is
  // keyed on the file's mtime rather than its path alone.
  let stamp = 0
  try {
    stamp = statSync(project).mtimeMs
  } catch {
    /* unreadable: parse and let readConfigFile report it */
  }
  const cached = parsedProjects.get(project)
  if (cached?.stamp === stamp) return cached.parsed
  const read = ts.readConfigFile(project, file => ts.sys.readFile(file))
  if (read.error) throw new PnextTypecheckError(formatDiagnostics(ts, [read.error]))
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(project))
  parsedProjects.set(project, { stamp, parsed })
  return parsed
}

function formatDiagnostics(ts: typeof TS, diagnostics: readonly TS.Diagnostic[]): string[] {
  const messages = new Set<string>()
  for (const diagnostic of diagnostics) {
    const raw = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
    const typedRoute = typedRouteMessage(raw)
    // Next prints `./relative/file.ts:line:col` on its own line above the
    // message; mirror that so build failures name their source.
    let location = ''
    if (diagnostic.file && diagnostic.start !== undefined) {
      const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
      location = `${diagnostic.file.fileName}:${line + 1}:${character + 1}\n`
    }
    messages.add(`${location}Type error: ${typedRoute ?? raw}`)
  }
  return [...messages]
}

function typedRouteMessage(message: string): string | undefined {
  const match = /^Type '(".*")' is not assignable to type '.*RouteImpl<\1>/.exec(message)
  if (!match?.[1]) return undefined
  return `${match[1]} is not an existing route. If it is intentional, please type it explicitly with \`as Route\`.`
}

function rootParamsModule(rootParams: Map<string, Set<RootParamValueType>>): string {
  // Real Next generates `next/root-params`'s exports per-build from the app's
  // actual root params (dynamic segments at/above a root layout). Mirror that:
  // one getter per scanned param with its scanned value type (`string` for
  // `[name]`, `string[]` for catch-alls, `| undefined` when optional or absent
  // from some root layout). When the scan finds nothing (no root layout / no
  // dynamic root segments), fall back to the static `lang`/`locale` exports
  // that existing suites rely on.
  const order: RootParamValueType[] = ['string', 'string[]', 'undefined']
  const entries: [string, string][] =
    rootParams.size > 0
      ? [...rootParams.entries()].map(([name, types]) => [
          name,
          order.filter(type => types.has(type)).join(' | '),
        ])
      : [
          ['lang', 'string | string[] | undefined'],
          ['locale', 'string | string[] | undefined'],
        ]
  const getters = entries
    .map(([name, union]) => `  export function ${name}(): Promise<${union}>`)
    .join('\n')
  return `declare module 'next/root-params' {
${getters}
  const rootParams: (...args: any[]) => Promise<any>
  export default rootParams
}`
}

// Remove every top-level `declare module 'next...' { ... }` block from a shim
// source by brace-counting. Used when the real next package is present and
// should own the `next/*` type surface (typedRoutes). Non-next ambient
// declarations (node builtins, asset wildcards, RequestInit augmentation) are
// left intact.
function stripNextModuleDeclarations(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (/^declare module 'next[^']*' \{/.test(line)) {
      let depth = 0
      for (; i < lines.length; i++) {
        const current = lines[i]!
        depth += (current.match(/\{/g)?.length ?? 0) - (current.match(/\}/g)?.length ?? 0)
        if (depth === 0) break
      }
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

function nextShims(
  hasReactTypes: boolean,
  rootParams: Map<string, Set<RootParamValueType>>,
  omitNextModuleShims = false,
  legacyRequestTypes = false,
  hasRealNext = false,
): string {
  // Ambient module declarations override real module resolution, so the react
  // fallbacks below must only exist when no real `@types/react` was found —
  // otherwise `import { JSX } from 'react'` etc. fail against the stub.
  const reactShims = hasReactTypes
    ? ''
    : `
declare namespace JSX {
  interface Element {}
  interface IntrinsicElements {
    [name: string]: any
  }
}

declare namespace React {
  type ReactNode = any
  type ComponentType<P = any> = (props: P) => ReactNode
}

declare module 'react' {
  export type ReactNode = any
  export type ComponentType<P = any> = (props: P) => ReactNode
  export type AnchorHTMLAttributes<T> = any
  export type DetailedHTMLProps<E, T> = any
  export const Suspense: ComponentType<any>
  export const ViewTransition: ComponentType<any>
  export function addTransitionType(type: string): void
}

declare module 'react/jsx-runtime' {
  export const jsx: any
  export const jsxs: any
  export const Fragment: any
}
`
  const requestType = (type: string) =>
    legacyRequestTypes ? `Promise<${type}> & ${type}` : `Promise<${type}>`
  const requestShims = `declare module 'next/headers'{interface CookieSetOptions{name?:string;value?:string;path?:string;maxAge?:number;expires?:Date|number;httpOnly?:boolean;secure?:boolean;sameSite?:'strict'|'lax'|'none'|boolean;domain?:string}interface CookieStore{get(name:string):{name:string;value:string}|undefined;get(options:{name:string;value?:string}):{name:string;value:string}|undefined;getAll(name?:string):{name:string;value:string}[];getAll(options:{name:string;value?:string}):{name:string;value:string}[];has(name:string):boolean;readonly size:number;set(options:CookieSetOptions):CookieStore;set(name:string,value:string,options?:CookieSetOptions):CookieStore;delete(name:string):boolean;clear():CookieStore;[Symbol.iterator]():IterableIterator<readonly[string,{name?:string;value:string}]>}export function cookies():${requestType('CookieStore')};export function headers():${requestType('Headers')};export function draftMode():${requestType(`{isEnabled:boolean;enable():void;disable():void}`)}}
`
  const fontShims = hasRealNext
    ? ''
    : `declare module 'next/font'{export interface FontModule{className:string;style:{fontFamily:string;fontWeight?:number;fontStyle?:string};variable:string}}
declare module 'next/font/local'{import type{FontModule}from'next/font';export default function localFont(options:any):FontModule}
declare module 'next/font/google'{import type{FontModule}from'next/font';type FontLoader=(options?:any)=>FontModule;const font:FontLoader;export default font;export const Inter:FontLoader,Geist:FontLoader,Geist_Mono:FontLoader,Roboto:FontLoader,Roboto_Mono:FontLoader,Open_Sans:FontLoader,Lato:FontLoader,Montserrat:FontLoader,Poppins:FontLoader,Noto_Sans:FontLoader}
`
  const source = `${reactShims}
declare const process: {
  env: Record<string, string | undefined>
  emit?: (...args: any[]) => boolean
  cwd(): string
  platform: string
  arch: string
  version: string
  versions: Record<string, string>
  nextTick(callback: (...args: any[]) => void, ...args: any[]): void
  argv: string[]
  pid: number
  exit(code?: number): never
  [key: string]: any
}

declare const EdgeRuntime: string

declare const require: (id: string) => any

declare class Buffer extends Uint8Array {}

declare module 'async_hooks' {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: () => R): R
    getStore(): T | undefined
  }
}

declare module 'timers/promises' {
  export function setTimeout<T = void>(delay?: number, value?: T, options?: any): Promise<T>
  export function setImmediate<T = void>(value?: T, options?: any): Promise<T>
  export function setInterval<T = void>(delay?: number, value?: T, options?: any): AsyncIterable<T>
}

declare module 'node:timers/promises' {
  export * from 'timers/promises'
}

declare module 'node:crypto' {
  interface KeyObject {
    export(...args: any[]): any
    toString(...args: any[]): string
  }
  export function randomInt(...args: any[]): number
  export function randomBytes(...args: any[]): Buffer
  export function randomFillSync<T extends Uint8Array>(buffer: T, ...args: any[]): T
  export function randomUUID(...args: any[]): string
  export function getRandomValues<T extends Uint8Array>(array: T): T
  export function generateKeyPairSync(...args: any[]): { publicKey: any; privateKey: any }
  export function generateKeySync(...args: any[]): KeyObject
  export function generatePrimeSync(...args: any[]): ArrayBuffer | Uint8Array
  const crypto: {
    randomInt: typeof randomInt
    randomBytes: typeof randomBytes
    randomFillSync: typeof randomFillSync
    randomUUID: typeof randomUUID
    getRandomValues: typeof getRandomValues
    generateKeyPairSync: typeof generateKeyPairSync
    generateKeySync: typeof generateKeySync
    generatePrimeSync: typeof generatePrimeSync
  }
  export default crypto
}

declare module 'crypto' {
  export * from 'node:crypto'
  export { default } from 'node:crypto'
}

// Next.js augments the fetch RequestInit with a "next" field for its extended
// fetch semantics (revalidate/tags); mirror that here so app code using
// fetch(url, next revalidate) typechecks.
interface RequestInit {
  next?: {
    revalidate?: number | false
    tags?: string[]
  }
}

interface ResponseInit {
  request?: {
    headers?: HeadersInit
  }
}

declare module 'node:buffer' {
  export const Buffer: any
  export const constants: any
  export const kMaxLength: number
  export const kStringMaxLength: number
  export const SlowBuffer: any
}

declare module 'url' {
  export interface UrlObject {
    pathname?: string
    query?: Record<string, string | string[]>
    hash?: string
  }
}

declare module 'next/types.js' {
  export interface NextConfig {
    env?: Record<string, string | number | boolean | undefined>
    typedRoutes?: boolean
    typescript?: { tsconfigPath?: string; ignoreBuildErrors?: boolean }
    eslint?: { ignoreDuringBuilds?: boolean; dirs?: string[] }
    [key: string]: any
  }
  export type Metadata = any
  export type Viewport = any
  export type ResolvingMetadata = Promise<Metadata>
  export type ResolvingViewport = Promise<Viewport>
  export type NextApiHandler<T = any> = (...args: any[]) => any
  export type NextApiRequest = any
  export type NextApiResponse<T = any> = any
  export namespace MetadataRoute {
    type Robots = any
    type Sitemap = any[]
    type Manifest = any
  }
  export type Route<T = string> = string
  export type NextPage<P = {}, IP = P> = ((props: P) => any) & { [key: string]: any }
  export type NextComponentType<C = any, IP = any, P = any> = any
  export type PageProps<P = any> = any
  export type LayoutProps<P = any> = any
}

declare module 'next/types' {
  export * from 'next/types.js'
  export { MetadataRoute } from 'next/types.js'
}

declare module 'next' {
  export type {
    NextConfig,
    Metadata,
    Viewport,
    ResolvingMetadata,
    ResolvingViewport,
    NextApiRequest,
    NextApiResponse,
    NextApiHandler,
    Route,
    NextPage,
    NextComponentType,
    PageProps,
    LayoutProps,
  } from 'next/types.js'
  export { MetadataRoute } from 'next/types.js'
  export type GetServerSideProps<P = any, Q = any> = any
  export type GetStaticProps<P = any, Q = any> = any
  export type GetStaticPaths<Q = any> = any
  export type InferGetServerSidePropsType<T = any> = any
  export type InferGetStaticPropsType<T = any> = any
}

declare module 'next/cache' {
  export function revalidatePath(path: string, type?: 'page' | 'layout'): void
  export function revalidateTag(tag: string, profile: string | { expire?: number }): void
  export function updateTag(tag: string): void
  export function unstable_cache(...args: any[]): any
  export function unstable_noStore(): void
  export function unstable_expirePath(path: string, type?: 'page' | 'layout'): void
  export function unstable_expireTag(...tags: string[]): void
  export function expirePath(path: string, type?: 'page' | 'layout'): void
  export function expireTag(...tags: string[]): void
  export function refresh(): void
  export function unstable_refresh(): void
  export const io: any
  export const cacheTag: (...tags: string[]) => void
  export const cacheLife: (...args: any[]) => void
  export const unstable_cacheTag: (...tags: string[]) => void
  export const unstable_cacheLife: (...args: any[]) => void
}

${requestShims}

declare module 'next/server' {
  interface NextURL extends URL {
    clone(): NextURL
    basePath: string
    buildId?: string
    locale: string
    defaultLocale?: string
  }
  interface RequestCookie {
    name: string
    value: string
  }
  interface RequestCookies {
    get(name: string): RequestCookie | undefined
    getAll(name?: string): RequestCookie[]
    has(name: string): boolean
    set(name: string, value: string): RequestCookies
    set(cookie: RequestCookie): RequestCookies
    delete(name: string | string[]): boolean | boolean[]
    clear(): RequestCookies
    readonly size: number
    [Symbol.iterator](): IterableIterator<[string, RequestCookie]>
  }
  interface ResponseCookies {
    get(name: string): (RequestCookie & Record<string, any>) | undefined
    getAll(name?: string): (RequestCookie & Record<string, any>)[]
    has(name: string): boolean
    set(name: string, value: string, options?: any): ResponseCookies
    set(options: { name: string; value: string; [key: string]: any }): ResponseCookies
    delete(name: string, options?: any): ResponseCookies
    [Symbol.iterator](): IterableIterator<[string, RequestCookie & Record<string, any>]>
  }
  export class NextRequest extends Request {
    nextUrl: NextURL
    cookies: RequestCookies
    geo?: any
    ip?: string
  }
  export class NextResponse extends Response {
    cookies: ResponseCookies
    static json(body: any, init?: ResponseInit): NextResponse
    static next(init?: ResponseInit): NextResponse
    static redirect(url: string | URL, init?: number | ResponseInit): NextResponse
    static rewrite(url: string | URL, init?: ResponseInit): NextResponse
  }
  export type NextFetchEvent = any
  export type NextMiddleware = (...args: any[]) => any
  export type NextMiddlewareResult = any
  export interface ProxyConfig {
    matcher?: string | { source: string } | Array<string | { source: string }>
  }
  export class ImageResponse extends Response {
    constructor(element: any, options?: any)
  }
  export const URLPattern: any
  export function userAgent(request: { headers: Headers }): any
  export function userAgentFromString(ua: string | undefined): any
  export function after(task: any): void
  export function connection(): Promise<void>
  export const io: any
}

declare module 'next/server.js' {
  export * from 'next/server'
}

declare module 'next/navigation.js' {
  export * from 'next/navigation'
}

declare module 'next/headers.js' {
  export * from 'next/headers'
}

declare module 'next/cache.js' {
  export * from 'next/cache'
}

declare module 'next/link.js' {
  export * from 'next/link'
  export { default } from 'next/link'
}

declare module 'next/image.js' {
  export * from 'next/image'
  export { default } from 'next/image'
}

declare module 'next/script.js' {
  export * from 'next/script'
  export { default } from 'next/script'
}

declare module 'next/dist/client/link.js' {
  export interface LinkProps {
    href: any
  }
  export function useLinkStatus(): any
}

declare module 'next/link' {
  import type { AnchorHTMLAttributes, ComponentType } from 'react'
  // Mirror Next's public LinkProps: standard anchor attributes plus Link's own
  // props, but NO catch-all index signature. A wildcard string index signature
  // would silently accept non-public props (e.g. unstable_dynamicOnHover),
  // making a fixture's ts-expect-error on such a prop report as unused.
  export interface LinkProps
    extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
    href: any
    // Next 16's public prefetch type. The unstable_forceStale value is
    // runtime-only and Next deliberately keeps it OUT of the public union, so an
    // exhaustive switch over prefetch ending in "prefetch satisfies never"
    // stays valid. Including it here would leave that value in the default
    // branch and break such fixtures under our shim.
    prefetch?: boolean | 'auto' | null
    scroll?: boolean
    replace?: boolean
    as?: any
    shallow?: boolean
    passHref?: boolean
    locale?: string | false
    legacyBehavior?: boolean
    onNavigate?: (event: { preventDefault(): void }) => void
    transitionTypes?: string[]
    children?: any
  }
  const Link: ComponentType<LinkProps>
  export default Link
  export function useLinkStatus(): { pending: boolean }
}

declare module 'next/image' {
  import type { ComponentType } from 'react'
  export interface ImageProps {
    src: any
    alt: string
    width?: number | string
    height?: number | string
    fill?: boolean
    priority?: boolean
    loading?: 'lazy' | 'eager'
    placeholder?: string
    blurDataURL?: string
    unoptimized?: boolean
    sizes?: string
    quality?: number | string
    className?: string
    [key: string]: any
  }
  export interface StaticImageData {
    src: string
    height: number
    width: number
    blurDataURL?: string
    blurWidth?: number
    blurHeight?: number
  }
  const Image: ComponentType<ImageProps>
  export default Image
  export function getImageProps(props: ImageProps): { props: any }
  export function unstable_getImgProps(props: ImageProps): { props: any }
}

declare module '@vercel/og' {
  export class ImageResponse extends Response {
    constructor(element: any, options?: any)
  }
  export type ImageResponseOptions = any
}

declare module 'next/og' {
  export class ImageResponse extends Response {
    constructor(element: any, options?: any)
    static json(...args: any[]): ImageResponse
  }
  export interface ImageResponseOptions {
    width?: number
    height?: number
    fonts?: any[]
    debug?: boolean
    status?: number
    statusText?: string
    headers?: HeadersInit
    emoji?: string
    [key: string]: any
  }
}

declare module 'next/dynamic' {
  import type { ComponentType } from 'react'
  export interface DynamicOptions {
    loading?: ComponentType<any>
    ssr?: boolean
    loadableGenerated?: any
    suspense?: boolean
    [key: string]: any
  }
  // Infer P from the loader like real next/dynamic's Loader<P>; a bare
  // Promise<any> loader would collapse P to any and strip prop types.
  type LoaderComponent<P> = ComponentType<P> | { default: ComponentType<P> }
  export default function dynamic<P = {}>(
    loader: (() => Promise<LoaderComponent<P>>) | Promise<LoaderComponent<P>>,
    options?: DynamicOptions,
  ): ComponentType<P>
}

declare module 'next/error' {
  import type { ComponentType, ReactNode } from 'react'
  export interface ErrorInfo {
    error: Error
    reset: () => void
    unstable_retry: () => void
    [key: string]: any
  }
  export interface ErrorProps {
    statusCode: number
    title?: string
    withDarkMode?: boolean
    [key: string]: any
  }
  const ErrorComponent: ComponentType<ErrorProps>
  export default ErrorComponent
  // Wraps a fallback renderer (props, info) => JSX in an error boundary. The
  // returned component takes the fallback's own props plus children (the
  // guarded subtree) and an optional clearError reset callback. Mirrors the
  // runtime in src/compat/next/error.tsx.
  export function unstable_catchError<P extends Record<string, any> = any>(
    fallback: (props: P, info: ErrorInfo) => ReactNode,
  ): ComponentType<P & { children?: ReactNode; clearError?: () => void }>
}

${fontShims}

declare module 'next/script' {
  import type { ComponentType } from 'react'
  export interface ScriptProps {
    src?: string
    strategy?: 'afterInteractive' | 'lazyOnload' | 'beforeInteractive' | 'worker'
    onLoad?: (...args: any[]) => void
    onReady?: (...args: any[]) => void
    onError?: (...args: any[]) => void
    id?: string
    children?: any
    [key: string]: any
  }
  const Script: ComponentType<ScriptProps>
  export default Script
}

declare module 'next/legacy/image' {
  import type { ComponentType } from 'react'
  export interface ImageProps {
    src: any
    alt?: string
    width?: number | string
    height?: number | string
    layout?: 'fixed' | 'intrinsic' | 'responsive' | 'fill'
    objectFit?: string
    objectPosition?: string
    priority?: boolean
    loading?: 'lazy' | 'eager'
    placeholder?: string
    blurDataURL?: string
    unoptimized?: boolean
    sizes?: string
    quality?: number | string
    [key: string]: any
  }
  const Image: ComponentType<ImageProps>
  export default Image
}

${rootParamsModule(rootParams)}

declare module 'next/web-vitals' {
  export interface NextWebVitalsMetric {
    id: string
    name: string
    startTime: number
    value: number
    label: 'web-vital' | 'custom'
    [key: string]: any
  }
  export function useReportWebVitals(reportFn: (metric: NextWebVitalsMetric) => void): void
}

declare module 'next/dist/client/components/app-router-headers' {
  export const NEXT_RSC_UNION_QUERY: string
  export const RSC_HEADER: string
  export const NEXT_ROUTER_STATE_TREE_HEADER: string
  export const NEXT_ROUTER_PREFETCH_HEADER: string
  export const NEXT_URL: string
  const headers: Record<string, string>
  export default headers
}

declare module 'next/dist/server/app-render/work-unit-async-storage.external' {
  export const workUnitAsyncStorage: {
    getStore(): any
    run<R>(store: any, callback: () => R): R
  }
}

declare module 'next/dist/server/web/spec-extension/adapters/headers' {
  export class ReadonlyHeaders extends Headers {}
}

declare module 'next/dist/server/web/spec-extension/adapters/request-cookies' {
  export interface ReadonlyRequestCookies {
    get(name: string): { name: string; value: string } | undefined
    getAll(name?: string): { name: string; value: string }[]
    has(name: string): boolean
    readonly size: number
    [Symbol.iterator](): IterableIterator<[string, { name: string; value: string }]>
  }
}

declare module 'node-fetch' {
  export class Headers {
    get(name: string): string | null
    has(name: string): boolean
    set(name: string, value: string): void
    append(name: string, value: string): void
    delete(name: string): void
    forEach(callback: (value: string, name: string) => void): void
    [Symbol.iterator](): IterableIterator<[string, string]>
  }
  const fetch: (...args: any[]) => Promise<any>
  export default fetch
}

declare module 'next/router' {
  export interface NextRouter {
    route: string
    pathname: string
    asPath: string
    query: Record<string, string | string[] | undefined>
    push(url: any, as?: any, options?: any): Promise<boolean>
    replace(url: any, as?: any, options?: any): Promise<boolean>
    prefetch(url: string): Promise<void>
    back(): void
    reload(): void
    beforePopState(callback: (...args: any[]) => boolean): void
    events: {
      on(type: string, handler: (...args: any[]) => void): void
      off(type: string, handler: (...args: any[]) => void): void
      emit(type: string, ...args: any[]): void
    }
  }
  export function useRouter(): NextRouter
  const router: NextRouter
  export default router
}

declare module 'next/app' {
  // Pages-router shim: pnext builds the app directory only, but fixtures and
  // hybrid apps may carry a pages/ tree whose _app imports next/app. The type
  // program includes pages/**, so this keeps the typecheck from failing a
  // build over files pnext never bundles.
  export interface AppProps<P = any> {
    Component: (props: P) => any
    pageProps: P
    router?: any
    [key: string]: any
  }
  export type AppType = (props: AppProps) => any
  const App: AppType
  export default App
}

declare module 'next/dist/client/components/navigation.js' {
  export interface NavigateOptions {
    scroll?: boolean
  }
  export interface PrefetchOptions {
    kind?: 'auto' | 'full'
    onInvalidate?: () => void
  }
  export interface AppRouterInstance {
    push(href: string, options?: NavigateOptions): void
    replace(href: string, options?: NavigateOptions): void
    prefetch(href: string, options?: PrefetchOptions): void
    refresh(): void
    back(): void
    forward(): void
    bfcacheId: string
  }
  export function useRouter(): AppRouterInstance
  export function notFound(): never
}

declare module 'next/navigation' {
  export interface NavigateOptions {
    scroll?: boolean
  }
  export interface PrefetchOptions {
    kind?: 'auto' | 'full'
    onInvalidate?: () => void
  }
  export interface AppRouterInstance {
    push(href: string, options?: NavigateOptions): void
    replace(href: string, options?: NavigateOptions): void
    prefetch(href: string, options?: PrefetchOptions): void
    refresh(): void
    back(): void
    forward(): void
    bfcacheId: string
  }
  export function useRouter(): AppRouterInstance
  export function usePathname(): string
  export class ReadonlyURLSearchParams extends URLSearchParams {
    append(): never
    delete(): never
    set(): never
    sort(): never
  }
  export function useSearchParams(): ReadonlyURLSearchParams
  export function useParams<T = Record<string, string | string[]>>(): T
  export function useSelectedLayoutSegment(parallelRoutesKey?: string): string | null
  export function useSelectedLayoutSegments(parallelRoutesKey?: string): string[]
  export function useLayoutSegments(parallelRoutesKey?: string): string[]
  export function useLinkStatus(): { pending: boolean }
  export function unstable_isUnrecognizedActionError(error: unknown): boolean
  export const RedirectType: { push: 'push'; replace: 'replace' }
  export type RedirectType = 'push' | 'replace'
  export function notFound(): never
  export function forbidden(): never
  export function unauthorized(): never
  export function redirect(url: string, type?: RedirectType): never
  export function permanentRedirect(url: string, type?: RedirectType): never
  export function unstable_rethrow(error: unknown): void
  export function useServerInsertedHTML(callback: () => any): void
}

declare module 'next/dist/shared/lib/app-router-context.shared-runtime.js' {
  export interface NavigateOptions {
    scroll?: boolean
  }
  export interface PrefetchOptions {
    kind?: 'auto' | 'full'
    onInvalidate?: () => void
  }
  export interface AppRouterInstance {
    push(href: string, options?: NavigateOptions): void
    replace(href: string, options?: NavigateOptions): void
    prefetch(href: string, options?: PrefetchOptions): void
    refresh(): void
    back(): void
    forward(): void
    bfcacheId: string
  }
}

declare module 'next/dist/client/components/redirect-error.js' {
  export type RedirectType = 'replace' | 'push'
}

declare module 'next/dist/client/form.js' {
  export interface FormProps {
    action: any
  }
}

declare module 'next/form' {
  export interface FormProps {
    action: string | ((formData: FormData) => void | Promise<void>)
    replace?: boolean
    scroll?: boolean
    prefetch?: boolean
    [key: string]: any
  }
  export default function Form(props: FormProps): any
}

declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.module.scss' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.module.sass' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css' {
  const href: string | undefined
  export default href
}

declare module '*.scss' {
  const href: string | undefined
  export default href
}

declare module '*.sass' {
  const href: string | undefined
  export default href
}

declare module '*.png' {
  const content: { src: string; height: number; width: number; blurDataURL?: string }
  export default content
}

declare module '*.jpg' {
  const content: { src: string; height: number; width: number; blurDataURL?: string }
  export default content
}

declare module '*.jpeg' {
  const content: { src: string; height: number; width: number; blurDataURL?: string }
  export default content
}

declare module '*.gif' {
  const content: { src: string; height: number; width: number; blurDataURL?: string }
  export default content
}

declare module '*.svg' {
  // \`any\` (not the static-image descriptor shape used above) to avoid
  // conflicts with \`@svgr/webpack\`-style loader rules that import an SVG as
  // a component, matching Next's own image-types/global.d.ts.
  const content: any
  export default content
}

declare module '*.webp' {
  const content: { src: string; height: number; width: number; blurDataURL?: string }
  export default content
}

declare module '*.wasm' {
  const content: any
  export default content
}

declare module '*.mdx' {
  const MDXComponent: (props: any) => any
  export default MDXComponent
}

declare module '*.md' {
  const MDXComponent: (props: any) => any
  export default MDXComponent
}
${loaderRuleAssetDeclarations()}`
  return omitNextModuleShims ? stripNextModuleDeclarations(source) : source
}

// Next's generated `next-env.d.ts` carries ambient wildcard module declarations
// for every asset extension its loaders/rules handle, so `import x from
// './x.data'` typechecks even though tsc has no on-disk `.data` module. pnext's
// generated typecheck env ships the standard set above; add one `any`-typed
// wildcard per configured `turbopack.rules` extension that the standard set
// (and TS's own source/JSON resolution) does not already cover.
const STANDARD_ASSET_DECLARATIONS = new Set([
  '.css',
  '.scss',
  '.sass',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '.wasm',
  '.mdx',
  '.md',
])
const TS_RESOLVED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.d.ts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
])

function loaderRuleAssetDeclarations(): string {
  const specs = new Set<string>()
  for (const rule of turbopackLoaderRules()) {
    // Only leading-`*` globs form a valid ambient wildcard module ('*.data').
    if (!rule.glob.startsWith('*')) continue
    const ext = rule.glob.slice(1).toLowerCase()
    if (STANDARD_ASSET_DECLARATIONS.has(ext) || TS_RESOLVED_EXTENSIONS.has(ext)) continue
    specs.add(rule.glob)
  }
  if (specs.size === 0) return ''
  return `${[...specs]
    .map(
      spec => `
declare module '${spec}' {
  const content: any
  export default content
}`,
    )
    .join('')}\n`
}
