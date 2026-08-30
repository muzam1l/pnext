import Counter from './counter'

export const metadata = {
  lang: 'en',
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
