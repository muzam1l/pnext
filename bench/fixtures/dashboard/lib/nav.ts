export interface NavItem {
  href: string
  label: string
}

export const primaryNav: NavItem[] = [
  { href: '/', label: 'Overview' },
  { href: '/analytics', label: 'Analytics' },
  { href: '/customers', label: 'Customers' },
  { href: '/products', label: 'Products' },
  { href: '/orders', label: 'Orders' },
  { href: '/invoices', label: 'Invoices' },
  { href: '/inventory', label: 'Inventory' },
]

export const workspaceNav: NavItem[] = [
  { href: '/reports', label: 'Reports' },
  { href: '/admin/users', label: 'Admin' },
  { href: '/notifications', label: 'Notifications' },
  { href: '/profile', label: 'Profile' },
]

export const settingsNav: NavItem[] = [
  { href: '/settings', label: 'Profile' },
  { href: '/settings/appearance', label: 'Appearance' },
  { href: '/settings/billing', label: 'Billing' },
  { href: '/settings/notifications', label: 'Notifications' },
  { href: '/settings/team', label: 'Team' },
]

export const reportsNav: NavItem[] = [
  { href: '/reports', label: 'Summary' },
  { href: '/reports/revenue', label: 'Revenue' },
  { href: '/reports/traffic', label: 'Traffic' },
  { href: '/reports/retention', label: 'Retention' },
  { href: '/reports/exports', label: 'Exports' },
]

export const adminNav: NavItem[] = [
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/roles', label: 'Roles' },
  { href: '/admin/audit-log', label: 'Audit log' },
]

export const inventoryNav: NavItem[] = [
  { href: '/inventory', label: 'Stock' },
  { href: '/inventory/categories', label: 'Categories' },
]

export const supportNav: NavItem[] = [
  { href: '/help', label: 'Help centre' },
  { href: '/search', label: 'Search' },
]
