import { CATEGORIES, products } from './products'
import { cycle, spread } from './seed'
import type { Category, InventoryItem } from './types'

export const WAREHOUSES = ['Rotterdam', 'Newark', 'Osaka', 'Fresno']

export const inventory: InventoryItem[] = Array.from({ length: 120 }, (_, index) => {
  const product = cycle(products, index)
  return {
    id: `inv_item_${String(index + 1).padStart(4, '0')}`,
    sku: product.sku,
    name: product.name,
    category: product.category,
    warehouse: cycle(WAREHOUSES, index * 3),
    onHand: spread(index, 29, 900),
    reserved: spread(index, 13, 140),
    reorderAt: 40 + spread(index, 7, 120),
    unitCost: Math.round(product.price * 0.62),
  }
})

export const findItem = (id: string) => inventory.find(item => item.id === id)

export const lowStock = inventory.filter(item => item.onHand - item.reserved < item.reorderAt)

export const categories: Category[] = CATEGORIES.map((name, index) => {
  const items = inventory.filter(item => item.category === name)
  const revenue = items.reduce((sum, item) => sum + item.onHand * item.unitCost, 0)
  return { id: `cat_${index + 1}`, name, items: items.length, revenue, share: 0 }
})

const totalRevenue = categories.reduce((sum, category) => sum + category.revenue, 0) || 1
for (const category of categories)
  category.share = Math.round((category.revenue / totalRevenue) * 100)

export const warehouseLoad = WAREHOUSES.map(warehouse => ({
  warehouse,
  units: inventory
    .filter(item => item.warehouse === warehouse)
    .reduce((sum, item) => sum + item.onHand, 0),
}))
