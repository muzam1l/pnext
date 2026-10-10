// Compat facts a production release carries (COMPAT): compiled next.config, cache handlers and
// instrumentation, plus the app facts compat would otherwise rescan from source at boot.
import path from 'node:path'
import type { ResolvedConfig } from '../config'
import type { CompatRelease } from '../runtime/production'
import { pagesRevalidateFacts } from './cache-control'
import { emitReleaseInstrumentation } from './lifecycle/instrumentation'
import { emitNextConfigBundle } from './next/config-loader'
import { pagesApiFacts, pagesRouteFacts } from './pages/api'
import { scanRootParams } from './ppr/root-params-scan'

export async function compatReleaseFacts(
  config: ResolvedConfig,
  outDir: string,
): Promise<CompatRelease> {
  const [nextConfig, instrumentation] = await Promise.all([
    emitNextConfigBundle(config.root, outDir),
    emitReleaseInstrumentation(config, outDir),
  ])
  const toPosix = (file: string) => file.split(path.sep).join('/')
  return {
    ...(nextConfig ? { nextConfig: toPosix(path.relative(config.outPath, nextConfig.file)) } : {}),
    ...(instrumentation
      ? {
          instrumentation: {
            file: toPosix(instrumentation.file),
            ...(instrumentation.edge ? { edge: toPosix(instrumentation.edge) } : {}),
          },
        }
      : {}),
    compat: {
      rootParams: [...scanRootParams(config.appPath)],
      pagesRevalidate: pagesRevalidateFacts(config.root).map(
        ([file, seconds]): [string, number] => [toPosix(file), seconds],
      ),
      pagesApi: pagesApiFacts(config.root),
      pagesRoutes: pagesRouteFacts(config),
      cacheHandlers: Object.fromEntries(
        Object.entries(nextConfig?.handlers ?? {}).map(([name, file]) => [
          name,
          toPosix(path.relative(config.outPath, file)),
        ]),
      ),
    },
  }
}
