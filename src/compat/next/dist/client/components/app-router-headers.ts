// Header-name constants matching
// next/src/client/components/app-router-headers.ts exactly.
export const RSC_HEADER = 'rsc' as const
export const ACTION_HEADER = 'next-action' as const
export const NEXT_ROUTER_STATE_TREE_HEADER = 'next-router-state-tree' as const
export const NEXT_ROUTER_PREFETCH_HEADER = 'next-router-prefetch' as const
export const NEXT_ROUTER_SEGMENT_PREFETCH_HEADER = 'next-router-segment-prefetch' as const
export const NEXT_HMR_REFRESH_HEADER = 'next-hmr-refresh' as const
export const NEXT_HMR_REFRESH_HASH_COOKIE = '__next_hmr_refresh_hash__' as const
export const NEXT_URL = 'next-url' as const
export const RSC_CONTENT_TYPE_HEADER = 'text/x-component' as const

export const NEXT_INSTANT_TEST_COOKIE = 'next-instant-navigation-testing' as const

export const FLIGHT_HEADERS = [
  RSC_HEADER,
  NEXT_ROUTER_STATE_TREE_HEADER,
  NEXT_ROUTER_PREFETCH_HEADER,
  NEXT_HMR_REFRESH_HEADER,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
] as const

export const NEXT_RSC_UNION_QUERY = '_rsc' as const
export const NEXT_ROUTER_STALE_TIME_HEADER = 'x-nextjs-stale-time' as const
export const NEXT_DID_POSTPONE_HEADER = 'x-nextjs-postponed' as const
export const NEXT_REWRITTEN_PATH_HEADER = 'x-nextjs-rewritten-path' as const
export const NEXT_REWRITTEN_QUERY_HEADER = 'x-nextjs-rewritten-query' as const
export const NEXT_IS_PRERENDER_HEADER = 'x-nextjs-prerender' as const
export const NEXT_ACTION_NOT_FOUND_HEADER = 'x-nextjs-action-not-found' as const
export const NEXT_REQUEST_ID_HEADER = 'x-nextjs-request-id' as const
export const NEXT_HTML_REQUEST_ID_HEADER = 'x-nextjs-html-request-id' as const
export const NEXT_ACTION_REVALIDATED_HEADER = 'x-action-revalidated' as const
