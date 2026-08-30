function color(open: string, close: string) {
  return (value: string) => (process.stdout.isTTY ? `${open}${value}${close}` : value)
}

/** Mid-gray for subordinate text. Readable on both light and dark terminals. */
export const dim = color('\x1b[38;5;244m', '\x1b[39m')
export const bold = color('\x1b[1m', '\x1b[22m')
export const cyan = color('\x1b[36m', '\x1b[39m')
export const green = color('\x1b[32m', '\x1b[39m')
