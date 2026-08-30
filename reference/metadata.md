# Metadata

Titles, descriptions, icons, and social images for a route. Metadata takes no request input in core, so it all resolves during the build, and the server sends the prebuilt head for a static route without recomputing it.

## metadata

Pages and layouts export it as an object. Metadata resolves from the root layout down to the page, and nearer segments override or extend what earlier ones set.

```tsx
import type { Metadata } from '@wular/pnext'

export const metadata: Metadata = {
  title: 'About',
  description: 'About the team',
}
```

## Fields

pnext follows the Next.js field shapes for `title`, `description`, `metadataBase`, `openGraph`, `twitter`, `robots`, `icons`, `manifest`, `alternates`, `verification`, `appleWebApp`, `appLinks`, and `other`. The [Next.js metadata fields reference](https://nextjs.org/docs/app/api-reference/functions/generate-metadata#metadata-fields) documents the full schema.

## metadata()

A no-argument function export, for values that come from somewhere else. It runs during the build.

```tsx
export async function metadata() {
  const site = await getSiteMetadata()
  return { title: site.title, description: site.description }
}
```

## viewport

Pages and layouts export it as an object or as a build-time function, the same way.

```tsx
import type { Viewport } from '@wular/pnext'

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0b0b0b',
}
```

## Metadata files

Drop these into a route segment and pnext picks them up:

- `icon`, `apple-icon`, `opengraph-image`, and `twitter-image`, as `.ico`, `.jpg`, `.jpeg`, `.png`, `.svg`, `.gif`, or `.webp`, optionally numbered as `icon2.png`.
- `sitemap.xml`.
- `favicon.ico`, `robots.txt`, `manifest.json`, and `manifest.webmanifest`, at the app root only.

The build copies them into the public output. Image and sitemap files apply to their segment and its descendants, while the root-only files are global.

## Generated metadata files

Each of the above has a code variant, written in `.tsx`, `.ts`, `.jsx`, `.js`, or `.mjs`: `icon`, `apple-icon`, `opengraph-image`, `twitter-image`, and `sitemap`, plus root-only `robots` and `manifest`.

These modules run at build time, and their generated links and route outputs are stored in the build output rather than recomputed per request. They can keep their metadata-route signatures, including `generateImageMetadata()` and `generateSitemaps()`, but core treats the results as build artifacts. Use `params()` to choose build-time params, as shown in [Type Safety](./typegen.md).

## Precedence

File-based metadata outranks page and layout metadata for images and icons, unless the page or layout defines its own image list.

The request path decides which segment's metadata files apply. Route groups and slot directories add no URL segment, and their metadata output names are disambiguated during the build.

## Request-time metadata

Anything that depends on the request needs `compat.next`: `generateMetadata()`, `generateViewport()`, streaming metadata, `headers()`, `cookies()`, and full `next/og` behavior. Under compat, `generateStaticParams()` also serves as the fallback static params provider for a module with no `params()` export. See [Compatibility](./compat.md).
