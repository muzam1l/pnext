import type { LayoutProps } from '@wular/pnext'
import './globals.css'

export const metadata = {
  title: 'pnext-app',
}

export default function RootLayout({ children }: LayoutProps) {
  return (
    <html>
      <body>
        <header class="site-header">
          <div class="container bar">
            <a class="brand" href="/">
              <span class="mark">▲</span> pnext-app
            </a>
            <nav>
              <a href="/server">Server component</a>
              <a href="/client">Client component</a>
              <a href="https://www.pnext.dev/docs" target="_blank" rel="noopener">
                Docs
              </a>
              <a href="https://github.com/muzam1l/pnext" target="_blank" rel="noopener">
                GitHub
              </a>
            </nav>
          </div>
        </header>
        <main class="container">{children}</main>
      </body>
    </html>
  )
}
