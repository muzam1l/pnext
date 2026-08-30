import Callout from '../../../components/callout'
import Card from '../../../components/card'
import TablePagination from '../../../components/table-pagination'
import Timeline from '../../../components/timeline'
import { auditLog, criticalEvents } from '../../../lib/audit'
import { pageOf, slice, type Params } from '../../../lib/paginate'

export default async function AuditLogPage({ searchParams }: { searchParams: Promise<Params> }) {
  const page = pageOf(await searchParams, auditLog.length, 30)
  return (
    <>
      {criticalEvents.length ? (
        <Callout tone="bad" title={`${criticalEvents.length} critical events`}>
          Review these before the next access audit.
        </Callout>
      ) : null}
      <Card title="Audit trail">
        <Timeline entries={slice(auditLog, page)} />
        <TablePagination page={page} base="/admin/audit-log" />
      </Card>
    </>
  )
}
