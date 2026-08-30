// The typecheck, run on its own thread, so `typescript`'s multi-megabyte import lands off the build
// thread and runs alongside client bundling and prerendering.
//
// The thread gets the two config fields the checker reads plus a serializable projection of
// next.config, so it never re-loads the app's config.

import { parentPort, workerData } from 'node:worker_threads'
import type { ResolvedConfig } from '../../config'
import { setNextConfig } from '../next/config-loader'
import { PnextTypecheckError, validateTypes } from './check'
import type { TypecheckWorkerInput, TypecheckWorkerResult } from './check'

const input = workerData as TypecheckWorkerInput
const { nextConfig, ...config } = input
setNextConfig(nextConfig)

let result: TypecheckWorkerResult
try {
  await validateTypes(config as ResolvedConfig)
  result = { ok: true }
} catch (error) {
  result =
    error instanceof PnextTypecheckError
      ? { ok: false, messages: error.message.split('\n\n') }
      : {
          ok: false,
          failure: error instanceof Error ? error.stack || error.message : String(error),
        }
}
parentPort?.postMessage(result)
