import type { Metadata } from 'next'
import Card from '../../components/card'
import FilterBar from '../../components/filter-bar'
import PageHeader from '../../components/page-header'
import SortableTable from '../../components/sortable-table'
import StatGrid from '../../components/stat-grid'
import TablePagination from '../../components/table-pagination'
import { invoices } from '../../lib/invoices'
import { invoiceMetrics } from '../../lib/metrics'
import { pageOf, slice, type Params } from '../../lib/paginate'
import type { Column, Invoice } from '../../lib/types'

export const metadata: Metadata = {
  title: 'Invoices · Acme Admin',
  description: 'Issued, outstanding and settled invoices.',
}

const columns: Column<Invoice>[] = [
  { key: 'id', header: 'Invoice' },
  { key: 'customer', header: 'Customer' },
  { key: 'issued', header: 'Issued' },
  { key: 'due', header: 'Due' },
  { key: 'status', header: 'Status', format: 'status' },
  { key: 'amount', header: 'Amount', align: 'right', format: 'currency' },
]

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<Params> }) {
  const page = pageOf(await searchParams, invoices.length)
  return (
    <>
      <PageHeader title="Invoices" description={`${invoices.length} invoices issued.`} />
      <StatGrid metrics={invoiceMetrics} />
      <Card>
        <FilterBar
          facets={[{ name: 'Status', options: ['draft', 'sent', 'paid', 'overdue', 'void'] }]}
          label="invoices"
        />
        <SortableTable rows={slice(invoices, page)} columns={columns} hrefBase="/invoices" />
        <TablePagination page={page} base="/invoices" />
      </Card>
    </>
  )
}
