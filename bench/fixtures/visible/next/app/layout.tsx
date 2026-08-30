import type { ReactNode } from 'react'
import './globals.css'

export const metadata = {
  title: 'Nimbus — ship the interface, not the bundle',
  description: 'A landing page with one below-the-fold island.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>
          <strong>Nimbus</strong>
          <nav>
            <a href="#features">Features</a>
            <a href="#pricing">Pricing</a>
            <a href="#faq">FAQ</a>
          </nav>
        </header>
        {children}
        <footer>© Nimbus</footer>
      </body>
    </html>
  )
}
