import Card from '../../../components/card'
import DataTable from '../../../components/data-table'
import DonutChart from '../../../components/donut-chart'
import PageHeader from '../../../components/page-header'
import ProgressBar from '../../../components/progress-bar'
import { categories, warehouseLoad } from '../../../lib/inventory'
import type { Category, Column } from '../../../lib/types'

const columns: Column<Category>[] = [
  { key: 'name', header: 'Category' },
  { key: 'items', header: 'Lines', align: 'right', format: 'number' },
  { key: 'revenue', header: 'Carrying value', align: 'right', format: 'currency' },
  { key: 'share', header: 'Share %', align: 'right', format: 'number' },
]

export default function CategoriesPage() {
  return (
    <>
      <PageHeader title="Categories" description="Carrying value split by product category." />
      <div className="split">
        <Card title="Share of value">
          <DonutChart
            slices={categories.map(category => ({ label: category.name, value: category.share }))}
            label="Value by category"
          />
        </Card>
        <Card title="Warehouse load">
          {warehouseLoad.map(entry => (
            <div key={entry.warehouse}>
              <span>
                {entry.warehouse} — {entry.units} units
              </span>
              <ProgressBar
                value={entry.units}
                max={Math.max(...warehouseLoad.map(load => load.units))}
              />
            </div>
          ))}
        </Card>
      </div>
      <Card title="Breakdown">
        <DataTable rows={categories} columns={columns} />
      </Card>
    </>
  )
}
