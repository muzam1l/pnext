// NO_COLOR (https://no-color.org): any non-empty value disables all styling.
function color(open: string, close: string) {
  return (value: string) =>
    process.stdout.isTTY && !process.env.NO_COLOR ? `${open}${value}${close}` : value
}

/** Mid-gray for subordinate text. Readable on both light and dark terminals. */
export const dim = color('\x1b[38;5;244m', '\x1b[39m')
export const bold = color('\x1b[1m', '\x1b[22m')
export const cyan = color('\x1b[36m', '\x1b[39m')
export const green = color('\x1b[32m', '\x1b[39m')
export const yellow = color('\x1b[33m', '\x1b[39m')

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB'] as const
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unitIndex]}`
}

export function formatDelta(bytes: number) {
  return `${bytes > 0 ? '+' : '-'}${formatBytes(Math.abs(bytes))}`
}
