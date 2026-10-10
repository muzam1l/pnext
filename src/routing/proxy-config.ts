/** The proxy's literal `config` read off its source: build and dev only, a release carries it. */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { ResolvedConfig } from '../config'
import { loadNative } from '../utils/native-require'
import { findProxyFile, type ProxyConfig } from './proxy'

// Lazy: the oxc-parser native binding costs ~12.6 MB RSS; load it only when a parse happens.
const parseSync: typeof import('oxc-parser').parseSync = (...args) =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  loadNative(() => require('oxc-parser') as typeof import('oxc-parser')).parseSync(...args)

/** The proxy a production release serves: its source and, when wholly literal, its matcher config. */
export function releasedProxy(config: ResolvedConfig) {
  const file = findProxyFile(config)
  if (!file) return undefined
  try {
    return { file, config: staticProxyConfig(file, readFileSync(file, 'utf8')) }
  } catch {
    return { file }
  }
}

export function staticProxyConfig(file: string, source: string): ProxyConfig | undefined {
  const result = parseSync(file, source, { lang: parserLang(file) })
  // A recovered parse may have dropped the very declaration we are reading.
  if (result.errors.length > 0) return undefined
  for (const statement of result.program.body as StaticNode[]) {
    if (statement.type !== 'ExportNamedDeclaration') continue
    const declaration = statement.declaration
    if (declaration?.type !== 'VariableDeclaration') continue
    for (const declarator of declaration.declarations ?? []) {
      if (declarator.id?.type !== 'Identifier' || declarator.id.name !== 'config') continue
      const value = staticValue(declarator.init)
      return isProxyConfigShape(value) ? (value as ProxyConfig) : undefined
    }
  }
  return undefined
}

function parserLang(file: string) {
  const ext = path.extname(file)
  if (ext === '.tsx') return 'tsx'
  if (ext === '.jsx') return 'jsx'
  return ext === '.js' || ext === '.mjs' ? 'js' : 'ts'
}

/** Structural view of the oxc AST nodes this file reads — no full type import. */
interface StaticNode {
  type: string
  name?: string
  value?: unknown
  computed?: boolean
  shorthand?: boolean
  key?: StaticNode
  init?: StaticNode
  id?: StaticNode
  declaration?: StaticNode
  declarations?: StaticNode[]
  expression?: StaticNode
  properties?: StaticNode[]
  elements?: (StaticNode | null)[]
  expressions?: StaticNode[]
  quasis?: { value?: { cooked?: string } }[]
}

/** Literal-only evaluation; `undefined` marks "not statically known". */
function staticValue(node: StaticNode | undefined | null): unknown {
  if (!node) return undefined
  switch (node.type) {
    // `… as const` / `… satisfies ProxyConfig` wrap the literal, they never change it.
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
      return staticValue(node.expression)
    case 'Literal':
    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
      // A regex literal reports `value: null` here; it is not a matcher shape.
      return node.value === null ? undefined : node.value
    case 'TemplateLiteral':
      return node.expressions?.length === 0
        ? (node.quasis?.[0]?.value?.cooked ?? undefined)
        : undefined
    case 'ArrayExpression': {
      const items: unknown[] = []
      for (const element of node.elements ?? []) {
        const value = staticValue(element)
        if (value === undefined) return undefined
        items.push(value)
      }
      return items
    }
    case 'ObjectExpression': {
      const object: Record<string, unknown> = {}
      for (const property of node.properties ?? []) {
        if (property.type !== 'Property' && property.type !== 'ObjectProperty') return undefined
        if (property.computed) return undefined
        const key =
          property.key?.type === 'Identifier' ? property.key.name : (property.key?.value as string)
        if (typeof key !== 'string') return undefined
        const value = staticValue(property.value as StaticNode | undefined)
        if (value === undefined) return undefined
        object[key] = value
      }
      return object
    }
    default:
      return undefined
  }
}

/** Only a config whose `matcher` is exactly the documented shape may gate. */
function isProxyConfigShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const matcher = (value as { matcher?: unknown }).matcher
  if (matcher === undefined) return true
  const items = Array.isArray(matcher) ? matcher : [matcher]
  return items.every(item => {
    if (typeof item === 'string') return true
    if (typeof item !== 'object' || item === null) return false
    const { source, has, missing } = item as Record<string, unknown>
    if (typeof source !== 'string') return false
    return [has, missing].every(
      list => list === undefined || (Array.isArray(list) && list.every(isConditionShape)),
    )
  })
}

function isConditionShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const { type, key, value: expected } = value as Record<string, unknown>
  if (type !== 'header' && type !== 'query' && type !== 'cookie' && type !== 'host') return false
  if (key !== undefined && typeof key !== 'string') return false
  return expected === undefined || typeof expected === 'string'
}
