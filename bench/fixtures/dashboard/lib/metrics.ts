import { auditLog, criticalEvents } from './audit'
import { customers } from './customers'
import { currency, compact } from './format'
import { inventory, lowStock } from './inventory'
import { invoices, outstanding } from './invoices'
import { orders } from './orders'
import { users } from './users'
import type { Metric } from './types'

const revenue = orders.reduce((sum, order) => sum + order.total, 0)
const units = inventory.reduce((sum, item) => sum + item.onHand, 0)

export const overviewMetrics: Metric[] = [
  { label: 'Revenue', value: currency(revenue), delta: 12.4, hint: 'vs. previous 30 days' },
  { label: 'Orders', value: String(orders.length), delta: 4.1, hint: 'placed this month' },
  { label: 'Customers', value: String(customers.length), delta: 8.7, hint: 'active accounts' },
  { label: 'Churn', value: '1.9%', delta: -0.4, hint: 'rolling 90 days' },
]

export const analyticsMetrics: Metric[] = [
  { label: 'Sessions', value: '48,210', delta: 6.2, hint: 'last 30 days' },
  { label: 'Conversion', value: '3.4%', delta: 0.8, hint: 'checkout completion' },
  {
    label: 'Avg. order',
    value: currency(revenue / orders.length),
    delta: 2.2,
    hint: 'per paid order',
  },
  { label: 'Refunds', value: '2.1%', delta: -1.1, hint: 'of paid orders' },
]

export const reportMetrics: Metric[] = [
  { label: 'MRR', value: currency(revenue / 12), delta: 3.9, hint: 'normalised monthly' },
  { label: 'Expansion', value: '14.2%', delta: 1.6, hint: 'of net new revenue' },
  { label: 'Net retention', value: '112%', delta: 2.4, hint: 'trailing 12 months' },
  { label: 'Payback', value: '9.1 mo', delta: -0.7, hint: 'blended CAC' },
]

export const adminMetrics: Metric[] = [
  { label: 'Members', value: String(users.length), delta: 5.0, hint: 'across all roles' },
  { label: 'Audit events', value: compact(auditLog.length), delta: 9.3, hint: 'last 30 days' },
  { label: 'Critical', value: String(criticalEvents.length), delta: -2.0, hint: 'needs review' },
  { label: 'Sessions', value: '73', delta: 1.2, hint: 'currently open' },
]

export const inventoryMetrics: Metric[] = [
  { label: 'Units on hand', value: compact(units), delta: 2.8, hint: 'across 4 warehouses' },
  { label: 'SKUs tracked', value: String(inventory.length), delta: 1.1, hint: 'stocked lines' },
  { label: 'Below reorder', value: String(lowStock.length), delta: -4.5, hint: 'needs restock' },
  {
    label: 'Carrying cost',
    value: currency(inventory.reduce((sum, item) => sum + item.onHand * item.unitCost, 0)),
    delta: 3.3,
    hint: 'at unit cost',
  },
]

export const invoiceMetrics: Metric[] = [
  { label: 'Outstanding', value: currency(outstanding), delta: -6.1, hint: 'sent and overdue' },
  { label: 'Invoices', value: String(invoices.length), delta: 2.7, hint: 'issued this year' },
  {
    label: 'Avg. value',
    value: currency(invoices.reduce((sum, invoice) => sum + invoice.amount, 0) / invoices.length),
    delta: 1.4,
    hint: 'per invoice',
  },
  { label: 'Days to pay', value: '21', delta: -1.9, hint: 'median' },
]
