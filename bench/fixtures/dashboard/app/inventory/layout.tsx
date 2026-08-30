import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import Breadcrumbs from '../../components/breadcrumbs'
import SectionNav from '../../components/section-nav'
import { inventoryNav } from '../../lib/nav'

export const metadata: Metadata = {
  title: 'Inventory · Acme Admin',
  description: 'Stock levels per warehouse and category.',
}

export default function InventoryLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Breadcrumbs
        trail={[
          { href: '/', label: 'Overview' },
          { href: '/inventory', label: 'Inventory' },
        ]}
      />
      <SectionNav items={inventoryNav} />
      {children}
    </>
  )
}
