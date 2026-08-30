import { cycle, spread } from './seed'
import type { Product } from './types'

export const CATEGORIES = [
  'Hardware',
  'Software',
  'Support',
  'Training',
  'Accessories',
  'Licensing',
]

export const products: Product[] = Array.from({ length: 120 }, (_, index) => ({
  id: `prd_${String(index + 1).padStart(4, '0')}`,
  name: `Widget ${String.fromCharCode(65 + (index % 26))}${index}`,
  sku: `SKU-${1000 + index}`,
  stock: spread(index, 17, 420),
  price: 15 + spread(index, 23, 500),
  category: cycle(CATEGORIES, index),
}))
