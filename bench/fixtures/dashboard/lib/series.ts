export interface Series {
  label: string
  points: number[]
}

export interface Slice {
  label: string
  value: number
}

const wave = (offset: number, scale: number, length = 24) =>
  Array.from({ length }, (_, index) =>
    Math.round(scale * (1 + Math.sin((index + offset) / 3)) + index * 4),
  )

export const revenueSeries: Series = { label: 'Revenue', points: wave(0, 30) }
export const sessionsSeries: Series = { label: 'Sessions', points: wave(4, 22) }
export const signupsSeries: Series = { label: 'Signups', points: wave(9, 14) }
export const ordersSeries: Series = { label: 'Orders', points: wave(2, 18) }
export const refundsSeries: Series = { label: 'Refunds', points: wave(15, 6) }
export const mrrSeries: Series = { label: 'MRR', points: wave(6, 40, 36) }

export const channelSlices: Slice[] = [
  { label: 'Organic', value: 46 },
  { label: 'Referral', value: 27 },
  { label: 'Paid', value: 18 },
  { label: 'Email', value: 9 },
]

export const deviceSlices: Slice[] = [
  { label: 'Desktop', value: 58 },
  { label: 'Mobile', value: 34 },
  { label: 'Tablet', value: 8 },
]

/** Cohort retention grid: row = signup month, column = months since signup. */
export const cohorts = Array.from({ length: 10 }, (_, row) => ({
  label: `2026-${String(row + 1).padStart(2, '0')}`,
  retention: Array.from({ length: 10 - row }, (_, column) =>
    Math.max(12, Math.round(100 - column * (9 + (row % 4)) + (row % 3) * 2)),
  ),
}))
