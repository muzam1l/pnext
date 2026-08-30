'use client'

import nextDynamic from 'next/dynamic'
import { useEffect, useRef, useState } from 'react'

// Next's equivalent of pnext's dynamic({ load: 'visible' }): a lazy import
// behind a client-side IntersectionObserver gate.
const PricingCalculator = nextDynamic(() => import('./pricing-calculator'), { ssr: false })

export default function VisibleIsland() {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const node = ref.current
    if (!node || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(
      entries => {
        if (!entries.some(entry => entry.isIntersecting)) return
        observer.disconnect()
        setVisible(true)
      },
      { rootMargin: '200px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return <div ref={ref}>{visible ? <PricingCalculator /> : null}</div>
}
