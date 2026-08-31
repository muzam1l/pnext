// Shared result types and rendering for the migrate command. Edits are what
// migrate changes on disk; report items are things the user must look at by
// hand. The body of the output is identical under --dry-run — only the header
// says whether anything was written.

import { bold, cyan, dim, green } from '../../utils/ansi'

/** Amber for warnings — ansi.ts has no yellow, so hand-roll the same shape. */
const amber = (value: string) => (process.stdout.isTTY ? `\x1b[38;5;214m${value}\x1b[39m` : value)

export interface Edit {
  file: string
  /** Short phrase joined into the file's summary line. */
  description: string
  /** Dim lines printed under the summary. */
  details?: string[]
}

export interface ReportItem {
  title: string
  detail: string
  files?: string[]
}

export interface MigrationResult {
  edits: Edit[]
  reports: ReportItem[]
  /** Files reading cookies()/headers()/draftMode() or params/searchParams synchronously (Next 14 style). */
  syncRequestApis: string[]
  /** Files importing next/font/google, which needs the `next-font` metadata package. */
  googleFontImports: string[]
}

export function emptyResult(): MigrationResult {
  return { edits: [], reports: [], syncRequestApis: [], googleFontImports: [] }
}

export function printHeader(root: string, dryRun: boolean) {
  const suffix = dryRun ? 'dry run, nothing will be written' : root
  console.log(`\n⚡ ${bold('pnext migrate')} ${dim(`— ${suffix}`)}`)
}

export function printResult(result: MigrationResult, options: { install: string }) {
  const lines: string[] = []

  lines.push(`\n${bold('Changes')}`)
  if (result.edits.length === 0) {
    lines.push(`  ${dim('nothing to change')}`)
  }
  for (const [file, edits] of groupByFile(result.edits)) {
    lines.push(
      `${green('✓')} ${bold(file)} ${dim(`— ${edits.map(edit => edit.description).join(', ')}`)}`,
    )
    for (const edit of edits) {
      for (const detail of edit.details ?? []) lines.push(`    ${dim(detail)}`)
    }
  }

  lines.push(`\n${bold('Review')}${result.reports.length > 0 ? ` (${result.reports.length})` : ''}`)
  if (result.reports.length === 0) {
    lines.push(`  ${dim('nothing flagged')}`)
  }
  for (const item of result.reports) {
    lines.push(`${amber('!')} ${bold(item.title)}`)
    lines.push(`    ${dim(item.detail)}`)
    for (const file of item.files ?? []) lines.push(`    ${dim(`· ${file}`)}`)
  }

  lines.push(`\n${bold('Next steps')}`)
  lines.push(`  1. Install the new dependencies: ${cyan(options.install)}`)
  lines.push(`  2. Start the app: ${cyan('pnext dev')}`)
  console.log(lines.join('\n'))
}

function groupByFile(edits: Edit[]) {
  const grouped = new Map<string, Edit[]>()
  for (const edit of edits) {
    const bucket = grouped.get(edit.file)
    if (bucket) bucket.push(edit)
    else grouped.set(edit.file, [edit])
  }
  return grouped
}
