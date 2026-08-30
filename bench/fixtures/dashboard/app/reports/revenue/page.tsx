import type { Metadata } from 'next'
import BarChart from '../../../components/bar-chart'
import Card from '../../../components/card'
import DataTable from '../../../components/data-table'
import { currency } from '../../../lib/format'
import { ordersByChannel } from '../../../lib/orders'
import { revenueSeries } from '../../../lib/series'
import type { Column } from '../../../lib/types'

export const metadata: Metadata = { title: 'Revenue report · Acme Admin' }

interface ChannelRow {
  id: string
  channel: string
  count: number
  revenue: number
}

const columns: Column<ChannelRow>[] = [
  { key: 'channel', header: 'Channel' },
  { key: 'count', header: 'Orders', align: 'right', format: 'number' },
  { key: 'revenue', header: 'Revenue', align: 'right', format: 'currency' },
]

const rows: ChannelRow[] = ordersByChannel.map(entry => ({ id: entry.channel, ...entry }))

export default function RevenueReportPage() {
  return (
    <>
      <Card title="Revenue by period">
        <BarChart series={revenueSeries} />
      </Card>
      <Card title="Revenue by channel">
        <DataTable rows={rows} columns={columns} />
        <p className="muted">Total {currency(rows.reduce((sum, row) => sum + row.revenue, 0))}</p>
      </Card>
    </>
  )
}
