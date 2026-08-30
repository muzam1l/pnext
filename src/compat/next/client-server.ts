// Client-safe `next/server` variant (COMPAT).
//
// The server entry imports request-scope and prerender machinery that all pull in `node:async_hooks`,
// which esbuild cannot resolve for a browser bundle. A `'use client'` component may still import
// `next/server`, so - mirroring the next/cache and next/navigation client/server alias split - the
// client target aliases `next/server` here. The request-scope APIs are server-only in Next anyway;
// client-side they degrade to inert stubs, since the real dynamic-marking happens during SSR and
// control-flow like redirect/notFound is driven by the client error runtime after hydration.

export { NextRequest, NextResponse } from '../../api/server'
export type { NextRequestGeo } from '../../api/server'
export type { NextFetchEvent } from '../../types'
export type { ProxyConfig } from '../../routing/proxy'
export { URLPattern, userAgent, userAgentFromString } from './user-agent'
export type { UserAgent } from './user-agent'

/** Browser-safe placeholder; OG rendering only runs on the server. */
export class ImageResponse extends Response {
  constructor(_element: unknown, options: ResponseInit = {}) {
    super(null, options)
  }
}

type AfterTask<T> = Promise<T> | (() => T | Promise<T>)

/** Client stub: dynamic marking is a server concern; resolve immediately. */
export function connection(): Promise<Record<never, never>> {
  return Promise.resolve({})
}

/** Client stub: `after()` callbacks only run server-side; no-op in the browser. */
export function after<T>(_task: AfterTask<T>): void {
  // intentionally empty
}

/** Client stub: IO postpone only fires during a server prerender. */
export function io(): Promise<void> {
  return Promise.resolve()
}
