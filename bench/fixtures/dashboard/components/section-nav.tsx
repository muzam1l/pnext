import NavLink from './nav-link'
import type { NavItem } from '../lib/nav'

export default function SectionNav({ items }: { items: NavItem[] }) {
  return (
    <nav className="section-nav">
      {items.map(item => (
        <NavLink key={item.href} href={item.href} label={item.label} exact />
      ))}
    </nav>
  )
}
