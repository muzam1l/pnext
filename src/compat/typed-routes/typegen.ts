// Next-identical codegen for `.next/types/{routes.d.ts,link.d.ts,validator.ts}`.
// Ported near-verbatim from Next 16.3's router-utils/typegen.ts (non-strict
// variants) so the generated output matches the exact substrings the
// typed-routes / typed-routes-validator e2e suites assert on. Compat-only.
import type { ManifestRouteInfo, RouteTypesManifest } from './manifest'

function isDynamicRoute(route: string): boolean {
  return /\[.+\]/.test(route)
}

function generateRouteTypes(manifest: RouteTypesManifest): string {
  const appRoutes = Object.keys(manifest.appRoutes).sort()
  const pageRoutes = Object.keys(manifest.pageRoutes).sort()
  const layoutRoutes = Object.keys(manifest.layoutRoutes).sort()
  const redirectRoutes = Object.keys(manifest.redirectRoutes).sort()
  const rewriteRoutes = Object.keys(manifest.rewriteRoutes).sort()
  const appRouteHandlerRoutes = Object.keys(manifest.appRouteHandlerRoutes).sort()
  const hasAppRouteHandlers = appRouteHandlerRoutes.length > 0

  const union = (list: string[]) => list.map(route => JSON.stringify(route)).join(' | ')

  let result = ''
  result +=
    appRoutes.length > 0 ? `type AppRoutes = ${union(appRoutes)}\n` : 'type AppRoutes = never\n'
  if (hasAppRouteHandlers) {
    result += `type AppRouteHandlerRoutes = ${union(appRouteHandlerRoutes)}\n`
  }
  result +=
    pageRoutes.length > 0 ? `type PageRoutes = ${union(pageRoutes)}\n` : 'type PageRoutes = never\n'
  result +=
    layoutRoutes.length > 0
      ? `type LayoutRoutes = ${union(layoutRoutes)}\n`
      : 'type LayoutRoutes = never\n'
  result +=
    redirectRoutes.length > 0
      ? `type RedirectRoutes = ${union(redirectRoutes)}\n`
      : 'type RedirectRoutes = never\n'
  result +=
    rewriteRoutes.length > 0
      ? `type RewriteRoutes = ${union(rewriteRoutes)}\n`
      : 'type RewriteRoutes = never\n'

  const routeUnionParts = [
    'AppRoutes',
    'PageRoutes',
    'LayoutRoutes',
    'RedirectRoutes',
    'RewriteRoutes',
  ]
  if (hasAppRouteHandlers) routeUnionParts.push('AppRouteHandlerRoutes')
  result += `type Routes = ${routeUnionParts.join(' | ')}\n`
  return result
}

function generateParamTypes(manifest: RouteTypesManifest): string {
  const allRoutes: Record<string, ManifestRouteInfo> = {
    ...manifest.appRoutes,
    ...manifest.appRouteHandlerRoutes,
    ...manifest.pageRoutes,
    ...manifest.layoutRoutes,
    ...manifest.redirectRoutes,
    ...manifest.rewriteRoutes,
  }

  let paramTypes = 'interface ParamMap {\n'
  const sortedRoutes = Object.entries(allRoutes).sort(([a], [b]) => a.localeCompare(b))
  for (const [route, routeInfo] of sortedRoutes) {
    const groups = routeInfo.groups
    if (!isDynamicRoute(route) || Object.keys(groups ?? {}).length === 0) {
      paramTypes += `  ${JSON.stringify(route)}: {}\n`
      continue
    }
    let paramType = '{'
    for (const [key, group] of Object.entries(groups)) {
      const escapedKey = JSON.stringify(key)
      if (group.repeat) {
        paramType += group.optional ? ` ${escapedKey}?: string[];` : ` ${escapedKey}: string[];`
      } else {
        paramType += group.optional ? ` ${escapedKey}?: string;` : ` ${escapedKey}: string;`
      }
    }
    paramType += ' }'
    paramTypes += `  ${JSON.stringify(route)}: ${paramType}\n`
  }
  paramTypes += '}\n'
  return paramTypes
}

function generateLayoutSlotMap(manifest: RouteTypesManifest): string {
  let slotMap = 'interface LayoutSlotMap {\n'
  const sorted = Object.entries(manifest.layoutRoutes).sort(([a], [b]) => a.localeCompare(b))
  for (const [route, routeInfo] of sorted) {
    const slots = [...routeInfo.slots].sort()
    slotMap +=
      slots.length > 0
        ? `  ${JSON.stringify(route)}: ${slots.map(slot => JSON.stringify(slot)).join(' | ')}\n`
        : `  ${JSON.stringify(route)}: never\n`
  }
  slotMap += '}\n'
  return slotMap
}

function formatRouteToRouteType(route: string): { isDynamic: boolean; routeType: string } {
  const isDynamic = isDynamicRoute(route)
  let routeType = route
  if (isDynamic) {
    routeType = route
      .split('/')
      .map(part => {
        if (part.startsWith('[') && part.endsWith(']')) {
          if (part.startsWith('[[...') && part.endsWith(']]')) return '${OptionalCatchAllSlug<T>}'
          if (part.startsWith('[...')) return '${CatchAllSlug<T>}'
          return '${SafeSlug<T>}'
        }
        return part
      })
      .join('/')
  }
  return { isDynamic, routeType }
}

function serializeRouteTypes(routeTypes: [routeType: string, cause: string][]): string {
  routeTypes.sort(([a], [b]) => a.localeCompare(b))
  let union = ''
  for (const [route, cause] of routeTypes) {
    union += `\n    | \`${route}\` // ${cause}`
  }
  return union
}

export function generateRouteTypesFile(manifest: RouteTypesManifest): string {
  const routeTypes = generateRouteTypes(manifest)
  const paramTypes = generateParamTypes(manifest)
  const layoutSlotMap = generateLayoutSlotMap(manifest)
  const hasAppRouteHandlers = Object.keys(manifest.appRouteHandlerRoutes).length > 0

  const routeExports = [
    'AppRoutes',
    'PageRoutes',
    'LayoutRoutes',
    'RedirectRoutes',
    'RewriteRoutes',
    'ParamMap',
  ]
  if (hasAppRouteHandlers) routeExports.push('AppRouteHandlerRoutes')
  const exportStatement = `export type { ${routeExports.join(', ')} }`

  const routeContextInterface = hasAppRouteHandlers
    ? `

  /**
   * Context for Next.js App Router route handlers
   * @example
   * \`\`\`tsx
   * export async function GET(request: NextRequest, context: RouteContext<'/api/users/[id]'>) {
   *   const { id } = await context.params
   *   return Response.json({ id })
   * }
   * \`\`\`
   */
  interface RouteContext<AppRouteHandlerRoute extends AppRouteHandlerRoutes> {
    params: Promise<ParamMap[AppRouteHandlerRoute]>
  }`
    : ''

  return `// This file is generated automatically by Next.js
// Do not edit this file manually

${routeTypes}

${paramTypes}

export type ParamsOf<Route extends Routes> = ParamMap[Route]

${layoutSlotMap}

${exportStatement}

declare global {
  /**
   * Props for Next.js App Router page components
   * @example
   * \`\`\`tsx
   * export default function Page(props: PageProps<'/blog/[slug]'>) {
   *   const { slug } = await props.params
   *   return <div>Blog post: {slug}</div>
   * }
   * \`\`\`
   */
  interface PageProps<AppRoute extends AppRoutes> {
    params: Promise<ParamMap[AppRoute]>
    searchParams: Promise<Record<string, string | string[] | undefined>>
  }

  /**
   * Props for Next.js App Router layout components
   * @example
   * \`\`\`tsx
   * export default function Layout(props: LayoutProps<'/dashboard'>) {
   *   return <div>{props.children}</div>
   * }
   * \`\`\`
   */
  type LayoutProps<LayoutRoute extends LayoutRoutes> = {
    params: Promise<ParamMap[LayoutRoute]>
    searchParams: Promise<Record<string, string | string[] | undefined>>
    children: React.ReactNode
  } & {
    [K in LayoutSlotMap[LayoutRoute]]: React.ReactNode
  }${routeContextInterface}
}
`
}

export function generateLinkTypesFile(manifest: RouteTypesManifest): string {
  const visited = new Set<string>()
  const staticRouteTypes: [routeType: string, cause: string][] = []
  const dynamicRouteTypes: [routeType: string, cause: string][] = []

  for (const routeMap of [
    manifest.appRoutes,
    manifest.pageRoutes,
    manifest.redirectRoutes,
    manifest.rewriteRoutes,
    manifest.appRouteHandlerRoutes,
  ]) {
    for (const route in routeMap) {
      if (visited.has(route)) continue
      visited.add(route)
      const { isDynamic, routeType } = formatRouteToRouteType(route)
      const cause = routeMap[route]!.path
      ;(isDynamic ? dynamicRouteTypes : staticRouteTypes).push([routeType, cause])
    }
  }

  for (const filePath of manifest.pageApiRoutes) {
    if (visited.has(filePath)) continue
    visited.add(filePath)
    const { isDynamic, routeType } = formatRouteToRouteType(filePath)
    ;(isDynamic ? dynamicRouteTypes : staticRouteTypes).push([routeType, filePath])
  }

  const serializedStaticRouteTypes = serializeRouteTypes(staticRouteTypes)
  const serializedDynamicRouteTypes = serializeRouteTypes(dynamicRouteTypes)
  const routeTypesFallback =
    !serializedStaticRouteTypes && !serializedDynamicRouteTypes ? 'string & {}' : ''

  return `// This file is generated automatically by Next.js
// Do not edit this file manually

// Type definitions for Next.js routes

/**
 * Internal types used by the Next.js router and Link component.
 * These types are not meant to be used directly.
 * @internal
 */
declare namespace __next_route_internal_types__ {
  type SearchOrHash = \`?\${string}\` | \`#\${string}\`
  type WithProtocol = \`\${string}:\${string}\`

  type Suffix = '' | SearchOrHash

  type SafeSlug<S extends string> = S extends \`\${string}/\${string}\`
    ? never
    : S extends \`\${string}\${SearchOrHash}\`
    ? never
    : S extends ''
    ? never
    : S

  type CatchAllSlug<S extends string> = S extends \`\${string}\${SearchOrHash}\`
    ? never
    : S extends ''
    ? never
    : S

  type OptionalCatchAllSlug<S extends string> =
    S extends \`\${string}\${SearchOrHash}\` ? never : S

  type StaticRoutes = ${serializedStaticRouteTypes || 'never'}
  type DynamicRoutes<T extends string = string> = ${serializedDynamicRouteTypes || 'never'}

  type RouteImpl<T> = ${
    routeTypesFallback ||
    `
    ${'| StaticRoutes'}
    | SearchOrHash
    | WithProtocol
    | \`\${StaticRoutes}\${SearchOrHash}\`
    | (T extends \`\${DynamicRoutes<infer _>}\${Suffix}\` ? T : never)
    `
  }
}

declare module 'next' {
  export { default } from 'next/types.js'
  export * from 'next/types.js'

  export type Route<T extends string = string> =
    __next_route_internal_types__.RouteImpl<T>
}

declare module 'next/link' {
  export { useLinkStatus } from 'next/dist/client/link.js'

  import type { LinkProps as OriginalLinkProps } from 'next/dist/client/link.js'
  import type { AnchorHTMLAttributes, DetailedHTMLProps } from 'react'
  import type { UrlObject } from 'url'

  type LinkRestProps = Omit<
    Omit<
      DetailedHTMLProps<
        AnchorHTMLAttributes<HTMLAnchorElement>,
        HTMLAnchorElement
      >,
      keyof OriginalLinkProps
    > &
      OriginalLinkProps,
    'href'
  >

  export type LinkProps<RouteInferType> = LinkRestProps & {
    /**
     * The path or URL to navigate to. This is the only required prop. It can also be an object.
     * @see https://nextjs.org/docs/api-reference/next/link
     */
    href: __next_route_internal_types__.RouteImpl<RouteInferType> | UrlObject
  }

  export default function Link<RouteType>(props: LinkProps<RouteType>): JSX.Element
}

declare module 'next/navigation' {
  export * from 'next/dist/client/components/navigation.js'

  import type { NavigateOptions, PrefetchOptions, AppRouterInstance as OriginalAppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime.js'
  import type { RedirectType } from 'next/dist/client/components/redirect-error.js'

  interface AppRouterInstance extends OriginalAppRouterInstance {
    /**
     * Navigate to the provided href.
     * Pushes a new history entry.
     */
    push<RouteType>(href: __next_route_internal_types__.RouteImpl<RouteType>, options?: NavigateOptions): void
    /**
     * Navigate to the provided href.
     * Replaces the current history entry.
     */
    replace<RouteType>(href: __next_route_internal_types__.RouteImpl<RouteType>, options?: NavigateOptions): void
    /**
     * Prefetch the provided href.
     */
    prefetch<RouteType>(href: __next_route_internal_types__.RouteImpl<RouteType>, options?: PrefetchOptions): void
  }

  export function useRouter(): AppRouterInstance;

  export function redirect<RouteType>(
    url: __next_route_internal_types__.RouteImpl<RouteType>,
    type?: RedirectType
  ): never;

  export function permanentRedirect<RouteType>(
    url: __next_route_internal_types__.RouteImpl<RouteType>,
    type?: RedirectType
  ): never;
}

declare module 'next/form' {
  import type { FormProps as OriginalFormProps } from 'next/dist/client/form.js'

  type FormRestProps = Omit<OriginalFormProps, 'action'>

  export type FormProps<RouteInferType> = {
    action: __next_route_internal_types__.RouteImpl<RouteInferType> | ((formData: FormData) => void)
  } & FormRestProps

  export default function Form<RouteType>(props: FormProps<RouteType>): JSX.Element
}
`
}

/**
 * Non-strict validator file. `importDir` is the directory the validator.ts is
 * written to (e.g. `<root>/.next/types`); import specifiers are recomputed
 * relative to it from the manifest's root-relative paths.
 */
export function generateValidatorFile(
  manifest: RouteTypesManifest,
  toImportSpecifier: (rootRelativePath: string) => string,
): string {
  const generateValidations = (
    paths: string[],
    type:
      | 'AppPageConfig'
      | 'PagesPageConfig'
      | 'LayoutConfig'
      | 'RouteHandlerConfig'
      | 'ApiRouteConfig',
    pathToRouteMap?: Map<string, string>,
  ) =>
    paths
      .sort()
      .filter(filePath => filePath.endsWith('.ts') || filePath.endsWith('.tsx'))
      .filter(
        filePath =>
          type !== 'AppPageConfig' || filePath.endsWith('page.ts') || filePath.endsWith('page.tsx'),
      )
      .map(filePath => {
        const importPath = toImportSpecifier(filePath)
        const route = pathToRouteMap?.get(filePath)
        const typeWithRoute =
          route &&
          (type === 'AppPageConfig' || type === 'LayoutConfig' || type === 'RouteHandlerConfig')
            ? `${type}<${JSON.stringify(route)}>`
            : type
        return `// Validate ${filePath}
{
  type __IsExpected<Specific extends ${typeWithRoute}> = Specific
  const handler = {} as typeof import(${JSON.stringify(importPath.replace(/\.tsx?$/, '.js'))})
  type __Check = __IsExpected<typeof handler>
  // @ts-ignore
  type __Unused = __Check
}`
      })
      .join('\n\n')

  const appPageValidations = generateValidations(
    [...manifest.appPagePaths].sort(),
    'AppPageConfig',
    manifest.filePathToRoute,
  )
  const appRouteHandlerValidations = generateValidations(
    [...manifest.appRouteHandlers].sort(),
    'RouteHandlerConfig',
    manifest.filePathToRoute,
  )
  const pagesRouterPageValidations = generateValidations(
    [...manifest.pagesRouterPagePaths].sort(),
    'PagesPageConfig',
  )
  const pagesApiRouteValidations = generateValidations(
    [...manifest.pageApiRoutes].sort(),
    'ApiRouteConfig',
  )
  const layoutValidations = generateValidations(
    [...manifest.layoutPaths].sort(),
    'LayoutConfig',
    manifest.filePathToRoute,
  )

  const hasAppRouteHandlers = Object.keys(manifest.appRouteHandlerRoutes).length > 0

  let typeDefinitions = ''
  if (appPageValidations) {
    typeDefinitions += `type AppPageConfig<Route extends AppRoutes = AppRoutes> = {
  default: React.JSXElementConstructor<PageProps<Route>> | ((props: { params: Promise<ParamMap[Route]>, searchParams: Promise<any> }) => React.ReactNode | Promise<React.ReactNode> | never | void | Promise<void>)
  generateStaticParams?: (props: { params: ParamMap[Route] }) => Promise<any[]> | any[]
  generateMetadata?: (
    props: { params: Promise<ParamMap[Route]> } & any,
    parent: ResolvingMetadata
  ) => Promise<any> | any
  generateViewport?: (
    props: { params: Promise<ParamMap[Route]> } & any,
    parent: ResolvingViewport
  ) => Promise<any> | any
  metadata?: any
  viewport?: any
}

`
  }

  if (pagesRouterPageValidations) {
    typeDefinitions += `type PagesPageConfig = {
  default: React.ComponentType<any> | ((props: any) => React.ReactNode | Promise<React.ReactNode> | never | void)
  getStaticProps?: (context: any) => Promise<any> | any
  getStaticPaths?: (context: any) => Promise<any> | any
  getServerSideProps?: (context: any) => Promise<any> | any
  getInitialProps?: (context: any) => Promise<any> | any
  /**
   * Segment configuration for legacy Pages Router pages.
   * Validated at build-time by parsePagesSegmentConfig.
   */
  config?: {
    maxDuration?: number
    runtime?: 'edge' | 'experimental-edge' | 'nodejs' | string // necessary unless config is exported as const
    regions?: string[]
  }
}

`
  }

  if (layoutValidations) {
    typeDefinitions += `type LayoutConfig<Route extends LayoutRoutes = LayoutRoutes> = {
  default: React.ComponentType<LayoutProps<Route>> | ((props: LayoutProps<Route>) => React.ReactNode | Promise<React.ReactNode> | never | void | Promise<void>)
  generateStaticParams?: (props: { params: ParamMap[Route] }) => Promise<any[]> | any[]
  generateMetadata?: (
    props: { params: Promise<ParamMap[Route]> } & any,
    parent: ResolvingMetadata
  ) => Promise<any> | any
  generateViewport?: (
    props: { params: Promise<ParamMap[Route]> } & any,
    parent: ResolvingViewport
  ) => Promise<any> | any
  metadata?: any
  viewport?: any
}

`
  }

  if (appRouteHandlerValidations) {
    typeDefinitions += `type RouteHandlerConfig<Route extends AppRouteHandlerRoutes = AppRouteHandlerRoutes> = {
  GET?: (request: NextRequest, context: { params: Promise<ParamMap[Route]> }) => Promise<Response | void> | Response | void
  POST?: (request: NextRequest, context: { params: Promise<ParamMap[Route]> }) => Promise<Response | void> | Response | void
  PUT?: (request: NextRequest, context: { params: Promise<ParamMap[Route]> }) => Promise<Response | void> | Response | void
  PATCH?: (request: NextRequest, context: { params: Promise<ParamMap[Route]> }) => Promise<Response | void> | Response | void
  DELETE?: (request: NextRequest, context: { params: Promise<ParamMap[Route]> }) => Promise<Response | void> | Response | void
  HEAD?: (request: NextRequest, context: { params: Promise<ParamMap[Route]> }) => Promise<Response | void> | Response | void
  OPTIONS?: (request: NextRequest, context: { params: Promise<ParamMap[Route]> }) => Promise<Response | void> | Response | void
}

`
  }

  if (pagesApiRouteValidations) {
    typeDefinitions += `type ApiRouteConfig = {
  default: (req: any, res: any) => ReturnType<NextApiHandler>
  config?: {
    api?: {
      bodyParser?: boolean | { sizeLimit?: number | string }
      responseLimit?: string | number | boolean
      externalResolver?: boolean
    }
    runtime?: 'edge' | 'experimental-edge' | 'nodejs' | string // necessary unless config is exported as const
    maxDuration?: number
  }
}

`
  }

  const routeImports: string[] = []
  if (appPageValidations) routeImports.push('AppRoutes')
  if (layoutValidations) routeImports.push('LayoutRoutes')
  if (appPageValidations || layoutValidations || appRouteHandlerValidations)
    routeImports.push('ParamMap')
  if (hasAppRouteHandlers) routeImports.push('AppRouteHandlerRoutes')
  const routeImportStatement =
    routeImports.length > 0 ? `import type { ${routeImports.join(', ')} } from "./routes.js"` : ''

  const nextRequestImport = hasAppRouteHandlers
    ? "import type { NextRequest } from 'next/server.js'\n"
    : ''

  const nextTypes: string[] = []
  if (pagesApiRouteValidations) nextTypes.push('NextApiHandler')
  if (appPageValidations || layoutValidations)
    nextTypes.push('ResolvingMetadata', 'ResolvingViewport')
  const nextTypesImport =
    nextTypes.length > 0 ? `import type { ${nextTypes.join(', ')} } from "next/types.js"\n` : ''

  return `// This file is generated automatically by Next.js
// Do not edit this file manually
// This file validates that all pages and layouts export the correct types

${routeImportStatement}
${nextTypesImport}${nextRequestImport}
${typeDefinitions}
${appPageValidations}

${appRouteHandlerValidations}

${pagesRouterPageValidations}

${pagesApiRouteValidations}

${layoutValidations}
`
}
