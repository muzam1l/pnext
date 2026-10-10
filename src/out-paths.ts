import path from 'node:path'

/** The release a build writes under the out root: everything a production server reads. */
export const standaloneOutSegment = 'standalone'

/** The build cache beside a release (`<outRoot>/cache`); dev keeps its own. */
export function outCachePath(outPath: string) {
  const owner = path.basename(outPath) === standaloneOutSegment ? path.dirname(outPath) : outPath
  return path.join(owner, 'cache')
}
