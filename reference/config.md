# Config

An optional `pnext.config.ts` in the project root, meaning the directory passed to the CLI.

```ts
import type { PNextConfig } from '@wular/pnext'

export default {
  outDir: '.pnext',
  basePath: '',
  productionBrowserSourceMaps: false,
  compat: {
    next: true,
  },
} satisfies PNextConfig
```

This is the form `pnext create` scaffolds. With `compat.next`, pnext also loads `next.config.js`, and that file wins for the options both can set: `basePath`, `assetPrefix`, `outDir`, `trailingSlash`, `skipTrailingSlashRedirect`, and `productionBrowserSourceMaps`.

## Fields

| Field                         | Default     | What it does                                                                                               |
| ----------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------- |
| `outDir`                      | `'.pnext'`  | Build output for HTML, client assets, cache files, and `manifest.json`.                                    |
| `basePath`                    | `''`        | Path prefix for an app served below the domain root.                                                       |
| `assetPrefix`                 | `basePath`  | URL prefix for emitted assets. Set it when assets come from a CDN.                                         |
| `trailingSlash`               | `false`     | Canonicalizes URLs to a trailing slash and redirects the form without one.                                 |
| `skipTrailingSlashRedirect`   | `false`     | Serves both slash forms with no canonical redirect, preserving authored hrefs.                             |
| `productionBrowserSourceMaps` | `false`     | Emits external `.js.map` files next to production client chunks.                                           |
| `prefetch`                    | `'visible'` | Default prefetch mode for links that set none of their own. See [Navigation](./navigation.md#prefetching). |
| `workspaceRoot`               | inferred    | Monorepo root for resolving and reloading local workspace package imports.                                 |
| `htmlLimitedBots`             | see below   | User agents that get blocking metadata in the head. Applies with `compat.next`.                            |
| `adapter`                     | unset       | Narrows what a deployment adapter packs into its server function.                                          |
| `compat`                      | all `false` | Turns on the React, Next, and React Compiler compatibility layers.                                         |

Worth knowing:

- Development client output is already unminified, so it never emits sourcemaps.
- `workspaceRoot` is inferred from `package.json#workspaces` or `pnpm-workspace.yaml`, otherwise the app root. It does not change the app root used for `public/`, `.pnext/`, or `pnext.config.ts`. Set it only to override the inference.
- The `htmlLimitedBots` default is a regex covering Twitterbot, Slackbot, Bingbot, Discordbot, LinkedInBot, and the Google and Lighthouse renderers. Matching user agents receive metadata blocked in the head instead of streamed into the body.

## Compat modes

| Flag                   | Effect                                                                     |
| ---------------------- | -------------------------------------------------------------------------- |
| `compat.react`         | Aliases the React and React DOM entry points to Preact-backed shims.       |
| `compat.next`          | Adds the `next/*` surface, `next.config.js`, and Next App Router behavior. |
| `compat.reactCompiler` | Experimental React Compiler support for React-style Client Components.     |

Both `compat.next` and `compat.reactCompiler` imply `compat.react`. Direct Preact imports stay smaller than any of them, so reach for compat when you are running React-style components. React Compiler is not intended for components built around Preact Signals. See [Compatibility](./compat.md).

## Deployment adapter

`exclude` and `keep` are string lists that adjust which directories and file suffixes an adapter packs. The Vercel adapter consumes them.

```ts
export default {
  adapter: {
    exclude: ['storybook-static', '.map'],
    keep: ['runtime-assets', '.wasm'],
  },
} satisfies PNextConfig
```

## Where pnext looks for files

Routes come from `app/` or `src/app/`, and `app/` wins if both exist. Static assets come from `public/` at the project root. Under `compat.next`, a `pages/` directory is materialized onto App Router routes, and a hybrid app keeps its native `app/` routes.
