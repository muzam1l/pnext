import type { Metadata } from 'next'
import Card from '../../../components/card'
import DataTable from '../../../components/data-table'
import Modal from '../../../components/modal'
import Toast from '../../../components/toast'
import { auditLog } from '../../../lib/audit'
import type { AuditEntry, Column } from '../../../lib/types'

export const metadata: Metadata = { title: 'Exports · Acme Admin' }

const columns: Column<AuditEntry>[] = [
  { key: 'at', header: 'Queued' },
  { key: 'actor', header: 'Requested by' },
  { key: 'target', header: 'Dataset' },
  { key: 'severity', header: 'State', format: 'status' },
]

const jobs = auditLog.filter(entry => entry.action === 'exported report').slice(0, 12)

export default function ExportsPage() {
  return (
    <Card title="Export jobs">
      <div className="toolbar">
        <Modal trigger="New export" title="Queue an export">
          <p>Pick a dataset and a format. The job runs on the next scheduler tick.</p>
          <Toast label="Queue CSV export" />
        </Modal>
        <Toast label="Retry failed jobs" />
      </div>
      <DataTable rows={jobs} columns={columns} />
    </Card>
  )
}
