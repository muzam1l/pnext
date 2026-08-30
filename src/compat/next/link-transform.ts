// Legacy `<Link legacyBehavior>` child validation (COMPAT): annotate the single child of a Link-shaped
// element with what it is (a server sync/async component, a lazy one), so the runtime can report Next's
// legacy-behavior errors.
//
// Folded off `typescript` onto oxc: the old path required the typescript package on first fire, a
// build-time-only dependency that also shipped into the deployed function. The gate is
// module-record-shaped (does this file import next/link at all), so the AST is only ever materialized
// for a file that really uses one.
// Lazy: the oxc-parser native binding costs ~12.6 MB RSS; load it only when a parse happens.
const parseSync: typeof import('oxc-parser').parseSync = (...args) =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  loadNative(() => require('oxc-parser') as typeof import('oxc-parser')).parseSync(...args)
import { loadNative } from '../../utils/native-require'
import { rewriteFacts } from '../../resolve/scan-facts'

const marker = '__pnextLegacyChildKind'

interface Node {
  type: string
  start: number
  end: number
  [key: string]: unknown
}

interface JsxName {
  type: string
  name?: string
  start: number
  end: number
}

interface JsxOpeningElement extends Node {
  name: JsxName
  attributes: Node[]
  selfClosing: boolean
}

interface JsxElement extends Node {
  openingElement: JsxOpeningElement
  children: Node[]
  closingElement: Node | null
}

export function rewriteLegacyLinkValidation(source: string, file: string): string {
  if (!source.includes('Link') && !source.includes('legacyBehavior')) return source
  const imports = rewriteFacts(file, source).imports
  const directLink =
    imports.some(statement => statement.specifier === 'next/link') &&
    source.includes('legacyBehavior')
  const asyncLinkWrapper =
    imports.some(statement =>
      statement.bindings.some(binding => !binding.type && binding.local.endsWith('Link')),
    ) &&
    /<[A-Za-z_$][\w$]*Link\b/.test(source) &&
    /\basync\s+function\b/.test(source)
  if (!directLink && !asyncLinkWrapper) return source

  const program = parseSync(file, source, { lang: langForFile(file) }).program as unknown as {
    body: Node[]
  }
  const linkNames = new Set<string>()
  const asyncNames = new Set<string>()
  const functionNames = new Set<string>()
  const lazyNames = new Set<string>()
  const edits: { at: number; text: string }[] = []
  const isClient = program.body.some(
    statement => statement.type === 'ExpressionStatement' && statement.directive === 'use client',
  )

  for (const statement of program.body) {
    if (statement.type === 'ImportDeclaration' && sourceValue(statement) === 'next/link') {
      for (const specifier of (statement.specifiers as Node[] | undefined) ?? []) {
        const local = identifierName(specifier.local)
        if (!local) continue
        if (specifier.type === 'ImportDefaultSpecifier') linkNames.add(local)
        else if (identifierName(specifier.imported) === 'Link') linkNames.add(local)
      }
    }
    if (statement.type === 'FunctionDeclaration') {
      const name = identifierName(statement.id)
      if (name) {
        functionNames.add(name)
        if (statement.async === true) asyncNames.add(name)
      }
    }
    if (statement.type === 'VariableDeclaration') {
      for (const declarator of (statement.declarations as Node[] | undefined) ?? []) {
        const name = identifierName(declarator.id)
        const init = declarator.init as Node | null
        if (!name || !init) continue
        if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
          functionNames.add(name)
          if (init.async === true) asyncNames.add(name)
        }
        if (isLazyCall(init)) lazyNames.add(name)
      }
    }
  }

  // Only elements with a body can have the single child this annotates.
  walk(program.body, node => {
    if (node.type !== 'JSXElement') return
    const element = node as unknown as JsxElement
    if (element.closingElement === null) return
    annotate(element)
  })

  function annotate(element: JsxElement): void {
    const opening = element.openingElement
    if (opening.name.type !== 'JSXIdentifier' || hasMarker(opening)) return
    const parent = opening.name.name ?? ''
    const isLink = linkNames.has(parent)
    if (!isLink && !parent.endsWith('Link')) return
    const children = element.children.filter(isMeaningfulChild)
    if (children.length !== 1) return
    const kind = childKind(children[0]!)
    if (!kind || (!isLink && kind !== 'server-async')) return
    const annotatedKind = !isLink
      ? 'server-async-through-client'
      : isClient && kind === 'lazy'
        ? 'client-lazy'
        : kind
    edits.push({ at: opening.name.end, text: ` ${marker}="${annotatedKind}"` })
  }

  function childKind(child: Node): 'server-sync' | 'server-async' | 'lazy' | undefined {
    let name: string | undefined
    if (child.type === 'JSXElement') {
      const opening = (child as unknown as JsxElement).openingElement
      if (opening.name.type === 'JSXIdentifier') name = opening.name.name
    } else if (child.type === 'JSXExpressionContainer') {
      const expression = child.expression as Node | undefined
      if (expression?.type === 'Identifier') name = expression.name as string
    }
    if (!name) return undefined
    if (lazyNames.has(name)) return 'lazy'
    if (asyncNames.has(name)) return 'server-async'
    if (!isClient && functionNames.has(name)) return 'server-sync'
    return undefined
  }

  if (edits.length === 0) return source
  let output = source
  for (const edit of edits.sort((a, b) => b.at - a.at)) {
    output = output.slice(0, edit.at) + edit.text + output.slice(edit.at)
  }
  return output
}

function isMeaningfulChild(child: Node): boolean {
  if (child.type === 'JSXText') {
    return typeof child.value === 'string' && child.value.trim().length > 0
  }
  if (child.type === 'JSXExpressionContainer') {
    return (child.expression as Node | undefined)?.type !== 'JSXEmptyExpression'
  }
  return true
}

function hasMarker(opening: JsxOpeningElement): boolean {
  return opening.attributes.some(
    attribute =>
      attribute.type === 'JSXAttribute' && (attribute.name as JsxName | undefined)?.name === marker,
  )
}

function isLazyCall(expression: Node): boolean {
  if (expression.type !== 'CallExpression') return false
  const callee = expression.callee as Node | undefined
  if (!callee) return false
  if (callee.type === 'Identifier') return callee.name === 'lazy'
  return callee.type === 'MemberExpression' && identifierName(callee.property) === 'lazy'
}

function identifierName(node: unknown): string | undefined {
  const named = node as { type?: string; name?: unknown } | null | undefined
  return typeof named?.name === 'string' ? named.name : undefined
}

function sourceValue(statement: Node): string | undefined {
  const literal = statement.source as { value?: unknown } | undefined
  return typeof literal?.value === 'string' ? literal.value : undefined
}

/** Depth-first over every AST node — this only runs for a file that uses Link. */
function walk(node: unknown, visit: (node: Node) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit)
    return
  }
  if (!node || typeof node !== 'object') return
  const candidate = node as Node
  if (typeof candidate.type === 'string') visit(candidate)
  for (const key in candidate) {
    if (key !== 'type') walk(candidate[key], visit)
  }
}

// `.ts` forbids JSX (`<T>value` is a type assertion); everything else parses as
// the tsx superset, matching the scan-facts language rule.
function langForFile(file: string): 'ts' | 'tsx' {
  return /\.[cm]?ts$/.test(file) ? 'ts' : 'tsx'
}
