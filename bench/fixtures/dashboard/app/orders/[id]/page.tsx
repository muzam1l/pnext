import Badge from '../../../components/badge'
import Card from '../../../components/card'
import CopyButton from '../../../components/copy-button'
import EmptyState from '../../../components/empty-state'
import KvList from '../../../components/kv-list'
import PageHeader from '../../../components/page-header'
import { currency } from '../../../lib/format'
import { findOrder, orders } from '../../../lib/orders'

export function generateStaticParams() {
  return orders.slice(0, 12).map(order => ({ id: order.id }))
}

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const order = findOrder(id)
  if (!order) return <EmptyState message={`No order ${id}.`} />
  return (
    <>
      <PageHeader
        title={order.id}
        description={`Placed ${order.placed} by ${order.customer}`}
        actions={<CopyButton value={order.id} />}
      />
      <Card title="Summary">
        <KvList
          rows={[
            { label: 'Status', value: <Badge status={order.status} /> },
            { label: 'Channel', value: order.channel },
            { label: 'Items', value: order.items },
            { label: 'Total', value: currency(order.total) },
          ]}
        />
      </Card>
    </>
  )
}
