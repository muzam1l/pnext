import { createHash } from 'node:crypto'

/**
 * The content fingerprint a build-output asset name carries so its URL can be
 * served `immutable`. Lowercase hex keeps the emitted name inside the
 * `<name>-<hash>.<ext>` shape the client chunks and Next's own assets use.
 */
export function assetContentHash(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16)
}

/** `global.css` + bytes -> `global-1f4a9c2b3d5e6f70.css`. */
export function hashedAssetName(name: string, bytes: Uint8Array | string): string {
  const hash = assetContentHash(bytes)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? `${name}-${hash}` : `${name.slice(0, dot)}-${hash}${name.slice(dot)}`
}

/** True for a name that already carries an `assetContentHash` fingerprint. */
export function isHashedAssetName(name: string): boolean {
  return /-[0-9a-f]{16}(?:\.[^.]+)?$/.test(name)
}
