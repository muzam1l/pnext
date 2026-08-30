import { dynamicCallFacts, rewriteFacts, type DynamicCallFact } from './scan-facts'

export interface DynamicCall {
  index: number
  name: string
  open: number
  close: number
  source: string
}

/** Cheap gate: a `dynamic` binding can only come from one of these specifiers. */
export function sourceHasDynamicImport(source: string) {
  return source.includes('@wular/pnext') || source.includes('next/dynamic')
}

/**
 * Local names bound to `dynamic()`. The import edge is module-record-shaped and
 * comes off the memoized parse; only the call-site
 * scanning below stays textual.
 */
export function pnextDynamicImportNames(source: string, file = 'module.tsx') {
  const names = new Set<string>()
  if (!sourceHasDynamicImport(source)) return names
  for (const statement of rewriteFacts(file, source).imports) {
    const { specifier } = statement
    const pnext = specifier === '@wular/pnext' || specifier === '@wular/pnext/dynamic'
    // The compat alias rewrite may already have turned `next/dynamic` into the
    // shim's own file path/href before this scan runs.
    const nextDynamic =
      specifier === 'next/dynamic' || /compat\/next\/dynamic(?:\.tsx)?$/.test(specifier)
    if (!pnext && !nextDynamic) continue
    for (const binding of statement.bindings) {
      if (binding.type) continue
      if (pnext ? binding.imported === 'dynamic' : binding.imported === 'default') {
        names.add(binding.local)
      }
    }
  }
  return names
}

export function dynamicCallsFromSource(source: string, dynamicNames: Set<string>) {
  const calls: DynamicCall[] = []
  if (dynamicNames.size === 0) return calls

  let index = 0

  while ((index = nextDynamicCallIndex(source, dynamicNames, index)) !== -1) {
    const name = dynamicNameAt(source, dynamicNames, index)
    if (!name) {
      index += 1
      continue
    }
    const before = source[index - 1]
    const after = source[index + name.length]
    if ((before && /[\w$]/.test(before)) || (after && /[\w$]/.test(after))) {
      index += name.length
      continue
    }

    const open = source.indexOf('(', index + name.length)
    if (open === -1 || source.slice(index + name.length, open).trim()) {
      index += name.length
      continue
    }

    const close = matchingParen(source, open)
    if (close === -1) {
      index = open + 1
      continue
    }

    calls.push({
      index,
      name,
      open,
      close,
      source: source.slice(index, close + 1),
    })
    index = close + 1
  }

  return calls
}

export function rewriteLiteralDynamicCalls(source: string, file?: string) {
  const dynamicNames = pnextDynamicImportNames(source, file)
  if (dynamicNames.size === 0) return source
  const facts = dynamicCallFacts(source, file)

  const edits: { start: number; end: number; value: string }[] = []
  for (const call of dynamicCallsFromSource(source, dynamicNames)) {
    const fact = factForCall(facts, call)
    if (!fact?.literal) continue
    edits.push({
      start: fact.specifierStart,
      end: fact.specifierEnd,
      value: `() => import(${source.slice(fact.specifierStart, fact.specifierEnd)})`,
    })
  }

  if (edits.length === 0) return source

  let next = source
  for (const edit of edits.reverse()) {
    next = `${next.slice(0, edit.start)}${edit.value}${next.slice(edit.end)}`
  }
  return next
}

// Server compiles append the statically-resolved import target as a third
// dynamic() argument, so the renderer can match the call to its scanned client
// reference without importing the module. Instance identity is useless for
// that match: dev route bundles, per-module compiles, and the client-SSR
// profile each produce their own copy of the target module.
export function rewriteDynamicCallTargets(
  source: string,
  resolve: (specifier: string) => string | undefined,
  file?: string,
) {
  const dynamicNames = pnextDynamicImportNames(source, file)
  if (dynamicNames.size === 0) return source
  const facts = dynamicCallFacts(source, file)

  const edits: { at: number; value: string }[] = []
  for (const call of dynamicCallsFromSource(source, dynamicNames)) {
    const target = loaderImportTargetForCall(call, facts)
    if (!target) continue
    const file = resolve(target.specifier)
    if (!file) continue

    const args = source.slice(call.open + 1, call.close)
    const argCount = topLevelArgCount(args)
    if (argCount < 1 || argCount > 2) continue
    const literal = JSON.stringify({ file, exportName: target.exportName })
    const separator = /,\s*$/.test(args) ? '' : ', '
    edits.push({
      at: call.close,
      value: `${separator}${argCount === 1 ? 'undefined, ' : ''}${literal}`,
    })
  }

  if (edits.length === 0) return source

  let next = source
  for (const edit of edits.reverse()) {
    next = `${next.slice(0, edit.at)}${edit.value}${next.slice(edit.at)}`
  }
  return next
}

function factForCall(facts: DynamicCallFact[], call: DynamicCall) {
  return facts.find(fact => fact.start === call.index)
}

/**
 * The statically-extractable import behind one dynamic() call — the AST fact
 * alone; a call the scan could not analyze yields no detection. Literal-loader
 * calls (`dynamic('./x')`) answer undefined — they carry no `import()` yet.
 */
function loaderImportTargetForCall(call: DynamicCall, facts: DynamicCallFact[]) {
  const fact = factForCall(facts, call)
  return fact && !fact.literal ? fact : undefined
}

/** Dev split of `dynamic(ssr:false)` targets; `PNEXT_DYNAMIC_SPLIT=0` restores eager builds. */
export function devDynamicSplitEnabled() {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  return process.env.PNEXT_DYNAMIC_SPLIT !== '0'
}

/**
 * Rewrite each deferred dynamic() import in a CLIENT-BUILD source to the served
 * chunk URL `href` names, so the entry build never bundles the target's graph.
 * Callers register the (file, exportName) behind each URL as `href` is asked.
 */
export function rewriteDeferredDynamicImports(
  source: string,
  file: string | undefined,
  resolve: (specifier: string) => string | undefined,
  href: (target: { file: string; exportName: string }) => string | undefined,
) {
  const dynamicNames = pnextDynamicImportNames(source, file)
  if (dynamicNames.size === 0) return source
  const deferred = deferredDynamicImportSpecifiers(source, file)
  if (deferred.size === 0) return source
  const facts = dynamicCallFacts(source, file)

  const edits: { start: number; end: number; value: string }[] = []
  for (const call of dynamicCallsFromSource(source, dynamicNames)) {
    const target = loaderImportTargetForCall(call, facts)
    if (!target || !deferred.has(target.specifier)) continue
    const resolved = resolve(target.specifier)
    if (!resolved) continue
    const url = href({ file: resolved, exportName: target.exportName })
    if (!url) continue
    edits.push({ start: target.specifierStart + 1, end: target.specifierEnd - 1, value: url })
  }
  if (edits.length === 0) return source
  let next = source
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    next = `${next.slice(0, edit.start)}${edit.value}${next.slice(edit.end)}`
  }
  return next
}

/**
 * Import specifiers of `dynamic()` calls the SSR layer never executes (`ssr: false`, or `load: 'visible'`
 * without `ssr: true`) - the dev split points: their target modules compile on browser demand, not eagerly.
 */
export function deferredDynamicImportSpecifiers(source: string, file?: string) {
  const deferred = new Set<string>()
  const dynamicNames = pnextDynamicImportNames(source, file)
  if (dynamicNames.size === 0) return deferred

  // `const opts = { ssr: false }` option objects referenced by name.
  const optionConsts = new Map<string, string>()
  const constPattern = /const\s+([A-Za-z_$][\w$]*)\s*=\s*({[\s\S]*?})\s*(?:as\s+const\s*)?;/g
  let constMatch: RegExpExecArray | null
  while ((constMatch = constPattern.exec(source))) {
    if (constMatch[1] && constMatch[2]) optionConsts.set(constMatch[1], constMatch[2])
  }

  const facts = dynamicCallFacts(source, file)
  for (const call of dynamicCallsFromSource(source, dynamicNames)) {
    const target = loaderImportTargetForCall(call, facts)
    if (!target) continue
    // Token scan over the call plus any named option consts it references —
    // tolerant of the compile-appended target argument (rewriteDynamicCallTargets).
    const tail = source.slice(target.loaderEnd, call.close)
    let options = tail
    for (const identifier of tail.match(/[A-Za-z_$][\w$]*/g) ?? []) {
      const named = optionConsts.get(identifier)
      if (named) options += `\n${named}`
    }
    const ssrFalse = /\bssr\s*:\s*false\b/.test(options)
    const visible =
      /\bload\s*:\s*['"]visible['"]/.test(options) && !/\bssr\s*:\s*true\b/.test(options)
    if (ssrFalse || visible) deferred.add(target.specifier)
  }
  return deferred
}

function topLevelArgCount(args: string) {
  let count = 0
  let depth = 0
  let quote: string | null = null
  let sawArg = false

  for (let index = 0; index < args.length; index += 1) {
    const char = args[index]
    if (quote) {
      if (char === quote && args[index - 1] !== '\\') quote = null
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      sawArg = true
      continue
    }
    if (char === '(' || char === '[' || char === '{') depth += 1
    if (char === ')' || char === ']' || char === '}') depth -= 1
    if (char === ',' && depth === 0) {
      if (sawArg) count += 1
      sawArg = false
      continue
    }
    if (!/\s/.test(char ?? '')) sawArg = true
  }

  return sawArg ? count + 1 : count
}

function matchingParen(source: string, open: number) {
  let depth = 0
  let quote: string | null = null

  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    const previous = source[index - 1]

    if (quote) {
      if (char === quote && previous !== '\\') quote = null
      continue
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }

    if (char === '(') depth += 1
    if (char === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }

  return -1
}

function nextDynamicCallIndex(source: string, dynamicNames: Set<string>, fromIndex: number) {
  let next = -1
  for (const name of dynamicNames) {
    const index = source.indexOf(name, fromIndex)
    if (index !== -1 && (next === -1 || index < next)) next = index
  }
  return next
}

function dynamicNameAt(source: string, dynamicNames: Set<string>, index: number) {
  for (const name of dynamicNames) {
    if (source.startsWith(name, index)) return name
  }
  return undefined
}
