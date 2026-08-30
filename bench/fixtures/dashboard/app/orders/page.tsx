import type { Metadata } from 'next'
import Card from '../../components/card'
import FilterBar from '../../components/filter-bar'
import PageHeader from '../../components/page-header'
import SortableTable from '../../components/sortable-table'
import TablePagination from '../../components/table-pagination'
import { orders } from '../../lib/orders'
import { pageOf, slice, type Params } from '../../lib/paginate'
import type { Column, Order } from '../../lib/types'

export const metadata: Metadata = { title: 'Orders · Acme Admin' }

const columns: Column<Order>[] = [
  { key: 'id', header: 'Order' },
  { key: 'customer', header: 'Customer' },
  { key: 'placed', header: 'Placed' },
  { key: 'channel', header: 'Channel' },
  { key: 'items', header: 'Items', align: 'right', format: 'number' },
  { key: 'status', header: 'Status', format: 'status' },
  { key: 'total', header: 'Total', align: 'right', format: 'currency' },
]

const facets = [
  { name: 'Status', options: ['paid', 'pending', 'refunded', 'failed'] },
  { name: 'Channel', options: ['web', 'mobile', 'partner', 'sales'] },
]

export default async function OrdersPage({ searchParams }: { searchParams: Promise<Params> }) {
  const page = pageOf(await searchParams, orders.length)
  return (
    <>
      <PageHeader title="Orders" description={`${orders.length} orders in the last quarter.`} />
      <Card>
        <FilterBar facets={facets} label="orders" />
        <SortableTable rows={slice(orders, page)} columns={columns} hrefBase="/orders" />
        <TablePagination page={page} base="/orders" />
      </Card>
    </>
  )
}
