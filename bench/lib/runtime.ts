import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '../..')

/** Client JS one rung of the ladder costs: the first paint, and what the page can fetch after it. */
export interface RuntimeSize {
  name: string
  raw: number
  gzip: number
  brotli: number
  /** Chunks the page fetches after first paint (idle or on demand), gzip. */
  deferredGzip: number
}

const LAYOUT = `export default function RootLayout({ children }: { children: any }) {
  return <html lang="en"><body>{children}</body></html>;
}
`

const COUNTER = (hooks: string) => `'use client';
import { useState } from '${hooks}';
export function Counter() {
  const [n, setN] = useState(0);
  return <button onClick={() => setN(n + 1)}>count {n}</button>;
}
`

const ISLAND_PAGE = `import { Counter } from './counter';
export default function Page() { return <main><h1>Island</h1><Counter /></main>; }
`

/** Each rung is a real app built by this checkout and served by its production handler. */
export const RUNGS: { name: string; files: Record<string, string> }[] = [
  {
    name: 'server page',
    files: {
      'app/layout.tsx': LAYOUT,
      'app/page.tsx': `export default function Page() { return <main>Hello</main>; }\n`,
    },
  },
  {
    name: 'server page + Link',
    files: {
      'app/layout.tsx': LAYOUT,
      'app/page.tsx': `import { Link } from '@wular/pnext/link';
export default function Page() { return <main><Link href="/about">About</Link></main>; }
`,
      'app/about/page.tsx': `export default function About() { return <main>About</main>; }\n`,
    },
  },
  {
    name: 'island (Preact)',
    files: {
      'app/layout.tsx': LAYOUT,
      'app/page.tsx': ISLAND_PAGE,
      'app/counter.tsx': COUNTER('preact/hooks'),
    },
  },
  {
    name: 'island (compat.react)',
    files: {
      'pnext.config.ts': `export default { compat: { react: true } };\n`,
      'app/layout.tsx': LAYOUT,
      'app/page.tsx': ISLAND_PAGE,
      'app/counter.tsx': COUNTER('react'),
    },
  },
  {
    name: 'island (compat.next)',
    files: {
      'pnext.config.ts': `export default { compat: { next: true } };\n`,
      'next.config.js': `module.exports = { typescript: { ignoreBuildErrors: true } };\n`,
      'app/layout.tsx': LAYOUT,
      'app/page.tsx': ISLAND_PAGE,
      'app/counter.tsx': COUNTER('react'),
    },
  },
]

/**
 * One child per rung: compat registrations are process-wide, so a rung built after a compat one would
 * scan as compat too.
 */
export async function measureRuntimeSizes(): Promise<RuntimeSize[]> {
  const sizes: RuntimeSize[] = []
  for (const rung of RUNGS) {
    const child = Bun.spawn(
      ['bun', '--conditions=react-server', path.join(import.meta.dirname, 'rung.ts'), rung.name],
      { cwd: REPO, stdout: 'pipe', stderr: 'pipe' },
    )
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) throw new Error(`rung "${rung.name}" failed\n${err.slice(-2000)}`)
    sizes.push(JSON.parse(out.trim().split('\n').at(-1)!) as RuntimeSize)
  }
  return sizes
}
