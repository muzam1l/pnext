import Card from '../../../components/card'
import UserCard from '../../../components/user-card'
import { users } from '../../../lib/users'

export default function TeamSettingsPage() {
  return (
    <Card title="Team">
      <p>
        Seats in use: {users.length} of 60. Invite and remove members in{' '}
        <a href="/admin/users">Admin → Users</a>.
      </p>
      <div className="card-grid">
        {users.slice(0, 8).map(user => (
          <UserCard key={user.id} user={user} />
        ))}
      </div>
    </Card>
  )
}
