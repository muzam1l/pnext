import { cycle, stamp } from './seed'
import type { Role, User, UserStatus } from './types'

const STATUSES: UserStatus[] = ['active', 'active', 'invited', 'suspended']
const NAMES = ['Ada', 'Grace', 'Linus', 'Barbara', 'Alan', 'Katherine', 'Edsger', 'Margaret']
const SURNAMES = ['Lovelace', 'Hopper', 'Torvalds', 'Liskov', 'Turing', 'Johnson']

export const roles: Role[] = [
  {
    id: 'owner',
    name: 'Owner',
    summary: 'Full control, including billing and deletion.',
    members: 2,
    permissions: ['billing:write', 'members:write', 'data:delete', 'settings:write'],
  },
  {
    id: 'admin',
    name: 'Admin',
    summary: 'Manages members, roles and workspace settings.',
    members: 6,
    permissions: ['members:write', 'settings:write', 'data:write'],
  },
  {
    id: 'analyst',
    name: 'Analyst',
    summary: 'Reads every dataset and publishes reports.',
    members: 11,
    permissions: ['data:read', 'reports:write'],
  },
  {
    id: 'support',
    name: 'Support',
    summary: 'Reads customer records and edits orders.',
    members: 9,
    permissions: ['data:read', 'orders:write'],
  },
  {
    id: 'billing',
    name: 'Billing',
    summary: 'Reads and issues invoices.',
    members: 4,
    permissions: ['billing:read', 'invoices:write'],
  },
  {
    id: 'viewer',
    name: 'Viewer',
    summary: 'Read-only access to dashboards.',
    members: 8,
    permissions: ['data:read'],
  },
]

export const PERMISSIONS = [...new Set(roles.flatMap(role => role.permissions))].sort()

export const users: User[] = Array.from({ length: 40 }, (_, index) => {
  const name = `${cycle(NAMES, index)} ${cycle(SURNAMES, index * 5)}`
  return {
    id: `usr_${String(index + 1).padStart(3, '0')}`,
    name,
    email: `${name.toLowerCase().replace(' ', '.')}${index}@acme.test`,
    role: cycle(roles, index).name,
    status: cycle(STATUSES, index),
    lastSeen: stamp(2026, index),
  }
})
