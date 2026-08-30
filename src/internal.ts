import type {
  LayoutProps,
  Metadata,
  PageProps,
  RoutePath,
  ServerComponent,
  StaticParams,
  Viewport,
} from './types'

export type PNextMetadataExport = Metadata | (() => Metadata | Promise<Metadata>)
export type PNextViewportExport = Viewport | (() => Viewport | Promise<Viewport>)

export interface PNextPageModule<Route extends RoutePath> {
  default: ServerComponent<PageProps<Route>>
  params?: () => StaticParams<Route>
  metadata?: PNextMetadataExport
  viewport?: PNextViewportExport
}

export interface PNextLayoutModule {
  default?: ServerComponent<LayoutProps>
  metadata?: PNextMetadataExport
  viewport?: PNextViewportExport
}

type NextHandler = {
  bivarianceHack(request: never, context: never): Response | Promise<Response>
}['bivarianceHack']

export interface PNextRouteHandlerModule<Route extends RoutePath> {
  GET?: NextHandler
  POST?: NextHandler
  PUT?: NextHandler
  PATCH?: NextHandler
  DELETE?: NextHandler
  OPTIONS?: NextHandler
  HEAD?: NextHandler
  params?: () => StaticParams<Route>
}
