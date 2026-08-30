# Compatibility

pnext is Next.js-shaped. With `compat.next` on, App Router apps behave the way they do in Next: the `next/*` module surface, `next.config.js`, server actions, metadata, proxy and middleware, `'use cache'`, the `/_next/image` optimizer, and the `next/navigation` router. That is validated by running Next.js's own test suite against pnext, with 4,400+ assertions passing, rather than by hand-written parity claims.

```ts
export default {
  compat: {
    react: true, // map react/react-dom onto Preact
    next: true, // the next/* surface + next.config.js; implies react
    reactCompiler: true, // React Compiler for React-style Client Components; implies react
  },
}
```

`compat.react` aliases `react`, `react-dom`, `react-dom/client`, `react-dom/server`, `react/jsx-runtime`, `react/jsx-dev-runtime`, and `react/compiler-runtime` onto Preact-backed shims. React's `cache()` maps to pnext's request cache on the server. Importing `next/*` or `react` without the matching mode is a build error that names the flag to enable.

To turn Next compatibility on without a config file, set `PNEXT_COMPAT=next`. See [Environment Variables](./env.md).

## Migrating a Next.js app

```sh
bunx @wular/pnext@latest migrate --dry-run
bunx @wular/pnext@latest migrate
```

Migration rewrites `package.json` and `tsconfig.json`, and creates a `pnext.config.ts` with `compat.next` enabled. It reports on your app source but never edits it.

## What differs from Next

These are the places pnext deliberately does not match Next. Read them before migrating. Together with the caveats in the feature notes below, this is the whole list.

### Preact, not React

The streaming renderers from `react-dom/server`, `renderToReadableStream` and `renderToPipeableStream`, throw. The synchronous `renderToString` and `renderToStaticMarkup` work. Client components run on Preact's reconciler, so code reaching into React internals is out of scope.

Direct Preact imports and Preact Signals need no compat and produce smaller bundles than `preact/compat`.

### No Flight payload

Soft navigation and server-action responses carry HTML, not a React Flight stream. Streaming, refresh, and revalidation-driven updates all work. Consuming the RSC payload as a wire format does not.

Server-rendered JSX can cross into a Client Component as `children` or through any other prop, including nested in arrays and plain objects. Both stay server-rendered static HTML and ship no code, as in Next. Elements inside `Map` and `Set` props are the one shape that throws.

### Pages Router is emulated

A `pages/` directory is materialized onto App Router routes, so `getStaticProps` and `getServerSideProps` pages and `pages/api` handlers run. `_app`, `_document`, and `_error` are ignored. `next/head` renders nothing, so use the metadata exports instead. `next/router` maps onto the app router where the concepts line up and no-ops elsewhere.

### No webpack or Turbopack

esbuild is the only bundler. A `webpack(config)` function in `next.config.js` is not executed, and pnext warns once at config load when one is present. Loader chains from `turbopack.rules`, plus `turbopack.resolveAlias`, `transpilePackages`, `modularizeImports`, and `optimizePackageImports`, are re-implemented on esbuild directly.

A `webpack()` function that references `@svgr/webpack`, by far the most common custom-loader use, is auto-detected. pnext then compiles `.svg` imports to inline Preact components, matching that loader's default output. Root SVG attributes are spread first, so props such as `className`, `width`, and `height` override them. Without that reference, `.svg` imports keep the normal static-asset URL behavior.

### Cache state is per process

`revalidatePath`, `revalidateTag`, `unstable_cache`, and `'use cache'` entries live in the server process by default, so a multi-instance deployment revalidates one instance. Configure `cacheHandler` in `next.config.js` for a shared store.

### Optional native dependencies

All three ship as `optionalDependencies`, so a normal install has them, the same as Next. These paths only matter when the optional install fails.

- `next/image`'s `/_next/image` optimizer needs `sharp`. The component, `images` config validation, and static imports work without it.
- `next/og`'s `ImageResponse` needs `satori` and `@resvg/resvg-js`. Without them, or without a usable font, it answers with a valid placeholder PNG instead of failing the request.
- `next/font/google` resolves the catalog through `next-font`. If it cannot, the build fails rather than falling back to a hosted font.

### Smaller surfaces

- `userAgent()` uses an in-house parser covering mainstream browsers, engines, CPUs, and devices, not the full ua-parser-js database.
- React's taint functions do not exist under Preact, so pnext does not export them. What it implements is the guarantee `experimental.taint` exists for: with the flag on, `process.env` is registered as tainted, and passing that object as a client-component prop at any depth throws. Development shows the message in the nearest error boundary and production shows React's redacted error text, matching Next. Tainting your own objects or values is not available.
- `ViewTransition` and `addTransitionType` are exported from the `react` entry so pages importing them render instead of throwing, and `next/link` accepts `transitionTypes`. Support stops there: the component is a passthrough that renders no DOM, and pnext does not drive `document.startViewTransition`, so declared names and types are recorded but no browser transition is played.
- Only these `next/dist/*` paths are shimmed. Any other deep import fails with an error naming this list.
  - `next/dist/client/components/app-router-headers`
  - `next/dist/server/web/spec-extension/unstable-cache`
  - `next/dist/server/web/spec-extension/unstable-no-store`
  - `next/dist/server/web/spec-extension/revalidate`
  - `next/dist/server/app-render/work-unit-async-storage.external` (server only)

## Feature notes

The rest of the surface ships as well. Each note says where support stops short.

### redirects and rewrites

`redirects()` and `rewrites()` in `next.config.js` are both honored. Sources support the `:param`, `:param*`, `:param+`, `:param?`, and `:param(regex)` tokens, plus `has` and `missing` conditions on host, header, query, and cookie. Named capture groups feed their values into destination parameters.

Rewrites accept the array form and the object form with `beforeFiles`, `afterFiles`, and `fallback`, and entries setting `basePath: false` match the raw path. An external `http` or `https` destination is proxied through a server-side fetch. After a rewrite fires, `usePathname()` and `useSearchParams()` still report the URL the browser asked for.

Redirects use 308 for `permanent: true`, 307 for `permanent: false`, or an explicit `statusCode`, and they keep external destinations as redirects.

One partial: fallback rewrites apply only to requests that would otherwise 404, and in development that check consults the route table alone, since there is no built output to look at.

### after()

`after()` from `next/server` runs work once the response is fully sent. Each callback runs exactly once, when the response closes, on every path: stream end, a redirect, a not-found, a thrown error, or a client abort. Calls nested inside an `after()` task run too. When the host platform supplies the Vercel request context, each task is also handed to its `waitUntil` so a serverless invocation stays alive until the task settles. An `after()` task that throws during a build prerender fails the build rather than quietly degrading the route.

### next/form

`Form` renders a GET form and intercepts submission into a client-side navigation, building the destination URL from the form's fields. String actions get the basePath applied and are prefetched like a link, including a re-prefetch when a revalidation invalidates them. Function actions pass straight through as React form actions with no interception. A submitter that overrides the encoding, method, or target falls back to the browser's native submit, and file inputs are not submitted with a string action. Both cases warn in development.

### instrumentation and instrumentation-client

An `instrumentation` file at the project root or in `src/` is bundled and imported once at server start. Its `register()` is awaited before the first request is served, and its `onRequestError` export is wired into the error funnel. When the app contains any edge entity, meaning a proxy or middleware, or a route declaring an edge runtime, a second freshly loaded instance is registered with `NEXT_RUNTIME` set to `edge`, mirroring Next's separate edge boot.

An `instrumentation-client` file is bundled with any `instrumentationClientInject` entries ahead of it, in configured order, and loaded from the document head so it runs before hydration. Each module's `onRouterTransitionStart` export is called at the start of every soft navigation. Apps without such a file get no extra bundle and no extra head tag.

### OpenTelemetry

pnext emits Next's span taxonomy through the global `@opentelemetry/api` that your instrumentation file registers: a root request span carrying `next.route` and `http.status_code`, plus child spans for rendering, route handlers, `fetch`, middleware and proxy, and Pages Router data and API handlers. Incoming `traceparent` headers are extracted, and errors caught by the request funnel mark the root span.

`@opentelemetry/api` is an optional dependency resolved from your own `node_modules`, so pnext and your SDK share one API singleton. When the package is absent, every tracing helper is inert. Keys listed in `experimental.clientTraceMetadata` are injected into the document head as meta tags.

### MDX

`.mdx` and `.md` modules compile through `@mdx-js/mdx`, an optional dependency loaded on the first MDX compile, so an app that never imports MDX does not need it installed. `createMDX()` from `@next/mdx` is understood at config load, so the remark, rehype, and recma plugins you configure there run. MDX files become routes only when `pageExtensions` lists the extension, matching Next. An `mdx-components` file supplies the component provider, and without one MDX emits plain host elements. One caveat: MDX currently compiles in the client graph, so treat an MDX module as client code.

### Edge runtime

A route or proxy declaring an edge runtime, and a Pages Router handler configured for `edge` or `experimental-edge`, runs with `process.env.NEXT_RUNTIME` set to `edge`, the `EdgeRuntime` global defined, and a `process` object that hides `version` and `versions` so code branching on those detects the edge environment. This is an emulation inside the same Bun process rather than a separate isolate, so the Edge API subset is not enforced: Node built-ins stay reachable, and code that only works because of that will still fail on a real edge platform.

### Root params

`next/root-params` resolves parameters from the root dynamic segment. It works in layouts, pages, and `'use cache'` functions, and inside `generateStaticParams` when a parent `generateStaticParams` already provided the parameter. Calling it inside a server action, inside `unstable_cache`, or from a route handler throws with the same diagnostics Next produces. Reading one marks every segment of the response as varying.

### output: 'export' and output: 'standalone'

`output: 'export'` writes a static tree to `out/`, or to `distDir` when the app configures a custom one. The tree carries the HTML and the flat per-page artifacts the client router fetches when no pnext server is present, the client runtime under `_next/static/chunks/`, the build manifests, the `public/` tree, and the not-found page. Dynamic routes without `generateStaticParams`, pages forcing dynamic rendering, and route handlers with disallowed segment config are build errors, as they are in Next.

`output: 'standalone'` writes `.next/standalone/` with a `server.js` that boots on `PORT` and `HOSTNAME`, along with a `.nft.json` trace beside each page entry and a middleware manifest. Because pnext's production server runs under Bun, that launcher is a thin Node script that re-executes the real pnext server pointed back at the original build directory. The folder is therefore not a self-contained bundle you can ship on its own, because the build tree has to travel with it.
