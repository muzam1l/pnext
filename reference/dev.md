# Development

The `pnext` CLI carries the whole flow: `dev` while you build, `analyze` to inspect what ships, `build` and `start` for production.

```sh
pnext dev [directory] [--port 3000] [--hostname 127.0.0.1]
pnext build [directory] [--adapter vercel] [--verbose]
pnext start [directory] [--port 3000] [--hostname 127.0.0.1]
pnext analyze [route] [directory] [--brotli] [--files] [--json]
pnext typegen [directory]
pnext create <directory> [--no-install]
pnext migrate [directory] [--dry-run]
```

`create` scaffolds a new app with everything set up. `migrate` converts a Next.js project in place: it rewrites `package.json` and `tsconfig.json` and creates a `pnext.config.ts` with `compat.next` enabled, without editing app source; `--dry-run` previews. To set a project up by hand, add the package and scripts:

```json
{
  "devDependencies": {
    "@wular/pnext": "latest"
  },
  "scripts": {
    "dev": "pnext dev",
    "build": "pnext build",
    "start": "pnext start",
    "analyze": "pnext analyze"
  }
}
```

## Dev server

`pnext dev` starts a Bun HTTP server that scans the route tree, renders matching pages on request, and serves static assets from `public/`. Client route entries are built on demand and cached in `.pnext/cache`. Browser pages reload on route-tree changes over a server-sent events stream at `/__pnext/events`; the other `/__pnext/*` endpoints are implementation details, not application routes.

The dev server does not typecheck in the request path; run your package's lint and typecheck scripts separately. `pnext typegen` regenerates the route types on demand; see [Type Safety](./typegen.md).

In Activity Monitor and `ps`, the dev server runs as `pnext-dev`, builds as `pnext-build`, and the bundler service as `pnext-esbuild`. The dev server re-execs itself when its memory passes `PNEXT_DEV_MAX_RSS_MB` (default 2048), and restarts the bundler past `PNEXT_DEV_MAX_ESBUILD_RSS_MB` (default 1024).

## Analyze

`pnext analyze` reports the client JavaScript behind each route. Optionally pass a route, either a template like `/users/[id]` or a concrete path, to report on that route only. `--files` breaks the report into files, `--brotli` measures with brotli instead of gzip, and `--json` emits machine-readable output.

## Build and run

`pnext build` makes the production build and `pnext start` serves it. Routes render on the server per request; ones that never read the request are prerendered to static HTML at build time. A `compat.next` build typechecks off-thread alongside bundling.

Debug flags: `--experimental-build-mode compile|generate` splits the build into its two phases, `--debug-build-paths <paths>` narrows diagnostics to matching paths, and `--debug-prerender` prints prerender diagnostics.

## Deploy

pnext deploys anywhere Bun runs: a VPS, a container, or any host you control. Run `pnext build` on the machine or in CI, then `pnext start` serves the app on your port.

Vercel has a dedicated adapter: `pnext build --adapter vercel` writes Build Output to `.vercel/output`. Static pages and static route-handler responses are emitted as files; everything dynamic runs in a single `_pnext` function on Vercel's Bun runtime.

## Environment variables

- `PNEXT_COMPAT=next`: Next compatibility without a config file. See [Compatibility](./compat.md).
- `PNEXT_TYPECHECK=classic`: in-process TypeScript checker instead of the native one.
- `PNEXT_TRACE=<scopes>`: turn on diagnostic output. Comma-separated scopes, each `scope` or
  `scope=value`; `1` means `boot`. A scope is all-or-nothing — it turns on everything it covers.
  Example: `PNEXT_TRACE=boot,server=/tmp/modules.json`.

| scope    | prints / does                                                                                                                                                           |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `boot`   | boot-phase timings and memory readings                                                                                                                                  |
| `server` | dev request, render and build timings; per-module compile attribution; route-facts and global-css hit/miss; why each artifact was recompiled; load-plugin registrations |
| `vendor` | vendor saturation spans, esbuild plugin-callback attribution, and the preplan / native decision report                                                                  |
| `client` | client-build phase timings, plus the esbuild metafile written into the output directory                                                                                 |
| `all`    | the four above                                                                                                                                                          |

Two scopes take a `=<path>` value:

- `server=<path>` dumps the per-module compile list as JSON. A `.jsonl` path collects the
  heavy-package facade profile instead — the two are never wanted at once, so the suffix picks.
- `vendor=<path>` appends the JSONL workload trace `bench/tools/vendor-analyze.ts` reads.
