import { requireRequest, requestApiPromise } from '../../request/context'
import { assertRequestApiAllowedInAfter } from '../lifecycle/after-scope'
import { assertNoDynamicApiInsideCache } from '../cache/revalidate'
import { assertDynamicErrorRequestApi } from './headers'

export { after } from '../lifecycle/after'
export { io } from '../ppr/io'
export { NextRequest, NextResponse } from '../../api/server'
export type { NextRequestGeo } from '../../api/server'
export type { NextFetchEvent } from '../../types'
export type { ProxyConfig } from '../../routing/proxy'
export { ImageResponse } from './og'
// Pure UA/URLPattern helpers live in a client-safe module so the client
// `next/server` variant (client-server.ts) can share them without pulling this
// file's node:async_hooks imports into the browser bundle.
export { URLPattern, userAgent, userAgentFromString } from './user-agent'
export type { UserAgent } from './user-agent'

/** Marks the surrounding scope as dynamic, like headers()/cookies(). */
export function connection(): Promise<Record<never, never>> {
  assertRequestApiAllowedInAfter('connection()')
  assertDynamicErrorRequestApi('connection()')
  assertNoDynamicApiInsideCache('connection()')
  return requestApiPromise('connection()', () => {
    requireRequest('connection()')
    return {}
  })
}
