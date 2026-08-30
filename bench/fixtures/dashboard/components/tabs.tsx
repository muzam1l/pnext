'use client'

import { useState } from 'react'
import type { ReactNode } from 'react'

/** Panels arrive as server-rendered children; the island only flips which one CSS shows. */
export default function Tabs({ labels, children }: { labels: string[]; children: ReactNode }) {
  const [active, setActive] = useState(0)
  return (
    <div className="tabs" data-active={active}>
      <div className="tablist" role="tablist">
        {labels.map((label, index) => (
          <button
            key={label}
            type="button"
            role="tab"
            aria-selected={index === active}
            className={index === active ? 'tab active' : 'tab'}
            onClick={() => setActive(index)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="tabpanels">{children}</div>
    </div>
  )
}
