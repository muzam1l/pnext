# Routing

Routes come from the file tree under `app/`. Directories make the URL path, and a `page` file inside one renders it as its default export.

## Path patterns

| Directory                  | Serves                                  |
| -------------------------- | --------------------------------------- |
| `app/about/`               | `/about`                                |
| `app/users/[id]/`          | `/users/:id`                            |
| `app/docs/[...slug]/`      | `/docs/*`                               |
| `app/docs/[[...slug]]/`    | `/docs` and `/docs/*`                   |
| `app/(marketing)/pricing/` | `/pricing`, the group adds no segment   |
| `app/dashboard/@team/`     | a slot of `/dashboard`, no path segment |

## Convention files

| File           | What it does                                              |
| -------------- | --------------------------------------------------------- |
| `page`         | Renders a UI route.                                       |
| `layout`       | Exports metadata and can wrap descendant pages.           |
| `route`        | Defines HTTP handlers.                                    |
| `loading`      | Suspense fallback for the segment.                        |
| `error`        | Fallback UI when server rendering throws in the segment.  |
| `not-found`    | Fallback UI for `notFound()` and unmatched URLs.          |
| `template`     | Wraps children like a layout, but re-renders per request. |
| `default`      | Fallback for a parallel slot with no page match.          |
| `global-error` | Replaces the whole document for an uncaught root error.   |

Convention files are matched across `.tsx`, `.ts`, `.jsx`, `.js`, and `.mjs`, with the TypeScript extensions tried first. Route handlers are the exception: they do not match `.jsx`. A proxy file lives at the project root rather than in a segment, and is covered under [Proxy](#proxy).

Behavior worth knowing:

- `loading`: static builds wait for the final HTML, while dev and server responses can stream the fallback first.
- `error`: receives `error`, `reset`, and `unstable_retry`. Both callbacks refresh the current route in `compat.next` apps.
- `not-found`: `pnext build` also writes `404.html` when the app root has one.
- `global-error`: renders its own `<html>` and `<body>`, so pnext serves that markup instead of the normal document shell. A nearer error boundary wins, and a `"use client"` directive opts the file out.
- `template`: nesting order is layout, then template, then children. A segment with no layout still applies its template.
- `forbidden` and `unauthorized`: experimental `compat.next` boundaries that render 403 and 401 responses. Without compat, the thrown errors take the normal error path. The `forbidden()` and `unauthorized()` functions are core exports either way. See [Navigation](./navigation.md#auth-interrupts).

To leave a route, use `redirect()` or `notFound()`. See [Navigation](./navigation.md#redirects-and-not-found).

## Page props

Pages receive explicit props:

```ts
type PageProps<P = Record<string, string | string[]>> = {
  params: Promise<P>
  searchParams: Promise<Record<string, string | string[] | undefined>>
  request?: NextRequest
}
```

Read request data from the request prop. Typed per-route versions of these props are generated for you; see [Type Safety](./typegen.md).

## Route handlers

A `route` file exports one function per HTTP method. The request extends the standard `Request` with convenience access for cookies and `nextUrl`, and the context carries the route params.

```ts
export async function GET(
  request: NextRequest,
  { params }: RouteContext,
) {
  const { id } = await params
  return Response.json({ id })
}
```

If a handler does not export `OPTIONS`, pnext answers with an automatic response carrying an `Allow` header. Unsupported methods get a 405 with that same header.

Static `GET` handlers are written as files during the build. A dynamic handler can export `params()` to write selected param outputs at build time.

## Static and dynamic routes

pnext infers rendering from what a route uses:

- Static: no dynamic params and no request prop usage.
- Dynamic: request prop usage or dynamic route segments.

Segment config overrides the inference. Hydration is inferred separately, from `"use client"`.

## Route segment config

Pages, layouts, and route handlers can export segment config. Values must be literals, because they are read from the source rather than evaluated.

```ts
export const dynamic = 'force-dynamic'
export const maxDuration = 60
```

- `dynamic`: `auto`, `force-dynamic`, `force-static`, or `error`.
- `revalidate`: a non-negative number, or `false`.
- `dynamicParams`: `false` restricts the route to its generated params.
- `runtime`: `edge` or `nodejs`.
- `maxDuration`: seconds, copied into the generated Vercel Node function metadata.
- `fetchCache`: `auto`, `default-cache`, `only-cache`, `force-cache`, `force-no-store`, `default-no-store`, or `only-no-store`.
- `prefetch`: `allow-runtime`, `partial`, or `unstable_eager`.
- `unstable_instant`: experimental, described below.

Config merges across the route's own file and its layout chain, leaf-first, so the nearest declaration wins. Two values behave differently: `force-dynamic` on any segment forces the whole route, and the lowest declared `revalidate` wins.

Setting `dynamicParams` to false applies to the dynamic segment declared by that file. When every dynamic segment has static params, requests must match a generated param tuple. Otherwise pnext drops the restriction and renders the route on demand. A page-level static params export makes this check apply to the complete param tuple.

`unstable_instant` is experimental. Set it to `true` or to an object of samples to opt in, and a leaf `false` overrides a layout opt-in. A full prefetch of such a route uses sampled request data and leaves `connection()`-gated content out of that prefetch render.

`experimental_ppr` is also experimental. For a request-using page without dynamic route segments, it records the page as a partial-prerendering candidate. See [Rendering](./rendering.md#experimental-partial-prerendering-and-cachecomponents).

`preferredRegion` is a `compat.next`-only export. It accepts a string or string array and is written to compat deployment metadata.

## Proxy

A `proxy` file at the project root runs before static files, pages, and route handlers.

```ts
import { NextResponse, type NextRequest } from '@wular/pnext/server'

export const config = { matcher: ['/admin/:path*'] }

export function proxy(request: NextRequest) {
  if (!request.cookies.has('session')) {
    return NextResponse.redirect(new URL('/login', request.url))
  }
  return NextResponse.next()
}
```

Return one of:

- `NextResponse.next()` to continue to the matched static file, page, or route handler.
- `NextResponse.redirect(url)` for a redirect response.
- `NextResponse.rewrite(url)` to serve another path without changing the browser URL.
- `new Response(...)` for a custom response.

The matcher accepts a string, an array of strings, or objects with a source pattern plus `has` and `missing` conditions on header, query, cookie, and host. Patterns support exact paths, `:param`, `:path*`, and regex. Without a matcher, every request runs through the proxy.

A `middleware` file works the same way and is supported for compatibility. Use a proxy file for new code, and note that it wins if both exist.

## Static params

Export `params()` from a dynamic route to choose which params `pnext build` writes as static HTML. See the typed example in [Type Safety](./typegen.md). Under `compat.next`, `generateStaticParams()` fills the same role when a module has no `params()` export.

## Parallel routes

A slot directory such as `@team` contributes no path segment. Its content is rendered and passed to the owning segment's layout as a prop named after the slot, alongside `children`. A slot uses its `page` when present, then its `default` fallback, and otherwise renders nothing. A slot's `loading` file wraps its content in a Suspense boundary.

## Intercepting routes

A marker prefixed to a segment intercepts a route from another level, and is stripped from the resulting path:

- `(.)segment` intercepts from the same level.
- `(..)segment` intercepts from one level up.
- `(..)(..)segment` intercepts from two levels up.
- `(...)segment` intercepts from the app root.

The intercepting route answers soft navigations toward the marked target, usually rendering into a parallel slot. A hard request renders the non-intercepted target instead. Intercepting routes are always dynamic and never take static params.
