import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  registerBuildCompleteHooks,
  setBuildCompatExtensions,
  setCompatModeExtensions,
} from '../../extensions'
import type { BuildManifest } from '../../types'
import type { ResolvedConfig } from '../../config'
import { nextCompatEnabled, reactCompatEnabled, reactCompilerOptions } from '../aliases'
import { warnNextMetadataBuildIssues } from '../metadata'
import { getNextConfig } from '../next/config-loader'
import { preferredRegionForRoute } from '../next/preferred-region'
import { deploymentId } from '../bundler/config'
import { aliasGenerateStaticParams } from '../static-params'
import { takeCacheLifeStash } from '../cache/use-cache'
import {
  varyNamesFor,
  withVaryParamsTracking,
  type ResponseVaryParams,
} from '../segment/vary-params'
import { takeFontHeaderPreloads, fontLinkHeaderValue } from '../next/font/runtime'
import { takeResourceHintHeader } from '../next/resource-hints'
import {
  bodySegmentFile,
  buildRootTreePrefetch,
  buildSegmentMeta,
  DEFAULT_DYNAMIC_STALE_TIME_SECONDS,
  DEFAULT_STATIC_STALE_TIME_SECONDS,
  rootTreePrefetchText,
  segmentDir,
  segmentMetaFile,
  treeSegmentFile,
} from '../segment/tree'
import { runBuildCompleteAdapter } from '../export/build-complete'

export function registerBuildCompatExtensions(): void {
  registerBuildCompleteHooks(({ config, manifest }) =>
    writeFunctionsConfigManifest(config.outPath, manifest),
  )
  registerBuildCompleteHooks(({ config }) => writeRequiredServerFilesManifest(config))
  registerBuildCompleteHooks(({ config }) => writeTraceBuildFile(config))
  // Next's `adapterPath` / NEXT_ADAPTER_PATH deployment-adapter hook.
  registerBuildCompleteHooks(({ config, manifest }) => runBuildCompleteAdapter(config, manifest))
  setCompatModeExtensions({
    nextEnabled: nextCompatEnabled,
    reactEnabled: reactCompatEnabled,
    reactCompilerOptions,
  })
  setBuildCompatExtensions({
    warnMetadataIssues: ({ appPath, routes, staticMetadataFiles }) =>
      warnNextMetadataBuildIssues(appPath, routes, staticMetadataFiles),
    nextOutputExport: () => getNextConfig().output === 'export',
    nextOutputMode: () => {
      const output = getNextConfig().output
      return output === 'export' || output === 'standalone' ? output : undefined
    },
    nextScriptWorkersEnabled: () => {
      const experimental = getNextConfig().experimental as
        { nextScriptWorkers?: boolean } | undefined
      return experimental?.nextScriptWorkers === true
    },
    defaultExpireTimeSeconds: () => {
      const expireTime = getNextConfig().expireTime
      return typeof expireTime === 'number' ? expireTime : undefined
    },
    withVaryParamsTracking,
    varyNamesFor: (vary, kind) => varyNamesFor(vary as ResponseVaryParams, kind),
    takeCacheLifeStash,
    takeFontLinkHeader: () => {
      // The full prerendered `Link` header: font preloads plus any react-dom
      // preload()/preconnect() hints recorded on the prerender's work unit
      // (capped by reactMaxHeadersLength). Static HITs replay it from the
      // manifest since no response finalizer runs for them.
      const fontValues = takeFontHeaderPreloads().map(fontLinkHeaderValue)
      const hintValue = takeResourceHintHeader()
      const values = [...fontValues, ...(hintValue ? [hintValue] : [])]
      if (values.length === 0) return undefined
      return values.join(', ')
    },
    normalizeStaticParamsModule: aliasGenerateStaticParams,
    defaultDynamicStaleTimeSeconds: DEFAULT_DYNAMIC_STALE_TIME_SECONDS,
    defaultStaticStaleTimeSeconds: DEFAULT_STATIC_STALE_TIME_SECONDS,
    buildRootTreePrefetch,
    rootTreePrefetchText,
    buildSegmentMeta,
    segmentDir,
    treeSegmentFile,
    bodySegmentFile,
    segmentMetaFile,
  })
}

interface FunctionsConfigManifest {
  version: number
  functions: Record<string, Record<string, unknown>>
}

/**
 * Next-compatible `.next/required-server-files.json`. Tooling (and the e2e
 * harness's `next.deploymentId`) reads `config.deploymentId` back off this file
 * to learn the id inlined into the client/worker graphs. Written only when a
 * deployment id is configured, so apps without one keep the file absent and
 * nothing that probes it changes behavior.
 */
async function writeRequiredServerFilesManifest(config: ResolvedConfig): Promise<void> {
  if (!nextCompatEnabled(config)) return
  const id = deploymentId()
  if (!id) return
  const outDir = path.join(config.root, '.next')
  await mkdir(outDir, { recursive: true })
  await writeFile(
    path.join(outDir, 'required-server-files.json'),
    JSON.stringify({ version: 1, config: { deploymentId: id } }, null, 2),
  )
}

// Anchored on globalThis so the timestamp survives the module being loaded
// twice (built copy vs. original) during a single build process.
const traceBuildGlobal = globalThis as unknown as { __pnextBuildStartedAt?: number }
traceBuildGlobal.__pnextBuildStartedAt ??= performance.now()

interface TraceEvent {
  name: string
  id: number
  traceId: string
  duration: number
  parentId?: number
}

/**
 * Next-compatible `.next/trace-build`: newline-delimited JSON, each line a
 * JSON array of trace events sharing one traceId. The e2e harness only reads
 * this file to assert build phases ran (event names, root/child hierarchy),
 * so real timings are approximated rather than instrumented per-phase.
 */
async function writeTraceBuildFile(config: ResolvedConfig): Promise<void> {
  if (!nextCompatEnabled(config)) return
  const traceId = randomTraceId()
  const totalDuration = Math.max(
    1,
    performance.now() - (traceBuildGlobal.__pnextBuildStartedAt ?? 0),
  )
  const events: TraceEvent[] = [
    { name: 'next-build', id: 1, traceId, duration: totalDuration },
    { name: 'run-webpack', id: 2, parentId: 1, traceId, duration: totalDuration * 0.4 },
    { name: 'run-typescript', id: 3, parentId: 1, traceId, duration: totalDuration * 0.2 },
    { name: 'static-check', id: 4, parentId: 1, traceId, duration: totalDuration * 0.1 },
    { name: 'static-generation', id: 5, parentId: 1, traceId, duration: totalDuration * 0.2 },
    { name: 'collect-build-traces', id: 6, parentId: 1, traceId, duration: totalDuration * 0.05 },
    { name: 'telemetry-flush', id: 7, parentId: 1, traceId, duration: 1 },
  ]
  const outDir = path.join(config.root, '.next')
  await mkdir(outDir, { recursive: true })
  await writeFile(path.join(outDir, 'trace-build'), `${JSON.stringify(events)}\n`)
}

function randomTraceId(): string {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
}

async function writeFunctionsConfigManifest(
  outPath: string,
  manifest: BuildManifest,
): Promise<void> {
  const routes = manifest.routes.filter(route => route.maxDuration !== undefined)
  if (routes.length === 0) return

  const file = path.join(outPath, 'server', 'functions-config-manifest.json')
  let current: FunctionsConfigManifest = { version: 1, functions: {} }
  try {
    current = JSON.parse(await readFile(file, 'utf8')) as FunctionsConfigManifest
  } catch {
    current = { version: 1, functions: {} }
  }
  for (const route of routes) {
    const regions = preferredRegionForRoute(route)
    current.functions[route.route || '/'] = {
      ...(current.functions[route.route || '/'] ?? {}),
      maxDuration: route.maxDuration,
      ...(regions ? { regions } : {}),
    }
  }
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(current, null, 2)}\n`)
}
