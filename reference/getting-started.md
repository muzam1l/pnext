# Getting Started

pnext is a Preact framework for file-routed apps. It renders on the server by default and ships client JavaScript only where a component opts in.

> pnext requires [Bun](https://bun.sh/get) 1.3.10 or newer (1.4.0 recommended) - make sure it is installed first.

<!-- tabs:start -->

## New app

```sh
bunx @wular/pnext@latest create my-app
cd my-app
bun dev
```

The app is running at `http://localhost:3000`. Edit `app/page.tsx`; the browser reloads on save.

`app/page.tsx` is a Server Component: it can be async, load data on the server, and ships no client JavaScript. The counter it renders, `app/counter.tsx`, starts with `'use client'`, so it alone hydrates in the browser. That's the model: files name routes, the server renders by default, components opt in to the client.

## Coming from Next.js

Run in your Next project:

```sh
bunx @wular/pnext@latest migrate
```

It converts the project to pnext with `compat.next` enabled, without editing app source. `--dry-run` previews.

With `compat.next`, the `next/*` modules, `next.config.js`, server actions, metadata, and the rest of the App Router behavior work as they do in Next, validated against Next's own test suite. [Compatibility](./compat.md) covers the full surface and where it stops short.

<!-- tabs:end -->

## Build and deploy

```sh
pnext build
pnext start
```

`pnext build` makes the production build and `pnext start` serves it. Routes render on the server per request; ones that never read the request are prerendered to static HTML at build time.

That deploys anywhere Bun runs. For Vercel, build with `pnext build --adapter vercel` and it writes ready-to-deploy Build Output.

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

Client Components hydrate on Preact for ~7.5 KB of framework, or ~12.5 KB with [`compat.react`](./compat.md) if you want to run React components and libraries unchanged. Offscreen islands can stay out of the initial bundle entirely with `dynamic({ load: 'visible' })`.

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

## References

- [Routing](./routing.md)
- [Navigation](./navigation.md)
- [Rendering](./rendering.md)
- [Metadata](./metadata.md)
- [CSS](./css.md)
- [Environment Variables](./env.md)
- [Config](./config.md)
- [Type Safety](./typegen.md)
- [Compatibility](./compat.md)
- [Development](./dev.md)
- [Performance](./performance.md)
