'use client'

import { useState } from 'react'
import type { Series } from '../lib/series'

const WIDTH = 640
const HEIGHT = 180

export default function Chart({ series }: { series: Series }) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(...series.points)
  const step = WIDTH / (series.points.length - 1)
  const path = series.points
    .map(
      (point, index) =>
        `${index === 0 ? 'M' : 'L'}${(index * step).toFixed(1)} ${(HEIGHT - (point / max) * HEIGHT).toFixed(1)}`,
    )
    .join(' ')

  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`${series.label} trend`}>
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" />
        {series.points.map((point, index) => (
          <circle
            key={index}
            cx={index * step}
            cy={HEIGHT - (point / max) * HEIGHT}
            r={hover === index ? 5 : 2.5}
            fill="var(--accent)"
            onMouseEnter={() => setHover(index)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
      </svg>
      <figcaption>
        {series.label}
        {hover === null ? '' : `: ${series.points[hover]}`}
      </figcaption>
    </figure>
  )
}
