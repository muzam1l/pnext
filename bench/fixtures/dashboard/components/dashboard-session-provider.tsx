'use client'

import type { ReactNode } from 'react'
import { DashboardSessionProvider } from '@dashboard/auth-context'
import type { DashboardSession } from '@dashboard/auth-store'

export default function DashboardSessionBoundary({
  children,
  session,
}: {
  children: ReactNode
  session: DashboardSession
}) {
  return <DashboardSessionProvider session={session}>{children}</DashboardSessionProvider>
}
