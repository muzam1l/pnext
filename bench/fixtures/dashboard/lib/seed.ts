/** Deterministic sequences: both benchmark arms must render byte-identical data. */
export const cycle = <T>(list: readonly T[], index: number) => list[index % list.length]

export const spread = (index: number, step: number, span: number) => (index * step) % span

export const dateOn = (year: number, index: number) =>
  `${year}-${String((index % 12) + 1).padStart(2, '0')}-${String((index % 28) + 1).padStart(2, '0')}`

export const stamp = (year: number, index: number) =>
  `${dateOn(year, index)} ${String(index % 24).padStart(2, '0')}:${String((index * 7) % 60).padStart(2, '0')}`
