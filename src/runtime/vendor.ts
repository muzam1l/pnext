/**
 * The vendor pipeline: demand scheduling (dedup, package grouping, bounded parallelism), the
 * browser-ready-ESM fast path, and CommonJS export recovery.
 *
 * SCHEDULING. Every vendor demand - a module compile's import scan, an esbuild resolve callback, a
 * transitive dependency of another vendor bundle - enters through `vendorBundle`, so the three
 * duplication sources are handled once:
 *
 *  - IDENTICAL demands share one build. The dedup key is the ARTIFACT key (resolved entry file x
 *    target x conditions), never the importer's directory: the same package demanded from seven
 *    importers resolves to one entry and must compile once.
 *  - SIBLING SUBPATHS of one package share one build. Same-package specifiers are inlined rather
 *    than externalized (externalizing a CJS entry loses its named exports), so one build per subpath
 *    would re-parse the package's whole graph per subpath. Concurrently demanded subpaths become
 *    entries of ONE `splitting: true` build instead. DEMANDED subpaths only - see `joinVendorGroup`.
 *  - PARALLELISM is capped. Only demands from outside a running build queue: a demand raised by a
 *    build's own resolve callback would deadlock behind the slot its parent still holds.
 *
 *    Bypassing the queue is not enough on its own, because dedup and grouping both let a nested
 *    demand land on work SOMEONE ELSE already queued - the nested caller then waits for the queue
 *    while its own parent holds a slot, and once every slot is held that way nothing can move again.
 *    So queued work carries a ticket, and a nested demand that lands on one PROMOTES it out of the
 *    queue instead of waiting.
 *
 * COMMONJS EXPORT RECOVERY. Externalizing a CommonJS entry loses its named exports (esbuild emits
 * only `default`), which is why every CJS dependency is otherwise inlined into each importer's
 * vendor bundle. A facade restores them: it re-publishes the entry's names off that default object,
 * so the dependency becomes a normal external and is parsed once for the whole app.
 *
 * The name set has to be COMPLETE or the facade is worse than inlining, and a static scan alone is
 * not a safe gate. So the static set is completed by importing the built bundle and reading its
 * keys, and the result is gated by re-bundling the facade - esbuild fails both on a missing file and
 * on "No matching export in X for import Y", so a clean re-bundle proves the facade resolves and
 * exports everything it claims. Packages left with no names (default-only) stay inlined.
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from '../utils/esbuild'
import { isCommonJsModuleSource } from '../resolve/imports'
import { outputSpecifiers } from './module-transform'
import { esbuildEntryExportNames, isIdentifier, uniqueIdentifier } from '../utils/code'
import { cachedExistsSync } from '../utils/fs-cache'
import { traceEnabled, traceValue } from '../utils/trace-flags'
import { writeFileAtomic } from '../utils/fs'

// --------------------------------------------------------------------------
// demand scheduling
// --------------------------------------------------------------------------

export interface VendorGroupMember {
  specifier: string
  /** Resolved entry file for this subpath. */
  entry: string
  /** Artifact path, identical to the one a solo build of this subpath writes. */
  file: string
}

export interface VendorGroupPlan {
  key: string
  /** The demanded subpath — the only thing a group is ever allowed to compile. */
  member: VendorGroupMember
  /** `external` are siblings already on disk: referenced, never re-parsed. */
  build: (
    members: VendorGroupMember[],
    external: readonly VendorGroupMember[],
    nested: boolean,
  ) => Promise<void>
}

export interface VendorBuildPlan {
  /** Artifact key — the ONLY dedup identity. Importer directories never enter it. */
  key: string
  file: string
  /** Disk cache / no-compile fast paths; a returned path settles the demand. */
  prepare: () => Promise<string | undefined>
  /** `nested` marks a build raised from inside another: it may never wait. */
  buildOne: (nested: boolean) => Promise<string>
  group?: VendorGroupPlan
}

/**
 * Something a demand can be waiting on that has not started yet. A nested demand that lands on one MUST be
 * able to pull it out of the queue - see `promoteVendorWork`.
 */
interface VendorPromotable {
  /** Set only while the work sits in the queue; cleared once it runs. */
  promote?: () => void
}

interface PendingBundle extends VendorPromotable {
  promise: Promise<string>
  result?: string
}

interface VendorGroupState {
  /** Demanded, not yet compiled. */
  pending: Map<string, VendorGroupMember>
  /** Compiled by this group. */
  produced: Map<string, VendorGroupMember>
  /** Handed back to the single-bundle path — a round with nothing to share. */
  solo: Map<string, VendorGroupMember>
  round?: Promise<void>
  /** The current round's queue ticket, while it is still waiting for a slot. */
  ticket?: VendorPromotable
  rounds: number
  /** Once closed (failed, or out of rounds) every member builds alone. */
  closed: boolean
}

const pendingBundles = new Map<string, PendingBundle>()
const vendorGroups = new Map<string, VendorGroupState>()

// §4e worker sweep (1/2/4/6/7/8/12 → 3.96/2.03/1.68/1.62/1.55/1.94/1.98 s):
// 6-7 concurrent builds is the optimum and going past core count regresses.
const VENDOR_CONCURRENCY = Math.max(
  1,
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  Number(process.env.PNEXT_VENDOR_CONCURRENCY) || 7,
)
/**
 * Ceiling on builds that have STARTED and not finished, which is a different resource from the
 * compute slots: a build waiting on a dependency gives its slot back (see `outsideVendorSlot`) but
 * keeps its bundler open, and open bundlers are what peak RSS is made of. Wall time keeps improving
 * as this rises and RSS grows with it, so the value is a choice, not an optimum - but the ceiling is
 * absolute, so memory stays bounded however big the app gets.
 */
const VENDOR_OPEN_LIMIT = Math.max(
  VENDOR_CONCURRENCY,
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  Number(process.env.PNEXT_VENDOR_OPEN_LIMIT) || VENDOR_CONCURRENCY * 8,
)
let vendorActive = 0
let vendorOpen = 0
/** Queued starts; each returns whether it actually took the slot. */
const vendorQueue: (() => boolean)[] = []

/**
 * Run a vendor build under the concurrency cap. Nested builds - raised by a running build's own resolve
 * callback - bypass the queue: their parent holds a slot until they finish, so making them wait for one
 * deadlocks. They still count as active, which is what backs the outer demands off.
 *
 * `ticket` is how work that DID queue can still be pulled forward: a nested demand that dedups onto it would
 * otherwise wait behind the cap while its own parent holds a slot - the deadlock this seam exists to prevent.
 */
function withVendorSlot<T>(
  nested: boolean,
  label: string,
  task: () => Promise<T>,
  ticket?: VendorPromotable,
): Promise<T> {
  return watchVendorWait(
    nested ? 'slot-nested' : 'slot',
    label,
    new Promise<T>((resolve, reject) => {
      let started = false
      const run = () => {
        if (started) return false
        started = true
        if (ticket) ticket.promote = undefined
        vendorActive += 1
        vendorOpen += 1
        const span = openVendorSpan(label, nested)
        task()
          .then(resolve, reject)
          .finally(() => {
            vendorActive -= 1
            vendorOpen -= 1
            closeVendorSpan(span)
            drainVendorQueue()
          })
        return true
      }
      if (nested || vendorActive < VENDOR_CONCURRENCY) run()
      else {
        if (ticket) ticket.promote = run
        vendorQueue.push(run)
      }
    }),
  )
}

/**
 * Give the slot back for the duration of `task`. A build that is waiting - on a nested dependency's compile,
 * or on another build to finish discovering their shared package's shape - is holding a worker while burning
 * nothing, which caps real parallelism at the depth of the dependency chain rather than at the worker count.
 */
export async function outsideVendorSlot<T>(task: () => Promise<T>): Promise<T> {
  // At the open ceiling, keeping the slot IS the back-pressure: yielding it
  // would only admit one more bundler to sit open alongside this one.
  if (vendorOpen >= VENDOR_OPEN_LIMIT) return task()
  vendorActive -= 1
  drainVendorQueue()
  try {
    return await task()
  } finally {
    vendorActive += 1
  }
}

/** Hand the freed slot to the first queued build that has not been promoted. */
function drainVendorQueue() {
  while (vendorActive < VENDOR_CONCURRENCY) {
    const next = vendorQueue.shift()
    if (!next) return
    if (next()) return
  }
}

/**
 * A nested demand landed on work that is still queued: run it now. Waiting is not an option - the caller's
 * own build holds a slot until this resolves, so every slot can end up held by a build waiting for the queue
 * to move.
 */
function promoteVendorWork(work: VendorPromotable | undefined) {
  work?.promote?.()
}

// --------------------------------------------------------------------------
// saturation trace (PNEXT_TRACE=vendor)
// --------------------------------------------------------------------------

/** One build's occupancy of a worker slot — the active-builds-over-time input. */
export interface VendorBuildSpan {
  label: string
  nested: boolean
  startMs: number
  endMs?: number
}

const vendorSpans: VendorBuildSpan[] = []

const vendorTracing = () => traceEnabled('vendor')

function openVendorSpan(label: string, nested: boolean) {
  if (!vendorTracing()) return undefined
  const span: VendorBuildSpan = { label, nested, startMs: performance.now() }
  vendorSpans.push(span)
  return span
}

function closeVendorSpan(span: VendorBuildSpan | undefined) {
  if (span) span.endMs = performance.now()
}

// --------------------------------------------------------------------------
// TEMPORARY JSONL workload trace (PNEXT_TRACE=vendor=<path>)
// --------------------------------------------------------------------------

// A path-valued `vendor` scope appends build/request/edge rows for
// bench/tools/vendor-analyze.ts; a bare `vendor` means the in-memory spans only.
const vendorTraceFile = (() => {
  const value = traceValue('vendor')
  if (!value || !(value.includes('/') || value.endsWith('.jsonl'))) return undefined
  return path.resolve(value)
})()

let vendorTraceDirReady = false
let vendorTraceSeq = 0

export const vendorTraceEnabled = () => vendorTraceFile !== undefined

export const nextVendorTraceSeq = () => vendorTraceSeq++

/** Append one JSONL row, stamped with the wall clock the analyzer unions on. */
export function vendorTraceRow(row: Record<string, unknown>) {
  if (!vendorTraceFile) return
  try {
    if (!vendorTraceDirReady) {
      mkdirSync(path.dirname(vendorTraceFile), { recursive: true })
      vendorTraceDirReady = true
    }
    appendFileSync(vendorTraceFile, `${JSON.stringify({ ...row, w: Date.now() })}\n`)
  } catch {
    // Tracing must never fail a build.
  }
}

/** Whether this artifact key already has an in-flight or settled build. */
export function vendorBundleMemHit(key: string) {
  return pendingBundles.has(key)
}

// --------------------------------------------------------------------------
// stall watchdog
// --------------------------------------------------------------------------

/**
 * Every vendor await this file performs, so a stalled pipeline can name what it is parked on -
 * without it, a promise that never settles is indistinguishable from slow work. Entries are removed
 * on settle, so a healthy pipeline holds none.
 */
const vendorWaits = new Map<number, { label: string; kind: string; startMs: number }>()
let vendorWaitSeq = 0

const VENDOR_STALL_MS = Math.max(
  0,
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  Number(process.env.PNEXT_VENDOR_STALL_MS ?? 20_000),
)

/** Waits older than the threshold, oldest first — the stall report's payload. */
function stalledVendorWaits(now: number) {
  return [...vendorWaits.values()]
    .filter(wait => now - wait.startMs >= VENDOR_STALL_MS)
    .sort((a, b) => a.startMs - b.startMs)
}

let stallTimer: ReturnType<typeof setInterval> | undefined

function reportVendorStall() {
  const now = performance.now()
  const stalled = stalledVendorWaits(now)
  if (stalled.length === 0) return
  const trace = vendorPipelineTrace()
  console.error(
    [
      `PNext vendor pipeline stalled: ${stalled.length} wait(s) over ${Math.round(VENDOR_STALL_MS)}ms.`,
      `  slots active=${trace.active}/${trace.concurrency} open=${trace.open}/${trace.openLimit} queued=${trace.queued}`,
      `  groups=${vendorGroups.size} unsettled bundles=${trace.unsettled.length}`,
      ...stalled
        .slice(0, 20)
        .map(w => `  [${w.kind}] ${w.label} waiting ${Math.round(now - w.startMs)}ms`),
      ...(trace.unsettled.length
        ? [`  unsettled: ${trace.unsettled.slice(0, 20).join(', ')}`]
        : []),
      `  set PNEXT_VENDOR_STALL_MS=0 to silence, PNEXT_VENDOR_GROUP=0 to bisect grouping.`,
    ].join('\n'),
  )
}

/**
 * Register `promise` as a scheduler wait. Purely observational — it never
 * changes what resolves — so arming it cannot itself introduce a stall.
 */
function watchVendorWait<T>(kind: string, label: string, promise: Promise<T>): Promise<T> {
  if (VENDOR_STALL_MS <= 0) return promise
  const id = vendorWaitSeq++
  vendorWaits.set(id, { kind, label, startMs: performance.now() })
  if (!stallTimer) {
    stallTimer = setInterval(reportVendorStall, Math.max(1000, VENDOR_STALL_MS))
    // Never keep the process alive for the watchdog alone.
    stallTimer.unref?.()
  }
  return promise.finally(() => {
    vendorWaits.delete(id)
    if (vendorWaits.size === 0 && stallTimer) {
      clearInterval(stallTimer)
      stallTimer = undefined
    }
  })
}

/** Scheduler waits currently outstanding — for tests and external diagnostics. */
export function vendorWaitReport() {
  const now = performance.now()
  return [...vendorWaits.values()].map(w => ({
    kind: w.kind,
    label: w.label,
    waitedMs: now - w.startMs,
  }))
}

/**
 * Scheduler state and every traced build span. Spans are what the worker-
 * saturation trace is computed from; the unsettled list is what a stuck
 * pipeline is diagnosed from.
 */
export function vendorPipelineTrace() {
  return {
    concurrency: VENDOR_CONCURRENCY,
    openLimit: VENDOR_OPEN_LIMIT,
    active: vendorActive,
    open: vendorOpen,
    queued: vendorQueue.length,
    spans: vendorSpans,
    unsettled: [...pendingBundles]
      .filter(([, pending]) => pending.result === undefined)
      .map(([key]) => key),
  }
}

/** The single funnel every vendor demand goes through. */
export function vendorBundle(plan: VendorBuildPlan, nested = false): Promise<string> {
  const existing = pendingBundles.get(plan.key)
  if (existing) {
    // Dedup is what makes this a deadlock risk: the demand we join may still be
    // queued, and a nested caller cannot afford to wait for the queue to move.
    if (nested) promoteVendorWork(existing)
    return watchVendorWait(nested ? 'dedup-nested' : 'dedup', plan.key, existing.promise)
  }
  const pending: PendingBundle = { promise: undefined as unknown as Promise<string> }
  pending.promise = runVendorDemand(plan, nested, pending).then(
    file => {
      pending.result = file
      return file
    },
    error => {
      // A write racing a concurrent `.pnext` wipe rejects; evict so the next
      // demand retries instead of re-awaiting a permanently failed promise.
      pendingBundles.delete(plan.key)
      throw error
    },
  )
  pendingBundles.set(plan.key, pending)
  return pending.promise
}

async function runVendorDemand(plan: VendorBuildPlan, nested: boolean, ticket: VendorPromotable) {
  const ready = await plan.prepare()
  if (ready !== undefined) return ready
  if (plan.group && (await joinVendorGroup(plan.group, nested, ticket))) return plan.file
  return withVendorSlot(nested, plan.key, () => plan.buildOne(nested), ticket)
}

/**
 * A round waits this long before it snapshots the group's demands. Sibling subpaths arrive in bursts - one
 * module's import scan, one bundle's resolve callbacks - and the window is what turns a burst into a single
 * build instead of one growth rebuild per straggler.
 *
 * Every demand pays it before it can even learn it has no siblings, and it is a timer on the one JS thread
 * the concurrent bundlers already saturate with plugin IPC, so the real wait is bounded below by this rather
 * than by it. `PNEXT_VENDOR_GROUP_WINDOW_MS` is the bisect seam, read per round so
 * tests can widen it after module load.
 */
function vendorGroupWindowMs() {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const override = Number(process.env.PNEXT_VENDOR_GROUP_WINDOW_MS)
  return Number.isFinite(override) && override >= 0 ? override : 5
}

/**
 * A group re-parses the package graph once per round, so an unbounded trickle
 * of stragglers must not turn into an unbounded chain of rebuilds. Past the
 * bound the package goes back to a build per subpath.
 */
const MAX_VENDOR_GROUP_ROUNDS = 4

/**
 * Escape hatch: `PNEXT_VENDOR_GROUP=0` puts every subpath back on its own build. Grouping is the one part of
 * the pipeline that changes what a single demand compiles, so it is also the one worth being able to switch
 * off while bisecting a slow or stuck compile.
 */
function vendorGroupingEnabled() {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  return process.env.PNEXT_VENDOR_GROUP !== '0'
}

/**
 * Attach the demand to its package's group and return whether the group compiled its artifact.
 *
 * Entries are the subpaths ACTUALLY DEMANDED, never the ones the package publishes: hub packages
 * export per-framework adapter subpaths whose entries import frameworks the app does not use (and
 * may not even have installed), so compiling the published set fans one demand out into hundreds of
 * foreign builds. A later sibling therefore grows the entry set and triggers another round;
 * artifacts from earlier rounds stay valid and are referenced as externals, so a growth round costs
 * what that sibling's own build would have cost.
 */
async function joinVendorGroup(group: VendorGroupPlan, nested: boolean, ticket: VendorPromotable) {
  if (!vendorGroupingEnabled()) return false
  let state = vendorGroups.get(group.key)
  if (!state) {
    state = {
      pending: new Map(),
      produced: new Map(),
      solo: new Map(),
      rounds: 0,
      closed: false,
    }
    vendorGroups.set(group.key, state)
  }
  const specifier = group.member.specifier
  if (state.closed || state.solo.has(specifier)) return false
  // A demand raised from INSIDE a running round cannot wait for that round:
  // the round is waiting on this demand. Build it alone, and leave it on file
  // so the group externalizes the artifact instead of re-parsing it.
  if (nested && state.round && !state.pending.has(specifier)) {
    state.solo.set(specifier, group.member)
    return false
  }
  state.pending.set(specifier, group.member)
  // While this demand waits on a shared round, promoting IT has to promote the
  // round — that is the only work its result depends on.
  const groupState = state
  ticket.promote = () => promoteVendorWork(groupState.ticket)
  try {
    while (!state.produced.has(specifier)) {
      if (state.closed || state.solo.has(specifier)) return false
      if (nested) promoteVendorWork(state.ticket)
      await watchVendorWait(
        nested ? 'group-round-nested' : 'group-round',
        `${group.key} :: ${specifier}`,
        runVendorGroupRound(group, state, nested),
      )
    }
  } finally {
    ticket.promote = undefined
  }
  return true
}

function runVendorGroupRound(
  group: VendorGroupPlan,
  state: VendorGroupState,
  nested: boolean,
): Promise<void> {
  if (!state.round) {
    state.round = vendorGroupRound(group, state, nested).finally(() => {
      state.round = undefined
      state.ticket = undefined
    })
  }
  return state.round
}

async function vendorGroupRound(group: VendorGroupPlan, state: VendorGroupState, nested: boolean) {
  await new Promise(resolve => setTimeout(resolve, vendorGroupWindowMs()))
  const members = [...state.pending.values()]
  if (members.length === 0) return
  // A lone subpath with no sibling to share a graph with is the single-bundle
  // path plus chunk plumbing. Hand it back — and keep it on file, so a sibling
  // demanded later externalizes its artifact instead of re-parsing it.
  if (members.length === 1 && state.produced.size === 0) {
    const only = members[0]!
    state.pending.delete(only.specifier)
    state.solo.set(only.specifier, only)
    return
  }
  state.rounds += 1
  const external = [...state.produced.values(), ...state.solo.values()]
  const ticket: VendorPromotable = {}
  state.ticket = ticket
  try {
    await withVendorSlot(nested, group.key, () => group.build(members, external, nested), ticket)
    for (const member of members) {
      state.pending.delete(member.specifier)
      state.produced.set(member.specifier, member)
    }
  } catch {
    // Grouping is an optimization: one bad sibling must not fail the demand,
    // so the group gives up and every member falls back to its own build.
    state.closed = true
  }
  if (state.rounds >= MAX_VENDOR_GROUP_ROUNDS) state.closed = true
}

// --------------------------------------------------------------------------
// pre-planned builds: enqueued without an awaiter, drained at route-module eval
// --------------------------------------------------------------------------

const preplanBuilds = new Set<Promise<unknown>>()
let preplanBuildError: unknown

export function trackPreplanBuild(promise: Promise<unknown>) {
  const tracked = promise.catch(error => {
    preplanBuildError ??= error
  })
  preplanBuilds.add(tracked)
  void tracked.finally(() => preplanBuilds.delete(tracked))
}

/** The one join point: nothing evaluates until every enqueued build settles. */
export async function drainPreplanBuilds() {
  while (preplanBuilds.size > 0) {
    await watchVendorWait('preplan-drain', 'preplan', Promise.allSettled([...preplanBuilds]))
  }
  if (preplanBuildError !== undefined) {
    const error = preplanBuildError
    preplanBuildError = undefined
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw error
  }
}

/**
 * Forget a bundle whose artifact turned out to be gone (a `pnext build` wiping
 * `.pnext` under a running server). Only the caller holding the stale result
 * evicts, so concurrent demands join the one rebuild instead of racing.
 */
export function dropVendorBundle(key: string, stale: string) {
  const pending = pendingBundles.get(key)
  if (pending?.result === stale) pendingBundles.delete(key)
}

/** Forget a group whose artifacts were wiped, so the retry rebuilds them. */
export function dropVendorGroup(key: string) {
  vendorGroups.delete(key)
}

export function clearVendorPipeline() {
  pendingBundles.clear()
  vendorGroups.clear()
  preplanBuilds.clear()
  preplanBuildError = undefined
  esmDistFiles.clear()
  vendorContentIds.clear()
  vendorSpans.length = 0
  // In-flight waits belong to the pipeline that was just dropped; leaving them
  // registered would have the watchdog report a stall that no longer exists.
  vendorWaits.clear()
  if (stallTimer) {
    clearInterval(stallTimer)
    stallTimer = undefined
  }
}

// --------------------------------------------------------------------------
// content-addressed artifacts
// --------------------------------------------------------------------------

/** Artifact (or facade) file -> content id of the bytes it resolves to. */
const vendorContentIds = new Map<string, string>()

export function vendorContentId(file: string) {
  return vendorContentIds.get(file)
}

export function noteVendorContentId(file: string, id: string) {
  vendorContentIds.set(file, id)
}

/**
 * Vendor hrefs replaced by the content id they point at. An href with no id yet
 * keeps its path, which keeps the artifact layer-specific — never the reverse.
 */
export function canonicalVendorCode(code: string) {
  return rewriteEmittedRefs(code, ref => {
    if (!ref.specifier.startsWith('file:')) return undefined
    const id = vendorContentIds.get(fileURLToPath(ref.specifier))
    return id ? `pnext-content:${id}` : undefined
  })
}

// --------------------------------------------------------------------------
// plugin-free builds: emitted-code surgery
// --------------------------------------------------------------------------

/**
 * A specifier as it appears in EMITTED code. The plugin-free vendor build lets esbuild externalize by pattern
 * and settles what each reference means here instead - the resolve callbacks were what serialized the bundler
 * and cost a JS bridge hop per file.
 */
export interface EmittedRef {
  specifier: string
  /** esbuild emits an external `require()` as `__require("x")`. */
  require: boolean
  /** Offsets of the specifier text itself, quotes excluded. */
  start: number
  end: number
}

// Import/export statements, dynamic imports, and (esbuild's) require calls.
const EMITTED_IMPORT_REF =
  /(?:^|[\s;}])(?:import|export)\s*(?:[\w$*{}\s,]*?\bfrom\s*)?(["'])([^"'\n]*)\1/g
const EMITTED_CALL_REF = /(?:^|[^\w$.])(?:(__)?require|import)\s*\(\s*(["'])([^"'\n]*)\2\s*\)/g

/** Every bare-specifier reference the emitted code still carries. */
export function emittedRefs(code: string): EmittedRef[] {
  const refs: EmittedRef[] = []
  const seen = new Set<number>()
  for (const match of code.matchAll(EMITTED_IMPORT_REF)) {
    const start = match.index + match[0].length - match[2]!.length - 1
    if (seen.has(start)) continue
    seen.add(start)
    refs.push({ specifier: match[2]!, require: false, start, end: start + match[2]!.length })
  }
  for (const match of code.matchAll(EMITTED_CALL_REF)) {
    const value = match[3]!
    const start = match.index + match[0].lastIndexOf(value)
    if (seen.has(start)) continue
    seen.add(start)
    refs.push({
      specifier: value,
      require: match[0].includes('require'),
      start,
      end: start + value.length,
    })
  }
  return refs.sort((a, b) => a.start - b.start)
}

/**
 * Repoint emitted references. `replace` returns the new specifier, or undefined
 * to leave one alone — a bare package name the runtime resolves itself.
 */
export function rewriteEmittedRefs(code: string, replace: (ref: EmittedRef) => string | undefined) {
  let out = ''
  let cursor = 0
  for (const ref of emittedRefs(code)) {
    const next = replace(ref)
    if (next === undefined || next === ref.specifier) continue
    out += code.slice(cursor, ref.start) + next.replace(/\\/g, '\\\\')
    cursor = ref.end
  }
  return cursor === 0 ? code : out + code.slice(cursor)
}

/**
 * Export names an emitted module publishes, or undefined when the set cannot be
 * proven (a star re-export). Used to check that a repointed reference can
 * actually bind what its importer asks for.
 */
export function emittedExportNames(code: string): Set<string> | undefined {
  const names = new Set<string>()
  if (/(^|\n)\s*export\s*\*\s*from/.test(code)) return undefined
  for (const match of code.matchAll(/(^|[\s;}])export\s*\{([^}]*)\}/g)) {
    for (const entry of match[2]!.split(',')) {
      const name = entry
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim()
      if (name) names.add(name)
    }
  }
  for (const match of code.matchAll(
    /(^|[\s;}])export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    names.add(match[2]!)
  }
  if (/(^|[\s;}])export\s+default[\s({[]/.test(code)) names.add('default')
  return names
}

/**
 * Republish a bundled CommonJS entry's named exports off its default export.
 * Applied to the bundle itself (not a separate module) for the inlined case.
 */
export function addCommonJsNamedExports(code: string) {
  if (hasNonDefaultExport(code)) return code
  const names = [...new Set([...commonJsExportNames(code), ...esbuildEntryExportNames(code)])]
    .filter(name => name !== 'default' && name !== '__esModule')
    .sort()
  if (names.length === 0) return code
  const defaultExport = /(^|\n)export default ([^;\n]+);/.exec(code)
  if (!defaultExport?.[2]) return code
  const defaultName = uniqueIdentifier(code, '__pnext_cjs_default')
  const usedNames = [defaultName]
  const bindings = names.map(name => {
    const localName = uniqueIdentifier(code, `__pnext_cjs_export_${name}`, ...usedNames)
    usedNames.push(localName)
    return { name, localName }
  })
  const namedBindings = bindings
    .map(({ name, localName }) => `const ${localName} = ${defaultName}[${JSON.stringify(name)}];`)
    .join('\n')
  const namedExports = bindings.map(({ name, localName }) => `${localName} as ${name}`).join(', ')
  return code.replace(
    defaultExport[0],
    `${defaultExport[1]}const ${defaultName} = ${defaultExport[2]};\nexport default ${defaultName};\n${namedBindings}\nexport { ${namedExports} };\n`,
  )
}

function hasNonDefaultExport(code: string) {
  return /(^|\n)export\s+(?:\*|\{[^}]*\b(?!default\b)[A-Za-z_$][\w$]*\b|(?:const|let|var|function|class)\s+)/.test(
    code,
  )
}

export function commonJsExportNames(code: string) {
  return [
    ...new Set([
      ...[...code.matchAll(/\bexports\.([A-Za-z_$][\w$]*)\s*=/g)].map(match => match[1]),
      ...[
        ...code.matchAll(/\bObject\.defineProperty\(\s*exports\s*,\s*["']([A-Za-z_$][\w$]*)["']/g),
      ].map(match => match[1]),
    ]),
  ]
    .filter((name): name is string => Boolean(name && name !== '__esModule' && isIdentifier(name)))
    .sort()
}

/**
 * The gate every plugin-free artifact has to pass before it is published: esbuild re-bundles the emitted
 * entry, so its own chunk graph has to resolve and its syntax has to be real, and every reference the
 * post-pass repointed has to exist on disk. `PNEXT_VENDOR_VERIFY=deep` additionally pulls those references
 * INTO the re-bundle, which is what makes esbuild check that each one exports the names its importer binds -
 * the audit configuration. Returns a failure reason, or undefined when the artifact is clean.
 */
export async function verifyVendorArtifact(
  file: string,
  code: string,
  repointed: ReadonlyMap<string, string>,
  /** Shared chunks of the same build, which are not on disk yet. */
  chunks: ReadonlyMap<string, string> = new Map(),
) {
  for (const [specifier, target] of repointed) {
    if (!existsSync(target)) return `repointed ${specifier} -> missing ${target}`
  }
  // Nothing was rewritten and nothing was split out: this is esbuild's own
  // output, unedited, and there is no claim left for a re-bundle to check.
  if (repointed.size === 0 && chunks.size === 0) return undefined
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const mode = process.env.PNEXT_VENDOR_VERIFY
  if (mode === 'off') return undefined
  const deep = mode === 'deep'
  const outDir = path.dirname(file)
  try {
    await build({
      stdin: { contents: code, resolveDir: outDir, sourcefile: file, loader: 'js' },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      packages: 'external',
      logLevel: 'silent',
      plugins: [
        {
          name: 'pnext-vendor-verify',
          setup(verify) {
            // The entry's own chunks are still in memory — verification runs
            // before anything is published, so nothing half-written is ever
            // readable by a concurrent demand.
            verify.onResolve({ filter: /^\.\.?\// }, args => {
              const resolved = path.resolve(args.resolveDir, args.path)
              return chunks.has(resolved)
                ? { path: resolved, namespace: 'pnext-vendor-chunk' }
                : undefined
            })
            verify.onLoad({ filter: /.*/, namespace: 'pnext-vendor-chunk' }, args => ({
              contents: chunks.get(args.path),
              loader: 'js',
              resolveDir: path.dirname(args.path),
            }))
            verify.onResolve({ filter: /^file:/ }, args => {
              const resolved = fileURLToPath(args.path)
              // Deep: one level in (esbuild then checks the export names), and
              // only from the artifact itself — its dependencies' own externals
              // stay external, so the closure cannot run away.
              const inside = args.importer === file || args.importer.startsWith(outDir)
              return { path: resolved, external: !deep || !inside }
            })
          },
        },
      ],
    })
  } catch (error) {
    return (error instanceof Error ? error.message : String(error))
      .replace(/\s+/g, ' ')
      .slice(0, 300)
  }
  return undefined
}

// --------------------------------------------------------------------------
// browser-ready ESM dist fast path
// --------------------------------------------------------------------------

/**
 * Some packages already ship exactly what the vendor pass would produce: an ESM dist whose modules only
 * import each other by relative path. Compiling those is pure waste - nothing in the build would change them,
 * because none of our plugins have anything to claim. Copy the closure instead, preserving the relative
 * layout so its specifiers keep resolving, and skip esbuild entirely.
 *
 * The predicate is deliberately strict: ONE bare specifier, one asset import, or one CommonJS shape anywhere
 * in the closure means a plugin could have fired, so the package goes back to the bundler. A false negative
 * costs a compile; a false positive ships wrong code.
 */
const MAX_ESM_DIST_FILES = 4096
const ESM_DIST_ENTRY_MARKER = 'entry'

const esmDists = new Map<string, Promise<string | undefined>>()

export function copyBrowserReadyEsmDist(
  entry: string,
  distDir: string,
): Promise<string | undefined> {
  // One copy per destination: a second copier would rewrite files the first has
  // already published, and copyFile is not atomic against a concurrent import.
  let dist = esmDists.get(distDir)
  if (!dist) {
    dist = copyBrowserReadyEsmDistUncached(entry, distDir)
    esmDists.set(distDir, dist)
  }
  // A `pnext build` wiping `.pnext` under this server deletes published copies out from under the
  // memo; a bundle repointed at a vanished dist 500s on every import. Re-verify against disk and
  // re-copy - the same only-the-stale-holder-evicts rule dropVendorBundle applies to bundles.
  return dist.then(published => {
    if (published === undefined || existsSync(published)) return published
    if (esmDists.get(distDir) === dist) esmDists.delete(distDir)
    return copyBrowserReadyEsmDist(entry, distDir)
  })
}

async function copyBrowserReadyEsmDistUncached(entry: string, distDir: string) {
  const existing = await readFile(path.join(distDir, ESM_DIST_ENTRY_MARKER), 'utf8').catch(
    () => undefined,
  )
  // The marker without its entry is a half-deleted copy: fall through and rewrite it.
  if (existing !== undefined && existsSync(path.join(distDir, existing))) {
    return path.join(distDir, existing)
  }

  const closure = await collectBrowserReadyEsmClosure(entry)
  if (!closure) return undefined
  // Copies keep their offsets relative to the shallowest directory the closure
  // touches, which is what makes every `../` in it still land on its target.
  const base = commonAncestorDir([...closure])
  const relative = (file: string) => path.relative(base, file)
  await Promise.all(
    [...closure].map(async file => {
      const target = path.join(distDir, relative(file))
      await mkdir(path.dirname(target), { recursive: true })
      await copyFile(file, target)
    }),
  )
  await writeFileAtomic(path.join(distDir, ESM_DIST_ENTRY_MARKER), relative(entry))
  return path.join(distDir, relative(entry))
}

const ESM_DIST_EXTENSIONS = new Set(['.js', '.mjs'])

/**
 * Per-FILE verdict, memoized: the predicate runs once per demanded artifact and
 * a package's subpaths share almost all of their closure, so the same few
 * thousand files were re-read, re-regexed and re-`existsSync`ed per subpath.
 * `undefined` means "not browser-ready", which fails the whole closure.
 */
const esmDistFiles = new Map<string, Promise<string[] | undefined>>()

function browserReadyEsmImports(file: string) {
  let entry = esmDistFiles.get(file)
  if (!entry) {
    entry = browserReadyEsmImportsUncached(file)
    esmDistFiles.set(file, entry)
  }
  return entry
}

async function browserReadyEsmImportsUncached(file: string) {
  if (!ESM_DIST_EXTENSIONS.has(path.extname(file))) return undefined
  const source = await readFile(file, 'utf8').catch(() => undefined)
  if (source === undefined) return undefined
  // `use cache` would need the post-bundle source transforms this path skips.
  if (
    isCommonJsModuleSource(source, file) ||
    /\brequire\s*\(|\bmodule\.exports\b/.test(source) ||
    source.includes('use cache')
  ) {
    return undefined
  }
  const imports: string[] = []
  for (const found of outputSpecifiers(source)) {
    const specifier = found.value
    if (!specifier.startsWith('.')) return undefined
    const resolved = resolveEsmDistImport(path.dirname(file), specifier)
    if (!resolved) return undefined
    imports.push(resolved)
  }
  return imports
}

async function collectBrowserReadyEsmClosure(entry: string) {
  const closure = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (closure.has(file)) continue
    if (closure.size >= MAX_ESM_DIST_FILES) return undefined
    closure.add(file)
    const imports = await browserReadyEsmImports(file)
    if (!imports) return undefined
    queue.push(...imports)
  }
  // A single-file "closure" is a re-export shim or a stub; bundling it is
  // already free, and the marker directory would cost more than it saves.
  return closure.size > 1 ? closure : undefined
}

/** Relative resolution limited to what a browser would do: exact file first. */
function resolveEsmDistImport(fromDir: string, specifier: string) {
  const base = path.resolve(fromDir, specifier)
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, path.join(base, 'index.js')]) {
    if (ESM_DIST_EXTENSIONS.has(path.extname(candidate)) && cachedExistsSync(candidate)) {
      return candidate
    }
  }
  return undefined
}

function commonAncestorDir(files: string[]) {
  const segmentLists = files.map(file => path.dirname(file).split(path.sep))
  const shortest = Math.min(...segmentLists.map(segments => segments.length))
  const common: string[] = []
  for (let index = 0; index < shortest; index += 1) {
    const segment = segmentLists[0]![index]!
    if (segmentLists.some(segments => segments[index] !== segment)) break
    common.push(segment)
  }
  return common.join(path.sep) || path.sep
}

// --------------------------------------------------------------------------
// facades
// --------------------------------------------------------------------------

const REEXPORT_CALL = /\bmodule\.exports\s*=\s*require\(\s*(['"])([^'"]+)\1\s*\)/

/**
 * Cheap pre-filter: can this CommonJS entry plausibly carry named exports? A
 * package whose entry publishes nothing but `module.exports = fn` is
 * default-only and never worth building separately just to discard the facade.
 * Re-exporting entries (`module.exports = require('./lib')`) are followed one
 * level, which is where most packages' real export list lives.
 */
export async function cjsEntryMayHaveNamedExports(entry: string) {
  const source = await readFile(entry, 'utf8').catch(() => undefined)
  if (source === undefined) return false
  if (commonJsExportNames(source).length > 0) return true
  const reexport = REEXPORT_CALL.exec(source)
  const target = reexport?.[2]
  if (!target?.startsWith('.')) return false
  for (const candidate of [target, `${target}.js`, path.join(target, 'index.js')]) {
    const file = path.resolve(path.dirname(entry), candidate)
    if (!existsSync(file) || !file.endsWith('.js')) continue
    const inner = await readFile(file, 'utf8').catch(() => undefined)
    if (inner && commonJsExportNames(inner).length > 0) return true
  }
  return false
}

/**
 * Facade shape, bumped whenever this file changes what it emits. The artifact is content-keyed to the
 * BUNDLE, so without it a pnext release that fixes the facade keeps reusing the one the previous release
 * wrote - and deleting the stale files by hand dangles every importer that baked the name in, which only a
 * full cache wipe recovers from. A new key sidesteps both: the old facade stays on disk for whoever still
 * imports it, and every new compile names the new one.
 */
const FACADE_GENERATOR = 'v3'

/** Marker written beside a bundle whose export set turned out to be default-only. */
const NO_FACADE_SUFFIX = `.no-facade-${FACADE_GENERATOR}`

/** The facade this generator writes for `bundleFile`. */
export function cjsFacadePath(bundleFile: string) {
  return path.join(`${bundleFile.replace(/\.mjs$/, '')}.facade-${FACADE_GENERATOR}`, 'index.mjs')
}

/** Where this generator records "no named exports" for `bundleFile`. */
export function cjsNoFacadeMarker(bundleFile: string) {
  return `${bundleFile}${NO_FACADE_SUFFIX}`
}

const facades = new Map<string, Promise<string | undefined>>()

// A `.jsonl` value on the server scope selects this profile; any other path is the
// per-module stats dump (runtime/modules.ts).
const heavyProfFile = (() => {
  const value = traceValue('server')
  return value?.endsWith('.jsonl') ? value : undefined
})()
export function heavyProfRow(row: Record<string, unknown>) {
  if (!heavyProfFile) return
  try {
    appendFileSync(heavyProfFile, `${JSON.stringify(row)}\n`)
  } catch {
    /* prof only */
  }
}

/**
 * Emit (once, persisted) a named-export facade for a bundled CommonJS package and return its path, or
 * undefined when the package has no named exports or the facade fails verification - in both cases the caller
 * inlines instead.
 */
export function cjsNamedExportFacade(bundleFile: string, importHref: string) {
  let facade = facades.get(bundleFile)
  if (!facade) {
    facade = writeCjsNamedExportFacade(bundleFile, importHref).catch(() => undefined)
    facades.set(bundleFile, facade)
  }
  return facade
}

async function writeCjsNamedExportFacade(bundleFile: string, importHref: string) {
  const file = cjsFacadePath(bundleFile)
  // The facade's identity follows its bundle's, so an importer of one canonical-
  // izes the same way an importer of the other does.
  const bundleId = vendorContentIds.get(bundleFile)
  if (bundleId) vendorContentIds.set(file, `${bundleId}:facade`)
  // Both outcomes persist: the facade is content-keyed with the bundle it wraps,
  // so a restart never re-executes the package to re-derive its names.
  if (existsSync(file)) return file
  if (existsSync(cjsNoFacadeMarker(bundleFile))) return undefined

  const t0 = performance.now()
  const code = await readFile(bundleFile, 'utf8').catch(() => undefined)
  if (code === undefined) return undefined
  const tRead = performance.now()
  // The exec pass is REQUIRED, not a supplement: a statically-scanned set is routinely short, and an
  // incomplete facade is worse than inlining - it breaks an importer's named binding at build time.
  // A bundle that cannot be executed here simply gets no facade.
  const executed = await executedExportNames(importHref)
  const tExec = performance.now()
  const names =
    executed &&
    [...new Set([...commonJsExportNames(code), ...executed])]
      .filter(name => name !== 'default' && name !== '__esModule' && isIdentifier(name))
      .sort()
  if (!names || names.length === 0) {
    heavyProfRow({
      k: 'facade',
      f: path.basename(bundleFile),
      readMs: tRead - t0,
      execMs: tExec - tRead,
      verifyMs: 0,
      out: 'no-names',
    })
    await writeFileAtomic(cjsNoFacadeMarker(bundleFile), '')
    return undefined
  }

  const binding = '__pnext_cjs'
  const namespace = '__pnext_cjs_ns'
  const holder = '__pnext_cjs_names'
  // A CommonJS entry marked `__esModule` but carrying no `default` (e.g.
  // bind-event-listener) leaves the default binding undefined, so reading names
  // off it threw at facade eval. Its names live on the bundle's own exports
  // instead — the same precedence `executedExportNames` derived them with.
  const source =
    `import ${binding}, * as ${namespace} from ${JSON.stringify(`../${path.basename(bundleFile)}`)};\n` +
    `export default ${binding};\n` +
    `const ${holder} = ${binding} ?? ${namespace};\n` +
    names.map(name => `export const ${name} = ${holder}[${JSON.stringify(name)}];`).join('\n') +
    '\n'
  // Bun 1.4 caches a resolved directory's module names. The bundle was just
  // imported above, so a new sibling facade is invisible to a later import;
  // a content-specific child directory has not been resolved yet.
  await mkdir(path.dirname(file), { recursive: true })
  const ok = await facadeRebundles(file, source)
  heavyProfRow({
    k: 'facade',
    f: path.basename(bundleFile),
    readMs: tRead - t0,
    execMs: tExec - tRead,
    verifyMs: performance.now() - tExec,
    out: ok ? 'facade' : 'verify-fail',
  })
  if (!ok) {
    await writeFileAtomic(cjsNoFacadeMarker(bundleFile), '')
    return undefined
  }
  await writeFileAtomic(file, source)
  return file
}

/**
 * Ground truth for the export set: import the bundle and read the keys off its default export - the same
 * object an importer would have seen inlined. This evaluates the package's module scope, so it returns
 * undefined (no facade) for a bundle that cannot run in this process, e.g. browser-only globals.
 */
async function executedExportNames(importHref: string) {
  try {
    const module_ = (await import(importHref)) as Record<string, unknown>
    const source = (module_.default as Record<string, unknown> | undefined) ?? module_
    if (!source || (typeof source !== 'object' && typeof source !== 'function')) return undefined
    return Object.keys(source)
  } catch {
    return undefined
  }
}

/**
 * The gate: esbuild reports a missing file AND a missing named export, so a
 * facade that re-bundles cleanly is one every importer can safely bind against.
 */
async function facadeRebundles(file: string, source: string) {
  try {
    await build({
      stdin: { contents: source, resolveDir: path.dirname(file), sourcefile: file, loader: 'js' },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      packages: 'external',
      logLevel: 'silent',
    })
    return true
  } catch {
    return false
  }
}
