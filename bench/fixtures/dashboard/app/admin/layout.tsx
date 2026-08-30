import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import Breadcrumbs from '../../components/breadcrumbs'
import PageHeader from '../../components/page-header'
import SectionNav from '../../components/section-nav'
import StatGrid from '../../components/stat-grid'
import { adminNav } from '../../lib/nav'
import { adminMetrics } from '../../lib/metrics'

export const metadata: Metadata = {
  title: 'Admin · Acme Admin',
  description: 'Members, roles and the workspace audit trail.',
}

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Breadcrumbs
        trail={[
          { href: '/', label: 'Overview' },
          { href: '/admin/users', label: 'Admin' },
        ]}
      />
      <PageHeader title="Administration" description="Who can do what, and what they did." />
      <SectionNav items={adminNav} />
      <StatGrid metrics={adminMetrics} />
      {children}
    </>
  )
}
