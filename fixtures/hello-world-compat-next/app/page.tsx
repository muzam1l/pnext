import type { Metadata } from 'next'
import Counter from './counter'

export const metadata: Metadata = {
  title: 'Hello world',
  description: 'Minimal PNext benchmark app.',
}

export default function Home() {
  return (
    <main>
      <h1>Hello world</h1>
      <Counter />
    </main>
  )
}
