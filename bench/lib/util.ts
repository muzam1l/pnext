import net from 'node:net'

/**
 * RSS across a process tree, summed from one `ps` snapshot (macOS and Linux
 * both support `-axo pid=,ppid=,rss=`, rss in KB). Frameworks that spawn
 * workers would otherwise be undercounted by a parent-only reading.
 */
export function treeRss(pid: number): number {
  const out = Bun.spawnSync(['ps', '-axo', 'pid=,ppid=,rss=']).stdout.toString()
  const rssByPid = new Map<number, number>()
  const childrenByParent = new Map<number, number[]>()
  for (const line of out.trim().split('\n')) {
    const [p, ppid, rss] = line.trim().split(/\s+/).map(Number)
    if (p === undefined || ppid === undefined || rss === undefined) continue
    rssByPid.set(p, rss)
    if (!childrenByParent.has(ppid)) childrenByParent.set(ppid, [])
    childrenByParent.get(ppid)!.push(p)
  }
  let totalKb = 0
  const stack = [pid]
  while (stack.length) {
    const current = stack.pop()!
    totalKb += rssByPid.get(current) ?? 0
    for (const child of childrenByParent.get(current) ?? []) stack.push(child)
  }
  return totalKb / 1024
}

export function median(values: number[]) {
  if (!values.length) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

export function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() =>
        address && typeof address === 'object'
          ? resolve(address.port)
          : reject(new Error('could not allocate a port')),
      )
    })
  })
}

/** SIGKILL whatever still listens on `port` — dev servers outlive their CLI parent. */
export function sweepPort(port: number) {
  Bun.spawnSync(['sh', '-c', `lsof -ti tcp:${port} -sTCP:LISTEN | xargs kill -9 2>/dev/null`])
}

export function ms(value: number | undefined) {
  return value === undefined || Number.isNaN(value) ? '—' : `${value.toFixed(1)} ms`
}

export function bytes(value: number | undefined) {
  if (value === undefined || Number.isNaN(value)) return '—'
  if (value === 0) return '0 B'
  if (value < 1024) return `${value} B`
  return `${(value / 1024).toFixed(2)} KB`
}

export function mb(value: number | undefined) {
  return value === undefined || Number.isNaN(value) ? '—' : `${value.toFixed(1)} MB`
}

/** next/pnext, so >1 always means pnext is ahead. */
export function ratio(pnext: number | undefined, next: number | undefined) {
  if (pnext === undefined || next === undefined || Number.isNaN(pnext) || Number.isNaN(next))
    return '—'
  if (pnext === 0) return next === 0 ? '1.00x' : '∞'
  return `${(next / pnext).toFixed(2)}x`
}
