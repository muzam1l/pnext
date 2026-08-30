'use client'

import { useState } from 'preact/hooks'

export default function ClientPage() {
  const [count, setCount] = useState(0)
  return <button onClick={() => setCount(count + 1)}>Count {count}</button>
}
