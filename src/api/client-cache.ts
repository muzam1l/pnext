export function cache<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Result {
  return (...args: Args) => fn(...args)
}

export function cacheSignal() {
  return null
}
