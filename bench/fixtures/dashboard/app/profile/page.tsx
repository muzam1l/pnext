import type { Metadata } from 'next'
import Card from '../../components/card'
import CopyButton from '../../components/copy-button'
import KvList from '../../components/kv-list'
import PageHeader from '../../components/page-header'
import ProfileForm from '../../components/profile-form'
import Tag from '../../components/tag'
import Timeline from '../../components/timeline'
import UserCard from '../../components/user-card'
import { auditLog } from '../../lib/audit'
import { users } from '../../lib/users'

const me = users[0]

export const metadata: Metadata = { title: 'Profile · Acme Admin' }

export default function ProfilePage() {
  return (
    <>
      <PageHeader
        title="Your profile"
        description={me.email}
        actions={<CopyButton value={me.email} />}
      />
      <div className="split">
        <Card title="Identity">
          <UserCard user={me} />
          <KvList
            rows={[
              { label: 'Role', value: <Tag label={me.role} /> },
              { label: 'Status', value: me.status },
              { label: 'Last seen', value: me.lastSeen },
            ]}
          />
        </Card>
        <Card title="Edit details">
          <ProfileForm name={me.name} email={me.email} />
        </Card>
      </div>
      <Card title="Your recent activity">
        <Timeline entries={auditLog.filter(entry => entry.actor === me.name).slice(0, 10)} />
      </Card>
    </>
  )
}
