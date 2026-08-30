import type { ComponentChildren } from 'preact'

export type RouteMode = 'static' | 'dynamic'

export const PREFETCH_MODES = ['visible', 'intent', 'load', false] as const
export type PrefetchMode = (typeof PREFETCH_MODES)[number]

export interface PNextRoutes {
  readonly __pnext_internal_route_brand?: never
}

export type RoutePath = Extract<Exclude<keyof PNextRoutes, '__pnext_internal_route_brand'>, string>
export type RouteParamValue = string | string[]

export type RouteParams<Route extends RoutePath> = PNextRoutes[Route] extends {
  params: infer Params extends Record<string, RouteParamValue>
}
  ? Params
  : Record<string, never>

export type StaticParams<Route extends RoutePath> =
  RouteParams<Route>[] | Promise<RouteParams<Route>[]>

export interface PNextConfig {
  outDir?: string
  basePath?: string
  assetPrefix?: string
  trailingSlash?: boolean
  // Next's skipTrailingSlashRedirect: serve both slashed and unslashed URLs
  // without a canonical 308/redirect, and never normalize trailing slashes on
  // Link hrefs / client navigation (the raw path is preserved end to end).
  skipTrailingSlashRedirect?: boolean
  htmlLimitedBots?: RegExp
  // App-wide default prefetch mode for client-router links that set none of
  // their own. `false` means links never prefetch unless they opt in.
  prefetch?: PrefetchMode
  // Emit browser sourcemaps from the production client build. Off by default,
  // matching Next: shipping maps publishes your source to every visitor, and
  // generating them costs real build time. Dev never emits them (the
  // un-minified output is already readable).
  productionBrowserSourceMaps?: boolean
  workspaceRoot?: string
  compat?: PNextCompatConfig
  adapter?: PNextAdapterConfig
}

/**
 * What a deployment adapter packs into the server function. It ships the closure the runtime can reach, minus
 * build debris and files no runtime reads - serverless size limits are hard. These lists are the escape hatch
 * when that classification is wrong for an app: `exclude` drops more, `keep` overrides a built-in drop.
 * Entries are directory names (`storybook-static`) or file suffixes (`.map`).
 */
export interface PNextAdapterConfig {
  exclude?: string[]
  keep?: string[]
}

export interface PNextCompatConfig {
  next?: boolean | PNextNextCompatConfig
  react?: boolean
  reactCompiler?: boolean
}

/** Opt-in Next-compat behaviours. Everything here defaults off. */
export interface PNextNextCompatConfig {
  /**
   * Next 15's transitional sync request APIs: cookies()/headers()/draftMode() return a Promise that
   * also carries the sync surface, warning once per callsite. Off by default (Next 16 semantics).
   */
  legacyRequestAPIs?: boolean
}

export interface MetadataLink {
  rel: string
  url: string
  dataPrecedence?: string
  type?: string
  media?: string
  sizes?: string
  as?: string
  title?: string
  hrefLang?: string
  crossOrigin?: 'anonymous' | 'use-credentials' | ''
  fetchPriority?: 'high' | 'low' | 'auto'
  /** CSP nonce (Next §A8) — set for a manually-nonced next/script preload hint. */
  nonce?: string
}

/** A generic document resource hint. Compat owns any resource-specific attributes. */
export interface ResourceHint extends Omit<MetadataLink, 'url'> {
  url?: string
  attributes?: Readonly<Record<string, string>>
}

export type MetadataTitle =
  string | number | { absolute?: string; default?: string; template?: string | null }

export type MetadataIcon =
  string | URL | (Omit<Partial<MetadataLink>, 'url'> & { url: string | URL })

export interface MetadataIconGroups {
  icon?: MetadataIcon | MetadataIcon[]
  shortcut?: MetadataIcon | MetadataIcon[]
  apple?: MetadataIcon | MetadataIcon[]
  other?: MetadataIcon | MetadataIcon[]
}

export interface MetadataAuthor {
  name?: string
  url?: string | URL
}

export interface MetadataRobots {
  index?: boolean
  follow?: boolean
  noarchive?: boolean
  nosnippet?: boolean
  noimageindex?: boolean
  nocache?: boolean
  googleBot?: string | (MetadataRobots & Record<string, string | number | boolean | undefined>)
}

export type MetadataImage =
  | string
  | URL
  | {
      url: string | URL
      secureUrl?: string | URL
      width?: string | number
      height?: string | number
      alt?: string
      type?: string
    }

export interface MetadataOpenGraph {
  title?: MetadataTitle
  description?: string
  url?: string | URL | null
  siteName?: string
  locale?: string
  type?: string
  images?: MetadataImage | MetadataImage[]
  videos?: MetadataImage | MetadataImage[]
  audio?: MetadataImage | MetadataImage[]
  publishedTime?: string
  authors?: string | URL | (string | URL)[] | null
  emails?: string | string[]
  phoneNumbers?: string | string[]
  faxNumbers?: string | string[]
}

export interface MetadataTwitterPlayer {
  playerUrl?: string | URL
  streamUrl?: string | URL
  width?: string | number
  height?: string | number
}

export interface MetadataTwitter {
  card?: string
  site?: string | null
  siteId?: string | null
  creator?: string | null
  creatorId?: string | null
  title?: MetadataTitle
  description?: string | null
  images?: MetadataImage | MetadataImage[]
  players?: MetadataTwitterPlayer | MetadataTwitterPlayer[]
  app?: {
    name?: string
    id?: Record<string, MetadataValue | undefined>
    url?: Record<string, string | URL | undefined>
  }
}

export type MetadataAlternate =
  | string
  | URL
  | { url: string | URL; title?: string }
  | (string | URL | { url: string | URL; title?: string })[]

export interface MetadataAlternates {
  canonical?: string | URL | { url: string | URL; title?: string } | null
  languages?: Record<string, MetadataAlternate | null | undefined>
  media?: Record<string, MetadataAlternate | null | undefined>
  types?: Record<string, MetadataAlternate | null | undefined>
}

// Every field is nullable: a metadata object may explicitly null a field out to
// suppress an inherited value, and null reads the same as absent here.
export interface Metadata {
  metadataBase?: string | URL | null
  title?: MetadataTitle | null
  description?: string | null
  lang?: string | null
  keywords?: string | number | (string | number)[] | null
  authors?: string | MetadataAuthor | (string | MetadataAuthor)[] | null
  generator?: string | null
  applicationName?: string | null
  referrer?: string | null
  robots?: string | MetadataRobots | null
  openGraph?: MetadataOpenGraph | null
  twitter?: MetadataTwitter | null
  alternates?: MetadataAlternates | null
  pagination?: {
    previous?: string | URL | null
    next?: string | URL | null
  } | null
  icons?: MetadataIcon | MetadataIcon[] | MetadataIconGroups | null
  manifest?: string | URL | null
  creator?: string | null
  publisher?: string | null
  formatDetection?: {
    email?: boolean | null
    address?: boolean | null
    telephone?: boolean | null
    url?: boolean | null
  } | null
  verification?: {
    google?: MetadataValue | MetadataValue[] | null
    yahoo?: MetadataValue | MetadataValue[] | null
    yandex?: MetadataValue | MetadataValue[] | null
    other?: Record<string, MetadataValue | MetadataValue[]>
  } | null
  itunes?: {
    appId?: string
    appArgument?: string | null
  } | null
  appleWebApp?:
    | boolean
    | {
        capable?: boolean
        title?: string | null
        statusBarStyle?: string
        startupImage?:
          | string
          | URL
          | { url: string | URL; media?: string }
          | (string | URL | { url: string | URL; media?: string })[]
          | null
      }
    | null
  facebook?: {
    appId?: string
    admins?: MetadataValue | MetadataValue[]
  } | null
  pinterest?: {
    richPin?: boolean | string | null
  } | null
  appLinks?: MetadataAppLinks | null
  other?: Record<string, MetadataValue | MetadataValue[] | null>
  links?: MetadataLink[]
}

/** A metadata value that renders to text; numbers are stringified. */
export type MetadataValue = string | number

export type MetadataAppLinkTarget = Record<string, MetadataValue | boolean | URL | undefined>

export type MetadataAppLinks = Record<
  string,
  MetadataAppLinkTarget | MetadataAppLinkTarget[] | undefined
>

export type ThemeColor = string | { color: string; media?: string }

export interface Viewport {
  width?: string | number
  initialScale?: number
  minimumScale?: number
  maximumScale?: number
  userScalable?: boolean
  viewportFit?: 'auto' | 'contain' | 'cover'
  interactiveWidget?: 'resizes-visual' | 'resizes-content' | 'overlays-content'
  themeColor?: ThemeColor | ThemeColor[] | null
  colorScheme?: string | null
}

export interface NextRequestCookie {
  name: string
  value: string
}

export interface NextRequestCookies {
  get(name: string): NextRequestCookie | undefined
  getAll(name?: string): NextRequestCookie[]
  has(name: string): boolean
  set(name: string, value: string): this
  delete(name: string): boolean
  clear(): void
}

export interface NextResponseCookies {
  set(options: {
    name: string
    value: string
    path?: string
    maxAge?: number
    httpOnly?: boolean
    secure?: boolean
    sameSite?: 'strict' | 'lax' | 'none'
  }): this
  set(
    name: string,
    value: string,
    options?: {
      path?: string
      maxAge?: number
      httpOnly?: boolean
      secure?: boolean
      sameSite?: 'strict' | 'lax' | 'none'
    },
  ): this
  delete(name: string): this
}

export interface NextURL extends URL {
  clone(): NextURL
  /** The configured basePath prefix ('' when unset), mirroring Next's NextURL. */
  basePath: string
  /** The active locale ('' without i18n), mirroring Next's NextURL. */
  locale: string
}

export interface NextRequest extends Request {
  cookies: NextRequestCookies
  nextUrl: NextURL
}

export interface NextFetchEvent {
  waitUntil(promise: Promise<unknown>): void
}

type ParamsInput<P> = P extends RoutePath
  ? RouteParams<P>
  : P extends Record<string, RouteParamValue>
    ? P
    : Record<string, RouteParamValue>

export type PageSearchParams = Record<string, string | string[] | undefined>

export interface PageProps<P = Record<string, RouteParamValue>> {
  params: Promise<ParamsInput<P>>
  searchParams: Promise<PageSearchParams>
  request?: NextRequest
}

export interface RouteContext<P = Record<string, RouteParamValue>> {
  params: Promise<ParamsInput<P>>
}

export type ServerComponentResult = ComponentChildren | void

export type ServerComponent<Props = Record<string, never>> = (
  props: Props,
) => ServerComponentResult | Promise<ServerComponentResult>

export interface LayoutProps {
  children: ComponentChildren
  params: Promise<Record<string, RouteParamValue>>
  searchParams: Promise<PageSearchParams>
  request?: NextRequest
}

export type RouteHandler = {
  bivarianceHack(request: NextRequest, context: RouteContext): Response | Promise<Response>
}['bivarianceHack']

/** Kind of intercepting-route marker on a route directory (Next.js convention). */
export type InterceptionMarker = '(.)' | '(..)' | '(..)(..)' | '(...)'

/**
 * Parallel-route render state carried across soft navigations. The client
 * echoes the state embedded in the current document (plus history entries) so
 * the server can re-render unmatched slots from the path they last matched.
 */
export interface NavState {
  /** Pathname the children tree rendered from. */
  children?: string
  /**
   * Search string (`?a=b`, may be empty or absent) the children tree rendered with. On a host render, where
   * interception keeps the current page visible, the children page re-renders with THIS query, not the target
   * URL's - Next's per-segment refetch-URL semantics preserve each slot's searchParams.
   */
  childrenSearch?: string
  /**
   * App-relative slot directory -> source URL (`pathname` or
   * `pathname?query`) its content rendered from. The query, when present, is
   * the searchParams the slot's page re-renders with when re-rendered from
   * this recorded source.
   */
  slots?: Record<string, string>
  /**
   * The children slot rendered a `default.*` because no page matched this path (Next's `__DEFAULT__`
   * segment). `useSelectedLayoutSegment()` with no parallel-route key reports NOTHING for such a slot - the
   * path's segments belong to whichever parallel slot did match, not to children.
   */
  childrenDefault?: boolean
  /**
   * The served document is a fully static (prerendered) route. Inlined so a
   * hard load can seed its prefetch entry with the static reuse window rather
   * than the dynamic default. Mirrors the `/_tree` payload's `isStatic`.
   */
  isStatic?: boolean
  /**
   * The route's `x-nextjs-stale-time` window (seconds) from its `use cache`
   * `cacheLife()`, inlined for the same hard-load seeding path. Mirrors the
   * `/_tree` payload's `staleTime`.
   */
  staleTime?: number
  /**
   * The served document was resumed from a BAKED SHELL (a fallback shell or a
   * sub-shell), so the markup above its dynamic holes is a prerender even though
   * the document as a whole is not static. The client files a hard load's
   * pre-hydration stage as a reusable static stage on the strength of this;
   * `isStatic` stays false, so the whole-document reuse window is untouched.
   */
  staticStage?: boolean
  /**
   * The served document is an interception HOST render: the URL is the intercepted target but the children
   * tree kept rendering the host page. Such a document is bound to its host - the client must NOT reuse it
   * origin-agnostically for a navigation issued from a DIFFERENT host, nor as a direct render of the target.
   * Stamped by the server, which alone knows the pre-rewrite host path; the client cannot infer it by
   * comparing `children` to the browser pathname under a rewrite.
   */
  hostRender?: boolean
}

/**
 * Metadata for an intercepting route. The entry's own `route`/`pattern` hold
 * the TARGET path the interceptor responds to; interception entries only match
 * soft navigations whose current children path sits at or below `base`.
 */
export interface RouteInterception {
  /** The raw marker that prefixed the intercepted segment. */
  marker: InterceptionMarker
  /** Route path of the level the interceptor renders within (e.g. `/feed`). */
  base: string
  /** Regex source (anchored by the matcher) for paths at or below `base`. */
  basePattern: string
  /**
   * Absolute path of the `@slot` directory the interceptor renders into. When
   * set, the interceptor renders as slot content of the current page; when
   * absent, the interceptor page replaces the children tree.
   */
  slotDir?: string
}

export interface RouteManifestEntry {
  id: string
  kind: 'page' | 'handler'
  route: string
  pattern: string
  file: string
  params: string[]
  catchAll?: string
  /**
   * The trailing catch-all is optional (`[[...slug]]`): it matches both the
   * parent path and nested paths. When set, `catchAll` holds the param name and
   * the pattern's final group is `(?:/(.*))?`.
   */
  catchAllOptional?: boolean
  mode: RouteMode
  hasStaticParams: boolean
  usesRequest: boolean
  /**
   * Route handler that calls a revalidation API (revalidatePath/revalidateTag/
   * expirePath/expireTag). Such a handler performs a side effect that cannot be
   * prerendered, so it stays dynamic even when a `revalidate` export or
   * generateStaticParams would otherwise opt it into static ISR output.
   */
  handlerUsesRevalidationApi?: boolean
  /**
   * Route declares `export const dynamic = 'error'` AND statically references a
   * dynamic data API (cookies()/headers()/connection()/searchParams for pages,
   * request.formData/nextUrl/url for handlers). Next fails the build for such a
   * route ("couldn't be rendered statically"); the value is the API label Next
   * names in that error (e.g. `cookies()`, `nextUrl.toString`). Set at scan time
   * and enforced in the build's prerender pass.
   */
  dynamicErrorApi?: string
  client: boolean
  clientReferences: import('./client/reference').ClientReference[]
  cssImports: string[]
  cssAssets?: string[]
  sourceFiles: string[]
  stream?: {
    hasLoadingBoundary?: boolean
    ancestorClientReferences?: string[]
  }
  clientEntry?: string
  /** Static import closure of the client entry, for modulepreload links. */
  clientEntryImports?: string[]
  /** Dynamic import closure of the client entry, for low-priority preload links. */
  clientDynamicImports?: string[]
  maxDuration?: number
  /** Route opts into partial prerendering via `export const experimental_ppr = true`. */
  ppr?: boolean
  /** Merged Next segment config across the page/handler and its layout chain. */
  segmentConfig?: RouteSegmentConfig
  /** Code-based metadata route synthesized from robots/sitemap/icon/etc. */
  metadataRoute?: MetadataRouteEntry
  /** Param sets prerendered at build from params(). Compat aliases generateStaticParams to params. */
  prerenderedParams?: Record<string, RouteParamValue>[]
  /**
   * Per-prerendered-URL vary sets tracked by the BUILD render, keyed by the concrete pathname. A request-time
   * render answered from that prerender executes no user code, so it tracks nothing and would publish
   * "unknown" (exact-URL keying) - these are the sets it publishes instead.
   */
  prerenderVary?: Record<string, { vary: string[]; layoutVary: string[]; pageVary: string[] }>
  /** Suspense boundary ids left as dynamic holes in the prebuilt PPR shell. */
  pprHoles?: number[]
  /** Metadata postponed out of the static PPR shell and resumed into the body. */
  pprMetadata?: boolean
  /**
   * Effective `use cache` cacheLife captured from the route's shell prerender.
   * A prebuilt page never re-runs its cache scopes at serve time, so start.ts
   * re-emits the SWR cache-control + x-nextjs-stale-time headers from this on a
   * pure static HIT/MISS (the render-time header finalizer never fires there).
   */
  cacheLife?: {
    revalidateSeconds?: number
    expireSeconds?: number
    staleSeconds?: number
  }
  /**
   * The `Link` response header captured from the route's shell prerender (font
   * preloads + react-dom preload()/preconnect() hints, capped by
   * reactMaxHeadersLength). A PPR resume replays the shell without re-running
   * the components that emitted the hints, so start.ts re-emits the header
   * from here (mirrors Next serving the prerender's stored headers).
   */
  linkHeader?: string
  /**
   * Cache tags collected across the route's shell (and sub-shell) prerenders - cacheTag(),
   * unstable_cache({tags}), fetch({next:{tags}}). A prebuilt PPR shell must stop serving once one of these
   * tags, or the route's path, is revalidated; loadPprShell compares them against the shell file's mtime.
   */
  cacheTags?: string[]
  /**
   * Prebuilt sub-shells at descending param specificity. Each entry fixes a leading prefix of params
   * (`concreteParams`) - those render buildtime - while the remaining route params hang. Ordered MOST-specific
   * first so the request path serves the deepest matching one; the base shell (all params hang) is the
   * least-specific fallback. `key` is the on-disk signature; `holes` are that shell's own dynamic hole ids.
   */
  pprSubShells?: {
    key: string
    concreteParams: Record<string, RouteParamValue>
    holes: number[]
  }[]
  /**
   * `template.*` files from app root to the route's own segment, parallel to
   * the layout chain. A template re-mounts on navigation where a layout persists.
   */
  templateFiles?: string[]
  /** `forbidden.*` files nearest-last (root->leaf); COMPAT authInterrupts. */
  forbiddenFiles?: string[]
  /** `unauthorized.*` files nearest-last (root->leaf); COMPAT authInterrupts. */
  unauthorizedFiles?: string[]
  /**
   * Parallel-route `@slot` directories (absolute) along the route's layout
   * chain, root->leaf. Presence means slot content participates in rendering
   * and soft navigations must render dynamically.
   */
  slotDirs?: string[]
  /**
   * Entry synthesized from a parallel slot's page: the URL is only reachable
   * because a slot matches it. `file` anchors the layout chain; the children
   * tree renders `childrenDefault` (or nothing) instead of importing `file`.
   */
  synthetic?: boolean
  /** Slot directory whose page produced this synthetic route. */
  syntheticSlotDir?: string
  /** `default.*` file rendered as children for a synthetic entry. */
  childrenDefault?: string
  /** Intercepting-route metadata, when this route is an interceptor. */
  interception?: RouteInterception
  /** First `'use server'` module in the route's closure — core refuses these. */
  serverActionFile?: string
  /**
   * Ship the soft-navigation runtime even without client references. Derived:
   * true exactly when `clientEntryReasons` is non-empty. Kept as its own field
   * because it is what every consumer asks and what the manifest carries.
   */
  needsRouterEntry?: boolean
  /**
   * WHY this route needs the client entry - one entry per fact the scan (or the build) observed. The client
   * build gates its feature regions on these, so a `<Link>`-only page never ships the action machinery;
   * collapsing them back into the boolean above loses exactly that.
   */
  clientEntryReasons?: ClientEntryReason[]
}

/**
 * Why a page ships the client router entry. Each value is a fact some detection site actually observes:
 *   compat-parity   - Next compat emits its app-router bootstrap on every page
 *   parallel-routes - the app uses parallel/intercepting routes (soft nav only)
 *   link            - the page's graph renders <Link>
 *   actions         - the page's graph reaches a server action, or a client component passes a function to
 *                     `<form action>`/`formAction`
 *   form            - the page's graph renders next/form
 *   router-api      - the page's graph imports Link or a navigation hook anywhere, scanned for every page
 *                     including those that already ship an entry: the entry drops the router entirely when no
 *                     route file can start a soft navigation
 */
export type ClientEntryReason =
  'compat-parity' | 'parallel-routes' | 'link' | 'router-api' | 'actions' | 'form' | 'control-flow'

export type MetadataRouteKind =
  'icon' | 'apple-icon' | 'opengraph-image' | 'twitter-image' | 'robots' | 'sitemap' | 'manifest'

export interface MetadataRouteEntry {
  kind: MetadataRouteKind
  generatedParam?: string
  /**
   * Concrete pathnames the generated-param expansion resolved to at build (generateSitemaps /
   * generateImageMetadata ids). The route pattern itself carries a param so it is never `mode: 'static'`, but
   * every id is known ahead of time - Next lists each expanded pathname as a prerendered route. Recorded
   * during the handler prerender pass.
   */
  generatedRoutes?: string[]
}

export interface StaticMetadataFileEntry {
  kind: MetadataRouteKind | 'favicon'
  file: string
  relative: string
  outputPath: string
  routeSegments: string[]
  contentType: string
  /** Content-derived URL identity for cache-busted metadata image links. */
  cacheIdentity?: string
  width?: number
  height?: number
  sizes?: string
  alt?: string
}

export interface StaticModuleMetadata {
  metadata?: Metadata
  viewport?: Viewport
}

export interface StaticRouteMetadata {
  favicon?: StaticMetadataFileEntry
  manifest?: StaticMetadataFileEntry
  manifestLink?: MetadataLink
  icons: StaticMetadataFileEntry[]
  appleIcons: StaticMetadataFileEntry[]
  rootIcons: StaticMetadataFileEntry[]
  dynamicIcons?: MetadataLink[]
  dynamicAppleIcons?: MetadataLink[]
  openGraphImage?: MetadataImage
  dynamicOpenGraphImages?: MetadataImage[]
  twitterImage?: MetadataImage
  dynamicTwitterImages?: MetadataImage[]
}

export interface BuildManifest {
  version: 0
  root: string
  appDir: string
  outDir: string
  routes: RouteManifestEntry[]
  staticFiles?: Record<string, StaticFileMetadata>
  /** Logical build-asset name -> the content-hashed name emitted (`global.css` -> `global-<hash>.css`). */
  assetNames?: Record<string, string>
  staticMetadataFiles?: StaticMetadataFileEntry[]
  staticModuleMetadata?: Record<string, StaticModuleMetadata>
  staticRouteMetadata?: Record<string, StaticRouteMetadata>
  /** Compiled proxy/middleware bundle, relative to outDir. */
  proxyModule?: string
  /** Absolute path to the app-root `global-error.*` file, if present. */
  globalErrorFile?: string
  /** Server-action registry: wire id -> compiled module + export. COMPAT. */
  actions?: ActionManifestEntry[]
}

/** One server-action target in the build manifest. */
export interface ActionManifestEntry {
  /** Wire id (actionId), sent by the client stub in the next-action header. */
  id: string
  /**
   * Project-root-relative POSIX path of the action's SOURCE module. Used at
   * startup to recompute the id (actionId with no root), giving parity with the
   * client stub's id regardless of the machine's absolute paths.
   */
  sourceKey: string
  /** Compiled server-module path, relative to outDir, for start to import. */
  modulePath: string
  /** Export name within the module implementing the action. */
  exportName: string
}

export interface StaticFileMetadata {
  status: number
  headers: [string, string][]
  routeId?: string
  /** 'page' entries are prebuilt HTML subject to ISR; absent means handler output. */
  kind?: 'page'
  /** ISR TTL in seconds (min of segment config and fetch/unstable_cache revalidates). */
  revalidateSeconds?: number
  /**
   * Hard-expiry window in seconds from a `use cache` cacheLife(). Past this the
   * stale copy is NO LONGER served: the request blocks on a fresh render (vs
   * revalidateSeconds, which serves stale-while-revalidate).
   */
  expireSeconds?: number
  /** `x-nextjs-stale-time` window in seconds from a `use cache` cacheLife(). */
  staleSeconds?: number
  /** Cache tags the prerender depended on; revalidateTag(tag) marks the file stale. */
  tags?: string[]
}

/** Next route segment config exports (`export const dynamic/revalidate/...`). */
export interface RouteSegmentConfig {
  dynamic?: 'auto' | 'force-dynamic' | 'error' | 'force-static'
  revalidate?: number | false
  fetchCache?:
    | 'auto'
    | 'default-cache'
    | 'only-cache'
    | 'force-cache'
    | 'force-no-store'
    | 'default-no-store'
    | 'only-no-store'
  /** Param names governed by a `dynamicParams = false` declaration. */
  dynamicParamsFalse?: string[]
  /**
   * The page has its own static params export while a `dynamicParams = false`
   * declaration governs the route: every param tuple must match a prerendered
   * path (Next's fallback: false), not just the governed params.
   */
  strictDynamicParams?: boolean
  /** `export const runtime` value, when declared ('edge' | 'nodejs'). */
  runtime?: string
  /** Next app-shell prefetch policy declared by the route. */
  prefetch?: 'allow-runtime' | 'partial' | 'unstable_eager'
  /**
   * `export const unstable_instant` on the page or a layout in its chain (a boolean or a sample-config object
   * means true; an explicit `false` on a leaf overrides an ancestor's opt-in). A full (`prefetch={true}`)
   * prefetch of an instant route is served as a RUNTIME-PREFETCH prerender: request data is sampled into the
   * response while connection()-gated content is omitted.
   */
  unstableInstant?: boolean
}
