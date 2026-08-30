import path from 'node:path'
import type { ClientReference } from './reference'
import { ISLAND_STATIC_CHILDREN_ATTRIBUTE } from '../render/static-children'
import {
  ISLAND_BOUNDARY_ERROR_DIGEST_ATTRIBUTE,
  ISLAND_BOUNDARY_ERROR_ELEMENT,
  ISLAND_BOUNDARY_ERROR_MESSAGE_ATTRIBUTE,
} from '../render/boundary-error'

interface ClientEntryOptions {
  pageFile?: string
  clientReferences: ClientReference[]
  nextCompat?: boolean
  /** See ClientRuntimeFacts.suspense; false drops the Suspense island wrapper (and preact/compat). */
  suspense?: boolean
  /**
   * The app reaches a server action anywhere (build's action manifest, or a route whose scan
   * recorded the `actions`/`form` client-entry reason). The whole action client runtime - RPC wire,
   * form interception, prop revival, error overlay - is emitted only then.
   */
  actions?: boolean
  /** Route's nearest error.* file: rendered as the action-error overlay (compat). */
  errorFile?: string
  /** Route's nearest not-found.* file: rendered for client-side notFound(). */
  notFoundFile?: string
  /**
   * A `'use client'` module in the route graph throws notFound()/forbidden()/
   * unauthorized(). The boundary then has something to render (its built-in
   * 404) even with no not-found.* file, so it must ship for this route.
   */
  controlFlow?: boolean
  /**
   * App-root global-error.* file (compat): passed to installClientErrors as the
   * globalErrorComponent so a user global-error mounts for client throws that
   * escape every route error boundary. Threaded by client/build.ts; consumed by
   * routerImportSource + mountLifecycleSource (the mount section owns the wiring).
   */
  globalErrorFile?: string
  /**
   * The route's root layout is itself a `'use client'` component. Only then does the whole document
   * body need re-rendering through that layout at hydration (the client-shell path, which adopts each
   * parallel-route slot's SSR DOM as a named prop). When the root layout is a server component its
   * client references are ordinary nested/slot islands that mount into their own containers, and
   * building a shell would wrongly remount the body under one of those islands.
   */
  clientRootLayout?: boolean
  /**
   * Some file in this route's closure can reach a soft navigation (a Link, a navigation hook, compat
   * parity). False means no click on this page can ever start one, so the entry ships no router.
   */
  router?: boolean
  /**
   * Layout files outermost-first; the shell nests in this order because
   * `clientReferences` is path-hash sorted (see build.ts shellLayoutOrder).
   */
  shellLayoutOrder?: string[]
  /**
   * Dev split: the served URL a deferred dynamic reference loads from instead
   * of bundling its target into this entry: the dev split emits that reference as
   * its own entry point of the same build (see buildClientEntry).
   */
  deferredDynamicHref?: (reference: ClientReference) => string | undefined
}

// The soft-navigation runtime is bundled into every entry from this source
// file; esbuild resolves the absolute path, so entries share the module (and
// its prefetch/navigation state) through the common chunk graph.
function routerModulePath() {
  return path.join(import.meta.dirname, './router/index.ts')
}

// Server-action client runtime lives in the compat layer (only ever imported
// into an entry when Next compat is on — see routerImportSource). entry.ts is
// core but emits these as generated import strings, gated on nextCompat, so
// core carries no static import of compat.
function actionRouterModulePath() {
  return path.join(import.meta.dirname, '../compat/actions/router.ts')
}

function actionClientModulePath() {
  return path.join(import.meta.dirname, '../compat/actions/client.ts')
}

function navCompatModulePath() {
  return path.join(import.meta.dirname, '../compat/client/nav.ts')
}

function islandContextModulePath() {
  return path.join(import.meta.dirname, '../render/island-context.ts')
}

// Wire-marker revival shared with the server encoder (utils/serialize.ts):
// island props carrying a CYCLE travel as `$$pnext_ref` back-references.
function staticSlotsModulePath() {
  // The preact-free half: entries import it eagerly, so it must not drag preact into a
  // visible-dynamic entry's static graph.
  return path.join(import.meta.dirname, '../render/static-slots-revive.ts')
}

function serializeModulePath() {
  return path.join(import.meta.dirname, '../utils/serialize.ts')
}

// Re-provide the per-island layout-segment snapshot (stamped by the renderer as
// `data-pnext-layout-segments`) around a hydrated island so compat's
// useSelectedLayoutSegment(s) recomputes live from the layout depth. Emitted
// only under next compat (the hooks are compat-only); a no-op wrapper otherwise.
function layoutSegmentHelperSource(nextCompat?: boolean) {
  if (!nextCompat) return ''
  return `
import { LayoutSegmentContext as __PNextLayoutSegmentContext, RouteParamsContext as __PNextRouteParamsContext } from ${JSON.stringify(islandContextModulePath())};
function pnextIslandReadJson(root, attr) {
  const raw = root && root.getAttribute ? root.getAttribute(attr) : null;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
function pnextIslandVNode(h, Component, props, children, root) {
  // An explicit undefined children argument clobbers props.children in
  // preact's createElement; plain children travel inside the parsed props.
  let vnode = children !== undefined ? h(Component, props, children) : h(Component, props);
  const segments = pnextIslandReadJson(root, 'data-pnext-layout-segments');
  if (segments) vnode = h(__PNextLayoutSegmentContext.Provider, { value: segments }, vnode);
  const params = pnextIslandReadJson(root, 'data-pnext-params');
  if (params) vnode = h(__PNextRouteParamsContext.Provider, { value: params }, vnode);
  return vnode;
}
`
}

function islandVNodeExpr(
  componentExpr: string,
  propsExpr: string,
  childrenExpr: string,
  rootExpr: string,
  nextCompat?: boolean,
) {
  return nextCompat
    ? `pnextIslandVNode(h, ${componentExpr}, ${propsExpr}, ${childrenExpr}, ${rootExpr})`
    : `h(${componentExpr}, ${propsExpr}, ${childrenExpr})`
}

/**
 * A streamed Suspense hole is the one region a live island stops owning: `$RC` replaces the hole's
 * children wholesale before the graft's materialize pass turns the arriving island markers into
 * hosts. Rendering the hole through this component leaves a seam that pass can re-adopt through -
 * INSIDE the parent island's tree, so the new islands keep the parent's whole context chain. Mounting
 * such a host as its own preact root instead severs it from every provider the parent renders.
 */
function holeSeamSource() {
  return `
class PnextHole extends Component {
  componentDidMount() {
    if (this.base) this.base.__pnextHole = this;
  }
  componentWillUnmount() {
    if (this.base && this.base.__pnextHole === this) this.base.__pnextHole = undefined;
  }
  componentWillReceiveProps(next) {
    // A soft navigation re-adopts the parent from the incoming document's DOM;
    // the previous document's grafted content must not outlive its children.
    if (next.children !== this.props.children) this.setState({ adopted: undefined });
  }
  render(props, state) {
    return h('pnext-hole', props.attrs, state.adopted !== undefined ? state.adopted : props.children);
  }
}
`
}

/**
 * The late-host half of the seam. `adoptHoleSeam` re-renders one hole through its live parent;
 * `claimNestedIslandRoot` is what the island scan calls instead of mounting a nested host.
 */
function lateIslandClaimSource() {
  return `
// The graft ($RC) swapped this hole's DOM wholesale, so re-adopting ALL of it is total: nothing in
// the hole is still preact-owned. The re-render lands inside the parent island's tree, which is what
// makes the new islands inherit its context.
// Detaching an element costs it every piece of state the browser keeps outside the DOM - a lazy
// image's deferred load observation, an iframe's document, playing media, focus - and re-inserting
// it does not bring any of that back. moveBefore is the state-preserving move (Chrome 133+); it
// needs both ends connected and refuses some moves outright, so a plain insert stays the fallback.
function movePnextNode(parent, node) {
  if (parent.moveBefore && parent.isConnected && node.isConnected) {
    try {
      parent.moveBefore(node, null);
      return;
    } catch (error) {}
  }
  parent.append(node);
}

// A subtree rebuilt from adopted vnodes is made of freshly created elements, and a graft can bring
// in ones the browser had already deferred. Either way a lazy image can end up in the document with
// no live intersection observation - no request ever fires, and it stays blank forever. Re-running
// its source selection re-arms it WITHOUT giving up laziness; one already loading (currentSrc set)
// or already loaded is left alone, so this never forces a fetch or duplicates one.
// Drop the capture holder, moving its nodes into \`into\` first when the adoption cannot use them.
function releaseHoleCapture(hole, into) {
  const captured = hole.__pnextCaptured;
  if (!captured) return;
  hole.__pnextCaptured = undefined;
  if (into) for (const node of [...captured.childNodes]) movePnextNode(into, node);
  captured.remove();
}

function rekickLazyLoadables(root) {
  for (const img of root.querySelectorAll('img[loading=lazy]')) {
    if (img.complete || img.currentSrc) continue;
    for (const name of ['src', 'srcset']) {
      const value = img.getAttribute(name);
      if (value === null) continue;
      img.removeAttribute(name);
      img.setAttribute(name, value);
    }
  }
}

async function adoptHoleSeam(hole) {
  const pending = hole.__pnextAdopting;
  if (pending) return pending;
  const seam = hole.__pnextHole;
  // No seam ever appeared: put the captured nodes back rather than losing them.
  if (!seam) return releaseHoleCapture(hole, hole);
  const adopting = (async () => {
    const captured = hole.__pnextCaptured;
    const children = await domChildren(captured ?? hole);
    // Preact rebuilds the subtree from the adopted vnodes, so the server nodes they were read from
    // would survive as unowned duplicates. Clearing and re-rendering within one task keeps the swap
    // inside a single frame - preact's rerender is a microtask, so no paint sees the empty hole.
    releaseHoleCapture(hole);
    hole.replaceChildren();
    seam.setState({ adopted: children ?? null }, () => rekickLazyLoadables(hole));
  })();
  hole.__pnextAdopting = adopting;
  try {
    await adopting;
  } finally {
    if (hole.__pnextAdopting === adopting) hole.__pnextAdopting = undefined;
  }
}

// A nested host belongs to its parent island's DOM adoption pass, never to a mount of its own. Wait
// out an adoption already in flight (its walk may still reach this host), and claim only what the
// parent can no longer see - a host the graft materialized after the parent went live - through the
// hole seam that owns the grafted DOM. A host under a parent that has not mounted yet stays put.
async function claimNestedIslandRoot(root, parent) {
  // The innermost hole whose seam is live owns this host. A nearer hole with no seam is raw grafted
  // DOM inside an outer seam's region, so that outer one is the tree to re-adopt through.
  let hole;
  for (let node = root.parentElement; node && node !== parent; node = node.parentElement) {
    if (node.localName !== 'pnext-hole') continue;
    if (node.__pnextHole) { hole = node; break; }
    hole ??= node;
  }
  // The parent is mid-adoption and has no seam here yet: its walk may already have snapshotted this
  // hole's fallback, and its hydration then drops the DOM the graft just landed. Park the grafted
  // nodes synchronously - ahead of that render - and adopt them from the holder once the tree is
  // live. A walk that had NOT reached the hole yet simply adopts an empty one and gets the same
  // content back through the seam. The holder is a hidden ELEMENT rather than a fragment: a
  // disconnected parent is exactly what strips browser state, and moveBefore refuses one.
  if (hole && !hole.__pnextHole && !hole.__pnextCaptured && parent.__pnextMounting) {
    const holder = document.createElement('pnext-hole-capture');
    holder.hidden = true;
    document.body.append(holder);
    hole.__pnextCaptured = holder;
    for (const node of [...hole.childNodes]) movePnextNode(holder, node);
  }
  // A parent whose module failed still settles: the claim has to release its capture rather than
  // leave the grafted nodes parked in a holder nobody will ever adopt from.
  await parent.__pnextMounting?.catch(() => {});
  if (!hole || (!hole.__pnextCaptured && !root.isConnected)) return;
  return adoptHoleSeam(hole);
}
`
}

// Two mount passes can reach the same island root concurrently - mountRoute and the streamed-Suspense
// re-scan both walk the document, and their "already live" guard runs BEFORE mountIsland awaits the
// component module. Without a synchronous claim both passes mount: the first tree is orphaned over the
// same DOM, still subscribed to the router's location store, and re-renders its stale state over the
// live tree on the next URL change.
function mountOnceSource() {
  return `
async function mountIslandOnce(root, mountTree) {
  const pending = root.__pnextMounting;
  if (pending) {
    await pending;
    // The other pass mounted this root; only a freshly stashed incoming
    // placeholder (a soft-nav graft) still needs this pass to re-render.
    if (root.__pnextLive && !root.__pnextIncoming) return;
  }
  const mounting = mountTree();
  root.__pnextMounting = mounting;
  try {
    await mounting;
  } finally {
    if (root.__pnextMounting === mounting) root.__pnextMounting = undefined;
  }
}
`
}

// Error seams, imported from their leaf modules rather than through a barrel:
// esbuild assigns chunks per set-of-reaching-entries on the MODULE graph, so a
// barrel re-export would drag the boundary into first paint even for an entry
// that never names it.
function clientErrorsInstallPath() {
  return path.join(import.meta.dirname, '../compat/client/errors/lazy.ts')
}

function clientErrorBoundaryPath() {
  return path.join(import.meta.dirname, '../compat/client/errors/error-boundary.ts')
}

function softRefreshModulePath() {
  return path.join(import.meta.dirname, '../compat/client/errors/soft-refresh.ts')
}

function bareErrorBoundaryPath() {
  return path.join(import.meta.dirname, '../compat/client/errors/bare-boundary.ts')
}

// The full in-tree ClientErrorBoundary is emitted only for a route that has an
// error.*/not-found.* to render at its own position in the tree. A route with
// neither still needs A boundary - a swallowed hydration throw never reaches the
// window last resort - but only the bare tier, which re-throws and preserves
// primitive throws for global-error and carries none of the cluster.
function boundaryImportSource(nextCompat?: boolean, boundary?: boolean, builtinNotFound?: boolean) {
  if (!nextCompat) return ''
  if (!boundary) {
    return `import { BareErrorBoundary } from ${JSON.stringify(bareErrorBoundaryPath())};`
  }
  return `import { ClientErrorBoundary } from ${JSON.stringify(clientErrorBoundaryPath())};
import { softRefreshRoute } from ${JSON.stringify(softRefreshModulePath())};${
    builtinNotFound ? `\n${builtInNotFoundSource()}` : ''
  }`
}

function errorUiModulePath() {
  return path.join(import.meta.dirname, '../compat/lifecycle/error-ui.ts')
}

// Next's default 404 body, for a client notFound() on a route with no not-found.* of its own.
// Emitted only when some route can reach it: error-ui.ts is first-paint bytes an app with a
// not-found file never uses.
function builtInNotFoundSource() {
  return `import { httpAccessFallbackUi as __pnextHttpAccessFallbackUi } from ${JSON.stringify(errorUiModulePath())};
function __PNextBuiltInNotFound() {
  return __pnextHttpAccessFallbackUi(404, 'This page could not be found.');
}`
}

/**
 * The compat facts every entry shape emits from. Kept as one record so the
 * shapes stay in step: each of them decides the same imports and the same
 * install calls, differing only in what they mount.
 */
type EntryCompatFacts = Pick<
  ClientEntryOptions,
  | 'nextCompat'
  | 'suspense'
  | 'actions'
  | 'errorFile'
  | 'globalErrorFile'
  | 'notFoundFile'
  | 'controlFlow'
  | 'router'
>

/** Whether this route has something for the in-tree boundary to render. */
export function hasErrorBoundary(
  facts: Pick<ClientEntryOptions, 'errorFile' | 'notFoundFile' | 'controlFlow'>,
) {
  return Boolean(facts.errorFile ?? facts.notFoundFile) || facts.controlFlow === true
}

function routerImportSource({
  nextCompat,
  actions,
  errorFile,
  globalErrorFile,
  notFoundFile,
  router,
}: EntryCompatFacts) {
  // No file in this route's closure can start a soft navigation (no Link, no navigation hook), so
  // the entry imports no router and the first-paint hub leaves the page entirely. The auto-mount
  // guard is the one thing still owed, and it is one window read (autoMountGuard).
  const base = router
    ? `import { installRouter, routerImportActive } from ${JSON.stringify(routerModulePath())};`
    : ''
  if (!nextCompat) return base
  const imports = [
    `${base}
import { installNavCompat } from ${JSON.stringify(navCompatModulePath())};
import { installClientErrors } from ${JSON.stringify(clientErrorsInstallPath())};`,
  ]
  if (actions) {
    // Compat apps may use server actions whose client stub navigates redirects
    // through window.__PNEXT_ROUTER__; install that global from the entry.
    imports.push(
      `import { installActionRouter } from ${JSON.stringify(actionRouterModulePath())};
import { isActionError } from ${JSON.stringify(actionClientModulePath())};`,
    )
  }
  if (errorFile) {
    // Route error.js: rendered as an overlay when an action error goes uncaught
    // (React's error-boundary semantics for action failures).
    if (actions) {
      imports.push(
        `import { installActionErrorOverlay } from ${JSON.stringify(actionClientModulePath())};`,
      )
    }
    imports.push(`import __PNextRouteErrorComponent from ${JSON.stringify(errorFile)};`)
  }
  if (globalErrorFile) {
    imports.push(`import __PNextGlobalErrorComponent from ${JSON.stringify(globalErrorFile)};`)
  }
  if (notFoundFile) {
    imports.push(`import __PNextRouteNotFoundComponent from ${JSON.stringify(notFoundFile)};`)
  }
  return imports.join('\n')
}

// Island props may carry serialized server-action references; the action runtime revives them into
// RPC functions. Lazy lookup: the runtime installs in the entry lifecycle before any island mounts.
// The `$$pnextError` marker is written by the renderer's action-prop serializer, which returns props
// untouched when next compat is off - so core and react entries import the ref+binary reviver and the
// error branch never ships.
/**
 * Both wire carriers - an island's `data-pnext-props` markers and the client page's
 * `__PNEXT_PROPS__` - must rebuild the same legacy sync surface, so they share one rebuilder. The
 * server stamps the flag only under compat.next.legacyRequestAPIs; a strict app reads params the
 * async way and must not grow a surface its server render never had.
 *
 * Emitted under next compat only - the flag rides compat's document scripts, so a core/react entry
 * could never see it and ships neither the import nor the call.
 */
function syncPropsHelperSource() {
  return `
import { rebuildSyncProps as __pnextRebuildSyncProps } from ${JSON.stringify(serializeModulePath())};
const __pnextSyncProps = () => (typeof window !== 'undefined' && window.__PNEXT_SYNC_PROPS__ ? __pnextRebuildSyncProps : undefined);
`
}

function propsParserSource(nextCompat?: boolean) {
  const revive = nextCompat ? 'reviveSerializedErrorRefs' : 'reviveSerializedRefs'
  return `
import { ${revive} as __pnextReviveSerializedRefs, hasPromiseProps as __pnextHasPromiseProps, revivePromiseMarkers as __pnextRevivePromiseMarkers } from ${JSON.stringify(serializeModulePath())};
import { hasIslandStaticSlots as __pnextHasIslandSlots, reviveIslandStaticSlots as __pnextReviveIslandSlots } from ${JSON.stringify(staticSlotsModulePath())};
// Element-valued props: the wire carries a \`$$pnext_slot\` id per element and the server rendered it
// inside a matching \`pnext-static-slot\` host, adopted here exactly like element children. Islands
// with no element props skip the walk on a substring test of the raw attribute.
// \`h\` is threaded in rather than imported by the slot reviver: that would put preact in the static
// graph of entries (visible-dynamic) that otherwise only lazy-import it.
function islandProps(raw, root, toChildren, h) {
  const props = parseIslandProps(raw);
  if (!__pnextHasIslandSlots(raw)) return props;
  return __pnextReviveIslandSlots(props, root, toChildren, h);
}
function parseIslandProps(raw) {
  const props = JSON.parse(raw || '{}');${
    nextCompat
      ? `
  const actions = typeof window !== 'undefined' ? window.__PNEXT_ACTIONS__ : undefined;`
      : ''
  }
  // Cyclic props: the encoder wrote the self-reference as a \`$$pnext_ref\` path
  // marker. Patch the original object back in AFTER action revival (which
  // rebuilds plain objects, so resolving first would restore identity onto
  // objects the revival then replaces).
  const revived = __pnextReviveSerializedRefs(${nextCompat ? 'actions ? actions.reviveProps(props) : props' : 'props'});
  // Promise props travel as markers, at the top level (a client slot page's params/searchParams) and
  // nested in plain containers (a dehydrated react-query state's pending-query promise). Revive both
  // into pre-fulfilled promises - see revivePromiseMarkers. The deep walk is gated on a substring
  // test of the raw attribute, so an island with no promise props pays one indexOf.
  return __pnextHasPromiseProps(raw || '') ? __pnextRevivePromiseMarkers(revived${nextCompat ? ', __pnextSyncProps()' : ''}) : revived;
}
`
}

/** Island hosts pnext emits as `display:contents` custom elements (renderer + compat dynamic). */
const MEASURED_HOST_TAGS = ['pnext-client', 'pnext-dynamic', 'pnext-static-children']

/**
 * A `display:contents` host has no CSS box, so an island child measuring its
 * parentElement (getBoundingClientRect/offsetWidth, or a ResizeObserver on it)
 * sees 0x0 and never resizes — under Next that parent is the app's real
 * container. Upgrading the hosts to custom elements lets their measurement
 * surface delegate to the nearest ancestor that does have a box.
 */
export function hostMeasureSource() {
  return `
function pnextInstallHostMeasure() {
  if (typeof customElements === 'undefined' || window.__PNEXT_HOST_MEASURE__) return;
  window.__PNEXT_HOST_MEASURE__ = true;
  const box = el =>
    el.style.display === 'contents' || getComputedStyle(el).display === 'contents'
      ? el.parentElement
      : null;
  class PnextHost extends HTMLElement {
    getBoundingClientRect() {
      const target = box(this);
      return target ? target.getBoundingClientRect() : super.getBoundingClientRect();
    }
    getClientRects() {
      const target = box(this);
      return target ? target.getClientRects() : super.getClientRects();
    }
  }
  for (const key of ['clientWidth', 'clientHeight', 'offsetWidth', 'offsetHeight', 'offsetTop', 'offsetLeft']) {
    Object.defineProperty(PnextHost.prototype, key, {
      configurable: true,
      get() {
        const target = box(this);
        return target ? target[key] : 0;
      },
    });
  }
  for (const tag of ${JSON.stringify(MEASURED_HOST_TAGS)}) {
    if (!customElements.get(tag)) customElements.define(tag, class extends PnextHost {});
  }
  // Observing the same element twice is a single native observation, so
  // redirecting host -> parent dedupes on its own.
  const observed = target => (target instanceof PnextHost ? (box(target) ?? target) : target);
  const NativeResizeObserver = window.ResizeObserver;
  if (NativeResizeObserver) {
    window.ResizeObserver = class extends NativeResizeObserver {
      observe(target, options) {
        super.observe(observed(target), options);
      }
      unobserve(target) {
        super.unobserve(observed(target));
      }
    };
  }
}
pnextInstallHostMeasure();
`
}

// Entries auto-mount only when loaded as the document's own module script.
// When the router imports an entry (asset warmup or a soft navigation) the
// router itself decides when to call mountRoute against the swapped DOM.
function mountLifecycleSource(nextCompat?: boolean) {
  return `
${
  nextCompat
    ? `// __NEXT_HYDRATED is the harness's interaction gate (test/lib/next-webdriver.ts
// waits on it and clicks immediately after), so it must mean "the visible tree is interactive", not
// "the island mounts were kicked off". preact's hydrate() attaches listeners during its synchronous
// commit, so the mount promises settling IS commit-level readiness. The gate waits for every promise
// that owns visible DOM and flips in a microtask so nothing extra is interposed under CPU load.
// pnextGateDeadline is a deadlock guard only: a wedged dynamic import must degrade to a late gate,
// never to a gate that never opens.
const pnextGateDeadline = 10000;
function pnextSettled(value) {
  if (value === undefined) return undefined;
  return Promise.resolve(value).then(pnextIgnore, pnextIgnore);
}
function pnextIgnore() {}
function markRouteHydrated() {
  window.__NEXT_HYDRATED = true;
  window.__NEXT_HYDRATED_AT ??= performance.now();
  if (typeof window.__NEXT_HYDRATED_CB === 'function') window.__NEXT_HYDRATED_CB();
  window.dispatchEvent(new Event('pnext:hydrated'));
}
// A settled mount promise means the DOM is attached, NOT that useEffect ran - preact defers effects
// to after-paint, so a layout publishing its handle from an effect is still unset when
// __NEXT_HYDRATED flips. Drive preact's flush through options.requestAnimationFrame so "effects ran"
// is an observable event the gate can await (plain rAF/macrotask ordering is not reliable in headless
// Chromium).
let pnextPendingEffectFlushes = 0;
let pnextEffectFlushWaiters = [];
const pnextEffectFlushRafTimeout = 100;
function pnextDrainEffectFlush(flush) {
  pnextPendingEffectFlushes--;
  try {
    flush();
  } finally {
    if (pnextPendingEffectFlushes <= 0) {
      pnextPendingEffectFlushes = 0;
      const waiters = pnextEffectFlushWaiters;
      pnextEffectFlushWaiters = [];
      for (const waiter of waiters) waiter();
    }
  }
}
__pnextPreactOptions.requestAnimationFrame = flush => {
  pnextPendingEffectFlushes++;
  let ran = false;
  const run = () => {
    if (ran) return;
    ran = true;
    pnextDrainEffectFlush(flush);
  };
  // preact's own afterNextFrame semantics: the frame, or a 100ms fallback for a
  // document whose rAF never fires (a backgrounded page).
  const timer = setTimeout(run, pnextEffectFlushRafTimeout);
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      clearTimeout(timer);
      run();
    });
  }
};
function pnextAfterEffectFlush(run) {
  // Effects are queued during the mount's synchronous commit, so by the time
  // the mount promise settles every pending flush is already registered above.
  // Nothing pending means there is nothing left to wait for.
  if (pnextPendingEffectFlushes === 0) {
    run();
    return;
  }
  pnextEffectFlushWaiters.push(run);
}
function pnextGate(mark, islandMounts, visibleMount) {
  const waits = [pnextSettled(islandMounts), pnextSettled(visibleMount)].filter(Boolean);
  if (waits.length === 0) {
    mark();
    return;
  }
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    mark();
  };
  const timer = setTimeout(once, pnextGateDeadline);
  void Promise.all(waits).then(() => {
    pnextAfterEffectFlush(() => {
      clearTimeout(timer);
      once();
    });
  });
}
`
    : ''
}
function keepsMountedRoot(root, keep) {
  if (!keep) return false;
  for (const kept of keep) {
    if (root === kept) return true;
    // The preserved client page's container is a marker-range proxy, not a
    // Node — contains() would throw on it, and only identity can match it.
    if (kept instanceof Node && root.contains && root.contains(kept)) return true;
  }
  return false;
}
`
}

// The per-route half of the lifecycle, closing over the route's own mount
// state. mountRoute runs the steps the route actually has: an island scan, the
// client-shell hydration, the client page.
function routeLifecycleSource({ nextCompat, islands, page, shell, dev }: ClientRuntimeFacts) {
  const gate = nextCompat
    ? '  pnextGate(markRouteHydrated, pnextIslandMounts, pnextVisibleMount);\n'
    : ''
  const islandMounts = dev
    ? `pnextIslandScan.done.then(() => {
      diagnoseSkippedIslands();
      return pnextIslandScan.mounted;
    })`
    : 'pnextIslandScan.done.then(() => pnextIslandScan.mounted)'
  const mountBody = [
    islands
      ? `  if (islands.length > 0) {
    pnextIslandScan = scanIslands();
    pnextIslandMounts = ${islandMounts};
  }`
      : '',
    shell ? '  if (shell) pnextVisibleMount = hydrateClientShell();' : '',
    page
      ? `  if (Page) {
    if (islands.length > 0) pnextVisibleMount = hydratePageAfterIslands();
    else hydratePage();
  }`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
  return `
  function mountRoute() {
${mountBody}
    window.__PNEXT_ACTIVE_ENTRY__ = { unmount: unmountRoute };
${gate}    return pnextIslandMounts;
  }

  // A postponed boundary can flush AFTER this entry module has evaluated: the shell's async module
  // scripts race the server's tail, and a server under load loses that race - the initial mountRoute()
  // then sees a document holding only the placeholder, mounts nothing, and the tree stays inert
  // FOREVER, because promotion has no way back into the entry. The promotion script calls this hook
  // once the real DOM is parsed in. Every step is guarded, so re-running them hydrates only what the
  // first pass could not see.
  function remountRoute() {
${mountBody}
${gate}    return pnextIslandMounts;
  }
  window.__PNEXT_MOUNT_ISLANDS__ = remountRoute;

  function unmountRoute(keep) {
    // Roots in \`keep\` are grafted into the next document by the router (shared
    // layout preservation) — leave them and any mounted ancestor intact; an
    // ancestor unmount would recursively tear down the preserved island.
    for (const root of pnextMountedRoots) {
      if (keepsMountedRoot(root, keep)) continue;
      render(null, root);
      root.__pnextLive = undefined;
    }
    // A preserved client page keeps its registration: its tree is still mounted
    // and grafted into the new body, so hydratePage must see it as live instead
    // of re-hydrating over it. Every other root is dropped — island roots kept
    // for the bfcache are detached and owned by the cache from here on.
    const page = window.__PNEXT_CLIENT_PAGE_ROOT__;
    let keepsPage = false;
    if (page && keep) for (const kept of keep) if (kept === page) keepsPage = true;
    pnextMountedRoots.clear();
    if (keepsPage) pnextMountedRoots.add(page);
  }

  return { mountRoute, remountRoute, unmountRoute };
`
}

/**
 * A route that renders no client page and no islands still needs an entry - it has a Link or another
 * router seam - but nothing in it ever renders, so it ships neither preact nor the mount/hydrate
 * machinery: just the router hub and the no-op module shape the router imports across a soft nav.
 */
function routerOnlyEntrySource(facts: EntryCompatFacts) {
  // Nothing hydrates here, so the route is interactive the moment mountRoute
  // runs — mark it right away (the island shapes gate on their mount promises
  // first) or the harness waits out its full __NEXT_HYDRATED fallback.
  const mark = facts.nextCompat
    ? `
function markRouteHydrated() {
  window.__NEXT_HYDRATED = true;
  window.__NEXT_HYDRATED_AT ??= performance.now();
  if (typeof window.__NEXT_HYDRATED_CB === 'function') window.__NEXT_HYDRATED_CB();
  window.dispatchEvent(new Event('pnext:hydrated'));
}
`
    : ''
  return `
${routerImportSource(facts)}
${mark}
export function mountRoute() {
  window.__PNEXT_ACTIVE_ENTRY__ = { unmount: unmountRoute };
${facts.nextCompat ? '  markRouteHydrated();\n' : ''}}

export function unmountRoute() {}

${installRouterCall(facts.router)}${installCallsSource(facts)}
if (${autoMountGuard(facts.router)}) mountRoute();
if (window.__PNEXT_REGISTER_ENTRY__) window.__PNEXT_REGISTER_ENTRY__(import.meta.url, { mountRoute, unmountRoute });
`
}

/** `installRouter()`, or nothing when the route can never soft-navigate. */
function installRouterCall(router?: boolean) {
  return router ? 'installRouter();\n' : ''
}

/**
 * Entries auto-mount when the browser loads them as the document's own module script, never when the
 * router imports one. Router-free entries read the counter directly rather than importing
 * `routerImportActive` - that one import would pull the whole first-paint hub back onto the page.
 */
function autoMountGuard(router?: boolean) {
  return router ? '!routerImportActive()' : '!((window.__PNEXT_ROUTER_IMPORTS__ ?? 0) > 0)'
}

// The compat install calls that follow installRouter() in every entry shape.
function installCallsSource({
  nextCompat,
  actions,
  errorFile,
  globalErrorFile,
  notFoundFile,
}: EntryCompatFacts) {
  if (!nextCompat) return ''
  const overlay =
    actions && errorFile ? 'installActionErrorOverlay(__PNextRouteErrorComponent);\n' : ''
  return `${actions ? 'installActionRouter();\n' : ''}installNavCompat();
${overlay}installClientErrors({ errorComponent: ${
    errorFile ? '__PNextRouteErrorComponent' : 'undefined'
  }, globalErrorComponent: ${
    globalErrorFile ? '__PNextGlobalErrorComponent' : 'undefined'
  }, notFoundComponent: ${
    notFoundFile ? '__PNextRouteNotFoundComponent' : 'undefined'
  }, isActionError: ${actions ? 'isActionError' : 'undefined'} });`
}

/**
 * App-wide facts the shared route runtime is emitted from: each piece of glue
 * ships only when some route in the app can actually use it.
 */
export interface ClientRuntimeFacts {
  /** Development-only diagnostics; omitted entirely from production bundles. */
  dev?: boolean
  nextCompat?: boolean
  /** Any route mounts islands (island scan, revival, static children). */
  islands?: boolean
  /** Any route is a whole-page `'use client'` component. */
  page?: boolean
  /** Any route hydrates a client root layout as the document shell. */
  shell?: boolean
  /** Any route has a `dynamic(..., { ssr: false })` island (DeferredIsland). */
  deferredIslands?: boolean
  /** Any island loads on visibility (IntersectionObserver tier). */
  visibleIslands?: boolean
  /**
   * Compat runtime must support suspension (Suspense island wrapper, preact/compat). False only when
   * the app's client graph provably never suspends (see clientCompatSurface); undefined outside compat.
   */
  suspense?: boolean
}

/** Module specifier the generated route stubs import their runtime from. */
export const CLIENT_RUNTIME_MODULE = 'pnext-client-runtime'

export function clientRuntimeFacts(
  routes: { route: RouteFacts; shell?: boolean }[],
  nextCompat?: boolean,
  suspense?: boolean,
): ClientRuntimeFacts {
  const references = routes.flatMap(({ route }) => route.clientReferences)
  return {
    nextCompat,
    suspense: nextCompat ? (suspense ?? true) : undefined,
    islands: references.length > 0,
    page: routes.some(({ route }) => route.client),
    shell: routes.some(entry => entry.shell),
    deferredIslands: references.some(reference => reference.dynamic?.ssr === false),
    visibleIslands: references.some(reference => reference.dynamic?.load === 'visible'),
  }
}

interface RouteFacts {
  client?: boolean
  clientReferences: ClientReference[]
}

/**
 * The mount/hydrate machinery every route entry runs - emitted ONCE per app and imported by each
 * route's stub, so the identical glue becomes one shared chunk plus a per-route manifest.
 * Route-specific values (islands, the client page, shell layouts, error components) arrive as config.
 */
export function clientRuntimeSource(facts: ClientRuntimeFacts) {
  const { nextCompat, deferredIslands, page, shell } = facts
  const suspense = nextCompat && facts.suspense !== false
  // The shell re-renders the whole document through the client root layout, so
  // it revives island DOM exactly like an island mount does.
  const revival = Boolean(facts.islands || shell)
  return `
import { ${revival ? 'Component, ' : ''}h, hydrate, render } from 'preact';
${nextCompat ? "import { options as __pnextPreactOptions } from 'preact';" : ''}
${deferredIslands ? "import { useEffect, useState } from 'preact/hooks';" : ''}
${suspense ? "import { Suspense } from 'preact/compat';" : ''}
${revival ? layoutSegmentHelperSource(nextCompat) : ''}
${nextCompat && (revival || page) ? syncPropsHelperSource() : ''}
${revival ? propsParserSource(nextCompat) : ''}
${revival ? islandHelpersSource(facts) : ''}
${islandCssHelperSource()}
${revival ? hostMeasureSource() : ''}
${mountLifecycleSource(nextCompat)}

export function bootstrapRoute(config) {
  const islands = config.islands ?? [];
  const Page = config.Page;
  const shell = config.shell;
  const pnextMountedRoots = new Set();
  let pnextIslandMounts;
  let pnextIslandScan;
  let pnextVisibleMount;
${clientBoundaryHelperSource(nextCompat, suspense)}
${mountSource()}
${revival ? hydrateIslandsSource(facts) : ''}
${shell ? hydrateClientShellSource(nextCompat) : ''}
${page ? hydratePageSource(nextCompat) : ''}
${routeLifecycleSource(facts)}
}
`
}

export function clientEntrySource(options: ClientEntryOptions) {
  const {
    pageFile,
    clientReferences,
    nextCompat,
    errorFile,
    notFoundFile,
    clientRootLayout,
    shellLayoutOrder,
  } = options
  const facts: EntryCompatFacts = {
    nextCompat,
    suspense: options.suspense,
    actions: options.actions,
    errorFile,
    globalErrorFile: options.globalErrorFile,
    notFoundFile,
    controlFlow: options.controlFlow,
    // The router-only entry shape exists BECAUSE this route needs the router.
    router: options.router || (!pageFile && clientReferences.length === 0),
  }
  if (!pageFile && clientReferences.length === 0) {
    return routerOnlyEntrySource(facts)
  }
  if (
    !pageFile &&
    clientReferences.length > 0 &&
    clientReferences.every(isVisibleDynamicReference)
  ) {
    return visibleDynamicIslandEntrySource(clientReferences, facts, options.deferredDynamicHref)
  }

  const imports = clientReferences
    .map((reference, index) => {
      if (reference.dynamic) return null
      // A side-effect-only client module (bare `import './client-only'`) is
      // bundled and run for its top-level code but never mounted as an island —
      // webpack-style eager initialization of all client references.
      if (reference.sideEffect) return `import ${JSON.stringify(reference.file)};`
      return reference.exportName === 'default'
        ? `import Island${index} from ${JSON.stringify(reference.file)};`
        : `import { ${reference.exportName} as Island${index} } from ${JSON.stringify(reference.file)};`
    })
    .filter((item): item is string => Boolean(item))
    .join('\n')
  const islandManifest = clientReferences
    .map((reference, index) =>
      reference.sideEffect
        ? null
        : reference.dynamic
          ? `{ id: ${JSON.stringify(reference.id)}, options: ${JSON.stringify(reference.dynamic)}, ${dynamicLoader(reference, options.deferredDynamicHref?.(reference))} }`
          : `{ id: ${JSON.stringify(reference.id)}, Component: Island${index} }`,
    )
    .filter((item): item is string => item !== null)
    .join(',\n  ')

  // Island bindings are named by position in the FULL reference array (see
  // `imports` above), so the shell must carry those names rather than re-index
  // its own filtered/reordered view.
  const islandNames = new Map(
    clientReferences.map((reference, index) => [reference, `Island${index}`]),
  )
  const shellReferences = shellClientReferences(
    clientReferences,
    errorFile,
    notFoundFile,
    shellLayoutOrder,
  )
  const shellNames =
    !pageFile && clientRootLayout && shellReferences.some(reference => !reference.dynamic)
      ? shellReferences
          .map(reference => (reference.dynamic ? undefined : islandNames.get(reference)))
          .filter((name): name is string => Boolean(name))
      : undefined
  const needsCss = clientReferences.some(reference => referenceCssHref(reference))

  return `
import { bootstrapRoute${needsCss ? ', loadIslandCss' : ''} } from ${JSON.stringify(CLIENT_RUNTIME_MODULE)};
${pageFile ? `import Page from ${JSON.stringify(pageFile)};` : ''}
${imports}
${routerImportSource(facts)}
${boundaryImportSource(nextCompat, hasErrorBoundary(facts), !notFoundFile)}

const { mountRoute, remountRoute, unmountRoute } = bootstrapRoute({
  islands: [
  ${islandManifest}
  ],${pageFile ? '\n  Page,' : ''}${shellNames ? `\n  shell: [${shellNames.join(', ')}],` : ''}${boundaryConfigSource(facts)}
});
export { mountRoute, remountRoute, unmountRoute };

${installRouterCall(facts.router)}${installCallsSource(facts)}
if (${autoMountGuard(facts.router)}) void mountRoute();
if (window.__PNEXT_REGISTER_ENTRY__) window.__PNEXT_REGISTER_ENTRY__(import.meta.url, { mountRoute, unmountRoute });
`
}

/**
 * The `bootstrapRoute` config fields carrying this route's in-tree boundary: the
 * full tier for a route with an `error`/`not-found` file to render, the bare tier
 * for one with neither. Emitting it per route is what keeps the cluster out of
 * the app-wide runtime chunk.
 */
function boundaryConfigSource(facts: EntryCompatFacts) {
  if (!facts.nextCompat) return ''
  const base = `\n  errorComponent: ${facts.errorFile ? '__PNextRouteErrorComponent' : 'undefined'},\n  notFoundComponent: ${
    facts.notFoundFile ? '__PNextRouteNotFoundComponent' : 'undefined'
  },`
  if (!hasErrorBoundary(facts)) return `${base}\n  errorBoundary: BareErrorBoundary,`
  return `${base}\n  errorBoundary: ClientErrorBoundary,\n  onBoundaryReset: softRefreshRoute,${
    facts.notFoundFile ? '' : '\n  builtInNotFound: __PNextBuiltInNotFound,'
  }`
}

function shellClientReferences(
  clientReferences: ClientReference[],
  errorFile?: string,
  notFoundFile?: string,
  shellLayoutOrder?: string[],
) {
  const shell = clientReferences.filter(
    reference =>
      !reference.sideEffect && reference.file !== errorFile && reference.file !== notFoundFile,
  )
  // The shell nests outermost-first, but `clientReferences` is path-hash
  // sorted — layouts must lead in hierarchy order or a non-layout reference
  // can end up outermost and silently drop the layout subtree. Non-layout
  // references keep their relative order behind the chain.
  if (!shellLayoutOrder?.length) return shell
  const rank = new Map(shellLayoutOrder.map((file, index) => [file, index]))
  return shell
    .map((reference, index) => ({ reference, index }))
    .sort((a, b) => {
      const aRank = rank.get(a.reference.file)
      const bRank = rank.get(b.reference.file)
      if (aRank !== undefined && bRank !== undefined) return aRank - bRank
      if (aRank !== undefined) return -1
      if (bRank !== undefined) return 1
      return a.index - b.index
    })
    .map(entry => entry.reference)
}

function isVisibleDynamicReference(reference: ClientReference) {
  return reference.dynamic?.load === 'visible'
}

function visibleDynamicIslandEntrySource(
  clientReferences: ClientReference[],
  facts: EntryCompatFacts,
  deferredDynamicHref?: (reference: ClientReference) => string | undefined,
) {
  const { nextCompat, errorFile, notFoundFile } = facts
  const boundary = hasErrorBoundary(facts)
  const islandManifest = clientReferences
    .map(
      reference =>
        `{ id: ${JSON.stringify(reference.id)}, ${visibleDynamicLoader(reference, deferredDynamicHref?.(reference))} }`,
    )
    .join(',\n  ')

  const compatBoundary = !nextCompat
    ? ''
    : boundary
      ? `function pnextClientBoundary(h, vnode) {
  return h(ClientErrorBoundary, { errorComponent: ${
    errorFile ? '__PNextRouteErrorComponent' : 'undefined'
  }, notFoundComponent: ${
    notFoundFile ? '__PNextRouteNotFoundComponent' : '__PNextBuiltInNotFound'
  }, onReset: softRefreshRoute }, vnode);
}
`
      : // No error.*/not-found.* to render here: the bare tier only re-throws
        // (and escalates primitive throws), so the window last resort still owns
        // the outcome without this route carrying the boundary cluster.
        `function pnextClientBoundary(h, vnode) {
  return h(BareErrorBoundary, null, vnode);
}
`

  return `
${nextCompat ? "import { options as __pnextPreactOptions } from 'preact';" : ''}
${islandCssHelperSource()}
${routerImportSource(facts)}
${boundaryImportSource(nextCompat, boundary, boundary && !notFoundFile)}
${layoutSegmentHelperSource(nextCompat)}
${hostMeasureSource()}
${mountLifecycleSource(nextCompat)}
const islands = [
  ${islandManifest}
];

const pnextMountedRoots = new Set();
let pnextIslandMounts;
let pnextRender;

${nextCompat ? syncPropsHelperSource() : ''}
${propsParserSource(nextCompat)}
${compatBoundary}
export function mountRoute() {
  for (const island of islands) {
    for (const root of document.querySelectorAll(\`[data-pnext-client="\${island.id}"]\`)) {
      if (isNestedIslandRoot(root)) continue;
      // A preserved root (router grafted its live DOM across the soft nav)
      // still shows the previous route's children — remount it immediately
      // instead of waiting for an intersection.
      if (root.__pnextIncoming) {
        void mountIsland(root, island);
        continue;
      }
      observeVisibleIsland(root, island);
    }
  }
  window.__PNEXT_ACTIVE_ENTRY__ = { unmount: unmountRoute };
${nextCompat ? '  pnextGate(markRouteHydrated, pnextIslandMounts, undefined);\n' : ''}  return pnextIslandMounts;
}

export const remountRoute = mountRoute;
window.__PNEXT_MOUNT_ISLANDS__ = remountRoute;

export function unmountRoute(keep) {
  // Roots in \`keep\` are grafted into the next document by the router (shared
  // layout preservation) — leave them and any mounted ancestor intact; an
  // ancestor unmount would recursively tear down the preserved island.
  if (pnextRender) for (const root of pnextMountedRoots) {
    if (keepsMountedRoot(root, keep)) continue;
    pnextRender(null, root);
    root.__pnextLive = undefined;
  }
  pnextMountedRoots.clear();
}

${installRouterCall(facts.router)}${installCallsSource(facts)}
if (${autoMountGuard(facts.router)}) void mountRoute();
if (window.__PNEXT_REGISTER_ENTRY__) window.__PNEXT_REGISTER_ENTRY__(import.meta.url, { mountRoute, unmountRoute });

function observeVisibleIsland(root, island) {
  if (typeof IntersectionObserver === 'undefined') {
    void mountIsland(root, island);
    return;
  }

  const target = visibleTarget(root);
  const observer = new IntersectionObserver(entries => {
    if (!entries.some(entry => entry.isIntersecting)) return;
    observer.disconnect();
    void mountIsland(root, island);
  }, island.options);

  observer.observe(target);
}

function visibleTarget(root) {
  // The host's OWN box: hostMeasureSource delegates the patched one to the
  // parent, and IntersectionObserver never fires for a display:contents target.
  const rect = Element.prototype.getBoundingClientRect.call(root);
  if (rect.width || rect.height) return root;
  return root.parentElement ?? root;
}

${mountOnceSource()}
${
  nextCompat
    ? `let islandBoundary;

function mountIsland(root, island) {
  return mountIslandOnce(root, () => mountIslandTree(root, island));
}

async function mountIslandTree(root, island) {
  const [{ h, hydrate, render }${facts.suspense !== false ? ', { Suspense }' : ''}, Component] = await Promise.all([
    import('preact'),${facts.suspense !== false ? "\n    import('preact/compat')," : ''}
    islandComponent(island),
  ]);
${facts.suspense !== false ? '  islandBoundary = Suspense;\n' : ''}  const rawProps = root.getAttribute('data-pnext-props') ?? '{}';
  const source = preservedSource(root, render);
  const vnode = islandVNode(h, Component, await islandProps(rawProps, source, node => domChildren(h, node), h), await staticChildren(h, source, island.id));
  const wrapped = ${facts.suspense !== false ? 'h(Suspense, { fallback: null }, pnextClientBoundary(h, vnode))' : 'pnextClientBoundary(h, vnode)'};
  if (source !== root) adoptPreserved(render, root, wrapped);
  else mount(hydrate, render, root, wrapped);
}`
    : `function mountIsland(root, island) {
  return mountIslandOnce(root, () => mountIslandTree(root, island));
}

async function mountIslandTree(root, island) {
  const [{ h, hydrate, render }, Component] = await Promise.all([import('preact'), islandComponent(island)]);
  const rawProps = root.getAttribute('data-pnext-props') ?? '{}';
  const source = preservedSource(root, render);
  const vnode = islandVNode(h, Component, await islandProps(rawProps, source, node => domChildren(h, node), h), await staticChildren(h, source, island.id));
  if (source !== root) adoptPreserved(render, root, vnode);
  else mount(hydrate, render, root, vnode);
}`
}

// Dev route entries each bundle their own copy of a shared island component, and Preact
// diffs by component IDENTITY: mounting the destination entry's copy would remount every
// preserved island on navigation (a splash gate re-splashes, a reel restarts). The first
// loaded instance of an island id wins for the document's lifetime; a dev recompile
// full-reloads the page, which resets the registry. Prod ships one entry, so this is a
// no-op there.
// NOTE: pinning a single component instance across dev route entries is NOT safe here:
// each dev entry carries its own module graph, and a pinned provider's context object
// would not match the consuming entry's copy (breaks e.g. QueryClientProvider). Module
// graphs must be deduped at the bundler level instead.
async function islandComponent(island) {
  return island.Component ?? await island.load();
}

// A root preserved across a soft navigation carries the incoming placeholder
// (fresh SSR children) stashed by the router; render children from it when this
// preact instance owns the live tree. A foreign entry copy (dev bundles) can't
// be diffed — restore the SSR children and mount fresh instead.
function preservedSource(root, render) {
  const incoming = root.__pnextIncoming;
  root.__pnextIncoming = undefined;
  if (!incoming) return root;
  if (root.__pnextLive === render) return incoming;
  root.replaceChildren(...incoming.childNodes);
  root.__pnextLive = undefined;
  return root;
}

// Re-render the preserved root in place so component state survives while the
// routed content under the island updates.
function adoptPreserved(render, root, vnode) {
  render(vnode, root);
  pnextRender = render;
  pnextMountedRoots.add(root);
}

function mount(hydrate, render, root, vnode) {
  // See mountSource(): an SSR-failed placeholder has no server DOM to adopt.
  const ssrFailed = root.getAttribute && root.getAttribute('data-pnext-ssr-failed') != null;
  const apply = root.hasChildNodes() && !ssrFailed ? hydrate : render;
  apply(vnode, root);
  // Stamp the root with this entry's render so the router can preserve it
  // across a soft navigation and the next entry can tell whether its own
  // preact instance owns the live tree.
  root.__pnextLive = render;
  pnextRender = render;
  pnextMountedRoots.add(root);
}

// Adopted DOM children win (element children); plain children travel inside
// the serialized props instead, and an explicit undefined third argument would
// clobber props.children in preact's createElement — so only pass it when set.
function islandVNode(h, Component, props, adopted) {
  return adopted !== undefined ? h(Component, props, adopted) : h(Component, props);
}

async function staticChildren(h, root, id) {
  const node = root.querySelector(\`[${ISLAND_STATIC_CHILDREN_ATTRIBUTE}="\${id}"]\`);
  if (!node) return undefined;
  // A fallback <template> sidecar (children the component did not render on
  // the server): materialize any island markers inside its inert content,
  // adopt, then drop the sidecar so the mount starts from a clean host.
  const template = node.localName === 'template';
  const source = template ? node.content : node;
  if (template && window.__PNEXT_MATERIALIZE_CLIENT_ISLANDS__) {
    window.__PNEXT_MATERIALIZE_CLIENT_ISLANDS__(source);
  }
  const children = await domChildren(h, source);
  if (template) node.remove();
  return h('pnext-static-children', {
    ${JSON.stringify(ISLAND_STATIC_CHILDREN_ATTRIBUTE)}: id,
    style: { display: 'contents' },
  }, children);
}

async function domChildren(h, node) {
  const children = (await Promise.all(Array.from(node.childNodes, child => domNode(h, child))))
    .filter(child => child !== null && child !== undefined && child !== false);
  if (children.length === 0) return undefined;
  return children.length === 1 ? children[0] : children;
}

async function domNode(h, node) {
  if (node.nodeType === 3) return node.textContent;
  if (node.nodeType !== 1) return null;

  const element = node;
  if (element.localName === ${JSON.stringify(ISLAND_BOUNDARY_ERROR_ELEMENT)}) return pnextBoundaryErrorVNode(h, element);
  if (element.localName === 'pnext-client') {
    const id = element.getAttribute('data-pnext-client');
    const island = islands.find(candidate => candidate.id === id);
    if (!island) return h(element.localName, domProps(element), await domChildren(h, element));
    const Component = await islandComponent(island);
    const rawProps = element.getAttribute('data-pnext-props') ?? '{}';
    const props = await islandProps(rawProps, element, node => domChildren(h, node), h);
    // Adopted DOM is diffed positionally, and SSR-state-only siblings (a splash overlay the
    // server rendered that the live tree no longer shows) shift positions between renders.
    // A nested island must match its previous incarnation by IDENTITY, or the shift remounts
    // it and resets its state - Next never remounts layout components on navigation.
    if (props.key === undefined) props.key = 'pnext-island:' + id;
    const vnode = islandVNode(h, Component, props, await staticChildren(h, element, island.id));
    return ${nextCompat ? 'islandBoundary ? h(islandBoundary, { fallback: null }, pnextClientBoundary(h, vnode)) : pnextClientBoundary(h, vnode)' : 'vnode'};
  }

  return h(element.localName, domProps(element), await domChildren(h, element));
}

function pnextBoundaryErrorVNode(h, element) {
  const message = element.getAttribute(${JSON.stringify(ISLAND_BOUNDARY_ERROR_MESSAGE_ATTRIBUTE)}) ?? '';
  const digest = element.getAttribute(${JSON.stringify(ISLAND_BOUNDARY_ERROR_DIGEST_ATTRIBUTE)});
  return h(function PnextBoundaryError() {
    const error = new Error(message);
    if (digest) error.digest = digest;
    throw error;
  }, null);
}

function domProps(element) {
  const props = {};
  for (const attribute of element.attributes) props[attribute.name] = attribute.value;
  return props;
}

// A nested root belongs to its parent island's DOM adoption pass, never to a
// mount of its own. This entry carries no streamed-hole seam (see the shared
// runtime): its whole point is a preact-free first paint, and a host grafted in
// after a visible island mounted would be dead weight in every bundle.
function isNestedIslandRoot(root) {
  return root.parentElement?.closest('pnext-client') != null;
}
`
}

function visibleDynamicLoader(reference: ClientReference, href?: string) {
  return `options: ${JSON.stringify(reference.dynamic ?? {})}, ${dynamicLoader(reference, href)}`
}

function dynamicLoader(reference: ClientReference, href?: string) {
  const imported =
    reference.exportName === 'default' ? 'module.default' : `module.${reference.exportName}`
  const importExpression = `import(${JSON.stringify(href ?? reference.file)}).then(module => ${imported})`
  const cssHref = referenceCssHref(reference)
  return cssHref
    ? `load: () => Promise.all([${importExpression}, loadIslandCss(${JSON.stringify(cssHref)})]).then(([module]) => module)`
    : `load: () => ${importExpression}`
}

function referenceCssHref(reference: ClientReference) {
  return reference.cssImports?.length ? `/assets/${reference.id}.css` : undefined
}

// The island's stylesheet loads with the island, not with the route: a
// non-SSR island renders nothing until it mounts, so its CSS would only
// penalize first paint. Resolves on error too — a missing stylesheet should
// degrade styling, not block the component forever.
function islandCssHelperSource() {
  return `
export function loadIslandCss(href) {
  if (document.querySelector('link[href="' + href + '"]')) return Promise.resolve();
  return new Promise(resolve => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = () => resolve();
    link.onerror = () => resolve();
    document.head.append(link);
  });
}
`
}

function mountSource() {
  return `
function mount(root, vnode) {
  // An island whose SSR stringification threw was served as an empty
  // pnext-client placeholder (data-pnext-ssr-failed) with no server DOM to adopt;
  // render it fresh rather than hydrating against nothing.
  const ssrFailed = root.getAttribute && root.getAttribute('data-pnext-ssr-failed') != null;
  const apply = root.hasChildNodes() && !ssrFailed ? hydrate : render;
  apply(vnode, root);
  // Stamp the root with this entry's render so the router can preserve it
  // across a soft navigation and the next entry can tell whether its own
  // preact instance owns the live tree (dev bundles carry separate copies).
  root.__pnextLive = render;
  pnextMountedRoots.add(root);
}
`
}

function hydratePageSource(nextCompat?: boolean) {
  return `
async function hydratePageAfterIslands() {
  await pnextIslandMounts;
  const root = document.getElementById('pnext-page');
  if (root?.closest('pnext-client')) return;
  hydratePage();
}

function pageProps() {
const rawProps = window.__PNEXT_PROPS__ ?? {};
// Pre-fulfilled promises (status/value readable synchronously): use() must
// not suspend during page hydration or preact appends fragment siblings
// instead of reusing the server DOM.
// Under compat.next.legacyRequestAPIs the server also gave these promises the resolved object's
// own keys (withSyncProps), so Next-14 code reads \`params.creator\` without await; rebuild that
// same surface here or the hydrated page loses every param the SSR render had.
${nextCompat ? 'const legacy = __pnextSyncProps();' : ''}
const fulfilled = (kind, value) => {
  const promise = Promise.resolve(value);
  promise.status = 'fulfilled';
  promise.value = value;
  return ${nextCompat ? 'legacy ? legacy(promise, kind, value) : promise' : 'promise'};
};
return {
  ...rawProps,
  params: fulfilled('params', rawProps.params ?? {}),
  searchParams: fulfilled(
    'searchParams',
    rawProps.searchParams ?? Object.fromEntries(new URLSearchParams(location.search)),
  ),
};
}

function hydratePage() {
// SSR-error recovery: when the server errored and served the error-boundary
// document, hydrating the real Page against that error HTML corrupts the tree.
// The server stamps data-pnext-ssr-error on <html>; skip page hydration and let
// the client error runtime (installClientErrors) own the tree instead.
if (document.documentElement.hasAttribute('data-pnext-ssr-error')) return;
// A refresh of this same route grafts the live page DOM back in (the router's
// client-page preservation), so its tree is still mounted — re-hydrating over
// it would blow away the state the graft exists to keep.
const live = window.__PNEXT_CLIENT_PAGE_ROOT__;
if (live && pnextMountedRoots.has(live)) return;
const root = pageMountRoot();
if (!root) return;
// Published for the router: it needs the mount container (and, for a dissolved
// page slot, its anchors) to preserve this page across a refresh.
window.__PNEXT_CLIENT_PAGE_ROOT__ = root;
mount(root, ${wrapInBoundary('h(Page, pageProps())', nextCompat)});
}

// Next renders a page's children directly into the layout with no wrapper element, so tests assert
// structural selectors against the live DOM. The island bootstrap rebuilt div#pnext-page from the SSR
// comment markers; a client page mounted here owns that wrapper exclusively, so dissolve it back into
// comment anchors and hydrate against a virtual container whose children are the marker range.
// Nested/segment contexts keep the real element: island adoption walks it and segment grafting
// queries #pnext-page.
function pageMountRoot() {
  const root = document.getElementById('pnext-page');
  if (!root || !root.parentNode) return root;
  if (root.closest('pnext-client') || root.closest('pnext-layout[data-pnext-segment]')) return root;
  const parent = root.parentNode;
  let attrs = '';
  for (const attribute of root.attributes) attrs += ' ' + attribute.name + '="' + attribute.value + '"';
  // Same encoding the island materializers parse (entity-escaped attribute
  // text, see renderer encodeIslandMarker) — a bfcache/entry snapshot of this
  // dissolved marker must re-materialize into a real #pnext-page wrapper.
  const encoded = attrs.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const open = document.createComment('pnext-page:' + encoded);
  const close = document.createComment('/pnext-page');
  parent.insertBefore(open, root);
  while (root.firstChild) parent.insertBefore(root.firstChild, root);
  parent.replaceChild(close, root);
  const container = pageMarkerContainer(open, close, parent);
  // The router preserves this range across a refresh; it needs the anchors.
  container.__pnextAnchors = [open, close];
  return container;
}

// The minimal parent-DOM surface preact's diff touches on a render container
// (namespaceURI/firstChild/childNodes/insertBefore), scoped to the nodes
// between the two page anchors; child removal goes through each node's own
// parentNode. contains/closest serve the entry's own keep/nesting checks.
function pageMarkerContainer(open, close, parent) {
  return {
    nodeType: 1,
    namespaceURI: parent.namespaceURI,
    get firstChild() {
      const node = open.nextSibling;
      return node === close ? null : node;
    },
    get childNodes() {
      const nodes = [];
      for (let node = open.nextSibling; node && node !== close; node = node.nextSibling) nodes.push(node);
      return nodes;
    },
    hasChildNodes() { return open.nextSibling !== close; },
    insertBefore(node, reference) { return parent.insertBefore(node, reference ?? close); },
    appendChild(node) { return parent.insertBefore(node, close); },
    removeChild(node) { return parent.removeChild(node); },
    contains(node) {
      for (let current = open.nextSibling; current && current !== close; current = current.nextSibling) {
        if (current === node || (current.contains && current.contains(node))) return true;
      }
      return false;
    },
    closest(selector) { return parent.closest ? parent.closest(selector) : null; },
  };
}
`
}

// Under next compat every hydrated island and the page mount wraps in the in-tree
// ClientErrorBoundary, NESTED INSIDE the implicit Suspense boundary islands must keep (a bare lazy()
// without Suspense kills the Preact tree). The boundary renders the route error.js and reset() soft-
// refreshes.
function wrapInBoundary(vnodeExpression: string, nextCompat?: boolean) {
  return nextCompat ? `pnextBoundary(${vnodeExpression})` : vnodeExpression
}

// Emits the per-route boundary helper referenced by wrapInBoundary. The Suspense wrapper is
// unconditional under compat - dropping it kills the tree. The boundary COMPONENT arrives through
// config (always set under compat, full tier or bare) rather than being imported here: this module is
// shared app-wide, so naming the full boundary would put the whole cluster - and its built-in 404 UI -
// on the first paint of every route in an app where any single route has an error file.
function clientBoundaryHelperSource(nextCompat?: boolean, suspense?: boolean) {
  if (!nextCompat) return ''
  // A suspense-free app (no lazy/use/async components anywhere in its client graph) keeps the error
  // boundary but drops the Suspense wrapper - and preact/compat with it.
  const boundary = `h(config.errorBoundary, {
      errorComponent: config.errorComponent,
      notFoundComponent: config.notFoundComponent,
      builtInNotFound: config.builtInNotFound,
      onReset: config.onBoundaryReset,
    }, vnode)`
  return `
  function pnextBoundary(vnode) {
    return ${suspense ? `h(Suspense, { fallback: null }, ${boundary})` : boundary};
  }
`
}

function hydrateIslandsSource({
  nextCompat,
  visibleIslands,
  deferredIslands,
  dev,
}: ClientRuntimeFacts) {
  const diagnostic = dev
    ? `
function diagnoseSkippedIslands() {
  for (const root of document.querySelectorAll('pnext-client[data-pnext-client]')) {
    if (root.__pnextLive) continue;
    const id = root.getAttribute('data-pnext-client');
    const island = id ? islandById.get(id) : undefined;
    const parent = nestedIslandParent(root);
    // A visible island is deliberately inert until intersection. A nested
    // island whose parent is still pending is likewise owned by that parent's
    // adoption pass, one parked in a capture holder is mid-adoption, and one the
    // claim pass adopted is no longer in the document. Everything else is a host
    // this route can never hydrate.
    if (island?.options?.load === 'visible') continue;
    if (root.closest('pnext-hole-capture')) continue;
    if (parent && !parent.__pnextLive) continue;
    const reason = island
      ? 'was materialized after its parent island mounted, outside any streamed hole this route can re-adopt'
      : 'has no entry in the client island manifest';
    console.warn('pnext: client island ' + (id ?? '<missing id>') + ' ' + reason);
  }
}
`
    : ''
  return `
const islandById = new Map(islands.map(island => [island.id, island]));
${lateIslandClaimSource()}${diagnostic}

// The mounted count is known as soon as the scan loop finishes, before any
// island module resolves — so the client shell can decide whether it owns the
// document without waiting behind island dynamic imports.
function scanIslands() {
  const pending = [];
  let mounted = 0;${
    // __PNEXT_ACTIONS__ is installed by the action client, which only a next
    // compat entry ever imports — the lookup is dead code anywhere else.
    nextCompat
      ? `
for (const island of islands) {
  if (island.Component) window.__PNEXT_ACTIONS__?.registerClientReference(island.id, island.Component);
}`
      : ''
  }
for (const island of islands) {
  for (const root of document.querySelectorAll(\`[data-pnext-client="\${island.id}"]\`)) {
    const parent = nestedIslandParent(root);
    if (parent) {
      pending.push(claimNestedIslandRoot(root, parent));
      continue;
    }
    // Already mounted (e.g. a re-scan after a streamed Suspense hole materialized new islands):
    // mount() stamps __pnextLive, so skipping these leaves the shell's live islands untouched. A root
    // preserved across a soft navigation is ALSO live, but carries the incoming placeholder (fresh SSR
    // props/children) the router stashed - it must re-render, not be skipped, or it keeps showing the
    // previous document's props.
    if (root.__pnextLive && !root.__pnextIncoming) continue;
    mounted += 1;${
      visibleIslands
        ? `
    // A preserved root (router grafted its live DOM across the soft nav) must
    // re-render immediately — its DOM still shows the previous route's children.
    if (island.load && island.options?.load === 'visible' && !root.__pnextIncoming) {
      observeVisibleIsland(root, island);
      continue;
    }`
        : ''
    }
    pending.push(mountIsland(root, island));
  }
}
  return { mounted, done: Promise.all(pending) };
}

function mountIsland(root, island) {
  return mountIslandOnce(root, () => mountIslandTree(root, island));
}

// Dev route entries each bundle their own copy of a shared island component; Preact diffs
// by identity, so mounting another entry's copy would remount every preserved island on
// navigation. First loaded instance per island id wins; a dev recompile full-reloads.
// NOTE: pinning a single component instance across dev route entries is NOT safe here:
// each dev entry carries its own module graph, and a pinned provider's context object
// would not match the consuming entry's copy (breaks e.g. QueryClientProvider). Module
// graphs must be deduped at the bundler level instead.
async function islandComponent(island) {
  return island.Component ?? await island.load();
}

async function mountIslandTree(root, island) {
  const Component = await islandComponent(island);${
    nextCompat
      ? `
  window.__PNEXT_ACTIONS__?.registerClientReference(island.id, Component);`
      : ''
  }
  const rawProps = root.getAttribute('data-pnext-props') ?? '{}';
  const incoming = root.__pnextIncoming;
  root.__pnextIncoming = undefined;
  // A streamed chunk promoted INSIDE this root's adopted children (the hard-loaded document
  // finishes streaming long after hydration) replaced DOM this preact tree owns without
  // telling it. Its vdom still names the fallback, so a diff would build the incoming
  // children BESIDE the promoted ones. Rebuild from the incoming DOM instead.
  const streamGrafted = root.__pnextStreamGrafted;
  root.__pnextStreamGrafted = undefined;
  if (incoming && root.__pnextLive === render && !streamGrafted) {
    // Preserved across a soft navigation: re-render in place with the incoming
    // document's props/children so component state survives while the routed
    // content under the island updates.
    const vnode = ${islandVNodeExpr('Component', 'await islandProps(rawProps, incoming, domChildren, h)', 'await staticChildren(incoming, island.id)', 'root', nextCompat)};
    render(${wrapInBoundary('vnode', nextCompat)}, root);
    pnextMountedRoots.add(root);
    return;
  }
  if (incoming) {
    // Preserved root owned by a foreign entry copy (dev bundles): this preact
    // instance can't diff its tree — restore the SSR children and mount fresh.
    root.replaceChildren(...incoming.childNodes);
    root.__pnextLive = undefined;
  }
  const vnode = ${islandVNodeExpr('Component', 'await islandProps(rawProps, root, domChildren, h)', 'await staticChildren(root, island.id)', 'root', nextCompat)};
  mount(root, ${wrapInBoundary('vnode', nextCompat)});
}

${
  visibleIslands
    ? `function observeVisibleIsland(root, island) {
  if (typeof IntersectionObserver === 'undefined') {
    void mountIsland(root, island);
    return;
  }

  const observer = new IntersectionObserver(entries => {
    if (!entries.some(entry => entry.isIntersecting)) return;
    observer.disconnect();
    void mountIsland(root, island);
  }, island.options);

  observer.observe(visibleTarget(root));
}
`
    : ''
}
async function staticChildren(root, id) {
  const node = root.querySelector(\`[${ISLAND_STATIC_CHILDREN_ATTRIBUTE}="\${id}"]\`);
  if (!node) return undefined;
  // A fallback <template> sidecar (children the component did not render on
  // the server): materialize any island markers inside its inert content,
  // adopt, then drop the sidecar so the mount starts from a clean host.
  const template = node.localName === 'template';
  const source = template ? node.content : node;
  if (template && window.__PNEXT_MATERIALIZE_CLIENT_ISLANDS__) {
    window.__PNEXT_MATERIALIZE_CLIENT_ISLANDS__(source);
  }
  const children = await domChildren(source);
  if (Page) {
    const pageRoot = source.querySelector?.('#pnext-page');
    if (pageRoot?.parentNode) pageRoot.replaceWith(...pageRoot.childNodes);
  }
  if (template) node.remove();
  return h('pnext-static-children', {
    ${JSON.stringify(ISLAND_STATIC_CHILDREN_ATTRIBUTE)}: id,
    style: { display: 'contents' },
  }, children);
}

async function domChildren(node) {
  const children = (await Promise.all(Array.from(node.childNodes, domNode)))
    .filter(child => child !== null && child !== undefined && child !== false);
  if (children.length === 0) return undefined;
  return children.length === 1 ? children[0] : children;
}

async function domNode(node) {
  if (node.nodeType === 3) return node.textContent;
  if (node.nodeType !== 1) return null;

  const element = node;
  if (element.localName === ${JSON.stringify(ISLAND_BOUNDARY_ERROR_ELEMENT)}) return pnextBoundaryErrorVNode(element);
  // The seam a late streamed graft re-adopts through (see holeSeamSource).
  if (element.localName === 'pnext-hole') {
    return h(PnextHole, { attrs: domProps(element) }, await domChildren(element));
  }
  if (element.localName === 'pnext-client') {
    const id = element.getAttribute('data-pnext-client');
    const island = id ? islandById.get(id) : undefined;
    if (!island) return h(element.localName, domProps(element), await domChildren(element));
    const rawProps = element.getAttribute('data-pnext-props') ?? '{}';
    const children = await staticChildren(element, island.id);${
      deferredIslands
        ? `
    if (!island.Component && island.options?.ssr === false) {
      return h(DeferredIsland, { load: island.load, props: parseIslandProps(rawProps), children });
    }`
        : ''
    }
    const Component = await islandComponent(island);
    return ${wrapInBoundary(islandVNodeExpr('Component', 'await islandProps(rawProps, element, domChildren, h)', 'children', 'element', nextCompat), nextCompat)};
  }

  if (Page && element.id === 'pnext-page') {
    return ${wrapInBoundary('h(Page, pageProps())', nextCompat)};
  }

  return h(element.localName, domProps(element), await domChildren(element));
}
`
}

// Helpers with no per-route state: they live once in the shared runtime module,
// not inside bootstrapRoute.
function islandHelpersSource({ deferredIslands, visibleIslands }: ClientRuntimeFacts) {
  return `
function pnextBoundaryErrorVNode(element) {
  const message = element.getAttribute(${JSON.stringify(ISLAND_BOUNDARY_ERROR_MESSAGE_ATTRIBUTE)}) ?? '';
  const digest = element.getAttribute(${JSON.stringify(ISLAND_BOUNDARY_ERROR_DIGEST_ATTRIBUTE)});
  return h(function PnextBoundaryError() {
    const error = new Error(message);
    if (digest) error.digest = digest;
    throw error;
  }, null);
}

function domProps(element) {
  const props = {};
  for (const attribute of element.attributes) props[attribute.name] = attribute.value;
  return props;
}

// The island host that owns this root's DOM, if any. A nested root is never
// mounted here: the parent adopts it, or claimNestedIslandRoot routes it through
// the parent's hole seam.
function nestedIslandParent(root) {
  return root.parentElement?.closest('pnext-client');
}
${holeSeamSource()}${
    visibleIslands
      ? `
function visibleTarget(root) {
  // The host's OWN box: hostMeasureSource delegates the patched one to the
  // parent, and IntersectionObserver never fires for a display:contents target.
  const rect = Element.prototype.getBoundingClientRect.call(root);
  if (rect.width || rect.height) return root;
  return root.parentElement ?? root;
}
`
      : ''
  }${mountOnceSource()}${
    deferredIslands
      ? `
function DeferredIsland({ load, props, children }) {
  const [Component, setComponent] = useState(null);
  useEffect(() => {
    let cancelled = false;
    void load().then(loaded => {
      if (!cancelled) setComponent(() => loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);
  return Component ? h(Component, props, children) : null;
}
`
      : ''
  }`
}

function hydrateClientShellSource(nextCompat?: boolean) {
  // The outermost component (index 0) is the client root layout: hand it the
  // adopted parallel-route slot props; inner layouts take bare children.
  const shell = `shell.reduceRight(
    (children, Component, index) => h(Component, index === 0 ? slotProps : null, children),
    page,
  )`

  return `
// A client root layout is re-rendered whole here, but its parallel-route slot
// props (nav/auth/…) are server-rendered subtrees that never serialized. Adopt
// each slot's preserved SSR DOM (marked with data-pnext-slot by the renderer)
// as the named prop on the outermost shell component so the slots survive.
async function collectRootSlotProps() {
  const props = {};
  for (const el of document.querySelectorAll('[data-pnext-slot]')) {
    if (el.parentElement?.closest('[data-pnext-slot]')) continue;
    const name = el.getAttribute('data-pnext-slot');
    if (!name) continue;
    props[name] = await domNode(el);
  }
  return props;
}

async function hydrateClientShell() {
  if (pnextIslandScan && pnextIslandScan.mounted > 0) return;
  // The streamed-chunk remount (remountRoute) re-runs every mount step; the
  // shell owns document.body, so re-rendering a shell that already hydrated
  // would blow away the live tree. mount() registers its root, and a soft
  // navigation clears the set, so this only skips a shell that is still live.
  if (pnextMountedRoots.has(document.body)) return;
  const pageRoot = document.getElementById('pnext-page');
  if (!pageRoot) return;
  const page = await domNode(pageRoot);
  const slotProps = await collectRootSlotProps();
  mount(document.body, ${wrapInBoundary(shell, nextCompat)});
}
`
}
