'use client'

import { useState } from 'react'
import type { Slice } from '../lib/series'

const SIZE = 180
const RADIUS = 70
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const HUES = [219, 168, 32, 348, 274]

export default function DonutChart({ slices, label }: { slices: Slice[]; label: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const total = slices.reduce((sum, slice) => sum + slice.value, 0) || 1
  let offset = 0

  return (
    <figure className="chart donut">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={label}>
        <g transform={`translate(${SIZE / 2} ${SIZE / 2}) rotate(-90)`}>
          {slices.map((slice, index) => {
            const length = (slice.value / total) * CIRCUMFERENCE
            const dash = `${length} ${CIRCUMFERENCE - length}`
            const element = (
              <circle
                key={slice.label}
                r={RADIUS}
                fill="none"
                stroke={`hsl(${HUES[index % HUES.length]} 68% ${hover === index ? 38 : 52}%)`}
                strokeWidth={hover === index ? 28 : 22}
                strokeDasharray={dash}
                strokeDashoffset={-offset}
                onMouseEnter={() => setHover(index)}
                onMouseLeave={() => setHover(null)}
              />
            )
            offset += length
            return element
          })}
        </g>
      </svg>
      <figcaption>
        {hover === null ? label : `${slices[hover].label}: ${slices[hover].value}`}
      </figcaption>
    </figure>
  )
}
