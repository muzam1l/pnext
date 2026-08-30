import StatusDot from './status-dot'
import Tag from './tag'
import type { Notification } from '../lib/types'

export default function NotificationItem({ notification }: { notification: Notification }) {
  return (
    <li className={notification.read ? 'notice read' : 'notice'}>
      <StatusDot ok={notification.read} />
      <div>
        <strong>{notification.title}</strong>
        <p className="muted">{notification.body}</p>
        <span className="muted">{notification.at}</span> <Tag label={notification.kind} />
      </div>
    </li>
  )
}
