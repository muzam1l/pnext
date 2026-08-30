import styles from './role-matrix.module.css'
import type { Role } from '../lib/types'

export default function RoleMatrix({
  roles,
  permissions,
}: {
  roles: Role[]
  permissions: string[]
}) {
  return (
    <table className={styles.matrix}>
      <thead>
        <tr>
          <th>Permission</th>
          {roles.map(role => (
            <th key={role.id}>{role.name}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {permissions.map(permission => (
          <tr key={permission}>
            <td>{permission}</td>
            {roles.map(role => (
              <td
                key={role.id}
                className={role.permissions.includes(permission) ? styles.yes : styles.no}
              >
                {role.permissions.includes(permission) ? '✓' : '—'}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
