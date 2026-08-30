import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import Breadcrumbs from '../../components/breadcrumbs'
import PageHeader from '../../components/page-header'
import SectionNav from '../../components/section-nav'
import { reportsNav } from '../../lib/nav'

export const metadata: Metadata = {
  title: 'Reports · Acme Admin',
  description: 'Revenue, traffic, retention and export jobs.',
}

export default function ReportsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Breadcrumbs
        trail={[
          { href: '/', label: 'Overview' },
          { href: '/reports', label: 'Reports' },
        ]}
      />
      <PageHeader
        title="Reports"
        description="Scheduled and ad-hoc analysis across the workspace."
      />
      <SectionNav items={reportsNav} />
      {children}
    </>
  )
}
