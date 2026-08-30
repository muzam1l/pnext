import Card from '../../../components/card'
import FilterBar from '../../../components/filter-bar'
import Modal from '../../../components/modal'
import MultiStepForm from '../../../components/multi-step-form'
import SortableTable from '../../../components/sortable-table'
import TablePagination from '../../../components/table-pagination'
import UserCard from '../../../components/user-card'
import { pageOf, slice, type Params } from '../../../lib/paginate'
import { roles, users } from '../../../lib/users'
import type { Column, User } from '../../../lib/types'

const columns: Column<User>[] = [
  { key: 'name', header: 'Member' },
  { key: 'email', header: 'Email' },
  { key: 'role', header: 'Role' },
  { key: 'status', header: 'Status', format: 'status' },
  { key: 'lastSeen', header: 'Last seen' },
]

const facets = [
  { name: 'Role', options: roles.map(role => role.name) },
  { name: 'Status', options: ['active', 'invited', 'suspended'] },
]

export default async function UsersPage({ searchParams }: { searchParams: Promise<Params> }) {
  const page = pageOf(await searchParams, users.length, 20)
  return (
    <>
      <Card title="Members">
        <div className="toolbar">
          <FilterBar facets={facets} label="members" />
          <Modal trigger="Invite member" title="Invite a member">
            <MultiStepForm roles={roles.map(role => role.name)} />
          </Modal>
        </div>
        <SortableTable rows={slice(users, page)} columns={columns} />
        <TablePagination page={page} base="/admin/users" />
      </Card>
      <Card title="Recently active">
        <div className="card-grid">
          {users.slice(0, 6).map(user => (
            <UserCard key={user.id} user={user} />
          ))}
        </div>
      </Card>
    </>
  )
}
