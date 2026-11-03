# Performance

Measured results against Next.js, and what a route ships to the browser. The numbers come from running the same hello-world, SSR, and 30-route dashboard fixtures under both frameworks. Ratios are Next.js time or memory divided by pnext, so a larger number favors pnext.

| Metric                        | Result across the three fixtures |
| ----------------------------- | -------------------------------- |
| Dev first page HTML           | **5.3–15.6× faster**             |
| HMR save to visible content   | **1.3–5.9× faster**              |
| Production build time         | **6.0–16.3× faster**             |
| Dev server memory             | **3.1–4.2× less**                |
| Production cold start (ready) | **1.9–2.1× faster**              |

For interactive tables and per-fixture values, see [pnext.dev/benchmarks](https://www.pnext.dev/benchmarks).

## What ships to the browser

First paint is what a page's document loads. Deferred is what the page can fetch after that: the navigation runtime loads on idle when the page has a `<Link>` and otherwise on first navigation, the `compat.next` error runtime loads on idle, and the server-action runtime loads only on a page with an action.

| Page                                 | First paint (gzip) | Deferred (gzip) |
| ------------------------------------ | ------------------ | --------------- |
| Server-rendered page                 | 0 KB               | 0 KB            |
| Server-rendered page with a `<Link>` | 1.3 KB             | 21 KB, on idle  |
| One island, core pnext (Preact)      | 8.5 KB             | 0 KB            |
| One island, `compat.react`           | 15 KB              | 0 KB            |
| One island, `compat.next`            | 13.1 KB            | 33 KB           |

`compat.next` ships Next's router bootstrap on every page, so its pages are never the 0 KB case. These rows are the "Client runtime bundles" table of `bun bench/run.ts --bundles`.

## The HMR result

HMR is faster than Next.js on all three fixtures, by the smallest margin on the dashboard. pnext uses live reload rather than a client HMR runtime, so component state does not survive a save. The measurement above is the time until the page serves fresh visible content.

## How these were measured

These results are from **2026-11-03**, using Bun **1.4.0** and Next.js **16.3.4** on a 4-vCPU AMD EPYC Linux x64 CI runner. Each metric used five runs, discarded the first, and reports medians.

- The fixtures use the same source under both frameworks.
- Dev first page HTML includes on-demand compilation after a cold server start.
- Dev memory is summed across the server process tree after readiness and seven warm requests.
- Build memory is the operating system's reported peak RSS.
