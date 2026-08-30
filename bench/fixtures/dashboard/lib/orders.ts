import { customers } from './customers'
import { cycle, dateOn, spread } from './seed'
import type { Order, OrderStatus } from './types'

const STATUSES: OrderStatus[] = ['paid', 'pending', 'refunded', 'failed']
const CHANNELS = ['web', 'mobile', 'partner', 'sales']

export const orders: Order[] = Array.from({ length: 240 }, (_, index) => ({
  id: `ord_${String(index + 1).padStart(4, '0')}`,
  customer: cycle(customers, index * 7).name,
  status: cycle(STATUSES, index),
  total: 25 + spread(index, 91, 4200),
  placed: dateOn(2026, index),
  items: 1 + (index % 9),
  channel: cycle(CHANNELS, index * 3),
}))

export const findOrder = (id: string) => orders.find(order => order.id === id)

export const ordersByChannel = CHANNELS.map(channel => ({
  channel,
  count: orders.filter(order => order.channel === channel).length,
  revenue: orders
    .filter(order => order.channel === channel)
    .reduce((sum, order) => sum + order.total, 0),
}))
