import CommandPalette from './command-palette'
import StatusDot from './status-dot'
import ThemeToggle from './theme-toggle'
import UserMenu from './user-menu'
import { unread } from '../lib/notifications'

export default function Topbar() {
  return (
    <header className="topbar">
      <span>
        <StatusDot ok /> All systems normal
      </span>
      <div className="topbar-actions">
        <CommandPalette />
        <a className="nav-link" href="/notifications">
          Inbox ({unread})
        </a>
        <ThemeToggle />
        <UserMenu name="Ada Lovelace" />
      </div>
    </header>
  )
}
