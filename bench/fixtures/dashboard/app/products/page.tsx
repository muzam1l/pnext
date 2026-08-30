import type { Metadata } from 'next'
import Card from '../../components/card'
import FilterBar from '../../components/filter-bar'
import PageHeader from '../../components/page-header'
import SortableTable from '../../components/sortable-table'
import TablePagination from '../../components/table-pagination'
import { CATEGORIES, products } from '../../lib/products'
import { pageOf, slice, type Params } from '../../lib/paginate'
import type { Column, Product } from '../../lib/types'

export const metadata: Metadata = { title: 'Products · Acme Admin' }

const columns: Column<Product>[] = [
  { key: 'name', header: 'Product' },
  { key: 'sku', header: 'SKU' },
  { key: 'category', header: 'Category' },
  { key: 'stock', header: 'Stock', align: 'right', format: 'number' },
  { key: 'price', header: 'Price', align: 'right', format: 'currency' },
]

export default async function ProductsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const page = pageOf(await searchParams, products.length)
  return (
    <>
      <PageHeader title="Products" description={`${products.length} SKUs in the catalog.`} />
      <Card>
        <FilterBar facets={[{ name: 'Category', options: CATEGORIES }]} label="products" />
        <SortableTable rows={slice(products, page)} columns={columns} />
        <TablePagination page={page} base="/products" />
      </Card>
    </>
  )
}
