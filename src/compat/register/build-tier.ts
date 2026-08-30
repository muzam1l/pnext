// The build-only slice of compat registration (COMPAT - may import core freely). These five domains
// register nothing but build steps and build-complete hooks, and their extensions are read exclusively
// through getBuildExtensions() - so a dev server never touches them, yet their module graphs are the
// fattest part of the full tier. Kept behind one dynamic import so registerCompatExtensions can skip
// loading them entirely when it is only being asked to serve; the call order is unchanged either way.

export { registerBuildCompatExtensions } from './build'
export { registerTypedRoutesExtensions } from './typed-routes'
export { registerValidationExtensions } from './validation'
export { registerMiddlewareExtensions } from './middleware'
export { registerExportExtensions } from './export'
