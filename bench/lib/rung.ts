// Child process for runtime.ts: builds ONE rung app in a pristine process and prints its client cost.
//
//   bun --conditions=react-server bench/lib/rung.ts <rung name>
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { gzipSync, brotliCompressSync, constants } from 'node:zlib'
import { buildProject } from '../../src/cli/build'
import { createRequestHandler } from '../../src/cli/start'
import { RUNGS, type RuntimeSize } from './runtime'

const REPO = path.resolve(import.meta.dirname, '../..')
const rung = RUNGS.find(item => item.name === process.argv[2])
if (!rung) throw new Error(`unknown rung ${process.argv[2]}`)

const root = path.join(REPO, '.tmp/rungs', rung.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase())
await rm(root, { recursive: true, force: true })
for (const [file, source] of Object.entries(rung.files)) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), source)
}
const log = console.log
console.log = () => undefined
await buildProject(root)
const handler = await createRequestHandler({ root })
console.log = log

const get = (href: string) => handler(new Request(`http://localhost${href}`))
const html = await (await get('/')).text()

// First paint: module scripts plus their modulepreloads (the bench fixtures' rule).
const initial = new Set<string>()
for (const [tag] of html.matchAll(/<script[^>]*>/g)) {
  const src = !tag.includes(' noModule') && /\ssrc="([^"]+)"/.exec(tag)?.[1]
  if (src) initial.add(src)
}
for (const [tag] of html.matchAll(/<link[^>]+>/g)) {
  const href = tag.includes('rel="modulepreload"') && /href="([^"]+)"/.exec(tag)?.[1]
  if (href) initial.add(href)
}

const size: RuntimeSize = { name: rung.name, raw: 0, gzip: 0, brotli: 0, deferredGzip: 0 }
const seen = new Set(initial)
const queue: { href: string; text: string }[] = []
for (const href of initial) {
  const body = new Uint8Array(await (await get(href)).arrayBuffer())
  size.raw += body.byteLength
  size.gzip += gzipSync(body, { level: 9 }).byteLength
  size.brotli += brotliCompressSync(body, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).byteLength
  queue.push({ href, text: new TextDecoder().decode(body) })
}
// Deferred: every chunk the loaded ones name, the graph the page can fetch after first paint.
for (let current = queue.shift(); current; current = queue.shift()) {
  for (const [, specifier] of current.text.matchAll(/["'`]([^"'`\s<>]+\.js)["'`]/g)) {
    if (/^[a-z]+:/i.test(specifier!)) continue
    const href = new URL(specifier!, `http://x${current.href}`).pathname
    if (seen.has(href)) continue
    seen.add(href)
    const response = await get(href)
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('javascript'))
      continue
    const body = new Uint8Array(await response.arrayBuffer())
    size.deferredGzip += gzipSync(body, { level: 9 }).byteLength
    queue.push({ href, text: new TextDecoder().decode(body) })
  }
}
console.log(JSON.stringify(size))
process.exit(0)
