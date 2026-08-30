import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs'
import path from 'node:path'

/**
 * Build-time app facts that let compat drop code an app cannot reach. The fact here: whether any
 * first-party source can ask for a blurred image placeholder. `placeholder="blur"` on `next/image` (or
 * getImageProps) is the only route into image/props' inline blur-SVG builder, which otherwise ships on
 * every page that uses next/image.
 *
 * The gate is one-sided by construction: every unreadable case answers "yes". A wrong "no" would render
 * a blurred placeholder server-side that the client does not, which is a hydration mismatch.
 */

/** Skipped wholesale: not first-party source, or build output. */
const skipDirs = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'public', 'target'])
const sourceFile = /\.(?:[cm]?[jt]sx?|mdx)$/

/** Only these APIs reach the branch, so only files naming one can matter. */
const imageApi = /next\/(?:legacy\/)?image|getImageProps|unstable_getImgProps/

/** A literal `placeholder="blur"`, in JSX-prop or object-property form. */
const literalBlur = /\bplaceholder\s*[=:]\s*\{?\s*['"`]blur['"`]/

/**
 * A `placeholder` whose value is not a string literal — `placeholder={value}`,
 * `placeholder: value`. Unreadable from source text, so it counts as usage.
 */
const opaquePlaceholder = /\bplaceholder\s*[=:]\s*(?!\{?\s*['"`])/

/**
 * Props reaching the image from somewhere this scan cannot see: a spread into
 * any element in an image-using file, or a re-export that lets another file
 * render `<Image>` without ever naming `next/image`.
 */
const opaqueProps = /\{\s*\.\.\.|export\s[^;]*from\s*['"]next\/(?:legacy\/)?image/

const cache = new Map<string, boolean>()

/**
 * Roots to scan: the app, plus the workspace's own packages when the app sits in one - a linked
 * `@scope/ui` is first-party source that compiles into the same client graph, so a `placeholder="blur"`
 * there must be seen.
 */
function scanRoots(root: string) {
  const roots = [root]
  for (let dir = path.dirname(root); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (
      !existsSync(path.join(dir, 'pnpm-workspace.yaml')) &&
      !existsSync(path.join(dir, 'lerna.json'))
    ) {
      continue
    }
    const packages = path.join(dir, 'packages')
    if (existsSync(packages)) roots.push(packages)
    break
  }
  return roots
}

export function appUsesBlurPlaceholder(root: string) {
  const cached = cache.get(root)
  if (cached !== undefined) return cached
  const used = scanFirstPartySource(root, blurSource)
  cache.set(root, used)
  return used
}

function blurSource(source: string): boolean {
  // The common case is one `test` and out: almost no file in an app names an
  // image API, and only those that do pay for the rest.
  if (!imageApi.test(source)) return false
  return literalBlur.test(source) || opaquePlaceholder.test(source) || opaqueProps.test(source)
}

/** Walk the app's first-party source (plus workspace packages) until `match`. */
export function scanFirstPartySource(root: string, match: (source: string) => boolean): boolean {
  return scanRoots(root).some(dir => scan(dir, match))
}

function scan(dir: string, match: (source: string) => boolean): boolean {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue
      if (scan(file, match)) return true
      continue
    }
    if (!sourceFile.test(entry.name)) continue
    let source: string
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (match(source)) return true
  }
  return false
}

/**
 * Build-time app fact: can any first-party source render `<Link legacyBehavior>`? The legacy child path
 * (child validation, the deprecation notice, the server/lazy child diagnostics, cloneElement) is a
 * meaningful slice of `next/link`, and next/link is initial on every page that links anywhere.
 *
 * One-sided like the blur gate: every unreadable case answers "yes". A wrong "no" renders the legacy
 * child shape on the server and a plain anchor on the client - a hydration mismatch. The scan sees the
 * app and its workspace packages, not registry dependencies.
 */
const legacyProp = /\blegacyBehavior\b/

/** A Link re-exported from here can be rendered by a file this scan can't tie
 * back to `next/link`, so treat the re-export itself as usage. */
const reexportedLink = /export\s[^;]*from\s*['"]next\/link['"]/

const legacyLinkCache = new Map<string, boolean>()

export function appUsesLegacyLink(root: string) {
  const cached = legacyLinkCache.get(root)
  if (cached !== undefined) return cached
  const used = scanFirstPartySource(
    root,
    source => legacyProp.test(source) || reexportedLink.test(source),
  )
  legacyLinkCache.set(root, used)
  return used
}
