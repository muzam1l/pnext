// Root-params scan (COMPAT).
//
// A ROOT param is a dynamic segment that sits at or above a ROOT LAYOUT (a layout that renders
// `<html>`). For `app/[lang]/[locale]/layout.tsx` as the root layout, both `lang` and `locale` are root
// params. With multiple root layouts (route groups each owning their own `<html>`), the root-param set
// is per-root-layout - a name is a root param when SOME root layout has it at or above its directory.
//
// The scan drives which names `next/root-params` legitimately exports (import validation) and typegen.
// Route-group and slot dirs never contribute params; catch-all segments contribute their param name.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const LAYOUT_BASENAMES = ['layout.tsx', 'layout.ts', 'layout.jsx', 'layout.js']

/** True when a layout source renders `<html>` (i.e. it is a root/document layout). */
function isRootLayoutSource(source: string): boolean {
  return /<html[\s>]/.test(source)
}

/** Extract the param name from a segment dir name, or undefined for a static one. */
function paramNameOfSegment(segment: string): string | undefined {
  // [[...slug]] optional catch-all, [...slug] catch-all, [slug] dynamic.
  const optional = /^\[\[\.\.\.(.+)\]\]$/.exec(segment)
  if (optional) return optional[1]
  const catchAll = /^\[\.\.\.(.+)\]$/.exec(segment)
  if (catchAll) return catchAll[1]
  const dynamic = /^\[(.+)\]$/.exec(segment)
  if (dynamic) return dynamic[1]
  return undefined
}

function findLayoutFile(dir: string): string | undefined {
  for (const base of LAYOUT_BASENAMES) {
    const candidate = path.join(dir, base)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Walk `app/` collecting, for every root layout, the param names on the path
 * from app root down to (and including) that layout's directory. The union is
 * the app's root-param set.
 */
export function scanRootParams(appPath: string): Set<string> {
  const rootParams = new Set<string>()
  if (!existsSync(appPath)) return rootParams

  const walk = (dir: string, paramsAbove: string[]): void => {
    const layoutFile = findLayoutFile(dir)
    if (layoutFile) {
      let source = ''
      try {
        source = readFileSync(layoutFile, 'utf8')
      } catch {
        source = ''
      }
      if (isRootLayoutSource(source)) {
        for (const name of paramsAbove) rootParams.add(name)
      }
    }
    let children: string[] = []
    try {
      children = readdirSync(dir)
    } catch {
      return
    }
    for (const child of children) {
      const childPath = path.join(dir, child)
      let isDir = false
      try {
        isDir = statSync(childPath).isDirectory()
      } catch {
        isDir = false
      }
      if (!isDir) continue
      if (child.startsWith('@')) continue // parallel-route slot dir
      const param = paramNameOfSegment(child)
      walk(childPath, param ? [...paramsAbove, param] : paramsAbove)
    }
  }

  walk(appPath, [])
  return rootParams
}

export type RootParamValueType = 'string' | 'string[]' | 'undefined'

interface ScannedParam {
  name: string
  segment: string
}

/**
 * Per-param value types for root-params typegen, mirroring Next's collection:
 * `[name]` contributes `string`, `[...name]` contributes `string[]`,
 * `[[...name]]` contributes `string[]` and `undefined`. With multiple root
 * layouts, a param absent from some root also gains `undefined`.
 */
export function scanRootParamTypes(appPath: string): Map<string, Set<RootParamValueType>> {
  const roots: Map<string, RootParamValueType[]>[] = []
  if (!existsSync(appPath)) return new Map()

  const walk = (dir: string, paramsAbove: ScannedParam[]): void => {
    const layoutFile = findLayoutFile(dir)
    if (layoutFile) {
      let source = ''
      try {
        source = readFileSync(layoutFile, 'utf8')
      } catch {
        source = ''
      }
      if (isRootLayoutSource(source)) {
        const params = new Map<string, RootParamValueType[]>()
        for (const { name, segment } of paramsAbove) {
          params.set(
            name,
            segment.startsWith('[[...')
              ? ['string[]', 'undefined']
              : segment.startsWith('[...')
                ? ['string[]']
                : ['string'],
          )
        }
        roots.push(params)
      }
    }
    let children: string[] = []
    try {
      children = readdirSync(dir)
    } catch {
      return
    }
    for (const child of children) {
      const childPath = path.join(dir, child)
      let isDir = false
      try {
        isDir = statSync(childPath).isDirectory()
      } catch {
        isDir = false
      }
      if (!isDir) continue
      if (child.startsWith('@')) continue // parallel-route slot dir
      const param = paramNameOfSegment(child)
      walk(childPath, param ? [...paramsAbove, { name: param, segment: child }] : paramsAbove)
    }
  }

  walk(appPath, [])

  const combined = new Map<string, Set<RootParamValueType>>()
  for (const params of roots) {
    for (const [name, types] of params) {
      const set = combined.get(name) ?? new Set<RootParamValueType>()
      for (const type of types) set.add(type)
      combined.set(name, set)
    }
  }
  for (const [name, set] of combined) {
    if (roots.some(params => !params.has(name))) set.add('undefined')
  }
  return combined
}
