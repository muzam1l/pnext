import type { ReactNode } from 'react'

export default function KvList({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="kv">
      {rows.map(row => (
        <div key={row.label} className="kv-row">
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}
