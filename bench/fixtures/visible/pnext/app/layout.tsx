import type { LayoutProps } from '@wular/pnext'
import './globals.css'

export default function RootLayout({ children }: LayoutProps) {
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
