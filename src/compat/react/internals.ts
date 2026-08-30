// React publishes its shared internals as a well-known export, and packages that reach into it read
// fields at MODULE scope - `var ReactCurrentOwner = React.__SECRET_INTERNALS_….ReactCurrentOwner` in
// react-reconciler, which every custom renderer (react-konva, react-three-fiber, react-pdf, ink) pulls
// in. preact has no equivalent, so the whole import crashes with a TypeError before a single component
// renders. The shim publishes React's shape with inert slots: reads resolve, and nothing pretends to be
// driving a render (real React's slots are null outside one too).

// Field-for-field react@18.3.1 and react@19.2.8, no more: an invented field is weight in every bundle
// and a lie to whatever reads it.
export const ReactSharedInternals = {
  ReactCurrentDispatcher: { current: null },
  ReactCurrentBatchConfig: { transition: null },
  ReactCurrentOwner: { current: null },
  ReactCurrentActQueue: { current: null, isBatchingLegacy: false, didScheduleLegacyUpdate: false },
  ReactDebugCurrentFrame: { getCurrentStack: null },
}

/** React 19 renamed both the export and every field (`__CLIENT_INTERNALS_…`). */
export const ReactClientInternals = {
  H: null,
  A: null,
  T: null,
  S: null,
  actQueue: null,
  asyncTransitions: 0,
  isBatchingLegacy: false,
  didScheduleLegacyUpdate: false,
  didUsePromise: false,
  thrownErrors: [],
  getCurrentStack: null,
  recentlyCreatedOwnerStacks: 0,
}

/**
 * react-dom's own internals, under both its React 18 (`usingClientEntryPoint`/`Events`) and React 19
 * (`d`/`p`/`findDOMNode`) shapes. Named exports only: the `react`/`react-dom` shims share ONE
 * preact/compat default object, so attaching a react-dom shape to it would shadow react's. Namespace
 * and CJS-interop reads - how react-dom internals are read in practice - resolve the named export.
 */
export const ReactDOMSharedInternals = {
  usingClientEntryPoint: false,
  Events: null,
  d: {},
  p: 0,
  findDOMNode: null,
}

const REACT_18_KEY = '__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED'
const REACT_19_KEY = '__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE'

/**
 * Attach both react internals keys to a shim's default export object. preact/compat already publishes
 * a one-field `ReactCurrentDispatcher`-only object under the React 18 key and reads that dispatcher for
 * its own `readContext`, so its live slots are folded IN rather than replaced - and folded into the
 * exported object, keeping one identity for consumers that capture a slot by reference.
 */
export function attachReactInternals<Target extends object>(target: Target): Target {
  const slots = target as Record<string, Record<string, unknown> | undefined>
  if (slots[REACT_18_KEY]) Object.assign(ReactSharedInternals, slots[REACT_18_KEY])
  if (slots[REACT_19_KEY]) Object.assign(ReactClientInternals, slots[REACT_19_KEY])
  return Object.assign(target, {
    [REACT_18_KEY]: ReactSharedInternals,
    [REACT_19_KEY]: ReactClientInternals,
  })
}
