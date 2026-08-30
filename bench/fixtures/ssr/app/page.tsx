import { items } from '../lib/data'
import Counter from './counter'

export default function HomePage() {
  return (
    <main>
      <h1>Server-rendered list</h1>
      <p>Fifty items rendered on the server from a local data module.</p>
      <Counter />
      <ul className="items">
        {items.map(item => (
          <li key={item.id}>
            <strong>{item.name}</strong>
            <span>{item.category}</span>
            <span>${item.price}</span>
          </li>
        ))}
      </ul>
    </main>
  )
}
