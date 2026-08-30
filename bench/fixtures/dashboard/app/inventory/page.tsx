import Callout from '../../components/callout'
import Card from '../../components/card'
import FilterBar from '../../components/filter-bar'
import PageHeader from '../../components/page-header'
import SortableTable from '../../components/sortable-table'
import TablePagination from '../../components/table-pagination'
import StatGrid from '../../components/stat-grid'
import { WAREHOUSES, inventory, lowStock } from '../../lib/inventory'
import { inventoryMetrics } from '../../lib/metrics'
import { CATEGORIES } from '../../lib/products'
import { pageOf, slice, type Params } from '../../lib/paginate'
import type { Column, InventoryItem } from '../../lib/types'

const columns: Column<InventoryItem>[] = [
  { key: 'name', header: 'Item' },
  { key: 'sku', header: 'SKU' },
  { key: 'warehouse', header: 'Warehouse' },
  { key: 'category', header: 'Category' },
  { key: 'onHand', header: 'On hand', align: 'right', format: 'number' },
  { key: 'reserved', header: 'Reserved', align: 'right', format: 'number' },
  { key: 'unitCost', header: 'Unit cost', align: 'right', format: 'currency' },
]

const facets = [
  { name: 'Warehouse', options: WAREHOUSES },
  { name: 'Category', options: CATEGORIES },
]

export default async function InventoryPage({ searchParams }: { searchParams: Promise<Params> }) {
  const page = pageOf(await searchParams, inventory.length)
  return (
    <>
      <PageHeader
        title="Stock"
        description={`${inventory.length} tracked lines across ${WAREHOUSES.length} warehouses.`}
      />
      <StatGrid metrics={inventoryMetrics} />
      {lowStock.length ? (
        <Callout tone="warn" title={`${lowStock.length} lines below their reorder point`}>
          Restock before the next fulfilment window.
        </Callout>
      ) : null}
      <Card>
        <FilterBar facets={facets} label="lines" />
        <SortableTable rows={slice(inventory, page)} columns={columns} hrefBase="/inventory" />
        <TablePagination page={page} base="/inventory" />
      </Card>
    </>
  )
}
