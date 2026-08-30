import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { cookies } from 'next/headers'
import { readDashboardSession } from '@dashboard/auth-server'
import DashboardSessionBoundary from '../components/dashboard-session-provider'
import Sidebar from '../components/sidebar'
import Topbar from '../components/topbar'
import './globals.css'

export const metadata: Metadata = {
  title: 'Acme Admin',
  description:
    'Medium-sized admin dashboard fixture shared by the pnext and Next.js benchmark arms.',
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const session = readDashboardSession((await cookies()).get('dashboard-session')?.value)
  return (
    <html lang="en">
      <body>
        <DashboardSessionBoundary session={session}>
          <div className="shell">
            <Sidebar />
            <div>
              <Topbar />
              <main className="content">{children}</main>
            </div>
          </div>
        </DashboardSessionBoundary>
      </body>
    </html>
  )
}
