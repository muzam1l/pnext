import { cycle, dateOn, spread } from './seed'
import type { Customer } from './types'

const PLANS = ['free', 'pro', 'enterprise'] as const
const FIRST = [
  'Ada',
  'Grace',
  'Linus',
  'Barbara',
  'Alan',
  'Katherine',
  'Edsger',
  'Margaret',
  'Radia',
  'Tim',
]
const LAST = [
  'Lovelace',
  'Hopper',
  'Torvalds',
  'Liskov',
  'Turing',
  'Johnson',
  'Dijkstra',
  'Hamilton',
  'Perlman',
]
const REGIONS = ['NA-East', 'NA-West', 'EU-Central', 'EU-North', 'APAC', 'LATAM']

export const customers: Customer[] = Array.from({ length: 160 }, (_, index) => {
  const name = `${cycle(FIRST, index)} ${cycle(LAST, index * 3)}`
  return {
    id: `cus_${String(index + 1).padStart(4, '0')}`,
    name,
    email: `${name.toLowerCase().replace(' ', '.')}${index}@example.com`,
    plan: cycle(PLANS, index),
    spend: 40 + spread(index, 137, 9600),
    joined: dateOn(2025, index),
    region: cycle(REGIONS, index * 5),
  }
})

export const findCustomer = (id: string) => customers.find(customer => customer.id === id)
