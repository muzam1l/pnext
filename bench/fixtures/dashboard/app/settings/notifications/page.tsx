import Card from '../../../components/card'
import StatusDot from '../../../components/status-dot'
import Toast from '../../../components/toast'

const channels = [
  { name: 'Product updates', on: true },
  { name: 'Weekly digest', on: true },
  { name: 'Security alerts', on: true },
  { name: 'Marketing', on: false },
  { name: 'Invoice reminders', on: true },
]

export default function NotificationSettingsPage() {
  return (
    <Card title="Notifications">
      <ul>
        {channels.map(channel => (
          <li key={channel.name}>
            <StatusDot ok={channel.on} /> {channel.name}
          </li>
        ))}
      </ul>
      <Toast label="Save channels" />
    </Card>
  )
}
