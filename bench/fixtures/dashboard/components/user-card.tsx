import Avatar from './avatar'
import Tag from './tag'
import type { User } from '../lib/types'

export default function UserCard({ user }: { user: User }) {
  return (
    <article className="user-card">
      <Avatar name={user.name} />
      <div>
        <strong>{user.name}</strong>
        <p className="muted">{user.email}</p>
        <Tag label={user.role} />
        <Tag label={user.status} />
      </div>
    </article>
  )
}
