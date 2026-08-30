import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import SectionNav from '../../components/section-nav'
import { supportNav } from '../../lib/nav'

export const metadata: Metadata = {
  title: 'Support · Acme Admin',
  description: 'Documentation and cross-workspace search.',
}

/** Route group: `/help` and `/search` share this chrome without a URL segment. */
export default function SupportLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SectionNav items={supportNav} />
      {children}
    </>
  )
}
