import { realpathSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { rewriteFacts } from '../../resolve/scan-facts'
import { spliceSource } from '../../runtime/module-transform'

export function sourceHasImportMetaUrl(source: string) {
  return source.includes('import.meta.url')
}

/**
 * Inline `import.meta.url` as the module's own file URL. Folded onto the module
 * record's `importMetas` spans: exact by construction, where
 * the regex also fired inside strings and comments.
 */
export function rewriteImportMetaUrlSource(source: string, file: string) {
  if (!sourceHasImportMetaUrl(source)) return source
  const facts = rewriteFacts(file, source)
  if (facts.unreliable) return legacyRewriteImportMetaUrl(source, file)
  const edits = facts.importMetas
    .filter(meta => /^\.url\b/.test(source.slice(meta.end, meta.end + 5)))
    .map(meta => ({
      start: meta.start,
      end: meta.end + 4,
      value: JSON.stringify(pathToFileURL(virtualFixturePath(realSourcePath(file))).href),
    }))
  return edits.length > 0 ? spliceSource(source, edits) : source
}

// A source oxc could only partially recover keeps the textual pass: an
// incomplete record would silently under-rewrite.
function legacyRewriteImportMetaUrl(source: string, file: string) {
  return source.replace(
    /\bimport\.meta\.url\b/g,
    JSON.stringify(pathToFileURL(virtualFixturePath(realSourcePath(file))).href),
  )
}

// Modules can reach the bundler through the pages-compat mirror's source-app/
// source-pages symlinks; inlining that symlinked path breaks code that walks
// the filesystem relative to import.meta.url (Next inlines the real path).
function realSourcePath(file: string) {
  try {
    return realpathSync(file)
  } catch {
    return file
  }
}

function virtualFixturePath(file: string) {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const root = process.env.PNEXT_IMPORT_META_URL_FIXTURE_ROOT
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const virtualRoot = process.env.PNEXT_IMPORT_META_URL_VIRTUAL_ROOT
  if (!root || !virtualRoot) return file
  const relative = path.relative(root, file)
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..'
    ? path.join(virtualRoot, relative)
    : file
}
