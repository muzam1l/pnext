# pnext: instructions for agents

pnext is a small, fast framework on Preact. Core (`src/` outside `compat/`) stays minimal; everything Next.js or React specific lives in `src/compat/`, and `scripts/check-compat-boundary.ts` enforces that core never imports it.

## Code

- Plain TypeScript in the idioms already around it. Find where a concern lives and extend that file in its patterns; search `src/` for an existing helper before writing one.
- Prefer deleting code to adding it. Fix at the right layer with the smallest diff; reuse or generalize what exists instead of adding a parallel path. No defensive branches for impossible cases, speculative options or dead code. A change that removes more lines than it adds is the goal.
- Comments one line, only for a non-obvious why. Formatting is prettier's (`bun run format`).
- Performance is a ratchet: no new client bytes or request/navigation work without a measured reason. Server bytes are tolerated, client bytes are not.
- Compat matches stable Next.js (wording, headers, status codes, wire formats), never canary.
- A module build never awaits another module build.

## Layout

- `src/api` public APIs, `src/cli` build/start/dev commands and adapters, `src/client` browser runtime and router, `src/render` server rendering, `src/routing`, `src/resolve`, `src/runtime` module loading, `src/compat` Next/React compatibility.
- One file or one folder per concern, no sibling-file sprawl. Files stay under 10k lines; don't split below that without a reason.
- `reference/` is the user documentation, rendered verbatim by the website: open with the common case, keep internals out.

## Gate

- `bun run lint` (compat boundary, prettier, eslint with zero warnings, tsc) gates publish.
- Bench is in `bench/`: `bun run bench <fixture>` then `bun bench/check.ts` against `bench/baselines.json`. A PR benches main and itself side by side (`bench/compare.ts`) and gets the site's headline numbers as a comment.
- Tests live in the private repo `pnext-workspace` (this repo is its `pnext/` submodule; locally `../`):
  - `tests/` is the native suite: `bun run test` from the workspace root, never bare `bun test`. Every behavior change gets a fast test asserting behavior, not Next-specific strings.
  - `conform/` runs Next.js's own e2e suite against pnext: `bun conform/run.ts <suite-pattern>`.
- On a PR, the native suite runs on every push from maintainers (guest PRs after the `ok-to-test` label) and the conform fold on the `conform` label; both report as `tests` and `conform` checks. A workspace branch named like the PR branch runs instead of workspace `main`, so test changes can ride along.
