import NavLink from './nav-link'
import { primaryNav, settingsNav, supportNav, workspaceNav } from '../lib/nav'

const groups = [
  { heading: null, items: primaryNav },
  { heading: 'Workspace', items: workspaceNav },
  { heading: 'Settings', items: settingsNav },
  { heading: 'Support', items: supportNav },
]

export default function Sidebar() {
  return (
    <aside className="sidebar">
      <span className="brand">Acme Admin</span>
      {groups.map(group => (
        <div key={group.heading ?? 'primary'}>
          {group.heading ? <span className="nav-heading">{group.heading}</span> : null}
          <nav>
            {group.items.map(item => (
              <NavLink key={item.href} href={item.href} label={item.label} />
            ))}
          </nav>
        </div>
      ))}
    </aside>
  )
}
