import StatCard from './stat-card'
import type { Metric } from '../lib/types'

export default function StatGrid({ metrics }: { metrics: Metric[] }) {
  return (
    <div className="stat-grid">
      {metrics.map(metric => (
        <StatCard key={metric.label} metric={metric} />
      ))}
    </div>
  )
}
