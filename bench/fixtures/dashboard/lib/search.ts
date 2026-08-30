import { articles } from './help'
import { customers } from './customers'
import { inventory } from './inventory'
import { invoices } from './invoices'
import { orders } from './orders'
import { users } from './users'
import type { SearchHit } from './types'

/** One flat index over every domain, built where it is used: the /search route. */
export const index: SearchHit[] = [
  ...customers.map(customer => ({
    id: customer.id,
    title: customer.name,
    subtitle: customer.email,
    href: `/customers/${customer.id}`,
    kind: 'customer',
  })),
  ...orders.map(order => ({
    id: order.id,
    title: order.id,
    subtitle: `${order.customer} — ${order.status}`,
    href: `/orders/${order.id}`,
    kind: 'order',
  })),
  ...invoices.map(invoice => ({
    id: invoice.id,
    title: invoice.id,
    subtitle: `${invoice.customer} — ${invoice.status}`,
    href: `/invoices/${invoice.id}`,
    kind: 'invoice',
  })),
  ...inventory.map(item => ({
    id: item.id,
    title: item.name,
    subtitle: `${item.sku} — ${item.warehouse}`,
    href: `/inventory/${item.id}`,
    kind: 'stock',
  })),
  ...users.map(user => ({
    id: user.id,
    title: user.name,
    subtitle: user.role,
    href: '/admin/users',
    kind: 'member',
  })),
  ...articles.map(article => ({
    id: article.id,
    title: article.title,
    subtitle: article.section,
    href: '/help',
    kind: 'doc',
  })),
]

export function search(query: string, limit = 25) {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  return index
    .filter(
      hit =>
        hit.title.toLowerCase().includes(needle) || hit.subtitle.toLowerCase().includes(needle),
    )
    .slice(0, limit)
}

export const quickLinks = index.filter(hit => hit.kind === 'doc').slice(0, 6)
