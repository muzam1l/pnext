'use client'

import { useState } from 'react'
import type { Series } from '../lib/series'

const WIDTH = 640
const HEIGHT = 180

export default function BarChart({ series }: { series: Series }) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(...series.points)
  const slot = WIDTH / series.points.length
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`${series.label} by period`}>
        {series.points.map((point, index) => {
          const height = (point / max) * HEIGHT
          return (
            <rect
              key={index}
              x={index * slot + slot * 0.15}
              y={HEIGHT - height}
              width={slot * 0.7}
              height={height}
              fill={hover === index ? 'var(--fg)' : 'var(--accent)'}
              onMouseEnter={() => setHover(index)}
              onMouseLeave={() => setHover(null)}
            />
          )
        })}
      </svg>
      <figcaption>
        {series.label}
        {hover === null ? '' : `: ${series.points[hover]}`}
      </figcaption>
    </figure>
  )
}
