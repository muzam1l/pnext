import Card from '../../../components/card'
import CopyButton from '../../../components/copy-button'
import EmptyState from '../../../components/empty-state'
import KvList from '../../../components/kv-list'
import PageHeader from '../../../components/page-header'
import Sparkline from '../../../components/sparkline'
import Tag from '../../../components/tag'
import { currency } from '../../../lib/format'
import { customers, findCustomer } from '../../../lib/customers'
import { orders } from '../../../lib/orders'
import { mrrSeries } from '../../../lib/series'

export function generateStaticParams() {
  return customers.slice(0, 12).map(customer => ({ id: customer.id }))
}

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const customer = findCustomer(id)
  if (!customer) return <EmptyState message={`No customer ${id}.`} />
  const theirs = orders.filter(order => order.customer === customer.name)
  return (
    <>
      <PageHeader
        title={customer.name}
        description={customer.email}
        actions={<CopyButton value={customer.email} />}
      />
      <Card title="Account">
        <KvList
          rows={[
            { label: 'Plan', value: <Tag label={customer.plan} /> },
            { label: 'Region', value: customer.region },
            { label: 'Lifetime spend', value: currency(customer.spend) },
            { label: 'Joined', value: customer.joined },
            { label: 'Orders', value: theirs.length },
          ]}
        />
      </Card>
      <Card title="Monthly recurring revenue">
        <Sparkline series={mrrSeries} />
      </Card>
    </>
  )
}
