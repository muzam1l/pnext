import Card from '../components/card'
import Chart from '../components/chart'
import DataTable from '../components/data-table'
import DonutChart from '../components/donut-chart'
import PageHeader from '../components/page-header'
import Sparkline from '../components/sparkline'
import StatGrid from '../components/stat-grid'
import WorkspaceWidgets from '../components/workspace-widgets'
import { overviewMetrics } from '../lib/metrics'
import { orders } from '../lib/orders'
import { channelSlices, ordersSeries, revenueSeries } from '../lib/series'
import type { Column, Order } from '../lib/types'

const columns: Column<Order>[] = [
  { key: 'id', header: 'Order' },
  { key: 'customer', header: 'Customer' },
  { key: 'status', header: 'Status', format: 'status' },
  { key: 'total', header: 'Total', align: 'right', format: 'currency' },
]

export default function OverviewPage() {
  return (
    <>
      <PageHeader title="Overview" description="Revenue, orders and account health at a glance." />
      <StatGrid metrics={overviewMetrics} />
      <Card title="Revenue trend">
        <Chart series={revenueSeries} />
      </Card>
      <div className="split">
        <Card title="Orders">
          <Sparkline series={ordersSeries} />
        </Card>
        <Card title="Channels">
          <DonutChart slices={channelSlices} label="Traffic by channel" />
        </Card>
      </div>
      <Card title="Recent orders">
        <DataTable rows={orders.slice(0, 10)} columns={columns} href={row => `/orders/${row.id}`} />
      </Card>
      <Card title="Workspace signals">
        <WorkspaceWidgets />
      </Card>
    </>
  )
}
