import { percent } from '../lib/format'
import type { Metric } from '../lib/types'

export default function StatCard({ metric }: { metric: Metric }) {
  return (
    <div className="stat">
      <span className="stat-label">{metric.label}</span>
      <strong className="stat-value">{metric.value}</strong>
      <span className={metric.delta < 0 ? 'delta down' : 'delta up'}>{percent(metric.delta)}</span>
      <span className="stat-hint">{metric.hint}</span>
    </div>
  )
}
