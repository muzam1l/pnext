import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'About the benchmark',
  description: 'A server-rendered fixture shared by the pnext and Next.js benchmark arms.',
}

export default function AboutPage() {
  return (
    <main>
      <h1>About</h1>
      <p>This fixture runs unmodified under both `pnext` and `next`.</p>
    </main>
  )
}
