import Card from '../../components/card'
import Skeleton from '../../components/skeleton'

export default function InventoryLoading() {
  return (
    <Card title="Loading stock">
      <Skeleton rows={10} />
    </Card>
  )
}
