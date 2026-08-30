# Navigation

Links, prefetching, redirects, and the client router. Server and browser APIs sit in separate entry points, so a server route never pulls in router code meant for the browser.

## Link

Renders a normal anchor. The href is a route template, and params are checked against the generated route types, so a wrong name or a missing param fails TypeScript. Use a plain anchor for external URLs and for links you do not want typed.

```tsx
import { Link } from '@wular/pnext/link'

export function Nav() {
  return (
    <Link
      href="/users/[id]"
      params={{ id: 'ada' }}
      search={{ tab: 'runs' }}
    >
      Ada
    </Link>
  )
}
```

| Prop                                  | Value                                                         |
| ------------------------------------- | ------------------------------------------------------------- |
| `href`                                | Generated route path.                                         |
| `params`                              | Required for dynamic routes.                                  |
| `search`                              | Query params.                                                 |
| `hash`                                | Hash fragment.                                                |
| `prefetch`                            | `false`, `'intent'`, `'visible'`, or `'load'`.                |
| `replace`                             | Marks the navigation as a history replace.                    |
| `scroll`                              | `false` preserves scroll on client navigation.                |
| `onNavigate`                          | Same-origin client callback that can call `preventDefault()`. |
| `onPrefetchStart`, `onPrefetchFinish` | Fire when this link's prefetch begins and settles.            |

## Prefetching

Prefetch warms the target page and its assets. Set the mode per link with the `prefetch` prop, as in `<Link prefetch="intent">`.

- `'visible'` is the default, and fires when the link enters the viewport.
- `'intent'` fires on hover, touch, or focus.
- `'load'` fires as soon as the link renders.
- `false` never prefetches. Pair it with `router.prefetch(href)` for manual control.

The app-wide default can be set with the `prefetch` field in `pnext.config.ts`, described in [Config](./config.md).

Requests use low network priority. At most four run at once, though the hover-intent lane allows up to twelve. The core fallback expiry is five minutes. Prefetch does nothing in development.

## Soft navigation

Link clicks and router pushes swap the page in place instead of reloading the document, so shared chunks and CSS are never re-downloaded. Back and forward stay soft and restore scroll. Cross-origin targets, non-HTML responses, and fetch failures fall back to a full page load.

## Redirects and not found

```tsx
import { href, notFound, redirect } from '@wular/pnext/navigation'

redirect('/login')
redirect('/login', 308)
redirect(href('/users/[id]', { params: { id: 'ada' } }))
notFound()
```

`redirect()` stops server rendering and returns a redirect response. Call it from pages, server components, route handlers, and any server helper used during rendering. Validate targets that come from user input.

The status is 307 unless you pass 303, 307, or 308. `permanentRedirect()` returns 308.

`notFound()` renders the nearest `not-found` fallback with a 404 response.

In the browser, `redirect()` navigates directly. Keep it as the last statement of an event handler, or return it, because browser navigation does not synchronously stop the rest of the handler. Use the router when you want explicit history control.

## href()

Builds a typed URL outside JSX. Routes without params take no params object.

```ts
href('/users/[id]', {
  params: { id: 'ada' },
  search: { tab: 'runs' },
})
```

## Client hooks

Exported from `@wular/pnext/navigation/client`, for use in components marked `"use client"`.

| Hook                 | Returns                                                       |
| -------------------- | ------------------------------------------------------------- |
| `useRouter()`        | `push`, `replace`, `prefetch`, `refresh`, `back`, `forward`.  |
| `usePathname()`      | Current browser pathname.                                     |
| `useSearchParams()`  | Read-only URL search params.                                  |
| `useParams<Route>()` | Current route params from the initial route state.            |
| `useRoute<Route>()`  | Pathname, route template, params, and search params together. |
| `useLinkStatus()`    | Currently always `{ pending: false }`.                        |

Router pushes and replaces are typed like links. They soft-navigate when the path or query changes, and fall back to the History API for same-URL hash updates. Cross-origin targets become a full page load. Refreshing re-fetches the current route in place.

`useSearchParams()` returns a `ReadonlyURLSearchParams`, whose mutation methods throw. Copy it before changing it.

```ts
const search = new URLSearchParams(searchParams.toString())
search.set('sort', 'asc')
router.replace('/products', { search, scroll: false })
```

## Auth interrupts

`forbidden()` and `unauthorized()` throw `PNextForbiddenError` and `PNextUnauthorizedError`, both exported from the server navigation module along with `ReadonlyURLSearchParams`. The functions are core exports, but rendering them as 403 and 401 responses needs the experimental `compat.next` auth interrupts. See [Routing](./routing.md#convention-files).
