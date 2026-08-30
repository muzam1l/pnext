import type { Metadata } from 'next'
import Callout from '../../../components/callout'
import Card from '../../../components/card'
import Heatmap from '../../../components/heatmap'
import { cohorts } from '../../../lib/series'

export const metadata: Metadata = { title: 'Retention report · Acme Admin' }

export default function RetentionReportPage() {
  return (
    <>
      <Callout tone="info" title="Cohorts are trailing">
        Each row is a signup month; each column is the share still active that many months later.
      </Callout>
      <Card title="Monthly cohorts">
        <Heatmap cohorts={cohorts} columns={10} />
      </Card>
    </>
  )
}
