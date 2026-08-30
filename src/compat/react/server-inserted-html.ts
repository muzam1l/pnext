// useServerInsertedHTML (COMPAT - CSS-in-JS SSR).
//
// Next exposes `useServerInsertedHTML(callback)`, re-exported from `next/navigation`. CSS-in-JS
// libraries call it during the server render to register the collected `<style>` markup that must land
// in the streamed document. React's upstream impl flushes each callback's JSX at every stream boundary;
// pnext retains callbacks in the request work unit and invokes them for the initial head and each
// streamed continuation.
//
// Server: push the callback. Client: no-op - the hook exists so a shared 'use client' registry component
// compiles and hydrates, but there is nothing to insert on the client, since the styles are already in
// the SSR HTML and the library takes over locally.
//
// renderServerInsertedHTML() renders each callback's vnode to a string and concatenates it. CSS-in-JS
// registries clear their emitted rules per call.

import { h, Fragment } from 'preact'
import type { ComponentChildren, VNode } from 'preact'
import renderToString from 'preact-render-to-string'

type InsertCallback = () => ComponentChildren

interface Holder {
  __PNEXT_SERVER_INSERTED_HTML__?: InsertCallback[]
}

const collectorKey = Symbol.for('pnext.serverInsertedHTML')
type RequestScopeGetter = () => Record<PropertyKey, unknown> | undefined
// globalThis-anchored: the prebundled server entry inlines its own copy of this module.
const SCOPE_GETTER_KEY = Symbol.for('pnext.serverInsertedHTMLScope')

export function setServerInsertedHTMLScope(getter: RequestScopeGetter): void {
  ;(globalThis as Record<PropertyKey, unknown>)[SCOPE_GETTER_KEY] = getter
}

function requestScope(): Record<PropertyKey, unknown> | undefined {
  const getter = (globalThis as Record<PropertyKey, unknown>)[SCOPE_GETTER_KEY] as
    RequestScopeGetter | undefined
  return getter?.()
}

function collector(): { callbacks: InsertCallback[]; scoped: boolean } {
  const scope = requestScope()
  if (scope) {
    return {
      callbacks: (scope[collectorKey] ??= []) as InsertCallback[],
      scoped: true,
    }
  }
  const holder = globalThis as Holder
  holder.__PNEXT_SERVER_INSERTED_HTML__ ??= []
  return { callbacks: holder.__PNEXT_SERVER_INSERTED_HTML__, scoped: false }
}

const isServer = typeof document === 'undefined'

/**
 * Register HTML to be inserted into the server-rendered document. The callback returns JSX (typically
 * one or more `<style>` elements) evaluated when the document is assembled. A client no-op - the SSR HTML
 * already carries the styles and the CSS-in-JS runtime rehydrates them itself.
 */
export function useServerInsertedHTML(callback: InsertCallback): void {
  if (!isServer) return
  collector().callbacks.push(callback)
}

/**
 * Render registered callbacks to HTML. Request-scoped callbacks remain active
 * for later stream flushes; the non-request fallback is cleared after one use.
 */
export function renderServerInsertedHTML(): string {
  const { callbacks, scoped } = collector()
  if (!scoped) (globalThis as Holder).__PNEXT_SERVER_INSERTED_HTML__ = []
  if (callbacks.length === 0) return ''

  const parts: string[] = []
  for (const callback of callbacks) {
    try {
      const node = callback()
      if (node == null || node === false) continue
      parts.push(renderToString(h(Fragment, null, node as VNode)))
    } catch {
      // A registry that throws during flush is skipped, not fatal.
    }
  }
  return parts.join('')
}

/** Discard any registered callbacks without rendering (error / reset paths). */
export function clearServerInsertedHTML(): void {
  const scope = requestScope()
  if (scope) scope[collectorKey] = []
  else (globalThis as Holder).__PNEXT_SERVER_INSERTED_HTML__ = []
}
