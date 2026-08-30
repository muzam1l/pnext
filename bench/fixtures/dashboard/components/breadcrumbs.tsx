import type { NavItem } from '../lib/nav'

export default function Breadcrumbs({ trail }: { trail: NavItem[] }) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {trail.map((item, index) => (
        <span key={item.href}>
          {index > 0 ? <span className="crumb-sep">/</span> : null}
          <a href={item.href}>{item.label}</a>
        </span>
      ))}
    </nav>
  )
}
