// ---------------------------------------------------------------------------
// `Profiler` import splitting (COMPAT). The React Compiler pass itself is core's
// (client/react-compiler.ts), driven by the client-source loader; next.config's
// `reactCompiler` flag reaches it through the compat-mode options seam.
// ---------------------------------------------------------------------------

import path from 'node:path'
import { rewriteFacts } from '../../resolve/scan-facts'
import { spliceSource } from '../../runtime/module-transform'

const profilerRuntimePath = path.join(import.meta.dirname, 'react-profiler.tsx')

/**
 * Split `Profiler` out of a `react` named import onto pnext's own Profiler
 * shim. Folded onto the module record, so the statement is
 * matched by shape rather than by a line-anchored regex.
 */
export function rewriteReactProfilerImport(source: string, file = 'module.tsx'): string {
  if (!source.includes('Profiler')) return source
  const edits: { start: number; end: number; value: string }[] = []
  for (const statement of rewriteFacts(file, source).imports) {
    if (statement.specifier !== 'react') continue
    const profilers = statement.bindings.filter(binding => binding.imported === 'Profiler')
    if (profilers.length === 0) continue

    const rest = statement.bindings.filter(binding => binding.imported !== 'Profiler')
    const named = rest.filter(binding => binding.imported !== 'default' && binding.imported !== '*')
    const other = rest.filter(binding => binding.imported === 'default' || binding.imported === '*')
    const indent = importIndent(source, statement.start)
    const clause = named.map(printBinding).join(', ')
    const prefix = other
      .map(binding => (binding.imported === '*' ? `* as ${binding.local}` : binding.local))
      .join(', ')
    const lines: string[] = []
    if (prefix && clause) lines.push(`${indent}import ${prefix}, { ${clause} } from 'react';`)
    else if (prefix) lines.push(`${indent}import ${prefix} from 'react';`)
    else if (clause) lines.push(`${indent}import { ${clause} } from 'react';`)
    for (const profiler of profilers) {
      lines.push(
        `${indent}import { Profiler as ${profiler.local} } from ${JSON.stringify(profilerRuntimePath)};`,
      )
    }
    edits.push({
      start: statement.start,
      end: statement.end,
      value: lines.join('\n').slice(indent.length),
    })
  }
  return edits.length > 0 ? spliceSource(source, edits) : source
}

function printBinding(binding: { imported: string; local: string; type: boolean }) {
  const name =
    binding.imported === binding.local ? binding.local : `${binding.imported} as ${binding.local}`
  return binding.type ? `type ${name}` : name
}

/** Leading whitespace of the statement's own line (the splice keeps the first one). */
function importIndent(source: string, start: number) {
  const lineStart = source.lastIndexOf('\n', start - 1) + 1
  const indent = source.slice(lineStart, start)
  return /^[ \t]*$/.test(indent) ? indent : ''
}

export function rewriteReactProfilerServerSource(source: string, file?: string): string {
  return rewriteReactProfilerImport(source, file)
}
