import type { RouteManifestEntry } from '../types'

export function clientEntryName(route: Pick<RouteManifestEntry, 'id'>) {
  // Chunk filenames are content/identity-hashed rather than named after the
  // route (Next parity): an app route name in a JS chunk filename lets a test's
  // Playwright route interceptor (e.g. `**/search*`) accidentally capture the
  // route's own client entry and wedge navigation. Hashing the route id keeps
  // route names out of asset filenames while staying deterministic across
  // processes (build, dev, renderer, and the manifest all derive the name here).
  return route.id === 'index' ? 'pnext-client' : `pnext-client-${routeHash(route.id)}`
}

// FNV-1a 32-bit — deterministic and dependency-free (no crypto import, so this
// module stays safe wherever it is bundled). Same route id → same chunk name.
function routeHash(id: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}
