import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import Breadcrumbs from '../../components/breadcrumbs'
import PageHeader from '../../components/page-header'
import SectionNav from '../../components/section-nav'
import { settingsNav } from '../../lib/nav'

export const metadata: Metadata = {
  title: 'Settings · Acme Admin',
  description: 'Workspace and account preferences.',
}

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Breadcrumbs
        trail={[
          { href: '/', label: 'Overview' },
          { href: '/settings', label: 'Settings' },
        ]}
      />
      <PageHeader title="Settings" description="Workspace and account preferences." />
      <SectionNav items={settingsNav} />
      {children}
    </>
  )
}
