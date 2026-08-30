import Card from '../../components/card'
import Skeleton from '../../components/skeleton'

export default function ReportsLoading() {
  return (
    <Card title="Loading report">
      <Skeleton rows={8} />
    </Card>
  )
}
