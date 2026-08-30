# CSS

Global styles, per-route styles, CSS Modules, and the compat-only preprocessors.

## Global CSS

Imported from the root layout. pnext compiles it once and links it from every page as `/assets/global.css`.

```tsx
// app/layout.tsx
import './globals.css'
```

Global CSS can import local workspace packages, font files, image assets, and the app's PostCSS or Tailwind setup.

## Route and component CSS

Any page, layout, or component can import a stylesheet.

```tsx
import './page.css'
```

pnext emits CSS only for routes that import it. A route stylesheet is named from the route id, as `/assets/<route-id>.css`. When a compat build splits one into chunks, each name gains an index suffix.

## CSS Modules

A `.module.css` file gives scoped class names that match the server-rendered HTML.

```tsx
import styles from './page.module.css'

export default function Page() {
  return <h1 className={styles.title}>Hello</h1>
}
```

Under `compat.next`, a `:global(...)` wrapper leaves the enclosed selector unscoped.

## Tailwind and PostCSS

A `postcss.config.{cjs,js,mjs}` file at the app root makes pnext run its plugins on every emitted stylesheet. Tailwind v4 stays warm in development. Editing the config file requires a dev-server restart.

## Sass

Requires `compat.next` and the optional `sass` dependency. `.scss`, `.sass`, `.module.scss`, and `.module.sass` imports compile, and `sassOptions.includePaths` from `next.config.js` is honored. If `sass` is unavailable, Sass imports produce no CSS rather than breaking a non-Sass app.

## styled-jsx

Requires `compat.next`. Style blocks and `styled-jsx/css` are transformed to pnext's own runtime, which collects server styles and mirrors client styles into the document head. Apps do not need to install `styled-jsx`.

## Lightning CSS

Requires `compat.next` and the app's own `lightningcss` package.

- `experimental.useLightningcss` transforms CSS with it.
- `experimental.lightningCssFeatures` controls which features are included or excluded.

CSS passes through untransformed when the package is absent or the transform fails.

## Nonces and inline CSS

pnext reads a CSP nonce from the request `Content-Security-Policy` header and applies it to generated styles. With `experimental.inlineCss`, production documents inline route and global CSS in nonce-bearing style tags, while development keeps stylesheet links.

## Chunking and order

`experimental.cssChunking` groups compatible route stylesheets into fewer files while preserving each route's stylesheet order. It splits them instead when sharing a chunk would change cascade order or make a chunk too large.
