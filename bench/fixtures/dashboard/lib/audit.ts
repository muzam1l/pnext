import { cycle, stamp } from './seed'
import { users } from './users'
import type { AuditEntry, Severity } from './types'

const ACTIONS = [
  'signed in',
  'updated role',
  'exported report',
  'deleted invoice',
  'rotated API key',
  'invited member',
  'changed billing plan',
  'revoked session',
]
const TARGETS = [
  'workspace',
  'inv_0031',
  'usr_014',
  'role:analyst',
  'report:revenue',
  'api-key:prod',
]
const SEVERITIES: Severity[] = ['info', 'info', 'info', 'warn', 'critical']

export const auditLog: AuditEntry[] = Array.from({ length: 140 }, (_, index) => ({
  id: `evt_${String(index + 1).padStart(4, '0')}`,
  actor: cycle(users, index * 3).name,
  action: cycle(ACTIONS, index),
  target: cycle(TARGETS, index * 2),
  at: stamp(2026, index),
  severity: cycle(SEVERITIES, index),
})).reverse()

export const criticalEvents = auditLog.filter(entry => entry.severity === 'critical')
