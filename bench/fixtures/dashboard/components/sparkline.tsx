import type { Series } from '../lib/series'

const WIDTH = 120
const HEIGHT = 32

export default function Sparkline({ series }: { series: Series }) {
  const max = Math.max(...series.points)
  const step = WIDTH / (series.points.length - 1)
  const path = series.points
    .map(
      (point, index) =>
        `${index === 0 ? 'M' : 'L'}${(index * step).toFixed(1)} ${(HEIGHT - (point / max) * HEIGHT).toFixed(1)}`,
    )
    .join(' ')
  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={`${series.label} sparkline`}
    >
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
    </svg>
  )
}
