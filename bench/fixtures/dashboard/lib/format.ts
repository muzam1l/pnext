export function currency(value: number) {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function percent(value: number) {
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`
}

export function shortDate(iso: string) {
  return iso.slice(0, 10)
}

export function count(value: number) {
  return value.toLocaleString('en-US')
}

export function compact(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}
