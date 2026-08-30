import { cycle, stamp } from './seed'
import type { Notification } from './types'

const KINDS = ['system', 'billing', 'security', 'product'] as const
const TITLES = [
  'Nightly sync finished',
  'Invoice is overdue',
  'New sign-in from an unknown device',
  'Retention report is ready',
  'Seat limit almost reached',
  'API key expires in 7 days',
]

export const notifications: Notification[] = Array.from({ length: 30 }, (_, index) => ({
  id: `ntf_${String(index + 1).padStart(3, '0')}`,
  title: cycle(TITLES, index),
  body: `Event ${index + 1} in the ${cycle(KINDS, index)} channel. No action is required unless it repeats.`,
  at: stamp(2026, index),
  kind: cycle(KINDS, index),
  read: index % 3 === 0,
})).reverse()

export const unread = notifications.filter(notification => !notification.read).length
