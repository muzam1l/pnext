import { createHash } from 'node:crypto'
import path from 'node:path'

/**
 * Every file this process stubbed as a client reference. The route manifest only records what the
 * scan attributes to a route, so a `'use client'` module inside a dependency - which only the vendor
 * pass sees, the package entry carrying no directive - is missing from it.
 */
const compiledClientReferences = new Set<string>()

/** @internal */
export function noteCompiledClientReference(file: string) {
  compiledClientReferences.add(path.resolve(file))
}

/** @internal Read by the vercel adapter's warm pass, so it compiles these before the deploy. */
export function compiledClientReferenceFiles(): ReadonlySet<string> {
  return compiledClientReferences
}

export interface ClientReference {
  id: string
  file: string
  exportName: string
  dynamic?: ClientDynamicReference
  cssImports?: string[]
  /**
   * A `'use client'` module imported only for its side effects (a bare
   * `import './client-only'` with no bindings). It is never rendered as a
   * component, but webpack eagerly initializes every client reference module in
   * a route's bundle once any of them renders, so pnext bundles it into the
   * client entry (a bare side-effect import) to run its top-level code. It has
   * no SSR component, so it is excluded from every server-side marking pass.
   */
  sideEffect?: boolean
}

export interface ClientDynamicReference {
  load?: 'render' | 'visible'
  rootMargin?: string
  ssr?: boolean
  threshold?: number | number[]
}

export const clientReferenceSymbol = Symbol.for('pnext.clientReference')

export type ClientComponent = ((props: Record<string, unknown>) => unknown) & {
  [clientReferenceSymbol]?: ClientReference
}

export function clientReferenceId(file: string, exportName: string) {
  return createHash('sha256')
    .update(file)
    .update('\0')
    .update(exportName)
    .digest('hex')
    .slice(0, 10)
}

export function ssrClientReference(reference: Pick<ClientReference, 'dynamic' | 'sideEffect'>) {
  if (reference.sideEffect) return false
  if (reference.dynamic?.ssr === false) return false
  if (reference.dynamic?.load === 'visible' && reference.dynamic.ssr !== true) return false
  return true
}
