// Stale ESM registry generations - the accounting behind dev's recycle trigger. Compiled server
// artifacts are content-graph-named, so every save that changes a module gives it a NEW href and
// the server imports that; Bun's registry has no eviction API, so the previous href stays linked
// for the process lifetime.
//
// Counting them needs no registry walk: an artifact goes stale exactly when its (profile, source)
// pair is renamed to a different artifact, and it only costs memory if it was ever imported. Both
// facts are known at the two call sites below, so the count is an O(1) side effect of compiling.
import { fileURLToPath } from 'node:url'

/** Current artifact per `${profile}:${file}`. */
const liveNames = new Map<string, string>()
/** Artifacts that actually entered the ES module registry. */
const imported = new Set<string>()
let stale = 0

/** Record that `outFile` is now the artifact for `key` (`${profile}:${file}`). */
export function noteModuleGeneration(key: string, outFile: string) {
  const previous = liveNames.get(key)
  if (previous !== outFile) {
    liveNames.set(key, outFile)
    // Only a generation the registry actually holds costs memory; one that was
    // compiled and superseded before any import cost disk alone.
    if (previous !== undefined && imported.delete(previous)) stale += 1
  }
}

/** Record that `href` was imported, so superseding it will count as stale. */
export function noteModuleImported(href: string) {
  // Named as a path on the compile side, imported as an href: normalise through
  // the same URL codec both sides use, or every entry would look never-imported.
  imported.add(href.startsWith('file:') ? fileURLToPath(href) : href)
}

/** Live and superseded registry generations of compiled server modules. */
export function moduleGenerationStats() {
  return { live: imported.size, stale }
}
