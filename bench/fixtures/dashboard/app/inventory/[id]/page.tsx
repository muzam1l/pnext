import Card from '../../../components/card'
import CopyButton from '../../../components/copy-button'
import EmptyState from '../../../components/empty-state'
import KvList from '../../../components/kv-list'
import PageHeader from '../../../components/page-header'
import StockMeter from '../../../components/stock-meter'
import Tag from '../../../components/tag'
import { currency } from '../../../lib/format'
import { findItem } from '../../../lib/inventory'

export default async function InventoryItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const item = findItem(id)
  if (!item) return <EmptyState message={`No stock line ${id}.`} />
  return (
    <>
      <PageHeader
        title={item.name}
        description={item.sku}
        actions={<CopyButton value={item.sku} />}
      />
      <Card title="Availability">
        <StockMeter onHand={item.onHand} reserved={item.reserved} reorderAt={item.reorderAt} />
      </Card>
      <Card title="Details">
        <KvList
          rows={[
            { label: 'Warehouse', value: item.warehouse },
            { label: 'Category', value: <Tag label={item.category} /> },
            { label: 'Unit cost', value: currency(item.unitCost) },
            { label: 'Carrying value', value: currency(item.onHand * item.unitCost) },
          ]}
        />
      </Card>
    </>
  )
}
