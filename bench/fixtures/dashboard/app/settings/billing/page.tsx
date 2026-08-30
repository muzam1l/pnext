import Button from '../../../components/button'
import Callout from '../../../components/callout'
import Card from '../../../components/card'
import DataTable from '../../../components/data-table'
import { currency } from '../../../lib/format'
import { invoices, outstanding } from '../../../lib/invoices'
import type { Column, Invoice } from '../../../lib/types'

const columns: Column<Invoice>[] = [
  { key: 'id', header: 'Invoice' },
  { key: 'issued', header: 'Date' },
  { key: 'status', header: 'Status', format: 'status' },
  { key: 'amount', header: 'Amount', align: 'right', format: 'currency' },
]

export default function BillingSettingsPage() {
  return (
    <>
      <Callout tone="warn" title={`${currency(outstanding)} outstanding`}>
        Sent and overdue invoices across the workspace.
      </Callout>
      <Card title="Billing">
        <p>Enterprise plan, billed monthly.</p>
        <Button>Update payment method</Button>
        <DataTable
          rows={invoices.slice(0, 10)}
          columns={columns}
          href={row => `/invoices/${row.id}`}
        />
      </Card>
    </>
  )
}
