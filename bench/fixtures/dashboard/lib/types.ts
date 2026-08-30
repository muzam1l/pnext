export type OrderStatus = 'paid' | 'pending' | 'refunded' | 'failed'
export type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'overdue' | 'void'
export type UserStatus = 'active' | 'invited' | 'suspended'
export type Severity = 'info' | 'warn' | 'critical'

export interface Customer {
  id: string
  name: string
  email: string
  plan: 'free' | 'pro' | 'enterprise'
  spend: number
  joined: string
  region: string
}

export interface Product {
  id: string
  name: string
  sku: string
  stock: number
  price: number
  category: string
}

export interface Order {
  id: string
  customer: string
  status: OrderStatus
  total: number
  placed: string
  items: number
  channel: string
}

export interface InvoiceLine {
  description: string
  quantity: number
  unitPrice: number
}

export interface Invoice {
  id: string
  customer: string
  issued: string
  due: string
  status: InvoiceStatus
  amount: number
  lines: InvoiceLine[]
}

export interface InventoryItem {
  id: string
  sku: string
  name: string
  category: string
  warehouse: string
  onHand: number
  reserved: number
  reorderAt: number
  unitCost: number
}

export interface Category {
  id: string
  name: string
  items: number
  revenue: number
  share: number
}

export interface User {
  id: string
  name: string
  email: string
  role: string
  status: UserStatus
  lastSeen: string
}

export interface Role {
  id: string
  name: string
  summary: string
  members: number
  permissions: string[]
}

export interface AuditEntry {
  id: string
  actor: string
  action: string
  target: string
  at: string
  severity: Severity
}

export interface Notification {
  id: string
  title: string
  body: string
  at: string
  kind: 'system' | 'billing' | 'security' | 'product'
  read: boolean
}

export interface HelpArticle {
  id: string
  title: string
  summary: string
  section: string
  minutes: number
}

export interface SearchHit {
  id: string
  title: string
  subtitle: string
  href: string
  kind: string
}

export interface Metric {
  label: string
  value: string
  delta: number
  hint: string
}

export interface Column<T> {
  key: keyof T & string
  header: string
  align?: 'left' | 'right'
  format?: 'currency' | 'status' | 'number'
}
