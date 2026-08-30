// Telemetry debug emission (COMPAT).
//
// Next prints every telemetry event to stdout when NEXT_TELEMETRY_DEBUG is set: `[telemetry] ` plus a
// pretty-printed `{ eventName, payload }`. Harnesses parse that output with a regex, so the two-space
// indentation (closing brace at column 0) is part of the contract. pnext sends nothing anywhere - this
// is wire-format parity only, emitted once per CLI session after next.config loads.

import type { NextConfigObject } from './config-loader'

const EVENT_CLI_SESSION_STARTED = 'NEXT_CLI_SESSION_STARTED'
const EVENT_BUILD_FEATURE_USAGE = 'NEXT_BUILD_FEATURE_USAGE'

let emitted = false
let featureUsageEmitted = false

function configuredStaleTimes(config: NextConfigObject): { static?: number; dynamic?: number } {
  const experimental = config.experimental
  if (!experimental || typeof experimental !== 'object') return {}
  const staleTimes = (experimental as { staleTimes?: unknown }).staleTimes
  if (!staleTimes || typeof staleTimes !== 'object') return {}
  const value = staleTimes as { static?: unknown; dynamic?: unknown }
  return {
    ...(typeof value.static === 'number' ? { static: value.static } : {}),
    ...(typeof value.dynamic === 'number' ? { dynamic: value.dynamic } : {}),
  }
}

/** Print the session-started telemetry event when NEXT_TELEMETRY_DEBUG is on. */
export function emitSessionStartedTelemetry(config: NextConfigObject): void {
  if (emitted) return
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  if (!process.env.NEXT_TELEMETRY_DEBUG) return
  emitted = true
  const staleTimes = configuredStaleTimes(config)
  const event = {
    eventName: EVENT_CLI_SESSION_STARTED,
    payload: {
      nodeVersion: process.version,
      cliCommand: process.argv[2] ?? 'unknown',
      staticStaleTime: staleTimes.static ?? null,
      dynamicStaleTime: staleTimes.dynamic ?? null,
    },
  }
  console.log(`[telemetry] ${JSON.stringify(event, null, 2)}`)
}

/**
 * Print `NEXT_BUILD_FEATURE_USAGE` events for the next.config features the suites assert on.
 * Build-command only, matching Next (the event is produced by the build pipeline, not by start). Payload
 * shape is exactly `{ featureName, invocationCount }` - the upstream assertions use `toContainEqual`, so
 * any extra key fails the deep match.
 */
export function emitBuildFeatureUsageTelemetry(config: NextConfigObject): void {
  if (featureUsageEmitted) return
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  if (!process.env.NEXT_TELEMETRY_DEBUG) return
  if ((process.argv[2] ?? '') !== 'build') return
  featureUsageEmitted = true
  const experimental = config.experimental
  const esmExternals =
    experimental && typeof experimental === 'object'
      ? (experimental as { esmExternals?: unknown }).esmExternals
      : undefined
  // Next counts a feature as "used" only when it is set away from its default.
  if (esmExternals !== undefined && esmExternals !== true) {
    console.log(
      `[telemetry] ${JSON.stringify(
        {
          eventName: EVENT_BUILD_FEATURE_USAGE,
          payload: { featureName: 'esmExternals', invocationCount: 1 },
        },
        null,
        2,
      )}`,
    )
  }
}
