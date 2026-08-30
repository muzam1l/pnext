import Badge from '../../../components/badge'
import Card from '../../../components/card'
import CopyButton from '../../../components/copy-button'
import EmptyState from '../../../components/empty-state'
import InvoiceLines from '../../../components/invoice-lines'
import KvList from '../../../components/kv-list'
import PageHeader from '../../../components/page-header'
import { currency } from '../../../lib/format'
import { findInvoice } from '../../../lib/invoices'

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const invoice = findInvoice(id)
  if (!invoice) return <EmptyState message={`No invoice ${id}.`} />
  return (
    <>
      <PageHeader
        title={invoice.id}
        description={invoice.customer}
        actions={<CopyButton value={invoice.id} />}
      />
      <Card title="Terms">
        <KvList
          rows={[
            { label: 'Status', value: <Badge status={invoice.status} /> },
            { label: 'Issued', value: invoice.issued },
            { label: 'Due', value: invoice.due },
            { label: 'Amount', value: currency(invoice.amount) },
          ]}
        />
      </Card>
      <Card title="Line items">
        <InvoiceLines lines={invoice.lines} />
      </Card>
    </>
  )
}
