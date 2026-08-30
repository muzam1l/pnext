import type { Metadata } from 'next'
import BarChart from '../../components/bar-chart'
import Card from '../../components/card'
import Chart from '../../components/chart'
import DonutChart from '../../components/donut-chart'
import PageHeader from '../../components/page-header'
import ProgressBar from '../../components/progress-bar'
import StatGrid from '../../components/stat-grid'
import Tabs from '../../components/tabs'
import { analyticsMetrics } from '../../lib/metrics'
import { channelSlices, deviceSlices, sessionsSeries, signupsSeries } from '../../lib/series'

export const metadata: Metadata = { title: 'Analytics · Acme Admin' }

export default function AnalyticsPage() {
  return (
    <>
      <PageHeader title="Analytics" description="Traffic and conversion for the last 30 days." />
      <StatGrid metrics={analyticsMetrics} />
      <Card title="Trends">
        <Tabs labels={['Sessions', 'Signups']}>
          <Chart series={sessionsSeries} />
          <BarChart series={signupsSeries} />
        </Tabs>
      </Card>
      <div className="split">
        <Card title="Devices">
          <DonutChart slices={deviceSlices} label="Sessions by device" />
        </Card>
        <Card title="Channels">
          {channelSlices.map(slice => (
            <div key={slice.label}>
              <span>
                {slice.label} — {slice.value}%
              </span>
              <ProgressBar value={slice.value} />
            </div>
          ))}
        </Card>
      </div>
    </>
  )
}
