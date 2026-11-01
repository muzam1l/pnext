# Review instructions for pnext

pnext is a Next.js-compatible framework on Preact: `src/compat` mirrors Next.js behavior, `src/client` is the browser runtime, `src/cli` builds and serves. Project conventions are in `AGENTS.md`.

Review for three things, in this order:

1. Performance. It is a ratchet. Flag any change that grows the client bundle or adds work on request, render or navigation paths unless the diff explains the bytes or milliseconds. Server bytes are tolerated, client bytes are not.
2. Compatibility with stable Next.js (not canary): wording of errors and warnings, headers, status codes, redirect and RSC wire formats, router behavior. Also flag Next or React specifics leaking into core outside `src/compat`.
3. Security: path traversal in file serving or caches, request data reaching file paths, headers or HTML unescaped, server-only values or secrets serialized to the client, open redirects, unsafe server action or proxy handling.

Report only defects with a concrete failure scenario. Skip style nits and comment wording.
