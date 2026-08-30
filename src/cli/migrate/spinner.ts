// Minimal braille spinner for the one step that can take a while (the source
// scan over a large app). TTY-only, so piped/CI output stays clean.

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export async function withSpinner<T>(label: string, run: () => Promise<T>): Promise<T> {
  if (!process.stdout.isTTY) return run()

  let frame = 0
  const timer = setInterval(() => {
    process.stdout.write(`\r${FRAMES[frame % FRAMES.length]} ${label}`)
    frame += 1
  }, 80)
  try {
    return await run()
  } finally {
    clearInterval(timer)
    process.stdout.write('\r\x1b[2K')
  }
}
