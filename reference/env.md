# Environment Variables

pnext loads `.env*` files from the project root, never from `src/`. Variables are server-only unless their name marks them for the browser. Server Components, layouts, route handlers, and the proxy read them from `process.env`.

## What reaches the browser

Browser bundles inline only these:

- `process.env.NODE_ENV`
- `process.env.NEXT_PUBLIC_*`
- `process.env.PNEXT_PUBLIC_*`

## Load order

Variables already set on `process.env` win. Missing ones are loaded from:

1. `.env.$NODE_ENV.local`
2. `.env.local`, except when `NODE_ENV` is `test`
3. `.env.$NODE_ENV`
4. `.env`

If `NODE_ENV` is not set, the dev server uses `development` and every other command uses `production`.

## Variable references

A value can reference an earlier variable, with or without braces, and with an optional fallback.

```env
API_HOST=api.example.com
NEXT_PUBLIC_API_URL=https://$API_HOST
PORT=${APP_PORT:-3000}
```

Escape the dollar sign when it should be literal, as `\$10`.

## PNEXT_COMPAT

Setting it to `next` gives an app with no `pnext.config.ts` the `next/*` module surface and `next.config.js` support. When a config file is present, it forces Next compatibility on and leaves every other compat flag as written. It is read after the `.env*` files load, so a `.env` file can set it. See [Compatibility](./compat.md).
