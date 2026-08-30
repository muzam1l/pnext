import Card from '../../../components/card'
import RoleMatrix from '../../../components/role-matrix'
import Tabs from '../../../components/tabs'
import Tag from '../../../components/tag'
import { PERMISSIONS, roles } from '../../../lib/users'

export default function RolesPage() {
  return (
    <Card title="Roles">
      <Tabs labels={['Permission matrix', 'Descriptions']}>
        <div>
          <RoleMatrix roles={roles} permissions={PERMISSIONS} />
        </div>
        <ul className="role-list">
          {roles.map(role => (
            <li key={role.id}>
              <strong>{role.name}</strong> <Tag label={`${role.members} members`} />
              <p className="muted">{role.summary}</p>
            </li>
          ))}
        </ul>
      </Tabs>
    </Card>
  )
}
