import type { Metadata } from 'next'
import Card from '../../components/card'
import NotificationItem from '../../components/notification-item'
import PageHeader from '../../components/page-header'
import Tabs from '../../components/tabs'
import Toast from '../../components/toast'
import { notifications, unread } from '../../lib/notifications'
import type { Notification } from '../../lib/types'

const List = ({ items }: { items: Notification[] }) => (
  <ul className="notices">
    {items.map(notification => (
      <NotificationItem key={notification.id} notification={notification} />
    ))}
  </ul>
)

export const metadata: Metadata = {
  title: 'Notifications · Acme Admin',
  description: 'Workspace inbox across system, billing, security and product channels.',
}

export default function NotificationsPage() {
  return (
    <>
      <PageHeader
        title="Inbox"
        description={`${unread} unread of ${notifications.length}.`}
        actions={<Toast label="Mark all read" />}
      />
      <Card>
        <Tabs labels={['All', 'Unread', 'Security']}>
          <List items={notifications} />
          <List items={notifications.filter(item => !item.read)} />
          <List items={notifications.filter(item => item.kind === 'security')} />
        </Tabs>
      </Card>
    </>
  )
}
