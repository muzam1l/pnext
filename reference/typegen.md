# Type Safety

pnext generates types from the `app/` tree so route params, static params, route handler context, and links are all checked.

## Route types

Each route imports the types generated for its own file path. pnext validates the exports against the route inferred from that path, so a wrong param name, a bad static param shape, or the wrong handler context fails TypeScript.

```tsx
// app/users/[id]/page.tsx
import type {
  PageProps,
  StaticParams,
} from '#gen/app/users/[id]/page'

export function params(): StaticParams {
  return [{ id: 'ada' }]
}

export default async function Page({ params }: PageProps) {
  return <p>{(await params).id}</p>
}
```

A route handler takes its generated context type as the second argument.

```ts
// app/users/[id]/route.ts
import type { RouteContext } from '#gen/app/users/[id]/route'
import type { NextRequest } from '@wular/pnext/server'

export async function GET(
  request: NextRequest,
  { params }: RouteContext,
) {
  return Response.json({ id: (await params).id })
}
```

## Links

`<Link>` and `href()` check their route template and params against the same generated types. See [Navigation](./navigation.md).

## Setup

Apps from `pnext create` are already set up. The package ships the `@wular/pnext/config/ts/react.json` preset, which the scaffold puts in `extends` alongside the alias for generated types:

```json
{
  "compilerOptions": {
    "paths": {
      "#gen/*": ["./.pnext/types/*"]
    }
  }
}
```

Include `.pnext/types/**/*.ts` in the app TypeScript project so the editor and `tsc` can see the generated files. `pnext migrate` repoints existing include paths there, but it does not add the alias.

## Regenerating

The dev server and the build refresh generated types on their own. Run `pnext typegen` to refresh them by hand. The files live in `.pnext/types` and should not be edited.
