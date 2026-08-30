import type { Metadata } from 'next'
import Card from '../../../components/card'
import Chart from '../../../components/chart'
import DonutChart from '../../../components/donut-chart'
import ProgressBar from '../../../components/progress-bar'
import { channelSlices, deviceSlices, sessionsSeries } from '../../../lib/series'

export const metadata: Metadata = { title: 'Traffic report · Acme Admin' }

export default function TrafficReportPage() {
  return (
    <>
      <Card title="Sessions">
        <Chart series={sessionsSeries} />
      </Card>
      <div className="split">
        <Card title="By device">
          <DonutChart slices={deviceSlices} label="Sessions by device" />
        </Card>
        <Card title="By channel">
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
