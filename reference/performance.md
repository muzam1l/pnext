# Performance

Measured results against Next.js, and what a route ships to the browser. The numbers come from running the same hello-world, SSR, and 30-route dashboard fixtures under both frameworks. Ratios are Next.js time or memory divided by pnext, so a larger number favors pnext.

| Metric                        | Result across the three fixtures                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| Dev first page HTML           | **10.1–12.4× faster**                                                                 |
| HMR save to visible content   | **2.0× faster** on hello-world; **3.1–3.9× slower** on the SSR and dashboard fixtures |
| Production build time         | **7.2–8.8× faster**                                                                   |
| Dev server memory             | **3.4–4.1× less**                                                                     |
| Production cold start (ready) | **1.8–2.3× faster**                                                                   |

For interactive tables and per-fixture values, see [pnext.dev/benchmarks](https://www.pnext.dev/benchmarks).

## What ships to the browser

Server-only routes ship 0 KB of route JavaScript, because they need no browser runtime to render their content.

For client navigation and prefetching, the prefetch-only runtime is 348 B gzip. The combined router and hydrator runtime is 4.47 KB gzip.

Routes using the Next compatibility layer carry its navigation client, so their client-JS numbers are not the core zero-JS case.

## The HMR result

HMR is slower than Next.js on the larger fixtures and is under investigation. pnext uses live reload rather than a client HMR runtime, so component state does not survive a save. The measurement above is the time until the page serves fresh visible content.

## How these were measured

These results are from **2026-08-20**, using Bun **1.3.10** and Next.js **16.2.12** on a Blacksmith 4-vCPU (Intel Xeon), 16 GB RAM, Ubuntu 22.04 x64 CI runner. Each metric used five runs, discarded the first, and reports medians.

- The fixtures use the same source under both frameworks.
- Dev first page HTML includes on-demand compilation after a cold server start.
- Dev memory is summed across the server process tree after readiness and seven warm requests.
- Build memory is the operating system's reported peak RSS.
