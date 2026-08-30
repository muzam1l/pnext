// Resume-data-cache (RDC) - COMPAT (may import core freely). Composes the per-cache capture/seed
// helpers into the opaque render-lifecycle capability core drives; core never imports this file.
//
// Artifact format (the `.rdc` file emitted next to a PPR shell, plain JSON):
//   { "v": 1,
//     "useCache": [ { key, value, tags, revalidateSeconds?, expireSeconds?, staleSeconds?, storedAt,
//                     tagSeq } ... ],
//     "fetch":    [ { key, snapshot: { status, statusText, headers, body(b64), url }, tags,
//                     revalidateSeconds?, storedAt } ... ] }
//
// `key` is the exact in-memory cache key so a serving-process read lands on the same key the dynamic
// render computes. Values are plain data only; anything else was skipped at capture and is recomputed
// at request time.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  getRequestExtensions,
  type PrerenderSidecarContext,
  type PrerenderSidecarExtension,
} from '../../extensions'
import { pathRevalidatedSince, tagsRevalidatedSince, tagsStaleSince } from './revalidate'
import {
  beginUseCacheRdcCapture,
  collectUseCacheRdcRecords,
  collectUseCacheRdcTags,
  seedUseCacheRdcRecords,
  type UseCacheRdcRecord,
} from './use-cache'
import {
  beginFetchRdcCapture,
  collectFetchRdcRecords,
  seedFetchRdcRecords,
  type FetchRdcRecord,
} from './fetch-patch'

export interface ResumeDataArtifact {
  v: 1
  useCache: UseCacheRdcRecord[]
  fetch: FetchRdcRecord[]
  /**
   * Union of every captured cache tag - including tags of entries too complex to serialize as records
   * (page-level `use cache` trees). isStale() must see them or updateTag()/revalidateTag() can never
   * stale the prebuilt shell.
   */
  tags?: string[]
}

function isArtifact(value: unknown): value is ResumeDataArtifact {
  const artifact = value as Partial<ResumeDataArtifact> | null
  return (
    typeof value === 'object' &&
    value !== null &&
    artifact?.v === 1 &&
    Array.isArray(artifact.useCache) &&
    Array.isArray(artifact.fetch)
  )
}

function artifactPath(context: PrerenderSidecarContext): string {
  return path.join(context.outPath, 'ppr', `${context.routeId}.rdc`)
}

function shellPath(context: PrerenderSidecarContext): string {
  return path.join(context.outPath, 'ppr', `${context.routeId}.html`)
}

async function sidecarFreshnessAt(context: PrerenderSidecarContext): Promise<number | undefined> {
  for (const file of [shellPath(context), artifactPath(context)]) {
    try {
      return (await stat(file)).mtimeMs
    } catch {
      // Try the fallback artifact when unit-testing the extension directly.
    }
  }
  return undefined
}

async function readArtifact(
  context: PrerenderSidecarContext,
): Promise<ResumeDataArtifact | undefined> {
  try {
    const artifact = JSON.parse(await readFile(artifactPath(context), 'utf8')) as unknown
    return isArtifact(artifact) ? artifact : undefined
  } catch {
    return undefined
  }
}

export const resumeDataCacheExtension: PrerenderSidecarExtension = {
  begin() {
    beginUseCacheRdcCapture()
    beginFetchRdcCapture()
  },
  async collect() {
    const useCache = await collectUseCacheRdcRecords()
    const fetch = await collectFetchRdcRecords()
    const tags = await collectUseCacheRdcTags()
    if (useCache.length === 0 && fetch.length === 0 && tags.length === 0) return undefined
    return {
      v: 1,
      useCache,
      fetch,
      ...(tags.length > 0 ? { tags } : {}),
    } satisfies ResumeDataArtifact
  },
  async persist(context, artifact) {
    if (!isArtifact(artifact)) return
    const file = artifactPath(context)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(artifact))
  },
  async seed(context) {
    const artifact = await readArtifact(context)
    if (!artifact) return
    seedUseCacheRdcRecords(artifact.useCache, context.routePath)
    seedFetchRdcRecords(artifact.fetch, context.routePath, artifact.tags ?? [])
  },
  async isStale(context) {
    const freshnessAt = await sidecarFreshnessAt(context)
    if (freshnessAt !== undefined && pathRevalidatedSince(context.routePath, freshnessAt)) {
      return true
    }
    const artifact = await readArtifact(context)
    if (!artifact) return false
    const tags = [
      ...(artifact.tags ?? []),
      ...artifact.useCache.flatMap(record => record.tags),
      ...artifact.fetch.flatMap(record => record.tags),
    ]
    if (
      freshnessAt !== undefined &&
      getRequestExtensions().staticStaleness(context.routePath, freshnessAt, tags)
    ) {
      return true
    }
    // Soft revalidations (revalidateTag with a nonzero-expiry profile) mark tags stale rather than
    // hard-revalidated. A PPR shell whose data carries a stale tag must regenerate on the next request -
    // the shell IS the data, since the values are baked into the prerendered HTML, so unlike ISR there
    // is no softer way to refresh it.
    if (freshnessAt === undefined) return false
    if (tagsRevalidatedSince(tags, freshnessAt)) return true
    return tagsStaleSince(tags, freshnessAt) ? 'soft' : false
  },
}
