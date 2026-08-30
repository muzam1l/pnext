'use client'

import { usePathname } from 'next/navigation'

export default function NavLink({
  href,
  label,
  exact,
}: {
  href: string
  label: string
  exact?: boolean
}) {
  const pathname = usePathname()
  const active = exact || href === '/' ? pathname === href : pathname.startsWith(href)
  return (
    <a href={href} className={active ? 'nav-link active' : 'nav-link'}>
      {label}
    </a>
  )
}
