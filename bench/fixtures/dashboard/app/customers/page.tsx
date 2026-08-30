import type { Metadata } from 'next'
import Card from '../../components/card'
import DataTable from '../../components/data-table'
import FilterBar from '../../components/filter-bar'
import PageHeader from '../../components/page-header'
import TablePagination from '../../components/table-pagination'
import { customers } from '../../lib/customers'
import { pageOf, slice, type Params } from '../../lib/paginate'
import type { Column, Customer } from '../../lib/types'

export const metadata: Metadata = { title: 'Customers · Acme Admin' }

const columns: Column<Customer>[] = [
  { key: 'name', header: 'Name' },
  { key: 'email', header: 'Email' },
  { key: 'plan', header: 'Plan' },
  { key: 'region', header: 'Region' },
  { key: 'spend', header: 'Spend', align: 'right', format: 'currency' },
  { key: 'joined', header: 'Joined' },
]

const facets = [
  { name: 'Plan', options: ['free', 'pro', 'enterprise'] },
  { name: 'Region', options: [...new Set(customers.map(customer => customer.region))] },
]

export default async function CustomersPage({ searchParams }: { searchParams: Promise<Params> }) {
  const page = pageOf(await searchParams, customers.length)
  return (
    <>
      <PageHeader title="Customers" description={`${customers.length} accounts.`} />
      <Card>
        <FilterBar facets={facets} label="customers" />
        <DataTable
          rows={slice(customers, page)}
          columns={columns}
          href={row => `/customers/${row.id}`}
        />
        <TablePagination page={page} base="/customers" />
      </Card>
    </>
  )
}
