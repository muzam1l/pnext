import { customers } from './customers'
import { cycle, dateOn, spread } from './seed'
import type { Invoice, InvoiceStatus } from './types'

const STATUSES: InvoiceStatus[] = ['draft', 'sent', 'paid', 'overdue', 'void']
const LINES = [
  'Platform subscription',
  'Seat overage',
  'Support retainer',
  'Onboarding services',
  'Data egress',
  'Training workshop',
]

export const invoices: Invoice[] = Array.from({ length: 100 }, (_, index) => {
  const lines = Array.from({ length: 1 + (index % 4) }, (_, line) => ({
    description: cycle(LINES, index + line),
    quantity: 1 + ((index + line) % 12),
    unitPrice: 45 + spread(index + line, 61, 900),
  }))
  return {
    id: `inv_${String(index + 1).padStart(4, '0')}`,
    customer: cycle(customers, index * 11).name,
    issued: dateOn(2026, index),
    due: dateOn(2026, index + 1),
    status: cycle(STATUSES, index),
    amount: lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0),
    lines,
  }
})

export const findInvoice = (id: string) => invoices.find(invoice => invoice.id === id)

export const outstanding = invoices
  .filter(invoice => invoice.status === 'sent' || invoice.status === 'overdue')
  .reduce((sum, invoice) => sum + invoice.amount, 0)
