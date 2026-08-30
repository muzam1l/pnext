# visible

A landing page whose above-the-fold content is entirely server-rendered and
whose one interactive island — a pricing calculator, far below the fold —
mounts when it scrolls into view.

## Why this fixture has two source trees

Every other fixture is a single Next.js app run twice, because `compat.next`
makes pnext accept Next source unchanged. That cannot work here: the tier
under test is pnext's **core** `dynamic(load: 'visible')`, which keeps the
island (and Preact itself) out of the first-page bundle. Running the Next
source under `compat.next` would measure the compat client, not that tier.

So this fixture is the documented exception — two idiomatic implementations of
one product spec:

- `pnext/` — core pnext (Preact, `@wular/pnext/dynamic`), island declared with
  `dynamic(() => import('./pricing-calculator'), { load: 'visible' })`.
- `next/` — Next.js App Router, island declared with `next/dynamic`
  (`ssr: false`) behind a `'use client'` `IntersectionObserver` gate, which is
  how the same behaviour is written on Next today.

**Equivalence rule.** The two trees must stay equivalent in _product spec_,
not in source: identical routes, identical server-rendered copy and DOM shape
(same headings, same number of feature/FAQ/logo rows from the same data),
identical island behaviour (same controls, same pricing maths, same
`rootMargin`), and no client JS above the fold on either side. Anything that
changes bytes on the wire — extra sections, extra islands, a different
observer margin — must be changed in both trees in the same commit. Only the
framework idiom differs.

Note for the deferred-JS metric: pnext hints its island chunk with a
low-priority `rel="preload"`, Next names its chunk inside the initial chunk.
Neither is executed during the first paint, and both land in deferred JS.

## Product spec

- One route, `/`.
- Header, hero, six features, four logos, three testimonials and six FAQ rows,
  all server-rendered from `lib/content.ts`.
- A `pricing-section` placeholder that reserves the island's box, then a
  pricing calculator island: seat stepper, monthly/yearly toggle, computed
  total. It loads only once the section is within `200px` of the viewport.
