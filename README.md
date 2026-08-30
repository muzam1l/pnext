<div align="center">

# pnext

**A fast little framework for server-first React apps, fully compatible with Next.js.**[<sup>1</sup>](./reference/compat.md)

</div>

## Getting started

> pnext requires [Bun](https://bun.sh/get) - make sure it is installed first.

A new app:

```sh
bunx @wular/pnext@latest create my-app
```

Migrating a Next.js app? This rewrites scripts and config in place, scans your source, and reports anything that needs a look (it never edits your code):

```sh
bunx @wular/pnext@latest migrate
```

Or by hand: `bun add -d @wular/pnext`, then `pnext dev`.

[Getting Started](./reference/getting-started.md) walks through all of it, from first page to build.

## Incremental by design

Server-rendered pages ship **0 KB** of JavaScript, or **~1 KB gzip** if you want client-side navigation and prefetching. Interactive pages hydrate on Preact for **~7.5 KB** of framework, **~12.5 KB** with React compatibility. Everything is instant, the first page in dev renders **10–12× faster** than Next.js on **3.5–4× less memory**, and production builds run **7–9× faster**. See [Performance](./reference/performance.md).

Core pnext is pure Preact. `compat.react` runs React components and libraries on it, and `compat.next` runs a whole Next.js App Router app unchanged. Start anywhere on that ladder and move when it suits you. The App Router compatibility is validated against Next's own test suite (4,400+ assertions passing). The `pages/` folder or private internal utilities of Next.js or React are mostly not supported. See [Compatibility](./reference/compat.md).

## A quick tour

### Your first page

Routes live in `app/`. A `page.tsx` is a Server Component by default. It runs only on the server, so it can be async and talk to your database, filesystem, or internal services directly. None of that code reaches the browser:

```tsx
// app/posts/[id]/page.tsx
import type { PageProps } from '#gen/app/posts/[id]/page'

export default async function Page({ params }: PageProps) {
  const { id } = await params
  const post = await db.post.findUnique({ where: { id } })
  return (
    <article>
      <h1>{post.title}</h1>
      <p>{post.body}</p>
    </article>
  )
}
```

This page ships **0 KB** of JavaScript. Layouts work the same way: the root `layout.tsx` owns `<html>` and `<body>` and can export `metadata`.

### Adding interactivity

Mark a component with `"use client"` where you need state, effects, or event handlers. Server Components render it into the page, and only that island hydrates in the browser:

```tsx
// app/counter.tsx
'use client'
import { useState } from 'preact/hooks'

export function Counter({ initial }: { initial: number }) {
  const [count, setCount] = useState(initial)
  return (
    <button onClick={() => setCount(count + 1)}>Count {count}</button>
  )
}
```

Client Components hydrate on Preact for ~7.5 KB of framework, or ~12.5 KB with [`compat.react`](./reference/compat.md) if you want to run React components and libraries unchanged. Offscreen islands can stay out of the initial bundle entirely with `dynamic({ load: 'visible' })`.

### Streaming

Wrap slow server work in `<Suspense>`. The shell streams immediately and the content follows when it's ready:

```tsx
import { Suspense } from '@wular/pnext'

export default function Page() {
  return (
    <Suspense fallback={<p>Loading comments…</p>}>
      <Comments />
    </Suspense>
  )
}
```

### APIs and everything else

A `route.ts` file is an HTTP handler:

```ts
// app/api/users/route.ts
export async function GET(request: NextRequest) {
  return Response.json(await listUsers())
}
```

- `proxy.ts` runs before route matching.
- `loading.tsx`, `error.tsx`, and `not-found.tsx` define per-segment fallbacks.
- `pnext build` makes the production build and `pnext start` serves it. Routes that never read the request are prerendered to static HTML.

## Learn more

Apps are file-routed from `app/`: `page.tsx` and `layout.tsx` are Server Components, `route.ts` files are HTTP handlers, `public/` is served from `/`. The reference covers the rest:

- [Getting Started](./reference/getting-started.md)
- [Development](./reference/dev.md)
- [Routing](./reference/routing.md)
- [Navigation](./reference/navigation.md)
- [Rendering](./reference/rendering.md)
- [Metadata](./reference/metadata.md)
- [CSS](./reference/css.md)
- [Environment Variables](./reference/env.md)
- [Config](./reference/config.md)
- [Typegen](./reference/typegen.md)
- [Compatibility](./reference/compat.md)
- [Performance](./reference/performance.md)
