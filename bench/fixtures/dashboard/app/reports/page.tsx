import Card from '../../components/card'
import Chart from '../../components/chart'
import Sparkline from '../../components/sparkline'
import StatGrid from '../../components/stat-grid'
import { reportMetrics } from '../../lib/metrics'
import { mrrSeries, ordersSeries, refundsSeries } from '../../lib/series'

export default function ReportsSummaryPage() {
  return (
    <>
      <StatGrid metrics={reportMetrics} />
      <Card title="MRR">
        <Chart series={mrrSeries} />
      </Card>
      <div className="split">
        <Card title="Orders">
          <Sparkline series={ordersSeries} />
        </Card>
        <Card title="Refunds">
          <Sparkline series={refundsSeries} />
        </Card>
      </div>
    </>
  )
}
