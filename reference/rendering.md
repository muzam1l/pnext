# Rendering

Where a component runs, what crosses between server and browser, and how to stream or defer work. pnext renders on the server first and sends browser JavaScript only for the components that need it.

## Server Components

Pages and layouts are Server Components. They run only on the server, so they can read files, query databases, call internal services, and use server-only dependencies without any of that reaching the browser bundle. They can be async, and static builds wait for the final HTML.

```tsx
export default async function Page() {
  const post = await getPost()
  return <article>{post.title}</article>
}
```

A layout file does not need a default export. Use a metadata-only layout when a segment only needs to set page metadata.

## Client Components

A `"use client"` directive marks a component that needs browser APIs, hooks, or event handlers. Server Components can render them. They render HTML on the server, then hydrate in the browser.

```tsx
'use client'

import { useState } from 'preact/hooks'

export function Counter({ initial }: { initial: number }) {
  const [count, setCount] = useState(initial)
  return (
    <button onClick={() => setCount(count + 1)}>Count {count}</button>
  )
}
```

Files imported by a client component become client code automatically. Add the directive to an imported file only when a server component also renders it directly.

A Client Component can wrap server-rendered children. Those children stay server-rendered, and only the wrapper hydrates.

Put the directive at the top of a page when the whole page needs browser-only behavior. Prefer smaller client components when only part of the page is interactive.

## Lazy loading

`dynamic()` defers loading a component. It works in Server Components and Client Components alike, and inside a Client Component it is a browser lazy loader. The loader can also be a literal module path for a default export.

```tsx
import { dynamic } from '@wular/pnext/dynamic'

const Chart = dynamic(() => import('./chart').then(m => m.Chart), {
  load: 'visible',
})
```

A Client Component target renders on the server and hydrates by default. The options change that:

- `ssr: false` produces browser-only output.
- `load: 'visible'` waits for the island to enter view, and accepts `rootMargin` and `threshold`. It is browser-only as well unless `ssr` is true.
- `loading` supplies fallback UI.

## Props that cross the boundary

Props passed from a server component to a client component must be serializable.

- Accepted: strings, numbers, booleans, `null`, `undefined`, arrays, plain objects, `Map`, `Set`, typed arrays, and `ArrayBuffer`.
- Rejected: functions, symbols, `bigint`, and class instances such as `Date` and `URL`. Pass those as strings.

Self-referencing values are fine, because they are written as back-references.

## Reading request data

The request prop on a page or layout is a `NextRequest` compatible object, which extends the standard Request with convenience access for cookies and headers, plus method and URL.

```tsx
const theme = request?.cookies.get('theme')?.value
```

Reading it keeps static routes static and marks request-dependent routes dynamic. Apps using `compat.next` can import `cookies()` and `headers()` from `next/headers` instead.

## Streaming

A Suspense boundary sends fallback HTML while the server finishes the content inside it.

```tsx
<Suspense fallback={<p>Loading comments...</p>}>
  <Comments />
</Suspense>
```

Dev and server responses stream the fallback first, then replace it when the content is ready. Static builds wait for the final content.

pnext exports `Suspense` and `SuspenseProps` from `@wular/pnext` and resolves these boundaries in its own renderer, so core apps need nothing from `preact/compat`. Apps with `compat.react` can keep importing React's `Suspense`, since both identities are recognized.

A segment `loading` file creates one of these boundaries automatically. See [Routing](./routing.md#convention-files).

## Request cache

`cache()` dedupes repeated work inside one render or route-handler request.

```tsx
import { cache } from '@wular/pnext/cache'

export const getPost = cache(async (id: string) =>
  db.post.findUnique({ where: { id } }),
)
```

Calls with the same arguments share one result. The cache is cleared between requests, so it never shares data across users. It is not a persistent data cache, and it should not be imported from Client Components.

## Root layout

The root layout owns the document. One with a default component must return `<html>` and `<body>`. One that only exports metadata gets a document shell from pnext. For the head itself, see [Metadata](./metadata.md).

```tsx
import type { LayoutProps } from '@wular/pnext'

export default function Layout({ children }: LayoutProps) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
```

## Experimental: partial prerendering and cacheComponents

A page that uses request data and exports `experimental_ppr` produces a static shell with postponed Suspense content that is resumed for the request. The renderer represents postponed work with a `PostponeError`, so wrap that content in Suspense rather than handling the error yourself.

`cacheComponents` requires `compat.next` and is set in the loaded Next configuration. It makes the shell-and-resume path the default, and turns request APIs into values that postpone when first awaited inside Suspense during prerendering: `cookies()`, `headers()`, `connection()`, route params, search params, and `io()`. The `io()` helper comes from the compat API and has no effect unless cacheComponents is enabled.

Cache lifetimes and cache tags recorded during prerendering are honored when prebuilt output is served, including partial shells. Reach them through the Next `cacheLife()` and cache-tag APIs, which compat supplies.
