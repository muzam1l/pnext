export const compact = (value: number) =>
  new Intl.NumberFormat('en', { notation: 'compact' }).format(value)
